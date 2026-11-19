// Verbindung zu OBS über OBS-WebSocket (ab OBS 28 eingebaut, Protokoll v5).
//
// Wird für zwei Dinge gebraucht:
//  - Lokale Clips: bei starken Momenten den Wiederholungspuffer speichern (highlights.js).
//  - System-Aktionen (Experte): Szene wechseln, Quelle ein/aus, Stream beenden (system-actions.js).
//
// Das Passwort liegt nur auf diesem PC (unter Windows verschlüsselt, siehe secret-store.js) und wird
// nie exportiert. Verbunden wird nur zu dieser Adresse - Standard ist der eigene PC (127.0.0.1).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DATA } from './config.js';
import { protect, unprotect, cryptoAvailable } from './secret-store.js';
import * as logger from './log.js';

export { OBS_DEFAULT, normalizeObs } from './system-config.js';

const secretFile = () => path.join(DATA, 'obs-secret.json');

// Entschlüsseln kostet unter Windows einen PowerShell-Aufruf - deshalb einmal lesen und merken.
let cached = null;
export function loadObsPassword() {
  if (cached !== null) return cached;
  try {
    const raw = JSON.parse(fs.readFileSync(secretFile(), 'utf8'));
    cached = raw.protected ? unprotect(raw.value) : String(raw.value || '');
  } catch { cached = ''; }
  return cached;
}

export function saveObsPassword(pw) {
  const value = String(pw || '').slice(0, 200);
  cached = value;
  if (!value) { try { fs.unlinkSync(secretFile()); } catch { /* war nicht da */ } return; }
  let out = { protected: false, value };
  if (cryptoAvailable()) { try { out = { protected: true, value: protect(value) }; } catch { /* dann unverschlüsselt, nur lokal */ } }
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(secretFile(), JSON.stringify(out), { mode: 0o600 });
}

const sha256b64 = (s) => crypto.createHash('sha256').update(s).digest('base64');
// Protokoll v5: base64(sha256(base64(sha256(passwort + salt)) + challenge))
export const obsAuth = (password, salt, challenge) => sha256b64(sha256b64(password + salt) + challenge);

// Ereignis-Gruppen (Bitmaske): General 1, Scenes 4, Outputs 64
const EVENTS = 1 | 4 | 64;

export class Obs extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.ws = null;
    this.status = 'off'; // off | connecting | connected | auth_failed | error
    this.detail = '';
    this.pending = new Map();
    this.seq = 0;
    this.retryTimer = null;
    this.attempt = 0;
    this.info = null; // { obsVersion, wsVersion }
    this.replayActive = null;
  }

  setStatus(s, detail = '') {
    if (s === this.status && detail === this.detail) return;
    this.status = s; this.detail = detail;
    this.emit('status', s, detail);
  }

  start() {
    this.stop();
    if (!this.cfg.obs?.enabled) { this.setStatus('off'); return; }
    this.stopped = false;
    this.open();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    for (const p of this.pending.values()) p.reject(new Error('OBS-Verbindung beendet'));
    this.pending.clear();
    try { this.ws?.close(); } catch { /* egal */ }
    this.ws = null;
    this.replayActive = null;
    this.setStatus('off');
  }

  open() {
    const { host, port } = this.cfg.obs;
    const url = `ws://${host.includes(':') ? `[${host}]` : host}:${port}`;
    this.setStatus('connecting');
    let ws;
    try { ws = new WebSocket(url, 'obswebsocket.json'); } catch (e) { this.fail(e.message); return; }
    this.ws = ws;
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      this.onMessage(ws, msg);
    };
    ws.onclose = (ev) => {
      if (ws !== this.ws) return;
      this.ws = null;
      this.replayActive = null; // ohne Verbindung wissen wir nichts über den Puffer
      for (const p of this.pending.values()) p.reject(new Error('OBS-Verbindung getrennt'));
      this.pending.clear();
      if (this.stopped) return;
      // 4009 = falsches Passwort: nicht endlos wiederholen
      if (ev.code === 4009) { this.setStatus('auth_failed', 'Passwort falsch'); return; }
      this.fail(ev.reason || 'getrennt');
    };
    ws.onerror = () => { /* onclose übernimmt */ };
  }

  fail(detail) {
    if (this.stopped) return;
    if (this.status !== 'error' || this.detail !== detail) logger.warn(`OBS nicht erreichbar (${detail}) - neuer Versuch gleich.`);
    this.setStatus('error', detail);
    clearTimeout(this.retryTimer);
    const delay = Math.min(60000, 2000 * 2 ** Math.min(this.attempt++, 5)) * (Number(process.env.UCC_POLL_SCALE) || 1);
    this.retryTimer = setTimeout(() => this.open(), delay);
    this.retryTimer.unref?.();
  }

  onMessage(ws, msg) {
    const d = msg.d || {};
    switch (msg.op) {
      case 0: { // Hello
        const ident = { rpcVersion: 1, eventSubscriptions: EVENTS };
        if (d.authentication) ident.authentication = obsAuth(loadObsPassword(), d.authentication.salt, d.authentication.challenge);
        this.info = { obsVersion: d.obsStudioVersion || null, wsVersion: d.obsWebSocketVersion || null };
        ws.send(JSON.stringify({ op: 1, d: ident }));
        break;
      }
      case 2: // Identified
        this.attempt = 0;
        this.setStatus('connected');
        logger.info(`Mit OBS verbunden${this.info?.obsVersion ? ` (OBS ${this.info.obsVersion})` : ''}.`);
        this.refreshReplay();
        break;
      case 5: // Event
        if (d.eventType === 'ReplayBufferStateChanged') { this.replayActive = !!d.eventData?.outputActive; this.emit('change'); }
        if (d.eventType === 'ReplayBufferSaved') this.emit('replaySaved', d.eventData?.savedReplayPath || null);
        if (d.eventType === 'StreamStateChanged') this.emit('streamState', d.eventData?.outputActive);
        if (d.eventType === 'CurrentProgramSceneChanged') this.emit('change');
        break;
      case 7: { // RequestResponse
        const p = this.pending.get(d.requestId);
        if (!p) return;
        this.pending.delete(d.requestId);
        clearTimeout(p.timer);
        if (d.requestStatus?.result) p.resolve(d.responseData || {});
        else p.reject(Object.assign(new Error(d.requestStatus?.comment || `OBS-Fehler ${d.requestStatus?.code}`), { code: d.requestStatus?.code }));
        break;
      }
      default: break;
    }
  }

  request(requestType, requestData = {}, timeoutMs = 8000) {
    if (this.status !== 'connected' || !this.ws) return Promise.reject(new Error('OBS ist nicht verbunden'));
    const requestId = `cc${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('OBS antwortet nicht')); }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
    });
  }

  async refreshReplay() {
    try { this.replayActive = !!(await this.request('GetReplayBufferStatus')).outputActive; } catch { this.replayActive = null; }
    this.emit('change');
    return this.replayActive;
  }

  async scenes() {
    const r = await this.request('GetSceneList');
    return { current: r.currentProgramSceneName || null, scenes: (r.scenes || []).map((s) => s.sceneName).reverse() };
  }

  async sources(sceneName) {
    const r = await this.request('GetSceneItemList', { sceneName });
    return (r.sceneItems || []).map((i) => ({ id: i.sceneItemId, name: i.sourceName, enabled: i.sceneItemEnabled }));
  }

  setScene(sceneName) { return this.request('SetCurrentProgramScene', { sceneName }); }

  async setSource(sceneName, sourceName, enabled) {
    const { sceneItemId } = await this.request('GetSceneItemId', { sceneName, sourceName });
    let on = enabled;
    if (on === 'toggle') on = !(await this.request('GetSceneItemEnabled', { sceneName, sceneItemId })).sceneItemEnabled;
    await this.request('SetSceneItemEnabled', { sceneName, sceneItemId, sceneItemEnabled: !!on });
    return !!on;
  }

  stopStream() { return this.request('StopStream'); }

  // Länge des Wiederholungspuffers (= wie viel VOR dem Moment im Clip ist). Steht in OBS je nach
  // Ausgabe-Modus unter SimpleOutput oder AdvOut.
  async replayCategory() {
    const mode = (await this.request('GetProfileParameter', { parameterCategory: 'Output', parameterName: 'Mode' })).parameterValue;
    return mode === 'Advanced' ? 'AdvOut' : 'SimpleOutput';
  }

  async getReplaySeconds() {
    const cat = await this.replayCategory();
    const r = await this.request('GetProfileParameter', { parameterCategory: cat, parameterName: 'RecRBTime' });
    const n = Number(r.parameterValue ?? r.defaultParameterValue);
    return Number.isFinite(n) ? n : null;
  }

  // Neue Länge setzen; ein laufender Puffer wird kurz neu gestartet, damit OBS sie übernimmt.
  async setReplaySeconds(sec) {
    const n = Math.round(Number(sec));
    if (!(n >= 5 && n <= 300)) throw new Error('Puffer-Länge: 5 bis 300 Sekunden');
    const cat = await this.replayCategory();
    await this.request('SetProfileParameter', { parameterCategory: cat, parameterName: 'RecRBTime', parameterValue: String(n) });
    if (this.replayActive) {
      await this.request('StopReplayBuffer').catch(() => {});
      for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 150)); if (!(await this.request('GetReplayBufferStatus')).outputActive) break; }
      await this.request('StartReplayBuffer');
      await this.refreshReplay();
    }
    return n;
  }

  async startReplay() { await this.request('StartReplayBuffer'); return this.refreshReplay(); }

  // Wiederholungspuffer speichern; liefert den Dateipfad (über das Ereignis oder die Nachfrage).
  async saveReplay(timeoutMs = 15000) {
    const saved = new Promise((resolve) => {
      const t = setTimeout(() => { this.off('replaySaved', on); resolve(null); }, timeoutMs);
      const on = (p) => { clearTimeout(t); this.off('replaySaved', on); resolve(p); };
      this.on('replaySaved', on);
    });
    await this.request('SaveReplayBuffer');
    const p = await saved;
    if (p) return p;
    try { return (await this.request('GetLastReplayBufferReplay')).savedReplayPath || null; } catch { return null; }
  }

  publicState() {
    return { enabled: !!this.cfg.obs?.enabled, status: this.status, detail: this.detail, replayActive: this.replayActive, version: this.info?.obsVersion || null, hasPassword: !!loadObsPassword() };
  }
}
