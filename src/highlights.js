// Highlights: starke Momente erkennen, bewerten und festhalten - als Twitch-Marker, Twitch-Clip und
// in der Highlight-Liste (mit Zeit im VOD), später auch als lokaler Clip über OBS (obs.js).
//
// Nicht jeder Moment wird markiert. Jede Moment-Art hat Punkte; Momente, die kurz nacheinander
// passieren, werden zu EINEM Highlight zusammengefasst (ein Clip, ein Titel). Markiert wird erst ab
// minScore, ein Clip erst ab clipScore, und höchstens ein Marker alle zwei Minuten - außer der neue
// Moment ist stärker. So bleibt die Liste kurz und jeder Eintrag ist es wert.
import { EventEmitter } from 'node:events';
import { TitleMaker, TITLE_FIELDS } from './highlight-titles.js';
import { TIME_SCALE } from './util.js';
import { findFfmpeg } from './local-clips.js';

const real = (ms) => ms * TIME_SCALE;

export const HIGHLIGHT_TYPES = ['chaos_death', 'clutch', 'bits_big', 'challenge', 'streak', 'pot', 'goal', 'raid', 'viewer_clip'];

export const HIGHLIGHT_DEFAULT = {
  enabled: true,
  markers: true,
  clips: true,
  minScore: 3,
  clipScore: 4,
  maxClips: 5, // Twitch-Clips pro Stream (0 = ohne Grenze) - die öffentliche Clip-Liste soll hochwertig bleiben
  autoCurse: false, // Tode durch den Auto-Fluch (Inaktivität) als Highlight zählen (2 Punkte)
  tone: 'frech',
  types: Object.fromEntries(HIGHLIGHT_TYPES.map((t) => [t, true])),
  customTitles: [],
};

export const MAX_CUSTOM_TITLES = 60;

// Für die eine Log-Warnung beim Live-Gehen (das Dashboard hat eigene, übersetzte Texte).
const READINESS_TEXT = {
  scopes: 'Twitch-Rechte für Clips/Marker fehlen (neu anmelden)',
  obs: 'OBS nicht verbunden',
  replay: 'Wiederholungspuffer in OBS läuft nicht',
  ffmpeg: 'ffmpeg fehlt (Hochkant-Versionen)',
  upload_youtube: 'YouTube nicht verbunden',
  upload_tiktok: 'TikTok nicht verbunden',
};

// Eigene Titel-Bausteine: nur bekannte Platzhalter, kurz, keine Steuerzeichen.
export function normalizeCustomTitles(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const c of list) {
    const type = c?.type === 'any' || HIGHLIGHT_TYPES.includes(c?.type) ? c.type : null;
    const text = String(c?.text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!type || text.length < 3) continue;
    const bad = [...text.matchAll(/\{(\w+)\}/g)].map(([, k]) => k).filter((k) => !TITLE_FIELDS.includes(k));
    if (bad.length) throw new Error(`Unbekannter Platzhalter {${bad[0]}} - erlaubt: ${TITLE_FIELDS.map((k) => `{${k}}`).join(' ')}`);
    const key = `${type}|${text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type, text });
    if (out.length >= MAX_CUSTOM_TITLES) break;
  }
  return out;
}

const MERGE_MS = 30000; // Momente innerhalb dieser Zeit = ein Highlight
const MAX_SPAN_MS = 90000;
const MARKER_GAP_MS = 120000;
const CLIP_DELAY_MS = 6000; // Twitch schneidet rückwirkend - kurz warten, damit der Moment drin ist

// Punkte je Moment (ab 2.1): 3 Kills in einer Runde = 3, 4 Kills = 4, Ace = 6, je +1 wenn die
// letzten drei Kills innerhalb von 5 Sekunden fielen. Chaos-Tod durch einen Zuschauer = 3, durch den
// Auto-Fluch = 2 (nur wenn eingeschaltet). Höchstens 8.
export function score(m) {
  switch (m.type) {
    case 'chaos_death': return m.system ? 2 : 3;
    case 'clutch': return Math.min(6, 2 + (m.kills || 2));
    case 'bits_big': return m.bits >= 1000 ? 4 : 3;
    case 'challenge': return 4;
    case 'viewer_clip': return 4;
    case 'streak': return Math.min(8, (m.kills >= 5 ? 6 : m.kills >= 4 ? 4 : m.kills >= 3 ? 3 : 2) + (m.fast ? 1 : 0));
    case 'pot': return 3;
    case 'goal': return 3;
    case 'raid': return 2;
    default: return 1;
  }
}

export function normalizeHighlights(h) {
  const v = h && typeof h === 'object' ? h : {};
  const n = (x, d, lo, hi) => { const k = Math.round(Number(x ?? d)); return k >= lo && k <= hi ? k : d; };
  return {
    enabled: v.enabled !== false, markers: v.markers !== false, clips: v.clips !== false,
    minScore: n(v.minScore, 3, 1, 8), clipScore: n(v.clipScore, 4, 1, 8), maxClips: n(v.maxClips, 5, 0, 50),
    autoCurse: v.autoCurse === true,
    tone: ['frech', 'episch', 'trocken'].includes(v.tone) ? v.tone : 'frech',
    types: Object.fromEntries(HIGHLIGHT_TYPES.map((t) => [t, v.types?.[t] !== false])),
    customTitles: (() => { try { return normalizeCustomTitles(v.customTitles); } catch { return []; } })(),
  };
}

const hms = (sec) => {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

export class Highlights extends EventEmitter {
  constructor({ cfg, db, twitch, gsi, logger, locale = 'de', clipDelayMs = CLIP_DELAY_MS, localClips = null }) {
    super();
    Object.assign(this, { cfg, db, twitch, gsi, logger, clipDelayMs, localClips });
    this.titles = new TitleMaker({ locale, tone: cfg.highlights?.tone });
    this.titles.setStyle({ custom: cfg.highlights?.customTitles || [] });
    this.group = null;
    this.timer = null;
    this.lastMarker = { at: 0, score: 0 };
    this.clipsThisStream = 0;
    this.streamStart = null; // Date.now()-Wert des Stream-Starts (für die Zeit im VOD)
    this.closed = false;
  }

  setLocale(locale) { this.titles.setStyle({ locale, tone: this.cfg.highlights?.tone, custom: this.cfg.highlights?.customTitles || [] }); }

  // Stream an/aus: Startzeit für die VOD-Zeit; neuer Stream = frische Titel-Statistik.
  async setLive(live) {
    if (!live) { this.streamStart = null; if (this.localClips) this.localClips.streamStart = null; return; }
    try {
      const s = await this.twitch.getStream();
      const t = s?.started_at ? Date.parse(s.started_at) : NaN;
      this.streamStart = Number.isFinite(t) ? t : Date.now();
    } catch { this.streamStart = Date.now(); }
    if (this.localClips) this.localClips.streamStart = this.streamStart;
    this.titles.resetStream();
    this.clipsThisStream = 0;
    // Fehlt ein Glied der Clip-Kette, soll man das beim Live-Gehen sofort merken - genau eine Warnung.
    const r = this.readiness();
    if (r.problems.length) this.logger.warn(`Stream läuft, aber die Clip-Automatik ist unvollständig: ${r.problems.map((id) => READINESS_TEXT[id] || id).join(', ')}. Details im Dashboard unter „Braucht dich“.`);
    this.emit('change');
  }

  // Prüfliste "Clip-Automatik bereit?" (Dashboard: Braucht dich + Highlights). Jedes Glied der Kette
  // mit ok = true/false (null = gerade nicht prüfbar) und need = ob es bei den Einstellungen gebraucht wird.
  readiness() {
    const h = this.cfg.highlights || {};
    const lc = this.cfg.localClips || {};
    const obs = this.localClips?.obs;
    const tw = this.twitch;
    const items = [];
    const add = (id, ok, need = true) => items.push({ id, ok, need });
    const twitchClips = h.enabled && (h.clips || h.markers);
    add('scopes', !!(tw?.hasScope?.('clips:edit') && tw?.hasScope?.('channel:manage:broadcast')), !!twitchClips);
    add('local', !!lc.enabled, false);
    if (lc.enabled) {
      const conn = obs?.status === 'connected';
      add('obs', conn);
      add('replay', conn ? obs.replayActive === true : null);
      if (lc.shorts) add('ffmpeg', this.ffmpegFound(lc.ffmpeg));
    }
    for (const x of this.extraReadiness?.() || []) items.push(x); // Uploads (uploads.js)
    return { live: this.streamStart !== null, items, problems: items.filter((i) => i.need && i.ok === false).map((i) => i.id) };
  }

  // findFfmpeg startet ffmpeg testweise - darum nur einmal pro Minute (und neu nach Änderungen).
  ffmpegFound(configured) {
    const now = Date.now();
    if (!this.ffCache || this.ffCache.path !== configured || now - this.ffCache.at > 60000) this.ffCache = { at: now, path: configured, ok: !!findFfmpeg(configured) };
    return this.ffCache.ok;
  }

  // Ein Moment aus Engine/Session-Stats. m: { type, user?, effect?, secs?, kills?, bits?, result?, ... }
  add(m) {
    const h = this.cfg.highlights;
    if (this.closed || !h?.enabled || !h.types[m.type]) return;
    if (m.system && !h.autoCurse) return; // Auto-Fluch-Tode nur, wenn so eingestellt
    const g = this.gsi?.get?.() || {};
    const moment = { ...m, at: Date.now(), round: m.round ?? g.round ?? null, map: m.map ?? g.map ?? null, score: score(m) };
    if (this.group && (moment.at - this.group.first > real(MAX_SPAN_MS))) this.flushNow();
    if (!this.group) this.group = { first: moment.at, moments: [] };
    // Gleiche Moment-Art vom selben Effekt (z. B. 2. und 3. Kill) ersetzt die schwächere statt sich zu stapeln.
    const same = this.group.moments.findIndex((x) => x.type === moment.type && x.user === moment.user && x.effect === moment.effect);
    if (same >= 0) { if (moment.score >= this.group.moments[same].score) this.group.moments[same] = moment; }
    else this.group.moments.push(moment);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flushNow(), real(MERGE_MS));
    this.timer.unref?.();
  }

  flushNow() {
    clearTimeout(this.timer);
    const g = this.group;
    this.group = null;
    if (!g || !g.moments.length) return null;
    return this.publish(g).catch((e) => this.logger.warn(`Highlight nicht gespeichert: ${e.message}`));
  }

  async publish(g) {
    const h = this.cfg.highlights;
    const sorted = [...g.moments].sort((a, b) => b.score - a.score);
    const main = sorted[0];
    // Zusammengefasst: stärkster Moment + 1 Punkt je weiterem (höchstens +2)
    const total = Math.min(main.score + Math.min(2, sorted.length - 1), 8);
    if (total < Math.min(h.minScore, 2)) return null; // Kleinkram gar nicht erst merken
    const offsetSec = this.streamStart ? Math.max(0, (g.first - this.streamStart) / 1000) : null;
    const extra = sorted[1] ? this.shortLabel(sorted[1]) : null;
    const title = this.titles.make({ ...main, extra, streamTime: offsetSec !== null ? hms(offsetSec) : null });
    const row = { ts: g.first, offsetSec, type: main.type, score: total, title, users: [...new Set(sorted.map((m) => m.user).filter(Boolean))].join(', '), status: 'list' };
    row.id = this.db.highlightAdd(row);
    const live = this.streamStart !== null;
    const tw = this.twitch;
    let markerDone = false;
    if (h.markers && total >= h.minScore && live && tw?.hasScope?.('channel:manage:broadcast')) {
      const recent = Date.now() - this.lastMarker.at < real(MARKER_GAP_MS);
      if (!recent || total > this.lastMarker.score) {
        try {
          const mk = await tw.createMarker(title);
          this.db.highlightSet(row.id, { markerId: mk?.id || null, status: 'marker' });
          this.lastMarker = { at: Date.now(), score: total };
          markerDone = true;
        } catch (e) { this.logger.warn(`Stream-Marker nicht gesetzt: ${e.message}`); }
      }
    }
    const clipRoom = !h.maxClips || this.clipsThisStream < h.maxClips;
    if (h.clips && total >= h.clipScore && live && tw?.hasScope?.('clips:edit') && !clipRoom) this.logger.info(`Clip-Obergrenze (${h.maxClips}) für diesen Stream erreicht - nur Marker.`);
    if (h.clips && total >= h.clipScore && live && tw?.hasScope?.('clips:edit') && clipRoom) {
      this.clipsThisStream++;
      setTimeout(() => this.makeClip(row.id, title).catch(() => {}), real(this.clipDelayMs)).unref?.();
    }
    // Lokaler Clip über den OBS-Wiederholungspuffer (läuft auch offline, z. B. bei Aufnahmen)
    const local = this.localClips?.maybeCapture(row, main.type) || false;
    this.logger.info(`Highlight (${total} P.): "${title}"${markerDone ? ' - Marker gesetzt' : ''}${local ? ' - lokaler Clip folgt' : ''}.`);
    this.emit('highlight', { ...row, marker: markerDone });
    this.emit('change');
    return row;
  }

  // "Clip das!" (Kanalpunkte): ohne Punkte-Schwelle, aber mit Clip-Obergrenze pro Stream.
  // Möglich, wenn ein Twitch-Clip (live + Recht clips:edit + unter der Obergrenze) ODER ein lokaler
  // Clip (OBS verbunden + Wiederholungspuffer läuft) geht.
  viewerClipCheck() {
    const h = this.cfg.highlights;
    const live = this.streamStart !== null;
    const room = !h.maxClips || this.clipsThisStream < h.maxClips;
    const twitchOk = live && room && !!this.twitch?.hasScope?.('clips:edit');
    const localOk = !!this.localClips?.ready?.();
    let reason = '';
    if (!twitchOk && !localOk) reason = !live ? 'Stream ist offline' : !room ? `Clip-Obergrenze (${h.maxClips}) für diesen Stream erreicht` : 'Clips sind gerade nicht möglich';
    return { ok: twitchOk || localOk, twitchOk, localOk, reason };
  }

  async viewerClip(user) {
    const chk = this.viewerClipCheck();
    if (!chk.ok) return chk;
    const g = this.gsi?.get?.() || {};
    const ts = Date.now();
    const offsetSec = this.streamStart ? Math.max(0, (ts - this.streamStart) / 1000) : null;
    const title = this.titles.make({ type: 'viewer_clip', user, round: g.round ?? null, map: g.map ?? null, streamTime: offsetSec !== null ? hms(offsetSec) : null });
    const row = { ts, offsetSec, type: 'viewer_clip', score: 4, title, users: user, status: 'list' };
    row.id = this.db.highlightAdd(row);
    const tw = this.twitch;
    if (this.streamStart !== null && tw?.hasScope?.('channel:manage:broadcast')) {
      try { const mk = await tw.createMarker(title); this.db.highlightSet(row.id, { markerId: mk?.id || null, status: 'marker' }); } catch (e) { this.logger.warn(`Stream-Marker nicht gesetzt: ${e.message}`); }
    }
    if (chk.twitchOk) { this.clipsThisStream++; setTimeout(() => this.makeClip(row.id, title).catch(() => {}), real(this.clipDelayMs)).unref?.(); }
    if (chk.localOk) this.localClips.captureNow(row);
    this.logger.info(`Zuschauer-Clip von ${user}: "${title}"${chk.twitchOk ? ' - Twitch-Clip folgt' : ''}${chk.localOk ? ' - lokaler Clip folgt' : ''}.`);
    this.emit('highlight', { ...row, marker: false });
    this.emit('change');
    return { ok: true, title, twitch: chk.twitchOk, local: chk.localOk };
  }

  async makeClip(id, title) {
    try {
      const c = await this.twitch.createClip();
      if (!c) return;
      this.db.highlightSet(id, { clipId: c.id, editUrl: c.edit_url || null, status: 'clip' });
      this.logger.info(`Clip erstellt für "${title}" - Titel im Dashboard übernehmen.`);
      // Die öffentliche Adresse kennt Twitch erst nach ein paar Sekunden.
      setTimeout(async () => {
        try { const info = await this.twitch.getClip(c.id); if (info?.url) { this.db.highlightSet(id, { clipUrl: info.url }); this.emit('change'); } } catch { /* später erneut im Dashboard */ }
      }, real(15000)).unref?.();
      this.emit('change');
    } catch (e) { this.logger.warn(`Clip nicht erstellt: ${e.message}`); }
  }

  shortLabel(m) {
    const en = this.titles.locale === 'en';
    switch (m.type) {
      case 'clutch': return en ? `${m.kills} kills` : `${m.kills} Kills`;
      case 'streak': return en ? `${m.kills} kills in the round` : `${m.kills} Kills in der Runde`;
      case 'chaos_death': return en ? `chaos death (${m.effect})` : `Chaos-Tod (${m.effect})`;
      case 'bits_big': return `${m.bits} Bits`;
      default: return m.effect || m.type;
    }
  }

  list(limit = 100) { return this.db.highlightList(limit).map((r) => ({ ...r, vod: r.offsetSec !== null ? hms(r.offsetSec) : null })); }

  // Für den Videoschnitt: eine Zeile pro Highlight.
  exportText(format = 'txt') {
    const rows = this.list(1000).reverse();
    if (format === 'csv') {
      const q = (v) => { const s = String(v ?? ''); return /^[=+\-@\t\r]/.test(s) ? `"'${s.replace(/"/g, '""')}"` : `"${s.replace(/"/g, '""')}"`; };
      return ['Datum;VOD;Punkte;Titel;Clip;Datei', ...rows.map((r) => [new Date(r.ts).toISOString(), r.vod || '', r.score, r.title, r.clipUrl || r.editUrl || '', r.videoFile || ''].map(q).join(';'))].join('\r\n');
    }
    return rows.map((r) => `${r.vod || new Date(r.ts).toLocaleTimeString()}  ${r.title}${r.clipUrl ? `  ${r.clipUrl}` : ''}`).join('\r\n');
  }

  close() { this.closed = true; clearTimeout(this.timer); }
}
