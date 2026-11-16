// SQLite-Protokoll (eingebautes node:sqlite, keine Installation nötig).
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA, ensureData } from './config.js';

const SESSION_GAP_MS = 6 * 3600 * 1000;

export function openDb(file) {
  ensureData();
  const db = new DatabaseSync(file || path.join(DATA, 'ucc.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS redemptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, redemption_id TEXT UNIQUE, session_id INTEGER, ts INTEGER,
      user_id TEXT, user_name TEXT, reward_id TEXT, action_id TEXT, category TEXT, cost INTEGER,
      status TEXT, reason TEXT, queued_at INTEGER, started_at INTEGER, finished_at INTEGER, detail TEXT);
    CREATE INDEX IF NOT EXISTS idx_red_session ON redemptions(session_id, user_id, category);
    CREATE TABLE IF NOT EXISTS viewers (user_id TEXT PRIMARY KEY, name TEXT, total INTEGER DEFAULT 0, chaos INTEGER DEFAULT 0, last_seen INTEGER);
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS seasons (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at INTEGER NOT NULL, ended_at INTEGER, winner_name TEXT, winner_chaos INTEGER);
    CREATE TABLE IF NOT EXISTS season_viewers (season_id INTEGER NOT NULL, user_id TEXT NOT NULL, name TEXT, total INTEGER DEFAULT 0, chaos INTEGER DEFAULT 0, last_seen INTEGER, PRIMARY KEY (season_id, user_id));
  `);
  const q = {
    lastSession: db.prepare('SELECT id, last_seen FROM sessions ORDER BY id DESC LIMIT 1'),
    newSession: db.prepare('INSERT INTO sessions (started_at, last_seen) VALUES (?, ?)'),
    touch: db.prepare('UPDATE sessions SET last_seen = ? WHERE id = ?'),
    insert: db.prepare(`INSERT OR IGNORE INTO redemptions
      (redemption_id, session_id, ts, user_id, user_name, reward_id, action_id, category, cost, status, queued_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?)`),
    update: db.prepare('UPDATE redemptions SET status = ?, reason = COALESCE(?, reason), started_at = COALESCE(?, started_at), finished_at = COALESCE(?, finished_at), detail = COALESCE(?, detail) WHERE id = ?'),
    idOf: db.prepare('SELECT id FROM redemptions WHERE redemption_id = ?'),
    countUser: db.prepare(`SELECT COUNT(*) AS n FROM redemptions WHERE session_id = ? AND user_id = ? AND category = ? AND status IN ('queued','running','done')`),
    viewers: db.prepare(`SELECT COUNT(DISTINCT user_id) AS n FROM redemptions WHERE session_id = ? AND status IN ('queued','running','done')`),
    viewerUpsert: db.prepare(`INSERT INTO viewers (user_id, name, total, chaos, last_seen) VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET name = excluded.name, total = total + 1, chaos = chaos + excluded.chaos, last_seen = excluded.last_seen`),
    hall: db.prepare('SELECT name, total, chaos FROM viewers ORDER BY total DESC, chaos DESC LIMIT ?'),
    hallSession: db.prepare(`SELECT user_name AS name, COUNT(*) AS total, MAX(finished_at) AS last FROM redemptions
      WHERE session_id = ? AND status = 'done' GROUP BY user_id ORDER BY total DESC, last ASC LIMIT ?`),
    recentDone: db.prepare("SELECT user_name, action_id, finished_at FROM redemptions WHERE status = 'done' AND finished_at IS NOT NULL ORDER BY id DESC LIMIT ?"),
    perAction: db.prepare(`SELECT action_id, COUNT(*) AS n, SUM(status = 'done') AS done, SUM(status = 'refunded') AS refunded,
      SUM(status = 'failed') AS failed, MAX(ts) AS last FROM redemptions GROUP BY action_id`),
    waits: db.prepare(`SELECT AVG(started_at - queued_at) AS avg FROM redemptions WHERE status = 'done' AND started_at IS NOT NULL AND queued_at IS NOT NULL AND ts > ?`),
    recent: db.prepare('SELECT ts, user_name, action_id, cost, status, reason FROM redemptions ORDER BY id DESC LIMIT ?'),
    // Zuschauer-Statistik für den eingebauten Chat-Befehl - Daten, die
    // ChaosCore ohnehin schon sammelt (kein anderer Chatbot kann das wissen).
    favoriteAction: db.prepare(`SELECT action_id, COUNT(*) AS n FROM redemptions
      WHERE user_id = ? AND status = 'done' GROUP BY action_id ORDER BY n DESC, action_id ASC LIMIT 1`),
    totalSpent: db.prepare(`SELECT SUM(cost) AS total FROM redemptions WHERE user_id = ? AND status = 'done'`),
    viewerById: db.prepare('SELECT total, chaos FROM viewers WHERE user_id = ?'),
    kvGet: db.prepare('SELECT v FROM kv WHERE k = ?'),
    kvSet: db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),
    lastSeasonRow: db.prepare('SELECT id, started_at, ended_at FROM seasons ORDER BY id DESC LIMIT 1'),
    newSeason: db.prepare('INSERT INTO seasons (started_at) VALUES (?)'),
    endSeasonRow: db.prepare('UPDATE seasons SET ended_at = ?, winner_name = ?, winner_chaos = ? WHERE id = ?'),
    seasonById: db.prepare('SELECT id, started_at FROM seasons WHERE id = ?'),
    lastEndedSeason: db.prepare('SELECT winner_name, winner_chaos FROM seasons WHERE ended_at IS NOT NULL ORDER BY id DESC LIMIT 1'),
    seasonViewerUpsert: db.prepare(`INSERT INTO season_viewers (season_id, user_id, name, total, chaos, last_seen) VALUES (?, ?, ?, 1, ?, ?)
      ON CONFLICT(season_id, user_id) DO UPDATE SET name = excluded.name, total = total + 1, chaos = chaos + excluded.chaos, last_seen = excluded.last_seen`),
    seasonHallStmt: db.prepare('SELECT name, total, chaos FROM season_viewers WHERE season_id = ? ORDER BY chaos DESC, total DESC LIMIT ?'),
    seasonTopOne: db.prepare('SELECT name, chaos FROM season_viewers WHERE season_id = ? ORDER BY chaos DESC, total DESC LIMIT 1'),
  };
  let sessionId = null;
  let seasonId = null;

  return {
    raw: db,
    close: () => db.close(),

    session() {
      const now = Date.now();
      if (sessionId) { q.touch.run(now, sessionId); return sessionId; }
      const last = q.lastSession.get();
      if (last && now - last.last_seen < SESSION_GAP_MS) sessionId = Number(last.id);
      else sessionId = Number(q.newSession.run(now, now).lastInsertRowid);
      q.touch.run(now, sessionId);
      return sessionId;
    },

    // gibt die interne ID zurück, oder null bei Duplikat
    record(r) {
      const now = Date.now();
      const res = q.insert.run(r.redemptionId, this.session(), now, r.userId, r.userName, r.rewardId || null, r.actionId, r.category, r.cost, now);
      if (!res.changes) return null;
      return Number(res.lastInsertRowid);
    },
    set(id, status, { reason, started, finished, detail } = {}) {
      q.update.run(status, reason ?? null, started ?? null, finished ?? null, detail ?? null, id);
    },
    userCount: (userId, category) => Number(q.countUser.get(db_session(), userId, category).n),
    distinctViewers: () => Number(q.viewers.get(db_session()).n),
    addViewer(userId, name, chaos) { q.viewerUpsert.run(userId, name, Math.round(chaos), Date.now()); },
    hall: (n = 5) => q.hall.all(n).map((r) => ({ name: r.name, total: Number(r.total), chaos: Number(r.chaos) })),
    // "Heute" = aktuelle Sitzung (ein neuer Stream beginnt nach 6 Stunden Pause)
    hallToday(n = 5) { return q.hallSession.all(this.session(), n).map((r) => ({ name: r.name, total: Number(r.total) })); },
    perAction: () => q.perAction.all().map((r) => ({ id: r.action_id, n: Number(r.n), done: Number(r.done), refunded: Number(r.refunded), failed: Number(r.failed), last: Number(r.last) })),
    avgWaitMs: () => Math.round(Number(q.waits.get(Date.now() - 14 * 86400000).avg) || 0),
    recentDone: (n = 8) => q.recentDone.all(n).map((r) => ({ user: r.user_name, actionId: r.action_id, ts: Number(r.finished_at) })),
    recent: (n = 15) => q.recent.all(n).map((r) => ({ ...r, ts: Number(r.ts), cost: Number(r.cost) })),
    kvGet(k, d = null) { const r = q.kvGet.get(k); return r ? JSON.parse(r.v) : d; },
    kvSet(k, v) { q.kvSet.run(k, JSON.stringify(v)); },
    // Lieblings-Effekt (häufigste erfolgreich abgeschlossene Aktion)
    // und insgesamt eingesetzte Punkte eines einzelnen Zuschauers, für den eingebauten
    // "!chaosstats"-Chat-Befehl. null, falls der Zuschauer noch nichts (erfolgreich) ausgelöst hat.
    favoriteAction: (userId) => { const r = q.favoriteAction.get(userId); return r ? r.action_id : null; },
    totalSpent: (userId) => Number(q.totalSpent.get(userId).total) || 0,
    viewerStats(userId) {
      const r = q.viewerById.get(userId);
      return r ? { total: Number(r.total), chaos: Number(r.chaos) } : { total: 0, chaos: 0 };
    },

    // Season: längerer, konfigurierbarer Zeitraum (z. B. eine Woche) für das sichtbare
    // Chaos-Score-Ranking - unabhängig von "Heute" (einzelner Stream/Session). Läuft automatisch
    // ab (siehe engine.js checkSeasonExpiry), kann aber auch jederzeit von Hand beendet werden.
    currentSeason() {
      if (seasonId) return seasonId;
      const last = q.lastSeasonRow.get();
      if (last && !last.ended_at) seasonId = Number(last.id);
      else seasonId = Number(q.newSeason.run(Date.now()).lastInsertRowid);
      return seasonId;
    },
    seasonInfo() {
      const id = this.currentSeason();
      const row = q.seasonById.get(id);
      return { id, startedAt: Number(row.started_at) };
    },
    // Beendet die laufende Season (Sieger wird festgehalten) und startet sofort eine neue.
    // Gibt den Sieger zurück ({name, chaos}) oder null, falls niemand teilgenommen hat.
    endSeason() {
      const id = this.currentSeason();
      const top = q.seasonTopOne.get(id);
      q.endSeasonRow.run(Date.now(), top?.name || null, top ? Number(top.chaos) : null, id);
      seasonId = null;
      this.currentSeason(); // legt sofort die nächste Season an
      return top ? { name: top.name, chaos: Number(top.chaos) } : null;
    },
    addSeasonViewer(userId, name, chaos) { q.seasonViewerUpsert.run(this.currentSeason(), userId, name, Math.round(chaos), Date.now()); },
    seasonHall(n = 5) { return q.seasonHallStmt.all(this.currentSeason(), n).map((r) => ({ name: r.name, total: Number(r.total), chaos: Number(r.chaos) })); },
    lastSeasonWinner() {
      const row = q.lastEndedSeason.get();
      if (!row || !row.winner_name) return null;
      return { name: row.winner_name, chaos: Number(row.winner_chaos) };
    },
  };

  function db_session() {
    return sessionId || (sessionId = Number(q.lastSession.get()?.id) || null) || 0;
  }
}
