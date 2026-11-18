// Twitch: Login (Device-Code), Helix-API, Rewards, EventSub-WebSocket.
// Nur eingebaute Node-Funktionen (fetch, WebSocket).
import { EventEmitter } from 'node:events';
import { LOGIN_SCOPES, loadTokens, saveTokens } from './config.js';
import * as logger from './log.js';

const API = process.env.UCC_TWITCH_API || 'https://api.twitch.tv/helix';
const ID = process.env.UCC_TWITCH_ID || 'https://id.twitch.tv';
const WS_URL = process.env.UCC_EVENTSUB_URL || 'wss://eventsub.wss.twitch.tv/ws';

// Verständliche Meldung, wenn Twitch den Login nicht verlängert.
// Häufigster Grund bei Endnutzern: die eigene App auf dev.twitch.tv ist als "Vertraulich" angelegt.
// Dann verlangt Twitch beim Verlängern ein Client-Secret ("missing client secret"), das ChaosCore als
// Desktop-Programm bewusst nicht hat - der Login hält nur rund 4 Stunden. Endnutzer haben kein
// "npm run login"; der Weg ist das Einrichtungsfenster.
export function refreshFailMessage(status, data) {
  const msg = String(data?.message || data?.error || '').toLowerCase();
  if (msg.includes('missing client secret') || msg.includes('client secret')) {
    return 'Twitch verlängert den Login nicht, weil deine Twitch-App auf dev.twitch.tv als „Vertraulich" angelegt ist. '
      + 'Lege dort eine App mit dem Client-Typ „Öffentlich" an, trage deren Client-ID im Einrichtungsfenster ein und melde dich neu an. '
      + 'Bis dahin musst du dich nach etwa 4 Stunden und nach jedem Neustart erneut anmelden.';
  }
  return 'Der Twitch-Login ist abgelaufen. Bitte im Einrichtungsfenster erneut bei Twitch anmelden.';
}

export class TwitchError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const looksLikeClientId = (s) => /^[a-z0-9]{30}$/i.test(String(s || '').trim());

const form = (o) => new URLSearchParams(o);
async function postForm(url, body) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    throw new TwitchError(`Keine Verbindung zu Twitch (${e.cause?.code || e.message})`, 0, 'network');
  }
  let data = {};
  try { data = await res.json(); } catch { /* leer */ }
  return { res, data };
}

// ---------- Login ----------
// LOGIN_SCOPES (nicht das strengere SCOPES) wird angefragt, damit ein Login direkt die optionalen
// Zugriffsregel-Scopes mitbringt - ohne dass dafür extra etwas
// verlangt werden muss. Fehlen sie trotzdem (z. B. vom Zuschauer bei Twitch abgelehnt), startet
// ChaosCore trotzdem (siehe SCOPES in config.js), nur Zugriffsregeln greifen dann nicht.
export async function startDeviceFlow(clientId, scopes = LOGIN_SCOPES) {
  const { res, data } = await postForm(`${ID}/oauth2/device`, { client_id: clientId, scopes });
  if (!res.ok || !data.device_code) {
    const msg = String(data.message || '');
    if (/invalid client|client id/i.test(msg) || res.status === 400 || res.status === 401) {
      throw new TwitchError('Twitch kennt diese Client-ID nicht. Prüfe sie auf https://dev.twitch.tv/console/apps', res.status, 'invalid_client');
    }
    throw new TwitchError(`Twitch-Fehler beim Start des Logins: ${msg || res.status}`, res.status, 'device_start');
  }
  return data; // device_code, user_code, verification_uri, expires_in, interval
}

export async function pollDeviceFlow(clientId, dev, { scopes = LOGIN_SCOPES, onWait = () => {}, signal } = {}) {
  const deadline = Date.now() + (dev.expires_in || 600) * 1000;
  const interval = Math.max(1, dev.interval || 5) * 1000 * (Number(process.env.UCC_POLL_SCALE) || 1);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    if (signal?.aborted) throw new TwitchError('Login abgebrochen.', 0, 'aborted');
    const { res, data } = await postForm(`${ID}/oauth2/token`, {
      client_id: clientId,
      scopes,
      device_code: dev.device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    if (res.ok && data.access_token) return tokenRecord(data);
    const msg = String(data.message || '');
    if (/authorization_pending/i.test(msg)) { onWait(); continue; }
    if (/slow_down/i.test(msg)) { await new Promise((r) => setTimeout(r, 5000)); continue; }
    throw new TwitchError(`Login abgebrochen: ${msg || res.status}`, res.status, 'device_poll');
  }
  throw new TwitchError('Der Login-Code ist abgelaufen. Bitte nochmal starten.', 0, 'expired');
}

// Twitch verlängert einen Login nur bei Apps mit Client-Typ "Öffentlich" ohne Client-Secret.
// Direkt nach der Anmeldung einmal verlängern zeigt sofort, ob das geht - statt erst nach 4 Stunden.
// Ergebnis: { clientType: 'public', tokens } oder { clientType: 'confidential' } oder { clientType: null } (unklar, z. B. offline).
export const needsSecret = (data) => /client secret/i.test(String(data?.message || data?.error || ''));
export async function probeRefresh(clientId, refreshToken) {
  let r;
  try { r = await postForm(`${ID}/oauth2/token`, { client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken }); }
  catch { return { clientType: null }; }
  if (r.res.ok && r.data.access_token) return { clientType: 'public', tokens: tokenRecord(r.data) };
  if (needsSecret(r.data)) return { clientType: 'confidential' };
  return { clientType: null };
}

function tokenRecord(d) {
  return {
    accessToken: d.access_token,
    refreshToken: d.refresh_token,
    expiresAt: Date.now() + Math.max(60, (d.expires_in || 3600) - 120) * 1000,
    scopes: d.scope || [],
  };
}

export async function validateToken(accessToken) {
  let res;
  try {
    res = await fetch(`${ID}/oauth2/validate`, { headers: { Authorization: `OAuth ${accessToken}` }, signal: AbortSignal.timeout(15000) });
  } catch (e) {
    throw new TwitchError(`Keine Verbindung zu Twitch (${e.cause?.code || e.message})`, 0, 'network');
  }
  if (!res.ok) throw new TwitchError('Der Twitch-Login ist ungültig oder abgelaufen.', res.status, 'invalid_token');
  return res.json(); // client_id, login, scopes, user_id, expires_in
}

// ---------- API-Client ----------
export class Twitch extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.tokens = loadTokens();
    this.status = 'offline';
    this.sock = null;
    this.stopped = false;
    this.seen = new Set();
  }

  hasLogin() { return !!this.tokens?.refreshToken; }

  async accessToken() {
    if (!this.tokens) throw new TwitchError('Nicht eingeloggt. Bitte im Einrichtungsfenster bei Twitch anmelden.', 401, 'no_login');
    if (Date.now() < this.tokens.expiresAt) return this.tokens.accessToken;
    return this.refresh();
  }

  refresh() {
    // Refresh-Tokens sind einmalig: parallele Aufrufe teilen sich eine Anfrage.
    this._refreshing ??= this._doRefresh().finally(() => { this._refreshing = null; });
    return this._refreshing;
  }

  async _doRefresh() {
    const { res, data } = await postForm(`${ID}/oauth2/token`, {
      client_id: this.cfg.twitch.clientId,
      grant_type: 'refresh_token',
      refresh_token: this.tokens.refreshToken,
    });
    if (!res.ok || !data.access_token) {
      if (needsSecret(data)) this.emit('clientType', 'confidential');
      this.setStatus('auth_failed');
      throw new TwitchError(refreshFailMessage(res.status, data), res.status, 'auth_failed');
    }
    this.tokens = { ...this.tokens, ...tokenRecord(data) };
    saveTokens(this.tokens);
    this.emit('clientType', 'public'); // Verlängern ohne Secret klappt nur bei öffentlichen Apps
    logger.info('Twitch-Login erneuert.');
    return this.tokens.accessToken;
  }

  setStatus(s, detail) {
    if (this.status === s && !detail) return;
    this.status = s;
    this.emit('status', s, detail);
  }

  async helix(method, path, body, retry = true) {
    const token = await this.accessToken();
    let res;
    try {
      res = await fetch(`${API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Client-Id': this.cfg.twitch.clientId, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      throw new TwitchError(`Keine Verbindung zu Twitch (${e.cause?.code || e.message})`, 0, 'network');
    }
    if (res.status === 401 && retry) {
      this.tokens.expiresAt = 0;
      return this.helix(method, path, body, false);
    }
    if (res.status === 429 && retry) {
      const wait = Math.max(1, Number(res.headers.get('ratelimit-reset')) - Math.floor(Date.now() / 1000)) || 2;
      await new Promise((r) => setTimeout(r, Math.min(wait, 10) * 1000));
      return this.helix(method, path, body, false);
    }
    let data = {};
    try { data = await res.json(); } catch { /* 204 */ }
    if (!res.ok) throw new TwitchError(data.message || `Twitch-API ${res.status}`, res.status, data.error);
    return data;
  }

  async getMe() {
    const d = await this.helix('GET', '/users');
    if (!d.data?.[0]) throw new TwitchError('Twitch hat keinen Nutzer zurückgegeben.', 0, 'no_user');
    return d.data[0]; // id, login, display_name, broadcaster_type
  }

  async listRewards() {
    const d = await this.helix('GET', `/channel_points/custom_rewards?broadcaster_id=${this.cfg.twitch.userId}&only_manageable_rewards=true`);
    return d.data || [];
  }

  async createReward(body) {
    const d = await this.helix('POST', `/channel_points/custom_rewards?broadcaster_id=${this.cfg.twitch.userId}`, body);
    return d.data[0];
  }

  async updateReward(id, body) {
    const d = await this.helix('PATCH', `/channel_points/custom_rewards?broadcaster_id=${this.cfg.twitch.userId}&id=${encodeURIComponent(id)}`, body);
    return d.data[0];
  }

  async deleteReward(id) {
    await this.helix('DELETE', `/channel_points/custom_rewards?broadcaster_id=${this.cfg.twitch.userId}&id=${encodeURIComponent(id)}`);
  }

  async listRedemptions(rewardId, status = 'UNFULFILLED') {
    const d = await this.helix('GET',
      `/channel_points/custom_rewards/redemptions?broadcaster_id=${this.cfg.twitch.userId}&reward_id=${encodeURIComponent(rewardId)}&status=${status}&first=50`);
    return d.data || [];
  }

  // status: FULFILLED (erledigt) oder CANCELED (Punkte zurück)
  async setRedemption(redemptionId, rewardId, status) {
    await this.helix('PATCH',
      `/channel_points/custom_rewards/redemptions?broadcaster_id=${this.cfg.twitch.userId}&reward_id=${encodeURIComponent(rewardId)}&id=${encodeURIComponent(redemptionId)}`,
      { status });
  }

  // ---------- Zuschauer-Rolle ----------
  // Rein lesende Abfragen, je eine Twitch-API pro Rolle - absichtlich NICHT hier zwischengespeichert
  // (das macht engine.js: AccessCache, mit einer sinnvollen Aktualisierungsfrequenz, damit nicht bei
  // jeder einzelnen Einlösung live abgefragt wird).
  async isModerator(userId) {
    const d = await this.helix('GET', `/moderation/moderators?broadcaster_id=${this.cfg.twitch.userId}&user_id=${encodeURIComponent(userId)}`);
    return (d.data || []).length > 0;
  }

  async isVip(userId) {
    const d = await this.helix('GET', `/channels/vips?broadcaster_id=${this.cfg.twitch.userId}&user_id=${encodeURIComponent(userId)}`);
    return (d.data || []).length > 0;
  }

  async isSubscriber(userId) {
    const d = await this.helix('GET', `/subscriptions?broadcaster_id=${this.cfg.twitch.userId}&user_id=${encodeURIComponent(userId)}`);
    return (d.data || []).length > 0;
  }

  // ---------- Chat ----------
  // Sendet als der Streamer selbst (sender_id = broadcaster_id) - ChaosCore braucht dafür KEINEN
  // eigenen, zweiten Bot-Account - ChaosCore ist bewusst kein eigenständiges Chatbot-Tool.
  async sendChatMessage(text) {
    await this.helix('POST', '/chat/messages', {
      broadcaster_id: this.cfg.twitch.userId,
      sender_id: this.cfg.twitch.userId,
      message: String(text).slice(0, 490), // Twitch-Chat-Obergrenze ist 500 Zeichen, etwas Puffer
    });
  }

  // Nach einer neuen Anmeldung (Notfall-Anmeldung im Dashboard): neue Tokens laden und neu verbinden.
  reloadLogin() {
    this.tokens = loadTokens();
    this.close();
    this.status = 'offline';
    this.connect();
  }

  // ---------- EventSub ----------
  connect() {
    this.stopped = false;
    this.open(WS_URL, 0);
  }

  close() {
    this.stopped = true;
    clearTimeout(this.kaTimer);
    clearTimeout(this.retryTimer);
    try { this.sock?.close(); } catch { /* egal */ }
  }

  open(url, attempt, isMigration = false) {
    if (this.stopped) return;
    if (!isMigration) this.setStatus(attempt ? 'reconnecting' : 'connecting');
    let ws;
    try { ws = new WebSocket(url); } catch (e) {
      logger.error(`WebSocket-Fehler: ${e.message}`);
      return this.retry(attempt);
    }
    const prev = this.sock;
    let welcomed = false;
    ws.onmessage = async (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const type = msg.metadata?.message_type;
      if (msg.metadata?.message_id) {
        if (this.seen.has(msg.metadata.message_id)) return;
        this.seen.add(msg.metadata.message_id);
        if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value);
      }
      if (ws !== this.sock && type !== 'session_welcome') return;
      this.armKeepalive(ws, (msg.payload?.session?.keepalive_timeout_seconds) || this.keepalive || 10);
      if (type === 'session_welcome') {
        welcomed = true;
        this.keepalive = msg.payload.session.keepalive_timeout_seconds || 10;
        this.sock = ws;
        if (prev && prev !== ws) { try { prev.close(); } catch { /* egal */ } }
        if (!isMigration) {
          try {
            await this.subscribe(msg.payload.session.id);
            this.setStatus('connected');
            logger.info('Mit Twitch EventSub verbunden. Warte auf Kanalpunkte-Einlösungen.');
          } catch (e) {
            logger.error(`EventSub-Abo fehlgeschlagen: ${e.message}`);
            if (e.code === 'auth_failed' || e.status === 401 || e.status === 403) this.setStatus('auth_failed', e.message);
            else this.retry(attempt + 1, ws);
          }
        } else this.setStatus('connected');
      } else if (type === 'session_reconnect') {
        this.open(msg.payload.session.reconnect_url, 0, true);
      } else if (type === 'notification') {
        const ev2 = msg.payload?.event;
        if (msg.metadata.subscription_type === 'channel.channel_points_custom_reward_redemption.add' && ev2) this.emit('redemption', ev2);
        else if (msg.metadata.subscription_type === 'channel.cheer' && ev2) this.emit('cheer', ev2);
        else if (msg.metadata.subscription_type === 'channel.chat.message' && ev2) this.emit('chatMessage', ev2);
        else if (msg.metadata.subscription_type === 'stream.online') this.emit('streamOnline', ev2 || {});
        else if (msg.metadata.subscription_type === 'stream.offline') this.emit('streamOffline', ev2 || {});
      } else if (type === 'revocation') {
        logger.error(`Twitch hat das Abo widerrufen: ${JSON.stringify(msg.payload?.subscription?.status)}`);
        this.setStatus('auth_failed', 'Abo widerrufen');
      }
    };
    ws.onclose = () => {
      if (this.stopped || (this.sock && ws !== this.sock) || (prev && !welcomed && isMigration)) return;
      logger.warn('EventSub-Verbindung getrennt.');
      this.retry(attempt + 1, ws);
    };
    ws.onerror = () => { /* onclose übernimmt */ };
  }

  armKeepalive(ws, seconds) {
    clearTimeout(this.kaTimer);
    this.kaTimer = setTimeout(() => {
      if (this.stopped || ws !== this.sock) return;
      logger.warn('Keine Lebenszeichen von Twitch, verbinde neu.');
      try { ws.close(); } catch { /* egal */ }
      this.retry(1, ws);
    }, (seconds * 1.6 + 2) * 1000);
  }

  retry(attempt, ws) {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    clearTimeout(this.kaTimer);
    if (ws && this.sock === ws) this.sock = null;
    if (this.status !== 'auth_failed') this.setStatus('reconnecting');
    const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5)) * (Number(process.env.UCC_POLL_SCALE) || 1);
    this.retryTimer = setTimeout(() => this.open(WS_URL, attempt), delay);
  }

  async subscribe(sessionId) {
    await this.helix('POST', '/eventsub/subscriptions', {
      type: 'channel.channel_points_custom_reward_redemption.add',
      version: '1',
      condition: { broadcaster_user_id: this.cfg.twitch.userId },
      transport: { method: 'websocket', session_id: sessionId },
    });
    // Bits-Cheers: eigenes Abo, bewusst getrennt von oben. Schlägt es fehl (z. B. weil ein
    // bestehender Login noch keinen "bits:read"-Scope hat), bricht das die Kanalpunkte-Verbindung
    // NICHT ab - Bits bleiben dann einfach inaktiv, bis neu eingeloggt wurde ("npm run login").
    try {
      await this.helix('POST', '/eventsub/subscriptions', {
        type: 'channel.cheer',
        version: '1',
        condition: { broadcaster_user_id: this.cfg.twitch.userId },
        transport: { method: 'websocket', session_id: sessionId },
      });
    } catch (e) {
      logger.warn(`Bits-Abo (Cheers) nicht möglich, Kanalpunkte funktionieren trotzdem: ${e.message}. Hilft meist: "npm run login" erneut ausführen.`);
    }
    // Chat lesen, genauso bewusst getrennt/weich fehlschlagend wie
    // Bits oben - ein älterer Login ohne die optionalen CHAT_SCOPES verliert dadurch nur die
    // Chat-Funktion, nicht die Kanalpunkte/Bits-Verbindung.
    try {
      await this.helix('POST', '/eventsub/subscriptions', {
        type: 'channel.chat.message',
        version: '1',
        condition: { broadcaster_user_id: this.cfg.twitch.userId, user_id: this.cfg.twitch.userId },
        transport: { method: 'websocket', session_id: sessionId },
      });
    } catch (e) {
      logger.warn(`Chat-Abo nicht möglich, Kanalpunkte/Bits funktionieren trotzdem: ${e.message}. Hilft meist: "npm run login" erneut ausführen.`);
    }
    // Session Stats: Stream online/offline startet bzw. beendet die
    // Statistik-Sitzung. Braucht keinen zusätzlichen Scope; schlägt es trotzdem fehl, bleibt nur der
    // automatische Start aus (von Hand starten geht weiter).
    for (const type of ['stream.online', 'stream.offline']) {
      try {
        await this.helix('POST', '/eventsub/subscriptions', {
          type, version: '1', condition: { broadcaster_user_id: this.cfg.twitch.userId },
          transport: { method: 'websocket', session_id: sessionId },
        });
      } catch (e) {
        logger.warn(`Abo "${type}" nicht möglich - Session Stats starten dann nicht automatisch mit dem Stream: ${e.message}`);
      }
    }
  }

  // Läuft der Stream gerade? (für den Abgleich nach Start/Neuverbindung, falls stream.online/offline
  // verpasst wurde). null, wenn die Abfrage scheitert.
  async isLive() {
    try {
      const d = await this.helix('GET', `/streams?user_id=${encodeURIComponent(this.cfg.twitch.userId)}`);
      return Array.isArray(d?.data) && d.data.some((x) => x.type === 'live' || !x.type);
    } catch (e) {
      logger.warn(`Stream-Status nicht abrufbar: ${e.message}`);
      return null;
    }
  }
}
