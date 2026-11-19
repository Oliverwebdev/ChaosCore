// Ende-zu-Ende-Test gegen einen simulierten Twitch. Aufruf: npm test
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock, VALID_CLIENT_ID } from './mock-twitch.js';
import { startObsMock } from './mock-obs.js';
const { renderPage } = await import('../src/web-pages.js');
// Das Dashboard ist auf mehrere Dateien verteilt; geprüft wird die ausgelieferte Seite.
const dashboardSource = () => renderPage('dashboard.html');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ucc-test-'));
let passed = 0, failed = 0;
const failures = [];

async function t(name, fn) {
  try { await fn(); passed++; console.log(`  ✔ ${name}`); }
  catch (e) { failed++; failures.push(name); console.log(`  ✖ ${name}\n      ${e.message}`); }
}
const eq = (a, b, msg) => { if (a !== b) throw new Error(`${msg || 'ungleich'}: erwartet ${JSON.stringify(b)}, erhalten ${JSON.stringify(a)}`); };
const yes = (v, msg) => { if (!v) throw new Error(msg || 'erwartet true'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, ms = 6000, what = 'Bedingung') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Zeitüberschreitung: ${what}`);
    await sleep(40);
  }
}

function mkEnv(name, mock, extra = {}) {
  const dir = path.join(tmp, name);
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  return {
    dir, home, data: path.join(dir, 'data'),
    env: { ...process.env, ...mock.env, HOME: home, UCC_DATA_DIR: path.join(dir, 'data'), UCC_NO_OPEN: '1', NO_COLOR: '1', UCC_POLL_SCALE: '0.01', UCC_BRIDGE: 'mock', ...extra },
  };
}

function run(script, args, env, input = '', timeout = 40000) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, script), ...args], { env, cwd: ROOT });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    const killer = setTimeout(() => p.kill(), timeout);
    p.on('exit', (code) => { clearTimeout(killer); resolve({ code, out }); });
    p.stdin.end(input);
  });
}

// Ein Lauf, der nicht bis zur Ergebniszeile kommt, ist KEIN bestandener Lauf. Dieser Wächter beendet einen hängenden Lauf mit eigenem Exit-Code 2 und einer
// eindeutigen Zeile, statt dass er still von außen abgebrochen wird. Ein normaler Lauf dauert
// rund 2 Minuten.
const WATCHDOG_MS = 8 * 60 * 1000;
setTimeout(() => {
  console.log(`\n✖ ABGEBROCHEN: Der Testlauf hat sich nach ${WATCHDOG_MS / 60000} Minuten nicht beendet (bis dahin ${passed} bestanden, ${failed} fehlgeschlagen). Das zählt als FEHLGESCHLAGEN.\n`);
  process.exit(2);
}, WATCHDOG_MS).unref();

console.log('\nUNKNOWN CHAT CONTROL: Test\n');
const mock = await startMock();
const A = mkEnv('a', mock);
const steam = path.join(A.home, '.steam', 'steam', 'steamapps', 'common', 'Counter-Strike Global Offensive', 'game', 'csgo', 'cfg');
fs.mkdirSync(steam, { recursive: true });

// =============== CS2-Verhalten als Referenz ===============
await t('CS2-Referenz unverändert - gesendete Schritte jeder mitgelieferten Aktion und die Bind-Datei', async () => {
  // Schlägt dieser Test fehl, hat ein Umbau geändert, was im Spiel ankommt. Ist das gewollt (z. B. nach
  // einem Live-Test), die Referenz bewusst neu erzeugen: node scripts/cs2-reference.mjs --write
  const { buildReference } = await import('../scripts/cs2-reference.mjs');
  const now = buildReference();
  const ref = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'cs2-reference.json'), 'utf8'));
  eq(now.bindsVersion, ref.bindsVersion, 'BINDS_VERSION');
  eq(JSON.stringify(now.keys), JSON.stringify(ref.keys), 'Standard-Tastenbelegung CS2');
  eq(Object.keys(now.actions).sort().join(), Object.keys(ref.actions).sort().join(), 'Menge der mitgelieferten CS2-Aktionen');
  for (const [id, r] of Object.entries(ref.actions)) eq(JSON.stringify(now.actions[id]), JSON.stringify(r), `Aktion ${id}`);
  const a = now.bindsCfg, b = ref.bindsCfg;
  for (let i = 0; i < Math.max(a.length, b.length); i++) eq(a[i], b[i], `Bind-Datei Zeile ${i + 1}`);
  yes(Object.keys(ref.actions).length >= 40, 'Referenz deckt zu wenige Aktionen ab');
});

// =============== CS2-Ereignis-Adapter ===============
const evMod = await import('../src/games/adapters/cs2-events.js');
const { readRecording: readRec } = await import('../src/gsi-recorder.js');
const evStr = (e) => [e.type, e.type === 'match_start' ? e.map : null, e.type === 'kill' ? `${e.count} rk${e.roundKills}` : null, e.result,
  e.type === 'match_end' && e.own !== null ? `${e.own}:${e.opp}` : null, e.late ? 'late' : null,
  e.type === 'round_start' ? String(e.round) : null].filter((x) => x !== null && x !== undefined).join(' ');
const replayFile = (file, adapter = evMod.createCs2EventAdapter()) => {
  const ev = [];
  for (const { t, body } of readRec(fs.readFileSync(file, 'utf8'))) ev.push(...adapter.feed(body, t));
  return ev;
};
await t('jede GSI-Fixture mit Erwartung ergibt genau die erwarteten Ereignisse (neues Match, Warmup, Zuschauen, später Tod, Teamkill)', async () => {
  const dir = path.join(ROOT, 'test', 'fixtures', 'gsi');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.expect.json'));
  yes(files.length >= 1, 'keine Fixtures');
  for (const f of files) {
    const exp = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const ev = replayFile(path.join(dir, f.replace('.expect.json', '.jsonl')));
    eq(ev.map(evStr).join(' | '), exp.events.join(' | '), f);
    const sum = (type, fn = () => 1) => ev.filter((e) => e.type === type).reduce((a, e) => a + fn(e), 0);
    const totals = { kills: sum('kill', (e) => e.count), deaths: sum('death'), deathsLate: ev.filter((e) => e.type === 'death' && e.late).length,
      roundsWon: ev.filter((e) => e.type === 'round_end' && e.result === 'win').length, roundsLost: ev.filter((e) => e.type === 'round_end' && e.result === 'loss').length,
      matchesWon: ev.filter((e) => e.type === 'match_end' && e.result === 'win').length, matchesLost: ev.filter((e) => e.type === 'match_end' && e.result === 'loss').length };
    eq(JSON.stringify(totals), JSON.stringify(exp.totals), `${f}: Summen`);
  }
});
await t('Einstieg mitten im Match zählt alte Werte nicht; Modusfilter; Wiederherstellung zählt Ausfallzeit genau einmal', async () => {
  const ME = '7656', P = (kills, deaths, extra = {}) => ({ provider: { steamid: ME }, map: { name: 'de_inferno', mode: extra.mode || 'competitive', phase: 'live', round: extra.round ?? 5 },
    round: { phase: 'live' }, player: { steamid: ME, team: 'T', state: { health: extra.health ?? 100, round_kills: 0 }, match_stats: { kills, deaths } } });
  // Einstieg mitten im Match (ChaosCore startet während Runde 5 mit 12 Kills): nichts zählen, nur Ausgangswert.
  let a = evMod.createCs2EventAdapter();
  eq(a.feed(P(12, 7)).map(evStr).join(' | '), 'match_start de_inferno');
  eq(a.feed(P(13, 7)).map(evStr).join(' | '), 'kill 1 rk1', 'Kills der Runde werden zur Sicherheit selbst mitgezählt');
  // Wiederherstellung: Zustand sichern, "Absturz", neuer Adapter mit gesichertem Zustand.
  const saved = a.exportState();
  a = evMod.createCs2EventAdapter();
  a.importState(JSON.parse(JSON.stringify(saved)));
  // In der Ausfallzeit gab es 2 Kills und 1 Tod - genau einmal gezählt, kein neues match_start.
  eq(a.feed(P(15, 8, { round: 6 })).map(evStr).join(' | '), 'death late | kill 2 rk3');
  eq(a.feed(P(15, 8, { round: 6 })).length, 0, 'gleiches Paket darf nichts mehr zählen');
  // Modusfilter: Deathmatch ausgeschlossen -> keine Kills/Tode, kein match_start.
  a = evMod.createCs2EventAdapter({ countMode: (m) => m !== 'deathmatch' });
  eq(a.feed(P(0, 0, { mode: 'deathmatch' })).length, 0);
  eq(a.feed(P(5, 3, { mode: 'deathmatch', health: 0 })).length, 0, 'gefilterter Modus darf nichts zählen');
  // Nur Zuschauen (nie eigenes Paket): nichts zählen.
  a = evMod.createCs2EventAdapter();
  const spec = P(9, 9); spec.player.steamid = '999';
  eq(a.feed(spec).filter((e) => e.type === 'kill' || e.type === 'death').length, 0);
  eq(a.feed({ ...spec, player: { ...spec.player, match_stats: { kills: 20, deaths: 20 } } }).filter((e) => e.type === 'kill' || e.type === 'death').length, 0);
  // Hauptmenü (keine Karte): keine Ereignisse.
  eq(a.feed({ provider: { steamid: ME } }).length, 0);
});

// =============== Session Stats: Sitzung, Zuordnung, Speicherung ===============
const { SessionStats } = await import('../src/session-stats.js');
const { openDb: openStatsDb } = await import('../src/db.js');
const { DEFAULTS: CFG_DEFAULTS } = await import('../src/config.js');
const statsHarness = (file = path.join(tmp, `stats-${Math.random().toString(36).slice(2)}.db`), cfgOver = {}) => {
  let clock = 1_000_000;
  const scfg = { game: { profile: 'cs2' }, stats: { ...structuredClone(CFG_DEFAULTS.stats), ...cfgOver } };
  const db = openStatsDb(file);
  const fx = [];
  const s = new SessionStats({ cfg: scfg, db, now: () => clock });
  s.on('fx', (f) => fx.push(f));
  const ME = '7656';
  const gsi = (kills, deaths, { health = 100, mine = true, roundPhase = 'live', map = 'de_nuke', mode = 'competitive', round = 3, mapPhase = 'live' } = {}) =>
    s.onGsi({ provider: { steamid: ME }, map: { name: map, mode, phase: mapPhase, round }, round: { phase: roundPhase },
      player: { steamid: mine ? ME : '1', team: 'CT', state: { health, round_kills: 0 }, match_stats: { kills, deaths } } }, clock);
  return { s, db, fx, gsi, file, scfg, tick: (ms) => { clock += ms; }, get now() { return clock; } };
};
await t('ohne Sitzung wird nichts gezählt; Start mitten im Match zählt alte Werte nicht', async () => {
  const h = statsHarness();
  h.gsi(5, 2); h.tick(1000); h.gsi(6, 2); // keine Sitzung: Adapter läuft mit, nichts gezählt
  eq(h.s.totals().kills, 0);
  h.s.start('manual');
  h.tick(1000); h.gsi(6, 2);
  eq(JSON.stringify([h.s.totals().kills, h.s.totals().deaths]), '[0,0]', 'Start mitten im Match');
  h.tick(1000); h.gsi(7, 2);
  eq(h.s.totals().kills, 1);
  h.s.close(); h.db.close();
});
await t('Tod während/kurz nach Effekt = Chaos mit Zuschauer und Effekt, danach natürlich; mehrere Effekte; Kills trotz Chaos; Serie', async () => {
  const h = statsHarness();
  h.s.start('manual'); h.gsi(0, 0);
  // Effekt läuft, Tod -> Chaos (Zuschauer + Effekt)
  const e1 = h.s.effectStart({ userId: 'u1', user: 'Anna', actionId: 'wasd_invert', title: 'WASD invertiert' });
  h.tick(1000); h.gsi(1, 0); // Kill trotz Chaos
  h.tick(1000); h.gsi(1, 0, { health: 0 });
  h.tick(500); h.s.effectEnd(e1); h.gsi(1, 1, { health: 0 });
  let tl = h.s.deathTimeline();
  eq(tl.length, 1, 'genau ein Tod (Leben 0 und Zähler werden nicht doppelt gezählt)');
  eq(JSON.stringify([tl[0].cause, tl[0].viewer, tl[0].effect]), '["chaos","Anna","WASD invertiert"]');
  yes(h.fx.some((f) => f.type === 'stats_chaos_death' && f.user === 'Anna'), 'Overlay-Meldung Chaos-Tod');
  // Tod 4 s nach Effekt-Ende -> noch Chaos (Standard-Fenster 5 s)
  h.tick(5000); h.gsi(1, 1, { health: 100 });
  const e2 = h.s.effectStart({ userId: 'u2', user: 'Ben', actionId: 'mouse_invert', title: 'Maus invertiert' });
  h.tick(2000); h.s.effectEnd(e2); h.tick(4000); h.gsi(1, 2, { health: 0 });
  // Tod 6 s nach Effekt-Ende -> natürlich
  h.tick(5000); h.gsi(1, 2, { health: 100 });
  const e3 = h.s.effectStart({ userId: 'u3', user: 'Cleo', actionId: 'x', title: 'Knife Time' });
  h.tick(1000); h.s.effectEnd(e3); h.tick(6000); h.gsi(1, 3, { health: 0 });
  // Zwei Effekte nacheinander: der jüngere gewinnt
  h.tick(5000); h.gsi(1, 3, { health: 100 });
  const e4 = h.s.effectStart({ userId: 'u1', user: 'Anna', actionId: 'a', title: 'Feuerpause' }); h.tick(500); h.s.effectEnd(e4);
  const e5 = h.s.effectStart({ userId: 'u2', user: 'Ben', actionId: 'b', title: 'Kein Zoom' }); h.tick(500);
  h.gsi(1, 4, { health: 0 }); h.s.effectEnd(e5);
  tl = h.s.deathTimeline().reverse();
  eq(tl.map((d) => `${d.cause}:${d.viewer || '-'}`).join(' '), 'chaos:Anna chaos:Ben natural:- chaos:Ben');
  const t1 = h.s.totals();
  eq(JSON.stringify([t1.kills, t1.killsUnderChaos, t1.deaths, t1.deathsChaos, t1.deathsNatural]), '[1,1,4,3,1]');
  eq(JSON.stringify(h.s.torture()), JSON.stringify([{ name: 'Ben', n: 2 }, { name: 'Anna', n: 1 }]), 'Folter-Rangliste');
  // Kill-Serie: Meldung ab 3 Kills in EINER Runde (CS2 meldet round_kills; neue Runde setzt zurück)
  const rk = (k, n, round) => h.s.onGsi({ provider: { steamid: '7656' }, map: { name: 'de_nuke', mode: 'competitive', phase: 'live', round }, round: { phase: 'live' },
    player: { steamid: '7656', team: 'CT', state: { health: 100, round_kills: n }, match_stats: { kills: k, deaths: 4 } } }, h.now);
  h.tick(5000);
  h.s.onGsi({ provider: { steamid: '7656' }, map: { name: 'de_nuke', mode: 'competitive', phase: 'live', round: 3 }, round: { phase: 'freezetime' }, player: { steamid: '7656', team: 'CT', state: { health: 100, round_kills: 0 }, match_stats: { kills: 1, deaths: 4 } } }, h.now);
  rk(1, 0, 3); rk(2, 1, 3); rk(3, 2, 3); rk(4, 3, 3); rk(5, 4, 3);
  h.s.onGsi({ provider: { steamid: '7656' }, map: { name: 'de_nuke', mode: 'competitive', phase: 'live', round: 4 }, round: { phase: 'freezetime' }, player: { steamid: '7656', team: 'CT', state: { health: 100, round_kills: 0 }, match_stats: { kills: 5, deaths: 4 } } }, h.now);
  rk(6, 1, 4); rk(7, 2, 4);
  eq(h.fx.filter((f) => f.type === 'stats_streak').map((f) => f.streak).join(','), '3,4', 'nur Runde mit 3+ Kills');
  eq(h.s.totals().bestStreak, 4, 'meiste Kills in einer Runde');
  // System-Effekt (Auto-Lebendig): Chaos-Tod, aber nicht in der Folter-Rangliste
  const e6 = h.s.effectStart({ userId: null, user: 'ChaosCore', actionId: 's', title: 'Auto', system: true });
  h.gsi(7, 5, { health: 0, round: 4 }); h.s.effectEnd(e6);
  eq(h.s.totals().deathsChaos, 4); eq(h.s.torture().length, 2);
  h.s.close(); h.db.close();
});
await t('später Tod nach Zuschauer-Wechsel bekommt den Wechsel-Zeitpunkt; ohne Hinweis "natürlich, Zeitpunkt unsicher"', async () => {
  const h = statsHarness();
  h.s.start('manual'); h.gsi(0, 0);
  const e = h.s.effectStart({ userId: 'u1', user: 'Anna', actionId: 'a', title: 'WASD invertiert' });
  h.tick(1000); h.gsi(0, 0, { mine: false }); // GSI zeigt sofort den Mitspieler
  h.s.effectEnd(e); h.tick(30000);
  h.gsi(0, 1, { roundPhase: 'freezetime', round: 4 }); // nächste Runde: Zähler +1
  let tl = h.s.deathTimeline();
  eq(JSON.stringify([tl.length, tl[0].cause, tl[0].viewer, tl[0].detail]), '[1,"chaos","Anna","Zeitpunkt geschätzt"]');
  // Zähler steigt ohne jeden Hinweis (z. B. nach Neustart): natürlich, als unsicher markiert
  h.tick(60000); h.gsi(0, 2, { round: 5 });
  tl = h.s.deathTimeline();
  eq(JSON.stringify([tl[0].cause, tl[0].detail]), '["natural","Zeitpunkt unsicher"]');
  h.s.close(); h.db.close();
});
await t('Korrektur, Handzählung (+/-, nie unter 0), Fail-Sperre, Runden/Matches, CSV ohne Formel-Einschleusung', async () => {
  const h = statsHarness();
  eq(h.s.addFail('chat').reason, 'no_session', 'ohne Sitzung kein Fail');
  h.s.start('manual'); h.gsi(0, 0);
  const e = h.s.effectStart({ userId: 'u9', user: '=HYPERLINK("x")', actionId: 'a', title: '+Böse' });
  h.gsi(0, 1, { health: 0 }); h.s.effectEnd(e);
  const id = h.s.deathTimeline()[0].id;
  yes(h.s.correctDeath(id, 'natural').ok); eq(h.s.totals().deathsNatural, 1);
  yes(h.s.correctDeath(id, 'chaos').ok); eq(h.s.totals().deathsChaos, 1); eq(h.s.deathTimeline()[0].corrected, true);
  eq(h.s.correctDeath(99999, 'chaos').ok, false);
  yes(h.s.adjust('deaths', -1).ok); eq(h.s.totals().deaths, 0); eq(h.s.deathTimeline()[0].removed, true);
  eq(h.s.adjust('deaths', -1).reason, 'zero', 'nie unter 0');
  yes(h.s.adjust('kills', +1).ok); yes(h.s.adjust('roundsWon', 1).ok); yes(h.s.adjust('matchesLost', 1).ok);
  eq(h.s.adjust('kd', 1).reason, 'unknown_stat', 'berechnete Werte sind nicht von Hand zählbar');
  yes(h.s.addFail('chat', 'mod1').ok); eq(h.s.addFail('chat', 'mod2').reason, 'cooldown', 'zwei Mods gleichzeitig = ein Fail');
  h.tick(3500); yes(h.s.addFail('hotkey').ok); yes(h.s.addFail('dashboard').ok, 'Dashboard ohne Sperre');
  const t1 = h.s.totals();
  eq(JSON.stringify([t1.kills, t1.fails, t1.roundsWon, t1.matchesLost, t1.kd]), '[1,3,1,1,1]');
  const csv = h.s.csv(h.s.session.id);
  yes(csv.startsWith('zeit;typ;wert;ursache;zuschauer'), 'CSV-Kopf');
  yes(csv.includes(`"'=HYPERLINK(""x"")"`) && csv.includes("'+Böse"), 'fremde Texte dürfen keine Tabellen-Formel werden');
  eq(h.s.csv(424242), null);
  h.s.close(); h.db.close();
});
await t('Absturz-Wiederherstellung - Sitzung, Ausgangswerte und Effekte überleben, nichts doppelt gezählt; Ende ohne Aktivität = letzter Sicherungszeitpunkt', async () => {
  const h = statsHarness();
  h.s.start('stream'); h.gsi(10, 4); h.tick(1000); h.gsi(11, 4);
  const e = h.s.effectStart({ userId: 'u1', user: 'Anna', actionId: 'a', title: 'WASD invertiert' });
  h.s.saveState(true);
  const savedAt = h.now;
  // "Absturz": kein close(), neue Instanz auf derselben Datenbank.
  h.tick(2000);
  let clock = h.now;
  const db2 = openStatsDb(h.file);
  const s2 = new SessionStats({ cfg: h.scfg, db: db2, now: () => clock });
  eq(s2.session?.source, 'stream', 'Sitzung fortgesetzt');
  const feed = (k, d, health = 100) => s2.onGsi({ provider: { steamid: '7656' }, map: { name: 'de_nuke', mode: 'competitive', phase: 'live', round: 3 }, round: { phase: 'live' },
    player: { steamid: '7656', team: 'CT', state: { health, round_kills: 0 }, match_stats: { kills: k, deaths: d } } }, clock);
  feed(11, 4); eq(s2.totals().kills, 1, 'derselbe Stand zählt nicht nochmal');
  feed(11, 5, 0);
  const tl = s2.deathTimeline();
  eq(JSON.stringify([tl.length, tl[0].cause, tl[0].viewer]), '[1,"chaos","Anna"]', 'laufender Effekt überlebt den Neustart');
  s2.close(); db2.close();
  // Neustart am nächsten Tag ohne jede Aktivität, Stream offline -> Ende = letzter Sicherungszeitpunkt
  clock += 20 * 3600 * 1000;
  const db3 = openStatsDb(h.file);
  const s3 = new SessionStats({ cfg: h.scfg, db: db3, now: () => clock });
  const sid = s3.session.id;
  s3.setStreamLive(false);
  eq(s3.session, null, 'Stream offline beendet die Stream-Sitzung');
  const row = s3.history(1)[0];
  yes(row.id === sid && row.endedAt < savedAt + 10 * 60000, `Ende ${row.endedAt} statt Startzeit+20h`);
  s3.close(); db3.close(); h.db.close();
  void e;
});
await t('Stream online/offline steuert die Sitzung; von Hand gestartete Sitzung wird übernommen; autoStream aus = nur von Hand; ausgeschaltet = keine Sitzung', async () => {
  const h = statsHarness();
  h.s.setStreamLive(true); eq(h.s.session?.source, 'stream');
  h.s.setStreamLive(false); eq(h.s.session, null);
  h.s.start('manual'); h.s.setStreamLive(true); eq(h.s.session.source, 'stream', 'übernommen');
  h.s.setStreamLive(false); eq(h.s.session, null, 'endet mit dem Stream');
  h.scfg.stats.autoStream = false;
  h.s.setStreamLive(true); eq(h.s.session, null);
  h.s.start('manual'); h.s.setStreamLive(false); eq(h.s.session?.source, 'manual', 'ohne autoStream endet nur von Hand');
  h.s.stop('manual');
  h.scfg.stats.enabled = false; eq(h.s.start('manual'), null);
  eq(h.s.history(5).length, 3);
  h.s.close(); h.db.close();
});

// =============== Schritt-Sprache: zentrale Grenzen ===============
// Reine Funktionstests ohne Server: steps.js hat keine Abhängigkeiten und keinen Zustand.
const stepsMod = await import('../src/steps.js');
const stepErr = (steps, keys = {}) => stepsMod.validateAction({ effect: { steps } }, keys);

await t('überdimensionierte Schritte werden sofort und ohne Speicheranstieg abgelehnt', async () => {
  const heap0 = process.memoryUsage().heapUsed;
  const t0 = Date.now();
  // Vier Ebenen "repeat 200" wären 1,6 Mrd. Zeilen - ohne die Grenze hätte schon die dritte Ebene 8 Mio. Zeilen erzeugt.
  yes(/verschachtelbar/.test(stepErr(['repeat 200', 'repeat 200', 'repeat 200', 'repeat 200', 'wait 1', 'endrepeat', 'endrepeat', 'endrepeat', 'endrepeat']) || ''), 'tiefe Verschachtelung nicht abgelehnt');
  yes(/mehr als 2000 Schritte/.test(stepErr(['repeat 200', 'repeat 200', 'wait 1', 'endrepeat', 'endrepeat']) || ''), '40.000 aufgelöste Zeilen nicht abgelehnt');
  yes(/mehr als 2000 Schritte/.test(stepErr(['repeat 200', ...Array(11).fill('wait 1'), 'endrepeat']) || ''), '2.200 aufgelöste Zeilen nicht abgelehnt');
  yes(/Zu viele Schritte/.test(stepErr(Array(101).fill('wait 1')) || ''), '101 Quellzeilen nicht abgelehnt');
  yes(Date.now() - t0 < 500, 'Ablehnung hat zu lange gedauert');
  yes(process.memoryUsage().heapUsed - heap0 < 20e6, 'Ablehnung hat spürbar Speicher belegt');
  // Genau an der Grenze ist erlaubt: 200 x 10 = 2000 Zeilen.
  eq(stepErr(['repeat 200', ...Array(10).fill('wait 1'), 'endrepeat']), null, '2000 Zeilen müssen erlaubt sein');
  eq(stepErr(['repeat 2', 'repeat 3', 'wait 1', 'endrepeat', 'endrepeat']), null, 'zweifache Verschachtelung muss erlaubt sein');
});

await t('Zeiten, Zahlenbereiche und Aufbau der Schritte werden geprüft', async () => {
  yes(/0 bis 60000/.test(stepErr(['wait 99999999']) || ''), 'zu langes wait nicht abgelehnt');
  yes(/1 bis 60000/.test(stepErr(['hold w 60001']) || ''), 'zu langes hold nicht abgelehnt');
  yes(/ungültig/.test(stepErr(['wait abc']) || ''), 'wait ohne Zahl nicht abgelehnt');
  yes(/ungültig/.test(stepErr(['wait -5']) || ''), 'negatives wait nicht abgelehnt');
  yes(/ungültig/.test(stepErr(['mouse 5 5 0 10']) || ''), 'mouse mit 0 Teilschritten nicht abgelehnt');
  yes(/ungültig/.test(stepErr(['look 0 9999 25 12']) || ''), 'look mit absurdem Winkel nicht abgelehnt');
  yes(/maximal 120 s/.test(stepErr(['hold w 60000', 'hold w 60000', 'hold w 1']) || ''), 'Gesamtdauer über 120 s nicht abgelehnt');
  eq(stepErr(['hold w 60000', 'hold w 60000']), null, 'genau 120 s müssen erlaubt sein');
  yes(/ohne zugehöriges/.test(stepErr(['wait 1', 'endrepeat']) || ''), 'überzähliges endrepeat nicht abgelehnt');
  yes(/ohne abschließendes/.test(stepErr(['repeat 3', 'wait 1']) || ''), 'fehlendes endrepeat nicht abgelehnt');
  yes(/oncleanup press/.test(stepErr(['oncleanup hold x']) || ''), 'oncleanup mit anderem Befehl nicht abgelehnt');
  yes(/Textzeile/.test(stepErr([{ toString: () => 'wait 1' }]) || ''), 'Nicht-Text als Schritt nicht abgelehnt');
  yes(/Unbekannter Effekt-Befehl/.test(stepErr(['constructor x']) || ''), 'Objekt-Eigenschaft als Befehl nicht abgelehnt');
  yes(/nicht definiert/.test(stepErr(['press @toString']) || ''), 'geerbte Objekt-Eigenschaft als Taste nicht abgelehnt');
  // until_stop zählt nicht in die geschätzte Dauer - dafür gilt die harte Lauf-Obergrenze in der Engine.
  eq(stepsMod.compile(['press w 60', 'until_stop'], {}).est.untilStop, true);
  yes(Object.isFrozen(stepsMod.LIMITS), 'LIMITS muss eingefroren sein (nicht zur Laufzeit änderbar)');
});

await t('alle mitgelieferten Aktionen, Bits-Stufen und Presets bestehen die neuen Grenzen unverändert', async () => {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  const cs2Keys = (await import('../src/games/index.js')).CS2_PROFILE.keyDefaults;
  const fnKeys = { ...cs2Keys, ...(await import('../src/games/index.js')).FORTNITE_PROFILE.keyDefaults };
  const sets = [
    ['config/actions.default.json', read('config/actions.default.json').actions, cs2Keys],
    ['config/actions-bits.default.json', read('config/actions-bits.default.json').actions, cs2Keys],
    ['config/actions.fortnite.default.json', read('config/actions.fortnite.default.json').actions, fnKeys],
  ];
  for (const f of fs.readdirSync(path.join(ROOT, 'config', 'presets'))) {
    const p = read(`config/presets/${f}`);
    sets.push([`config/presets/${f}`, p.actions.actions, { ...cs2Keys, ...p.keys }]);
  }
  let checked = 0;
  for (const [file, actions, keys] of sets) {
    for (const a of actions) {
      const err = stepsMod.validateAction(a, keys); // bewusst auch deaktivierte Aktionen
      eq(err, null, `${file}: Aktion "${a.id}" besteht die Prüfung nicht mehr`);
      checked++;
    }
  }
  yes(checked >= 30, `zu wenige Aktionen geprüft (${checked})`);
});

// =============== Tasten-Erlaubnisliste in drei Stufen ===============
const keysMod = await import('../src/keys.js');
await t('Tasten-Stufen normal/kritisch/gesperrt, Roh-Codes und Systemkombinationen', async () => {
  for (const k of ['w', 'W', '1', 'Space', 'Tab', 'LCtrl', 'Shift', 'F12', 'Numpad7', 'NumpadEnter', 'NumpadMult', 'LButton', 'WheelDown', 'XButton2']) eq(keysMod.classifyKey(k), 'normal', `"${k}"`);
  for (const k of ['Enter', 'Return', 'Escape', 'esc', 'Alt', 'LAlt', 'RAlt', 'Delete', 'Backspace', 'Home', 'PgDn']) eq(keysMod.classifyKey(k), 'critical', `"${k}"`);
  // Roh-Codes (vk/sc) würden jede Verbotsliste umgehen - eine Erlaubnisliste nicht.
  for (const k of ['LWin', 'RWin', 'AppsKey', 'PrintScreen', 'Sleep', 'Volume_Mute', 'Browser_Home', 'Launch_App1', 'vk5B', 'sc15B', 'F13', '12', 'toString', '__proto__']) eq(keysMod.classifyKey(k), 'blocked', `"${k}"`);
  // Ohne Freigabe: kritisch abgelehnt. Mit Freigabe der Gruppe: erlaubt, in jeder Schreibweise.
  yes(/kritische Taste/.test(stepErr(['press Enter']) || ''), 'Enter ohne Freigabe');
  eq(stepsMod.validateAction({ effect: { steps: ['press Return 60', 'hold RAlt 500'] } }, {}, { critical: ['Enter', 'Alt'] }), null, 'freigegebene kritische Tasten müssen gehen');
  yes(/kritische Taste/.test(stepsMod.validateAction({ effect: { steps: ['press Escape'] } }, {}, { critical: ['Enter'] }) || ''), 'Freigabe von Enter darf Escape nicht freigeben');
  // Gesperrt bleibt gesperrt, auch wenn alles freigegeben ist - an jeder Tasten-Position jedes Befehls.
  const all = { critical: keysMod.CRITICAL_KEY_NAMES };
  for (const st of [['press LWin'], ['hold RWin 100'], ['block w LWin'], ['release vk5B'], ['swap w LWin'], ['swap LWin w'], ['oncleanup press LWin'], ['press @x']]) {
    yes(/gesperrt oder unbekannt/.test(stepsMod.validateAction({ effect: { steps: st } }, { x: 'LWin' }, all) || ''), `nicht abgelehnt: ${st}`);
  }
  // Systemkombinationen: nie, auch wenn beide Tasten einzeln erlaubt/freigegeben sind.
  for (const st of [['press LAlt', 'press F4'], ['hold Alt 100', 'press Tab'], ['press @a', 'press @b'], ['hold LCtrl 100', 'press Esc'], ['block RAlt', 'press Space']]) {
    yes(/Systemkombination/.test(stepsMod.validateAction({ effect: { steps: st } }, { a: 'F4', b: 'RAlt' }, all) || ''), `Kombination nicht abgelehnt: ${st}`);
  }
  // Alt allein (freigegeben) und F4 allein bleiben nutzbar.
  eq(stepsMod.validateAction({ effect: { steps: ['hold LAlt 500'] } }, {}, all), null);
  eq(stepErr(['press F4']), null);
  // Import-Stufe: roh geschriebene kritische Taste nie, über "@name" nur die lokal freigegebene.
  const imp = { critical: ['Alt'], rawCritical: [] };
  yes(/kritische Taste/.test(stepsMod.validateAction({ effect: { steps: ['hold LAlt 500'] } }, {}, imp) || ''), 'rohe kritische Taste im Import');
  eq(stepsMod.validateAction({ effect: { steps: ['hold @walk 500'] } }, { walk: 'LAlt' }, imp), null, 'lokal freigegebene Belegung über @name');
});

await t('schon vorher belegte kritische Taste wird NICHT stillschweigend freigegeben - Belegung bleibt, Nachfrage steht aus, Antwort wirkt', async () => {
  const dir = path.join(tmp, 'keypolicy'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ keys: { walk: 'LAlt' } }));
  const script = path.join(tmp, 'keypolicy.mjs');
  // Ausgabe je Aufruf: Stand nach dem Laden; optionales Argument beantwortet die Nachfrage ("allow"/"decline").
  fs.writeFileSync(script, `import { loadConfig, loadActions, pendingCriticalKeys, applyCriticalKeys } from ${JSON.stringify(path.join(ROOT, 'src', 'config.js'))};
    const c = loadConfig();
    if (process.argv[2] === 'allow') applyCriticalKeys(c, ['Alt']);
    if (process.argv[2] === 'decline') applyCriticalKeys(c, [], ['Alt']);
    const a = loadActions('cs2').byId.get('shift_police');
    console.log(JSON.stringify({ input: c.input, walk: c.keys.walk, pending: pendingCriticalKeys(c), invalid: a.invalid || null, enabled: a.enabled, enabledInFile: a.enabledInFile }));`);
  const env = { ...process.env, UCC_DATA_DIR: dir, NO_COLOR: '1' };
  const call = async (arg, e = env) => JSON.parse((await run(path.relative(ROOT, script), arg ? [arg] : [], e)).out.trim().split('\n').pop());
  // Erster Start nach dem Update: nichts freigegeben, Belegung unverändert, Nachfrage steht aus,
  // die Aktion "Shift-Polizei" (hält @walk) ist deaktiviert und nennt den Grund.
  const first = await call();
  eq(JSON.stringify(first.input.criticalKeys), '[]', 'kritische Taste wurde stillschweigend freigegeben');
  eq(first.walk, 'LAlt', 'bestehende Belegung ging verloren');
  eq(JSON.stringify(first.pending), JSON.stringify([{ group: 'Alt', bindings: [{ name: 'walk', key: 'LAlt' }] }]), 'Nachfrage steht nicht (richtig) aus');
  yes(/kritische Taste \(Alt\) und nicht freigegeben/.test(first.invalid || '') && first.enabled === false && first.enabledInFile === true, `betroffene Aktion nicht deaktiviert/begründet: ${JSON.stringify(first)}`);
  // Ein zweiter Start ohne Antwort ändert nichts (keine Freigabe "nach einer Weile").
  eq(JSON.stringify((await call()).pending), JSON.stringify(first.pending));
  // Antwort "nein": Belegung bleibt, Nachfrage verschwindet, Aktion bleibt aus.
  const declined = await call('decline');
  eq(declined.walk, 'LAlt'); eq(declined.pending.length, 0, 'Nachfrage kommt nach "nein" wieder');
  eq(JSON.stringify(declined.input), JSON.stringify({ criticalKeys: [], criticalDeclined: ['Alt'] }));
  yes(declined.invalid && declined.enabled === false, 'Aktion müsste nach "nein" aus bleiben');
  eq((await call()).pending.length, 0, 'Nachfrage kommt nach Neustart wieder');
  // Antwort "ja" (auch nachträglich über die Einstellungen): freigegeben, Aktion wieder da.
  const allowed = await call('allow');
  eq(JSON.stringify(allowed.input), JSON.stringify({ criticalKeys: ['Alt'], criticalDeclined: [] }));
  yes(allowed.invalid === null && allowed.enabled === true, `Aktion nach Freigabe nicht wieder gültig: ${JSON.stringify(allowed)}`);
  // Frische Installation: nichts freigegeben, keine Nachfrage.
  const dir2 = path.join(tmp, 'keypolicy2'); fs.mkdirSync(dir2, { recursive: true });
  const fresh = await call(null, { ...env, UCC_DATA_DIR: dir2 });
  eq(JSON.stringify(fresh.input.criticalKeys), '[]'); eq(fresh.pending.length, 0);
});

// =============== Zentrale Aktionsprüfung ===============
const validateMod = await import('../src/validate.js');
await t('jede Aktion wird vollständig geprüft - Felder, Typen, requires, effect.dynamic, Stufen, Fluchrad', async () => {
  const cats = { small: { cooldownSec: 1, perUser: 1, chaos: 1, color: '#B026FF' } };
  const ok = { id: 'x1', title: 'Test', cost: 100, category: 'small', enabled: false, requires: ['live'], effect: { steps: ['press w 60'] } };
  const prob = (patch, strict = true) => validateMod.actionProblem({ ...structuredClone(ok), ...patch }, { categories: cats, keys: {}, policy: {}, strict });
  eq(prob({}), null, 'gültige Aktion abgelehnt');
  const cases = [
    [{ id: '../../etc' }, /gültige id/], [{ id: 5 }, /gültige id/], [{ title: '' }, /Titel/], [{ title: 'x'.repeat(46) }, /Titel/],
    [{ category: 'nope' }, /unbekannte Stufe/], [{ category: 'toString' }, /unbekannte Stufe/],
    [{ cost: 0 }, /Preis/], [{ cost: '100' }, /Preis/], [{ cost: 1.5 }, /Preis/], [{ access: 'admin' }, /Zugriffsregel/],
    [{ enabled: 'yes' }, /wahr oder falsch/], [{ prompt: 'x'.repeat(301) }, /höchstens 300/], [{ evil: 1 }, /unbekannte Feld "evil"/],
    [{ requires: ['root'] }, /unbekannte Bedingung "root"/], [{ requires: 'live' }, /kurze Liste/],
    [{ effect: [] }, /Objekt/], [{ effect: { dynamic: 'shell' } }, /unbekannte Sonderaktion "shell"/],
    [{ effect: { steps: ['wait 1'], dynamic: 'curse' } }, /nur eine Form/], [{ effect: { exec: 'calc.exe' } }, /unbekannte Feld "exec"/],
    [{ effect: { overlay: true, options: [], displayMs: 5000 } }, /1 bis 12 Texte/], [{ effect: { overlay: true, options: ['A'], displayMs: 999999 } }, /displayMs/],
    [{ effect: { options: ['A'] } }, /nur zusammen/], [{ effect: { steps: 'press w' } }, /Liste/],
    // deaktiviert (enabled: false ist der Ausgangswert) - Schritte werden trotzdem geprüft:
    [{ effect: { steps: ['press LWin'] } }, /gesperrt/], [{ effect: { steps: ['format c'] } }, /Unbekannter Effekt-Befehl/],
  ];
  for (const [patch, re] of cases) yes(re.test(prob(patch) || ''), `nicht abgelehnt: ${JSON.stringify(patch)} -> ${prob(patch)}`);
  // "__proto__" als eigenes Feld (so kommt es aus JSON.parse) zählt als unbekanntes Feld.
  yes(/unbekannte Feld "__proto__"/.test(validateMod.actionProblem(JSON.parse('{"id":"x1","title":"T","cost":1,"category":"small","__proto__":{"a":1}}'), { categories: cats, keys: {}, policy: {}, strict: true }) || ''), '__proto__ nicht abgelehnt');
  // Nachsichtig (lokale Datei): unbekannte Felder werden ignoriert, echte Fehler nicht.
  eq(prob({ evil: 1 }, false), null, 'lokale Datei: unbekanntes Feld sollte ignoriert werden');
  yes(/unbekannte Sonderaktion/.test(prob({ effect: { dynamic: 'shell' } }, false) || ''), 'lokale Datei: unbekanntes dynamic muss trotzdem auffallen');

  const file = (patch) => validateMod.actionsFileProblem({ schema: 3, categories: structuredClone(cats), actions: [structuredClone(ok)], ...patch }, { keys: {}, policy: {} });
  eq(file({}), null, 'gültige Datei abgelehnt');
  const fcases = [
    [{ extra: 1 }, /unbekannte Feld "extra"/], [{ categories: {} }, /1 bis 20 Stufen/], [{ categories: { small: { ...cats.small, color: 'red' } } }, /color/],
    [{ categories: { small: { ...cats.small, cooldownSec: -1 } } }, /cooldownSec/], [{ categories: { small: { ...cats.small, run: 'x' } } }, /unbekannte Feld "run"/],
    [{ actions: 'x' }, /Aktionen-Liste fehlt/], [{ actions: [ok, ok] }, /mehrfach/], [{ actions: Array.from({ length: 201 }, (_, i) => ({ ...ok, id: `a${i}` })) }, /Zu viele Aktionen/],
    [{ curse: { pool: ['ghost'] } }, /unbekannte Aktion "ghost"/], [{ curse: { pool: 'x1' } }, /Fluchrad/], [{ actions: [null] }, /kein Objekt/],
  ];
  for (const [patch, re] of fcases) yes(re.test(file(patch) || ''), `Datei nicht abgelehnt: ${JSON.stringify(patch).slice(0, 80)} -> ${file(patch)}`);
});

await t('alle mitgelieferten Aktionen-Dateien und Presets bestehen die STRENGE Prüfung (wie ein Import)', async () => {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  const g = await import('../src/games/index.js');
  const cs2Keys = g.CS2_PROFILE.keyDefaults;
  const files = [
    ['config/actions.default.json', read('config/actions.default.json'), cs2Keys],
    ['config/actions-bits.default.json', read('config/actions-bits.default.json'), cs2Keys],
    ['config/actions.fortnite.default.json', read('config/actions.fortnite.default.json'), { ...cs2Keys, ...g.FORTNITE_PROFILE.keyDefaults }],
  ];
  for (const f of fs.readdirSync(path.join(ROOT, 'config', 'presets'))) { const p = read(`config/presets/${f}`); files.push([`config/presets/${f}`, p.actions, { ...cs2Keys, ...p.keys }]); }
  for (const [name, raw, keys] of files) eq(validateMod.actionsFileProblem(raw, { keys, policy: {} }), null, name);
  // Jede Bedingung und Sonderaktion, die mitgeliefert wird, ist in der bekannten Menge - und umgekehrt
  // gibt es keinen bekannten Eintrag, den niemand benutzt (sonst wäre die Liste zu weit).
  const all = files.flatMap(([, raw]) => raw.actions);
  for (const r of validateMod.KNOWN_REQUIRES) yes(all.some((a) => (a.requires || []).includes(r)), `requires "${r}" wird nirgends benutzt`);
  for (const d of validateMod.KNOWN_DYNAMIC) yes(all.some((a) => a.effect?.dynamic === d), `dynamic "${d}" wird nirgends benutzt`);
});

// =============== Einrichtungs-Assistent ===============
console.log('Einrichtungs-Assistent');
let wiz;
await t('Erstes Setup: Stream-Key/Müll abgelehnt, falsche ID erkannt, Login, CS2, 20 Belohnungen', async () => {
  // Erste Antwort ("j") ist die neue Zustimmung zur Eigenverantwortung -
  // ohne sie bricht der Assistent ab, bevor er überhaupt nach der Client-ID fragt.
  const answers = ['j', 'n', 'live_abcdef123456', 'zu-kurz', 'b'.repeat(30), VALID_CLIENT_ID, '1,2', '8', 'j', 'n', 'j', 'n'].join('\n') + '\n';
  wiz = await run('scripts/setup.js', [], A.env, answers);
  eq(wiz.code, 0, `Exit-Code (Ausgabe:\n${wiz.out.slice(-1500)})`);
  yes(/Zustimmung gespeichert/.test(wiz.out), 'Zustimmung zur Eigenverantwortung fehlt');
  yes(/STREAM-KEY/.test(wiz.out), 'Stream-Key wurde nicht erkannt');
  yes(/30 Zeichen/.test(wiz.out), 'Kurze ID wurde nicht abgelehnt');
  yes(/kennt diese Client-ID nicht/.test(wiz.out), 'Falsche ID wurde nicht von Twitch abgelehnt');
  yes(/Eingeloggt als testcaster/.test(wiz.out), 'Login fehlt');
  eq(mock.st.rewards.length, 20, 'Anzahl Belohnungen auf Twitch');
  const cfg = JSON.parse(fs.readFileSync(path.join(A.data, 'config.json'), 'utf8'));
  eq(cfg.twitch.clientId, VALID_CLIENT_ID); eq(cfg.twitch.userId, '123'); eq(cfg.game.cs2CfgDir, steam);
  // Verantwortung als Produktmerkmal: die Zustimmung landet mit echtem Zeitstempel in
  // der Config, nicht nur als "wurde angezeigt"-Haken ohne Beweis.
  yes(!!cfg.consent.riskAcknowledgedAt && !Number.isNaN(Date.parse(cfg.consent.riskAcknowledgedAt)), 'Zustimmungs-Zeitstempel fehlt oder ist ungültig');
  const map = JSON.parse(fs.readFileSync(path.join(A.data, 'rewards.json'), 'utf8'));
  eq(Object.keys(map).length, 20, 'rewards.json');
  eq(cfg.game.sensitivity, 1.2, 'Sensitivity wird gespeichert (Komma erlaubt)'); eq(cfg.keys.flash, '8', 'Blend-Taste wird gespeichert');
});
await t('Token-Datei ist privat (0600) und enthält Refresh-Token', async () => {
  const f = path.join(A.data, 'tokens.json');
  const tok = JSON.parse(fs.readFileSync(f, 'utf8'));
  yes(tok.refreshToken && tok.accessToken, 'Tokens fehlen');
  if (process.platform !== 'win32') eq((fs.statSync(f).mode & 0o777).toString(8), '600', 'Dateirechte');
});
await t('CS2-Dateien installiert (GSI, Binds, autoexec)', async () => {
  const gsi = fs.readFileSync(path.join(steam, 'gamestate_integration_chaoscore.cfg'), 'utf8');
  yes(!fs.existsSync(path.join(steam, 'gamestate_integration_unknown.cfg')), 'alte GSI-Datei liegt noch daneben (CS2 schickt dann doppelt)');
  yes(/"player_match_stats"\s+"1"/.test(gsi), 'player_match_stats fehlt (Session Stats)');
  yes(gsi.charCodeAt(0) !== 0xfeff, 'GSI-Datei beginnt mit einem BOM');
  const cfg = JSON.parse(fs.readFileSync(path.join(A.data, 'config.json'), 'utf8'));
  yes(gsi.includes(cfg.server.gsiToken), 'GSI-Token fehlt');
  yes(gsi.includes(`127.0.0.1:${cfg.server.port}/gsi`), 'GSI-URL falsch');
  yes(fs.existsSync(path.join(steam, 'unknown_chat_control.cfg')), 'Binds fehlen');
  yes(/exec unknown_chat_control/.test(fs.readFileSync(path.join(steam, 'autoexec.cfg'), 'utf8')), 'autoexec fehlt');
});
await t('Zweiter Lauf ist idempotent (keine doppelten Belohnungen), alte Aktionen optional', async () => {
  const r = await run('scripts/setup.js', [], A.env, ['n', 'n', '', '', 'j', 'j', 'n'].join('\n') + '\n');
  eq(r.code, 0, `Exit-Code (Ausgabe:\n${r.out.slice(-1200)})`);
  yes(/Bereits eingeloggt/.test(r.out), 'sollte vorhandenen Login erkennen');
  eq(mock.st.rewards.length, 20 + 3, 'Belohnungen inkl. alte Aktionen');
  eq(new Set(mock.st.rewards.map((x) => x.id)).size, 23, 'IDs eindeutig');
});
await t('Doctor: alles in Ordnung (Exit 0)', async () => {
  const r = await run('scripts/doctor.js', [], A.env);
  eq(r.code, 0, `Doctor-Ausgabe:\n${r.out}`);
  yes(/Belohnungen auf Twitch verbunden/.test(r.out), 'Belohnungs-Check fehlt');
});
await t('Doctor erkennt kaputten Effekt in actions.json', async () => {
  const f = path.join(A.data, 'actions.json');
  const orig = fs.readFileSync(f, 'utf8');
  const j = JSON.parse(orig);
  j.actions.find((a) => a.id === 'shift_police').effect.steps = ['hold shiftt rm -rf'];
  fs.writeFileSync(f, JSON.stringify(j));
  const r = await run('scripts/doctor.js', [], A.env);
  fs.writeFileSync(f, orig);
  eq(r.code, 1, 'Exit-Code'); yes(/Shift-Polizei.*ungültig/.test(r.out), 'Fehler nicht gemeldet');
});
await t('Kein Affiliate: Kanalpunkte-Belohnungen werden trotzdem ganz normal angelegt (Twitch-Regel seit Mai 2026', async () => {
  const m2 = await startMock({ broadcasterType: '' });
  const B = mkEnv('b', m2);
  const r = await run('scripts/setup.js', [], B.env, ['j', 'n', VALID_CLIENT_ID, '', '', '', 'n', 'j', 'n'].join('\n') + '\n');
  await m2.stop();
  eq(r.code, 0, `Exit-Code (Ausgabe:\n${r.out.slice(-1500)})`);
  yes(/kein Affiliate\/Partner nötig/.test(r.out), 'Hinweis "kein Affiliate/Partner nötig" fehlt');
  yes(!/Affiliate oder Partner\. Kanalpunkte-Belohnungen sind dann nicht verfügbar/.test(r.out), 'veraltete, falsche Affiliate-Warnung sollte nicht mehr erscheinen');
  yes(m2.st.rewards.length > 0, 'Belohnungen sollten trotz fehlendem Affiliate-Status angelegt worden sein');
});
await t('Zustimmung zur Eigenverantwortung abgelehnt: Assistent bricht ab, kein Start möglich', async () => {
  const m3 = await startMock();
  const C = mkEnv('c', m3);
  // Erste Antwort "n" lehnt die Zustimmung ab - alles danach wird nie gefragt, weil abgebrochen wird.
  const r = await run('scripts/setup.js', [], C.env, 'n\n');
  await m3.stop();
  eq(r.code, 1, `Exit-Code (Ausgabe:\n${r.out.slice(-1500)})`);
  yes(/Ohne diese Zustimmung kann ChaosCore nicht gestartet werden/.test(r.out), 'Abbruch-Meldung fehlt');
  const cfg = JSON.parse(fs.readFileSync(path.join(C.data, 'config.json'), 'utf8'));
  yes(!cfg.consent.riskAcknowledgedAt, 'Ohne Zustimmung darf kein Zeitstempel gespeichert werden');
});
await t('Server-Start: ohne Zustimmung bleibt es bei "Erst-Einrichtung nötig", trotz gültigem Twitch-Login', async () => {
  // Env B hat schon einen vollständigen, gültigen Twitch-Login (voriger Test) - Zustimmung aber
  // gezielt wieder entfernt, um zu beweisen, dass GENAU das (und nichts anderes) den Start blockiert.
  const bCfgFile = path.join(tmp, 'b', 'data', 'config.json');
  const bCfg = JSON.parse(fs.readFileSync(bCfgFile, 'utf8'));
  yes(!!bCfg.consent.riskAcknowledgedAt, 'Voraussetzung für diesen Test: Env b sollte eigentlich zugestimmt haben');
  const savedConsent = bCfg.consent;
  bCfg.consent = { riskAcknowledgedAt: null };
  bCfg.server.port = 20000 + Math.floor(Math.random() * 20000);
  fs.writeFileSync(bCfgFile, JSON.stringify(bCfg, null, 2));
  const m4 = await startMock({ broadcasterType: '' });
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/server.js')],
    { env: { ...mkEnv('b', m4).env, UCC_TIME_SCALE: '0.02', UCC_POLL_SCALE: '0.02' }, cwd: ROOT });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  try {
    await waitFor(() => /Erst-Einrichtung nötig|läuft\./.test(out), 8000, 'Server-Startmeldung');
    yes(/Erst-Einrichtung nötig: Die Zustimmung zur Eigenverantwortung fehlt noch/.test(out), `Server sollte ohne Zustimmung NICHT starten, Ausgabe: ${out}`);
    yes(!/ChaosCore läuft\./.test(out), 'Server hätte trotz fehlender Zustimmung nicht "läuft" melden dürfen');
  } finally {
    p.kill();
    await m4.stop();
    bCfg.consent = savedConsent; // Zustand für etwaige spätere Nutzung von Env b wiederherstellen
    fs.writeFileSync(bCfgFile, JSON.stringify(bCfg, null, 2));
  }
});

// =============== Laufender Server ===============
console.log('\nServer');
const cfgFile = path.join(A.data, 'config.json');
const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
cfg.server.port = 20000 + Math.floor(Math.random() * 20000);
fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
const actFile = path.join(A.data, 'actions.json');
const act = JSON.parse(fs.readFileSync(actFile, 'utf8'));
Object.assign(act.categories.small, { cooldownSec: 1, perUser: 2 });
Object.assign(act.categories.medium, { cooldownSec: 1 });
Object.assign(act.categories.strong, { cooldownSec: 1000, perUser: 5 });
for (const a of act.actions) {
  if (a.legacy) a.enabled = false;
  if (['weapon_tax', 'pistol_only', 'curse'].includes(a.id)) a.category = 'medium';
  if (a.id === 'route_change') a.category = 'strong';
}
fs.writeFileSync(actFile, JSON.stringify(act, null, 2));
// Abgelaufenes Token erzwingt einen Refresh beim Start; liegen gebliebene Einlösung soll erstattet werden
const tokFile = path.join(A.data, 'tokens.json');
const tok = JSON.parse(fs.readFileSync(tokFile, 'utf8')); tok.expiresAt = 0; fs.writeFileSync(tokFile, JSON.stringify(tok));
mock.st.stale[mock.rewardIdByTitle('Shift-Polizei')] = [{ id: 'stale1' }];

// Nachgestelltes GitHub (Releases-API + Downloads), damit die Update-Prüfung nie ins echte Netz geht.
const ghSetup = Buffer.from('MZ fake installer ' + 'x'.repeat(5000));
const ghSha = (await import('node:crypto')).createHash('sha256').update(ghSetup).digest('hex');
const gh = { releases: [], hits: 0, sums: null, sig: null };
const ghServer = http.createServer((req, res) => {
  gh.hits++;
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/repos/Oliverwebdev/ChaosCore/releases') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(gh.releases)); }
  const tagM = u.pathname.match(/^\/repos\/Oliverwebdev\/ChaosCore\/releases\/tags\/(.+)$/);
  if (tagM) { const r = gh.releases.find((x) => x.tag_name === decodeURIComponent(tagM[1])); res.writeHead(r ? 200 : 404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(r || {})); }
  if (u.pathname.endsWith('/SHA256SUMS.txt.sig')) { res.writeHead(gh.sig ? 200 : 404); return res.end(gh.sig || ''); }
  if (u.pathname.endsWith('/SHA256SUMS.txt')) { res.writeHead(200); return res.end(gh.sums ?? `${ghSha}  ChaosCore-1.1.0-Setup.exe\n`); }
  if (u.pathname.endsWith('-Setup.exe')) { res.writeHead(200, { 'Content-Length': ghSetup.length }); return res.end(ghSetup); }
  res.writeHead(404); res.end();
});
await new Promise((r) => ghServer.listen(0, '127.0.0.1', r));
const ghBase = `http://127.0.0.1:${ghServer.address().port}`;
const ghRelease = (tag, prerelease, sig = true) => ({ tag_name: tag, prerelease, draft: false, html_url: `https://github.com/Oliverwebdev/ChaosCore/releases/tag/${tag}`, body: `Notes ${tag}`,
  assets: [{ name: `ChaosCore-${tag.slice(1)}-Setup.exe`, size: ghSetup.length, browser_download_url: `${ghBase}/dl/${tag}/ChaosCore-${tag.slice(1)}-Setup.exe` },
    { name: 'SHA256SUMS.txt', size: 100, browser_download_url: `${ghBase}/dl/${tag}/SHA256SUMS.txt` },
    ...(sig ? [{ name: 'SHA256SUMS.txt.sig', size: 150, browser_download_url: `${ghBase}/dl/${tag}/SHA256SUMS.txt.sig` }] : [])] });

const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/server.js')],
  { env: { ...A.env, UCC_TIME_SCALE: '0.02', UCC_POLL_SCALE: '0.02', UCC_GITHUB_API: ghBase, UCC_GITHUB_DOWNLOAD: ghBase }, cwd: ROOT });
let srvOut = '';
srv.stdout.on('data', (d) => { srvOut += d; });
srv.stderr.on('data', (d) => { srvOut += d; });
const base = `http://127.0.0.1:${cfg.server.port}`;
const H = { 'x-admin-token': cfg.server.adminToken, 'Content-Type': 'application/json' };
const api = async (p, body) => {
  const r = await fetch(`${base}/api/${p}`, { method: body === undefined ? 'GET' : 'POST', headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const setupApi = async (p, body) => {
  const r = await fetch(`${base}/setup/api/${p}`, { method: body === undefined ? 'GET' : 'POST', headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const st = async () => (await api('status')).json;
const rw = (title) => mock.rewardIdByTitle(title);
let seq = 0;
const redeem = (title, user, id = `r${++seq}`) => { mock.redeem({ id, rewardId: rw(title), user }); return id; };
const status = (id) => mock.st.redemptionStatus[id];
// Löst ein, und wiederholt, falls noch der Cooldown eines früheren Tests der Kategorie läuft (Zeitverhalten des Tests, kein Fehler).
const redeemFree = async (title, user) => {
  for (let i = 0; i < 20; i++) {
    const id = redeem(title, user);
    await sleep(500);
    if (status(id) !== 'CANCELED') return id;
    await sleep(1000);
  }
  throw new Error(`${title}: Cooldown läuft dauerhaft`);
};
const done = (id, s = 'FULFILLED') => waitFor(() => status(id) === s, 6000, `${id} -> ${s} (ist: ${status(id)})`);
const reasonOf = async (action) => (await st()).recent.find((r) => r.action_id === action && r.reason)?.reason;
const gsiPost = (phase, { health = 100, grenade = true, rifle = true, active = 'weapon_ak47', activity = 'playing' } = {}) => fetch(`${base}/gsi`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    provider: { steamid: '765' }, auth: { token: cfg.server.gsiToken }, map: { name: 'de_mirage', mode: 'casual' }, round: { phase },
    player: { steamid: '765', activity, state: { health }, weapons: {
      w0: { name: 'weapon_knife', type: 'Knife', state: active === 'weapon_knife' ? 'active' : 'holstered' },
      ...(rifle ? { w1: { name: 'weapon_ak47', type: 'Rifle', state: active === 'weapon_ak47' ? 'active' : 'holstered' } } : {}),
      w2: { name: 'weapon_glock', type: 'Pistol', state: active === 'weapon_glock' ? 'active' : 'holstered' },
      ...(grenade ? { w3: { name: 'weapon_flashbang', type: 'Grenade', state: active === 'weapon_flashbang' ? 'active' : 'holstered' } } : {}) } },
  }),
});

// SSE-Mitschnitt wie das Overlay
const events = [];
const ac = new AbortController();

await t('Start: Server läuft, Token wurde erneuert, EventSub abonniert', async () => {
  await waitFor(async () => { try { return (await fetch(`${base}/dashboard`)).ok; } catch { return false; } }, 10000, 'Server startet');
  await waitFor(() => mock.st.subscriptions >= 1, 8000, 'EventSub-Abo');
  yes(mock.st.refreshes >= 1, 'Refresh wurde nicht benutzt');
  eq(JSON.parse(fs.readFileSync(tokFile, 'utf8')).refreshToken, mock.st.refreshToken, 'neuer Refresh-Token gespeichert');
  (async () => {
    const res = await fetch(`${base}/events`, { signal: ac.signal });
    const dec = new TextDecoder(); let buf = '';
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i; while ((i = buf.indexOf('\n\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 2); if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6))); }
    }
  })().catch(() => {});
  await waitFor(() => events.length >= 1, 3000, 'erster SSE-Zustand');
  eq(events[0].type, 'state');
});
// Die älteren Tests unten prüfen die klassischen Bits-Stufen - dafür das (standardmäßig aktive)
// Bits-Menü ausschalten. Das Bits-Menü hat weiter unten eigene Tests.
await api('bitsmenu', { enabled: false });
await t('Setup-Fenster: /setup/api/consent setzt/bestätigt die Zustimmung mit Zeitstempel', async () => {
  const before = await setupApi('summary');
  yes(!!before.json.consent?.riskAcknowledgedAt, 'summary sollte die schon beim CLI-Setup gegebene Zustimmung zeigen');
  const r = await setupApi('consent', {});
  yes(r.json.ok && !!r.json.at && !Number.isNaN(Date.parse(r.json.at)), `consent-Antwort ungültig: ${JSON.stringify(r.json)}`);
  const after = await setupApi('summary');
  eq(after.json.consent.riskAcknowledgedAt, r.json.at, 'summary sollte den neuen Zeitstempel widerspiegeln');
});
await t('Setup-Fenster: vorhandene Twitch-Belohnung mit gleichem Titel wird übernommen statt doppelt angelegt', async () => {
  // Simuliert genau das: die Belohnung existiert auf Twitch noch von einem früheren Lauf, aber die
  // lokale Verknüpfung (rewards.json) ist weg - z. B. weil mit frischen lokalen Daten neu
  // eingerichtet wurde. Vorher lehnte Twitch das erneute Anlegen mit "Duplicate Reward" ab; jetzt
  // wird die vorhandene Belohnung per Titel automatisch wieder verknüpft.
  const rewardMapFile = path.join(A.data, 'rewards.json');
  const mapBefore = JSON.parse(fs.readFileSync(rewardMapFile, 'utf8'));
  const oldRid = Object.keys(mapBefore).find((rid) => mapBefore[rid] === 'shift_police');
  yes(oldRid, 'shift_police sollte schon mit Twitch verknüpft sein');
  delete mapBefore[oldRid];
  fs.writeFileSync(rewardMapFile, JSON.stringify(mapBefore));
  const before = mock.st.rewards.length;

  const r = await setupApi('rewards', {});
  yes(r.json.ok, `Abgleich fehlgeschlagen: ${JSON.stringify(r.json)}`);
  const row = r.json.results.find((x) => x.id === 'shift_police');
  eq(row?.state, 'übernommen', `shift_police sollte übernommen, nicht neu angelegt worden sein: ${JSON.stringify(row)}`);
  eq(mock.st.rewards.length, before, 'keine doppelte Belohnung sollte entstanden sein');

  const mapAfter = JSON.parse(fs.readFileSync(rewardMapFile, 'utf8'));
  eq(mapAfter[oldRid], 'shift_police', 'die alte Twitch-Belohnung sollte wieder verknüpft sein');
});
await t('Setup-Fenster: Belohnungen auf Twitch ohne zugehörige Aktion werden als solche gelistet und lassen sich löschen', async () => {
  const extra = await setupApi('rewards'); // GET - vorher: keine verwaisten Belohnungen
  eq(extra.json.unmatched.length, 0, 'vor dem Test sollte es keine verwaisten Belohnungen geben');
  // Eine Belohnung von Hand auf Twitch anlegen, die zu keiner ChaosCore-Aktion gehört.
  mock.st.rewards.push({ id: 'rwOrphan1', title: 'Von Hand angelegt', cost: 999, is_enabled: true });
  const withOrphan = await setupApi('rewards');
  yes(withOrphan.json.unmatched.some((r) => r.id === 'rwOrphan1' && r.title === 'Von Hand angelegt'), 'verwaiste Belohnung wurde nicht gelistet');
  const del = await setupApi('rewards/delete', { id: 'rwOrphan1' });
  yes(del.json.ok, `Löschen fehlgeschlagen: ${JSON.stringify(del.json)}`);
  yes(!mock.st.rewards.some((r) => r.id === 'rwOrphan1'), 'Belohnung wurde bei Twitch nicht gelöscht');
});
await t('Prüfungen (runChecks): kein Affiliate ist überhaupt kein Warn-/Fehlerzustand mehr (Twitch-Regel seit Mai 2026', async () => {
  // Eigener Prozess mit eigenen Daten nötig, da UCC_DATA_DIR in src/config.js beim ersten Import
  // fest einprogrammiert wird (wie bei den anderen Tests, die eine eigene Umgebung brauchen).
  const m5 = await startMock({ broadcasterType: '' });
  const E = mkEnv('e-affiliate-check', m5);
  const r = await run('scripts/setup.js', [], E.env, ['j', 'n', VALID_CLIENT_ID, '', '', '', 'n', 'j', 'n'].join('\n') + '\n');
  eq(r.code, 0, `Setup fehlgeschlagen: ${r.out.slice(-1500)}`);
  const script = path.join(tmp, 'affiliate-check.mjs');
  fs.writeFileSync(script, `import { runChecks } from ${JSON.stringify(path.join(ROOT, 'src', 'checks.js'))}; console.log(JSON.stringify(await runChecks('gui')));`);
  const out = await run(path.relative(ROOT, script), [], E.env);
  await m5.stop();
  eq(out.code, 0, `Check-Skript fehlgeschlagen: ${out.out.slice(-1500)}`);
  const res = JSON.parse(out.out.trim().split('\n').pop());
  const row = res.find((x) => /Affiliate/.test(x.label));
  yes(row, 'Channel-Status-Zeile fehlt');
  eq(row.level, 'ok', `Nicht-Affiliate sollte seit Twitchs Änderung (Mai 2026) überhaupt kein Warn-/Fehlerzustand mehr sein: ${JSON.stringify(row)}`);
});
await t('Liegen gebliebene Einlösung aus der Zwischenzeit wird erstattet', async () => { await done('stale1', 'CANCELED'); });
await t('Sicherheit: Admin-API, Host-Header, GSI-Token, keine Geheimnisse im Overlay-Stream', async () => {
  eq((await fetch(`${base}/api/status`)).status, 401);
  eq((await fetch(`${base}/api/status`, { headers: { 'x-admin-token': 'falsch' } })).status, 401);
  const code = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: cfg.server.port, path: '/dashboard', headers: { Host: 'evil.example:80' } }, (r) => { r.resume(); resolve(r.statusCode); });
  });
  eq(code, 421, 'fremder Host');
  const bad = await fetch(`${base}/gsi`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ auth: { token: 'x' } }) });
  eq(bad.status, 403);
  const blob = JSON.stringify(events);
  for (const secret of [cfg.server.adminToken, cfg.server.gsiToken, mock.st.accessToken, mock.st.refreshToken]) yes(!blob.includes(secret), 'Geheimnis im Overlay-Stream');
});
await t('Einlösung wird ausgeführt und bei Twitch abgeschlossen (FULFILLED)', async () => {
  await done(redeem('Shift-Polizei', 'alice'));
  const s = await st();
  yes(s.recent.some((r) => r.action_id === 'shift_police' && r.status === 'done'), 'DB-Eintrag fehlt');
  yes(/Sende: hold Shift 5000/.test(srvOut), 'Effekt wurde nicht gesendet');
  yes(events.some((e) => e.type === 'fx' && e.fx.type === 'alert' && e.fx.user === 'alice'), 'Overlay-Alert fehlt');
  await waitFor(() => events.some((e) => e.type === 'state' && e.state.chaos > 0), 2000, 'Chaos-Level steigt');
});
await t('Fremde Belohnung wird ignoriert', async () => {
  mock.redeem({ id: 'x1', rewardId: 'fremd', user: 'alice' });
  await sleep(500); eq(status('x1'), undefined);
});
await t('Doppelt zugestellte Einlösung zählt nur einmal', async () => {
  const id = `r${++seq}`;
  mock.redeem({ id, rewardId: rw('Shift-Polizei'), user: 'alice' }); mock.redeem({ id, rewardId: rw('Shift-Polizei'), user: 'alice' });
  await done(id); await sleep(300);
  const n = (await st()).stats.find((x) => x.id === 'shift_police').n;
  eq(n, 2, 'Einlösungen in der DB');
});
await t('Limit pro Zuschauer: dritte Einlösung wird erstattet (CANCELED)', async () => {
  const id = redeem('Shift-Polizei', 'alice'); await done(id, 'CANCELED');
  eq(await reasonOf('shift_police'), 'Limit pro Zuschauer erreicht');
});
await t('Cooldown: zweite starke Aktion direkt danach wird erstattet', async () => {
  await done(redeem('Routenwechsel', 'bob'));
  yes(events.some((e) => e.type === 'fx' && e.fx.type === 'route'), 'Route-Overlay fehlt');
  const id = redeem('Routenwechsel', 'carol'); await done(id, 'CANCELED');
  eq(await reasonOf('route_change'), 'Cooldown läuft noch');
});
await t('Ohne CS2-Verbindung: Utility-Steuer wird erstattet statt blind zu feuern', async () => {
  await done(redeem('Utility-Steuer', 'dora'), 'CANCELED');
  eq(await reasonOf('utility_tax'), 'Braucht die CS2-Verbindung (GSI)');
});
await t('GSI: Aktion wartet im Freezetime und läuft erst, wenn die Runde live ist', async () => {
  yes((await gsiPost('freezetime')).ok, 'GSI akzeptiert');
  const id = redeem('Kein Zoom', 'erin');
  await sleep(600); eq(status(id), undefined, 'darf noch nicht laufen');
  yes((await st()).state.queue.length === 1, 'Queue-Länge');
  await gsiPost('live'); await done(id);
});
await t('GSI: Timeout im falschen Spielmoment erstattet die Punkte', async () => {
  await gsiPost('freezetime');
  const keep = setInterval(() => gsiPost('freezetime'), 1000);
  const id = redeem('UNKNOWN entdeckt dich', 'finn');
  await done(id, 'CANCELED').finally(() => clearInterval(keep));
  eq(await reasonOf('unknown_sees'), 'Kein passender Spielmoment');
});
await t('Queue-Limit: vierte Einlösung wird sofort erstattet, die anderen laufen der Reihe nach', async () => {
  await gsiPost('freezetime');
  const a = redeem('Shift-Polizei', 'gina'), b = redeem('Feuerpause', 'hugo'), c = redeem('UNKNOWN entdeckt dich', 'ivan');
  await waitFor(async () => (await st()).state.queue.length === 3, 3000, 'Queue = 3');
  const d = redeem('Knife Time', 'jule'); await done(d, 'CANCELED');
  eq(await reasonOf('knife_time'), 'Warteschlange ist voll');
  await gsiPost('live');
  for (const id of [a, b, c]) await done(id);
});
// Wechselt nach kurzer Zeit die aktive Waffe, wie es CS2 nach dem Tastendruck tun würde
const switchSoon = (weapon, ms = 150) => setTimeout(() => gsiPost('live', { active: weapon }), ms);
const mark = () => srvOut.length;
const since = (m) => srvOut.slice(m);

await t('Utility-Steuer: wählt die nächste Granate (Slot-Taste), prüft per GSI und wirft erst dann', async () => {
  await gsiPost('live'); const m = mark();
  switchSoon('weapon_flashbang');
  await done(await redeemFree('Utility-Steuer', 'kai'));
  yes(/press 4 ; wait 450/.test(since(m)), 'Slot-Taste (4) wurde nicht gedrückt');
  yes(/click 80 ; wait 700/.test(since(m)), 'Wurf fehlt');
  await gsiPost('live'); // zurück zur Hauptwaffe
});
await t('Utility-Steuer: klickt NIE, wenn keine Granate in der Hand ist (Punkte werden erstattet)', async () => {
  await gsiPost('live', { active: 'weapon_ak47' }); const m = mark();
  const id = await redeemFree('Utility-Steuer', 'kira');
  await done(id, 'CANCELED');
  eq(await reasonOf('utility_tax'), 'Granate konnte nicht gewählt werden');
  yes(!/click 80/.test(since(m)), 'Es wurde geklickt, obwohl keine Granate gewählt war');
  yes(/press 4 ; wait 450/.test(since(m)) && /press 8 ; wait 450/.test(since(m)) && /press Numpad8 ; wait 450/.test(since(m)), 'Weitere Versuche (Blend-Taste, Numpad8) fehlen');
});
await t('Utility-Steuer: zweiter Versuch über die Granaten-Taste klappt, wenn Slot-Taste nicht reicht', async () => {
  await gsiPost('live', { active: 'weapon_ak47' }); const m = mark();
  switchSoon('weapon_flashbang', 700); // erst nach dem ersten Versuch (Fenster 400 ms im Test)
  await done(await redeemFree('Utility-Steuer', 'kuno'));
  yes(/click 80/.test(since(m)), 'Wurf fehlt');
  await gsiPost('live');
});
await t('Eigene Flashbang: nutzt deine Blend-Taste (hier 8) und wirft automatisch', async () => {
  await gsiPost('live', { active: 'weapon_ak47' }); const m = mark();
  switchSoon('weapon_flashbang');
  await done(await redeemFree('Eigene Flashbang', 'lotta'));
  yes(/press 8 ; wait 450/.test(since(m)), 'Blend-Taste fehlt');
  yes(/click 80/.test(since(m)), 'Wurf fehlt');
  await gsiPost('live');
});
await t('Feuerpause: sperrt linke Maustaste (Programm UND im Spiel) und stellt sie wieder her', async () => {
  await gsiPost('live'); const m = mark();
  await done(await redeemFree('Feuerpause', 'mona'));
  const o = since(m);
  yes(/oncleanup press NumpadMult ; press NumpadDiv ; release LButton ; block LButton ; wait 3000 ; unblock/.test(o), `Schritte falsch:\n${o.slice(-400)}`);
});
await t('Kein Zoom: sperrt rechte Maustaste (Programm UND im Spiel)', async () => {
  await gsiPost('live'); const m = mark();
  await done(await redeemFree('Kein Zoom', 'nils'));
  yes(/oncleanup press NumpadAdd ; press NumpadSub ; release RButton ; block RButton ; wait 15000 ; unblock/.test(since(m)), 'Schritte falsch');
});
await t('UNKNOWN entdeckt dich: schaut automatisch nach oben und wieder zurück', async () => {
  await gsiPost('live'); const m = mark();
  await done(await redeemFree('UNKNOWN entdeckt dich', 'olga'));
  yes(/look 0 -55 25 12 ; wait 700 ; look 0 55 25 12/.test(since(m)), 'Blick-Bewegung fehlt');
});
await t('Bewegungssperre: lässt WASD los und sperrt es', async () => {
  await gsiPost('live'); const m = mark();
  await done(await redeemFree('Bewegungssperre', 'paul'));
  yes(/release w a s d ; block w a s d ; wait 5000 ; unblock/.test(since(m)), 'Schritte falsch');
});
await t('WASD invertiert: tauscht Vor/Zurück und Links/Rechts', async () => {
  await gsiPost('live'); const m = mark();
  await done(await redeemFree('WASD invertiert', 'quentin'));
  yes(/swap w s ; swap s w ; swap a d ; swap d a ; wait 20000 ; unblock/.test(since(m)), 'Schritte falsch');
});
await t('Crosshair unsichtbar: aus und am Ende garantiert wieder an', async () => {
  await gsiPost('live'); const m = mark();
  await done(await redeemFree('Crosshair unsichtbar', 'rosa'));
  yes(/oncleanup press Numpad2 ; press Numpad1 ; wait 20000/.test(since(m)), 'Schritte falsch');
});
await t('Sprung-Spam: presst die Sprung-Taste wiederholt', async () => {
  await gsiPost('live'); const m = mark();
  await done(await redeemFree('Sprung-Spam', 'ina'));
  yes(/press Space 60 ; wait 110/.test(since(m)), 'Sprung-Tastenfolge fehlt');
});
await t('Scoreboard-Sicht: hält die Tab-Taste für die Dauer gedrückt', async () => {
  await gsiPost('live'); const m = mark();
  await done(await redeemFree('Scoreboard-Sicht', 'jo'));
  yes(/hold Tab 4000/.test(since(m)), 'Scoreboard-Halten fehlt');
});
await t('Fadenkreuz riesig: vergrößert und stellt am Ende Größe UND Maus zurück', async () => {
  await gsiPost('live'); const m = mark();
  await done(await redeemFree('Fadenkreuz riesig', 'uwe'));
  yes(/oncleanup press NumpadDot ; press Numpad0 ; wait 15000/.test(since(m)), 'Schritte falsch (muss @restoreExtra nutzen, nicht @xhOn)');
});
await t('Maus invertiert: invertiert vertikal und stellt am Ende Größe UND Maus zurück', async () => {
  await gsiPost('live'); const m = mark();
  await done(await redeemFree('Maus invertiert', 'tom'));
  yes(/oncleanup press NumpadDot ; press NumpadEnter ; wait 10000/.test(since(m)), 'Schritte falsch (muss @restoreExtra nutzen)');
});
await t('Kauf-Sperre: sperrt die Kauftaste befristet, auch außerhalb einer laufenden Runde', async () => {
  await gsiPost('freezetime'); const m = mark(); // "requires": [] -> läuft auch ohne "live"
  const id = await redeemFree('Kauf-Sperre', 'eva');
  await done(id);
  yes(/release b ; block b ; wait 25000 ; unblock/.test(since(m)), 'Schritte falsch');
});
await t('Waffensteuer läuft bis Rundenende und endet automatisch', async () => {
  await gsiPost('live');
  const id = await redeemFree('Waffensteuer', 'lea');
  await waitFor(async () => (await st()).state.current?.untilStop === true, 4000, 'Effekt aktiv');
  await sleep(300); eq(status(id), undefined, 'darf noch nicht fertig sein');
  await gsiPost('over'); await done(id);
});
await t('Not-Aus: stoppt Effekt, erstattet Queue, pausiert, danach Neustart möglich', async () => {
  await gsiPost('live');
  const a = await redeemFree('Pistol Only', 'max'); await waitFor(async () => (await st()).state.current?.untilStop, 4000, 'läuft');
  const b = redeem('Feuerpause', 'nina');
  yes((await api('panic', {})).json.ok, 'panic');
  await done(a, 'CANCELED'); await done(b, 'CANCELED');
  eq((await st()).state.paused, true, 'pausiert');
  const c = redeem('Feuerpause', 'otto'); await done(c, 'CANCELED');
  eq(await reasonOf('ceasefire'), 'ChaosCore ist gerade pausiert');
  await api('pause', { paused: false }); eq((await st()).state.paused, false);
  await gsiPost('live'); await done(redeem('Feuerpause', 'pia'));
});
await t('UNKNOWN-Fluch: Schicksalsrad wählt eine Challenge und führt sie aus', async () => {
  await gsiPost('live', { active: 'weapon_flashbang' }); // Granate in der Hand, damit auch eine gezogene Utility-Challenge klappt
  const id = redeem('UNKNOWN-Fluch', 'quin');
  await waitFor(() => events.some((e) => e.type === 'fx' && e.fx.type === 'wheel'), 4000, 'Rad');
  const w = events.filter((e) => e.type === 'fx' && e.fx.type === 'wheel').pop().fx;
  yes(w.options.includes(w.winner) && w.options.length >= 5, 'Rad-Daten');
  await gsiPost('over'); await sleep(100); await gsiPost('live', { active: 'weapon_flashbang' }); // beendet eine evtl. gewählte until_stop-Challenge
  await done(id, 'FULFILLED').catch(async () => { await gsiPost('over'); await done(id); });
});
await t('Aufräumen: nach hartem Abbruch werden Tasten im Spiel wiederhergestellt', async () => {
  const { cleanupLines } = await import('../src/bridge.js');
  const c = cleanupLines(['oncleanup press NumpadMult', 'press NumpadDiv', 'hold Shift 5000', 'oncleanup press NumpadAdd']);
  // Praxistest 15.11.: auch gerade getippte Tasten, Tausch-Ziele und die Maustaste werden losgelassen.
  eq(c.join(' ; '), 'up NumpadDiv ; up Shift ; press NumpadMult ; press NumpadAdd');
  const c2 = cleanupLines(['swap w s', 'click 80', 'press e', 'hold e 100']);
  eq(c2.join(' ; '), 'up s ; up LButton ; up e', 'Tausch-Ziel, Maustaste und doppelte Tasten');
});
await t('CS2-Binds: Maus-Sperre, Crosshair, Granaten und Wiederherstellung sind enthalten', async () => {
  const { bindsCfg, BINDS_VERSION, cs2KeyName } = await import('../src/cs2.js');
  const { DEFAULTS } = await import('../src/config.js');
  const x = bindsCfg({ crosshairAlpha: 180, crosshairSize: 5, crosshairBigSize: 80, mPitch: 0.022, restoreMouseBinds: true }, DEFAULTS.keys);
  // Praxistest 15.11.: CS2 kennt nur kp_0-kp_9/kp_divide/..., Granaten nur
  // über slot6-10, Fadenkreuz über "crosshair 0/1", cl_crosshair_length und cl_crosshaircolor_r/g/b.
  for (const need of ['bind kp_divide "-attack; unbind mouse1"', 'bind kp_multiply "bind mouse1 +attack"', 'bind kp_minus "-attack2; unbind mouse2"', 'bind kp_plus "bind mouse2 +attack2"',
    'bind kp_1 "crosshair 0"', 'bind kp_2 "crosshair 1"', 'bind kp_7 "slot6"', 'bind kp_8 "slot7"', 'bind kp_9 "slot8"', 'bind kp_4 "slot10"', 'bind kp_5 "slot9"',
    'bind kp_0 "cl_crosshair_length 80"', 'bind kp_enter "m_pitch -0.022"', 'bind kp_del "cl_crosshair_length 5; m_pitch 0.022; cl_crosshaircolor_r 50; cl_crosshaircolor_g 250; cl_crosshaircolor_b 50"', 'bind kp_6 "lastinv"',
    'cl_crosshaircolor_r 255; cl_crosshaircolor_g 0; cl_crosshaircolor_b 0', `ucc-binds-version: ${BINDS_VERSION}`]) yes(x.includes(need), `fehlt: ${need}`);
  yes(BINDS_VERSION >= 8, 'BINDS_VERSION muss mindestens 8 sein, damit bestehende Installationen die neuen Binds bekommen');
  // Diese Source-1-Namen und alten Befehle lehnt CS2 ab bzw. ignoriert sie - sie dürfen nicht mehr vorkommen.
  for (const bad of ['kp_home', 'kp_end', 'kp_ins', 'kp_uparrow', 'kp_downarrow', 'kp_leftarrow', 'kp_rightarrow', 'kp_pgup', 'kp_pgdn', 'kp_slash', 'use weapon_', 'cl_crosshairusealpha', 'cl_crosshairsize', 'cl_crosshaircolor ']) {
    yes(!x.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n').includes(bad), `veraltet/ungültig in CS2: ${bad}`);
  }
  yes(/alias ucc_restore ".*crosshair 1;.*cl_crosshair_length 5; m_pitch 0\.022; cl_crosshaircolor_r 50; cl_crosshaircolor_g 250; cl_crosshaircolor_b 50"/.test(x), 'Sicherheitsnetz stellt Fadenkreuz/Länge/Maus/Farbe nicht zurück');
  // Eigene Farbe: Wiederherstellung nutzt sie.
  const own = bindsCfg({ crosshairColor: [0, 255, 255] }, DEFAULTS.keys);
  yes(own.includes('cl_crosshaircolor_r 0; cl_crosshaircolor_g 255; cl_crosshaircolor_b 255"'), 'eigene Fadenkreuz-Farbe wird nicht wiederhergestellt');
  yes(!/\bF1[3-9]\b|\bF2[0-4]\b/i.test(x), 'F13-F24 darf nicht vorkommen (Source kennt sie nicht)');
  yes(/^ucc_restore$/m.test(x), 'Sicherheitsnetz fehlt');
  yes(!/^ucc_restore$/m.test(bindsCfg({ restoreMouseBinds: false }, DEFAULTS.keys)), 'Sicherheitsnetz sollte abschaltbar sein');
  eq(cs2KeyName('F20'), null, 'F20 ist nicht bindbar'); eq(cs2KeyName('Numpad0'), 'kp_0'); eq(cs2KeyName('NumpadDiv'), 'kp_divide'); eq(cs2KeyName('Q'), 'q');
});
await t('Update: alte actions.json bekommt neue Effekte, eigene Preise und Schalter bleiben', async () => {
  const dir = path.join(tmp, 'migrate'); fs.mkdirSync(dir, { recursive: true });
  const def = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'actions.default.json'), 'utf8'));
  const old = structuredClone(def); delete old.schema;
  const find = (id) => old.actions.find((a) => a.id === id);
  find('ceasefire').effect = { steps: ['block LButton', 'wait 3000', 'unblock'] }; find('ceasefire').cost = 777; find('shift_police').enabled = false;
  Object.assign(find('movement_lock'), { enabled: false, legacy: true }); find('wasd_invert').customEffect = true; find('wasd_invert').effect = { steps: ['wait 1'] };
  old.curse.pool = ['shift_police'];
  fs.writeFileSync(path.join(dir, 'actions.json'), JSON.stringify(old));
  const script = path.join(tmp, 'migrate.mjs');
  fs.writeFileSync(script, `import { loadActions } from ${JSON.stringify(path.join(ROOT, 'src', 'config.js'))}; const a = loadActions(); console.log(JSON.stringify({ cease: a.byId.get('ceasefire'), shift: a.byId.get('shift_police').enabled, ml: a.byId.get('movement_lock'), wi: a.byId.get('wasd_invert').effect, pool: a.curse.pool }));`);
  const r = await run(path.relative(ROOT, script), [], { ...process.env, UCC_DATA_DIR: dir, NO_COLOR: '1' });
  const o = JSON.parse(r.out.trim().split('\n').pop());
  yes(o.cease.effect.steps.includes('press @fireOff'), 'neuer Effekt fehlt'); eq(o.cease.cost, 777, 'eigener Preis bleibt'); eq(o.shift, false, 'eigener Schalter bleibt');
  eq(o.ml.enabled, true, 'früher "alte" Aktion ist jetzt aktiv'); yes(!o.ml.legacy, 'legacy-Flag bleibt');
  eq(o.wi.steps[0], 'wait 1', 'customEffect bleibt unangetastet');
  yes(o.pool.includes('shift_police') && o.pool.includes('movement_lock'), 'Fluch-Pool ergänzt');
});
await t('Aktionstexte: neue Installation mit Locale "en" bekommt englische Titel/Texte, ohne "_en"-Reste in der gespeicherten Datei', async () => {
  const dir = path.join(tmp, 'i18n-fresh'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ server: { locale: 'en' } }));
  const script = path.join(tmp, 'i18n-fresh.mjs');
  fs.writeFileSync(script, `import { loadActions, loadBitsActions } from ${JSON.stringify(path.join(ROOT, 'src', 'config.js'))}; const a = loadActions('cs2'); const b = loadBitsActions(); console.log(JSON.stringify({ title: a.byId.get('unknown_sees').title, flavor: a.byId.get('unknown_sees').flavor, hasEnField: 'title_en' in a.byId.get('unknown_sees'), bitsTitle: b.byId.get('bits_ceasefire').title }));`);
  const r = await run(path.relative(ROOT, script), [], { ...process.env, UCC_DATA_DIR: dir, NO_COLOR: '1' });
  const o = JSON.parse(r.out.trim().split('\n').pop());
  eq(o.title, 'UNKNOWN is watching', 'englischer Titel fehlt bei Locale "en"');
  eq(o.flavor, 'UNKNOWN is watching you.', 'englischer Flavor-Text fehlt bei Locale "en"');
  yes(!o.hasEnField, '"_en"-Feld hätte in der gespeicherten data/actions.json nicht auftauchen dürfen');
  eq(o.bitsTitle, 'Bits Ceasefire', 'englischer Bits-Titel fehlt bei Locale "en"');
});
await t('Aktionstexte: Migration lokalisiert Prompt/Flavor, lässt einen eigenen Titel aber unberührt', async () => {
  const dir = path.join(tmp, 'i18n-migrate'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ server: { locale: 'en' } }));
  const def = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'actions.default.json'), 'utf8'));
  const old = structuredClone(def); delete old.schema;
  // Alte, deutsche Prompt/Flavor-Reste (vor dem "_en"-Feld) UND ein vom Streamer selbst
  // umbenannter Titel - genau der Fall, den eine Migration nicht überschreiben darf.
  const shift = old.actions.find((a) => a.id === 'shift_police');
  shift.title = 'Meine eigene Bezeichnung'; shift.prompt = 'Alter deutscher Text.'; shift.flavor = 'Alter Flavor.';
  delete shift.title_en; delete shift.prompt_en; delete shift.flavor_en;
  fs.writeFileSync(path.join(dir, 'actions.json'), JSON.stringify(old));
  const script = path.join(tmp, 'i18n-migrate.mjs');
  fs.writeFileSync(script, `import { loadActions } from ${JSON.stringify(path.join(ROOT, 'src', 'config.js'))}; const a = loadActions('cs2'); const s = a.byId.get('shift_police'); console.log(JSON.stringify({ title: s.title, prompt: s.prompt, flavor: s.flavor }));`);
  const r = await run(path.relative(ROOT, script), [], { ...process.env, UCC_DATA_DIR: dir, NO_COLOR: '1' });
  const o = JSON.parse(r.out.trim().split('\n').pop());
  eq(o.title, 'Meine eigene Bezeichnung', 'ein eigener Titel hätte bei der Migration nicht überschrieben werden dürfen');
  eq(o.prompt, 'Walk only for 5 seconds.', 'Prompt hätte bei Locale "en" auf Englisch migriert werden müssen');
  eq(o.flavor, '5 seconds of mandatory sneaking.', 'Flavor hätte bei Locale "en" auf Englisch migriert werden müssen');
});
await t('Overlay-Daten: Verlauf (wer hat zuletzt was ausgelöst) und Top-Einlöser nach Anzahl', async () => {
  const s = (await st()).state;
  yes(s.history.length >= 3, 'Verlauf zu kurz');
  const h = s.history[0];
  yes(h.user && h.title && h.color && h.ts > 0, 'Verlauf-Eintrag unvollständig');
  yes(s.history.every((x, i, a) => i === 0 || a[i - 1].ts >= x.ts), 'Verlauf nicht neueste zuerst');
  yes(s.hall.every((x, i, a) => i === 0 || a[i - 1].total >= x.total), 'Top-Liste nicht nach Einlösungen sortiert');
  eq(s.overlay.history, true); eq(s.overlay.top, true);
  yes(/class="panel" id="history"|id="history"/.test(fs.readFileSync(path.join(ROOT, 'web', 'overlay.html'), 'utf8')), 'Verlauf-Panel fehlt im Overlay');
});
await t('Top-Einlöser "heute" und "Neuer Platz 1": Überholen löst die Meldung genau einmal aus', async () => {
  const s0 = (await st()).state;
  yes(Array.isArray(s0.hallToday) && s0.hallToday.length >= 2, 'Rangliste "heute" fehlt');
  yes(s0.hallToday.every((x, i, a) => i === 0 || a[i - 1].total >= x.total), 'Rangliste "heute" nicht sortiert');
  eq(s0.overlay.topMode, 'both');
  const lead = s0.hallToday[0];
  const n0 = events.filter((e) => e.type === 'fx' && e.fx.type === 'newleader').length;
  await gsiPost('live');
  for (const a of ['Feuerpause', 'Shift-Polizei', 'Kein Zoom', 'Knife Time', 'Bewegungssperre']) {
    const id = await redeemFree(a, 'zed'); await done(id);
    if ((await st()).state.hallToday[0].name === 'zed') break;
  }
  const s1 = (await st()).state;
  eq(s1.hallToday[0].name, 'zed', 'zed sollte jetzt vorne liegen');
  yes(s1.hallToday[0].total > lead.total, 'Zähler stimmt nicht');
  await waitFor(() => events.filter((e) => e.type === 'fx' && e.fx.type === 'newleader').length > n0, 3000, 'newleader-Event');
  const ev = events.filter((e) => e.type === 'fx' && e.fx.type === 'newleader').pop().fx;
  eq(ev.user, 'zed'); eq(ev.prev, lead.name); eq(ev.scope, 'today');
  const n1 = events.filter((e) => e.type === 'fx' && e.fx.type === 'newleader').length;
  const id = await redeemFree('Feuerpause', 'zed').catch(() => null); if (id) await done(id).catch(() => {});
  eq(events.filter((e) => e.type === 'fx' && e.fx.type === 'newleader').length, n1, 'darf nicht erneut auslösen, wenn der Spitzenreiter gleich bleibt');
});
await t('Overlay-Skript: Syntax in Ordnung und Heute/Gesamt-Wechsel vorhanden', async () => {
  const html = fs.readFileSync(path.join(ROOT, 'web', 'overlay.html'), 'utf8');
  const js = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
  new Function(js); // wirft bei Syntaxfehler
  yes(/hallToday/.test(js) && /newleader/.test(js) && /topRotateSec/.test(js), 'Funktionen fehlen');
  yes(/on-soft/.test(js) && /reduceFlash/.test(js), 'Reduzierte-Blitz-Effekte fehlt im Overlay-Skript');
});
await t('Dashboard-Skript: Syntax in Ordnung, alle Knöpfe haben einen Klick-Handler', async () => {
  const html = dashboardSource();
  // Seit dem Design-Umschalter gibt es im <head> ein winziges zweites
  // <script>, das das gespeicherte Theme so früh wie möglich setzt (gegen Aufblitzen im falschen
  // Design) - lastIndexOf statt indexOf, damit wirklich das große Haupt-Skript am Seitenende geprüft
  // wird, nicht das kurze Kopf-Skript.
  const js = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
  new Function(js); // wirft bei Syntaxfehler
  // Jeder <button id="..."> im Markup muss im Skript auch wirklich verdrahtet sein (sonst wirkt er
  // im Dashboard wie ein funktionierendes Feature, tut aber nichts).
  const buttonIds = [...html.matchAll(/<button[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
  for (const id of buttonIds) {
    yes(new RegExp(`\\$\\('${id}'\\)\\.(onclick|addEventListener)`).test(js), `Button #${id} hat keinen Klick-Handler`);
  }
  // die GSI-Status-Ampel darf nur erscheinen, wenn das aktive Profil
  // GSI überhaupt unterstützt (kein generischer Chip für jedes Spiel).
  const chipsBlock = js.slice(js.indexOf('const chips ='), js.indexOf("$('chips').replaceChildren"));
  yes(/if\s*\(\s*s\.game\s*&&\s*s\.game\.supportsGsi\s*\)/.test(chipsBlock), 'GSI-Chip ist nicht an s.game.supportsGsi gebunden');
  yes(/\$\('gameProfile'\)/.test(js), 'Profil-Dropdown (#gameProfile) wird im Skript nicht befüllt/synchronisiert');
  // die Onboarding-Karte existiert, zeigt die Feature-Übersicht
  // und prüft die Einrichtungs-Checkliste live über dieselbe /api/checks-Route wie "Systemcheck".
  yes(/<details class="card" id="onboarding"/.test(html), 'Onboarding-Karte fehlt im Markup');
  yes(/id="onboardingFeatures"/.test(html) && /id="onboardingChecklist"/.test(html), 'Onboarding-Feature-Liste oder -Checkliste fehlt im Markup');
  yes(/onboardingFeatures.*api\('checks'\)/s.test(js) || /api\('checks'\)[\s\S]*onboardingChecklist/.test(js), 'Onboarding-Checkliste ruft /api/checks nicht ab');
});
await t('Setup-Skript: Syntax in Ordnung, jeder POST-Aufruf schickt einen Body (Methode sonst fälschlich GET)', async () => {
  // Bug aus dem ersten echten Test: api('consent') ohne zweites Argument wählte
  // in der api()-Hilfsfunktion GET statt POST (body === undefined -> 'GET'), der Server kennt aber
  // nur "POST consent" - Ergebnis: 404 "Unbekannt" direkt nach dem Setzen des Zustimmungs-Hakens.
  // Dieser Test prüft das systematisch für ALLE POST-only-Routen aus src/server.js, nicht nur für
  // consent, damit derselbe Fehler nicht an anderer Stelle erneut passieren kann.
  const html = fs.readFileSync(path.join(ROOT, 'web', 'setup.html'), 'utf8');
  const js = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
  new Function(js); // wirft bei Syntaxfehler
  const serverJs = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');
  const setupBlock = serverJs.slice(serverJs.indexOf("p.startsWith('/setup/api/')"), serverJs.indexOf('default: return json(res, 404'));
  const getRoutes = [...setupBlock.matchAll(/case 'GET ([a-z/-]+)':/g)].map((m) => m[1]);
  // Routen, die es NUR als POST gibt (z. B. "rewards" gibt es als GET *und* POST - ein Aufruf ohne
  // Body ist dort das legitime GET, deshalb hier ausgenommen; nur eindeutige POST-only-Routen
  // prüfen, sonst falscher Alarm).
  const postOnlyRoutes = [...setupBlock.matchAll(/case 'POST ([a-z/-]+)':/g)].map((m) => m[1]).filter((r) => !getRoutes.includes(r));
  yes(postOnlyRoutes.includes('consent'), 'Testdaten-Annahme falsch: "consent" sollte eine POST-only-Route sein');
  for (const route of postOnlyRoutes) {
    const calls = [...js.matchAll(new RegExp(`api\\('${route.replace(/\//g, '\\/')}'([^)]*)\\)`, 'g'))];
    yes(calls.length > 0, `Route "${route}" wird im Setup-Skript gar nicht aufgerufen`);
    for (const c of calls) yes(c[1].trim().startsWith(','), `api('${route}') ohne Body wäre fälschlich GET statt POST (genau der Fehler "Unbekannt")`);
  }
});
await t('Dashboard-Fenster: ohne Browser/Test-Modus passiert nichts, App-Suche stürzt nicht ab', async () => {
  const { openDashboard, findAppBrowser } = await import('../src/util.js');
  process.env.UCC_NO_OPEN = '1';
  eq(openDashboard('http://127.0.0.1:1/x', 'app', path.join(tmp, 'profile')), undefined);
  const p = findAppBrowser(); yes(p === null || typeof p === 'string');
});
await t('Daily Contract wird nach mehreren verschiedenen Zuschauern erfüllt', async () => {
  yes((await st()).state.contract.done, 'Contract-Status');
  yes(events.some((e) => e.type === 'fx' && e.fx.type === 'contract'), 'Contract-Event');
  yes((await st()).state.hall.length >= 3, 'Hall of Chaos');
});
await t('Dashboard-Schalter deaktiviert Aktion lokal und auf Twitch', async () => {
  const r = await api('action', { id: 'shift_police', enabled: false });
  yes(r.json.ok && !r.json.warning, `Antwort ${JSON.stringify(r.json)}`);
  yes(mock.st.rewardPatches.some((p) => p.id === rw('Shift-Polizei') && p.is_enabled === false), 'Twitch-Update fehlt');
  const id = redeem('Shift-Polizei', 'rolf'); await done(id, 'CANCELED');
  eq(await reasonOf('shift_police'), 'Aktion ist deaktiviert');
  await api('action', { id: 'shift_police', enabled: true });
});
await t('Dashboard: eigene Belohnung anlegen, umschalten und löschen (mit Twitch synchron)', async () => {
  const r1 = await api('action/add', { title: 'Mate-Roast', cost: 777, category: 'small', prompt: 'Ich roaste meinen Mate live.' });
  yes(r1.json.ok && !r1.json.warning, `Anlegen fehlgeschlagen: ${JSON.stringify(r1.json)}`);
  const id = r1.json.id;
  yes(/^custom_/.test(id), 'eigene ID erwartet');
  yes(mock.st.rewards.some((rw2) => rw2.title === 'Mate-Roast' && rw2.cost === 777), 'Belohnung wurde nicht bei Twitch angelegt');
  const s1 = await st();
  const a = s1.actions.find((x) => x.id === id);
  yes(a && a.custom && a.linked && a.enabled, 'neue Aktion fehlt/nicht verbunden im Status');
  // doppelter Titel wird abgelehnt
  const dup = await api('action/add', { title: 'Mate-Roast', cost: 10, category: 'small' });
  yes(!dup.json.ok && /Titel/.test(dup.json.error || ''), 'doppelter Titel hätte abgelehnt werden müssen');
  // löschen entfernt sie lokal und bei Twitch
  const del = await api('action/delete', { id });
  yes(del.json.ok && !del.json.warning, `Löschen fehlgeschlagen: ${JSON.stringify(del.json)}`);
  yes(!mock.st.rewards.some((rw2) => rw2.title === 'Mate-Roast'), 'Belohnung wurde bei Twitch nicht gelöscht');
  const s2 = await st();
  yes(!s2.actions.some((x) => x.id === id), 'gelöschte Aktion steht noch im Status');
  // mitgelieferte Aktionen lassen sich nicht löschen
  const protectedDel = await api('action/delete', { id: 'shift_police' });
  yes(!protectedDel.json.ok && /gelöscht/.test(protectedDel.json.error || ''), 'mitgelieferte Aktion hätte geschützt sein müssen');
  // Regressionstest für einen beim Testen der Warteschlange gefundenen Bug: eine abgelehnte Löschung
  // (geschützt) darf die Twitch-Belohnung NICHT trotzdem entfernen - sonst bleibt die Aktion lokal
  // bestehen, aber ohne zugehörige Belohnung auf Twitch ("verwaist").
  yes(mock.st.rewards.some((r) => r.title === 'Shift-Polizei'), 'eine abgelehnte, geschützte Löschung hätte die Twitch-Belohnung nicht entfernen dürfen');
});
await t('Dashboard: Preis einer mitgelieferten Aktion ändern (mit Twitch synchron)', async () => {
  const r = await api('action/update', { id: 'movement_lock', cost: 999 });
  yes(r.json.ok && !r.json.warning, `Preisänderung fehlgeschlagen: ${JSON.stringify(r.json)}`);
  yes(mock.st.rewardPatches.some((p) => p.id === rw('Bewegungssperre') && p.cost === 999), 'Twitch-Preisupdate fehlt');
  eq((await st()).actions.find((a) => a.id === 'movement_lock').cost, 999);
  const bad = await api('action/update', { id: 'movement_lock', cost: 0 });
  yes(!bad.json.ok, 'Preis 0 hätte abgelehnt werden müssen');
  await api('action/update', { id: 'movement_lock', cost: 350 }); // zurücksetzen
});
await t('Zugriffsregeln pro Aktion: nur die passende Rolle löst aus, andere werden mit klarem Grund erstattet', async () => {
  // Validierung: unbekannte Zugriffsregel wird abgelehnt, bei Kanalpunkten UND bei Bits.
  yes(!(await api('action/access', { id: 'movement_lock', access: 'admin' })).json.ok, 'unbekannte Zugriffsregel hätte abgelehnt werden müssen');
  yes(!(await api('bits/action/access', { id: 'bits_jump_spam', access: 'admin' })).json.ok, 'unbekannte Zugriffsregel (Bits) hätte abgelehnt werden müssen');

  // Kanalpunkte-Aktion auf "nur Moderatoren" einschränken.
  const set = await api('action/access', { id: 'movement_lock', access: 'moderator' });
  yes(set.json.ok, `Zugriffsregel speichern fehlgeschlagen: ${JSON.stringify(set.json)}`);
  eq((await st()).actions.find((a) => a.id === 'movement_lock').access, 'moderator', 'Zugriffsregel fehlt im Status');

  try {
    // Normaler Zuschauer ohne Mod-Rolle: Einlösung wird erstattet, mit eindeutigem Grund (nicht
    // "Aktion deaktiviert" oder einem der anderen bestehenden Gründe).
    const id1 = redeem('Bewegungssperre', 'normalo');
    await done(id1, 'CANCELED');
    eq(await reasonOf('movement_lock'), 'Nur für Moderatoren', 'falscher/kein Erstattungsgrund bei fehlender Rolle');

    // Rolle für einen ANDEREN Zuschauer VOR dessen erster Einlösung setzen (nicht denselben Nutzer
    // mittendrin umschalten): checkAccess() cacht eine Rollenabfrage pro Nutzer für mehrere Minuten
    // (ACCESS_CACHE_MS) - bei "normalo" wurde oben bereits "kein Moderator" eingetragen und bliebe
    // trotz Rollenänderung noch eine Weile stehen. Ein frischer Nutzer hat noch keinen Cache-Eintrag.
    mock.setRole('u_modtester', 'moderator', true);
    const id2 = redeem('Bewegungssperre', 'modtester');
    await done(id2, 'FULFILLED');

    // Ein Bits-Cheer eines NICHT-privilegierten Zuschauers auf eine "nur VIPs"-Bits-Stufe wird
    // ebenfalls abgelehnt (kein DB-Eintrag bei Bits, aber der Reject-Grund landet im Log).
    const bitsSet = await api('bits/action/access', { id: 'bits_jump_spam', access: 'vip' });
    yes(bitsSet.json.ok, `Zugriffsregel (Bits) speichern fehlgeschlagen: ${JSON.stringify(bitsSet.json)}`);
    const before = srvOut.length;
    mock.cheer({ bits: 100, user: 'keinvip' });
    await waitFor(() => srvOut.slice(before).includes('Nur für VIPs'), 6000, 'Bits-Cheer ohne VIP-Rolle wurde nicht mit dem richtigen Grund abgelehnt');
    // Auch hier ein frischer Nutzer statt desselben, aus demselben Cache-Grund wie oben.
    mock.setRole('u_vipspender', 'vip', true);
    mock.cheer({ bits: 100, user: 'vipspender' });
    await waitFor(async () => (await st()).recent.find((x) => x.action_id === 'bits_jump_spam' && x.user_name === 'vipspender')?.status === 'done', 6000, 'bits_jump_spam (mit VIP-Rolle) -> done');
  } finally {
    mock.setRole('u_modtester', 'moderator', false);
    mock.setRole('u_vipspender', 'vip', false);
    await api('action/access', { id: 'movement_lock', access: 'everyone' });
    await api('bits/action/access', { id: 'bits_jump_spam', access: 'everyone' });
  }
});
await t('Warteschlangen-Politik: schnelle Spur für Overlay-Effekte, konfigurierbare Länge, Warten bei voller Schlange', async () => {
  await waitFor(async () => { const s = await st(); return s.state.queue.length === 0 && !s.state.current; }, 6000, 'Warteschlange/laufender Effekt vom vorherigen Test wurden nicht rechtzeitig leer/fertig');

  // Schnelle Spur: eine reine Overlay-Meldung ("Routenwechsel", kein Tastendruck) läuft parallel zu
  // einer gerade laufenden, echten Tasten-Aktion ("Crosshair unsichtbar", länger laufend) - fertig,
  // ohne auf deren Ende zu warten, und ohne die Haupt-Warteschlange zu belegen.
  const busyId = redeem('Crosshair unsichtbar', 'buylocker');
  await waitFor(async () => (await st()).state.current?.user === 'buylocker', 3000, 'Tasten-Aktion ist nicht rechtzeitig "current" geworden');
  const fastId = redeem('Routenwechsel', 'fastlaner');
  await done(fastId, 'FULFILLED');
  yes(status(busyId) !== 'FULFILLED', 'die echte Tasten-Aktion hätte an dieser Stelle noch nicht fertig sein dürfen (sonst beweist der Test die parallele Spur nicht)');
  await done(busyId, 'FULFILLED');

  try {
    // Hinweis zur Testumgebung: der Testaufbau setzt "Routenwechsel" (route_change) absichtlich auf
    // die Kategorie "strong" um (mit einer sehr langen Testkategorie-Cooldownzeit), um dessen EIGENEN
    // Cooldown an anderer Stelle gezielt zu testen - das gilt für den Rest des gesamten Testlaufs.
    // "Routenwechsel" oben läuft deshalb jetzt über die "strong"-Kategorie-Cooldown mit, die danach
    // erst abklingen muss, bevor andere "strong"-Aktionen (z. B. im Effekt-Baukasten-Test gleich
    // danach) wieder zuverlässig auslösen - siehe sleep im finally unten.
    // Validierung der Warteschlangen-Politik.
    yes(!(await api('queuepolicy', { maxQueue: 0, queueWaitSec: 0 })).json.ok, 'maxQueue=0 hätte abgelehnt werden müssen');
    yes(!(await api('queuepolicy', { maxQueue: 3, queueWaitSec: 999 })).json.ok, 'queueWaitSec=999 hätte abgelehnt werden müssen');

    // Konfigurierbare Länge + "sofort erstatten" (Standard): bei maxQueue=1 passen "current" plus
    // ein wartender Platz - der übernächste wird sofort mit einem klaren, eigenen Grund erstattet.
    let set = await api('queuepolicy', { maxQueue: 1, queueWaitSec: 0 });
    yes(set.json.ok, `Warteschlangen-Politik speichern fehlgeschlagen: ${JSON.stringify(set.json)}`);
    const busy2 = redeem('Shift-Polizei', 'busy2user');
    await waitFor(async () => (await st()).state.current?.user === 'busy2user', 3000, 'busy2 ist nicht rechtzeitig "current" geworden');
    const queued2 = redeem('UNKNOWN entdeckt dich', 'queued2user');
    await waitFor(async () => (await st()).state.queue.length === 1, 3000, 'queued2 hätte die Warteschlange füllen müssen');
    const overflow2 = redeem('Feuerpause', 'overflow2user');
    await done(overflow2, 'CANCELED');
    eq(await reasonOf('ceasefire'), 'Warteschlange ist voll', 'falscher/kein Grund bei voller Warteschlange (sofort erstatten)');
    await done(queued2, 'FULFILLED');
    await done(busy2, 'FULFILLED');
    await sleep(2600); // "small"-Cooldown abklingen lassen, bevor unten erneut "small"-Aktionen verwendet werden

    // Warten bei voller Schlange, Wartezeit reicht: die aktuell laufende Aktion wird rechtzeitig
    // fertig, die wartende Einlösung kommt dadurch doch noch durch statt erstattet zu werden.
    set = await api('queuepolicy', { maxQueue: 1, queueWaitSec: 30 });
    yes(set.json.ok, `Warteschlangen-Politik (warten) speichern fehlgeschlagen: ${JSON.stringify(set.json)}`);
    const busy3 = redeem('Sprung-Spam', 'busy3user');
    await waitFor(async () => (await st()).state.current?.user === 'busy3user', 3000, 'busy3 ist nicht rechtzeitig "current" geworden');
    const queued3 = redeem('Ducken-Spam', 'queued3user');
    await waitFor(async () => (await st()).state.queue.length === 1, 3000, 'queued3 hätte die Warteschlange füllen müssen');
    const waitingId = redeem('UNKNOWN entdeckt dich', 'waiting3user'); // trifft auf volle Schlange, wartet laut Politik
    await done(waitingId, 'FULFILLED');
    await done(queued3, 'FULFILLED');
    await done(busy3, 'FULFILLED');
    await sleep(2600);

    // Warten bei voller Schlange, Wartezeit reicht NICHT: ein ANDERER, eigener Erstattungsgrund als
    // beim sofortigen "voll"-Fall oben - der Zuschauer soll nicht denken, sein Klick sei einfach verschwunden.
    set = await api('queuepolicy', { maxQueue: 1, queueWaitSec: 1 }); // real(1000ms) in Tests ~20ms - viel zu kurz
    yes(set.json.ok, `Warteschlangen-Politik (kurz) speichern fehlgeschlagen: ${JSON.stringify(set.json)}`);
    const busy4 = redeem('Scoreboard-Sicht', 'busy4user');
    await waitFor(async () => (await st()).state.current?.user === 'busy4user', 3000, 'busy4 ist nicht rechtzeitig "current" geworden');
    const queued4 = redeem('Feuerpause', 'queued4user');
    await waitFor(async () => (await st()).state.queue.length === 1, 3000, 'queued4 hätte die Warteschlange füllen müssen');
    const tooLateId = redeem('Shift-Polizei', 'toolate4user');
    await done(tooLateId, 'CANCELED');
    eq(await reasonOf('shift_police'), 'Warteschlange war zu lange voll', 'falscher/kein Grund nach abgelaufener Wartezeit');
    await done(queued4, 'FULFILLED');
    await done(busy4, 'FULFILLED');
  } finally {
    await api('queuepolicy', { maxQueue: 3, queueWaitSec: 0 }); // Standard wiederherstellen
    await sleep(20500); // "strong"-Testkategorie-Cooldown (siehe Hinweis oben) sicher abklingen lassen
  }
});
await t('Dashboard: eigene Belohnung mit Effekt-Vorlage (echter Spiel-Effekt, kein Overlay-Dummy)', async () => {
  const r1 = await api('action/add', { title: 'Bewegungssperre VIP', cost: 1500, category: 'medium', templateId: 'movement_lock' });
  yes(r1.json.ok, `Anlegen mit Vorlage fehlgeschlagen: ${JSON.stringify(r1.json)}`);
  const s = await st();
  const a = s.actions.find((x) => x.id === r1.json.id);
  yes(a && a.linked, 'Vorlagen-Aktion fehlt/nicht verbunden');
  const id = redeem('Bewegungssperre VIP', 'nina');
  await done(id, 'FULFILLED'); // echter Effekt (wie Bewegungssperre) läuft statt nur Overlay-Meldung
  await api('action/delete', { id: r1.json.id });
});
await t('Dashboard: Effekt-Baukasten erzeugt für jeden Typ einen echten, lauffähigen Effekt', async () => {
  const cases = [
    { title: 'Sprung sperren (eigen)', mode: 'block', key: 'jump', ms: 2000, category: 'small' },
    { title: 'Ducken halten (eigen)', mode: 'hold', key: 'duck', ms: 2000, category: 'medium' },
    { title: 'Inspizieren-Spam (eigen)', mode: 'spam', key: 'inspect', ms: 1000, intervalMs: 150, category: 'strong' },
    { title: 'Links/Rechts tauschen (eigen)', mode: 'swap', key: 'left', key2: 'right', ms: 2000, category: 'medium' },
  ];
  // Verschiedene Stufen je Fall, nicht nur "small" — sonst würde dasselbe Test-Zuschauer-Limit
  // (hier in Tests auf 2 gesetzt) schon beim dritten Fall fälschlich alles weitere erstatten.
  for (const c of cases) {
    const r = await api('action/add', { title: c.title, cost: 123, category: c.category, builder: c });
    yes(r.json.ok && !r.json.warning, `Baukasten "${c.mode}" fehlgeschlagen: ${JSON.stringify(r.json)}`);
    const s = await st();
    const a = s.actions.find((x) => x.id === r.json.id);
    yes(a && a.linked, `Baukasten-Aktion "${c.mode}" fehlt/nicht verbunden`);
    const id = redeem(c.title, 'builderfan');
    await done(id, 'FULFILLED');
    await api('action/delete', { id: r.json.id });
  }
  // ungültige Baukasten-Eingaben werden abgelehnt, nicht stillschweigend als Overlay-Dummy gespeichert
  const badKey = await api('action/add', { title: 'Böse Taste', cost: 100, category: 'small', builder: { mode: 'block', key: 'xhOff', ms: 1000 } });
  yes(!badKey.json.ok, 'interne Bind-Taste hätte im Baukasten abgelehnt werden müssen');
  const badSwap = await api('action/add', { title: 'Böser Tausch', cost: 100, category: 'small', builder: { mode: 'swap', key: 'primary', key2: 'secondary', ms: 1000 } });
  yes(!badSwap.json.ok, 'Tauschen von Nicht-Bewegungstasten hätte abgelehnt werden müssen');
});
await t('Dashboard: freier Sequenz-Builder verkettet mehrere Bausteine, deckelt Anzahl/Gesamtdauer', async () => {
  const s0 = await st();
  yes(s0.builder.maxSteps >= 2, 'maxSteps sollte im Status stehen und mehr als einen Schritt erlauben');
  yes(s0.builder.maxTotalMs > 0, 'maxTotalMs sollte im Status stehen');

  // Eine echte Mehrschritt-Sequenz: Springen sperren, danach Ducken halten - läuft nacheinander ab.
  const seq = {
    title: 'Sprung dann Ducken (Sequenz)', cost: 150, category: 'medium',
    builder: { steps: [
      { mode: 'block', key: 'jump', ms: 1000 },
      { mode: 'hold', key: 'duck', ms: 1000 },
    ] },
  };
  const r = await api('action/add', seq);
  yes(r.json.ok && !r.json.warning, `Sequenz-Baukasten fehlgeschlagen: ${JSON.stringify(r.json)}`);
  const sAfter = await st();
  const a = sAfter.actions.find((x) => x.id === r.json.id);
  yes(a && a.linked, 'Sequenz-Aktion fehlt/nicht verbunden');
  const id = redeem(seq.title, 'sequenzfan');
  await done(id, 'FULFILLED');
  await api('action/delete', { id: r.json.id });

  // Bremse 1: zu viele Bausteine in einer Sequenz werden abgelehnt.
  const tooManySteps = Array.from({ length: 20 }, () => ({ mode: 'hold', key: 'use', ms: 500 }));
  const badCount = await api('action/add', { title: 'Zu viele Schritte', cost: 100, category: 'small', builder: { steps: tooManySteps } });
  yes(!badCount.json.ok, 'Eine Sequenz mit zu vielen Bausteinen hätte abgelehnt werden müssen');

  // Bremse 2: die Gesamtdauer über alle Bausteine hinweg ist gedeckelt, auch wenn jeder einzelne
  // Baustein für sich erlaubt wäre.
  const tooLong = Array.from({ length: 8 }, () => ({ mode: 'hold', key: 'use', ms: 60000 }));
  const badDuration = await api('action/add', { title: 'Zu lange Sequenz', cost: 100, category: 'small', builder: { steps: tooLong } });
  yes(!badDuration.json.ok, 'Eine Sequenz mit zu hoher Gesamtdauer hätte abgelehnt werden müssen');

  // Ein kaputter Baustein in der Sequenz (interne Bind-Taste) lässt die ganze Sequenz scheitern,
  // nicht nur den einen Schritt - kein halb gültiges Ergebnis wird gespeichert.
  const badStep = await api('action/add', { title: 'Kaputter Schritt in Sequenz', cost: 100, category: 'small', builder: { steps: [{ mode: 'hold', key: 'duck', ms: 500 }, { mode: 'block', key: 'xhOff', ms: 500 }] } });
  yes(!badStep.json.ok, 'Eine Sequenz mit einem ungültigen Baustein hätte abgelehnt werden müssen');
});
await t('Bits: Cheer löst die höchste passende Stufe aus (keine Mehrfachauslösung pro Cheer)', async () => {
  const before = (await st()).state.queue.length;
  mock.cheer({ bits: 50, user: 'kleinspender' }); // unter der niedrigsten Schwelle (100) -> nichts passiert
  await sleep(500);
  eq((await st()).state.queue.length, before, 'zu wenig Bits hätten nichts auslösen dürfen');
  mock.cheer({ bits: 250, user: 'mittelspender' }); // erreicht 100er-Stufe, nicht die 300er -> höchste passende (100) gewinnt
  await waitFor(async () => (await st()).recent.find((r) => r.action_id === 'bits_jump_spam' && r.user_name === 'mittelspender')?.status === 'done', 6000, 'bits_jump_spam -> done');
});
await t('Bits: eigene Stufe anlegen, Schwelle ändern, umschalten und löschen', async () => {
  const r1 = await api('bits/action/add', { title: 'Bits-VIP-Chaos', cost: 2000, templateId: 'bits_jump_spam' });
  yes(r1.json.ok, `Anlegen fehlgeschlagen: ${JSON.stringify(r1.json)}`);
  const id = r1.json.id;
  yes(/^bits_custom_/.test(id), 'eigene Bits-ID erwartet');
  let s = await st();
  yes(s.bitsActions.some((a) => a.id === id && a.cost === 2000 && a.enabled), 'neue Bits-Stufe fehlt im Status');
  // doppelter Titel wird abgelehnt
  const dup = await api('bits/action/add', { title: 'Bits-VIP-Chaos', cost: 10 });
  yes(!dup.json.ok && /Titel/.test(dup.json.error || ''), 'doppelter Titel hätte abgelehnt werden müssen');
  // Schwelle ändern
  const upd = await api('bits/action/update', { id, cost: 3000 });
  yes(upd.json.ok, `Schwellenänderung fehlgeschlagen: ${JSON.stringify(upd.json)}`);
  eq((await st()).bitsActions.find((a) => a.id === id).cost, 3000);
  // umschalten
  yes((await api('bits/action', { id, enabled: false })).json.ok);
  yes(!(await st()).bitsActions.find((a) => a.id === id).enabled, 'Stufe hätte deaktiviert sein müssen');
  // löschen
  const del = await api('bits/action/delete', { id });
  yes(del.json.ok, `Löschen fehlgeschlagen: ${JSON.stringify(del.json)}`);
  s = await st();
  yes(!s.bitsActions.some((a) => a.id === id), 'gelöschte Bits-Stufe steht noch im Status');
  // mitgelieferte Bits-Stufen lassen sich nicht löschen
  const protectedDel = await api('bits/action/delete', { id: 'bits_jump_spam' });
  yes(!protectedDel.json.ok && /gelöscht/.test(protectedDel.json.error || ''), 'mitgelieferte Bits-Stufe hätte geschützt sein müssen');
});
await t('Dashboard: Overlay-Einstellungen (Farbe, Verlauf/Top, Zähler) werden übernommen', async () => {
  const r = await api('overlay', { accent: '#00F0FF', sound: false, history: true, top: false, historyCount: 8, topCount: 3, topMode: 'today', topRotateSec: 20 });
  yes(r.json.ok, `Overlay-Speichern fehlgeschlagen: ${JSON.stringify(r.json)}`);
  const s = await st();
  eq(s.state.accent, '#00F0FF'); eq(s.state.sound, false);
  eq(s.state.overlay.history, true); eq(s.state.overlay.top, false);
  eq(s.state.overlay.historyCount, 8); eq(s.state.overlay.topCount, 3);
  eq(s.state.overlay.topMode, 'today'); eq(s.state.overlay.topRotateSec, 20);
  const bad = await api('overlay', { accent: 'not-a-color' });
  yes(!bad.json.ok, 'ungültige Farbe hätte abgelehnt werden müssen');
  // Reduzierte Blitz-Effekte (Fotosensibilität)
  yes((await api('overlay', { reduceFlash: true })).json.ok);
  eq((await st()).state.overlay.reduceFlash, true);
  await api('overlay', { accent: '#B026FF', sound: true, history: true, top: true, historyCount: 5, topCount: 5, topMode: 'both', topRotateSec: 12, reduceFlash: false }); // zurücksetzen
});
await t('Dashboard: Overlay-Layout (Drag & Drop) wird übernommen, validiert und zurückgesetzt', async () => {
  const r = await api('overlay/layout', { layout: { chaos: { x: 10, y: 20 }, queue: { x: 70.25, y: 5 } } });
  yes(r.json.ok, `Layout-Speichern fehlgeschlagen: ${JSON.stringify(r.json)}`);
  const s = await st();
  eq(s.state.overlay.layout.chaos.x, 10); eq(s.state.overlay.layout.chaos.y, 20);
  eq(s.state.overlay.layout.queue.x, 70.3); // auf eine Nachkommastelle gerundet
  yes(!s.state.overlay.layout.hall, 'nicht gesetztes Panel sollte fehlen (bleibt bei CSS-Standardposition)');
  const badPanel = await api('overlay/layout', { layout: { nope: { x: 1, y: 1 } } });
  yes(!badPanel.json.ok, 'unbekannte Panel-ID hätte abgelehnt werden müssen');
  const badRange = await api('overlay/layout', { layout: { chaos: { x: 200, y: 20 } } });
  yes(!badRange.json.ok, 'Position außerhalb 0-100 hätte abgelehnt werden müssen');

  // Größe (scale), getrennt von der Position oben, aber
  // in derselben layout-Struktur - optional, Standard 1 (unsichtbar/nicht gesetzt), 0.5-2.0.
  const withScale = await api('overlay/layout', { layout: { chaos: { x: 10, y: 20, scale: 1.456 }, queue: { x: 70, y: 5 } } });
  yes(withScale.json.ok, `Layout mit Größe speichern fehlgeschlagen: ${JSON.stringify(withScale.json)}`);
  const s2 = await st();
  eq(s2.state.overlay.layout.chaos.scale, 1.46, 'Größe wird nicht auf zwei Nachkommastellen gerundet'); // auf zwei Nachkommastellen gerundet
  yes(s2.state.overlay.layout.queue.scale === undefined, 'ohne angegebene Größe hätte kein scale-Feld gesetzt werden dürfen');
  const badScale = await api('overlay/layout', { layout: { chaos: { x: 10, y: 20, scale: 5 } } });
  yes(!badScale.json.ok, 'Größe außerhalb 0.5-2.0 hätte abgelehnt werden müssen');

  const reset = await api('overlay/layout', { layout: {} });
  yes(reset.json.ok, 'Zurücksetzen fehlgeschlagen');
  eq(Object.keys((await st()).state.overlay.layout).length, 0);
});
await t('Dashboard: Systemcheck-Knopf liefert echte Prüfungen', async () => {
  const r = await api('checks');
  yes(r.json.checks?.length > 0, 'keine Prüfungen zurückgegeben');
  yes(r.json.checks.every((c) => ['ok', 'warn', 'fail'].includes(c.level) && c.label), 'Prüfung ohne gültiges Format');
  yes(r.json.checks.some((c) => /Twitch-Login gültig/.test(c.label)), 'Twitch-Login-Check fehlt');
  yes(r.json.checks.some((c) => c.level === 'ok' && /Zustimmung zur Eigenverantwortung gegeben/.test(c.label)), 'Zustimmungs-Check fehlt im Systemcheck');
});
await t('Dashboard: Diagnose-Export enthält Systemstatus, aber keine Geheimnisse', async () => {
  const r = await api('diagnostics');
  yes(r.json.product?.version && r.json.system?.node && Array.isArray(r.json.checks), 'Diagnose-Grundgerüst fehlt');
  yes(typeof r.json.actions.total === 'number' && typeof r.json.actions.linked === 'number', 'Aktions-Zusammenfassung fehlt');
  const text = JSON.stringify(r.json);
  for (const secret of [cfg.server.adminToken, cfg.server.gsiToken, mock.st.accessToken, mock.st.refreshToken]) {
    yes(!text.includes(secret), `Geheimnis in der Diagnose-Datei: ${secret.slice(0, 4)}…`);
  }
});
await t('Fehlerbericht-Knopf: bündelt Freitext, Protokoll und aktive Konfiguration, ohne Geheimnisse', async () => {
  const r = await api('report', { note: 'Overlay blieb beim Routenwechsel kurz stehen.' });
  yes(r.json.product?.version && r.json.system?.node && Array.isArray(r.json.checks), 'Diagnose-Grundgerüst fehlt im Fehlerbericht');
  eq(r.json.note, 'Overlay blieb beim Routenwechsel kurz stehen.', 'Freitextfeld fehlt oder falsch im Fehlerbericht');
  yes(Array.isArray(r.json.recentLog) && r.json.recentLog.length > 0, 'Protokoll-Zeilen fehlen im Fehlerbericht');
  yes(r.json.config?.game && r.json.config?.keys && r.json.config?.engine, 'aktive Konfiguration fehlt im Fehlerbericht');
  yes(r.json.config.game.cs2CfgDir === undefined, 'maschinenspezifischer CS2-Ordnerpfad hätte nicht im Fehlerbericht stehen dürfen');
  eq(Object.keys(r.json.config.server || {}).sort().join(','), 'dashboardMode,locale', 'Server-Teil des Fehlerberichts sollte nur unkritische Einstellungen enthalten');
  const text = JSON.stringify(r.json);
  for (const secret of [cfg.server.adminToken, cfg.server.gsiToken, mock.st.accessToken, mock.st.refreshToken]) {
    yes(!text.includes(secret), `Geheimnis im Fehlerbericht: ${secret.slice(0, 4)}…`);
  }
  // Ohne Freitext bleibt note ein leerer String statt "undefined" im JSON.
  const r2 = await api('report', {});
  eq(r2.json.note, '', 'ohne Freitext sollte note ein leerer String sein');
});
await t('Absturzsicheres Loggen: ein unbehandelter Fehler landet trotzdem vollständig im Protokoll', async () => {
  // Eigene, frische Kopie von Umgebung A (schon vollständig eingerichtet - Zustimmung, Twitch-Login,
  // Belohnungen) statt eines neuen Einrichtungs-Assistenten, nur um server.js direkt mit dem
  // Test-Absturz-Schalter zu starten.
  const crashDir = path.join(tmp, 'crash');
  fs.cpSync(A.data, path.join(crashDir, 'data'), { recursive: true });
  const home = path.join(crashDir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const crashCfgFile = path.join(crashDir, 'data', 'config.json');
  const crashCfg = JSON.parse(fs.readFileSync(crashCfgFile, 'utf8'));
  crashCfg.server.port = 20000 + Math.floor(Math.random() * 20000); // eigener Port, Env A läuft parallel weiter
  fs.writeFileSync(crashCfgFile, JSON.stringify(crashCfg, null, 2));
  const env = { ...process.env, ...mock.env, HOME: home, UCC_DATA_DIR: path.join(crashDir, 'data'), UCC_NO_OPEN: '1', NO_COLOR: '1', UCC_BRIDGE: 'mock', UCC_TEST_CRASH: '1' };
  const r = await run('src/server.js', [], env, '', 8000);
  yes(r.code !== 0, `Testabsturz hätte den Prozess beenden müssen (Exit-Code ${r.code}, Ausgabe:\n${r.out.slice(-800)})`);
  const log = fs.readFileSync(path.join(crashDir, 'data', 'ucc.log'), 'utf8');
  yes(/Unbehandelter Absturz: Error: Testabsturz \(UCC_TEST_CRASH\)/.test(log), `Absturz-Zeile fehlt im Protokoll:\n${log.slice(-500)}`);
});
await t('Update-Prüfung: Versionen mit Beta-Teil richtig vergleichen; installierte Version aus Build-Kennung', async () => {
  const { compareVersions, installedVersion, isPrerelease } = await import('../src/update-check.js');
  yes(compareVersions('1.2.0', '1.1.9') > 0); yes(compareVersions('v2.0.0', '1.9.9') > 0);
  eq(compareVersions('1.0.0', '1.0.0'), 0); yes(compareVersions('1.0.0', '1.0.1') < 0);
  yes(compareVersions('1.0.0', '1.0.0-beta.9') > 0, 'fertig > beta');
  yes(compareVersions('1.0.0-beta.2', '1.0.0-beta.1') > 0); yes(compareVersions('1.0.0-beta.10', '1.0.0-beta.9') > 0, 'Zahlen, nicht Text');
  yes(compareVersions('1.0.0-rc.1', '1.0.0-beta.3') > 0); yes(compareVersions('1.1.0-beta.1', '1.0.0') > 0);
  eq(installedVersion('1.0.0', { build: 'beta.1' }), '1.0.0-beta.1');
  eq(installedVersion('1.0.0', { build: 's12-20261116' }), '1.0.0', 'Test-Builds zählen nicht als Beta');
  eq(installedVersion('1.0.0', null), '1.0.0');
  yes(isPrerelease('1.0.0-beta.1') && !isPrerelease('1.0.0'));
});
await t('Update-Prüfung: richtiges Release je Kanal, nur mit Klick, außerhalb der installierten Windows-Version nur Link', async () => {
  gh.releases = [ghRelease('v9.0.0-beta.1', true), ghRelease('v9.1.0', false), ghRelease('v9.2.0-beta.1', true)];
  let r = (await api('update/channel', { channel: 'stable' })).json;
  eq(JSON.stringify([r.latest, r.newer, r.channel, r.installable]), '["9.1.0",true,"stable",true]');
  yes(!('setup' in r) && !('sums' in r), 'Download-Adressen gehen nicht ans Dashboard');
  r = (await api('update/channel', { channel: 'beta' })).json;
  eq(r.latest, '9.2.0-beta.1', 'Beta-Kanal bietet die neueste Vorabversion an');
  eq((await api('update/channel', { channel: 'nightly' })).status, 400);
  const hits = gh.hits;
  await api('update-check'); await api('update-check');
  eq(gh.hits, hits, 'innerhalb von 10 Minuten nicht nochmal bei GitHub gefragt');
  const inst = await api('update/install', {});
  eq(inst.status, 409, 'hier (kein installiertes Windows) wird nichts installiert');
  eq(inst.json.reason, 'not_windows');
  eq((await api('update/channel', { channel: 'auto' })).json.channelSetting, 'auto');
});
await t('Update-Download: Prüfsumme muss stimmen, nur Adressen aus dem eigenen Repo', async () => {
  const { downloadVerified, installInfo } = await import('../src/update-check.js');
  const dir = path.join(tmp, 'upd');
  const info = { setup: { name: 'ChaosCore-1.1.0-Setup.exe', url: `${ghBase}/dl/v1.1.0/ChaosCore-1.1.0-Setup.exe`, size: ghSetup.length }, sums: { url: `${ghBase}/dl/v1.1.0/SHA256SUMS.txt` } };
  process.env.UCC_GITHUB_DOWNLOAD = ghBase;
  gh.sums = null;
  const ok = await downloadVerified(info, 'Oliverwebdev/ChaosCore', { dir });
  eq(ok.sha256, ghSha); yes(fs.existsSync(ok.file));
  gh.sums = `${'0'.repeat(64)}  ChaosCore-1.1.0-Setup.exe\n`;
  let err = await downloadVerified(info, 'Oliverwebdev/ChaosCore', { dir: dir + '2' }).catch((e) => e.message);
  yes(/Prüfsumme stimmt nicht/.test(err), err);
  yes(!fs.existsSync(path.join(dir + '2', 'ChaosCore-1.1.0-Setup.exe')), 'falsche Datei bleibt nicht liegen');
  gh.sums = null;
  delete process.env.UCC_GITHUB_DOWNLOAD;
  err = await downloadVerified({ ...info, setup: { ...info.setup, url: 'https://evil.example/ChaosCore-1.1.0-Setup.exe' }, sums: { url: 'https://github.com/Oliverwebdev/ChaosCore/releases/download/v1.1.0/SHA256SUMS.txt' } }, 'Oliverwebdev/ChaosCore', { dir }).catch((e) => e.message);
  yes(/gehört nicht zu diesem Projekt/.test(err), err);
  err = await downloadVerified({ ...info, setup: { ...info.setup, url: 'https://github.com/someone/else/releases/download/v1/ChaosCore-1.1.0-Setup.exe' }, sums: { url: 'https://github.com/someone/else/releases/download/v1/SHA256SUMS.txt' } }, 'Oliverwebdev/ChaosCore', { dir }).catch((e) => e.message);
  yes(/gehört nicht zu diesem Projekt/.test(err), 'fremdes Repo auf github.com abgelehnt');
  // Installationsart erkennen
  const fake = path.join(tmp, 'inst'); fs.mkdirSync(path.join(fake, 'app'), { recursive: true });
  eq(installInfo(path.join(fake, 'app'), 'ChaosCore.exe', 'linux').reason, 'not_windows');
  eq(installInfo(path.join(fake, 'app'), 'ChaosCore.exe', 'win32').reason, 'not_installed');
  fs.writeFileSync(path.join(fake, 'ChaosCore.exe'), ''); fs.writeFileSync(path.join(fake, 'Uninstall.exe'), '');
  eq(installInfo(path.join(fake, 'app'), 'ChaosCore.exe', 'win32').canInstall, true);
  fs.writeFileSync(path.join(fake, 'portable.flag'), '');
  eq(installInfo(path.join(fake, 'app'), 'ChaosCore.exe', 'win32').reason, 'portable');
  const nsi = fs.readFileSync(path.join(ROOT, 'build', 'installer.nsi'), 'utf8');
  yes(/\$\{IfNot\} \$\{Silent\}\s+!insertmacro MUI_LANGDLL_DISPLAY/.test(nsi), 'stilles Update fragt nicht nach der Sprache');
  yes(/RMDir \/r "\$INSTDIR\\app"/.test(nsi), 'alte Programmdateien werden vor dem Update entfernt');
});
await t('Signierte Updates: nur mit passender Signatur installierbar, fremde Schlüssel und veränderte Prüfsummen werden abgelehnt', async () => {
  const nodeCrypto = await import('node:crypto');
  const { signSums, verifySums, parsePublicKey, publicKeyBase64 } = await import('../src/release-signature.js');
  const { downloadVerified, checkForUpdate } = await import('../src/update-check.js');
  const { readProduct } = await import('../src/product.js');
  const mine = nodeCrypto.generateKeyPairSync('ed25519');
  const other = nodeCrypto.generateKeyPairSync('ed25519');
  const pub = parsePublicKey(publicKeyBase64(mine.publicKey));
  yes(pub, 'öffentlicher Schlüssel lässt sich einlesen');
  yes(!parsePublicKey('kein schlüssel') && !parsePublicKey(nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64')), 'nur Ed25519 wird akzeptiert');
  const sums = Buffer.from(`${ghSha}  ChaosCore-1.1.0-Setup.exe\n`);
  const sig = signSums(sums, mine.privateKey);
  yes(verifySums(sums, sig, [pub]).ok, 'eigene Signatur gültig');
  yes(!verifySums(Buffer.from(sums.toString().replace(/^./, 'f')), sig, [pub]).ok, 'veränderte Prüfsummen fallen auf');
  yes(!verifySums(sums, signSums(sums, other.privateKey), [pub]).ok, 'fremder Schlüssel fällt auf');
  yes(!verifySums(sums, 'Unsinn', [pub]).ok, 'kaputte Signaturdatei fällt auf');
  // product.json: Schlüssel werden eingelesen, Unsinn ignoriert
  const pf = path.join(tmp, 'product-keys.json');
  fs.writeFileSync(pf, JSON.stringify({ name: 'ChaosCore', releaseKeys: [publicKeyBase64(mine.publicKey), 'Quatsch'] }));
  eq(readProduct(pf).releaseKeys.length, 1);
  eq(readProduct(path.join(tmp, 'gibts-nicht.json')).releaseKeys.length, 0);

  // Update-Prüfung: ohne .sig ist ein Release bei Pflicht-Signatur noch nicht installierbar
  gh.releases = [ghRelease('v9.3.0', false, false)];
  const apiBefore = process.env.UCC_GITHUB_API;
  process.env.UCC_GITHUB_API = ghBase;
  let r = await checkForUpdate('Oliverwebdev/ChaosCore', '1.0.0', { requireSignature: true });
  yes(r.newer && !r.installable && r.awaitingSignature, `ohne Signatur nicht installierbar: ${JSON.stringify(r)}`);
  gh.releases[0].assets.push({ name: 'SHA256SUMS.txt.sig', size: 150, browser_download_url: `${ghBase}/dl/v9.3.0/SHA256SUMS.txt.sig` });
  r = await checkForUpdate('Oliverwebdev/ChaosCore', '1.0.0', { requireSignature: true });
  yes(r.installable && r.signed && r.sig?.url, 'mit Signatur installierbar');
  eq((await checkForUpdate('Oliverwebdev/ChaosCore', '1.0.0', { requireSignature: false })).installable, true, 'ohne eingetragene Schlüssel wie bisher');
  if (apiBefore === undefined) delete process.env.UCC_GITHUB_API; else process.env.UCC_GITHUB_API = apiBefore;

  // Download: Signatur wird vor dem Installer geprüft
  process.env.UCC_GITHUB_DOWNLOAD = ghBase;
  const dir = path.join(tmp, 'upd-signed');
  const info = { setup: { name: 'ChaosCore-1.1.0-Setup.exe', url: `${ghBase}/dl/v1.1.0/ChaosCore-1.1.0-Setup.exe`, size: ghSetup.length }, sums: { url: `${ghBase}/dl/v1.1.0/SHA256SUMS.txt` }, sig: { url: `${ghBase}/dl/v1.1.0/SHA256SUMS.txt.sig` } };
  try {
    gh.sums = null; gh.sig = sig;
    eq((await downloadVerified(info, 'Oliverwebdev/ChaosCore', { dir, publicKeys: [pub] })).sha256, ghSha, 'gültig signiert -> geladen');
    gh.sig = signSums(sums, other.privateKey);
    let err = await downloadVerified(info, 'Oliverwebdev/ChaosCore', { dir: dir + '2', publicKeys: [pub] }).catch((e) => e.message);
    yes(/Signatur des Updates passt nicht/.test(err), err);
    yes(!fs.existsSync(path.join(dir + '2', 'ChaosCore-1.1.0-Setup.exe')), 'bei falscher Signatur wird der Installer gar nicht erst geladen');
    // Angreifer tauscht Installer UND Prüfsumme (z. B. mit gekapertem GitHub-Konto), hat aber den Schlüssel nicht
    gh.sig = sig; gh.sums = `${'a'.repeat(64)}  ChaosCore-1.1.0-Setup.exe\n`;
    err = await downloadVerified(info, 'Oliverwebdev/ChaosCore', { dir: dir + '3', publicKeys: [pub] }).catch((e) => e.message);
    yes(/Signatur des Updates passt nicht/.test(err), err);
    err = await downloadVerified({ ...info, sig: null }, 'Oliverwebdev/ChaosCore', { dir: dir + '4', publicKeys: [pub] }).catch((e) => e.message);
    yes(/nicht signiert/.test(err), err);
  } finally {
    gh.sums = null; gh.sig = null; gh.releases = [];
    delete process.env.UCC_GITHUB_DOWNLOAD;
  }
});
await t('Signier-Werkzeug: Schlüssel mit Passwort, prüft Release-Dateien vor dem Signieren, Signatur passt', async () => {
  const { verifySums, parsePublicKey } = await import('../src/release-signature.js');
  const keyFile = path.join(tmp, 'sign', 'release-key.pem');
  const env = { ...process.env, CHAOSCORE_KEY_PASSPHRASE: 'ein-langes-test-passwort', UCC_GITHUB_API: ghBase, NO_COLOR: '1' };
  let r = await run('scripts/release-sign.mjs', ['keygen', '--key', keyFile], env);
  eq(r.code, 0, r.out);
  yes(/BEGIN ENCRYPTED PRIVATE KEY/.test(fs.readFileSync(keyFile, 'utf8')), 'privater Schlüssel ist verschlüsselt gespeichert');
  const pubB64 = r.out.match(/"releaseKeys": \["([A-Za-z0-9+/=]+)"\]/)?.[1];
  yes(pubB64 && parsePublicKey(pubB64), 'öffentlicher Schlüssel wird ausgegeben');
  eq((await run('scripts/release-sign.mjs', ['keygen', '--key', keyFile], env)).code, 1, 'vorhandener Schlüssel wird nie überschrieben');
  eq((await run('scripts/release-sign.mjs', ['sign-file', path.join(tmp, 'gibts-nicht'), '--key', keyFile], { ...env, CHAOSCORE_KEY_PASSPHRASE: 'falsch' })).code, 1);

  gh.releases = [ghRelease('v1.1.0', false, false)];
  const out = path.join(tmp, 'sign', 'SHA256SUMS.txt.sig');
  try {
    r = await run('scripts/release-sign.mjs', ['sign', 'v1.1.0', '--key', keyFile, '--yes', '--out', out], env);
    eq(r.code, 0, r.out);
    const sums = Buffer.from(`${ghSha}  ChaosCore-1.1.0-Setup.exe\n`);
    yes(verifySums(sums, fs.readFileSync(out, 'utf8'), [parsePublicKey(pubB64)]).ok, 'erzeugte Signatur ist gültig');
    // Passt eine Prüfsumme nicht zur Datei im Release, wird nicht signiert
    gh.sums = `${'b'.repeat(64)}  ChaosCore-1.1.0-Setup.exe\n`;
    r = await run('scripts/release-sign.mjs', ['sign', 'v1.1.0', '--key', keyFile, '--yes', '--out', out + '2'], env);
    yes(r.code === 1 && /NICHT signieren/.test(r.out) && !fs.existsSync(out + '2'), r.out);
    // falsches Passwort
    gh.sums = null;
    r = await run('scripts/release-sign.mjs', ['sign', 'v1.1.0', '--key', keyFile, '--yes', '--out', out + '3'], { ...env, CHAOSCORE_KEY_PASSPHRASE: 'falsch-falsch-falsch' });
    yes(r.code === 1 && /Passwort falsch/.test(r.out), r.out);
  } finally { gh.releases = []; gh.sums = null; }
  yes(/\*\.pem/.test(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')), 'Schlüsseldateien sind von Git ausgeschlossen');
});
await t('Lizenz-/Testversion-Modul: ohne Marker voll freigeschaltet, mit Marker zeitlich befristet erkannt', async () => {
  const markerFile = path.join(tmp, 'license-marker.json');
  process.env.UCC_TESTVERSION_FILE = markerFile; // vor dem allerersten Import setzen - der Pfad wird beim Laden des Moduls einmal gelesen
  const { getLicenseState, resetLicenseCache, isUnlocked } = await import('../src/license.js');

  // Ohne Marker-Datei: normale, volle Version.
  resetLicenseCache();
  let s = getLicenseState();
  yes(!s.testVersion && !s.expired, 'ohne Marker-Datei hätte es keine Testversion sein dürfen');
  yes(isUnlocked('irgendein-feature'), 'ohne Lizenz-Beschränkung sollte alles freigeschaltet sein');

  // Noch gültige Testversion.
  fs.writeFileSync(markerFile, JSON.stringify({ expiresAt: new Date(Date.now() + 3600_000).toISOString() }));
  resetLicenseCache();
  s = getLicenseState();
  yes(s.testVersion && !s.expired, 'eine noch gültige Testversion hätte nicht als abgelaufen gelten dürfen');

  // Abgelaufene Testversion.
  fs.writeFileSync(markerFile, JSON.stringify({ expiresAt: new Date(Date.now() - 3600_000).toISOString() }));
  resetLicenseCache();
  s = getLicenseState();
  yes(s.testVersion && s.expired, 'eine abgelaufene Testversion hätte als abgelaufen erkannt werden müssen');

  fs.rmSync(markerFile, { force: true });
});
await t('Testversion-Modus: eine abgelaufene Testversion verweigert den Start, ohne Daten anzufassen', async () => {
  const dir = path.join(tmp, 'license-expired');
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const markerFile = path.join(dir, 'testversion.json');
  fs.writeFileSync(markerFile, JSON.stringify({ expiresAt: new Date(Date.now() - 3600_000).toISOString() }));
  const dataDir = path.join(dir, 'data');
  const env = { ...process.env, ...mock.env, HOME: home, UCC_DATA_DIR: dataDir, UCC_TESTVERSION_FILE: markerFile, UCC_NO_OPEN: '1', NO_COLOR: '1', UCC_BRIDGE: 'mock' };
  const r = await run('src/server.js', [], env, '', 8000);
  yes(r.code !== 0, `abgelaufene Testversion hätte den Start verweigern müssen (Exit-Code ${r.code})`);
  yes(/abgelaufen/.test(r.out), `klare Meldung über den Ablauf fehlt in der Ausgabe:\n${r.out.slice(-500)}`);
  yes(!fs.existsSync(dataDir), 'eine verweigerte abgelaufene Testversion hätte keine Daten anlegen dürfen');
});
await t('Testversion-Modus: eine noch gültige Testversion startet normal und zeigt das Wasserzeichen', async () => {
  const dir = path.join(tmp, 'license-valid');
  fs.cpSync(A.data, path.join(dir, 'data'), { recursive: true });
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const markerFile = path.join(dir, 'testversion.json');
  const expiresAt = new Date(Date.now() + 3600_000).toISOString();
  fs.writeFileSync(markerFile, JSON.stringify({ expiresAt }));
  const cfgFile2 = path.join(dir, 'data', 'config.json');
  const cfg2 = JSON.parse(fs.readFileSync(cfgFile2, 'utf8'));
  const port2 = 20000 + Math.floor(Math.random() * 20000);
  cfg2.server.port = port2;
  fs.writeFileSync(cfgFile2, JSON.stringify(cfg2, null, 2));
  const env = { ...process.env, ...mock.env, HOME: home, UCC_DATA_DIR: path.join(dir, 'data'), UCC_TESTVERSION_FILE: markerFile, UCC_NO_OPEN: '1', NO_COLOR: '1', UCC_BRIDGE: 'mock' };
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/server.js')], { env, cwd: ROOT });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  try {
    await waitFor(() => /läuft\./.test(out), 10000, 'Server-Startmeldung (gültige Testversion)');
    const r = await fetch(`http://localhost:${port2}/api/status`, { headers: { 'x-admin-token': cfg2.server.adminToken } });
    const body = await r.json();
    yes(body.state?.license?.testVersion === true, `Status hätte die Testversion melden müssen: ${JSON.stringify(body.state?.license)}`);
    eq(body.state.license.expiresAt, expiresAt, 'Ablaufdatum im Status stimmt nicht mit dem Marker überein');
  } finally {
    p.kill();
  }
});
await t('Dashboard: Profil exportieren und auf anderem Stand wieder importieren', async () => {
  // Preis ändern, damit der Export danach einen erkennbaren Unterschied zur Vorlage hat
  await api('action/update', { id: 'ceasefire', cost: 777 });
  const exp = await api('profile/export', {});
  yes(exp.json.schema === 1 && exp.json.keys && exp.json.actions?.actions?.length > 0, 'Export-Grundgerüst fehlt');
  yes(!('twitch' in exp.json) && !JSON.stringify(exp.json).includes(cfg.server.adminToken), 'Export enthält Zugangsdaten');
  yes(exp.json.actions.actions.find((a) => a.id === 'ceasefire')?.cost === 777, 'geänderter Preis fehlt im Export');
  // Preis wieder ändern, dann den Export reimportieren — danach muss wieder 777 gelten
  await api('action/update', { id: 'ceasefire', cost: 150 });
  eq((await st()).actions.find((a) => a.id === 'ceasefire').cost, 150);
  const imp = await api('profile/import', exp.json);
  yes(imp.json.ok && imp.json.actionsImported, `Import fehlgeschlagen: ${JSON.stringify(imp.json)}`);
  eq((await st()).actions.find((a) => a.id === 'ceasefire').cost, 777);
  const badImport = await api('profile/import', { schema: 99 });
  yes(!badImport.json.ok, 'unbekanntes Profil-Format hätte abgelehnt werden müssen');
  await api('action/update', { id: 'ceasefire', cost: 150 }); // zurücksetzen
});
await t('Testlauf (trocken) aus dem Dashboard zeigt Overlay ohne Twitch-Aufruf', async () => {
  const before = Object.keys(mock.st.redemptionStatus).length;
  const n = events.length;
  yes((await api('test', { id: 'ceasefire', dry: true })).json.ok, 'test');
  await waitFor(() => events.slice(n).some((e) => e.type === 'fx' && e.fx.type === 'alert' && e.fx.test), 4000, 'Test-Alert');
  await sleep(300); eq(Object.keys(mock.st.redemptionStatus).length, before, 'keine Twitch-Statusänderung');
});
await t('Verbindungsabbruch: Server verbindet neu und arbeitet weiter', async () => {
  const subs = mock.st.subscriptions;
  mock.dropSockets();
  // Kanalpunkte, Bits (channel.cheer) und seit Schritt 11 auch Chat (channel.chat.message) sind
  // drei eigene, getrennte EventSub-Abos, seit Schritt 12 (Session Stats) dazu stream.online und
  // stream.offline - eine Neuverbindung meldet also fünf neue an.
  await waitFor(() => mock.st.subscriptions === subs + 5, 8000, 'Neuverbindung');
  await gsiPost('live');
  await done(redeem('Feuerpause', 'sven'));
});
await t('Preset-Metadaten (Name/Autor) landen im Export; eigener Overlay-Sound/-Bild wird hochgeladen, bedient, exportiert und wieder importiert', async () => {
  const expNamed = await api('profile/export', { name: 'Mein Chaos-Preset', author: 'Oliver' });
  eq(expNamed.json.preset?.name, 'Mein Chaos-Preset', 'Preset-Name fehlt im Export');
  eq(expNamed.json.preset?.author, 'Oliver', 'Preset-Autor fehlt im Export');
  const expUnnamed = await api('profile/export', {});
  yes(!expUnnamed.json.preset, 'ohne Name/Autor sollte kein preset-Feld entstehen');

  // Vorher: kein eigener Sound/Bild -> Status sagt das, die Auslieferungs-Route liefert 404.
  let s = await st();
  yes(!s.state.hasCustomSound && !s.state.overlay.customSound, 'vor dem Hochladen sollte kein Sound gesetzt sein');
  let r404 = await fetch(`${base}/overlay-asset/sound`);
  eq(r404.status, 404, 'ohne hochgeladenen Sound sollte die Route 404 liefern');

  // Falscher Dateityp / zu groß werden abgelehnt, ohne irgendetwas zu speichern.
  const badMime = await api('overlay/asset', { kind: 'sound', name: 'böse.exe', mime: 'application/octet-stream', dataBase64: Buffer.from('x').toString('base64') });
  yes(!badMime.json.ok, 'unerlaubter Dateityp hätte abgelehnt werden müssen');
  const tooBig = await api('overlay/asset', { kind: 'image', name: 'riesig.png', mime: 'image/png', dataBase64: Buffer.alloc(1000 * 1024, 1).toString('base64') });
  yes(!tooBig.json.ok, 'zu große Datei hätte abgelehnt werden müssen');

  // Seit wird auch der Inhalt geprüft (Dateisignatur passend zum Typ).
  const wrongContent = await api('overlay/asset', { kind: 'sound', name: 'kein-mp3.mp3', mime: 'audio/mpeg', dataBase64: Buffer.from('MZ-das-ist-kein-mp3').toString('base64') });
  yes(!wrongContent.json.ok && /passt nicht zum angegebenen Typ/.test(wrongContent.json.error || ''), 'Datei mit falschem Inhalt hätte abgelehnt werden müssen');
  // Echter Upload (klein, erfundener Rest - aber mit echter MP3-/PNG-Signatur am Anfang).
  const soundBytes = Buffer.concat([Buffer.from('ID3'), Buffer.from('-FAKE-MP3-BYTES-FOR-TEST')]);
  const up = await api('overlay/asset', { kind: 'sound', name: 'mein-sound.mp3', mime: 'audio/mpeg', dataBase64: soundBytes.toString('base64') });
  yes(up.json.ok && up.json.customSound?.name === 'mein-sound.mp3', `Sound-Upload fehlgeschlagen: ${JSON.stringify(up.json)}`);
  const imgBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('FAKE-PNG-BYTES-FOR-TEST')]);
  const upImg = await api('overlay/asset', { kind: 'image', name: 'mein-logo.png', mime: 'image/png', dataBase64: imgBytes.toString('base64') });
  yes(upImg.json.ok, `Bild-Upload fehlgeschlagen: ${JSON.stringify(upImg.json)}`);

  s = await st();
  yes(s.state.hasCustomSound && s.state.hasCustomImage, 'Status sollte jetzt beide eigenen Dateien zeigen');
  yes(s.state.overlay.customSound?.name === 'mein-sound.mp3' && s.state.overlay.customImage?.name === 'mein-logo.png', 'Dashboard-Metadaten fehlen/falsch');

  const rSound = await fetch(`${base}/overlay-asset/sound`);
  eq(rSound.status, 200, 'Sound-Route sollte jetzt 200 liefern');
  eq(rSound.headers.get('content-type'), 'audio/mpeg', 'falscher Content-Type für den Sound');
  yes((await rSound.arrayBuffer()).byteLength === soundBytes.length, 'ausgelieferte Sound-Datei stimmt nicht mit dem Upload überein');

  // Export bettet die Datei als Base64 ein - genug, um sie auf einem anderen Rechner wiederherzustellen.
  const expWithAsset = await api('profile/export', {});
  yes(expWithAsset.json.overlay.customSound?.dataBase64 && expWithAsset.json.overlay.customImage?.dataBase64, 'eingebettete Base64-Dateien fehlen im Export');

  // Entfernen funktioniert und wird sofort ausgeliefert/im Status sichtbar.
  const rm = await api('overlay/asset/remove', { kind: 'sound' });
  yes(rm.json.ok, 'Entfernen fehlgeschlagen');
  s = await st();
  yes(!s.state.hasCustomSound && s.state.hasCustomImage, 'nach dem Entfernen des Sounds sollte nur noch das Bild gesetzt sein');

  // Reimport auf denselben Stand stellt den entfernten Sound aus der eingebetteten Datei wieder her.
  const imp = await api('profile/import', expWithAsset.json);
  yes(imp.json.ok, `Import mit eingebetteten Dateien fehlgeschlagen: ${JSON.stringify(imp.json)}`);
  s = await st();
  yes(s.state.hasCustomSound && s.state.overlay.customSound?.name === 'mein-sound.mp3', 'eingebetteter Sound wurde beim Import nicht wiederhergestellt');

  // Aufräumen für nachfolgende Tests.
  await api('overlay/asset/remove', { kind: 'sound' });
  await api('overlay/asset/remove', { kind: 'image' });
});
await t('One-Click-Presets: mitgeliefertes Preset wird gelistet und übernimmt Tasten/Aktionen über den normalen Import-Pfad', async () => {
  const list = await api('presets');
  yes(Array.isArray(list.json.presets) && list.json.presets.length > 0, 'es sollte mindestens ein mitgeliefertes Preset geben');
  const classic = list.json.presets.find((p) => p.id === 'cs2-klassisch');
  yes(classic && classic.name && classic.targetGame === 'cs2', 'Preset "cs2-klassisch" fehlt oder ist unvollständig');

  await api('action/update', { id: 'ceasefire', cost: 999 }); // vom Standard abweichen, damit die Übernahme erkennbar ist
  // Vorschau (erster Klick im Dashboard): nennt die Änderung, ändert aber nichts.
  const pv = await api('preset/preview', { id: 'cs2-klassisch' });
  yes(pv.json.ok && pv.json.report.actions.changed.some((x) => x.id === 'ceasefire' && x.what.includes('cost')), `Preset-Vorschau zeigt die Preisänderung nicht: ${JSON.stringify(pv.json).slice(0, 200)}`);
  eq((await st()).actions.find((a) => a.id === 'ceasefire').cost, 999, 'die Preset-Vorschau hat schon etwas geändert');
  yes(!(await api('preset/preview', { id: '../../etc/passwd' })).json.ok, 'Vorschau für ein unbekanntes Preset hätte abgelehnt werden müssen');
  const applied = await api('preset/apply', { id: 'cs2-klassisch' });
  yes(applied.json.ok, `Preset-Übernahme fehlgeschlagen: ${JSON.stringify(applied.json)}`);
  eq((await st()).actions.find((a) => a.id === 'ceasefire').cost, 150, 'Preset sollte den Standardpreis wiederherstellen');

  const unknown = await api('preset/apply', { id: 'nicht_vorhanden' });
  yes(!unknown.json.ok, 'unbekanntes Preset hätte abgelehnt werden müssen');
});
await t('Chaos-Overload: UNKNOWN löst wirklich einen Spiel-Effekt aus, nicht nur eine Bildschirmmeldung', async () => {
  // Das Overlay verspricht beim Overload "UNKNOWN übernimmt kurz die Kontrolle" — das muss auch
  // etwas im Spiel auslösen. "Waffensteuer" (strong, 22 Chaos) per Trockentest mehrfach hochzählen,
  // bis Overload bei 100 greift. Trockentests zählen Chaos genauso wie echte Einlösungen, lösen
  // aber keine echten Tasten/Twitch-Aufrufe aus — ideal, um das deterministisch zu provozieren.
  // Wichtig: "ausgelöst" anhand des SSE-Streams (ab jetzt, Index n) prüfen, nicht am kumulierten
  // Server-Log — der könnte den Satz schon von früheren Tests im Lauf enthalten.
  const n = events.length;
  const overloaded = () => events.slice(n).some((e) => e.type === 'fx' && e.fx.type === 'overload');
  for (let i = 0; i < 8 && !overloaded(); i++) {
    for (let tries = 0; tries < 10; tries++) {
      const r = await api('test', { id: 'weapon_tax', dry: true });
      if (r.json.ok) break;
      await sleep(150); // Warteschlange noch voll (max. 3) -> kurz warten und erneut versuchen
    }
    await sleep(250); // dem Trockentest Zeit geben, durchzulaufen (simulierter Rundenablauf), bevor erneut geprüft wird
  }
  yes(overloaded(), 'Chaos-Overload wurde nicht ausgelöst');
  await waitFor(() => events.slice(n).some((e) => e.type === 'fx' && e.fx.type === 'alert' && e.fx.user === 'UNKNOWN'), 6000, 'UNKNOWN hat keinen echten Effekt ausgelöst');
  // UNKNOWN-Effekte sind keine Zuschauer-Einlösung: kein DB-Eintrag, keine Twitch-Statusänderung.
  yes(!(await st()).recent.some((r) => r.user_name === 'UNKNOWN'), 'UNKNOWN-Effekt hätte keinen Einlösungs-Eintrag erzeugen dürfen');
});
await t('Community-Ziel: eigener Name/Grundlage/feste Schwellen-Aktion, Grundlage filtert Punkte/Bits getrennt', async () => {
  // Der vorherige Test (Chaos-Overload) treibt Chaos per Trockentests absichtlich über die Schwelle
  // und kann dabei mehrere Trockentests gleichzeitig in der Warteschlange haben: der Überlauf setzt
  // Chaos zwar bei GENAU einem von ihnen auf 0 zurück, ein noch laufender zweiter/dritter Trockentest
  // kann aber danach noch etwas Chaos nachliefern, ohne selbst die (immer noch Standard-)Schwelle von
  // 100 zu erreichen - das Chaos-Meter bleibt dann bei einem Rest >0 stehen, auch wenn die
  // Warteschlange längst wieder leer ist. Deshalb NICHT nur auf eine leere Warteschlange warten,
  // sondern auf state.chaos === 0 UNTER DER NOCH UNVERÄNDERTEN Standard-Schwelle (100) - das ist
  // dort gleichbedeutend mit "wirklich 0 Rest-Chaos", bevor unten die eigene, viel kleinere Schwelle
  // (8) gesetzt wird, die sonst von genau so einem Rest sofort falsch ausgelöst würde.
  await waitFor(async () => { const s = await st(); return s.state.queue.length === 0 && !s.state.current; }, 6000, 'Warteschlange/laufender Effekt vom vorherigen Test wurden nicht rechtzeitig leer/fertig');
  await waitFor(async () => (await st()).state.chaos === 0, 15000, 'Rest-Chaos vom vorherigen Test ist nicht rechtzeitig abgeklungen (siehe decay-Timer)');
  // Validierung: kaputte Eingaben werden abgelehnt, bevor überhaupt etwas gespeichert wird.
  yes(!(await api('goal', { name: 'X', basis: 'ungueltig', thresholds: [{ value: 10 }] })).json.ok, 'ungültige Grundlage hätte abgelehnt werden müssen');
  yes(!(await api('goal', { name: 'X', basis: 'both', thresholds: [] })).json.ok, 'leere Schwellenliste hätte abgelehnt werden müssen');
  yes(!(await api('goal', { name: 'X', basis: 'both', thresholds: [{ value: 10, actionId: 'gibt_es_nicht' }] })).json.ok, 'unbekannte Aktion hätte abgelehnt werden müssen');
  const tooMany = Array.from({ length: 6 }, (_, i) => ({ value: 10 + i }));
  yes(!(await api('goal', { name: 'X', basis: 'both', thresholds: tooMany })).json.ok, 'mehr als 5 Schwellen hätten abgelehnt werden müssen');

  // Teststabilität (untersucht 2026-11-13): dieser Test schlug in rund jedem fünften Lauf mit
  // "Zeitüberschreitung: bits_jump_spam -> done" fehl. Ursache: der vorherige Test (Chaos-Overload)
  // löst beim Überlauf eine ZUFÄLLIGE Aktion aus dem Pool aus. Ist das zufällig eine Bits-Stufe,
  // setzt deren Ende die Abklingzeit der Stufe "bits" (15 s x UCC_TIME_SCALE 0,02 = 300 ms) - ein
  // Cheer in genau diesem Fenster wird korrekt mit "Cooldown läuft noch" abgewiesen, und der Test
  // wartete vergeblich. Kein Programmfehler. Deshalb vor jedem Cheer warten, bis nichts mehr läuft
  // UND die Abklingzeit sicher vorbei ist.
  const settleBits = async () => {
    const idle = async () => { const s = await st(); return s.state.queue.length === 0 && !s.state.current; };
    for (let i = 0; i < 20; i++) {
      await waitFor(idle, 8000, 'vor dem Cheer läuft noch ein Effekt');
      await sleep(450); // länger als die skalierte Bits-Abklingzeit (300 ms)
      if (await idle()) return;
    }
    throw new Error('System kam vor dem Cheer nicht zur Ruhe');
  };
  // Ab hier wird das Community-Ziel absichtlich auf sehr kleine, leicht selbst-auslösende Schwellen
  // umgestellt - in einem try/finally, damit auch bei einem fehlschlagenden Assert unten GARANTIERT
  // auf den Standard zurückgesetzt wird. Ohne das würde ein hier liegen gebliebenes, kleines
  // Schwellen-Setup ALLE folgenden Tests verseuchen (jede weitere Einlösung dieser Kategorie würde
  // die Schwelle immer wieder treffen) - genau das ist beim ersten Entwurf dieses Tests passiert.
  try {
    // Grundlage "Nur Punkte": ein Bits-Cheer darf NICHT zum Fortschritt beitragen. Ein Trockentest mit
    // exakt der konfigurierten Chaos-Menge (8, Kategorie "small") erreicht die Schwelle beim ersten Mal
    // und löst deterministisch die fest hinterlegte Aktion aus (keine zufällige Wahl aus dem Pool).
    let r = await api('goal', { name: 'Nur Punkte', basis: 'points', thresholds: [{ name: 'Nur Punkte', value: 8, actionId: 'jump_spam' }] });
    yes(r.json.ok, `Community-Ziel speichern fehlgeschlagen: ${JSON.stringify(r.json)}`);
    eq((await st()).communityGoal.name, 'Nur Punkte', 'Community-Ziel-Name fehlt im Status');

    await settleBits();
    mock.cheer({ bits: 100, user: 'nurpunktetester' }); // löst bits_jump_spam aus (Chaos 10) - darf bei basis "points" nicht zählen
    await waitFor(async () => (await st()).recent.find((x) => x.action_id === 'bits_jump_spam' && x.user_name === 'nurpunktetester')?.status === 'done', 6000, 'bits_jump_spam -> done');
    eq((await st()).state.chaos, 0, 'Bits-Cheer hätte bei basis "points" nicht zum Community-Ziel beitragen dürfen');

    let n = events.length;
    const r2 = await api('test', { id: 'jump_spam', dry: true });
    yes(r2.json.ok, `Trockentest fehlgeschlagen: ${JSON.stringify(r2.json)}`);
    await waitFor(() => events.slice(n).some((e) => e.type === 'fx' && e.fx.type === 'overload' && e.fx.name === 'Nur Punkte'), 6000, 'Community-Ziel "Nur Punkte" wurde nicht bei genau 8 Chaos erreicht');
    await waitFor(() => events.slice(n).some((e) => e.type === 'fx' && e.fx.type === 'alert' && e.fx.user === 'UNKNOWN' && e.fx.title === 'Sprung-Spam'), 6000, 'die fest konfigurierte Aktion "Sprung-Spam" wurde nicht ausgelöst');

    // Grundlage "Nur Bits": jetzt umgekehrt - ein Punkte-Trockentest darf nicht zählen, ein Bits-Cheer
    // mit exakt passender Chaos-Menge (10, Kategorie "bits") löst die feste Bits-Aktion deterministisch aus.
    r = await api('goal', { name: 'Nur Bits', basis: 'bits', thresholds: [{ name: 'Nur Bits', value: 10, actionId: 'bits_jump_spam' }] });
    yes(r.json.ok, `Community-Ziel speichern fehlgeschlagen: ${JSON.stringify(r.json)}`);

    const r3 = await api('test', { id: 'jump_spam', dry: true });
    yes(r3.json.ok, `Trockentest fehlgeschlagen: ${JSON.stringify(r3.json)}`);
    await sleep(500);
    eq((await st()).state.chaos, 0, 'Punkte-Trockentest hätte bei basis "bits" nicht zum Community-Ziel beitragen dürfen');

    n = events.length;
    await settleBits();
    mock.cheer({ bits: 100, user: 'nurbitstester' });
    await waitFor(async () => (await st()).recent.find((x) => x.action_id === 'bits_jump_spam' && x.user_name === 'nurbitstester')?.status === 'done', 6000, 'bits_jump_spam -> done');
    await waitFor(() => events.slice(n).some((e) => e.type === 'fx' && e.fx.type === 'overload' && e.fx.name === 'Nur Bits'), 6000, 'Community-Ziel "Nur Bits" wurde nicht bei genau 10 Chaos erreicht');
    await waitFor(() => events.slice(n).some((e) => e.type === 'fx' && e.fx.type === 'alert' && e.fx.user === 'UNKNOWN' && e.fx.title === 'Bits-Sprung-Spam'), 6000, 'die fest konfigurierte Bits-Aktion wurde nicht ausgelöst');
  } finally {
    // Aufräumen: Standard-Community-Ziel wiederherstellen, damit spätere Tests (u. a. Season) sich
    // weiterhin auf das Standardverhalten verlassen können. Zusätzliche Wartezeit, damit der durch
    // die Trockentests oben gesetzte Cooldown der Kategorie "small" (siehe engine.js finish()) beim
    // folgenden Season-Test (Feuerpause, ebenfalls Kategorie "small") sicher abgelaufen ist.
    const restore = await api('goal', { name: 'Chaos Overload', basis: 'both', thresholds: [{ id: 'overload', name: 'Chaos Overload', value: 100, actionId: null }] });
    yes(restore.json.ok, `Zurücksetzen des Community-Ziels fehlgeschlagen: ${JSON.stringify(restore.json)}`);
    await sleep(2600);
  }
});
await t('Season: Chaos-Score wird über echte Einlösungen gezählt, "Season beenden" hält den Spitzenreiter fest und setzt zurück', async () => {
  // Trockentests (siehe Chaos-Overload-Test) zählen hier bewusst NICHT mit (finish() schließt
  // item.test/item.system aus) - nur echte Zuschauer-Einlösungen. Die laufende Season sammelt
  // über den gesamten Testlauf hinweg, darum verlässt sich dieser Test nicht auf eine bestimmte
  // Platzierung, sondern vergleicht den Spitzenreiter VOR dem Beenden mit dem zurückgegebenen Sieger.
  await done(redeem('Feuerpause', 'sven')); // sorgt für mindestens einen frischen Eintrag in dieser Season
  let s = await st();
  yes(s.state.season.chaosHall.length > 0, 'Season-Bestenliste sollte nicht leer sein');
  yes(s.state.season.lengthDays === 7, 'Season-Standardlaufzeit sollte 7 Tage sein');
  yes(s.state.season.endsAt > Date.now(), 'Season sollte noch nicht abgelaufen sein');
  const top = s.state.season.chaosHall[0];

  const end = await api('season/end', {});
  yes(end.json.ok, `Season beenden fehlgeschlagen: ${JSON.stringify(end.json)}`);
  eq(end.json.winner.name, top.name, 'Sieger der beendeten Season stimmt nicht mit dem vorherigen Spitzenreiter überein');
  eq(end.json.winner.chaos, top.chaos, 'Chaos-Score des Siegers stimmt nicht');

  s = await st();
  eq(s.state.season.chaosHall.length, 0, 'neue Season sollte ohne Teilnehmer starten');
  yes(s.state.season.lastWinner?.name === top.name && s.state.season.lastWinner?.chaos === top.chaos, 'letzter Season-Sieger fehlt/stimmt nicht');
  yes(s.state.season.endsAt > Date.now(), 'neue Season sollte wieder eine volle Laufzeit haben');
});
await t('Dashboard-Feld für Season-Dauer: Grenzen geprüft, wirkt sofort auf die laufende Season', async () => {
  yes(!(await api('season/config', { lengthDays: 0 })).json.ok, 'zu kurze Season-Dauer hätte abgelehnt werden müssen');
  yes(!(await api('season/config', { lengthDays: 91 })).json.ok, 'zu lange Season-Dauer hätte abgelehnt werden müssen');

  const before = (await st()).state.season;
  eq(before.lengthDays, 7, 'Voraussetzung für diesen Test: Season sollte noch bei der Standardlaufzeit sein');
  const r = await api('season/config', { lengthDays: 14 });
  yes(r.json.ok && r.json.season.lengthDays === 14, 'Season-Dauer hätte auf 14 Tage geändert werden müssen');

  const after = (await st()).state.season;
  eq(after.lengthDays, 14, 'neue Season-Dauer fehlt im Status');
  // Dieselbe laufende Season (startedAt unverändert), aber mit verschobenem Enddatum - nicht erst
  // nach dem nächsten Season-Wechsel wirksam (engine.js: refreshSeasonLength()).
  eq(after.startedAt, before.startedAt, 'die Änderung hätte keine neue Season starten dürfen');
  yes(after.endsAt > before.endsAt, 'das Enddatum der laufenden Season hätte sich sofort verlängern müssen');

  await api('season/config', { lengthDays: 7 }); // zurücksetzen für nachfolgende Tests/Erwartungen
});
await t('Chat-Befehle: eigene Befehle, Abklingzeit, Validierung', async () => {
  const { CHAT_STATS_TRIGGER } = await import('../src/config.js');
  // Validierung, bevor überhaupt etwas gespeichert wird.
  yes(!(await api('chat/command/add', { trigger: '', response: 'x' })).json.ok, 'leerer Trigger hätte abgelehnt werden müssen');
  yes(!(await api('chat/command/add', { trigger: '!a b', response: 'x' })).json.ok, 'Trigger mit Leerzeichen hätte abgelehnt werden müssen');
  yes(!(await api('chat/command/add', { trigger: CHAT_STATS_TRIGGER, response: 'x' })).json.ok, 'der reservierte Statistik-Befehl hätte nicht überschrieben werden dürfen');
  yes(!(await api('chat/command/add', { trigger: '!discord', response: '' })).json.ok, 'leere Antwort hätte abgelehnt werden müssen');

  const add = await api('chat/command/add', { trigger: '!Discord', response: 'https://discord.gg/beispiel' });
  yes(add.json.ok, `Befehl anlegen fehlgeschlagen: ${JSON.stringify(add.json)}`);
  eq(add.json.command.trigger, '!discord', 'Trigger hätte klein geschrieben gespeichert werden müssen');
  yes(!(await api('chat/command/add', { trigger: '!discord', response: 'anders' })).json.ok, 'doppelter Trigger (andere Schreibweise) hätte abgelehnt werden müssen');

  // Chat erst jetzt einschalten, alle Ankündigungen aus - dieser Test prüft nur den Befehl selbst.
  await api('chat/config', { enabled: true, announceEffect: false, announceSeasonEndingSoon: false, announceSeasonWinner: false, cooldownSec: 50 });

  const before = (mock.st.chatMessages || []).length;
  mock.chat({ text: '!discord', user: 'chatfan1' });
  await waitFor(() => (mock.st.chatMessages || []).length > before, 4000, 'Antwort auf !discord');
  eq(mock.st.chatMessages[mock.st.chatMessages.length - 1], 'https://discord.gg/beispiel', 'falsche Antwort auf !discord');

  // Abklingzeit: eine sofortige zweite Auslösung desselben Befehls bleibt stumm
  // (50s Abklingzeit * UCC_TIME_SCALE 0.02 = 1s im echten Testlauf).
  const afterFirst = mock.st.chatMessages.length;
  mock.chat({ text: '!discord', user: 'chatfan2' });
  await sleep(300);
  eq(mock.st.chatMessages.length, afterFirst, 'eine zu schnelle zweite Auslösung hätte durch die Abklingzeit unterdrückt werden müssen');

  // Ein deaktivierter Befehl antwortet gar nicht mehr, unabhängig von der Abklingzeit.
  await api('chat/command/toggle', { id: add.json.command.id, enabled: false });
  await sleep(1200);
  const beforeDisabled = mock.st.chatMessages.length;
  mock.chat({ text: '!discord', user: 'chatfan3' });
  await sleep(300);
  eq(mock.st.chatMessages.length, beforeDisabled, 'ein deaktivierter Befehl hätte nicht mehr antworten dürfen');

  await api('chat/command/remove', { id: add.json.command.id });
  yes(!(await st()).chat.commands.some((c) => c.id === add.json.command.id), 'Befehl hätte entfernt werden müssen');
  yes(!(await api('chat/command/remove', { id: add.json.command.id })).json.ok, 'erneutes Entfernen eines schon gelöschten Befehls hätte fehlschlagen müssen');

  await api('chat/config', { enabled: false }); // zurücksetzen für nachfolgende Tests
});
await t('Chat: ausgelöster Effekt wird angekündigt, eingebauter "!chaosstats"-Befehl nutzt echte Zuschauerdaten', async () => {
  const { CHAT_STATS_TRIGGER } = await import('../src/config.js');
  await api('chat/config', { enabled: true, announceEffect: true, announceSeasonEndingSoon: false, announceSeasonWinner: false, cooldownSec: 0 });

  const before = (mock.st.chatMessages || []).length;
  // Erneut versuchen, falls die Einlösung ausnahmsweise genau in ein kurzes EventSub-Reconnect-
  // Fenster fällt (siehe Schritt 7: Neuverbindung ist robust, aber eine einzelne Mock-Nachricht
  // während der Umschaltung kann verloren gehen) - kein Produktfehler, nur Test-Robustheit.
  for (let i = 0; i < 3; i++) {
    try { await done(redeem('Feuerpause', 'sven')); break; }
    catch (e) { if (i === 2) throw e; }
  }
  await waitFor(() => (mock.st.chatMessages || []).length > before, 4000, 'Ankündigung im Chat nach ausgelöstem Effekt');
  const lastEffect = mock.st.chatMessages[mock.st.chatMessages.length - 1];
  yes(lastEffect.includes('sven') && lastEffect.includes('Feuerpause'), `Ankündigung sollte Zuschauer und Aktion nennen: ${lastEffect}`);

  const beforeStats = mock.st.chatMessages.length;
  mock.chat({ text: CHAT_STATS_TRIGGER, user: 'sven' });
  await waitFor(() => mock.st.chatMessages.length > beforeStats, 4000, 'Antwort auf !chaosstats');
  const reply = mock.st.chatMessages[mock.st.chatMessages.length - 1];
  yes(reply.includes('@sven') && /\d+ Aktionen/.test(reply), `Statistik-Antwort unerwartet: ${reply}`);

  // Ein Zuschauer ohne jede bisherige (erfolgreiche) Einlösung bekommt die Leer-Antwort.
  const beforeNone = mock.st.chatMessages.length;
  mock.chat({ text: CHAT_STATS_TRIGGER, user: 'niemalsgesehen', userId: 'u_niemalsgesehen_schritt11' });
  await waitFor(() => mock.st.chatMessages.length > beforeNone, 4000, 'Antwort auf !chaosstats (unbekannter Zuschauer)');
  yes(mock.st.chatMessages[mock.st.chatMessages.length - 1].includes('Noch keine Aktion'), 'unbekannter Zuschauer hätte die Leer-Antwort bekommen sollen');

  await api('chat/config', { enabled: false }); // zurücksetzen für nachfolgende Tests
});
await t('Chat: Season-Ankündigungen ("bald zu Ende" / neuer Sieger) laufen automatisch mit', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = path.join(tmp, 'chat-season');
  fs.cpSync(A.data, path.join(dir, 'data'), { recursive: true });
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const cfgFile3 = path.join(dir, 'data', 'config.json');
  const cfg3 = JSON.parse(fs.readFileSync(cfgFile3, 'utf8'));
  const port3 = 20000 + Math.floor(Math.random() * 20000);
  cfg3.server.port = port3;
  cfg3.chat = { ...cfg3.chat, enabled: true, announceSeasonEndingSoon: true, announceSeasonWinner: true, announceEffect: false };
  fs.writeFileSync(cfgFile3, JSON.stringify(cfg3, null, 2));

  // Die laufende Season künstlich kurz vor ihr Ende rücken: season.lengthDays erlaubt produktiv
  // keinen Wert unter einem Tag (config.js: applySeasonConfig) - ein direktes Zurückdatieren in
  // der (kopierten, isolierten) DB-Datei ist der einzige Weg, ihr Ende in Sekunden statt Tagen zu
  // erreichen, ohne dafür eigens einen produktiven Code-Pfad nur für Tests einzubauen.
  const sdb = new DatabaseSync(path.join(dir, 'data', 'ucc.db'));
  const lengthMs = cfg3.season.lengthDays * 86400000;
  sdb.prepare('UPDATE seasons SET started_at = ? WHERE ended_at IS NULL').run(Date.now() - (lengthMs - 1500));
  // Garantiert einen Sieger, unabhängig davon, ob die laufende Season in A zu diesem Zeitpunkt
  // schon eigene Teilnehmer hat (sonst bliebe die "neuer Sieger"-Ankündigung aus, siehe engine.js:
  // finishSeason() - bewusst keine Nachricht ohne echten Sieger).
  const seasonRow = sdb.prepare('SELECT id FROM seasons WHERE ended_at IS NULL').get();
  sdb.prepare('INSERT OR REPLACE INTO season_viewers (season_id, user_id, name, total, chaos, last_seen) VALUES (?, ?, ?, ?, ?, ?)')
    .run(seasonRow.id, 'u_chattest_winner', 'chattestwinner', 1, 42, Date.now());
  sdb.close();

  const env = { ...process.env, ...mock.env, HOME: home, UCC_DATA_DIR: path.join(dir, 'data'), UCC_NO_OPEN: '1', NO_COLOR: '1', UCC_BRIDGE: 'mock', UCC_TIME_SCALE: '0.02', UCC_POLL_SCALE: '0.02', UCC_SEASON_ENDING_SOON_MS: '10000' };
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/server.js')], { env, cwd: ROOT });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  try {
    await waitFor(() => /läuft\./.test(out), 10000, 'Server-Startmeldung (Season-Chat-Test)');
    await waitFor(() => (mock.st.chatMessages || []).some((m) => /endet bald/.test(m)), 8000, '"Season endet bald"-Ankündigung');
    await waitFor(() => (mock.st.chatMessages || []).some((m) => /Season beendet! Sieger/.test(m)), 8000, '"neuer Season-Sieger"-Ankündigung');
  } finally {
    p.kill();
  }
});
await t('Auto-Lebendig: löst nach Ruhezeit selbst eine Aktion aus der Whitelist aus, nie aus dem vollen Pool; echte Einlösung setzt den Timer zurück', async () => {
  // Validierung: kaputte Eingaben werden abgelehnt, bevor überhaupt etwas gespeichert wird.
  yes(!(await api('autoidle', { enabled: false, idleSec: 10, whitelist: [] })).json.ok, 'zu kurze Ruhezeit hätte abgelehnt werden müssen');
  yes(!(await api('autoidle', { enabled: false, idleSec: 300, whitelist: ['gibt_es_nicht'] })).json.ok, 'unbekannte Whitelist-Aktion hätte abgelehnt werden müssen');
  const tooMany = Array.from({ length: 21 }, (_, i) => `id${i}`);
  yes(!(await api('autoidle', { enabled: false, idleSec: 300, whitelist: tooMany })).json.ok, 'zu lange Whitelist hätte abgelehnt werden müssen');

  // Aktivieren mit kurzer Ruhezeit (30s - durch UCC_TIME_SCALE im Test auf einen Bruchteil einer
  // Sekunde verkürzt, siehe engine.js: real()) und genau einer Whitelist-Aktion.
  const r = await api('autoidle', { enabled: true, idleSec: 30, whitelist: ['jump_spam'] });
  yes(r.json.ok, `Auto-Lebendig speichern fehlgeschlagen: ${JSON.stringify(r.json)}`);
  eq((await st()).autoIdle.enabled, true, 'Auto-Lebendig sollte als aktiviert im Status stehen');

  // Eine echte Einlösung setzt den Ruhe-Timer zurück - kurz danach darf noch NICHTS automatisch
  // passieren, auch nicht kurz vor Ablauf der (skalierten) Ruhezeit. Bewusst NICHT auf den Abschluss
  // der Einlösung warten (done()) - der Ruhe-Timer wird schon beim Einreihen zurückgesetzt, nicht
  // erst wenn die Aktion fertig gelaufen ist, und "Kein Zoom" läuft selbst schon einen Teil der
  // (skalierten) Ruhezeit lang.
  redeem('Kein Zoom', 'idletester'); // andere Kategorie (medium) als die Whitelist-Aktion (small) - kein Cooldown-Zusammenhang
  await sleep(80); // kurz warten, bis die Einlösung wirklich verarbeitet wurde
  let n = events.length;
  await sleep(250); // deutlich unter 30s * TIME_SCALE (600ms)
  yes(!events.slice(n).some((e) => e.type === 'fx' && e.fx.type === 'alert' && e.fx.user === 'ChaosCore'), 'Auto-Lebendig hätte so kurz nach einer echten Einlösung noch nicht auslösen dürfen');

  // Jetzt lange genug ohne weitere Aktivität warten - ChaosCore muss jetzt selbst "Sprung-Spam" auslösen.
  await waitFor(() => events.slice(n).some((e) => e.type === 'fx' && e.fx.type === 'alert' && e.fx.user === 'ChaosCore' && e.fx.title === 'Sprung-Spam'), 6000, 'Auto-Lebendig hat nach Ablauf der Ruhezeit nicht selbst ausgelöst');
  // Klar als ChaosCore gekennzeichnet, keine echte Zuschauer-Einlösung dahinter (kein DB-Eintrag).
  yes(!(await st()).recent.some((x) => x.user_name === 'ChaosCore'), 'Auto-Lebendig-Effekt hätte keinen Einlösungs-Eintrag erzeugen dürfen');

  // Praxistest 15.11.: läuft das Spiel nicht (GSI nicht live), löst Auto-Lebendig nie aus.
  await waitFor(async () => { const x = (await st()).state; return !x.current && x.queue.length === 0; }, 8000, 'Ruhe vor dem Nicht-live-Teil');
  await gsiPost('freezetime');
  n = events.length;
  await sleep(1500); // mehr als zwei skalierte Ruhezeiten
  yes(!events.slice(n).some((e) => e.type === 'fx' && e.fx.type === 'alert' && e.fx.user === 'ChaosCore'), 'Auto-Lebendig hat ausgelöst, obwohl das Spiel nicht live war');
  await gsiPost('live');

  // Ausgeschaltet: trotz abgelaufener Ruhezeit passiert nichts automatisch.
  yes((await api('autoidle', { enabled: false, idleSec: 30, whitelist: ['jump_spam'] })).json.ok);
  n = events.length;
  await sleep(900);
  yes(!events.slice(n).some((e) => e.type === 'fx' && e.fx.type === 'alert' && e.fx.user === 'ChaosCore'), 'bei ausgeschalteter Funktion hätte nichts automatisch auslösen dürfen');

  // Aufräumen: Standardwerte wiederherstellen, damit spätere Tests (Profil-Wechsel u. a.) unbeeinflusst bleiben.
  const restore = await api('autoidle', { enabled: false, idleSec: 300, whitelist: [] });
  yes(restore.json.ok, `Zurücksetzen von Auto-Lebendig fehlgeschlagen: ${JSON.stringify(restore.json)}`);
});
await t('Import mit kritischer oder gesperrter Taste wird vollständig abgelehnt; Freigabe gilt nur lokal', async () => {
  const snapshot = async () => { const e = (await api('profile/export', {})).json; delete e.exportedAt; return JSON.stringify(e); };
  const before = await snapshot();
  const base = (await api('profile/export', {})).json;
  const tryImport = async (mutate) => { const d = structuredClone(base); mutate(d); return (await api('profile/import', d)).json; };
  const firstEnabled = (d) => d.actions.actions.find((a) => a.enabled && a.effect?.steps);
  let r = await tryImport((d) => { d.keys.jump = 'Enter'; });
  yes(!r.ok && /kritische Tasten dürfen nicht importiert werden/.test(r.error || ''), `kritische Taste in keys nicht abgelehnt: ${JSON.stringify(r)}`);
  r = await tryImport((d) => { d.keys.jump = 'LWin'; });
  yes(!r.ok && /gesperrt oder unbekannt/.test(r.error || ''), `gesperrte Taste in keys nicht abgelehnt: ${JSON.stringify(r)}`);
  r = await tryImport((d) => { d.keys.jump = { toString: 1 }; });
  yes(!r.ok, 'Nicht-Text als Taste nicht abgelehnt');
  r = await tryImport((d) => { firstEnabled(d).effect.steps = ['press Enter']; });
  yes(!r.ok && /kritische Taste/.test(r.error || ''), `rohe kritische Taste in Aktion nicht abgelehnt: ${JSON.stringify(r)}`);
  r = await tryImport((d) => { firstEnabled(d).effect.steps = ['press LWin', 'press r']; });
  yes(!r.ok && /gesperrt oder unbekannt/.test(r.error || ''), `Windows-Taste in Aktion nicht abgelehnt: ${JSON.stringify(r)}`);
  eq(await snapshot(), before, 'abgelehnte Importe haben Konfiguration oder Aktionen verändert');

  // Lokale Freigabe: nur bekannte Gruppen, wird gespeichert und im Status gemeldet.
  eq((await st()).input.criticalKeys.length, 0, 'Ausgangslage: nichts freigegeben');
  yes(!(await api('input/critical', { keys: ['LWin'] })).json.ok, 'Windows-Taste ließ sich freigeben');
  yes(!(await api('input/critical', { keys: 'Enter' })).json.ok, 'Nicht-Liste wurde angenommen');
  yes((await api('input/critical', { keys: ['Enter', 'Enter'] })).json.ok, 'Freigabe von Enter fehlgeschlagen');
  eq(JSON.stringify((await st()).input.criticalKeys), '["Enter"]');
  // Auch mit lokaler Freigabe: ein Import darf die Taste weder roh benutzen noch mitbringen ...
  r = await tryImport((d) => { firstEnabled(d).effect.steps = ['press Enter']; });
  yes(!r.ok, 'rohe kritische Taste im Import trotz lokaler Freigabe angenommen');
  r = await tryImport((d) => { d.keys.jump = 'Enter'; });
  yes(!r.ok, 'kritische Taste in importierten keys trotz lokaler Freigabe angenommen');
  // ... und er kann die Freigabe-Liste selbst nicht setzen.
  r = await tryImport((d) => { d.input = { criticalKeys: ['Alt', 'Escape'], criticalDeclined: [] }; });
  yes(r.ok, `Import mit zusätzlichem input-Feld sollte durchgehen (Feld wird ignoriert): ${JSON.stringify(r)}`);
  eq(JSON.stringify((await st()).input.criticalKeys), '["Enter"]', 'Import hat die Freigabe-Liste verändert');
  yes(!(await api('input/critical', { keys: [], declined: ['LWin'] })).json.ok, 'unbekannte Gruppe in "declined" wurde angenommen');
  eq((await st()).input.pending.length, 0, 'ohne kritische Taste in der Belegung darf keine Nachfrage ausstehen');
  yes((await api('input/critical', { keys: [] })).json.ok, 'Zurücknehmen fehlgeschlagen');
  eq((await st()).input.criticalKeys.length, 0);
});
await t('Import prüft auch deaktivierte Aktionen, requires und effect.dynamic - bei jedem Fehler bleibt alles unverändert', async () => {
  const snapshot = async () => { const e = (await api('profile/export', {})).json; delete e.exportedAt; return JSON.stringify(e); };
  const before = await snapshot();
  const base = (await api('profile/export', {})).json;
  const tryImport = async (mutate) => { const d = structuredClone(base); mutate(d); return (await api('profile/import', d)).json; };
  const off = (d) => { const a = d.actions.actions.find((x) => x.effect?.steps); a.enabled = false; return a; };
  const bad = [
    ['deaktivierte Aktion mit Windows-Taste', (d) => { off(d).effect.steps = ['press LWin']; }, /gesperrt oder unbekannt/],
    ['deaktivierte Aktion mit unbekanntem Befehl', (d) => { off(d).effect.steps = ['run calc']; }, /Unbekannter Effekt-Befehl/],
    ['unbekanntes effect.dynamic', (d) => { off(d).effect = { dynamic: 'shell' }; }, /unbekannte Sonderaktion/],
    ['unbekanntes requires', (d) => { off(d).requires = ['admin']; }, /unbekannte Bedingung/],
    ['unbekanntes Feld', (d) => { off(d).onload = 'x'; }, /unbekannte Feld "onload"/],
    ['doppelte id', (d) => { d.actions.actions.push(structuredClone(d.actions.actions[0])); }, /mehrfach/],
    ['Fluchrad auf unbekannte Aktion', (d) => { d.actions.curse = { pool: ['ghost'] }; }, /unbekannte Aktion "ghost"/],
    ['kaputte Stufe', (d) => { Object.values(d.actions.categories)[0].color = 'javascript:alert(1)'; }, /color/],
    ['Aktionen-Teil ohne Liste', (d) => { d.actions = { categories: d.actions.categories }; }, /Aktionen-Liste fehlt/],
    ['Aktionen-Teil ist Text', (d) => { d.actions = 'x'; }, /kein Objekt/],
  ];
  for (const [what, mutate, re] of bad) {
    const r = await tryImport(mutate);
    yes(!r.ok && re.test(r.error || ''), `${what}: nicht (richtig) abgelehnt -> ${JSON.stringify(r)}`);
  }
  eq(await snapshot(), before, 'ein abgelehnter Import hat Konfiguration oder Aktionen verändert');
  eq((await st()).actions.filter((a) => a.invalid).length, 0, 'nach abgelehnten Importen darf keine Aktion als ungültig gelten');
});
await t('ungültige lokale Aktion wird deaktiviert und mit Grund gemeldet, der Rest läuft weiter', async () => {
  const orig = fs.readFileSync(actFile, 'utf8');
  const j = JSON.parse(orig);
  const victim = j.actions.find((a) => a.id === 'jump_spam');
  victim.enabled = true; victim.effect = { steps: ['press LWin', 'press r'] };
  const sleeper = j.actions.find((a) => a.id === 'movement_lock');
  sleeper.enabled = false; sleeper.effect = { dynamic: 'shell' };
  fs.writeFileSync(actFile, JSON.stringify(j));
  try {
    await api('action/update', { id: 'ceasefire', cost: 150 }); // irgendeine Änderung -> Server lädt die Datei neu
    const s = await st();
    const v = s.actions.find((a) => a.id === 'jump_spam');
    yes(v.invalid && /gesperrt oder unbekannt/.test(v.invalid) && v.enabled === false, `ungültige Aktion nicht deaktiviert/begründet: ${JSON.stringify(v)}`);
    const sl = s.actions.find((a) => a.id === 'movement_lock');
    yes(sl.invalid && /unbekannte Sonderaktion/.test(sl.invalid), 'auch eine ausgeschaltete ungültige Aktion muss ihren Grund zeigen');
    yes(s.actions.filter((a) => !a.invalid && a.enabled).length > 5, 'die übrigen Aktionen müssen nutzbar bleiben');
    const on = (await api('action', { id: 'jump_spam', enabled: true })).json;
    yes(!on.ok && /ungültig und bleibt aus/.test(on.error || ''), `ungültige Aktion ließ sich einschalten: ${JSON.stringify(on)}`);
    // Selbst ein direkter Testlauf sendet die gesperrte Taste nicht an die Bridge.
    // Abwarten, bis der Testlauf wirklich abgewiesen UND die Warteschlange wieder leer ist - sonst
    // läuft er (mit seinem Vorlauf) in den nächsten Test hinein und stört dessen Ablauf.
    await api('test', { id: 'jump_spam', dry: false });
    await waitFor(() => /Effekt "jump_spam" fehlgeschlagen: Die Taste "LWin"/.test(srvOut), 15000, 'ungültiger Testlauf wird abgewiesen');
    await waitFor(async () => { const x = (await st()).state; return !x.current && x.queue.length === 0; }, 8000, 'Warteschlange wieder leer');
    yes(!/Sende: [^\n]*LWin/.test(srvOut), 'die gesperrte Taste wurde an die Bridge gesendet');
    // Die Datei selbst wurde nicht umgeschrieben (nur im Speicher deaktiviert).
    eq(JSON.parse(fs.readFileSync(actFile, 'utf8')).actions.find((a) => a.id === 'jump_spam').enabled, true, 'Datei wurde verändert');
  } finally {
    fs.writeFileSync(actFile, orig);
    await api('action/update', { id: 'ceasefire', cost: 150 });
  }
  eq((await st()).actions.filter((a) => a.invalid).length, 0, 'nach dem Zurücksetzen darf nichts mehr ungültig sein');
});
await t('Vorschau zeigt, was ein Import tun würde, und ändert nichts', async () => {
  const files = () => [cfgFile, actFile].map((f) => fs.readFileSync(f, 'utf8')).join('\n---\n');
  const before = files();
  const base = (await api('profile/export', {})).json;
  // Unverändertes eigenes Preset: nichts hinzugefügt/geändert/entfernt, aber die nie importierbaren
  // Felder werden ausdrücklich genannt.
  let p = (await api('profile/preview', { preset: base })).json;
  yes(p.ok, `Vorschau fehlgeschlagen: ${JSON.stringify(p).slice(0, 300)}`);
  eq(p.report.actions.added.length + p.report.actions.changed.length + p.report.actions.removed.length, 0, 'eigenes Preset sollte keine Unterschiede zeigen');
  eq(p.report.actions.unchanged, base.actions.actions.length);
  for (const f of ['game.requireFocus', 'game.windowExe', 'game.requireGameState', 'bridge.panicHotkey', 'engine.roundMaxSec', 'engine.holdTimeoutSec', 'engine.autoRefund']) {
    yes(p.report.notImported.includes(f), `"${f}" fehlt in der Liste "nicht übernommen": ${p.report.notImported}`);
  }
  eq(p.report.targetGame.id, 'cs2'); eq(p.report.targetGame.switches, false);
  // Verändertes Preset: hinzugefügt / geändert / entfernt, Tasten, Haltezeit, Medien, Overlay, Zustimmungs-Gruppen.
  const d = structuredClone(base);
  const removed = d.actions.actions.find((a) => a.id === 'scoreboard_block'); d.actions.actions = d.actions.actions.filter((a) => a !== removed);
  d.actions.curse.pool = d.actions.curse.pool.filter((id) => id !== 'scoreboard_block');
  d.actions.actions.find((a) => a.id === 'ceasefire').cost = 4321;
  d.actions.actions.push({ id: 'b4_neu', title: 'B4 Neu', cost: 10, category: 'small', enabled: true, requires: ['live'], effect: { steps: ['hold @duck 2500', 'press @jump 60'] } });
  d.keys.jump = 'j';
  d.overlay.accent = '#112233';
  d.overlay.customImage = { name: 'logo.png', mime: 'image/png', dataBase64: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2000, 7)]).toString('base64') };
  d.contract.distinctViewers = 77; d.engine.maxQueue = 9; d.game.sensitivity = 2.5;
  d.unbekannt = { x: 1 };
  p = (await api('profile/preview', { preset: d })).json;
  yes(p.ok, `Vorschau fehlgeschlagen: ${JSON.stringify(p).slice(0, 300)}`);
  const r = p.report;
  eq(r.actions.added.map((a) => a.id).join(), 'b4_neu');
  const added = r.actions.added[0];
  eq(added.keys.slice().sort().join(), ['LCtrl', 'j'].sort().join(), 'Tasten der neuen Aktion (inkl. der mitgebrachten Belegung) fehlen/falsch');
  eq(added.maxHoldMs, 2500, 'Haltezeit fehlt'); eq(added.seconds, 2.6, 'Dauer fehlt');
  yes(r.actions.changed.some((a) => a.id === 'ceasefire' && a.what.includes('cost')), 'geänderter Preis fehlt');
  eq(r.actions.removed.map((a) => a.id).join(), 'scoreboard_block');
  eq(JSON.stringify(r.keys.changed), JSON.stringify([{ name: 'jump', from: 'Space', to: 'j' }]));
  yes(r.overlay.changed.some((c) => c.field === 'accent' && c.to === '#112233'), 'Overlay-Änderung fehlt');
  eq(r.media.image?.action, 'added'); eq(r.media.image?.mime, 'image/png'); eq(r.media.image?.kb, 2);
  eq(r.optional.contract?.accepted, false); eq(r.optional.contract?.changes[0].to, 77);
  eq(r.optional.queue?.changes[0].to, 9); eq(r.optional.gameTuning?.changes[0].field, 'sensitivity');
  yes(r.notImported.includes('unbekannt'), 'unbekannter Abschnitt fehlt in "nicht übernommen"');
  // Fehlerhaftes Preset: die Vorschau sagt klar, dass es abgelehnt würde.
  d.actions.actions[0].effect = { dynamic: 'shell' };
  p = (await api('profile/preview', { preset: d })).json;
  yes(p.ok === false && /unbekannte Sonderaktion/.test(p.error || ''), `Vorschau meldet das fehlerhafte Preset nicht: ${JSON.stringify(p).slice(0, 200)}`);
  eq(files(), before, 'die Vorschau hat etwas verändert');
  yes(!fs.existsSync(path.join(A.data, 'uploads', 'overlay-image.png')), 'die Vorschau hat eine Mediendatei geschrieben');
});
await t('Dashboard importiert eine Datei nie ohne Vorschau', async () => {
  const html = dashboardSource();
  const js = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
  const onFile = js.slice(js.indexOf("$('profileImportFile').onchange"), js.indexOf("$('sync').onclick"));
  yes(/api\('profile\/preview'/.test(onFile), 'nach der Dateiauswahl wird keine Vorschau angefordert');
  yes(!/api\('profile\/import'/.test(onFile), 'nach der Dateiauswahl wird direkt importiert (ohne Vorschau/Bestätigung)');
  eq((js.match(/api\('profile\/import'/g) || []).length, 1, 'profile/import darf nur an einer Stelle aufgerufen werden');
  // Auch mitgelieferte Presets: erster Klick = Vorschau, Übernahme nur über den Bestätigen-Knopf.
  const oneClick = js.slice(js.indexOf('async function paintOneClick()'), js.indexOf('keine Presets verfügbar'));
  yes(oneClick.length > 100 && /api\('preset\/preview'/.test(oneClick), 'ein mitgeliefertes Preset fordert keine Vorschau an');
  yes(!/api\('preset\/apply'/.test(oneClick) && !/confirm\(/.test(oneClick), 'ein mitgeliefertes Preset wird ohne Vorschau übernommen');
  eq((js.match(/api\('preset\/apply'/g) || []).length, 1, 'preset/apply darf nur an einer Stelle aufgerufen werden');
  const confirm = js.slice(js.indexOf("$('importConfirm').onclick"), js.indexOf("$('profileImportFile').onchange"));
  yes(/api\('profile\/import', \{ preset: pendingImport\.data, accept \}\)/.test(confirm) && /api\('preset\/apply', \{ id: pendingImport\.presetId, accept \}\)/.test(confirm), 'Import/Preset-Übernahme laufen nicht über den Bestätigen-Knopf der Vorschau');
  yes(/importConfirm'\)\.style\.display = 'none'/.test(js), 'bei einem abgelehnten Preset muss der Übernehmen-Knopf verschwinden');
});
await t('Import übernimmt nur erlaubte Einstellungen; Contract/Warteschlange/Spielwerte nur nach Zustimmung', async () => {
  const diskCfg = () => JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  const base = (await api('profile/export', {})).json;
  const c0 = diskCfg();
  const d = structuredClone(base);
  Object.assign(d.game, { requireFocus: false, windowExe: 'evil.exe', requireGameState: true, cs2CfgDir: 'C:/evil', restoreMouseBinds: false, sensitivity: 2.5 });
  Object.assign(d.engine, { roundMaxSec: 99999, holdTimeoutSec: 99999, autoRefund: false, maxQueue: 9, queueWaitSec: 30 });
  d.bridge = { panicHotkey: '^!x', ahkPath: 'C:/evil.exe' };
  d.overlay.brand = 'GEHACKT';
  d.contract.distinctViewers = 77;
  d.server = { port: 1, adminToken: 'x' }; d.twitch = { clientId: 'x' }; d.consent = { riskAcknowledgedAt: 'x' }; d.input = { criticalKeys: ['Alt'] };
  d.overlay.accent = '#445566';
  let r = (await api('profile/import', d)).json;
  yes(r.ok, `Import fehlgeschlagen: ${JSON.stringify(r)}`);
  let c = diskCfg();
  eq(c.overlay.accent, '#445566', 'erlaubte Overlay-Einstellung wurde nicht übernommen');
  for (const [what, a, b] of [
    ['game.requireFocus', c.game.requireFocus, c0.game.requireFocus], ['game.windowExe', c.game.windowExe, c0.game.windowExe],
    ['game.requireGameState', c.game.requireGameState, c0.game.requireGameState], ['game.cs2CfgDir', c.game.cs2CfgDir, c0.game.cs2CfgDir],
    ['game.restoreMouseBinds', c.game.restoreMouseBinds, c0.game.restoreMouseBinds], ['game.sensitivity', c.game.sensitivity, c0.game.sensitivity],
    ['engine', JSON.stringify(c.engine), JSON.stringify(c0.engine)], ['bridge', JSON.stringify(c.bridge), JSON.stringify(c0.bridge)],
    ['overlay.brand', c.overlay.brand, c0.overlay.brand], ['contract', JSON.stringify(c.contract), JSON.stringify(c0.contract)],
    ['server', JSON.stringify(c.server), JSON.stringify(c0.server)], ['twitch', JSON.stringify(c.twitch), JSON.stringify(c0.twitch)],
    ['consent', JSON.stringify(c.consent), JSON.stringify(c0.consent)], ['input', JSON.stringify(c.input), JSON.stringify(c0.input)],
  ]) eq(a, b, `${what} wurde durch den Import verändert`);
  // Mit ausdrücklicher Zustimmung nur für EINE Gruppe ändert sich genau diese.
  r = (await api('profile/import', { preset: d, accept: { contract: true } })).json;
  yes(r.ok, `Import mit Zustimmung fehlgeschlagen: ${JSON.stringify(r)}`);
  c = diskCfg();
  eq(c.contract.distinctViewers, 77, 'Contract-Ziel trotz Zustimmung nicht übernommen');
  eq(c.engine.maxQueue, c0.engine.maxQueue, 'Warteschlange ohne Zustimmung übernommen');
  eq(c.game.sensitivity, c0.game.sensitivity, 'Spielwerte ohne Zustimmung übernommen');
  r = (await api('profile/import', { preset: d, accept: { queue: true, gameTuning: true } })).json;
  c = diskCfg();
  eq(c.engine.maxQueue, 9); eq(c.engine.queueWaitSec, 30); eq(c.game.sensitivity, 2.5);
  eq(c.engine.roundMaxSec, c0.engine.roundMaxSec, 'Zeitlimit der Engine trotzdem übernommen'); eq(c.game.requireFocus, c0.game.requireFocus);
  // Zurück auf den Ausgangsstand (eigenes Preset mit allen Zustimmungen).
  r = (await api('profile/import', { preset: base, accept: { contract: true, queue: true, gameTuning: true } })).json;
  yes(r.ok, 'Zurücksetzen fehlgeschlagen');
  c = diskCfg();
  eq(JSON.stringify([c.contract, c.engine, c.game.sensitivity, c.overlay.accent]), JSON.stringify([c0.contract, c0.engine, c0.game.sensitivity, c0.overlay.accent]), 'Ausgangsstand nicht wiederhergestellt');
});
await t('fehlerhafter Import wird vollständig abgelehnt - keine Teilübernahme von Einstellungen, Medien oder Aktionen', async () => {
  const state = () => [cfgFile, actFile].map((f) => fs.readFileSync(f, 'utf8')).join('\n---\n') + '\n' + (fs.existsSync(path.join(A.data, 'uploads')) ? fs.readdirSync(path.join(A.data, 'uploads')).join() : '');
  const before = state();
  const base = (await api('profile/export', {})).json;
  const png = (extra = 100) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(extra, 7)]).toString('base64');
  // Jedes dieser Presets enthält ZUSÄTZLICH gültige Änderungen (Farbe, Bild, Taste, Preis) - nichts davon darf ankommen.
  const good = (d) => { d.overlay.accent = '#abcdef'; d.overlay.customImage = { name: 'ok.png', mime: 'image/png', dataBase64: png() }; d.keys.jump = 'k'; d.actions.actions.find((a) => a.id === 'ceasefire').cost = 999; };
  const bad = [
    ['kaputte Aktion ganz am Ende', (d) => { d.actions.actions.at(-1).effect = { steps: ['press LWin'] }; }, /gesperrt oder unbekannt/],
    ['Bild mit falschem Inhalt', (d) => { d.overlay.customImage = { name: 'x.png', mime: 'image/png', dataBase64: Buffer.from('MZ\x90\x00kein-bild').toString('base64') }; }, /passt nicht zum angegebenen Typ/],
    ['Bild mit unerlaubtem Typ', (d) => { d.overlay.customImage = { name: 'x.exe', mime: 'application/x-msdownload', dataBase64: png() }; }, /nicht erlaubt/],
    ['Bild mit SVG-Typ (Skript möglich)', (d) => { d.overlay.customImage = { name: 'x.svg', mime: 'image/svg+xml', dataBase64: png() }; }, /nicht erlaubt/],
    ['kaputtes Base64', (d) => { d.overlay.customImage = { name: 'x.png', mime: 'image/png', dataBase64: 'iVBOR$$$$w0KGgo=' }; }, /kein gültiges Base64/],
    ['zu großes Bild', (d) => { d.overlay.customImage = { name: 'x.png', mime: 'image/png', dataBase64: png(950 * 1024) }; }, /zu groß/],
    ['Sound als Liste', (d) => { d.overlay.customSound = ['x']; }, /unvollständig/],
    ['Farbe kein Hex-Code', (d) => { d.overlay.accent = 'red;background:url(x)'; }, /Hex-Code/],
    ['Layout mit unbekanntem Panel', (d) => { d.overlay.layout = { admin: { x: 1, y: 1 } }; }, /Unbekanntes Overlay-Panel/],
    ['Layout außerhalb des Bereichs', (d) => { d.overlay.layout = { chaos: { x: 5000, y: 1 } }; }, /zwischen 0 und 100/],
    ['topCount außerhalb', (d) => { d.overlay.topCount = 9999; }, /1 bis 15/],
    ['unbekanntes Spiel-Profil', (d) => { d.game.profile = '../../etc'; }, /unbekanntes Spiel-Profil/],
    ['Warteschlange unsinnig (auch ohne Zustimmung)', (d) => { d.engine.maxQueue = 99999; }, /maxQueue/],
    ['Contract-Ziel unsinnig (auch ohne Zustimmung)', (d) => { d.contract.distinctViewers = 'viele'; }, /Contract-Ziel/],
    ['Spielwert unsinnig (auch ohne Zustimmung)', (d) => { d.game.sensitivity = -5; }, /sensitivity/],
    ['Tastenname ungültig', (d) => { d.keys['a b;c'] = 'w'; }, /Tastenname/],
    ['Abschnitt overlay ist Text', (d) => { d.overlay = 'x'; }, /"overlay"/],
    ['Abschnitt keys ist Liste', (d) => { d.keys = ['w']; }, /"keys"/],
    ['falsche Schema-Version', (d) => { d.schema = 2; }, /keine gültige/],
  ];
  for (const [what, mutate, re] of bad) {
    const d = structuredClone(base); good(d); mutate(d);
    for (const body of [d, { preset: d, accept: { contract: true, queue: true, gameTuning: true } }]) {
      const r = (await api('profile/import', body)).json;
      yes(!r.ok && re.test(r.error || ''), `${what}: nicht (richtig) abgelehnt -> ${JSON.stringify(r).slice(0, 200)}`);
    }
    eq(state(), before, `${what}: der abgelehnte Import hat trotzdem etwas verändert`);
  }
  // Gegenprobe: dasselbe Preset OHNE den Fehler wird übernommen (die Prüfung lehnt nicht einfach alles ab).
  const ok = structuredClone(base); good(ok);
  yes((await api('profile/import', ok)).json.ok, 'gültiges Preset wurde abgelehnt');
  const c = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  eq(c.overlay.accent, '#abcdef'); eq(c.keys.jump, 'k'); eq(c.overlay.customImage?.name, 'ok.png');
  yes(fs.existsSync(path.join(A.data, 'uploads', 'overlay-image.png')), 'Bild wurde nicht geschrieben');
  // Aufräumen: Ausgangsstand wiederherstellen.
  await api('overlay/asset/remove', { kind: 'image' });
  yes((await api('profile/import', base)).json.ok, 'Zurücksetzen fehlgeschlagen');
  eq(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).keys.jump, 'Space');
});
await t('Runner prüft den Fokus vor jeder Eingabe, lässt bei Verlust alles los und sendet nichts in fremde Fenster (statische Prüfung)', async () => {
  // AutoHotkey läuft nur unter Windows - hier wird der Quelltext geprüft, der echte Beweis ist ein
  // Test auf Windows.
  const src = fs.readFileSync(path.join(ROOT, 'ahk', 'runner.ahk'), 'utf8').replace(/\r/g, '');
  const code = src.split('\n').filter((l) => !/^\s*;/.test(l)).join('\n'); // ohne reine Kommentarzeilen
  const fns = {};
  for (const m of code.matchAll(/^(\w+)\([^\n]*\) \{\n([\s\S]*?)^\}$/gm)) fns[m[1]] = m[2];
  for (const need of ['Guard', 'FocusWatch', 'Down', 'Up', 'Tap', 'Rel', 'LClick', 'MouseUp', 'ReleaseAll', 'AbortFocus', 'Finish', 'MakeSwap']) yes(fns[need] !== undefined, `Funktion ${need} fehlt im Runner`);
  const pressing = /" down\}"|0x0002|0x0001/; // Taste runter, Maustaste runter, Mausbewegung
  // 1. Drückende/bewegende Eingaben gibt es nur in diesen Funktionen ...
  const main = code.slice(code.indexOf('for line in StrSplit('));
  yes(!pressing.test(main), 'die Hauptschleife sendet selbst eine drückende Eingabe (muss über Down/Tap/Rel/LClick laufen)');
  for (const [name, body] of Object.entries(fns)) {
    if (!pressing.test(body)) continue;
    yes(['Down', 'Rel', 'LClick', 'MakeSwap', 'Finish'].includes(name), `Funktion ${name} sendet eine drückende Eingabe, steht aber nicht auf der geprüften Liste`);
  }
  // 2. ... und dort steht direkt davor Guard() (Effekt-Eingaben) bzw. eine InGame()-Prüfung (Wiederherstellung).
  for (const name of ['Down', 'Rel', 'LClick', 'MakeSwap']) {
    const lines = fns[name].split('\n').map((l) => l.trim());
    const i = lines.findIndex((l) => pressing.test(l));
    yes(lines.slice(0, i).some((l) => l === 'Guard()'), `${name}: kein Guard() vor der Eingabe`);
  }
  // Nach "Taste runter" wird sofort noch einmal geprüft (Zeitfenster zwischen Prüfung und Eingabe).
  for (const name of ['Down', 'LClick', 'MakeSwap']) {
    const lines = fns[name].split('\n').map((l) => l.trim());
    const i = lines.findIndex((l) => pressing.test(l));
    eq(lines[i + 1], 'Guard()', `${name}: keine erneute Prüfung direkt nach "runter"`);
    yes(lines.slice(0, i).some((l) => /held\[\w+\] := true|mouseDown := true/.test(l)), `${name}: die Taste wird nicht VOR dem Senden als gehalten vermerkt (sonst ließe ein Abbruch sie nicht los)`);
  }
  {
    // Reguläres Ende: Wiederherstellungs-Tasten nur mit Fokusprüfung direkt davor.
    const lines = fns.Finish.split('\n').map((l) => l.trim());
    lines.forEach((l, i) => { if (pressing.test(l)) yes(lines.slice(Math.max(0, i - 4), i).some((x) => /InGame\(\)/.test(x)), 'Finish: Wiederherstellungs-Taste ohne Fokusprüfung direkt davor'); });
  }
  // 3. Guard bricht ab, statt nur "false" zu melden; Loslassen wird nie blockiert.
  yes(/if !InGame\(\)\n\s+AbortFocus\(\)/.test(fns.Guard), 'Guard() ruft bei Fokusverlust nicht AbortFocus() auf');
  yes(!/Guard\(\)/.test(fns.Up) && !/Guard\(\)/.test(fns.MouseUp) && !/Guard\(\)/.test(fns.ReleaseAll), 'Loslassen darf nicht an der Fokusprüfung hängen');
  // 4. Nach Fokusverlust: AUSSCHLIESSLICH loslassen. AbortFocus und
  //    alles, was es aufruft, enthält keine drückende Eingabe, kein Warten auf die Rückkehr und
  //    endet immer mit ExitApp 5 oder 6.
  const ab = fns.AbortFocus;
  for (const name of ['AbortFocus', 'ReleaseAll', 'Unblock', 'Up', 'MouseUp']) yes(!pressing.test(fns[name]), `${name} (läuft nach Fokusverlust) enthält eine drückende Eingabe`);
  const called = [...ab.matchAll(/\b([A-Z]\w+)\(/g)].map((m) => m[1]).filter((n) => fns[n] !== undefined);
  eq([...new Set(called)].sort().join(), 'ReleaseAll', 'AbortFocus ruft etwas anderes als ReleaseAll auf');
  yes(!/Sleep|while|loop|Send|DllCall|Tap\(|Down\(/.test(ab), 'AbortFocus wartet oder sendet selbst etwas');
  yes(/ReleaseAll\(\)\n\s+ExitApp cleanups\.Length \? 6 : 5\s*$/.test(ab), 'AbortFocus endet nicht direkt nach dem Loslassen mit ExitApp 5/6');
  yes(/Unblock\(\)/.test(fns.ReleaseAll) && /Up\(k\)/.test(fns.ReleaseAll) && /MouseUp\(\)/.test(fns.ReleaseAll), 'ReleaseAll gibt nicht Tasten, Maustaste und Sperren frei');
  yes(!/" down\}"/.test(fns.Up) && /" up\}"/.test(fns.Up) && /0x0004/.test(fns.MouseUp), 'Up/MouseUp senden nicht ausschließlich Loslassen');
  yes(!/waitFocus|RESTORE_WAIT/.test(code), 'der Runner wartet noch auf die Rückkehr des Spiels');
  // 5. Der Zeitgeber läuft, sobald Fokus verlangt ist, und die Sperren gelten nur im Spielfenster.
  yes(/if needFocus \{\n\s+HotIfWinActive "ahk_exe " exe\n\s+SetTimer FocusWatch, \d+\n\}/.test(code), 'FocusWatch/HotIfWinActive werden bei needFocus nicht eingerichtet');
  // 6. Die Bridge: ohne Fokusprüfung läuft NUR der reine Loslassen-Lauf ("up ..."); nichts wird
  //    für einen späteren Lauf vorgemerkt; bei ungeklärtem Zustand startet kein neuer Effekt.
  const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  // Wiederherstellung wird nachgeholt. Ohne
  // Fokusprüfung starten deshalb genau zwei Läufe: der reine Loslassen-Lauf und der Wartelauf, der mit
  // "waitfocus" beginnt - der Runner sendet dann erst, wenn das Spiel vorn ist, und ab da mit Fokusprüfung.
  const noFocusCalls = [...bridge.matchAll(/runAhk\(([^,()]+?),[^()]*,\s*true\)/g)].map((m) => m[1].trim());
  eq(noFocusCalls.join(), "['waitfocus',ups", 'ohne Fokusprüfung dürfen nur der Loslassen- und der Wartelauf starten');
  yes(/runAhk\(\['waitfocus', \.\.\.lines\], PENDING_MAX_MS, true\)/.test(bridge), 'der Wartelauf beginnt nicht mit "waitfocus"');
  const wf = main.slice(main.indexOf('case "waitfocus":'));
  yes(/case "waitfocus":\n\s+while !InGame\(\) \{[\s\S]*?\}\n\s+Sleep \d+\n\s+needFocus := true\n\s+HotIfWinActive "ahk_exe " exe\n\s+SetTimer FocusWatch, 15/.test(wf), '"waitfocus" schaltet die Fokusprüfung nicht ein, nachdem das Spiel vorn ist');
  yes(!pressing.test(wf.slice(0, wf.indexOf('default:'))), '"waitfocus" sendet selbst eine Eingabe');
  yes(/const ups = c\.filter\(\(l\) => l\.startsWith\('up '\)\)/.test(bridge), 'der Loslassen-Lauf enthält nicht ausschließlich "up"-Zeilen');
  yes(/if \(inputUnclear\) \{\n\s+const reason/.test(bridge), 'run() lehnt bei ungeklärtem Eingabezustand nicht ab');
  // Der Runner-Befehl "up" sendet wirklich nur Loslassen.
  yes(/case "up":\n\s+Up\(p\[2\]\)/.test(main), 'Runner-Befehl "up" ruft nicht Up() auf');
});
await t('Fokusverlust mitten im Effekt - abgebrochen, protokolliert, nicht erstattet, Warteschlange bleibt konsistent', async () => {
  const marker = path.join(A.data, 'run', 'mock-focus-lost');
  const idle = async () => { const s = await st(); return s.state.queue.length === 0 && !s.state.current; };
  const count = (re) => (srvOut.match(re) || []).length;
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  await gsiPost('live');
  await waitFor(idle, 8000, 'Ruhe vor dem Test');
  // 1. Effekt MIT Wiederherstellungs-Taste (Feuerpause) verliert den Fokus -> Runner-Code 6.
  const lostBefore = count(/Effekt abgebrochen: Das Spielfenster/g);
  fs.writeFileSync(marker, '6');
  const id1 = await redeemFree('Feuerpause', 'b5-a');
  await done(id1); // FULFILLED = beendet, NICHT erstattet (keine automatische Erstattung)
  await waitFor(() => count(/Effekt abgebrochen: Das Spielfenster/g) === lostBefore + 1, 4000, 'Abbruchgrund im Protokoll');
  yes(/hat während des Effekts den Fokus verloren\. Alle gehaltenen Tasten wurden losgelassen, es wurde keine weitere Taste gedrückt\. Der Spielzustand wird zurückgesetzt, sobald cs2\.exe wieder im Vordergrund ist \(press NumpadMult\)/.test(srvOut), 'Protokollzeile nennt Ursache und den nicht zurückgesetzten Spielzustand nicht');
  yes(!fs.existsSync(marker), 'der simulierte Fokusverlust wurde nicht verbraucht');
  await waitFor(idle, 8000, 'Warteschlange nach dem Abbruch leer');
  yes(!(await st()).state.paused, 'ein Fokusverlust darf das Programm nicht pausieren');
  // 2. In der Simulation wird nichts nachgeholt (das Nachholen gibt es nur mit echtem AutoHotkey, live
  //    in CS2 geprüft): der nächste Effekt sendet exakt seine normale Schrittfolge.
  const sendBefore = count(/Sende: /g);
  const id2 = await redeemFree('Feuerpause', 'b5-b');
  await done(id2);
  const sends = srvOut.split('\n').filter((l) => /Sende: /.test(l)).slice(sendBefore);
  yes(sends.length >= 1 && sends.every((l) => / Sende: oncleanup press NumpadMult ; press NumpadDiv ; release LButton ; block LButton ; wait 3000 ; unblock$/.test(l)), `nach dem Fokusverlust wurde etwas anderes gesendet als die normale Aktion: ${sends.join(' | ')}`);
  eq(count(/Hole ausstehende|nachgeholt/g), 0, 'es wurde eine Wiederherstellung nachgeholt');
  await waitFor(idle, 8000, 'Ruhe');
  // 3. Effekt OHNE Wiederherstellungs-Taste (Sprung-Spam) verliert den Fokus -> Runner-Code 5,
  //    kein Hinweis auf einen offenen Spielzustand.
  const warnBefore = count(/Der Spielzustand wird zurückgesetzt/g);
  fs.writeFileSync(marker, '5');
  const id3 = await redeemFree('Sprung-Spam', 'b5-c');
  await done(id3);
  await waitFor(() => count(/Effekt abgebrochen: Das Spielfenster/g) === lostBefore + 2, 4000, 'Protokoll für Code 5');
  eq(count(/Der Spielzustand wird zurückgesetzt/g), warnBefore, 'bei einem Effekt ohne Wiederherstellungs-Taste darf kein offener Spielzustand gemeldet werden');
  await waitFor(idle, 8000, 'Ruhe am Ende');
});
await t('Praxistest 15.11.: Menü/Chat/Konsole, Tod und Rundenende werden unterschieden; Menü stoppt mit Aufschub', async () => {
  const idle = async () => { const x = (await st()).state; return !x.current && x.queue.length === 0; };
  const start = async (user) => {
    await gsiPost('live');
    await waitFor(idle, 8000, 'Ruhe');
    await redeemFree('Pistol Only', user); // läuft bis Rundenende (until_stop)
    await waitFor(async () => (await st()).state.current?.untilStop, 8000, 'Pistol Only läuft');
    await sleep(100);
  };
  await start('menu-1');
  await gsiPost('live', { activity: 'menu' });
  await waitFor(() => /Effekt beendet \(Spieler im Menü, Chat oder in der Konsole\)/.test(srvOut), 4000, 'Grund "Menü" im Protokoll');
  await waitFor(idle, 8000, 'Effekt nach Menü beendet');
  await start('menu-2');
  await gsiPost('live', { health: 0 });
  await waitFor(() => /Effekt beendet \(Spieler gestorben\)/.test(srvOut), 4000, 'Grund "gestorben" im Protokoll');
  await waitFor(idle, 8000, 'Effekt nach Tod beendet');
  await start('menu-3');
  await gsiPost('over');
  await waitFor(() => /Effekt beendet \(Runde vorbei\)/.test(srvOut), 4000, 'Grund "Runde vorbei" im Protokoll');
  await waitFor(idle, 8000, 'Effekt nach Rundenende beendet');
  await gsiPost('live');
  // Engine gibt den Aufschub an die Bridge weiter (stop({ defer: true })), der Runner antwortet dann mit Code 7.
  const eng = fs.readFileSync(path.join(ROOT, 'src', 'engine.js'), 'utf8');
  yes(/this\.stopCurrent\('Spieler im Menü, Chat oder in der Konsole', \{ defer: true \}\)/.test(eng), 'Menü-Stopp ohne Aufschub');
  yes(/this\.current\.handle\.stop\(opts\)/.test(eng), 'stopCurrent reicht den Aufschub nicht an die Bridge weiter');
  const runner = fs.readFileSync(path.join(ROOT, 'ahk', 'runner.ahk'), 'utf8').replace(/\r/g, '');
  yes(/if Trim\(FileRead\(stopFile\)\) = "defer"\n\s+ExitApp 7/.test(runner), 'Runner kennt den Aufschub (Code 7) nicht');
});
await t('Praxistest 15.11.: "letzte Waffe" läuft über den eigenen Bind lastInv, nicht über die Taste des Streamers', async () => {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  const knife = (acts) => acts.find((a) => a.id === 'knife_time').effect.steps;
  for (const steps of [knife(read('config/actions.default.json').actions), knife(read('config/presets/cs2-klassisch.json').actions.actions)]) {
    eq(steps.at(-1), 'press @lastInv'); yes(steps.some((l) => /^block .*@last\b/.test(l)), '@last soll weiterhin gesperrt werden');
  }
  yes(/'press @lastInv'\]\)/.test(fs.readFileSync(path.join(ROOT, 'src', 'engine.js'), 'utf8')), 'Granatenwurf drückt nicht @lastInv');
  const g = await import('../src/games/index.js');
  eq(g.CS2_PROFILE.keyDefaults.lastInv, 'Numpad6');
  // Kein zweiter interner Bind auf derselben Taste.
  const { BIND_KEYS } = await import('../src/cs2.js');
  const used = BIND_KEYS.map((k) => g.CS2_PROFILE.keyDefaults[k]);
  eq(new Set(used).size, used.length, `doppelt belegte interne Bind-Taste: ${used}`);
  eq((await st()).keys?.lastInv ?? JSON.parse(fs.readFileSync(cfgFile, 'utf8')).keys.lastInv, 'Numpad6', 'bestehende Installation bekommt lastInv nicht');
});
await t('Praxistest 15.11.: Login-Verlängerung erklärt "missing client secret" und verweist nicht auf npm', async () => {
  const { refreshFailMessage } = await import('../src/twitch.js');
  const secret = refreshFailMessage(400, { status: 400, message: 'missing client secret' });
  yes(/„Vertraulich"/.test(secret) && /„Öffentlich"/.test(secret) && /Einrichtungsfenster/.test(secret), `Meldung erklärt die Ursache nicht: ${secret}`);
  const other = refreshFailMessage(400, { status: 400, message: 'Invalid refresh token' });
  yes(/Einrichtungsfenster/.test(other) && !/npm/.test(other) && !/Vertraulich/.test(other), `allgemeine Meldung falsch: ${other}`);
  yes(!/npm run login/.test(fs.readFileSync(path.join(ROOT, 'src', 'twitch.js'), 'utf8').split('\n').filter((l) => /TwitchError\(/.test(l)).join('\n')), 'eine Fehlermeldung an Endnutzer nennt noch "npm run login"');
});
await t('Farbe zeitlich begrenzt mit Rücksetzen, Ducken 150 ms, kein neues Fenster nach Neustart', async () => {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  for (const acts of [read('config/actions.default.json').actions, read('config/presets/cs2-klassisch.json').actions.actions]) {
    eq(acts.find((a) => a.id === 'crosshair_color').effect.steps.join(' ; '), 'oncleanup press @restoreExtra ; press @xhColor ; wait 15000');
    yes(acts.find((a) => a.id === 'duck_spam').effect.steps.includes('press @duck 150'), 'Ducken-Spam drückt nicht 150 ms');
  }
  const srv = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');
  yes(/const relaunched = process\.env\.UCC_RELAUNCHED === '1';[\s\S]{0,400}if \(!quiet && cfg\.server\.openDashboard && !relaunched\)/.test(srv), 'nach einem Neustart wird trotzdem ein neues Dashboard-Fenster geöffnet');
  yes(/location\.reload\(\)/.test(dashboardSource()), 'das Dashboard lädt sich nach "Neu starten" nicht selbst neu');
  // Ungültige eigene Farbe wird beim Laden abgelehnt (wie die anderen Spielwerte).
  const dir = path.join(tmp, 'xhcolor'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ game: { crosshairColor: [300, 0, 0] } }));
  const script = path.join(tmp, 'xhcolor.mjs');
  fs.writeFileSync(script, `import { loadConfig } from ${JSON.stringify(path.join(ROOT, 'src', 'config.js'))}; try { loadConfig(); console.log('ok'); } catch (e) { console.log('ERR ' + e.message); }`);
  const out = (await run(path.relative(ROOT, script), [], { ...process.env, UCC_DATA_DIR: dir, NO_COLOR: '1' })).out;
  yes(/ERR game\.crosshairColor/.test(out), `ungültige Farbe nicht abgelehnt: ${out}`);
});
await t('alte GSI-Datei wird beim Aktualisieren ersetzt, nicht doppelt', async () => {
  const { installCs2Files, cs2FilesInstalled, GSI_FILE, GSI_FILE_OLD } = await import('../src/cs2.js');
  const dir = path.join(tmp, 's1-cs2cfg'); fs.mkdirSync(dir, { recursive: true });
  installCs2Files(dir, 7788, 'tok', {}, { ...cfg.keys });
  fs.renameSync(path.join(dir, GSI_FILE), path.join(dir, GSI_FILE_OLD)); // Stand vor Schritt 12
  fs.writeFileSync(path.join(dir, GSI_FILE_OLD), fs.readFileSync(path.join(dir, GSI_FILE_OLD), 'utf8').replace(/\s*"player_match_stats"\s+"1"/, ''));
  let f = cs2FilesInstalled(dir);
  eq(f.gsi, true); eq(f.gsiCurrent, false, 'alte Datei darf nicht als aktuell gelten'); eq(f.current, false, 'ohne neue GSI-Datei muss aktualisiert werden');
  installCs2Files(dir, 7788, 'tok', {}, { ...cfg.keys });
  f = cs2FilesInstalled(dir);
  eq(f.gsiCurrent, true); eq(f.current, true);
  yes(!fs.existsSync(path.join(dir, GSI_FILE_OLD)), 'alte Datei liegt noch daneben');
});
await t('GSI-Aufzeichnung schreibt Pakete ohne Token und endet sauber', async () => {
  let r = (await api('gsi/record', { on: true })).json;
  yes(r.ok && r.recording.on, `Aufzeichnung startet nicht: ${JSON.stringify(r)}`);
  await gsiPost('live'); await gsiPost('over'); await gsiPost('live');
  await waitFor(async () => (await st()).gsiRecording.count >= 3, 4000, 'Pakete werden gezählt');
  r = (await api('gsi/record', { on: false })).json;
  eq(r.recording.on, false);
  const dir = path.join(A.data, 'gsi-recordings');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  eq(files.length, 1, 'genau eine Aufzeichnung erwartet');
  const text = fs.readFileSync(path.join(dir, files[0]), 'utf8');
  yes(!text.includes(cfg.server.gsiToken) && !/"auth"/.test(text), 'das GSI-Token steht in der Aufzeichnung');
  const { readRecording } = await import('../src/gsi-recorder.js');
  const rec = readRecording(text);
  yes(rec.length >= 3 && rec.every((x) => typeof x.t === 'number' && x.body.provider), 'Aufzeichnung unvollständig');
  eq(rec.at(-1).body.round.phase, 'live');
  fs.rmSync(dir, { recursive: true, force: true });
});
await t('jede Angriffs-Datei unter test/fixtures/presets wird wie erwartet behandelt (Vorschau und Import), nichts ändert sich', async () => {
  // Dieselben Dateien, die man auf Windows von Hand im Dashboard importieren kann.
  const dir = path.join(ROOT, 'test', 'fixtures', 'presets');
  const expected = JSON.parse(fs.readFileSync(path.join(dir, 'ERWARTUNG.json'), 'utf8')).files;
  const onDisk = fs.readdirSync(dir).filter((f) => f !== 'ERWARTUNG.json').sort();
  eq(expected.map((e) => e.file).sort().join(), onDisk.join(), 'ERWARTUNG.json und die vorhandenen Dateien passen nicht zusammen');
  yes(expected.length >= 20, 'zu wenige Angriffs-Dateien');
  const raw = async (route, text) => (await fetch(`${base}/api/${route}`, { method: 'POST', headers: { 'x-admin-token': cfg.server.adminToken, 'Content-Type': 'application/json' }, body: text })).json();
  const state = () => [cfgFile, actFile].map((f) => fs.readFileSync(f, 'utf8')).join('\n---\n') + '\n' + (fs.existsSync(path.join(A.data, 'uploads')) ? fs.readdirSync(path.join(A.data, 'uploads')).join() : '');
  const restore = (await api('profile/export', {})).json;
  const before = state();
  for (const e of expected) {
    const text = fs.readFileSync(path.join(dir, e.file), 'utf8'); // roh, damit z. B. "__proto__" erhalten bleibt
    const pv = await raw('profile/preview', `{"preset":${text}}`);
    if (e.expect === 'reject') {
      yes(pv.ok === false && new RegExp(e.match).test(pv.error || ''), `${e.file}: Vorschau lehnt nicht (richtig) ab -> ${JSON.stringify(pv).slice(0, 200)}`);
      for (const body of [text, `{"preset":${text},"accept":{"contract":true,"queue":true,"gameTuning":true}}`]) {
        const im = await raw('profile/import', body);
        yes(!im.ok && new RegExp(e.match).test(im.error || ''), `${e.file}: Import lehnt nicht (richtig) ab -> ${JSON.stringify(im).slice(0, 200)}`);
      }
      eq(state(), before, `${e.file}: abgelehnt, aber etwas wurde verändert`);
    } else {
      // "Einstellungen kapern": gültig, aber keine der geschützten Einstellungen darf sich ändern.
      yes(pv.ok === true, `${e.file}: Vorschau hätte das Preset annehmen müssen -> ${JSON.stringify(pv).slice(0, 200)}`);
      for (const f of ['game.requireFocus', 'game.windowExe', 'game.requireGameState', 'bridge.panicHotkey', 'engine.roundMaxSec', 'engine.holdTimeoutSec', 'engine.autoRefund', 'overlay.brand', 'input', 'server']) {
        yes(pv.report.notImported.includes(f), `${e.file}: "${f}" steht nicht unter "nicht übernommen"`);
      }
      eq(state(), before, `${e.file}: schon die Vorschau hat etwas verändert`);
      const c0 = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
      const im = await raw('profile/import', `{"preset":${text},"accept":{"contract":true,"queue":true,"gameTuning":true}}`);
      yes(im.ok, `${e.file}: Import fehlgeschlagen -> ${JSON.stringify(im).slice(0, 200)}`);
      const c1 = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
      for (const pick of [(c) => c.game.requireFocus, (c) => c.game.windowExe, (c) => c.game.requireGameState, (c) => JSON.stringify(c.bridge), (c) => JSON.stringify(c.engine), (c) => JSON.stringify(c.input), (c) => JSON.stringify(c.server), (c) => c.overlay.brand]) {
        eq(pick(c1), pick(c0), `${e.file}: eine geschützte Einstellung wurde verändert`);
      }
      yes((await api('profile/import', { preset: restore, accept: { contract: true, queue: true, gameTuning: true } })).json.ok, 'Zurücksetzen nach dem angenommenen Preset fehlgeschlagen');
      eq(state(), before, 'Ausgangsstand nach dem angenommenen Preset nicht wiederhergestellt');
    }
  }
});
await t('kaputte und übergroße Anfragen bringen den Server nicht aus dem Tritt', async () => {
  const post = (route, text) => fetch(`${base}/api/${route}`, { method: 'POST', headers: { 'x-admin-token': cfg.server.adminToken, 'Content-Type': 'application/json' }, body: text });
  const state = () => [cfgFile, actFile].map((f) => fs.readFileSync(f, 'utf8')).join('\n---\n');
  const before = state();
  for (const route of ['profile/preview', 'profile/import']) {
    let r = await post(route, '{"schema":1,"actions":{"actions":[');
    eq(r.status, 400, `${route}: abgeschnittenes JSON`);
    r = await post(route, '['.repeat(200000) + ']'.repeat(200000)); // extrem tief verschachtelt
    yes(r.status === 400 || r.status === 200, `${route}: tief verschachteltes JSON -> ${r.status}`);
    if (r.status === 200) yes((await r.json()).ok !== true, `${route}: tief verschachteltes JSON wurde angenommen`);
    r = await post(route, 'null'); yes(r.status === 400 || (await r.json()).ok !== true, `${route}: null wurde angenommen`);
    r = await post(route, '"text"'); yes(r.status === 400 || (await r.json()).ok !== true, `${route}: Text wurde angenommen`);
    r = await post(route, '[1,2,3]'); yes(r.status === 400 || (await r.json()).ok !== true, `${route}: Liste wurde angenommen`);
    // Größer als die 4-MB-Grenze für Presets: wird abgewiesen, bevor der Inhalt überhaupt gelesen ist.
    let tooBig;
    try { tooBig = (await post(route, `{"schema":1,"x":"${'A'.repeat(5 * 1024 * 1024)}"}`)).status; } catch { tooBig = 'verbindung-geschlossen'; }
    yes(tooBig === 413 || tooBig === 'verbindung-geschlossen', `${route}: 5-MB-Anfrage -> ${tooBig}`);
  }
  eq(state(), before, 'eine kaputte Anfrage hat etwas verändert');
  yes((await st()).state !== undefined, 'der Server antwortet danach nicht mehr normal');
});
await t('Session Stats im Server: Stream online startet die Sitzung, Effekt-Tod zählt als Chaos mit Zuschauer, !fail nur für Mods, CSV, Stream offline beendet', async () => {
  const gsiStats = (kills, deaths, health = 100) => fetch(`${base}/gsi`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    provider: { steamid: '765' }, auth: { token: cfg.server.gsiToken }, map: { name: 'de_mirage', mode: 'casual', phase: 'live', round: 2 }, round: { phase: 'live' },
    player: { steamid: '765', team: 'T', activity: 'playing', state: { health, round_kills: 0 }, match_stats: { kills, deaths },
      weapons: { w0: { name: 'weapon_knife', type: 'Knife', state: 'holstered' }, w1: { name: 'weapon_ak47', type: 'Rifle', state: 'active' } } } }) });
  yes(mock.st.streamSubscriptions >= 2, 'stream.online/offline abonniert');
  await gsiStats(3, 1);
  mock.stream(true);
  await waitFor(async () => (await st()).state.stats?.active, 5000, 'Sitzung startet mit dem Stream');
  const sx = await api('stats');
  eq(sx.json.state.session.source, 'stream');
  await gsiStats(3, 1); await gsiStats(4, 1);
  const nEv = events.length;
  const id = await redeemFree('WASD invertiert', 'Folterknecht');
  await waitFor(() => events.slice(nEv).some((e) => e.type === 'fx' && e.fx.type === 'alert' && e.fx.title === 'WASD invertiert'), 5000, 'Effekt läuft');
  await gsiStats(4, 2, 0);
  await done(id).catch(() => {});
  await waitFor(async () => (await api('stats')).json.totals.deaths === 1, 4000, 'Tod gezählt');
  const s1 = (await api('stats')).json;
  eq(JSON.stringify([s1.totals.kills, s1.totals.deathsChaos, s1.timeline[0].viewer, s1.timeline[0].effect]), '[1,1,"Folterknecht","WASD invertiert"]');
  eq(s1.torture[0]?.name, 'Folterknecht');
  mock.chat({ text: '!fail', user: 'zuschauer' });
  mock.chat({ text: '!fail', user: 'modkatze', mod: true });
  await waitFor(async () => (await api('stats')).json.totals.fails === 1, 4000, 'Mod-Fail');
  await sleep(400); eq((await api('stats')).json.totals.fails, 1, 'normaler Zuschauer darf nicht');
  eq((await api('stats/adjust', { stat: 'kills', delta: 1 })).json.ok, true);
  eq((await api('stats/correct', { id: s1.timeline[0].id, cause: 'natural' })).json.ok, true);
  eq((await api('stats')).json.totals.deathsNatural, 1);
  const csvRes = await fetch(`${base}/api/stats/csv?id=${s1.sessionId}`, { headers: { 'x-admin-token': cfg.server.adminToken } });
  const csvText = await csvRes.text();
  yes(csvRes.ok && csvText.includes('modkatze') && csvText.includes(';fail;') && csvText.includes(';death;'), `CSV-Export (${csvRes.status}): ${csvText.slice(0, 300)}`);
  eq((await api('stats/config', { show: ['kills', 'nope'] })).status, 400, 'unbekannter Wert in show abgelehnt');
  eq((await api('stats/config', { show: ['deaths', 'kills', 'roundsWon'], chaosWindowSec: 8 })).json.stats.chaosWindowSec, 8);
  mock.stream(false);
  await waitFor(async () => !(await st()).state.stats?.active, 5000, 'Sitzung endet mit dem Stream');
  const hist = (await api('stats')).json.history;
  eq(hist[0].endReason, 'stream_offline');
  // Nach Ende: Fail ohne Sitzung wird abgelehnt, GSI zählt nichts
  eq((await api('stats/fail', {})).status, 409);
});
await t('Fail-Hotkey läuft im Not-Aus-Hilfsskript mit, meldet über die Standardausgabe; prüfbar, abschaltbar, nie gleich dem Not-Aus', async () => {
  const ahkSrc = fs.readFileSync(path.join(ROOT, 'ahk', 'panic.ahk'), 'utf8');
  yes(/Hotkey A_Args\[1\], \(\*\) => ExitApp\(42\)/.test(ahkSrc), 'Not-Aus unverändert');
  yes(/A_Args\.Length >= 2 && A_Args\[2\] != ""/.test(ahkSrc) && /FileAppend\("fail`n", "\*"\)/.test(ahkSrc), 'Fail-Hotkey meldet "fail" auf stdout');
  const br = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  yes(/cfg\.bridge\.panicHotkey, failKey\]/.test(br) && /line === 'fail'\) onFail\?\.\(\)/.test(br), 'Server liest die Meldung');
  eq((await api('stats/config', { failHotkey: cfg.bridge.panicHotkey })).status, 400, 'gleich dem Not-Aus abgelehnt');
  eq((await api('stats/config', { failHotkey: 'Strg+F' })).status, 400, 'ungültig abgelehnt');
  eq((await api('stats/config', { failHotkey: '^!g' })).json.failHotkey, '^!g');
  eq((await api('stats/config', { failHotkey: '' })).json.failHotkey, '', 'leer = aus');
  eq((await api('stats/config', { failHotkey: '^!f' })).json.failHotkey, '^!f');
  eq((await st()).bridge.failHotkey, '^!f');
});
await t('Dashboard-Bereich und Overlay-Panel "Session Stats" - Texte de/en vollständig, Layout-Panel, Design-Auswahl, keine harten Blitze', async () => {
  const dash = dashboardSource();
  const ovl = fs.readFileSync(path.join(ROOT, 'web', 'overlay.html'), 'utf8');
  const { stringsFor } = await import('../src/i18n.js');
  const flatJson = (f) => { const out = {}; const walk = (o, p) => { for (const [k, v] of Object.entries(o)) { if (v && typeof v === 'object') walk(v, p ? `${p}.${k}` : k); else out[p ? `${p}.${k}` : k] = v; } }; walk(JSON.parse(fs.readFileSync(path.join(ROOT, 'locale', f), 'utf8')), ''); return out; };
  const de = flatJson('de.json'), en = flatJson('en.json');
  const used = new Set([...`${dash}\n${ovl}`.matchAll(/['"]((?:dash|overlay)\.(?:st[A-Z]\w*|nav\.session|layoutStats))['"]/g)].map((m) => m[1]));
  yes(used.size > 60, `zu wenige Texte gefunden (${used.size})`);
  for (const k of used) { yes(de[k], `de fehlt: ${k}`); yes(en[k], `en fehlt: ${k}`); }
  eq(stringsFor('en')['dash.stTortureHeading'], 'Torture leaderboard');
  yes(/data-section="session"/.test(dash) && /data-nav="session"/.test(dash), 'Bereich und Navigation');
  for (const src of [dash, ovl, fs.readFileSync(path.join(ROOT, 'src', 'config.js'), 'utf8')]) yes(/LAYOUT_(?:EDITOR_DEFAULTS|PANELS)[^\n]*stats/.test(src), 'Panel "stats" im Layout');
  // Blitzschutz: im Stats-Teil des Overlays keine Endlos-/Stufen-Animation, nur sanfte Übergänge.
  const statsCss = ovl.slice(ovl.indexOf('/* ---- Session Stats'), ovl.indexOf('#conn {'));
  yes(statsCss.length > 500 && !/animation\s*:/.test(statsCss) && /prefers-reduced-motion/.test(statsCss), 'Overlay-Stats ohne Blitz-Animation');
  // Einstellungen über die API
  eq((await api('stats/config', { overlayTheme: 'neon' })).status, 400);
  const r = await api('stats/config', { overlayTheme: 'light', overlay: { torture: false } });
  eq(JSON.stringify([r.json.stats.overlayTheme, r.json.stats.overlay]), '["light",{"bar":true,"split":true,"torture":false,"popups":true}]');
  eq((await api('overlay/layout', { layout: { stats: { x: 2, y: 45, scale: 1.2 } } })).status, 200, 'Layout nimmt das Stats-Panel an');
  const s1 = (await st()).state;
  eq(JSON.stringify([s1.stats.overlayTheme, s1.overlay.layout.stats]), '["light",{"x":2,"y":45,"scale":1.2}]');
  await api('stats/config', { overlayTheme: 'unknown', overlay: { torture: true } });
  await api('overlay/layout', { layout: {} });
});
await t('Overlay-Fenster einzeln ausschalten: gespeichert, im Zustand, im Overlay ausgeblendet, alter "Verlauf anzeigen"-Schalter landet in derselben Liste', async () => {
  eq((await api('overlay/hidden', { hidden: ['queue', 'nope'] })).status, 400, 'unbekanntes Fenster abgelehnt');
  eq((await api('overlay/hidden', { hidden: 'queue' })).status, 400, 'keine Liste abgelehnt');
  const r = await api('overlay/hidden', { hidden: ['stats', 'queue', 'queue'] });
  eq(JSON.stringify(r.json.hidden), '["queue","stats"]', 'Reihenfolge wie im Overlay, doppelt entfernt');
  eq(JSON.stringify((await st()).state.overlay.hidden), '["queue","stats"]');
  // alter Schalter (API bleibt kompatibel)
  await api('overlay', { accent: '#B026FF', sound: true, history: false, top: true, historyCount: 5, topCount: 5, topMode: 'both', topRotateSec: 12, reduceFlash: false });
  eq(JSON.stringify((await st()).state.overlay.hidden), '["queue","history","stats"]');
  await api('overlay', { accent: '#B026FF', sound: true, history: true, top: true, historyCount: 5, topCount: 5, topMode: 'both', topRotateSec: 12, reduceFlash: false });
  const ovl = fs.readFileSync(path.join(ROOT, 'web', 'overlay.html'), 'utf8');
  for (const id of ['chaos', 'queue', 'history', 'hall', 'effect', 'season', 'stats']) yes(ovl.includes(`body.off-${id} #${id}`), `CSS für ${id}`);
  yes(/classList\.toggle\('off-' \+ id/.test(ovl), 'Overlay setzt die Klassen aus dem Zustand');
  eq((await api('overlay/hidden', { hidden: [] })).json.hidden.length, 0);
});
await t('Mini-Ansicht: einzelner Effekt lässt sich aus der Warteliste nehmen (Punkte zurück); Ansicht im selben Fenster statt Zusatzfenster', async () => {
  await gsiPost('freezetime'); // Runde läuft nicht -> der Effekt wartet in der Warteliste
  await sleep(300);
  const id = await redeemFree('WASD invertiert', 'Wartender');
  await waitFor(async () => (await st()).state.queue.some((q) => q.user === 'Wartender'), 4000, 'wartet in der Warteliste');
  const q = (await st()).state.queue.find((x) => x.user === 'Wartender');
  yes(Number.isInteger(q.qid) && q.qid > 0, 'Eintrag hat eine Nummer');
  eq((await api('queue/remove', { qid: q.qid })).status, 200);
  await done(id, 'CANCELED');
  eq((await st()).state.queue.some((x) => x.user === 'Wartender'), false);
  eq((await api('queue/remove', { qid: q.qid })).status, 404, 'zweites Mal: nicht mehr da');
  await gsiPost('live');
  const dash = dashboardSource();
  yes(!/window\.open\(/.test(dash), 'kein zweites Fenster mehr');
  yes(/id="miniView"/.test(dash) && /body\.mini \.wrap > :not\(#miniView\)/.test(dash), 'Mini-Ansicht im selben Fenster');
});
await t('Bits-Menü (Regeln): Stichwort, Preis und Abrechnung je Punkt, Blöcke bis zur Obergrenze, Topf, Roulette, Cheermotes zählen nicht', async () => {
  const { planCheer, findKeyword, normalizeBitsMenu, BITS_MENU_DEFAULT, menuAction, menuChatText, menuEntries, rouletteSeq } = await import('../src/bits-menu.js');
  const menu = normalizeBitsMenu(BITS_MENU_DEFAULT);
  const P = (bits, msg, m = menu, r = Math.random) => planCheer(m, bits, msg, r);
  eq(JSON.stringify(P(300, 'Cheer300 maus bitte').blocks.map((b) => [b.key, b.unit, b.units, b.chosenBy])), '[["mouse","minute",3,"keyword"]]');
  eq(JSON.stringify(P(99, 'Cheer99 maus')), '{"blocks":[],"pot":99}', 'zu wenig: in den Topf statt verloren');
  eq(JSON.stringify(P(1250, 'WASD!!').blocks.map((b) => b.units)), '[5,5,2]', '12 Minuten = Blöcke 5+5+2');
  eq(findKeyword('Cheer100 Shift100', menuEntries(menu)), null, 'Cheermote "Shift100" ist kein Stichwort');
  eq(findKeyword('Cheer100 fadenkreuz', menuEntries(menu)), null, 'ausgeschalteter Effekt zählt nicht');
  eq(P(200, 'hallo', menu, () => 0).blocks[0].chosenBy, 'random');
  eq(JSON.stringify(P(200, 'hallo', { ...menu, noKeyword: 'none' })), '{"blocks":[],"pot":200}');
  eq(P(200, 'hallo', { ...menu, noKeyword: 'wasd' }).blocks[0].key, 'wasd', 'fester Standard-Effekt ohne Stichwort');
  eq(P(500, 'maus', { ...menu, enabled: false }).blocks.length, 0);
  eq(P(300, 'Cheer300 topf').pot, 300, 'Topf-Stichwort');
  // Preis und Abrechnung je Punkt
  const m2 = normalizeBitsMenu({ ...BITS_MENU_DEFAULT, items: BITS_MENU_DEFAULT.items.map((x) => (x.id === 'mouse' ? { ...x, price: 250, unit: 'round' } : x.id === 'challenge' ? { ...x, enabled: true } : x)) });
  eq(JSON.stringify(P(600, 'maus', m2).blocks.map((b) => [b.unit, b.units])), '[["round",2]]', '600 Bits bei 250/Runde = 2 Runden');
  eq(JSON.stringify(P(1000, 'challenge', m2).blocks.map((b) => [b.unit, b.units])), '[["once",2]]');
  eq(P(200, 'hallo', m2, () => 0.999).blocks[0]?.key !== 'challenge', true, 'zufällig nur, was man sich leisten kann');
  // eigene Effekte
  const m3 = normalizeBitsMenu({ ...BITS_MENU_DEFAULT, custom: [{ actionId: 'jump_spam', keyword: 'hops', price: 150 }] });
  eq(JSON.stringify(P(300, 'hops', m3).blocks.map((b) => [b.key, b.unit, b.units])), '[["act:jump_spam","once",2]]');
  // Roulette: nie zweimal hintereinander
  const seq = rouletteSeq(40);
  yes(seq.every((x, k) => x !== seq[k - 1]), 'Roulette ohne Wiederholung direkt hintereinander');
  // Prüfungen der Einstellungen
  for (const bad of [{ bitsPerMinute: 0 }, { maxMinutes: 60 }, { noKeyword: 'x' }, { items: [{ id: 'walk', keyword: 'maus' }, { id: 'mouse', keyword: 'maus' }] }, { items: [{ id: 'nope', keyword: 'x1' }] }, { items: [{ id: 'walk', keyword: 'zwei worte' }] },
    { pot: { keyword: 'maus' } }, { custom: [{ actionId: '../x', keyword: 'aa' }] }, { maxPerStream: -1 }]) {
    let threw = false; try { normalizeBitsMenu({ ...BITS_MENU_DEFAULT, ...bad }); } catch { threw = true; }
    yes(threw, `ungültig: ${JSON.stringify(bad)}`);
  }
  // Jede Vorlage ist mit der CS2-Belegung gültig - je Abschnitt, auch als Runde und jede Eskalationsstufe
  const { compile } = await import('../src/steps.js');
  for (const id of ['walk', 'mouse', 'wasd', 'crosshair', 'buylock', 'escalate', 'roulette']) for (const part of [0, 2, 4, 7]) compile(menuAction(id, 60000, 5, 'de', { part, seq: ['mouse', 'wasd', 'crosshair', 'walk', 'mouse'] }).effect.steps, cfg.keys);
  for (const id of ['mouse', 'wasd', 'crosshair', 'buylock']) yes(menuAction(id, 60000, 2, 'de', { unit: 'round' }).effect.steps.includes('until_stop'), `${id} als Runde`);
  yes(/maus \(Maus invertiert, 100 Bits\/Min\.\)/.test(menuChatText(menu, 'de')) && /Gemeinschaftstopf/.test(menuChatText(menu, 'de')), menuChatText(menu, 'de'));
});
await t('Bits-Menü im Server: Cheer mit Stichwort läuft in Abschnitten, Tod unterbricht und der Rest läuft in der nächsten Runde weiter, Chaos zählt pro Minute', async () => {
  eq((await api('bitsmenu', { enabled: true, items: [{ id: 'walk', keyword: 'maus' }] })).status, 400, 'doppeltes Stichwort abgelehnt');
  const r = await api('bitsmenu', { enabled: true, bitsPerMinute: 100, maxMinutes: 5 });
  eq(r.json.bitsMenu.enabled, true);
  eq((await st()).bitsMenu.templates.wasd.title, 'WASD invertiert');
  await gsiPost('live');
  const n0 = events.length;
  mock.cheer({ bits: 200, user: 'Bitsfan', message: 'Cheer200 wasd' });
  await waitFor(() => events.slice(n0).some((e) => e.type === 'fx' && e.fx.type === 'alert' && /WASD invertiert · 2 Min\./.test(e.fx.title)), 5000, 'erster Abschnitt startet');
  // Mitten im ersten Abschnitt sterben -> Rest bleibt gut
  await sleep(200);
  await gsiPost('live', { health: 0 });
  await waitFor(async () => (await st()).state.queue.some((q) => q.user === 'Bitsfan'), 5000, 'Rest wartet vorne in der Warteliste');
  await sleep(1500);
  eq((await st()).state.current, null, 'solange nicht gespielt wird, läuft nichts');
  await gsiPost('live');
  await waitFor(() => events.slice(n0).some((e) => e.type === 'fx' && e.fx.type === 'alert' && /WASD invertiert · noch /.test(e.fx.title)), 6000, 'Rest läuft in der nächsten Runde weiter');
  // Zwischen zwei Abschnitten ist der Eintrag kurz weder aktiv noch in der Warteliste - deshalb auf den Verlauf warten.
  await waitFor(async () => (await st()).recent.some((x) => x.user_name === 'Bitsfan' && x.status === 'done'), 15000, 'alles abgelaufen');
  const rec = (await st()).recent.filter((x) => x.user_name === 'Bitsfan');
  eq(rec.length, 1, 'ein Eintrag im Verlauf, nicht einer je Abschnitt');
  eq(rec[0].status, 'done');
  // Zu wenig Bits: nichts
  const n1 = events.length;
  mock.cheer({ bits: 50, user: 'Kleinfan', message: 'Cheer50 maus' });
  await sleep(800);
  eq(events.slice(n1).some((e) => e.type === 'fx' && e.fx.type === 'alert'), false);
  await api('bitsmenu', { enabled: false });
});
await t('Bits-Menü erweitert: Abrechnung nach Runden, eigene Effekte, Gemeinschaftstopf, Herausforderung, Obergrenze pro Stream', async () => {
  const g = (phase, { health = 100, kills = 0 } = {}) => fetch(`${base}/gsi`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    provider: { steamid: '765' }, auth: { token: cfg.server.gsiToken }, map: { name: 'de_mirage', mode: 'casual' }, round: { phase },
    player: { steamid: '765', activity: 'playing', state: { health }, match_stats: { kills }, weapons: { w0: { name: 'weapon_glock', type: 'Pistol', state: 'active' } } } }) });
  const before = (await st()).bitsMenu;
  const items = before.items.map((x) => (x.id === 'mouse' ? { ...x, enabled: true, unit: 'round', price: 100 } : x.id === 'challenge' ? { ...x, enabled: true, price: 100 } : x));
  let r = await api('bitsmenu', { enabled: true, items, custom: [{ actionId: 'jump_spam', keyword: 'hops', price: 100 }], challenge: { kills: 2, minutes: 5, weapon: 'pistol' },
    pot: { enabled: true, goal: 50, keyword: 'topf', effect: 'walk', minutes: 1 }, noKeyword: 'none', maxPerStream: 0 });
  eq(r.status, 200, JSON.stringify(r.json));
  await api('bits/credit/settings', { autoResume: false });
  const n0 = events.length;
  const alerts = () => events.slice(n0).filter((e) => e.type === 'fx' && e.fx.type === 'alert').map((e) => e.fx.title);
  const doneFor = (u) => waitFor(async () => (await st()).recent.some((x) => x.user_name === u && x.status === 'done'), 15000, `${u} fertig`);
  // 1) Zwei Runden "Maus invertiert": jede Runde zählt eine Einheit
  await g('live');
  mock.cheer({ bits: 200, user: 'Rundenfan', message: 'Cheer200 maus' });
  await waitFor(() => alerts().some((t) => /Maus invertiert · Runde 1\/2/.test(t)), 5000, 'Runde 1');
  const stage = (await st()).state.bitsStage;
  yes(stage.current?.user === 'Rundenfan' && stage.current.left === 2 && stage.current.total === 2 && stage.top?.name, `Bits-Bühne: ${JSON.stringify(stage)}`);
  yes(events.slice(n0).some((e) => e.type === 'fx' && e.fx.type === 'alert' && e.fx.bits === 200), 'Alert kennt den Betrag');
  await sleep(300); await g('over');
  await waitFor(async () => (await st()).state.queue.some((q) => q.user === 'Rundenfan'), 4000, 'zweite Runde wartet');
  await g('live');
  await waitFor(() => alerts().some((t) => /Runde 2\/2/.test(t)), 5000, 'Runde 2');
  await sleep(300); await g('over'); await g('live');
  await doneFor('Rundenfan');
  // 2) Eigener Effekt aus dem Baukasten im Menü
  await g('live');
  mock.cheer({ bits: 100, user: 'Hopsfan', message: 'Cheer100 hops' });
  await doneFor('Hopsfan');
  // 3) Gemeinschaftstopf: Stichwort + zu kleiner Cheer füllen ihn, voll -> Effekt für alle
  await g('live');
  mock.cheer({ bits: 30, user: 'Topf1', message: 'Cheer30 topf' });
  await waitFor(async () => (await st()).state.bitsPot?.have === 30, 3000, 'Topf 30');
  mock.cheer({ bits: 25, user: 'Topf2', message: 'Cheer25 hallo' });
  await waitFor(async () => (await st()).state.bitsPot?.have === 5, 3000, 'Topf voll und Rest bleibt');
  yes(events.slice(n0).some((e) => e.type === 'fx' && e.fx.type === 'pot_full' && e.fx.names.includes('Topf1')), 'Topf-voll-Auftritt mit Namen');
  await doneFor('Community');
  // 4) Herausforderung: 2 Pistolen-Kills
  await g('live'); // Spielzustand frisch halten (sonst gilt CS2 als nicht verbunden)
  mock.cheer({ bits: 100, user: 'Challenger', message: 'Cheer100 challenge' });
  await waitFor(async () => (await st()).state.challenge?.goal === 2, 5000, 'Herausforderung läuft');
  await g('live', { kills: 1 }); await sleep(150); await g('live', { kills: 2 });
  await waitFor(async () => (await st()).state.challenge?.result === 'won', 5000, 'geschafft');
  await doneFor('Challenger');
  // 5) Obergrenze pro Stream: der Rest geht in den Topf
  await api('bitsmenu', { maxPerStream: 1, pot: { enabled: true, goal: 10000, keyword: 'topf', effect: 'walk', minutes: 1 } });
  const potBefore = (await st()).state.bitsPot.have;
  mock.cheer({ bits: 300, user: 'Grenzfan', message: 'Cheer300 maus' });
  await waitFor(async () => (await st()).state.bitsPot.have === potBefore + 200, 4000, 'Überschuss (2 von 3 Runden) im Topf');
  yes((await st()).state.queue.some((q) => q.user === 'Grenzfan') || (await st()).state.current?.user === 'Grenzfan', 'eine Runde läuft');
  await api('clear', {});
  for (const c of (await st()).state.bitsCredit) await api('bits/credit/drop', { id: c.id });
  // Aufräumen
  await api('bitsmenu', { enabled: before.enabled, items: before.items, custom: [], maxPerStream: 0, noKeyword: 'random', pot: before.pot, challenge: before.challenge });
  await api('bits/credit/settings', { autoResume: true });
  await gsiPost('live');
});
await t('Bits-Guthaben: nichts Bezahltes geht verloren - Pause, Not-Aus und Neustart werden gutgeschrieben, Fortsetzen von Hand und automatisch', async () => {
  const credits = async () => (await st()).state.bitsCredit || [];
  const mine = async (u) => (await credits()).filter((c) => c.user === u);
  await gsiPost('live');
  const bmWas = (await st()).bitsMenu.enabled;
  await api('bitsmenu', { enabled: true });
  eq((await api('bits/credit/settings', { autoResume: false })).json.bitsCredit.autoResume, false);
  // 1) Cheer während Pause -> Guthaben (läuft von selbst weiter, sobald erlaubt)
  await api('pause', { paused: true });
  mock.cheer({ bits: 200, user: 'Guthaben1', message: 'Cheer200 wasd' });
  const c1 = (await waitFor(async () => (await mine('Guthaben1')).length && mine('Guthaben1'), 4000, 'Guthaben angelegt'))[0];
  eq(JSON.stringify([c1.kind, c1.remainingMs, c1.auto]), '["menu",120000,true]');
  yes(/WASD/i.test(c1.title), `Titel: ${c1.title}`);
  await api('pause', { paused: false });
  await sleep(500);
  eq((await mine('Guthaben1')).length, 1, 'ohne automatisches Fortsetzen bleibt es liegen');
  // 2) von Hand einreihen -> läuft und verschwindet
  eq((await api('bits/credit/resume', { id: c1.id })).status, 200);
  eq((await api('bits/credit/resume', { id: c1.id })).status, 409, 'zweimal geht nicht');
  await waitFor(async () => !(await mine('Guthaben1')).length && (await st()).recent.some((x) => x.user_name === 'Guthaben1' && x.status === 'done'), 15000, 'Guthaben gelaufen');
  // 3) Not-Aus mitten im Effekt -> Restzeit wartet auf den Streamer
  mock.cheer({ bits: 100, user: 'Guthaben2', message: 'Cheer100 shift' });
  await waitFor(async () => (await st()).state.current?.user === 'Guthaben2', 6000, 'läuft');
  await sleep(200);
  await api('panic', {});
  const c2 = (await waitFor(async () => (await mine('Guthaben2')).length && mine('Guthaben2'), 4000, 'Not-Aus -> Guthaben'))[0];
  yes(!c2.auto && c2.remainingMs > 2000 && c2.remainingMs < 60000, `Restzeit nach Not-Aus: ${JSON.stringify(c2)}`);
  await api('pause', { paused: false });
  eq((await api('bits/credit/drop', { id: c2.id })).status, 200);
  eq((await api('bits/credit/drop', { id: c2.id })).status, 404);
  eq((await mine('Guthaben2')).length, 0);
  // 4) automatisch fortsetzen, sobald der Stream läuft
  await api('bits/credit/settings', { autoResume: true });
  await api('pause', { paused: true });
  mock.cheer({ bits: 100, user: 'Guthaben3', message: 'Cheer100 maus' });
  await waitFor(async () => (await mine('Guthaben3')).length, 4000, 'Guthaben 3');
  await api('pause', { paused: false });
  mock.stream(true);
  await waitFor(async () => (await st()).recent.some((x) => x.user_name === 'Guthaben3' && x.status === 'done'), 20000, 'automatisch fortgesetzt und gelaufen');
  eq((await mine('Guthaben3')).length, 0);
  mock.stream(false);
  await api('bitsmenu', { enabled: bmWas });
  // 5) Neustart/Absturz: was in der Warteliste stand, wird Guthaben
  const db = openStatsDb(path.join(tmp, 'credit.db'));
  const id = db.creditAdd({ userId: 'u1', userName: 'X', kind: 'menu', effectId: 'walk', minutes: 2, remainingMs: 90000 });
  eq(db.creditList().length, 0, 'in der Warteliste ist es noch kein Guthaben');
  eq(db.creditRecoverPending('Neustart'), 1);
  eq(JSON.stringify(db.creditList().map((c) => [c.id, c.remainingMs, c.state, c.auto])), JSON.stringify([[id, 90000, 'credit', true]]));
  db.close();
  const dash = dashboardSource();
  yes(/id="creditCard"/.test(dash) && /bits\/credit\/resume/.test(dash), 'Guthaben im Dashboard');
});
await t('Bits-Vorrang: Bits sind als Nächstes dran, Kanalpunkte-Schutz nach 2 Bits und nach zu langer Wartezeit', async () => {
  await gsiPost('live');
  const bmWas = (await st()).bitsMenu.enabled;
  await api('bitsmenu', { enabled: true });
  await api('bits/credit/settings', { autoResume: false });
  eq((await api('queuepolicy', { maxQueue: 10, queueWaitSec: 0, bitsPriority: { enabled: true, maxInRow: 2, maxWaitSec: 1800 } })).status, 200);
  eq((await api('queuepolicy', { bitsPriority: { maxInRow: 0 } })).status, 400, 'ungültige Anzahl abgelehnt');
  // Ein Kanalpunkte-Effekt läuft zuerst: setzt die Bits-Folge zurück.
  const p0 = await redeemFree('Feuerpause', 'VorrangP0');
  await done(p0, 'FULFILLED');
  await gsiPost('freezetime'); // keine laufende Runde: alles wartet
  await sleep(300);
  await redeemFree('WASD invertiert', 'VorrangP1');
  await redeemFree('Pistol Only', 'VorrangP2');
  for (const u of ['VorrangB1', 'VorrangB2', 'VorrangB3']) { mock.cheer({ bits: 100, user: u, message: 'Cheer100 shift' }); await sleep(150); }
  const order = async () => (await st()).state.queue.map((q) => q.user).filter((u) => u.startsWith('Vorrang'));
  await waitFor(async () => (await order()).length === 5, 6000, 'alle fünf in der Warteliste');
  eq((await order()).join(','), 'VorrangB1,VorrangB2,VorrangP1,VorrangB3,VorrangP2', 'Bits zuerst, nach 2 Bits ein Kanalpunkte-Effekt');
  yes((await st()).state.queue.filter((q) => q.user.startsWith('VorrangB')).every((q) => q.bits), 'Bits-Einträge sind markiert');
  // Zu lange gewartet (30 s x 0,02 = 0,6 s): Kanalpunkte rücken nach vorne
  await api('queuepolicy', { bitsPriority: { maxWaitSec: 30 } });
  await waitFor(async () => (await order()).join(',') === 'VorrangP1,VorrangP2,VorrangB1,VorrangB2,VorrangB3', 4000, 'überfällige Kanalpunkte zuerst');
  // Ausgeschaltet: wieder der Reihe nach wie eingegangen (bestehende Reihenfolge bleibt)
  await api('queuepolicy', { bitsPriority: { enabled: false, maxWaitSec: 180 } });
  await api('clear', {});
  await sleep(300);
  for (const c of (await st()).state.bitsCredit.filter((x) => x.user.startsWith('VorrangB'))) await api('bits/credit/drop', { id: c.id });
  await api('queuepolicy', { bitsPriority: { enabled: true } });
  await api('bitsmenu', { enabled: bmWas });
  await api('bits/credit/settings', { autoResume: true });
  await gsiPost('live');
  const ovl = fs.readFileSync(path.join(ROOT, 'web', 'overlay.html'), 'utf8');
  yes(/bits-badge/.test(ovl), 'Overlay markiert Bits-Einträge');
});
await t('Spielmodus-Sperre: in Competitive laufen keine Effekte, Kanalpunkte zurück, Bits gutgeschrieben; Casual läuft normal', async () => {
  const gsiMode = (mode) => fetch(`${base}/gsi`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    provider: { steamid: '765' }, auth: { token: cfg.server.gsiToken }, map: { name: 'de_mirage', mode }, round: { phase: 'live' },
    player: { steamid: '765', activity: 'playing', state: { health: 100 }, weapons: { w0: { name: 'weapon_knife', type: 'Knife', state: 'active' } } } }) });
  const s0 = await st();
  eq(JSON.stringify(s0.modeLock.blocked), '["competitive","scrimcomp2v2","premier"]', 'Standard: Competitive, Wingman, Premier gesperrt');
  yes(s0.modeLock.enabled && s0.modeLock.modes.includes('deathmatch'));
  eq((await api('modelock', { blocked: ['Comp etitive'] })).status, 400, 'Unsinn abgelehnt');
  await gsiMode('competitive');
  await waitFor(async () => (await st()).state.game.blockedMode === 'competitive', 3000, 'gesperrt erkannt');
  // Kanalpunkte: sofort erstattet mit klarem Grund (ein noch laufender Cooldown wird abgewartet)
  await waitFor(async () => {
    const id = redeem('Kein Zoom', 'ModusP');
    await done(id, 'CANCELED');
    return (await st()).recent.some((x) => x.user_name === 'ModusP' && /Spielmodus/.test(x.reason || ''));
  }, 30000, 'Kanalpunkte mit Grund Spielmodus erstattet');
  const bmWas = (await st()).bitsMenu.enabled;
  await api('bitsmenu', { enabled: true });
  mock.cheer({ bits: 100, user: 'ModusB', message: 'Cheer100 shift' });
  await waitFor(async () => (await st()).state.bitsCredit.some((c) => c.user === 'ModusB' && /Spielmodus/.test(c.reason)), 5000, 'Bits gutgeschrieben');
  // Sperre aus -> läuft in Competitive
  await api('modelock', { enabled: false });
  eq((await st()).state.game.blockedMode, null);
  await api('modelock', { enabled: true });
  await gsiMode('casual');
  await waitFor(async () => (await st()).state.game.blockedMode === null, 3000, 'Casual frei');
  const c = (await st()).state.bitsCredit.find((x) => x.user === 'ModusB');
  await api('bits/credit/resume', { id: c.id });
  await waitFor(async () => (await st()).recent.some((x) => x.user_name === 'ModusB' && x.status === 'done'), 15000, 'läuft in Casual');
  await api('bitsmenu', { enabled: bmWas });
  await gsiPost('live');
});
await t('Zuschauer: sperren (Kanalpunkte zurück, Bits als Guthaben) und Daten löschen', async () => {
  await gsiPost('live');
  // Einen Zuschauer bekannt machen
  const id1 = await redeemFree('Sprung-Spam', 'Sperrkandidat');
  await done(id1, 'FULFILLED');
  let r = (await api('viewers?q=sperrkand')).json;
  const v = r.viewers.find((x) => x.name === 'Sperrkandidat');
  yes(v && v.count >= 1 && !v.blocked, `Suche findet ihn: ${JSON.stringify(r)}`);
  eq((await api('viewers/block', { id: 'anon', blocked: true })).status, 400);
  eq((await api('viewers/block', { id: v.id, name: v.name, blocked: true })).status, 200);
  r = (await api('viewers?q=')).json;
  yes(r.blocked.some((x) => x.id === v.id) && r.viewers.find((x) => x.id === v.id)?.blocked, 'steht auf der Sperrliste');
  // Kanalpunkte: sofort zurück
  const id2 = redeem('Ducken-Spam', 'Sperrkandidat');
  await done(id2, 'CANCELED');
  yes((await st()).recent.some((x) => x.user_name === 'Sperrkandidat' && x.reason === 'Zuschauer ist gesperrt'), 'Grund gesperrt');
  // Bits: landen als Guthaben beim Streamer
  const bmWas = (await st()).bitsMenu.enabled;
  await api('bitsmenu', { enabled: true });
  mock.cheer({ bits: 100, user: 'Sperrkandidat', userId: v.id, message: 'Cheer100 shift' });
  await waitFor(async () => (await st()).state.bitsCredit.some((c) => c.user === 'Sperrkandidat' && !c.auto), 4000, 'Bits als Guthaben');
  await api('bitsmenu', { enabled: bmWas });
  // Daten löschen
  eq((await api('viewers/delete', { id: v.id })).status, 200);
  r = (await api('viewers?q=sperrkand')).json;
  eq(r.viewers.length, 0, 'nichts mehr gespeichert');
  yes(!(await st()).state.bitsCredit.some((c) => c.user === 'Sperrkandidat'), 'Guthaben weg');
  yes(!(await st()).recent.some((x) => x.user_name === 'Sperrkandidat'), 'Verlauf weg');
  await api('viewers/block', { id: v.id, blocked: false });
  eq((await api('viewers?q=')).json.blocked.length, 0);
});
await t('Twitch-Login verschlüsselt speichern: alte Datei wird umgestellt, fremde Datei gilt als abgemeldet', async () => {
  const dir = path.join(tmp, 'tokcrypt');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'tokens.json');
  fs.writeFileSync(f, JSON.stringify({ accessToken: 'GEHEIM_AT', refreshToken: 'GEHEIM_RT', expiresAt: 1 }));
  const code = "import('./src/config.js').then((m) => process.stdout.write(JSON.stringify(m.loadTokens())))";
  let r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', code], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, UCC_DATA_DIR: dir, UCC_TEST_TOKEN_CRYPT: '1' } });
  eq(JSON.parse(r.stdout).refreshToken, 'GEHEIM_RT', r.stderr);
  const text = fs.readFileSync(f, 'utf8');
  yes(/"protected"/.test(text) && !text.includes('GEHEIM'), 'Datei ist danach verschlüsselt');
  r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', code], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, UCC_DATA_DIR: dir, UCC_TEST_TOKEN_CRYPT: '1' } });
  eq(JSON.parse(r.stdout).accessToken, 'GEHEIM_AT', 'wieder lesbar');
  // Ohne den passenden Schlüssel (anderer PC / anderes Konto): kein Absturz, nur abgemeldet
  r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', code], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, UCC_DATA_DIR: dir, UCC_TEST_TOKEN_CRYPT: '0' } });
  eq(r.stdout, 'null', r.stderr);
});
await t('Baukasten: neue Bausteine, zufällig einer, Wiederholen, bis Rundenende, Klartext, vorhandener Effekt mit Länge', async () => {
  const B = await import('../src/effect-builder.js');
  const { compile } = await import('../src/steps.js');
  const keys = cfg.keys;
  const ok = (spec, ctx = { profile: 'cs2' }) => { const r = B.buildEffect(spec, ctx); for (const l of r.effect.variants || [r.effect.steps]) compile(l, keys, { critical: cfg.input?.criticalKeys || [] }); return r; };
  for (const mode of ['fire', 'zoom', 'mouseinv', 'xhhide', 'xhbig']) {
    const r = ok({ blocks: [{ mode, ms: 4000 }] });
    yes(r.effect.steps.some((l) => l.startsWith('oncleanup')), `${mode}: räumt auch beim Abbruch auf`);
  }
  let r = ok({ blocks: [{ mode: 'block', key: 'jump', ms: 3000 }, { mode: 'xhhide', round: true }] });
  eq(r.effect.steps.at(-2), 'until_stop', 'bis Rundenende am Ende');
  let err = (() => { try { B.buildEffect({ blocks: [{ mode: 'xhhide', round: true }, { mode: 'block', key: 'jump' }] }, { profile: 'cs2' }); } catch (e) { return e.message; } })();
  yes(/letzten/.test(err || ''), `bis Rundenende nur am Ende: ${err}`);
  err = (() => { try { B.buildEffect({ blocks: [{ mode: 'hold', key: 'duck', round: true }] }, {}); } catch (e) { return e.message; } })();
  yes(/kann nicht bis Rundenende/.test(err || ''), err);
  err = (() => { try { B.buildEffect({ blocks: [{ mode: 'fire' }] }, { profile: 'fortnite' }); } catch (e) { return e.message; } })();
  yes(/nur für CS2/.test(err || ''), err);
  r = ok({ blocks: [{ mode: 'block', key: 'jump', ms: 2000 }, { mode: 'hold', key: 'duck', ms: 2000 }], order: 'random' });
  eq(r.effect.variants.length, 2, 'zufällig einer = zwei Abläufe');
  r = ok({ blocks: [{ mode: 'block', key: 'jump', ms: 2000 }], repeat: 3 });
  eq(r.effect.steps[0], 'repeat 3');
  err = (() => { try { B.buildEffect({ blocks: [{ mode: 'block', key: 'jump', ms: 40000 }], repeat: 3 }, {}); } catch (e) { return e.message; } })();
  yes(/maximal 90 s/.test(err || ''), `Gesamtdauer begrenzt: ${err}`);
  // vorhandener Effekt, auf 50 % gekürzt
  const actions = new Map([['x', { id: 'x', title: 'Testeffekt', requires: ['live'], effect: { steps: ['release @jump', 'block @jump', 'wait 10000', 'unblock'] } }]]);
  r = ok({ blocks: [{ mode: 'original', from: 'x', scale: 0.5 }] }, { actions });
  yes(r.effect.steps.includes('wait 5000'), 'Länge halbiert');
  eq(B.describeSpec({ blocks: [{ mode: 'block', key: 'jump', ms: 3000 }, { mode: 'original', from: 'x', scale: 0.5 }], repeat: 2 }, { actions }), 'Springen ist 3 Sek. lang gesperrt, danach „Testeffekt“ (50 %) - das Ganze 2-mal.');
  eq(B.describeSpec({ blocks: [{ mode: 'xhhide', round: true }, { mode: 'mouseinv', ms: 5000 }], order: 'random' }, {}, 'en'), 'Randomly one of: no crosshair until the round ends or the mouse is inverted for 5 s.');
  yes(/gesperrt/.test(B.describeSteps(['release @jump', 'block @jump', 'wait 5000', 'unblock'])), 'mitgelieferte Abläufe in Klartext');
  // Fremde Felder im Bauplan werden verworfen (er wird gespeichert und wieder angezeigt)
  eq(JSON.stringify(B.normalizeSpec({ blocks: [{ mode: 'block', key: 'jump', ms: 1000, evil: '<script>' }] }).blocks[0]), '{"mode":"block","key":"jump","ms":1000}');
});
await t('Effekte bearbeiten: Name, Texte, Farbe, Cooldown, Ablauf; Kopie; Original wiederherstellen; Teilen und Importieren', async () => {
  const s0 = await st();
  const a0 = s0.actions.find((a) => a.id === 'jump_spam');
  yes(a0 && a0.describe && !a0.custom && !a0.builder, `Klartext für mitgelieferte Effekte: ${a0?.describe}`);
  // Vorschau
  let pv = (await api('builder/preview', { builder: { blocks: [{ mode: 'original', from: 'jump_spam', scale: 1 }, { mode: 'xhbig', ms: 4000 }] }, self: { id: 'jump_spam', kind: 'points' } })).json;
  yes(pv.ok && /Fadenkreuz/.test(pv.text) && pv.ms > 4000, JSON.stringify(pv));
  pv = (await api('builder/preview', { builder: { blocks: [{ mode: 'block', key: 'LWin' }] } })).json;
  yes(!pv.ok && /Taste/.test(pv.error), 'unbekannte Taste abgelehnt');
  // bearbeiten
  let r = await api('action/update', { id: 'jump_spam', title: 'Hüpfburg', prompt: 'Lass mich hüpfen', flavor: 'Hüpf, hüpf!', color: '#00FF88', cooldownSec: 7, onDeath: 'continue', phase: 'any',
    builder: { blocks: [{ mode: 'original', from: 'jump_spam', scale: 0.5 }, { mode: 'xhbig', ms: 3000 }] } });
  eq(r.status, 200, JSON.stringify(r.json));
  let a = (await st()).actions.find((x) => x.id === 'jump_spam');
  eq(JSON.stringify([a.title, a.prompt, a.flavor, a.color, a.cooldownSec, a.onDeath, a.phase]), '["Hüpfburg","Lass mich hüpfen","Hüpf, hüpf!","#00FF88",7,"continue","any"]');
  yes(a.builder?.blocks?.length === 2 && /Fadenkreuz/.test(a.describe), `Ablauf gespeichert: ${a.describe}`);
  // Nochmal speichern mit demselben Bauplan: der Ablauf wächst nicht (Selbstbezug nutzt das Original)
  const len1 = a.describe.length;
  await api('action/update', { id: 'jump_spam', builder: a.builder });
  eq((await st()).actions.find((x) => x.id === 'jump_spam').describe.length, len1, 'kein Wachsen bei Selbstbezug');
  yes(mock.st.rewards.find((x) => x.title === 'Hüpfburg' && x.background_color === '#00FF88' && x.global_cooldown_seconds === 7), 'Twitch-Belohnung mit umbenannt, Farbe und Cooldown');
  eq((await api('action/update', { id: 'jump_spam', title: 'x'.repeat(46) })).status, 400);
  eq((await api('action/update', { id: 'jump_spam', color: 'rot' })).status, 400, 'ungültige Farbe');
  // Kopie: aus, eindeutiger Name, gleicher Ablauf
  r = await api('action/copy', { id: 'jump_spam' });
  eq(r.status, 200);
  const copy = (await st()).actions.find((x) => x.id === r.json.id);
  yes(copy.custom && !copy.enabled && copy.title === 'Hüpfburg (Kopie)', JSON.stringify(copy));
  eq((await api('action/copy', { id: 'jump_spam' })).json.title, 'Hüpfburg (Kopie 2)');
  // Teilen + Importieren
  const ex = (await api('action/export', { kind: 'points', id: copy.id })).json.data;
  eq(ex.format, 'chaoscore-effect');
  let im = await api('action/import', { kind: 'points', data: ex });
  yes(im.status === 200 && !im.json.committed && /Fadenkreuz/.test(im.json.describe), JSON.stringify(im.json));
  im = await api('action/import', { kind: 'points', data: ex, commit: true });
  const imp = (await st()).actions.find((x) => x.id === im.json.id);
  yes(imp && !imp.enabled && imp.custom, 'importiert und zunächst aus');
  // Gefährliche Datei: rohe Windows-Taste, unbekanntes Feld, falsches Format
  const bad = structuredClone(ex); bad.action.effect = { steps: ['press LWin'] };
  yes(/nicht übernommen/.test((await api('action/import', { kind: 'points', data: bad })).json.error || ''), 'rohe kritische Taste abgelehnt');
  const bad2 = structuredClone(ex); bad2.action.access = 'everyone'; bad2.action.hack = 1;
  eq((await api('action/import', { kind: 'points', data: bad2 })).status, 400);
  eq((await api('action/import', { kind: 'bits', data: ex })).status, 400, 'falsche Art');
  // Original wiederherstellen
  eq((await api('action/restore', { id: copy.id })).status, 400, 'eigene Aktion hat kein Original');
  eq((await api('action/restore', { id: 'jump_spam' })).status, 200);
  a = (await st()).actions.find((x) => x.id === 'jump_spam');
  yes(a.title !== 'Hüpfburg' && !a.color && a.cooldownSec === null && !a.builder && a.phase === 'live' && a.onDeath === 'stop', JSON.stringify(a));
  // Erfolg: erste Einlösung eines eigenen Effekts
  await api('action', { id: copy.id, enabled: true });
  await gsiPost('live');
  const mid = await redeemFree('Hüpfburg (Kopie)', 'Erfolgsfan');
  await done(mid, 'FULFILLED');
  await waitFor(async () => (await st()).state.milestones.some((m) => m.id === copy.id && m.n === 1), 4000, 'Erfolg gemeldet');
  // Aufräumen
  for (const id of [copy.id, imp.id, ...(await st()).actions.filter((x) => /Hüpfburg \(Kopie/.test(x.title)).map((x) => x.id)]) await api('action/delete', { id });
  // Testlauf eines noch nicht gespeicherten Effekts
  eq((await api('builder/test', { builder: { blocks: [{ mode: 'block', key: 'jump', ms: 1000 }, { mode: 'hold', key: 'duck', ms: 1000 }], order: 'random' }, title: 'Probe' })).status, 200);
  await waitFor(async () => (await st()).recent.length >= 0 && !(await st()).state.queue.some((q) => q.title === 'Probe'), 8000, 'Testlauf durch');
  const dash = dashboardSource();
  yes(/id="fxDlg"/.test(dash) && /builder\/preview/.test(dash) && /action\/import/.test(dash), 'Editor im Dashboard');
});
await t('Highlight-Titel: 1.000 Momente ohne Doppel, je mindestens zwei echte Fakten, Anfänge wechseln', async () => {
  const { TitleMaker } = await import('../src/highlight-titles.js');
  let seed = 11; const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const users = ['NeonNacho', 'Kekskruemel', 'Folterknecht', 'zed', 'sven', 'alice', 'bob', 'Hopsfan', 'Pixelpirat', 'Kaffeekatze', 'Schattenwolf', 'Lumi'];
  const effects = ['WASD invertiert', 'Maus invertiert', 'Nur Schleichen', 'Fadenkreuz riesig', 'Pistol Only', 'Messer-Zeit', 'Feuerpause', 'Chaos-Eskalation'];
  for (const [locale, tone] of [['de', 'frech'], ['de', 'episch'], ['de', 'trocken'], ['en', 'frech']]) {
    const tm = new TitleMaker({ locale, tone, rand });
    const seen = new Set(); let few = 0;
    const starts = new Map();
    for (let i = 0; i < 1000; i++) {
      const m = { type: pick(['chaos_death', 'chaos_death', 'clutch', 'bits_big', 'streak', 'challenge', 'pot']), user: pick(users), effect: pick(effects), secs: 1 + Math.floor(rand() * 50),
        kills: 2 + Math.floor(rand() * 4), bits: pick([500, 1000]), round: 1 + Math.floor(rand() * 24), map: 'de_mirage', goal: 3, minutes: 5, result: rand() < 0.5 ? 'won' : 'lost', streamTime: `1:${String(i % 60).padStart(2, '0')}:00` };
      const title = tm.make(m);
      yes(!seen.has(title.toLowerCase()), `doppelt: ${title}`);
      seen.add(title.toLowerCase());
      yes(title.length <= 140, 'höchstens 140 Zeichen (Twitch-Marker)');
      const facts = [m.user, m.effect, String(m.secs), String(m.kills), String(m.bits), String(m.round), 'Mirage', `${m.minutes} `, m.streamTime].filter((f) => title.toLowerCase().includes(f.toLowerCase()));
      if (facts.length < 2) few++;
      const st2 = title.toLowerCase().split(' ').slice(0, 2).join(' ');
      starts.set(st2, (starts.get(st2) || 0) + 1);
    }
    eq(few, 0, `${locale}/${tone}: jeder Titel hat mindestens zwei Fakten`);
    yes(Math.max(...starts.values()) < 100, `${locale}/${tone}: kein Anfang in mehr als 10 % der Titel`);
  }
});
await t('Highlights: Momente zusammenfassen, Punkte, Marker und Clip im laufenden Stream, Liste mit VOD-Zeit, Export, Stream-Infos', async () => {
  // Einheit: Zusammenfassen und Schwellen (ohne Server)
  const { Highlights, normalizeHighlights } = await import('../src/highlights.js');
  const hdb = openStatsDb(path.join(tmp, 'hl.db'));
  const calls = [];
  const fakeTw = { hasScope: () => true, getStream: async () => ({ started_at: new Date(Date.now() - 600000).toISOString() }), createMarker: async (d) => { calls.push(['marker', d]); return { id: 'm1' }; }, createClip: async () => { calls.push(['clip']); return { id: 'c1', edit_url: 'https://clips.twitch.tv/c1/edit' }; }, getClip: async () => ({ url: 'https://clips.twitch.tv/c1' }) };
  const hcfg = { highlights: normalizeHighlights({}) };
  const h = new Highlights({ cfg: hcfg, db: hdb, twitch: fakeTw, gsi: { get: () => ({ round: 7, map: 'de_inferno' }) }, logger: { info() {}, warn() {} }, clipDelayMs: 10 });
  await h.setLive(true);
  h.add({ type: 'streak', kills: 3 }); // 2 Punkte - allein kein Marker
  await h.flushNow();
  eq(calls.length, 0, 'schwacher Moment: kein Marker');
  eq(hdb.highlightList().length, 1, 'aber in der Liste');
  h.add({ type: 'chaos_death', user: 'NeonNacho', effect: 'WASD invertiert', secs: 4 });
  h.add({ type: 'clutch', user: 'NeonNacho', effect: 'WASD invertiert', kills: 2 });
  h.add({ type: 'clutch', user: 'NeonNacho', effect: 'WASD invertiert', kills: 3 }); // ersetzt den 2er
  await h.flushNow();
  const last = hdb.highlightList()[0];
  eq(last.score, 6, 'Clutch 5 + 1 für den zweiten Moment');
  yes(/NeonNacho|WASD/.test(last.title) && last.offsetSec >= 590, `Titel mit Fakten und VOD-Zeit: ${last.title} @ ${last.offsetSec}`);
  eq(calls.filter((c) => c[0] === 'marker').length, 1, 'ein Marker für die zusammengefassten Momente');
  await sleep(400);
  eq(calls.filter((c) => c[0] === 'clip').length, 1, 'ab 4 Punkten ein Clip');
  // Abstand zwischen Markern: ein schwächerer Moment kurz danach bekommt keinen Marker
  h.add({ type: 'chaos_death', user: 'zed', effect: 'Feuerpause', secs: 9 });
  await h.flushNow();
  eq(calls.filter((c) => c[0] === 'marker').length, 1, 'kein zweiter Marker innerhalb von 2 Minuten bei schwächerem Moment');
  const csv = h.exportText('csv');
  yes(/^Datum;VOD;Punkte;Titel;Clip/.test(csv) && csv.split('\r\n').length === 4, csv);
  h.close(); hdb.close();

  // Server: Marker und Clip landen bei Twitch, Liste und Export im Dashboard
  mock.stream(true);
  await waitFor(async () => (await api('highlights')).json.live, 4000, 'Stream läuft');
  const before = (mock.st.markers || []).length;
  const bmWas = (await st()).bitsMenu.enabled;
  await api('bitsmenu', { enabled: true });
  await gsiPost('live');
  mock.cheer({ bits: 1000, user: 'Großzahler', message: 'Cheer1000 wasd' });
  await waitFor(() => (mock.st.markers || []).length > before, 6000, 'Marker bei Twitch');
  yes(/Großzahler/.test(mock.st.markers.at(-1)) && /1000/.test(mock.st.markers.at(-1)), mock.st.markers.at(-1));
  await waitFor(() => (mock.st.clips || 0) > 0, 4000, 'Clip bei Twitch');
  const hl = (await api('highlights')).json;
  yes(hl.scopes.markers && hl.scopes.clips && hl.list[0].vod && hl.list[0].title.includes('Großzahler'), JSON.stringify(hl.list[0]));
  const chk = (await api('highlights/check', {})).json;
  eq(JSON.stringify([chk.markers, chk.clips, chk.vods, chk.live]), '[true,true,true,true]');
  const ex = await fetch(`${base}/api/highlights/export?format=txt`, { headers: { 'x-admin-token': cfg.server.adminToken } });
  yes(ex.ok && (await ex.text()).includes('Großzahler'), 'Export');
  eq((await fetch(`${base}/api/highlights/export`)).status, 401, 'Export nur mit Token');
  eq((await api('highlights/settings', { tone: 'episch', minScore: 9 })).json.settings.minScore, 3, 'ungültige Punkte -> Standard');
  // Eigene Titel-Bausteine + Vorschau
  eq((await api('highlights/settings', { customTitles: [{ type: 'chaos_death', text: '{user} und {foo}' }] })).status, 400, 'unbekannter Platzhalter');
  const own = (await api('highlights/settings', { customTitles: [{ type: 'chaos_death', text: 'EIGEN: {user} killt mich mit {effect}' }, { type: 'chaos_death', text: 'EIGEN: {user} killt mich mit {effect}' }, { type: 'nix', text: 'weg' }] })).json.settings.customTitles;
  eq(own.length, 1, 'doppelt/ungültig gefiltert');
  let ownSeen = false;
  for (let i = 0; i < 8 && !ownSeen; i++) ownSeen = (await api('highlights/preview', {})).json.titles.some((x) => x.title.startsWith('EIGEN: Lena'));
  yes(ownSeen, 'eigener Baustein erscheint in der Vorschau');
  eq((await api('highlights/preview', { customTitles: [{ type: 'any', text: '{x}' }] })).status, 400);
  await api('highlights/settings', { customTitles: [] });
  // Stream-Infos
  eq((await api('stream/info')).json.channel.title, 'Testtitel');
  eq((await api('stream/categories?q=fort')).json.categories[0].name, 'Fortnite');
  eq((await api('stream/info', { title: 'Chaos heute!', gameId: '33214', tags: ['Deutsch', 'Chaos'] })).status, 200);
  eq(JSON.stringify([mock.st.channelTitle, mock.st.gameId, mock.st.tags]), '["Chaos heute!","33214",["Deutsch","Chaos"]]');
  eq((await api('stream/info', { tags: ['zwei worte'] })).status, 400);
  await api('clear', {});
  for (const c of (await st()).state.bitsCredit) await api('bits/credit/drop', { id: c.id });
  await api('bitsmenu', { enabled: bmWas });
  mock.stream(false);
});
await t('Raid, Follow, Abo, Hype Train: lösen nur eingeschaltet einen Effekt aus, mit Mindestwert, Cooldown und Follow nur einmal', async () => {
  const fxOf = (kind) => events.filter((e) => e.type === 'fx' && e.fx.type === 'event' && e.fx.kind === kind && e.fx.user !== 'TEST');
  const d0 = (await api('events')).json;
  yes(Object.values(d0.settings).every((c) => !c.enabled), 'Standard: alles aus');
  yes(d0.actionChoices.length > 0 && d0.scopes.follow && d0.scopes.hype, JSON.stringify(d0.scopes));
  mock.st.hypeV2Missing = true; // ältere Twitch-Version: ChaosCore fällt auf v1 zurück
  const actionId = d0.actionChoices[0].id;
  const r = (await api('events', { raid: { enabled: true, actionId, min: 10, cooldownSec: 600 }, follow: { enabled: true }, sub: { enabled: true, cooldownSec: 0 }, hype: { enabled: true, cooldownSec: 0 } })).json;
  eq(r.settings.raid.actionId, actionId);
  yes(r.subs.raid === true && r.subs.follow === true && r.subs.sub === true && r.subs.hype === true, JSON.stringify(r.subs));
  yes(mock.st.eventTypes.includes('channel.hype_train.begin@1') && mock.st.eventTypes.includes('channel.follow@2'), mock.st.eventTypes.join());
  const n0 = mock.st.eventTypes.length;
  await api('events', { raid: { enabled: true } });
  eq(mock.st.eventTypes.length, n0, 'nichts doppelt abonniert');
  eq((await api('events', { raid: { cooldownSec: -5, min: 'x' } })).json.settings.raid.cooldownSec, 600, 'ungültige Werte bleiben beim alten');
  // Raid zu klein -> nichts, groß genug -> Effekt + Highlight-Moment, zweiter Raid im Cooldown -> nichts
  mock.event('channel.raid', { from_broadcaster_user_id: 'r1', from_broadcaster_user_login: 'kleinraid', from_broadcaster_user_name: 'KleinRaid', viewers: 3 });
  await sleep(300);
  eq(fxOf('raid').length, 0, 'zu kleiner Raid');
  mock.event('channel.raid', { from_broadcaster_user_id: 'r2', from_broadcaster_user_login: 'grossraid', from_broadcaster_user_name: 'GrossRaid', viewers: 42 });
  await waitFor(() => fxOf('raid').length === 1, 3000, 'Raid-Effekt');
  const rf = fxOf('raid')[0].fx;
  yes(rf.user === 'GrossRaid' && rf.amount === 42 && rf.title, JSON.stringify(rf));
  mock.event('channel.raid', { from_broadcaster_user_id: 'r3', from_broadcaster_user_login: 'noch', from_broadcaster_user_name: 'Noch', viewers: 50 });
  await sleep(300);
  eq(fxOf('raid').length, 1, 'Raid-Cooldown');
  // Follow: derselbe Zuschauer nur einmal
  mock.event('channel.follow', { user_id: 'f1', user_login: 'fan', user_name: 'Fan' });
  await waitFor(() => fxOf('follow').length === 1, 3000, 'Follow-Effekt');
  await api('events', { follow: { cooldownSec: 0 } });
  mock.event('channel.follow', { user_id: 'f1', user_login: 'fan', user_name: 'Fan' });
  await sleep(300);
  eq(fxOf('follow').length, 1, 'Follow nur einmal pro Zuschauer');
  // Abo: einzelnes Geschenk-Abo zählt nicht doppelt, Geschenk-Paket zählt mit Anzahl
  mock.event('channel.subscribe', { user_id: 's1', user_login: 'beschenkt', user_name: 'Beschenkt', is_gift: true });
  await sleep(300);
  eq(fxOf('sub').length, 0, 'is_gift wird über subscription.gift gezählt');
  mock.event('channel.subscription.gift', { user_id: 'g1', user_login: 'gönner', user_name: 'Gönner', total: 5, is_anonymous: false });
  await waitFor(() => fxOf('sub').length === 1, 3000, 'Geschenk-Abos');
  yes(fxOf('sub')[0].fx.gift && fxOf('sub')[0].fx.amount === 5, JSON.stringify(fxOf('sub')[0].fx));
  mock.event('channel.hype_train.begin', { level: 2 });
  await waitFor(() => fxOf('hype').length === 1 && fxOf('hype')[0].fx.user === 'Hype Train', 3000, 'Hype Train');
  // Test-Knopf: nur Overlay + Trockenlauf
  eq((await api('events/test', { kind: 'raid' })).status, 200);
  eq((await api('events/test', { kind: 'nope' })).status, 400);
  await api('clear', {});
  await api('events', { raid: { enabled: false }, follow: { enabled: false }, sub: { enabled: false }, hype: { enabled: false } });
  mock.st.hypeV2Missing = false;
});

await t('OBS: Verbindung mit Passwort, falsches Passwort wird erkannt, Szenen und Quellen werden gelesen', async () => {
  const om = await startObsMock({ password: 'geheim', dir: path.join(tmp, 'obs-replays') });
  try {
    eq((await api('obs')).json.status, 'off', 'Standard: aus');
    await api('obs', { enabled: true, host: '127.0.0.1', port: om.port, password: 'falsch' });
    await waitFor(async () => (await api('obs')).json.status === 'auth_failed', 5000, 'falsches Passwort erkannt');
    await api('obs', { enabled: true, host: '127.0.0.1', port: om.port, password: 'geheim' });
    await waitFor(async () => (await api('obs')).json.status === 'connected', 5000, 'verbunden');
    const o = (await api('obs')).json;
    yes(o.replayActive === true && o.hasPassword && o.version === '31.0.0', JSON.stringify(o));
    eq(JSON.stringify(o.scenes.map((x) => x.name)), '["Spiel","Pause","Ende"]');
    eq(JSON.stringify(o.scenes[0].sources), '["Kamera","Chaos-Overlay"]');
    yes(!JSON.stringify(o).includes('geheim'), 'Passwort wird nie ausgegeben');
    const preset = JSON.stringify((await api('profile/export', {})).json || {});
    yes(!preset.includes('geheim') && !preset.includes('"system"'), 'nicht im Export');
    await api('obs', { enabled: false });
    await waitFor(async () => (await api('obs')).json.status === 'off', 3000, 'aus');
  } finally { om.close(); }
});

await t('System-Aktionen: nur freigeschaltet, mit Bestätigung, Szene/Quelle, Stream-Ende mit Countdown und Abbruch, Programm aus der eigenen Liste', async () => {
  const om = await startObsMock({ password: '', dir: path.join(tmp, 'obs-replays2') });
  try {
    await api('obs', { enabled: true, host: '127.0.0.1', port: om.port, password: '' });
    await waitFor(async () => (await api('obs')).json.status === 'connected', 5000, 'verbunden');
    const sys0 = (await api('system')).json;
    yes(!sys0.settings.enabled && sys0.settings.confirm, 'Standard: aus, mit Bestätigung');
    const duck = sys0.actionChoices.find((a) => a.title === 'Ducken-Spam').id;
    eq((await api('system', { link: { actionId: duck, kind: 'scene' } })).status, 400, 'Szene fehlt');
    await api('system', { link: { actionId: duck, kind: 'scene', scene: 'Pause', cooldownSec: 0 } });
    // nicht freigeschaltet -> nichts
    await done(await redeemFree('Ducken-Spam', 'sysuser1'));
    await sleep(200);
    eq(om.st.current, 'Spiel', 'ohne Freischaltung passiert nichts');
    await api('system', { enabled: true });
    await done(await redeemFree('Ducken-Spam', 'sysuser2'));
    await waitFor(async () => !!(await st()).state.system?.pending, 3000, 'wartet auf Bestätigung');
    const pend = (await st()).state.system.pending;
    yes(pend.user === 'sysuser2' && /Pause/.test(pend.what), JSON.stringify(pend));
    eq(om.st.current, 'Spiel', 'vor dem Ja passiert nichts');
    eq((await api('system/answer', { id: pend.id, yes: true })).status, 200);
    eq(om.st.current, 'Pause', 'Szene gewechselt');
    // Quelle ausblenden ohne Bestätigung
    await api('system', { confirm: false, link: { actionId: duck, kind: 'source', scene: 'Spiel', source: 'Kamera', mode: 'off', cooldownSec: 0 } });
    await done(await redeemFree('Ducken-Spam', 'sysuser3'));
    await waitFor(() => om.st.items.Spiel[0].enabled === false, 3000, 'Kamera aus');
    // Stream beenden: Countdown, Abbruch
    await api('system', { link: { actionId: duck, kind: 'endStream', seconds: 30, cooldownSec: 0 } });
    await done(await redeemFree('Ducken-Spam', 'sysuser4'));
    await waitFor(async () => !!(await st()).state.system?.countdown, 3000, 'Countdown läuft');
    yes(events.some((e) => e.type === 'fx' && e.fx.type === 'sys_countdown'), 'Countdown im Overlay');
    eq((await api('system/abort', {})).json.aborted, true);
    await sleep(800);
    eq(om.st.streaming, true, 'abgebrochen - Stream läuft weiter');
    await api('system', { link: { actionId: duck, kind: 'endStream', seconds: 10, cooldownSec: 0 } });
    await done(await redeemFree('Ducken-Spam', 'sysuser5'));
    await waitFor(() => om.st.streaming === false, 4000, 'Stream beendet');
    // Programm: nur aus der eigenen Liste, Pfad muss existieren
    eq((await api('system', { program: { name: 'Gibtsnicht', target: path.join(tmp, 'nope.exe') } })).status, 400);
    eq((await api('system', { program: { name: 'Böse', target: 'calc.exe & del x' } })).status, 400);
    const marker = path.join(tmp, 'spiel-gestartet.txt');
    const win = process.platform === 'win32';
    const script = win ? process.execPath : path.join(tmp, 'spiel.sh'); // Windows: nur .exe/.lnk/.url erlaubt
    if (!win) fs.writeFileSync(script, `#!/bin/sh\necho ok > "${marker}"\n`, { mode: 0o755 });
    const sys1 = (await api('system', { program: { name: 'Testspiel', target: script } })).json.settings;
    const prog = sys1.programs.find((p) => p.name === 'Testspiel');
    yes(prog && prog.target === script, JSON.stringify(sys1.programs));
    if (!win) {
      eq((await api('system/start', { id: prog.id })).status, 200);
      await waitFor(() => fs.existsSync(marker), 3000, 'Programm gestartet');
    }
    await api('system', { link: { actionId: duck, kind: 'game', programId: prog.id } });
    eq((await api('system')).json.settings.links[duck].kind, 'game');
    await api('system', { removeProgram: prog.id });
    eq((await api('system')).json.settings.links[duck], undefined, 'Verknüpfung fällt mit dem Programm weg');
    // Not-Aus bricht ein laufendes Stream-Ende ab
    om.st.streaming = true;
    await api('system', { link: { actionId: duck, kind: 'endStream', seconds: 60, cooldownSec: 0 } });
    await done(await redeemFree('Ducken-Spam', 'sysuser6'));
    await waitFor(async () => !!(await st()).state.system?.countdown, 3000, 'Countdown läuft');
    await api('panic', {});
    await waitFor(async () => !(await st()).state.system?.countdown, 3000, 'Not-Aus bricht ab');
    await api('pause', { paused: false });
    eq(om.st.streaming, true);
  } finally {
    await api('system', { enabled: false, confirm: true, link: { actionId: (await api('system')).json.actionChoices.find((a) => a.title === 'Ducken-Spam').id, kind: 'none' } });
    await api('obs', { enabled: false });
    om.close();
  }
});

await t('Lokale Clips: OBS speichert den Puffer, Datei bekommt den Highlight-Titel und landet im Ordner des Streams', async () => {
  const { Obs } = await import('../src/obs.js');
  const { LocalClips, normalizeLocalClips, clipBaseName, streamFolderName } = await import('../src/local-clips.js');
  const { Highlights, normalizeHighlights } = await import('../src/highlights.js');
  const { openDb } = await import('../src/db.js');
  const om = await startObsMock({ password: '', dir: path.join(tmp, 'obs-replays3') });
  const target = path.join(tmp, 'meine-clips');
  const lcfg = { obs: { enabled: true, host: '127.0.0.1', port: om.port }, highlights: normalizeHighlights({ minScore: 3 }), localClips: normalizeLocalClips({ enabled: true, minScore: 3, afterSec: 0, folder: target }) };
  const obs = new Obs(lcfg);
  const logs = [];
  const logger = { info: (m) => logs.push(m), warn: (m) => logs.push(m) };
  const hdb = openDb(path.join(tmp, 'lc.sqlite'));
  try {
    obs.start();
    await waitFor(() => obs.status === 'connected' && obs.replayActive === true, 4000, 'OBS verbunden');
    const lc = new LocalClips({ cfg: lcfg, obs, db: hdb, logger });
    const h = new Highlights({ cfg: lcfg, db: hdb, twitch: null, gsi: null, logger, localClips: lc, clipDelayMs: 0 });
    h.add({ type: 'chaos_death', user: 'Lena', effect: 'Maus-Drift', secs: 7 });
    h.flushNow();
    await waitFor(() => !!hdb.highlightList(5)[0]?.videoFile, 4000, 'Clip-Datei verknüpft');
    const row = hdb.highlightList(5)[0];
    yes(row.videoFile.startsWith(path.join(target, streamFolderName(row.ts))) && fs.existsSync(row.videoFile), row.videoFile);
    yes(path.basename(row.videoFile).includes('Lena') && row.videoFile.endsWith('.mkv'), row.videoFile);
    eq(fs.existsSync(om.st.saved[0]), false, 'aus dem OBS-Ordner verschoben');
    eq(clipBaseName('a/b:c*?"<>|  d.', 0).slice(9), 'abc d', 'nur erlaubte Zeichen');
    // Kleiner Moment: kein Clip; Puffer aus: Hinweis statt Fehler
    h.add({ type: 'raid', user: 'X', effect: 'Y' }); h.flushNow();
    om.st.replayActive = false; await obs.refreshReplay();
    h.add({ type: 'challenge', user: 'Z', result: 'won', kills: 3, goal: 3 }); h.flushNow();
    await sleep(300);
    eq(om.st.saved.length, 1, 'nur der eine starke Moment');
    yes(logs.some((m) => /Wiederholungspuffer in OBS ist aus/.test(m)), logs.join(' | '));
    h.close();
  } finally { obs.stop(); hdb.close(); om.close(); }
});

await t('Hochkant-Version: 1080x1920 mit Titel und Logo (nur wenn ffmpeg vorhanden ist)', async () => {
  const { LocalClips, normalizeLocalClips, findFfmpeg } = await import('../src/local-clips.js');
  const ff = findFfmpeg('');
  if (!ff) { console.log('    (übersprungen: kein ffmpeg)'); return; }
  const dir = path.join(tmp, 'shorts');
  fs.mkdirSync(dir, { recursive: true });
  spawnSync(ff, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30', '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', path.join(dir, 'clip.mp4')]);
  spawnSync(ff, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=100x50', '-frames:v', '1', path.join(dir, 'logo.png')]);
  const row = { id: 7, title: 'Test: 100% Chaos "zitiert" \\ mit Sonderzeichen', videoFile: path.join(dir, 'clip.mp4') };
  const db = { highlightList: () => [row], highlightSet: (id, p) => Object.assign(row, p) };
  const lc = new LocalClips({ cfg: { localClips: normalizeLocalClips({}) }, obs: null, db, logger: { info() {}, warn() {} }, logoFile: () => path.join(dir, 'logo.png') });
  const out = await lc.makeShort(7);
  eq(row.shortFile, out);
  const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', out], { encoding: 'utf8' });
  if (probe.status === 0) eq(probe.stdout.trim(), '1080,1920');
  yes(!fs.readdirSync(dir).some((f) => f.startsWith('.chaoscore-title')), 'Hilfsdatei aufgeräumt');
});

await t('Englisch: Fehlermeldungen werden übersetzt, unbekannte bleiben stehen, jede Übersetzung passt zu ihren Platzhaltern', async () => {
  const { translateError } = await import('../src/i18n.js');
  eq(translateError('Warteschlange ist voll', 'en'), 'Queue is full');
  eq(translateError('Warteschlange ist voll', 'de'), 'Warteschlange ist voll');
  eq(translateError('Unbekanntes Spiel-Profil: "x". Erlaubt: cs2, fortnite.', 'en'), 'Unknown game profile: "x". Allowed: cs2, fortnite.');
  eq(translateError('Effekte sind im Spielmodus „premier“ aus', 'en'), 'Effects are off in game mode "premier"');
  eq(translateError('etwas ganz anderes', 'en'), 'etwas ganz anderes');
  const list = JSON.parse(fs.readFileSync(path.join(ROOT, 'locale', 'errors-en.json'), 'utf8'));
  for (const { de, en } of list) {
    const ph = (x) => [...x.matchAll(/\{(\d)\}/g)].map((m) => m[1]).sort().join();
    eq(ph(en), ph(de), `Platzhalter: ${de}`);
    yes(!/[äöüß]/.test(en.replace(/\{\d\}/g, '')), `nicht übersetzt: ${en}`);
  }
});

await t('Dashboard im echten Browser: alle Bereiche öffnen ohne Skriptfehler (aus Teil-Dateien zusammengesetzt)', async () => {
  let chromium;
  try { ({ chromium } = (await import('node:module')).createRequire(import.meta.url)('playwright')); } catch { console.log('    (übersprungen: kein Playwright)'); return; }
  let browser;
  try { browser = await chromium.launch(); } catch { console.log('    (übersprungen: kein Browser)'); return; }
  try {
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
    await page.goto(`${base}/dashboard#token=${cfg.server.adminToken}`);
    await page.waitForTimeout(1500);
    for (const nav of await page.$$eval('[data-nav]', (els) => els.map((e) => e.dataset.nav))) {
      await page.click(`[data-nav="${nav}"]`);
      await page.waitForTimeout(250);
    }
    // Optional: Bildschirmfotos jedes Bereichs in drei Breiten (Design-Prüfung): UCC_SHOTS=<Ordner>
    if (process.env.UCC_SHOTS) {
      fs.mkdirSync(process.env.UCC_SHOTS, { recursive: true });
      for (const [w, h] of [[390, 844], [820, 1180], [1440, 900]]) {
        await page.setViewportSize({ width: w, height: h });
        for (const nav of await page.$$eval('[data-nav]', (els) => [...new Set(els.map((e) => e.dataset.nav))])) {
          const btn = await page.$(`[data-nav="${nav}"]`);
          if (await btn.isVisible()) await btn.click(); else await page.evaluate((n) => document.querySelector(`[data-nav="${n}"]`).click(), nav);
          await page.waitForTimeout(300);
          await page.screenshot({ path: path.join(process.env.UCC_SHOTS, `${w}-${nav}.png`), fullPage: true });
        }
      }
      await page.setViewportSize({ width: 1280, height: 800 });
    }
    await page.click('[data-nav="automation"]');
    await page.waitForTimeout(600);
    yes(await page.$eval('#evRows', (e) => e.children.length) === 4, 'Ereignis-Zeilen');
    eq(JSON.stringify(errs), '[]');
  } finally { await browser.close(); }
});

await t('Aussehen der Overlay-Fenster: Regler werden geprüft und ins Overlay übernommen, reisen mit Presets; eigenes CSS bleibt lokal', async () => {
  for (const bad of [{ queue: { theme: 'neon' } }, { queue: { accent: 'rot' } }, { queue: { opacity: 150 } }, { queue: { shape: 'stern' } }, { queue: { radius: 99 } }, { nope: {} }, { stats: {} }]) {
    eq((await api('overlay/styles', { styles: bad })).status, 400, `abgelehnt: ${JSON.stringify(bad)}`);
  }
  eq((await api('overlay/styles', { customCss: '</style><script>alert(1)</script>' })).status, 400, 'keine HTML-Tags im CSS');
  eq((await api('overlay/styles', { customCss: 'x'.repeat(20001) })).status, 400, 'zu lang');
  const r = await api('overlay/styles', { styles: { queue: { theme: 'light', accent: '#00f0ff', opacity: 60, shape: 'round', radius: 16, border: false, glow: false } }, customCss: '#queue li { font-size: 20px; }' });
  eq(JSON.stringify(r.json.styles.queue), '{"theme":"light","accent":"#00f0ff","opacity":60,"shape":"round","radius":16,"border":false,"glow":false}');
  const s1 = (await st()).state.overlay;
  eq(s1.styles.queue.theme, 'light'); eq(s1.customCss, '#queue li { font-size: 20px; }');
  const exp = (await api('profile/export', {})).json;
  eq(exp.overlay.styles.queue.theme, 'light', 'Stile gehen mit ins Preset');
  yes(!('customCss' in exp.overlay), 'eigenes CSS geht nicht ins Preset');
  // Fremdes Preset mit CSS: CSS wird nicht übernommen, Stil schon
  const foreign = JSON.parse(JSON.stringify(exp));
  foreign.overlay.customCss = 'body { display: none; }';
  foreign.overlay.styles = { chaos: { theme: 'glass', opacity: 40 } };
  const prev = (await api('profile/preview', { preset: foreign })).json;
  yes(prev.report.notImported.includes('overlay.customCss'), 'CSS steht unter "nicht übernommen"');
  yes(prev.report.overlay.changed.some((c) => c.field === 'styles'), 'Stil-Änderung wird in der Vorschau gezeigt');
  await api('profile/import', foreign);
  const s2 = (await st()).state.overlay;
  eq(s2.customCss, '#queue li { font-size: 20px; }', 'lokales CSS unverändert');
  eq(s2.styles.chaos.theme, 'glass');
  const ovl = fs.readFileSync(path.join(ROOT, 'web', 'overlay.html'), 'utf8');
  yes(/function applyStyles/.test(ovl) && /\.panel\.st-light/.test(ovl) && /id="customCss"/.test(ovl), 'Overlay setzt Stile und eigenes CSS um');
  await api('overlay/styles', { styles: {}, customCss: '' });
});
await t('Spiel-Profil: Wechsel zu Fortnite aktiviert eigene Aktionen, unbekanntes Profil wird abgelehnt, Zurückwechseln stellt CS2 wieder her', async () => {
  const before = await st();
  eq(before.game.profile, 'cs2', 'Ausgangsprofil sollte cs2 sein');
  yes(before.game.profiles.some((p) => p.id === 'fortnite'), 'Fortnite sollte in der Profil-Liste stehen');

  const bad = await api('game/profile', { id: 'nicht_existent' });
  eq(bad.status, 400, 'Unbekanntes Profil sollte abgelehnt werden');

  // Die eine, generelle Zustimmung beim
  // Setup deckt jedes Spiel gleich ab - kein zweites Nachfragen beim Wechsel zu Fortnite.
  const switched = await api('game/profile', { id: 'fortnite' });
  yes(switched.json.ok, `Profil-Wechsel fehlgeschlagen: ${JSON.stringify(switched.json)}`);
  eq(switched.json.profile, 'fortnite');

  const s = await st();
  eq(s.game.profile, 'fortnite', 'Aktives Profil sollte jetzt fortnite sein');
  yes(!s.game.supportsGsi, 'Fortnite-Profil sollte GSI nicht unterstützen');
  const ids = s.actions.map((a) => a.id);
  for (const id of ['movement_lock', 'wasd_invert', 'jump_spam', 'forced_crouch', 'reload_spam']) {
    yes(ids.includes(id), `Fortnite-Aktion "${id}" fehlt nach dem Wechsel`);
  }

  // Eine Fortnite-Aktion wirklich auslösen (Trockentest, reine Tastensimulation, kein GSI nötig).
  const test = await api('test', { id: 'jump_spam', dry: true });
  yes(test.json.ok, `Fortnite-Effekt lief nicht an: ${JSON.stringify(test.json)}`);

  // Zurückwechseln: CS2-Aktionen und bisherige Tasten müssen exakt wie vorher da sein.
  const back = await api('game/profile', { id: 'cs2' });
  yes(back.json.ok, 'Zurückwechseln zu CS2 fehlgeschlagen');
  const s2 = await st();
  eq(s2.game.profile, 'cs2');
  yes(s2.actions.some((a) => a.id === 'shift_police'), 'CS2-Aktionen fehlen nach dem Zurückwechseln');
  await api('game/profile', { id: 'cs2' }); // für nachfolgende Tests wieder auf CS2 zurück
});
await t('Profil-Selbsttest: prüft jede Aktion gegen die Tastenbelegung, meldet kaputte Tasten verständlich statt mit Absturz', async () => {
  const good = await api('game/selftest');
  yes(good.json.allOk, `Selbsttest sollte mit der mitgelieferten Belegung fehlerfrei sein: ${JSON.stringify(good.json)}`);
  yes(good.json.results.length > 0, 'Selbsttest hat keine Aktionen geprüft');
  yes(good.json.results.every((r) => r.ok && !r.error), 'Es dürfen hier noch keine Fehler gemeldet werden');
  yes(good.json.results.some((r) => r.id === 'shift_police'), 'shift_police sollte Teil des Selbsttests sein');

  // Eine Aktion absichtlich kaputt machen (Taste, die es in der Belegung nicht gibt) und
  // wieder prüfen: muss verständlich gemeldet werden, nicht mit einem rohen Absturz enden.
  const actionsPath = path.join(A.data, 'actions.json');
  const original = fs.readFileSync(actionsPath, 'utf8');
  try {
    const raw = JSON.parse(original);
    const broken = raw.actions.find((a) => a.id === 'shift_police');
    yes(!!broken, 'shift_police nicht in actions.json gefunden');
    broken.effect.steps = ['hold @diese_taste_gibt_es_nicht 5000'];
    fs.writeFileSync(actionsPath, JSON.stringify(raw, null, 2));

    const bad = await api('game/selftest');
    eq(bad.status, 200, 'Selbsttest darf bei einer kaputten Aktion nicht abstürzen');
    yes(!bad.json.allOk, 'Selbsttest sollte die kaputte Aktion jetzt melden');
    const r = bad.json.results.find((x) => x.id === 'shift_police');
    yes(r && r.ok === false && typeof r.error === 'string' && r.error.length > 0, `kaputte Aktion ohne verständlichen Fehlertext: ${JSON.stringify(r)}`);
    const others = bad.json.results.filter((x) => x.id !== 'shift_police');
    yes(others.every((x) => x.ok), 'unbeteiligte Aktionen sollten weiterhin fehlerfrei sein');
  } finally {
    fs.writeFileSync(actionsPath, original); // Belegung für nachfolgende Tests wiederherstellen
  }
});
await t('Abgelaufener Login (App "Vertraulich"): Start ins Dashboard, Hinweis auf den App-Typ, Schnell-Anmeldung ohne Neustart', async () => {
  const dir = path.join(tmp, 'relogin');
  fs.cpSync(A.data, path.join(dir, 'data'), { recursive: true });
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const cfgFile2 = path.join(dir, 'data', 'config.json');
  const cfg2 = JSON.parse(fs.readFileSync(cfgFile2, 'utf8'));
  const port2 = 20000 + Math.floor(Math.random() * 20000);
  cfg2.server.port = port2;
  delete cfg2.twitch.clientType;
  fs.writeFileSync(cfgFile2, JSON.stringify(cfg2, null, 2));
  // Login nach 4 Stunden: Access-Token abgelaufen, Verlängern scheitert am fehlenden Client-Secret.
  const tokFile = path.join(dir, 'data', 'tokens.json');
  fs.writeFileSync(tokFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(tokFile, 'utf8')), expiresAt: Date.now() - 1000 }));
  mock.st.confidential = true;
  const env = { ...process.env, ...mock.env, HOME: home, UCC_DATA_DIR: path.join(dir, 'data'), UCC_NO_OPEN: '1', NO_COLOR: '1', UCC_BRIDGE: 'mock', UCC_POLL_SCALE: '0.01' };
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/server.js')], { env, cwd: ROOT });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  const H = { 'x-admin-token': cfg2.server.adminToken, 'Content-Type': 'application/json' };
  const b2 = `http://localhost:${port2}`;
  const status = async () => (await fetch(`${b2}/api/status`, { headers: H })).json();
  try {
    await waitFor(() => /läuft\./.test(out), 10000, 'Server-Startmeldung trotz abgelaufenem Login');
    const r = await fetch(`${b2}/`, { redirect: 'manual' });
    eq(r.headers.get('location'), '/dashboard', 'mit abgelaufenem Login muss der Start im Dashboard landen, nicht in der Einrichtung');
    const s1 = await waitFor(async () => { const s = await status(); return s.twitch.status === 'auth_failed' && s; }, 8000, 'Status auth_failed');
    eq(s1.twitch.clientType, 'confidential', 'App-Typ "Vertraulich" muss erkannt werden');
    eq(JSON.parse(fs.readFileSync(cfgFile2, 'utf8')).twitch.clientType, 'confidential', 'App-Typ wird gespeichert');
    const page = await (await fetch(`${b2}/dashboard`)).text();
    yes(/id="reloginBox"/.test(page) && /id="reloginBtn"/.test(page) && /id="confidentialBox"/.test(page), 'Schnell-Anmeldung/Hinweis fehlen im Dashboard');
    // Schnell-Anmeldung (Device-Code) aus dem Dashboard
    const st1 = await (await fetch(`${b2}/setup/api/login/start`, { method: 'POST', headers: H, body: '{}' })).json();
    eq(st1.state, 'waiting');
    yes(/^[A-Z0-9]+$/.test(st1.userCode), 'Code fehlt');
    const v = await waitFor(async () => { const x = await (await fetch(`${b2}/setup/api/login/status`, { headers: H })).json(); return x.state !== 'waiting' && x; }, 15000, 'Login abgeschlossen');
    eq(v.state, 'ok', `Login: ${JSON.stringify(v)}`);
    eq(v.clientType, 'confidential', 'auch die neue Anmeldung meldet den App-Typ');
    const rl = await fetch(`${b2}/api/twitch/reload`, { method: 'POST', headers: H, body: '{}' });
    eq(rl.status, 200);
    await waitFor(async () => (await status()).twitch.status === 'connected', 10000, 'nach der Schnell-Anmeldung ohne Neustart wieder mit Twitch verbunden');
    const sum = await (await fetch(`${b2}/setup/api/summary`, { headers: H })).json();
    eq(sum.twitch.clientType, 'confidential', 'Einrichtung kennt den App-Typ (Warnung in Schritt 3)');
  } finally {
    mock.st.confidential = false;
    p.kill();
  }
});
await t('Nur ein Fenster: Dashboard und Einrichtung schließen ältere Fenster, Einrichtung springt per #step', async () => {
  for (const f of ['dashboard', 'setup']) {
    const page = await (await fetch(`${base}/${f}`)).text();
    yes(/new BroadcastChannel\('chaoscore-window'\)/.test(page) && /window\.close\(\)/.test(page), `${f}: Einzelfenster-Logik fehlt`);
    yes(!/location\.href\s*=/.test(page), `${f}: Seitenwechsel sollen location.replace nutzen (sonst lässt sich das alte Fenster nicht schließen)`);
  }
  const setupPage = await (await fetch(`${base}/setup`)).text();
  yes(/get\('step'\)/.test(setupPage) && /id="okConfidential"/.test(setupPage), 'Einrichtung: #step oder App-Typ-Warnung fehlt');
  const { needsSecret } = await import('../src/twitch.js');
  yes(needsSecret({ status: 400, message: 'missing client secret' }) && !needsSecret({ status: 400, message: 'Invalid refresh token' }), 'Erkennung "Vertraulich"');
});
await t('Log enthält keine Geheimnisse', async () => {
  const log = fs.readFileSync(path.join(A.data, 'ucc.log'), 'utf8') + srvOut;
  for (const secret of [cfg.server.adminToken, cfg.server.gsiToken, mock.st.accessToken, mock.st.refreshToken, 'AT1', 'RT1']) yes(!log.includes(secret), `Geheimnis im Log/Terminal: ${secret.slice(0, 4)}…`);
});

await t('Beenden: Der Dashboard-Knopf existiert und fährt das Programm sauber herunter', async () => {
  const page = await (await fetch(`${base}/dashboard`)).text();
  yes(/id="quit"/.test(page) && /id="restart"/.test(page), 'Knöpfe fehlen im Dashboard');
  const exited = new Promise((resolve) => srv.once('exit', (code) => resolve(code)));
  yes((await api('quit', {})).json.ok, 'quit');
  const code = await Promise.race([exited, sleep(6000).then(() => 'timeout')]);
  yes(code !== 'timeout', 'Programm läuft nach "Beenden" weiter');
});

ac.abort();
srv.kill('SIGINT');
await sleep(500);
srv.kill();
// Teststabilität (untersucht 2026-11-13): vereinzelt beendete sich der Lauf nach dem letzten
// bestandenen Test nicht - mock.stop() wartet auf das Schließen aller Verbindungen zum simulierten
// Twitch, und eine noch offene Verbindung hielt den Lauf dann bis zum äußeren Abbruch fest, OHNE
// dass je eine Ergebniszeile erschien. Aufräumen darf das Ergebnis nicht verschlucken: höchstens
// 3 s warten, dann weiter.
const mockStopped = await Promise.race([mock.stop().then(() => true), sleep(3000).then(() => false)]);
if (!mockStopped) console.log('  (Hinweis: der simulierte Twitch-Server hat sich nicht innerhalb von 3 s geschlossen - Aufräumen übersprungen)');
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${failed ? '✖' : '✔'} ${passed} bestanden, ${failed} fehlgeschlagen${failed ? `: ${failures.join(' | ')}` : ''}\n`);
if (failed) console.log(srvOut.split('\n').slice(-40).join('\n'));
process.exit(failed ? 1 : 0);
