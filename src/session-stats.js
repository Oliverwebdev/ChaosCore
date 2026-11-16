// Session Stats: zählt Kills, Tode, Fails, Runden und Matches
// eines Streams und ordnet jeden Tod "natürlich" oder "durch Chaos" (Zuschauer-Effekt) zu.
//
// Aufbau (spielneutral):
//   GSI-Paket -> Spiel-Adapter (src/games/adapters/*-events.js) -> normalisierte Ereignisse ->
//   dieses Modul (Sitzung, Zuordnung, Speicherung) -> Dashboard/Overlay.
// Nur der Adapter kennt das Spiel. Spiele ohne Adapter haben trotzdem Fails und Handzählung.
//
// Speicherung: eigene Tabellen stat_sessions/stat_events (getrennt von der bestehenden Tabelle
// "sessions", die für Einlöse-Limits und "Top heute" zuständig ist).
// Jede Zählung ist eine Zeile in stat_events; Summen entstehen per SUM(value). Dadurch bleibt
// jede Korrektur nachvollziehbar (Spalte corrected) und der CSV-Export ist die Rohdatenliste.
//
// Zuordnung eines Todes: läuft gerade ein Effekt mit Spiel-Eingaben, oder endete einer vor
// höchstens stats.chaosWindowSec Sekunden (Standard 5), zählt der Tod als "Chaos" - mit Name des
// Zuschauers und Effekt. Sonst "natürlich". Im Dashboard korrigierbar.
// "Kills trotz Chaos": Kills, während ein solcher Effekt läuft.
import { EventEmitter } from 'node:events';
import { createCs2EventAdapter } from './games/adapters/cs2-events.js';

export const STAT_KEYS = ['kills', 'deaths', 'kd', 'fails', 'deathsChaos', 'deathsNatural', 'killsUnderChaos',
  'roundsWon', 'roundsLost', 'matchesWon', 'matchesLost', 'bestStreak'];
// Was sich im Dashboard per +/- von Hand zählen lässt (Summen-Werte, keine berechneten).
export const ADJUSTABLE = ['kills', 'deaths', 'fails', 'roundsWon', 'roundsLost', 'matchesWon', 'matchesLost'];
const ADJ_TYPE = { kills: 'kill', deaths: 'death', fails: 'fail', roundsWon: 'round_win', roundsLost: 'round_loss', matchesWon: 'match_win', matchesLost: 'match_loss' };

const ADAPTERS = { cs2: createCs2EventAdapter };
export const hasStatsAdapter = (profileId) => !!ADAPTERS[profileId];

const SAVE_EVERY_MS = 2000;
const RECENT_EFFECTS = 30;

export class SessionStats extends EventEmitter {
  constructor({ cfg, db, logger, now = () => Date.now() }) {
    super();
    this.cfg = cfg; this.db = db.raw || db; this.kv = db; this.logger = logger; this.now = now;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS stat_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at INTEGER NOT NULL, ended_at INTEGER,
        source TEXT NOT NULL, game TEXT, end_reason TEXT);
      CREATE TABLE IF NOT EXISTS stat_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL, ts INTEGER NOT NULL,
        type TEXT NOT NULL, value INTEGER NOT NULL DEFAULT 1, cause TEXT, viewer_id TEXT, viewer_name TEXT, action_id TEXT,
        action_title TEXT, chaos INTEGER NOT NULL DEFAULT 0, corrected INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'game', detail TEXT,
        round_kills INTEGER);
      CREATE INDEX IF NOT EXISTS stat_events_session ON stat_events (session_id, ts);
    `);
    const d = this.db;
    this.q = {
      open: d.prepare('SELECT id, started_at, source, game FROM stat_sessions WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1'),
      create: d.prepare('INSERT INTO stat_sessions (started_at, source, game) VALUES (?, ?, ?)'),
      end: d.prepare('UPDATE stat_sessions SET ended_at = ?, end_reason = ? WHERE id = ?'),
      setSource: d.prepare('UPDATE stat_sessions SET source = ? WHERE id = ?'),
      byId: d.prepare('SELECT id, started_at, ended_at, source, game, end_reason FROM stat_sessions WHERE id = ?'),
      list: d.prepare('SELECT id, started_at, ended_at, source, game, end_reason FROM stat_sessions ORDER BY id DESC LIMIT ?'),
      insert: d.prepare(`INSERT INTO stat_events (session_id, ts, type, value, cause, viewer_id, viewer_name, action_id, action_title, chaos, source, detail)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      sums: d.prepare('SELECT type, cause, chaos, SUM(value) AS n FROM stat_events WHERE session_id = ? GROUP BY type, cause, chaos'),
      bestRound: d.prepare("SELECT MAX(round_kills) AS n FROM stat_events WHERE session_id = ? AND type = 'kill'"),
      setRoundKills: d.prepare('UPDATE stat_events SET round_kills = ? WHERE id = ?'),
      torture: d.prepare(`SELECT viewer_name AS name, SUM(value) AS n FROM stat_events WHERE session_id = ? AND type = 'death' AND cause = 'chaos'
        AND viewer_id IS NOT NULL GROUP BY viewer_id ORDER BY n DESC, MAX(ts) ASC LIMIT ?`),
      deaths: d.prepare(`SELECT id, ts, value, cause, viewer_name, action_title, corrected, source, detail FROM stat_events
        WHERE session_id = ? AND type = 'death' ORDER BY ts DESC, id DESC LIMIT ?`),
      event: d.prepare('SELECT id, session_id, type, value, cause, ts FROM stat_events WHERE id = ?'),
      setCause: d.prepare('UPDATE stat_events SET cause = ?, viewer_id = ?, viewer_name = ?, action_id = ?, action_title = ?, corrected = 1 WHERE id = ?'),
      remove: d.prepare("UPDATE stat_events SET value = 0, corrected = 1, detail = COALESCE(detail || ' ', '') || '(entfernt)' WHERE id = ?"),
      lastDeath: d.prepare("SELECT id FROM stat_events WHERE session_id = ? AND type = 'death' AND value > 0 ORDER BY ts DESC, id DESC LIMIT 1"),
      all: d.prepare('SELECT ts, type, value, cause, viewer_name, action_title, chaos, corrected, source, detail FROM stat_events WHERE session_id = ? ORDER BY ts, id'),
    };
    this.effects = [];       // zuletzt gelaufene Effekte mit Spiel-Eingaben: { userId, user, actionId, title, start, end, system }
    this.streamLive = false;
    this.gsiSeenAt = 0;
    this.lastFailAt = 0;
    this.adapterProfile = null;
    this.adapter = null;
    this.dirty = false;
    this.ensureAdapter();
    this.session = this.loadOpenSession();
    this.saveTimer = setInterval(() => this.saveState(), SAVE_EVERY_MS);
    this.saveTimer.unref?.();
  }

  get opts() { return this.cfg.stats; }

  ensureAdapter() {
    const prof = this.cfg.game?.profile || 'cs2';
    if (this.adapterProfile === prof && this.adapter) return;
    this.adapterProfile = prof;
    const make = ADAPTERS[prof];
    this.adapter = make ? make({ countMode: (m) => !(this.opts.excludeModes || []).includes(m) }) : null;
  }

  // ---------- Absturz-Wiederherstellung ----------
  loadOpenSession() {
    const row = this.q.open.get();
    if (!row) { this.kv.kvSet?.('stats_state', null); return null; }
    const saved = this.kv.kvGet?.('stats_state', null);
    if (saved && saved.sessionId === Number(row.id)) {
      if (saved.adapter && saved.profile === this.adapterProfile) this.adapter?.importState(saved.adapter);
      this.effects = Array.isArray(saved.effects) ? saved.effects : [];
      // Endet die Sitzung, bevor seit dem Neustart überhaupt etwas passiert ist (z. B. ChaosCore wird
      // am nächsten Tag gestartet und der Stream ist längst offline), gilt der letzte gesicherte
      // Zeitpunkt als Ende - sonst stünde in der Historie ein 20-Stunden-Stream.
      this.resumedAt = Number(saved.savedAt) || null;
    }
    this.logger?.info(`Session Stats: laufende Sitzung #${row.id} nach Neustart fortgesetzt.`);
    return { id: Number(row.id), startedAt: Number(row.started_at), source: row.source, game: row.game };
  }

  saveState(force = false) {
    if (!this.session || (!this.dirty && !force)) return;
    this.dirty = false;
    try {
      this.kv.kvSet?.('stats_state', { sessionId: this.session.id, profile: this.adapterProfile, adapter: this.adapter?.exportState() || null,
        effects: this.effects, savedAt: this.now() });
    } catch (e) { this.logger?.warn(`Session Stats: Zustand konnte nicht gesichert werden: ${e.message}`); }
  }

  // ---------- Sitzung ----------
  isActive() { return !!this.session; }

  start(source = 'manual') {
    if (this.opts.enabled === false) return null;
    if (this.session) {
      // Ein von Hand gestarteter Lauf wird vom Stream übernommen, damit "Stream offline" ihn beendet.
      if (source === 'stream' && this.session.source !== 'stream') { this.q.setSource.run('stream', this.session.id); this.session.source = 'stream'; this.changed(); }
      return this.session;
    }
    const ts = this.now();
    const id = Number(this.q.create.run(ts, source, this.cfg.game?.profile || null).lastInsertRowid);
    this.session = { id, startedAt: ts, source, game: this.cfg.game?.profile || null };
    this.effects = this.effects.filter((e) => e.end === null);
    this.logger?.info(`Session Stats: Sitzung #${id} gestartet (${source === 'stream' ? 'Stream online' : 'von Hand'}).`);
    this.saveState(true);
    this.changed();
    return this.session;
  }

  stop(reason = 'manual') {
    if (!this.session) return null;
    const s = this.session;
    this.q.end.run(this.resumedAt && !this.activeSinceResume ? Math.max(this.resumedAt, s.startedAt) : this.now(), reason, s.id);
    this.resumedAt = null;
    this.session = null;
    this.kv.kvSet?.('stats_state', null);
    this.logger?.info(`Session Stats: Sitzung #${s.id} beendet (${reason}).`);
    this.changed();
    return s;
  }

  setStreamLive(live) {
    this.streamLive = !!live;
    if (this.opts.autoStream) {
      if (live) this.start('stream');
      else if (this.session?.source === 'stream') this.stop('stream_offline');
    }
    this.changed();
  }

  // ---------- Effekte (von der Engine gemeldet) ----------
  effectStart({ userId, user, actionId, title, system }) {
    const e = { userId: system ? null : (userId || null), user: user || null, actionId: actionId || null, title: title || null, start: this.now(), end: null, system: !!system };
    this.effects.push(e); this.activeSinceResume = true;
    if (this.effects.length > RECENT_EFFECTS) this.effects.splice(0, this.effects.length - RECENT_EFFECTS);
    this.dirty = true;
    return e;
  }

  effectEnd(e) {
    const ref = e && this.effects.includes(e) ? e : [...this.effects].reverse().find((x) => x.end === null);
    if (ref && ref.end === null) { ref.end = this.now(); this.dirty = true; }
  }

  // Effekt, der zum Zeitpunkt t lief oder höchstens windowMs vorher endete (der jüngste gewinnt).
  effectAt(t, windowMs) {
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const e = this.effects[i];
      if (e.start <= t && (e.end === null || t <= e.end + windowMs)) return e;
    }
    return null;
  }

  // ---------- Spielereignisse ----------
  onGsi(body, ts = this.now()) {
    if (this.closed) return [];
    this.gsiSeenAt = ts;
    this.ensureAdapter();
    if (!this.adapter) return [];
    let events;
    try { events = this.adapter.feed(body, ts); }
    catch (e) { this.logger?.warn(`Session Stats: GSI-Paket nicht auswertbar: ${e.message}`); return []; }
    this.dirty = true;
    if (body?.map?.name) this.activeSinceResume = true;
    // Außerhalb einer Sitzung läuft der Adapter weiter (damit die Ausgangswerte stimmen), gezählt wird nichts.
    if (!this.session || !events.length) return [];
    for (const ev of events) this.handle(ev);
    this.saveState(true);
    this.changed();
    return events;
  }

  handle(ev) {
    const sid = this.session.id;
    const windowMs = Math.round((this.opts.chaosWindowSec ?? 5) * 1000);
    switch (ev.type) {
      case 'match_start':
        this.q.insert.run(sid, ev.ts, 'match_start', 0, null, null, null, null, null, 0, 'game', [ev.map, ev.mode].filter(Boolean).join(' / '));
        break;
      case 'match_end': {
        const type = ev.result === 'win' ? 'match_win' : ev.result === 'loss' ? 'match_loss' : ev.result === 'tie' ? 'match_tie' : null;
        if (type) this.q.insert.run(sid, ev.ts, type, 1, null, null, null, null, null, 0, 'game', ev.own !== null ? `${ev.map} ${ev.own}:${ev.opp}` : ev.map);
        break;
      }
      case 'round_end':
        if (ev.result === 'win' || ev.result === 'loss') this.q.insert.run(sid, ev.ts, ev.result === 'win' ? 'round_win' : 'round_loss', 1, null, null, null, null, null, 0, 'game', null);
        break;
      case 'kill': {
        const fx = this.effectAt(ev.ts, 0);
        const under = !!(fx && fx.end === null);
        const id = this.q.insert.run(sid, ev.ts, 'kill', ev.count, null, null, null, under ? fx.actionId : null, under ? fx.title : null, under ? 1 : 0, 'game', ev.count < 0 ? 'Teamkill' : null).lastInsertRowid;
        // Kill-Serie: ab streakMin Kills in EINER Runde eine kurze Einblendung.
        if (ev.count > 0 && ev.roundKills > 0) {
          this.q.setRoundKills.run(ev.roundKills, id);
          if (ev.roundKills >= (this.opts.streakMin ?? 3)) this.emit('fx', { type: 'stats_streak', streak: ev.roundKills });
        }
        break;
      }
      case 'death': {
        const at = ev.at ?? ev.ts;
        const fx = ev.late && ev.at === undefined ? null : this.effectAt(at, windowMs);
        const detail = ev.late ? (ev.at === undefined ? 'Zeitpunkt unsicher' : 'Zeitpunkt geschätzt') : null;
        if (fx) {
          this.q.insert.run(sid, at, 'death', 1, 'chaos', fx.userId, fx.user, fx.actionId, fx.title, 1, 'game', detail);
          this.emit('fx', { type: 'stats_chaos_death', user: fx.user, title: fx.title });
          if (!fx.system) this.emit('chaosDeath', { user: fx.user, title: fx.title });
        } else {
          this.q.insert.run(sid, at, 'death', 1, 'natural', null, null, null, null, 0, 'game', detail);
        }
        break;
      }
      default: break;
    }
  }

  // ---------- Fails und Handzählung ----------
  // source: 'hotkey' | 'chat' | 'dashboard'. Kurze Sperre, damit zwei Mods mit "!fail" gleichzeitig
  // (oder ein doppelt gedrückter Hotkey) nicht doppelt zählen.
  addFail(source = 'dashboard', by = null) {
    if (!this.session) return { ok: false, reason: 'no_session' };
    const ts = this.now();
    const cd = Math.round((this.opts.failCooldownSec ?? 3) * 1000);
    if (source !== 'dashboard' && ts - this.lastFailAt < cd) return { ok: false, reason: 'cooldown' };
    this.lastFailAt = ts; this.activeSinceResume = true;
    this.q.insert.run(this.session.id, ts, 'fail', 1, null, null, by, null, null, 0, source, null);
    this.emit('fx', { type: 'stats_fail' });
    this.changed();
    return { ok: true };
  }

  adjust(stat, delta) {
    if (!this.session) return { ok: false, reason: 'no_session' };
    if (!ADJUSTABLE.includes(stat)) return { ok: false, reason: 'unknown_stat' };
    const d = Math.sign(Number(delta));
    if (!d) return { ok: false, reason: 'bad_delta' };
    const sid = this.session.id; this.activeSinceResume = true;
    const totals = this.totals(sid);
    if (d < 0 && totals[stat] <= 0) return { ok: false, reason: 'zero' };
    if (stat === 'deaths' && d < 0) {
      // Tode werden nicht "minus gerechnet", sondern der letzte Tod wird als entfernt markiert -
      // so passt die Aufteilung natürlich/Chaos weiter und die Zeitleiste zeigt, was passiert ist.
      const last = this.q.lastDeath.get(sid);
      if (last) this.q.remove.run(last.id);
    } else {
      this.q.insert.run(sid, this.now(), ADJ_TYPE[stat], d, stat === 'deaths' ? 'natural' : null, null, null, null, null, 0, 'manual', null);
    }
    this.changed();
    return { ok: true };
  }

  // Tod umbuchen: natürlich <-> Chaos. Beim Umbuchen auf Chaos wird der Effekt genommen, der zu
  // diesem Zeitpunkt lief oder zuletzt davor endete (bis 60 s) - sonst bleibt der Zuschauer leer.
  correctDeath(eventId, cause) {
    if (!['chaos', 'natural'].includes(cause)) return { ok: false, reason: 'bad_cause' };
    const ev = this.q.event.get(Number(eventId));
    if (!ev || ev.type !== 'death') return { ok: false, reason: 'not_found' };
    if (cause === 'natural') this.q.setCause.run('natural', null, null, null, null, ev.id);
    else {
      const fx = this.effectAt(Number(ev.ts), 60000);
      this.q.setCause.run('chaos', fx?.userId || null, fx?.user || null, fx?.actionId || null, fx?.title || null, ev.id);
    }
    this.changed();
    return { ok: true };
  }

  // ---------- Auswertung ----------
  totals(sessionId = this.session?.id) {
    const t = { kills: 0, deaths: 0, fails: 0, deathsChaos: 0, deathsNatural: 0, killsUnderChaos: 0, roundsWon: 0, roundsLost: 0, matchesWon: 0, matchesLost: 0, matchesTied: 0, bestStreak: 0, kd: 0 };
    if (!sessionId) return t;
    for (const r of this.q.sums.all(sessionId)) {
      const n = Number(r.n) || 0;
      switch (r.type) {
        case 'kill': t.kills += n; if (Number(r.chaos)) t.killsUnderChaos += n; break;
        case 'death': t.deaths += n; if (r.cause === 'chaos') t.deathsChaos += n; else t.deathsNatural += n; break;
        case 'fail': t.fails += n; break;
        case 'round_win': t.roundsWon += n; break;
        case 'round_loss': t.roundsLost += n; break;
        case 'match_win': t.matchesWon += n; break;
        case 'match_loss': t.matchesLost += n; break;
        case 'match_tie': t.matchesTied += n; break;
        default: break;
      }
    }
    t.bestStreak = Number(this.q.bestRound.get(sessionId)?.n) || 0; // meiste Kills in einer Runde
    t.kd = t.deaths > 0 ? Math.round((t.kills / t.deaths) * 100) / 100 : t.kills;
    return t;
  }

  torture(sessionId = this.session?.id, n = 5) {
    if (!sessionId) return [];
    return this.q.torture.all(sessionId, n).map((r) => ({ name: r.name, n: Number(r.n) }));
  }

  deathTimeline(sessionId = this.session?.id, n = 50) {
    if (!sessionId) return [];
    return this.q.deaths.all(sessionId, n).map((r) => ({ id: Number(r.id), ts: Number(r.ts), removed: Number(r.value) === 0, cause: r.cause,
      viewer: r.viewer_name, effect: r.action_title, corrected: !!Number(r.corrected), source: r.source, detail: r.detail }));
  }

  history(n = 20) {
    return this.q.list.all(n).map((r) => ({ id: Number(r.id), startedAt: Number(r.started_at), endedAt: r.ended_at === null ? null : Number(r.ended_at),
      source: r.source, game: r.game, endReason: r.end_reason, totals: this.totals(Number(r.id)), torture: this.torture(Number(r.id), 1)[0] || null }));
  }

  csv(sessionId) {
    const s = this.q.byId.get(Number(sessionId));
    if (!s) return null;
    const esc = (v) => { const x = v === null || v === undefined ? '' : String(v); return /[",;\n\r]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
    // Formel-Einschleusung in Tabellenprogrammen verhindern (Zuschauernamen/Effekttitel sind fremde Texte).
    const safe = (v) => { const x = v === null || v === undefined ? '' : String(v); return /^[=+\-@\t\r]/.test(x) ? `'${x}` : x; };
    const lines = ['zeit;typ;wert;ursache;zuschauer;effekt;unter_chaos;korrigiert;quelle;info'];
    for (const r of this.q.all.all(s.id)) {
      lines.push([new Date(Number(r.ts)).toISOString(), r.type, r.value, r.cause, safe(r.viewer_name), safe(r.action_title), Number(r.chaos), Number(r.corrected), r.source, safe(r.detail)].map(esc).join(';'));
    }
    return lines.join('\r\n') + '\r\n';
  }

  publicState() {
    if (this.closed) return null; // Datenbank ist schon zu (Herunterfahren)
    const s = this.session;
    return {
      enabled: this.opts.enabled !== false,
      active: !!s,
      session: s ? { id: s.id, startedAt: s.startedAt, source: s.source } : null,
      totals: this.totals(),
      torture: this.torture(undefined, 3),
      show: this.opts.show,
      overlayTheme: this.opts.overlayTheme || 'unknown',
      overlay: this.opts.overlay || { bar: true, split: true, torture: true, popups: true },
      streamLive: this.streamLive,
      gsiLive: this.now() - this.gsiSeenAt < 15000,
      adapter: !!this.adapter,
    };
  }

  changed() { this.emit('change'); }

  close() { if (this.closed) return; clearInterval(this.saveTimer); this.saveState(true); this.closed = true; }
}
