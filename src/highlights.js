// Highlights: starke Momente erkennen, bewerten und festhalten - als Twitch-Marker, Twitch-Clip und
// in der Highlight-Liste (mit Zeit im VOD), später auch als lokaler Clip über OBS (obs.js).
//
// Nicht jeder Moment wird markiert. Jede Moment-Art hat Punkte; Momente, die kurz nacheinander
// passieren, werden zu EINEM Highlight zusammengefasst (ein Clip, ein Titel). Markiert wird erst ab
// minScore, ein Clip erst ab clipScore, und höchstens ein Marker alle zwei Minuten - außer der neue
// Moment ist stärker. So bleibt die Liste kurz und jeder Eintrag ist es wert.
import { EventEmitter } from 'node:events';
import { TitleMaker } from './highlight-titles.js';
import { TIME_SCALE } from './util.js';

const real = (ms) => ms * TIME_SCALE;

export const HIGHLIGHT_TYPES = ['chaos_death', 'clutch', 'bits_big', 'challenge', 'streak', 'pot', 'goal', 'raid'];

export const HIGHLIGHT_DEFAULT = {
  enabled: true,
  markers: true,
  clips: true,
  minScore: 3,
  clipScore: 4,
  tone: 'frech',
  types: Object.fromEntries(HIGHLIGHT_TYPES.map((t) => [t, true])),
};

const MERGE_MS = 30000; // Momente innerhalb dieser Zeit = ein Highlight
const MAX_SPAN_MS = 90000;
const MARKER_GAP_MS = 120000;
const CLIP_DELAY_MS = 6000; // Twitch schneidet rückwirkend - kurz warten, damit der Moment drin ist

// Punkte je Moment (Feinheiten in score()).
function score(m) {
  switch (m.type) {
    case 'chaos_death': return 3;
    case 'clutch': return Math.min(6, 2 + (m.kills || 2));
    case 'bits_big': return m.bits >= 1000 ? 4 : 3;
    case 'challenge': return 4;
    case 'streak': return m.kills >= 5 ? 5 : m.kills >= 4 ? 3 : 2;
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
    minScore: n(v.minScore, 3, 1, 6), clipScore: n(v.clipScore, 4, 1, 6),
    tone: ['frech', 'episch', 'trocken'].includes(v.tone) ? v.tone : 'frech',
    types: Object.fromEntries(HIGHLIGHT_TYPES.map((t) => [t, v.types?.[t] !== false])),
  };
}

const hms = (sec) => {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

export class Highlights extends EventEmitter {
  constructor({ cfg, db, twitch, gsi, logger, locale = 'de', clipDelayMs = CLIP_DELAY_MS }) {
    super();
    Object.assign(this, { cfg, db, twitch, gsi, logger, clipDelayMs });
    this.titles = new TitleMaker({ locale, tone: cfg.highlights?.tone });
    this.group = null;
    this.timer = null;
    this.lastMarker = { at: 0, score: 0 };
    this.streamStart = null; // Date.now()-Wert des Stream-Starts (für die Zeit im VOD)
    this.closed = false;
  }

  setLocale(locale) { this.titles.setStyle({ locale, tone: this.cfg.highlights?.tone }); }

  // Stream an/aus: Startzeit für die VOD-Zeit; neuer Stream = frische Titel-Statistik.
  async setLive(live) {
    if (!live) { this.streamStart = null; return; }
    try {
      const s = await this.twitch.getStream();
      const t = s?.started_at ? Date.parse(s.started_at) : NaN;
      this.streamStart = Number.isFinite(t) ? t : Date.now();
    } catch { this.streamStart = Date.now(); }
    this.titles.resetStream();
  }

  // Ein Moment aus Engine/Session-Stats. m: { type, user?, effect?, secs?, kills?, bits?, result?, ... }
  add(m) {
    const h = this.cfg.highlights;
    if (this.closed || !h?.enabled || !h.types[m.type]) return;
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
    if (h.clips && total >= h.clipScore && live && tw?.hasScope?.('clips:edit')) {
      setTimeout(() => this.makeClip(row.id, title).catch(() => {}), real(this.clipDelayMs)).unref?.();
    }
    this.logger.info(`Highlight (${total} P.): "${title}"${markerDone ? ' - Marker gesetzt' : ''}.`);
    this.emit('highlight', { ...row, marker: markerDone });
    this.emit('change');
    return row;
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
      return ['Datum;VOD;Punkte;Titel;Clip', ...rows.map((r) => [new Date(r.ts).toISOString(), r.vod || '', r.score, r.title, r.clipUrl || r.editUrl || ''].map(q).join(';'))].join('\r\n');
    }
    return rows.map((r) => `${r.vod || new Date(r.ts).toLocaleTimeString()}  ${r.title}${r.clipUrl ? `  ${r.clipUrl}` : ''}`).join('\r\n');
  }

  close() { this.closed = true; clearTimeout(this.timer); }
}
