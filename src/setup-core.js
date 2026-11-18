// Einrichtung ohne Terminal: dieselben Schritte wie der Text-Assistent, aber als Funktionen für das Setup-Fenster.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import {
  SCOPES, loadConfig, saveConfig, saveTokens, loadActions, loadRewardMap, setActionEnabled, acknowledgeRisk,
} from './config.js';
import { Twitch, TwitchError, looksLikeClientId, startDeviceFlow, pollDeviceFlow, validateToken, probeRefresh } from './twitch.js';
import { findCs2CfgDir, installCs2Files, cs2FilesInstalled } from './cs2.js';
import { findAhk } from './bridge.js';
import { syncRewards, explain, listUnmatchedRewards } from './rewards.js';
import { openUrl } from './util.js';
import * as logger from './log.js';

export function clientIdProblem(v) {
  const s = String(v ?? '').trim();
  if (/^live_/i.test(s)) return 'Das sieht nach einem STREAM-KEY aus! Bitte nicht eingeben. Du brauchst die Client-ID deiner Twitch-Anwendung.';
  if (!looksLikeClientId(s)) return 'Eine Client-ID hat genau 30 Zeichen (Buchstaben und Ziffern). Bitte nochmal kopieren.';
  return null;
}

export function sensitivityProblem(v) {
  const n = Number(String(v ?? '').replace(',', '.'));
  return n > 0 && n <= 30 ? null : 'Bitte eine Zahl größer als 0 eingeben, z. B. 1.2';
}

// Nur Twitch-Seiten dürfen vom Fenster aus im Browser geöffnet werden.
export function externalAllowed(u) {
  try {
    const x = new URL(String(u));
    if (x.protocol === 'https:' && /(^|\.)twitch\.tv$/i.test(x.hostname)) return true;
    return !!process.env.UCC_NO_OPEN && ['localhost', '127.0.0.1'].includes(x.hostname); // nur Tests
  } catch { return false; }
}
export function openExternal(u) {
  if (!externalAllowed(u)) throw Object.assign(new Error('Diese Adresse darf nicht geöffnet werden.'), { status: 400 });
  openUrl(String(u));
}

export class Setup {
  constructor() {
    this.login = { state: 'idle' };
    this.run = 0;
    this.abort = null;
  }

  summary() {
    const cfg = loadConfig();
    const tw = new Twitch(cfg);
    const dir = cfg.game.cs2CfgDir || findCs2CfgDir();
    const ahk = findAhk(cfg.bridge.ahkPath);
    const actions = loadActions(cfg.game.profile);
    const map = new Set(Object.values(loadRewardMap()));
    const enabled = actions.list.filter((a) => a.enabled);
    const base = `http://localhost:${cfg.server.port}`;
    return {
      platform: process.platform,
      packaged: process.env.UCC_PACKAGED === '1',
      brand: cfg.overlay.brand,
      // Verantwortung als Produktmerkmal: Schritt 1 im Setup-Fenster
      // zeigt die Zustimmung nur an, wenn sie noch fehlt (sonst würde ein zurückkehrender Nutzer
      // sie erneut sehen, obwohl sie schon gegeben wurde).
      consent: { riskAcknowledgedAt: cfg.consent.riskAcknowledgedAt },
      twitch: {
        hasClientId: looksLikeClientId(cfg.twitch.clientId),
        clientIdHint: cfg.twitch.clientId ? `${cfg.twitch.clientId.slice(0, 6)}…` : '',
        loggedIn: tw.hasLogin() && !!cfg.twitch.login,
        login: cfg.twitch.login || '',
        clientType: cfg.twitch.clientType || null,
      },
      game: {
        dir: dir || '', dirFound: !!dir, files: dir ? cs2FilesInstalled(dir) : null,
        sensitivity: cfg.game.sensitivity, flash: cfg.keys.flash,
      },
      ahk: { found: !!ahk, supported: process.platform === 'win32' },
      rewards: { enabled: enabled.length, linked: enabled.filter((a) => map.has(a.id)).length, total: actions.list.length },
      urls: { overlay: `${base}/overlay`, dashboard: `${base}/dashboard` },
    };
  }

  // ----- Schritt: Zustimmung zur Eigenverantwortung -----
  // Ohne das kein Start (siehe readiness() in server.js) - hier wird sie mit Zeitstempel in der
  // Config festgehalten, nicht nur angezeigt und vergessen.
  giveConsent() {
    const at = acknowledgeRisk(loadConfig());
    logger.info(`Zustimmung zur Eigenverantwortung gegeben (${at}).`);
    return { ok: true, at };
  }

  // ----- Schritt: Client-ID -----
  setClientId(value) {
    const v = String(value ?? '').trim();
    const problem = clientIdProblem(v);
    if (problem) throw Object.assign(new Error(problem), { status: 400 });
    const cfg = loadConfig();
    if (cfg.twitch.clientId !== v) { // andere ID: alter Login passt nicht mehr
      cfg.twitch = { clientId: v, userId: '', login: '' };
      saveConfig(cfg);
      this.login = { state: 'idle' };
    }
    return { ok: true };
  }

  // ----- Schritt: Login (Device-Code) -----
  async startLogin() {
    const cfg = loadConfig();
    if (!looksLikeClientId(cfg.twitch.clientId)) throw Object.assign(new Error('Es fehlt die Client-ID.'), { status: 400 });
    this.abort?.abort();
    const ctl = new AbortController();
    this.abort = ctl;
    const run = ++this.run;
    let dev;
    try { dev = await startDeviceFlow(cfg.twitch.clientId); }
    catch (e) { this.login = { state: 'error', error: e.message, code: e.code }; throw Object.assign(e, { status: e.code === 'network' ? 502 : 400 }); }
    this.login = { state: 'waiting', userCode: dev.user_code, uri: dev.verification_uri, expiresAt: Date.now() + (dev.expires_in || 600) * 1000 };
    (async () => {
      try {
        const tokens = await pollDeviceFlow(cfg.twitch.clientId, dev, { signal: ctl.signal });
        if (run !== this.run) return;
        const v = await validateToken(tokens.accessToken);
        const missing = SCOPES.split(' ').filter((s) => !v.scopes?.includes(s));
        if (missing.length) throw new TwitchError(`Dem Login fehlen Rechte (${missing.join(', ')}). Bitte nochmal anmelden und alles erlauben.`, 0, 'scopes');
        // Gleich einmal verlängern: zeigt sofort, ob der Login dauerhaft hält (App-Typ "Öffentlich").
        const probe = await probeRefresh(cfg.twitch.clientId, tokens.refreshToken);
        saveTokens(probe.tokens || tokens);
        const c2 = loadConfig();
        c2.twitch = { ...c2.twitch, userId: v.user_id, login: v.login, clientType: probe.clientType ?? c2.twitch.clientType ?? null };
        saveConfig(c2);
        if (probe.clientType === 'confidential') logger.warn('Diese Twitch-App ist als "Vertraulich" angelegt - der Login hält nur rund 4 Stunden. Lösung: neue App mit Client-Typ "Öffentlich" anlegen.');
        let type = '';
        try { type = (await new Twitch(c2).getMe()).broadcaster_type || ''; } catch { /* Kanalstatus optional */ }
        if (run === this.run) this.login = { state: 'ok', login: v.login, broadcasterType: type, clientType: probe.clientType };
        logger.info(`Twitch-Login: ${v.login}${type ? ` (${type})` : ''}`);
      } catch (e) {
        if (run === this.run) this.login = { state: e.code === 'expired' ? 'expired' : e.code === 'aborted' ? 'idle' : 'error', error: e.message };
      }
    })();
    return this.public();
  }

  public() {
    const l = this.login;
    return { state: l.state, userCode: l.userCode, uri: l.uri, expiresInSec: l.expiresAt ? Math.max(0, Math.round((l.expiresAt - Date.now()) / 1000)) : 0, login: l.login, broadcasterType: l.broadcasterType, clientType: l.clientType || null, error: l.error };
  }

  // ----- Schritt: Spiel (CS2-Ordner, Maus, Blendgranate) -----
  saveGame({ dir, sensitivity, flash, install }) {
    const problem = sensitivityProblem(sensitivity);
    if (problem) throw Object.assign(new Error(problem), { status: 400 });
    const flashKey = String(flash ?? '').trim();
    if (!/^[A-Za-z0-9]{1,20}$/.test(flashKey)) throw Object.assign(new Error('Die Blendgranaten-Taste darf nur aus Buchstaben oder Ziffern bestehen, z. B. 7 oder x.'), { status: 400 });
    const folder = String(dir ?? '').trim().replace(/^"|"$/g, '');
    if (folder) {
      let ok = false;
      try { ok = fs.statSync(folder).isDirectory(); } catch { /* fehlt */ }
      if (!ok) throw Object.assign(new Error('Diesen Ordner gibt es nicht. Er endet auf …\\Counter-Strike Global Offensive\\game\\csgo\\cfg'), { status: 400 });
    }
    const cfg = loadConfig();
    cfg.game.sensitivity = Number(String(sensitivity).replace(',', '.'));
    cfg.keys.flash = flashKey;
    if (folder) cfg.game.cs2CfgDir = folder;
    saveConfig(loadConfigChecked(cfg));
    let installed = false;
    const target = folder || cfg.game.cs2CfgDir || findCs2CfgDir();
    if (install && target) {
      installCs2Files(target, cfg.server.port, cfg.server.gsiToken, cfg.game, cfg.keys);
      installed = true;
    }
    return { ok: true, installed, files: target ? cs2FilesInstalled(target) : null, dir: target || '' };
  }

  // ----- AutoHotkey (nur falls nicht mitgeliefert) -----
  installAhk() {
    return new Promise((resolve) => {
      if (process.platform !== 'win32') return resolve({ ok: false, error: 'AutoHotkey gibt es nur für Windows.' });
      let p;
      try { p = spawn('winget.exe', ['install', '-e', '--id', 'AutoHotkey.AutoHotkey', '--accept-package-agreements', '--accept-source-agreements'], { windowsHide: true }); }
      catch (e) { return resolve({ ok: false, error: e.message }); }
      const timer = setTimeout(() => { try { p.kill(); } catch { /* egal */ } resolve({ ok: false, error: 'Die Installation hat zu lange gedauert.' }); }, 180000);
      p.on('error', () => { clearTimeout(timer); resolve({ ok: false, error: 'winget ist nicht verfügbar. Lade AutoHotkey v2 von autohotkey.com.' }); });
      p.on('exit', () => { clearTimeout(timer); const f = findAhk(loadConfig().bridge.ahkPath); resolve(f ? { ok: true } : { ok: false, error: 'Die Installation hat nicht geklappt. Lade AutoHotkey v2 von autohotkey.com.' }); });
    });
  }

  // ----- Schritt: Belohnungen -----
  rewardList() {
    const actions = loadActions(loadConfig().game.profile);
    const map = new Set(Object.values(loadRewardMap()));
    return actions.list.map((a) => ({
      id: a.id, title: a.title, cost: a.cost, category: a.category, enabled: !!a.enabled, legacy: !!a.legacy,
      linked: map.has(a.id), prompt: a.prompt || '',
    }));
  }

  async applyRewards({ enabled = {} } = {}) {
    const cfg = loadConfig();
    const tw = new Twitch(cfg);
    if (!tw.hasLogin()) throw Object.assign(new Error('Du bist noch nicht bei Twitch angemeldet.'), { status: 409 });
    const actions0 = loadActions(cfg.game.profile);
    for (const a of actions0.list) {
      if (Object.hasOwn(enabled, a.id)) setActionEnabled(a.id, !!enabled[a.id], cfg.game.profile);
    }
    try {
      const results = await syncRewards(tw, loadActions(cfg.game.profile));
      return { ok: true, results: results.filter((r) => r.state !== 'übersprungen') };
    } catch (e) {
      throw Object.assign(new Error(explain(e)), { status: 502 });
    }
  }

  // ----- Belohnungen auf dem Kanal, die zu keiner aktuellen Aktion gehören -----
  // Rein informativ + löschbar fürs Aufräumen, syncRewards() fasst sie nicht an.
  async unmatchedRewards() {
    const cfg = loadConfig();
    const tw = new Twitch(cfg);
    if (!tw.hasLogin()) return [];
    try { return await listUnmatchedRewards(tw, loadActions(cfg.game.profile)); }
    catch { return []; } // z. B. (noch) nicht bei Twitch angemeldet oder API kurzzeitig nicht erreichbar
  }

  async deleteUnmatchedReward(id) {
    const cfg = loadConfig();
    const tw = new Twitch(cfg);
    if (!tw.hasLogin()) throw Object.assign(new Error('Du bist noch nicht bei Twitch angemeldet.'), { status: 409 });
    try { await tw.deleteReward(String(id)); }
    catch (e) { throw Object.assign(new Error(explain(e)), { status: 502 }); }
    return { ok: true };
  }
}

// Prüft die geänderte Konfiguration mit denselben Regeln wie beim Start, bevor sie gespeichert wird.
function loadConfigChecked(cfg) {
  if (!(Number(cfg.game.sensitivity) > 0 && Number(cfg.game.sensitivity) <= 30)) throw new Error('Ungültige Sensitivity.');
  return cfg;
}
