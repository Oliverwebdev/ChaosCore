// Uploads (2.1): Hochkant-Clips zu YouTube (Shorts) und TikTok (als Entwurf) hochladen.
//
// Anmeldung: Ein Klick im Dashboard öffnet die Anmeldeseite von Google bzw. TikTok im Browser. Nach dem
// Bestätigen leitet die Seite auf eine kurzlebige Adresse auf diesem PC (127.0.0.1, zufälliger Port)
// zurück - dort nimmt ChaosCore den Code an und tauscht ihn gegen einen Token (OAuth "Loopback" mit
// PKCE). Die Tokens liegen verschlüsselt im Datenordner (Windows: DPAPI, wie das OBS-Passwort).
//
// App-Daten: ChaosCore bringt eigene App-Daten mit (product.json -> uploads, beim Bauen auch aus
// Umgebungsvariablen). Wer eine eigene Google-/TikTok-App nutzen will, trägt sie im Dashboard ein.
//
// Hochgeladen wird nur die Hochkant-Version (1080x1920, höchstens 59 s). Standard: nur auf Knopfdruck.
// Wahlweise automatisch nach Stream-Ende oder sofort - dann mit Mindest-Punkten und Obergrenze pro Stream.
//
// YouTube: Videos aus noch nicht geprüften Google-Projekten sperrt YouTube auf "privat" - darum ist
// "privat" der Standard. TikTok: Upload als Entwurf in die Inbox der TikTok-App (veröffentlichen musst du
// dort selbst); TikTok erlaubt höchstens 5 offene Entwürfe in 24 Stunden.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { DATA } from './config.js';
import { product } from './product.js';
import { protect, unprotect, cryptoAvailable } from './secret-store.js';
import { TIME_SCALE } from './util.js';

const real = (ms) => ms * TIME_SCALE;
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms).unref?.(); });

import { UPLOAD_PLATFORMS, TIKTOK_DAILY } from './upload-settings.js';

const cleanText = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);

// ---------- Adressen (für Tests über UCC_UPLOAD_API auf einen eigenen Server umlenkbar) ----------
const API = {
  youtube: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    revoke: 'https://oauth2.googleapis.com/revoke',
    upload: 'https://www.googleapis.com/upload/youtube/v3/videos',
    scope: 'https://www.googleapis.com/auth/youtube.upload',
  },
  tiktok: {
    authorize: 'https://www.tiktok.com/v2/auth/authorize/',
    token: 'https://open.tiktokapis.com/v2/oauth/token/',
    revoke: 'https://open.tiktokapis.com/v2/oauth/revoke/',
    userInfo: 'https://open.tiktokapis.com/v2/user/info/?fields=display_name',
    init: 'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/',
    status: 'https://open.tiktokapis.com/v2/post/publish/status/fetch/',
    scope: 'user.info.basic,video.upload',
  },
};
export function apiUrl(platform, key) {
  const u = API[platform][key];
  const base = process.env.UCC_UPLOAD_API;
  if (!base || key === 'scope') return u;
  const p = new URL(u);
  return `${base.replace(/\/$/, '')}/${platform}${p.pathname}${p.search}`;
}

// ---------- App-Daten ----------
const appsFile = () => path.join(DATA, 'upload-apps.json');
const tokensFile = () => path.join(DATA, 'upload-tokens.json');

function readJson(file, d) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return d; } }
function seal(obj) {
  const text = JSON.stringify(obj);
  if (cryptoAvailable()) { try { return { protected: true, value: protect(text) }; } catch { /* dann unverschlüsselt, nur lokal */ } }
  return { protected: false, value: text };
}
function unseal(rec) {
  if (!rec) return null;
  try { return JSON.parse(rec.protected ? unprotect(rec.value) : rec.value); } catch { return null; }
}
function writePrivate(file, data) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
}

// Eingebaute App-Daten: product.json -> uploads.youtube { clientId, clientSecret }, uploads.tiktok { clientKey, clientSecret }
function builtinApp(platform) {
  const u = product.uploads?.[platform] || {};
  if (platform === 'youtube') return u.clientId ? { id: u.clientId, secret: u.clientSecret || '' } : null;
  return u.clientKey && u.clientSecret ? { id: u.clientKey, secret: u.clientSecret } : null;
}
export function ownApp(platform) { return unseal(readJson(appsFile(), {})[platform]); }
export function setOwnApp(platform, id, secret) {
  if (!UPLOAD_PLATFORMS.includes(platform)) throw new Error('Unbekannte Plattform');
  const all = readJson(appsFile(), {});
  const cid = cleanText(id, 200), sec = cleanText(secret, 200);
  if (!cid) delete all[platform];
  else {
    if (!/^[A-Za-z0-9._-]{8,200}$/.test(cid)) throw new Error('Die Client-ID sieht nicht richtig aus');
    if (platform === 'tiktok' && !sec) throw new Error('TikTok braucht auch das Client Secret');
    all[platform] = seal({ id: cid, secret: sec });
  }
  writePrivate(appsFile(), all);
}
function appFor(platform) {
  const own = ownApp(platform);
  if (own?.id) return { ...own, source: 'own' };
  const b = builtinApp(platform);
  return b ? { ...b, source: 'builtin' } : null;
}

// ---------- Tokens ----------
function loadTokens() { const all = readJson(tokensFile(), {}); return Object.fromEntries(UPLOAD_PLATFORMS.map((p) => [p, unseal(all[p])])); }
function saveToken(platform, tok) {
  const all = readJson(tokensFile(), {});
  if (tok) all[platform] = seal(tok); else delete all[platform];
  writePrivate(tokensFile(), all);
}

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function postForm(url, params) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    const msg = body.error_description || body.error?.message || (typeof body.error === 'string' ? body.error : '') || `HTTP ${res.status}`;
    const e = new Error(msg); e.status = res.status; e.code = body.error; throw e;
  }
  return body;
}

// Netzfehler und 5xx/429 lohnen einen neuen Versuch, abgelehnte Anmeldungen o. Ä. nicht.
const retryable = (e) => !e.noRetry && (!e.status || e.status >= 500 || e.status === 429);

export class Uploads extends EventEmitter {
  constructor({ cfg, db, logger, localClips, highlights, twitchLogin = () => '' }) {
    super();
    Object.assign(this, { cfg, db, logger, localClips, highlights, twitchLogin });
    this.tokens = loadTokens();
    this.logins = new Map(); // platform -> { server, state, verifier, timer }
    this.queue = db.kvGet?.('upload_queue', []) || [];
    for (const j of this.queue) if (j.status === 'uploading') { j.status = 'queued'; j.detail = 'nach Neustart erneut'; } // Absturz mitten im Upload
    this.streamCount = 0;
    this.live = false;
    this.working = false;
    this.closed = false;
    this.seq = Math.max(0, ...this.queue.map((j) => j.id || 0));
  }

  settings() { return this.cfg.uploads; }
  save() { try { this.db.kvSet?.('upload_queue', this.queue.slice(-200)); } catch (e) { this.logger.warn(`Upload-Liste nicht gespeichert: ${e.message}`); } this.emit('change'); }

  // ---------- Zustand fürs Dashboard ----------
  account(platform) {
    const t = this.tokens[platform];
    const app = appFor(platform);
    return { connected: !!t?.refresh_token, account: t?.account || '', app: app ? app.source : 'none', loggingIn: this.logins.has(platform), ownApp: !!ownApp(platform)?.id };
  }
  tiktokSent24h() {
    const since = Date.now() - 24 * 3600e3;
    return (this.db.kvGet?.('tiktok_sent', []) || []).filter((ts) => ts > since);
  }
  publicState() {
    return {
      settings: this.cfg.uploads,
      accounts: { youtube: this.account('youtube'), tiktok: { ...this.account('tiktok'), sent24h: this.tiktokSent24h().length, daily: TIKTOK_DAILY } },
      queue: this.queue.slice(-50).reverse(),
      streamCount: this.streamCount,
    };
  }
  // Für die Prüfliste "Clip-Automatik bereit?": automatische Uploads brauchen ein verbundenes Konto.
  readiness() {
    const s = this.cfg.uploads;
    if (s.when === 'manual') return [];
    return UPLOAD_PLATFORMS.filter((p) => s[p].auto).map((p) => ({ id: `upload_${p}`, ok: !!this.tokens[p]?.refresh_token, need: true }));
  }

  // ---------- Anmeldung (Loopback + PKCE) ----------
  async startLogin(platform) {
    if (!UPLOAD_PLATFORMS.includes(platform)) throw new Error('Unbekannte Plattform');
    const app = appFor(platform);
    if (!app) throw new Error(platform === 'youtube' ? 'Für YouTube sind noch keine App-Daten hinterlegt (Dashboard: eigene App eintragen).' : 'Für TikTok sind noch keine App-Daten hinterlegt (Dashboard: eigene App eintragen).');
    this.cancelLogin(platform);
    const verifier = b64url(crypto.randomBytes(48));
    const state = b64url(crypto.randomBytes(18));
    const hash = crypto.createHash('sha256').update(verifier).digest();
    const server = http.createServer((req, res) => this.onCallback(platform, req, res));
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    const redirect = platform === 'youtube' ? `http://127.0.0.1:${port}/` : `http://127.0.0.1:${port}/callback/`;
    const timer = setTimeout(() => this.cancelLogin(platform), real(10 * 60e3));
    timer.unref?.();
    this.logins.set(platform, { server, state, verifier, redirect, app, timer });
    let url;
    if (platform === 'youtube') {
      url = `${apiUrl('youtube', 'authorize')}?${new URLSearchParams({ client_id: app.id, redirect_uri: redirect, response_type: 'code', scope: API.youtube.scope,
        code_challenge: b64url(hash), code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent', state })}`;
    } else {
      // TikTok erwartet die Prüfsumme als Hex (nicht Base64url wie im PKCE-Standard).
      url = `${apiUrl('tiktok', 'authorize')}?${new URLSearchParams({ client_key: app.id, redirect_uri: redirect, response_type: 'code', scope: API.tiktok.scope,
        code_challenge: hash.toString('hex'), code_challenge_method: 'S256', state })}`;
    }
    this.emit('change');
    return { url };
  }

  cancelLogin(platform) {
    const l = this.logins.get(platform);
    if (!l) return;
    clearTimeout(l.timer);
    try { l.server.close(); } catch { /* egal */ }
    this.logins.delete(platform);
    this.emit('change');
  }

  async onCallback(platform, req, res) {
    const l = this.logins.get(platform);
    const url = new URL(req.url, 'http://127.0.0.1');
    const page = (ok, text) => {
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><meta charset="utf-8"><title>ChaosCore</title><body style="font-family:sans-serif;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0"><div style="max-width:420px;text-align:center"><h2>${ok ? '✔' : '✖'} ChaosCore</h2><p>${text}</p></div></body>`);
    };
    if (!l || !url.searchParams.has('state') && !url.searchParams.has('error')) { page(false, 'Diese Anmeldung ist nicht mehr gültig. Bitte im Dashboard neu starten.'); return; }
    if (url.searchParams.get('state') !== l.state) { page(false, 'Ungültige Anfrage.'); return; }
    if (url.searchParams.get('error')) {
      page(false, 'Anmeldung abgebrochen. Du kannst dieses Fenster schließen.');
      this.logger.warn(`${platform === 'youtube' ? 'YouTube' : 'TikTok'}-Anmeldung abgebrochen: ${cleanText(url.searchParams.get('error_description') || url.searchParams.get('error'), 120)}`);
      this.cancelLogin(platform);
      return;
    }
    const code = url.searchParams.get('code') || '';
    try {
      const tok = await this.exchange(platform, l, code);
      saveToken(platform, tok);
      this.tokens[platform] = tok;
      page(true, 'Verbunden! Du kannst dieses Fenster schließen und zu ChaosCore zurückkehren.');
      this.logger.info(`${platform === 'youtube' ? 'YouTube' : 'TikTok'} verbunden${tok.account ? ` (${tok.account})` : ''}.`);
      this.kick();
    } catch (e) {
      page(false, 'Die Anmeldung hat nicht geklappt. Details stehen im ChaosCore-Log.');
      this.logger.warn(`${platform === 'youtube' ? 'YouTube' : 'TikTok'}-Anmeldung fehlgeschlagen: ${e.message}`);
    }
    this.cancelLogin(platform);
  }

  async exchange(platform, l, code) {
    if (platform === 'youtube') {
      const t = await postForm(apiUrl('youtube', 'token'), { code, client_id: l.app.id, ...(l.app.secret ? { client_secret: l.app.secret } : {}), redirect_uri: l.redirect, grant_type: 'authorization_code', code_verifier: l.verifier });
      if (!t.refresh_token) throw new Error('Google hat keinen dauerhaften Zugang geliefert - bitte erneut anmelden');
      return { refresh_token: t.refresh_token, access_token: t.access_token, expires_at: Date.now() + (Number(t.expires_in) || 3600) * 1000, account: 'YouTube', app: l.app.source };
    }
    const t = await postForm(apiUrl('tiktok', 'token'), { client_key: l.app.id, client_secret: l.app.secret, code, grant_type: 'authorization_code', redirect_uri: l.redirect, code_verifier: l.verifier });
    const tok = { refresh_token: t.refresh_token, access_token: t.access_token, expires_at: Date.now() + (Number(t.expires_in) || 86400) * 1000, open_id: t.open_id, account: 'TikTok', app: l.app.source };
    try {
      const r = await fetch(apiUrl('tiktok', 'userInfo'), { headers: { Authorization: `Bearer ${tok.access_token}` } });
      const j = await r.json();
      if (j?.data?.user?.display_name) tok.account = cleanText(j.data.user.display_name, 60);
    } catch { /* Name ist nur Anzeige */ }
    return tok;
  }

  async accessToken(platform) {
    const t = this.tokens[platform];
    if (!t?.refresh_token) throw Object.assign(new Error(`${platform === 'youtube' ? 'YouTube' : 'TikTok'} ist nicht verbunden`), { status: 401 });
    if (t.access_token && t.expires_at - Date.now() > 60e3) return t.access_token;
    const app = appFor(platform);
    if (!app) throw Object.assign(new Error('App-Daten fehlen'), { status: 401 });
    let r;
    try {
      r = platform === 'youtube'
        ? await postForm(apiUrl('youtube', 'token'), { client_id: app.id, ...(app.secret ? { client_secret: app.secret } : {}), refresh_token: t.refresh_token, grant_type: 'refresh_token' })
        : await postForm(apiUrl('tiktok', 'token'), { client_key: app.id, client_secret: app.secret, refresh_token: t.refresh_token, grant_type: 'refresh_token' });
    } catch (e) {
      if (e.status === 400 || e.status === 401) { // Zugang widerrufen oder abgelaufen: neu anmelden
        this.logger.warn(`${platform === 'youtube' ? 'YouTube' : 'TikTok'}-Zugang abgelaufen - bitte im Dashboard neu verbinden.`);
        this.tokens[platform] = null; saveToken(platform, null); this.emit('change');
        throw Object.assign(new Error('Zugang abgelaufen - bitte neu verbinden'), { status: 401 });
      }
      throw e;
    }
    Object.assign(t, { access_token: r.access_token, expires_at: Date.now() + (Number(r.expires_in) || 3600) * 1000, ...(r.refresh_token ? { refresh_token: r.refresh_token } : {}) });
    saveToken(platform, t);
    return t.access_token;
  }

  async logout(platform) {
    this.cancelLogin(platform);
    const t = this.tokens[platform];
    const app = appFor(platform);
    if (t?.refresh_token) {
      try {
        if (platform === 'youtube') await postForm(apiUrl('youtube', 'revoke'), { token: t.refresh_token });
        else if (app) await postForm(apiUrl('tiktok', 'revoke'), { client_key: app.id, client_secret: app.secret, token: t.access_token || '' });
      } catch { /* lokal wird trotzdem getrennt */ }
    }
    this.tokens[platform] = null;
    saveToken(platform, null);
    this.logger.info(`${platform === 'youtube' ? 'YouTube' : 'TikTok'} getrennt.`);
    this.emit('change');
  }

  // ---------- Warteschlange ----------
  row(id) { return this.db.highlightList(2000).find((r) => r.id === Number(id)) || null; }

  // Manuell (Knopf in der Highlight-Liste) oder automatisch (auto = true).
  enqueue(highlightId, platform, { auto = false } = {}) {
    if (!UPLOAD_PLATFORMS.includes(platform)) throw new Error('Unbekannte Plattform');
    const row = this.row(highlightId);
    if (!row) throw new Error('Highlight nicht gefunden');
    if (!row.videoFile && !row.shortFile) throw new Error('Zu diesem Highlight gibt es keinen lokalen Clip');
    if (this.queue.some((j) => j.highlightId === row.id && j.platform === platform && !['error', 'canceled'].includes(j.status))) throw new Error('Ist schon in der Upload-Liste');
    if (!this.tokens[platform]?.refresh_token && !auto) throw new Error(`${platform === 'youtube' ? 'YouTube' : 'TikTok'} ist nicht verbunden`);
    const wait = auto && this.cfg.uploads.when === 'after_stream' && this.live;
    const job = { id: ++this.seq, highlightId: row.id, platform, title: row.title, status: wait ? 'waiting' : 'queued', auto, created: Date.now(), attempts: 0, detail: wait ? 'nach Stream-Ende' : '' };
    this.queue.push(job);
    this.save();
    this.kick();
    return job;
  }

  cancel(id) {
    const j = this.queue.find((x) => x.id === Number(id));
    if (!j) throw new Error('Nicht gefunden');
    if (j.status === 'uploading') throw new Error('Läuft gerade - bitte kurz warten');
    if (['queued', 'waiting', 'error'].includes(j.status)) { j.status = 'canceled'; this.save(); }
    return j;
  }
  retry(id) {
    const j = this.queue.find((x) => x.id === Number(id));
    if (!j || !['error', 'canceled'].includes(j.status)) throw new Error('Nur fehlgeschlagene oder abgebrochene Uploads');
    Object.assign(j, { status: 'queued', attempts: 0, detail: '', error: '' });
    this.save(); this.kick();
    return j;
  }

  // Ein neuer Hochkant-Clip ist fertig (local-clips.js) - bei automatischen Uploads einreihen.
  onShort(row) {
    const s = this.cfg.uploads;
    if (s.when === 'manual' || this.closed) return;
    if ((row.score ?? 0) < s.minScore) return;
    if (s.maxPerStream && this.streamCount >= s.maxPerStream) { this.logger.info(`Automatischer Upload übersprungen: Obergrenze (${s.maxPerStream}) für diesen Stream erreicht.`); return; }
    let any = false;
    for (const p of UPLOAD_PLATFORMS) {
      if (!s[p].auto || !this.tokens[p]?.refresh_token) continue;
      try { this.enqueue(row.id, p, { auto: true }); any = true; } catch (e) { this.logger.warn(`Automatischer Upload (${p}): ${e.message}`); }
    }
    if (any) this.streamCount++;
  }

  setLive(live) {
    const was = this.live;
    this.live = !!live;
    if (live && !was) this.streamCount = 0;
    if (!live) { // Stream vorbei (oder nach einem Neustart offline): wartende Uploads starten
      let n = 0;
      for (const j of this.queue) if (j.status === 'waiting') { j.status = 'queued'; j.detail = ''; n++; }
      if (n) { this.logger.info(`Stream beendet: ${n} Upload(s) starten.`); this.save(); }
    }
    this.kick();
  }

  kick() { if (!this.working && !this.closed) this.work().catch((e) => this.logger.warn(`Upload-Warteschlange: ${e.message}`)); }

  async work() {
    this.working = true;
    try {
      for (;;) {
        if (this.closed) return;
        const j = this.queue.find((x) => x.status === 'queued' && (!x.notBefore || x.notBefore <= Date.now()));
        if (!j) {
          const later = this.queue.filter((x) => x.status === 'queued' && x.notBefore).map((x) => x.notBefore);
          if (later.length) { const t = setTimeout(() => this.kick(), Math.max(50, Math.min(...later) - Date.now())); t.unref?.(); }
          return;
        }
        await this.runJob(j);
      }
    } finally { this.working = false; }
  }

  async runJob(j) {
    j.status = 'uploading'; j.attempts++; j.detail = ''; j.error = ''; this.save();
    try {
      const file = await this.videoFor(j);
      await this.aiText(j);
      const out = j.platform === 'youtube' ? await this.uploadYoutube(j, file) : await this.uploadTiktok(j, file);
      Object.assign(j, { status: 'done', done: Date.now(), detail: '', error: '', ...out });
      this.logger.info(`Upload fertig (${j.platform === 'youtube' ? 'YouTube' : 'TikTok'}): „${j.title}“${out.url ? ` - ${out.url}` : ''}`);
    } catch (e) {
      if (retryable(e) && j.attempts < 3) {
        Object.assign(j, { status: 'queued', detail: `neuer Versuch (${j.attempts}/3)`, error: e.message, notBefore: Date.now() + real(15000 * j.attempts) });
        this.logger.warn(`Upload unterbrochen (${j.platform}): ${e.message} - neuer Versuch gleich.`);
      } else {
        Object.assign(j, { status: 'error', error: e.message });
        this.logger.warn(`Upload fehlgeschlagen (${j.platform}): ${e.message}`);
      }
    }
    this.save();
  }

  // Nur die Hochkant-Version wird hochgeladen. Fehlt sie, wird sie jetzt erzeugt (braucht ffmpeg).
  async videoFor(j) {
    let row = this.row(j.highlightId);
    if (!row) throw Object.assign(new Error('Highlight wurde gelöscht'), { status: 410 });
    if (!row.shortFile || !fs.existsSync(row.shortFile)) {
      if (!row.videoFile || !fs.existsSync(row.videoFile)) throw Object.assign(new Error('Die Clip-Datei fehlt'), { status: 410 });
      j.detail = 'Hochkant-Version wird erstellt'; this.save();
      try { await this.localClips.makeShort(row.id); } catch (e) { throw Object.assign(new Error(`Hochkant-Version nicht möglich: ${e.message}`), { status: 422 }); }
      row = this.row(j.highlightId);
    }
    return row.shortFile;
  }

  // KI-Assistent (ai.js): Titel, Hashtags und Beschreibung - einmal pro Upload, sonst die Vorlage.
  async aiText(j) {
    if (j.text || !this.ai?.connected || !this.cfg.ai?.uploads) return;
    const row = this.row(j.highlightId);
    if (!row) return;
    try {
      j.detail = 'KI schreibt den Titel'; this.save();
      j.text = await this.ai.clipText(row);
      // TikTok nimmt beim Entwurf keinen Text an - der Vorschlag steht zum Kopieren im Dashboard.
      if (j.platform === 'tiktok') j.caption = `${j.text.title} ${j.text.hashtags.join(' ')}`.trim();
    } catch (e) {
      this.logger.warn(`KI-Texte nicht erstellt, Vorlage genutzt: ${e.message}`);
    }
  }

  titleFor(j, max) {
    // Eigene Hashtags (Einstellung) stehen immer im Titel; die der KI nur, solange Platz ist.
    const own = j.platform === 'youtube' ? this.cfg.uploads.youtube.hashtags : '';
    const ownSet = new Set((own.match(/#[\p{L}\p{N}_]+/gu) || []).map((h) => h.toLowerCase()));
    let tags = own;
    for (const h of j.text?.hashtags || []) if (!ownSet.has(h.toLowerCase()) && (tags + ' ' + h).trim().length <= 40) { tags = `${tags} ${h}`.trim(); ownSet.add(h.toLowerCase()); }
    const t = String(j.text?.title || j.title || 'ChaosCore Highlight');
    const room = max - (tags ? tags.length + 1 : 0);
    return (t.length > room ? `${t.slice(0, Math.max(10, room - 1))}…` : t) + (tags ? ` ${tags}` : '');
  }

  async uploadYoutube(j, file) {
    const token = await this.accessToken('youtube');
    const size = fs.statSync(file).size;
    const s = this.cfg.uploads.youtube;
    const login = this.twitchLogin();
    const description = [j.text?.description, s.description, login ? `Live auf Twitch: https://www.twitch.tv/${login}` : '', 'Erstellt mit ChaosCore'].filter(Boolean).join('\n\n');
    const tags = [...new Set([...(s.hashtags.match(/#[\p{L}\p{N}_]+/gu) || []), ...(j.text?.hashtags || [])].map((x) => x.slice(1)))].slice(0, 15);
    const meta = { snippet: { title: this.titleFor(j, 100), description: description.slice(0, 4900), tags, categoryId: '20' }, status: { privacyStatus: s.privacy, selfDeclaredMadeForKids: false } };
    const init = await fetch(`${apiUrl('youtube', 'upload')}?uploadType=resumable&part=snippet,status`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Length': String(size), 'X-Upload-Content-Type': 'video/mp4' },
      body: JSON.stringify(meta),
    });
    if (!init.ok) throw await httpError(init, 'YouTube');
    const loc = init.headers.get('location');
    if (!loc) throw new Error('YouTube hat keine Upload-Adresse geliefert');
    j.detail = 'lädt hoch'; this.save();
    const put = await fetch(loc, { method: 'PUT', headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(size) }, body: fs.readFileSync(file) });
    if (!put.ok) throw await httpError(put, 'YouTube');
    const v = await put.json();
    return { remoteId: v.id, url: v.id ? `https://youtube.com/shorts/${v.id}` : '', privacy: s.privacy };
  }

  async uploadTiktok(j, file) {
    const sent = this.tiktokSent24h();
    if (sent.length >= TIKTOK_DAILY) throw Object.assign(new Error(`TikTok erlaubt höchstens ${TIKTOK_DAILY} Entwürfe in 24 Stunden - später erneut versuchen`), { status: 429, noRetry: true });
    const token = await this.accessToken('tiktok');
    const size = fs.statSync(file).size;
    // Bis 64 MB in einem Stück, sonst 10-MB-Stücke (das letzte nimmt den Rest auf).
    const chunk = size <= 64e6 ? size : 10e6;
    const count = size <= 64e6 ? 1 : Math.floor(size / chunk);
    const init = await fetch(apiUrl('tiktok', 'init'), {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: chunk, total_chunk_count: count } }),
    });
    const ij = await init.json().catch(() => ({}));
    if (!init.ok || (ij.error?.code && ij.error.code !== 'ok')) {
      const code = ij.error?.code || '';
      const msg = code === 'spam_risk_too_many_pending_share' ? `TikTok: zu viele offene Entwürfe (max. ${TIKTOK_DAILY} in 24 h)` : `TikTok: ${ij.error?.message || code || `HTTP ${init.status}`}`;
      throw Object.assign(new Error(msg), { status: init.status || 400, noRetry: code.startsWith('spam_risk') });
    }
    const { upload_url: uploadUrl, publish_id: publishId } = ij.data || {};
    if (!uploadUrl) throw new Error('TikTok hat keine Upload-Adresse geliefert');
    j.detail = 'lädt hoch'; this.save();
    const fd = fs.openSync(file, 'r');
    try {
      for (let i = 0; i < count; i++) {
        const start = i * chunk;
        const end = i === count - 1 ? size - 1 : start + chunk - 1;
        const buf = Buffer.alloc(end - start + 1);
        fs.readSync(fd, buf, 0, buf.length, start);
        const r = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(buf.length), 'Content-Range': `bytes ${start}-${end}/${size}` }, body: buf });
        if (!r.ok) throw await httpError(r, 'TikTok');
      }
    } finally { fs.closeSync(fd); }
    this.db.kvSet?.('tiktok_sent', [...sent, Date.now()]);
    j.detail = 'TikTok verarbeitet'; this.save();
    for (let i = 0; i < 40; i++) { // höchstens ~2 Minuten auf die Bestätigung warten
      await sleep(real(3000));
      const r = await fetch(apiUrl('tiktok', 'status'), { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ publish_id: publishId }) });
      const sj = await r.json().catch(() => ({}));
      const st = sj?.data?.status;
      if (st === 'FAILED') throw Object.assign(new Error(`TikTok: Verarbeitung fehlgeschlagen (${sj.data.fail_reason || 'unbekannt'})`), { status: 422 });
      if (st === 'SEND_TO_USER_INBOX' || st === 'PUBLISH_COMPLETE') return { remoteId: publishId, url: '', inbox: true };
    }
    return { remoteId: publishId, url: '', inbox: true, detail: 'TikTok verarbeitet noch - der Entwurf erscheint gleich in der App' };
  }

  close() {
    this.closed = true;
    for (const p of UPLOAD_PLATFORMS) this.cancelLogin(p);
  }
}

async function httpError(res, who) {
  let msg = '';
  try { const j = await res.json(); msg = j.error?.message || j.error_description || j.error || ''; } catch { /* kein JSON */ }
  return Object.assign(new Error(`${who}: ${msg || `HTTP ${res.status}`}`), { status: res.status });
}
