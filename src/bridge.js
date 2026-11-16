// Bridge: führt freigegebene Effekte aus.
//  - "ahk":  AutoHotkey v2 (Windows), ein kurzer Prozess pro Effekt
//  - "mock": Simulation (Tests, Linux/Mac, Trockenlauf)
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA, ROOT, ensureData } from './config.js';
import { TIME_SCALE } from './util.js';
import { estimate } from './steps.js';
import * as logger from './log.js';

export function findAhk(custom) {
  const env = process.env;
  const cands = [];
  if (custom) cands.push(custom);
  // Mitgeliefert (gepacktes Programm): <Programmordner>/tools/AutoHotkey64.exe
  for (const dir of [path.join(ROOT, 'tools'), path.join(ROOT, '..', 'tools'), path.join(DATA, 'tools')]) cands.push(path.join(dir, 'AutoHotkey64.exe'), path.join(dir, 'AutoHotkey32.exe'));
  for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')]) {
    if (!base) continue;
    for (const exe of ['AutoHotkey64.exe', 'AutoHotkey32.exe']) cands.push(path.join(base, 'AutoHotkey', 'v2', exe));
  }
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (dir) cands.push(path.join(dir, 'AutoHotkey64.exe'), path.join(dir, 'AutoHotkey32.exe'));
  }
  return cands.find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } }) || null;
}

// Hilfsbefehle, falls ein Runner hart beendet werden musste
export function cleanupLines(lines) {
  const out = [];
  const ups = new Set();
  for (const l of lines) {
    const p = l.split(' ');
    if (p[0] === 'oncleanup') out.push(`${p[1]} ${p[2]}`);
    if (p[0] === 'hold') ups.add(p[1]);
    // Fix 2026-11-15: ein hart beendeter Runner (Not-Aus) konnte die Ziel-Taste eines Tausches
    // (WASD invertiert: W hält S) und gerade getippte Tasten nicht mehr loslassen - z. B. blieb S
    // nach Not-Aus für den ganzen Rechner gedrückt. Diese Tasten werden jetzt mit losgelassen.
    if (p[0] === 'swap') ups.add(p[2]);
    if (p[0] === 'press') ups.add(p[1]);
    if (p[0] === 'click') ups.add('LButton');
  }
  return [...[...ups].map((k) => `up ${k}`), ...out];
}

// Was der Nutzer tun kann, wenn ein Effekt abgebrochen wurde, ohne dass der Spielzustand
// zurückgesetzt wurde. Not-Aus (restore() unten) drückt fireOn, zoomOn und xhOn - das stellt die
// Maustasten und die Sichtbarkeit des Fadenkreuzes wieder her, NICHT aber Fadenkreuz-Größe und
// Maus-Invertierung (die hängen an einer anderen Taste). Dafür hilft das Sicherheitsnetz in der
// CS2-Konfiguration (cs2.js: ucc_restore).
const RESTORE_HINT = 'Not-Aus stellt im Spiel die Maustasten und die Sichtbarkeit des Fadenkreuzes wieder her. Fadenkreuz-Größe und Maus-Invertierung stellt Not-Aus NICHT wieder her - dafür in der CS2-Konsole "exec unknown_chat_control" eingeben oder CS2 neu starten.';

export function createBridge(cfg) {
  const wanted = process.env.UCC_BRIDGE || cfg.bridge.type || 'auto';
  let kind = 'mock';
  let ahk = null;
  let note = '';
  if (wanted === 'mock') note = 'Simulationsmodus (keine Tasten werden gesendet).';
  else if (process.platform !== 'win32') note = 'Tasten-Effekte laufen nur unter Windows (AutoHotkey). Simulationsmodus aktiv.';
  else {
    ahk = findAhk(cfg.bridge.ahkPath);
    if (ahk) kind = 'ahk';
    else note = 'AutoHotkey v2 nicht gefunden. Simulationsmodus aktiv (npm run setup installiert es).';
  }

  const active = new Set();
  const history = []; // nur für Tests und Doku
  let counter = 0;
  const runDir = path.join(DATA, 'run');
  let panicProc = null;
  let panicStopped = false;

  // Simulation. Für Tests lässt sich ein Fokusverlust nachstellen: liegt die Datei
  // data/run/mock-focus-lost (Inhalt "5" oder "6" = Runner-Code) vor, endet der gerade laufende
  // Lauf so, wie der echte Runner es bei Fokusverlust meldet - über denselben Weg (focusLost).
  const mockFocusFile = path.join(runDir, 'mock-focus-lost');
  function runMock(lines) {
    const est = estimate(lines);
    let stop;
    const stopped = new Promise((r) => { stop = r; });
    history.push(lines);
    const finish = () => ({ ok: true, code: 0 });
    let watch;
    const lost = new Promise((r) => {
      watch = setInterval(() => {
        let code;
        try { code = Number(fs.readFileSync(mockFocusFile, 'utf8').trim()); fs.rmSync(mockFocusFile, { force: true }); } catch { return; }
        r(focusLost(code === 5 ? 5 : 6, lines));
      }, 20);
      watch.unref();
    });
    const normal = est.untilStop
      ? stopped.then(finish)
      : Promise.race([new Promise((r) => setTimeout(r, est.ms * TIME_SCALE)), stopped]).then(finish);
    const done = Promise.race([normal, lost]).finally(() => clearInterval(watch));
    return { est, stop, hardStop: stop, done };
  }

  // was ein Lauf zurückmeldet, wenn
  // das Spielfenster WÄHREND des Effekts den Fokus verliert (Runner-Codes 5 und 6, siehe
  // ahk/runner.ahk). Gemeinsam für den echten Runner und die Simulation.
  //  - Der Runner hat ausschließlich losgelassen, was er selbst gedrückt hielt. Es wird KEINE Taste
  //    nachträglich gedrückt - weder jetzt noch beim nächsten Lauf, auch nicht zur Wiederherstellung.
  //  - Der Effekt gilt als beendet, NICHT als fehlgeschlagen: keine automatische Erstattung.
  //  - Code 6: der Effekt hatte Wiederherstellungs-Tasten (oncleanup), die nicht gesendet wurden.
  //    Der Spielzustand kann deshalb noch verändert sein; das wird ausdrücklich protokolliert.
  function focusLost(code, lines) {
    const restore = lines.filter((l) => l.startsWith('oncleanup ')).map((l) => l.slice('oncleanup '.length));
    // Fix 2026-11-15: ohne Nachholen blieb z. B. das Fadenkreuz nach einem Fokusverlust dauerhaft
    // unsichtbar (oder riesig / Maus invertiert), bis CS2 neu gestartet wurde. Die Wiederherstellung
    // wird jetzt aufgeschoben und gesendet, sobald CS2 wieder im Vordergrund ist.
    if (code === 6 && restore.length) deferRestore(restore);
    const tail = code === 6
      ? ` Der Spielzustand wird zurückgesetzt, sobald ${cfg.game.windowExe} wieder im Vordergrund ist (${restore.join(' ; ')}).`
      : '';
    logger.warn(`Effekt abgebrochen: Das Spielfenster (${cfg.game.windowExe}) hat während des Effekts den Fokus verloren. Alle gehaltenen Tasten wurden losgelassen, es wurde keine weitere Taste gedrückt.${tail}`);
    return { ok: true, code, aborted: 'focus', stateRestored: code !== 6, reason: 'Spielfenster hat während des Effekts den Fokus verloren' };
  }

  // Ungeklärter Eingabezustand: gesetzt, wenn ein hart beendeter Runner seine gehaltenen Tasten nicht
  // nachweislich loslassen konnte. Solange das gilt, startet KEIN neuer Effekt (run() lehnt ab) -
  // erst Not-Aus (restore()) hebt die Sperre wieder auf.
  let inputUnclear = null; // null oder Text mit der Ursache

  // Aufgeschobene Wiederherstellung (Fix 2026-11-15). Konnten Wiederherstellungs-Tasten (oncleanup,
  // Not-Aus) nicht wirksam gesendet werden - CS2 war nicht im Vordergrund, ODER der Spieler war im
  // Menü / Chat / in der Konsole (dort landet z. B. "Numpad2" als Text "2" in der Konsole statt den
  // Bind auszulösen) -, werden sie nachgeholt, sobald
  //   1. das Spiel laut GSI wieder "playing" meldet (Gate, von der Engine gesetzt) und
  //   2. CS2 im Vordergrund ist (Runner-Befehl "waitfocus", danach normale Fokusprüfung).
  // Startet vorher ein neuer Effekt, werden die Tasten diesem Effekt vorangestellt (er startet ohnehin
  // nur im Spiel und mit Fokus) und das Warten beendet.
  let pendingLines = [];
  let waiter = null;      // wartender waitfocus-Runner
  let gateTimer = null;   // wartet, bis das Gate (Spieler spielt) offen ist
  let gate = null;        // () => boolean, von der Engine gesetzt
  const PENDING_MAX_MS = 6 * 60 * 60 * 1000;
  function deferRestore(presses) {
    if (kind !== 'ahk' || !presses.length) return;
    const before = pendingLines.length;
    pendingLines = [...new Set([...pendingLines, ...presses])];
    if (pendingLines.length === before && (waiter || gateTimer)) return;
    logger.info(`Wiederherstellung wird nachgeholt, sobald du wieder im Spiel bist und ${cfg.game.windowExe} im Vordergrund ist (${pendingLines.join(' ; ')}).`);
    if (waiter) { const w = waiter; waiter = null; w.stop(); }
    scheduleRestore();
  }
  function scheduleRestore() {
    if (waiter || gateTimer || !pendingLines.length) return;
    if (gate && !gate()) {
      gateTimer = setInterval(() => {
        if (!pendingLines.length) { clearInterval(gateTimer); gateTimer = null; return; }
        if (!gate()) return;
        clearInterval(gateTimer); gateTimer = null;
        scheduleRestore();
      }, 500);
      gateTimer.unref?.();
      return;
    }
    const lines = pendingLines.slice();
    const h = runAhk(['waitfocus', ...lines], PENDING_MAX_MS, true);
    waiter = h;
    h.done.then((r) => {
      if (waiter !== h) return; // abgelöst (neuer Effekt / neue Wiederherstellung)
      waiter = null;
      if (r.code === 0) {
        pendingLines = pendingLines.filter((l) => !lines.includes(l));
        logger.info(`Spielzustand nach dem Abbruch wiederhergestellt (${lines.join(' ; ')}).`);
      } else if (!(r.code === 3 || r.aborted === 'focus')) {
        logger.warn(`Wiederherstellung fehlgeschlagen (${r.reason || r.code}). ${RESTORE_HINT}`);
        pendingLines = [];
        return;
      }
      scheduleRestore(); // Rest / erneuter Versuch (z. B. beim Drücken schon wieder weggewechselt)
    }).catch(() => {});
  }
  function takePending() {
    const lines = pendingLines;
    pendingLines = [];
    if (gateTimer) { clearInterval(gateTimer); gateTimer = null; }
    if (waiter) { const w = waiter; waiter = null; w.stop(); }
    return lines;
  }

  function runAhk(lines, maxMs, noFocus = false) {
    ensureData();
    fs.mkdirSync(runDir, { recursive: true });
    const id = ++counter;
    const stepsFile = path.join(runDir, `${id}.txt`);
    const stopFile = path.join(runDir, `${id}.stop`);
    fs.writeFileSync(stepsFile, lines.join('\n'), 'utf8');
    try { fs.rmSync(stopFile, { force: true }); } catch { /* egal */ }
    const est = estimate(lines);
    const child = spawn(ahk, [
      path.join(ROOT, 'ahk', 'runner.ahk'), stepsFile, stopFile,
      cfg.game.windowExe, cfg.game.requireFocus && !noFocus ? '1' : '0', String(maxMs), String(cfg.game.sensitivity || 1),
    ], { stdio: 'ignore', windowsHide: true });
    active.add(child);
    let killed = false;
    const handle = {
      est,
      // opts.defer: Wiederherstellungs-Tasten NICHT jetzt senden (Spieler ist im Menü/Chat/Konsole,
      // dort würden sie verpuffen), sondern aufschieben - Runner antwortet dann mit Code 7.
      stop: (opts = {}) => {
        try { fs.writeFileSync(stopFile, opts.defer ? 'defer' : '1'); } catch { /* egal */ }
        setTimeout(() => { if (child.exitCode === null) { killed = true; child.kill(); } }, 2500).unref();
      },
      hardStop: () => { killed = true; try { child.kill(); } catch { /* egal */ } },
      done: new Promise((resolve) => {
        child.on('error', (e) => { logger.error(`AutoHotkey-Fehler: ${e.message}`); resolve({ ok: false, code: -1, reason: 'AutoHotkey konnte nicht starten' }); });
        child.on('exit', (code) => {
          active.delete(child);
          for (const f of [stepsFile, stopFile]) { try { fs.rmSync(f, { force: true }); } catch { /* egal */ } }
          if (killed) {
            // Der Runner musste hart beendet werden (Not-Aus oder er reagierte nicht auf die
            // Stopp-Datei) und konnte nicht selbst aufräumen. Zwei getrennte Schritte:
            //  1. LOSLASSEN, was er gedrückt hielt - ohne Fokusprüfung, denn eine Taste freizugeben
            //     ist in jedem Fenster sicher, und sonst bliebe sie für den ganzen Rechner gedrückt.
            //     Erst wenn das erledigt ist, gilt dieser Lauf als beendet (kein neuer Effekt davor).
            //  2. Wiederherstellungs-Tasten (oncleanup) - nur, wenn das Spiel JETZT im Vordergrund
            //     ist (normale Fokusprüfung, kein Warten). Sonst unterbleibt es und wird protokolliert.
            const c = cleanupLines(lines);
            const ups = c.filter((l) => l.startsWith('up '));
            const presses = c.filter((l) => !l.startsWith('up '));
            const release = ups.length ? runAhk(ups, 5000, true).done : Promise.resolve({ ok: true, code: 0 });
            release.then((r) => {
              if (!r.ok || r.code !== 0) {
                inputUnclear = `Tasten konnten nach einem hart beendeten Effekt nicht nachweislich losgelassen werden (${ups.join(' ; ')})`;
                logger.error(`Eingabezustand ungeklärt: ${inputUnclear}. Es startet kein neuer Effekt, bis Not-Aus gedrückt wurde.`);
              }
              if (presses.length) {
                runAhk(presses, 5000).done.then((p) => {
                  if (p.code === 3 || p.aborted === 'focus') deferRestore(presses.filter((l) => l.startsWith('press ')));
                }).catch(() => {});
              }
              resolve({ ok: true, code, reason: '' });
            }).catch(() => resolve({ ok: true, code, reason: '' }));
            return;
          }
          if (code === 5 || code === 6) return resolve(focusLost(code, lines));
          if (code === 7) {
            deferRestore(cleanupLines(lines).filter((l) => l.startsWith('press ')));
            return resolve({ ok: true, code, reason: '' });
          }
          resolve({ ok: code === 0 || killed, code, reason: code === 3 ? 'CS2 war nicht im Vordergrund' : code === 4 ? 'Ungültiger Effekt' : code ? `Runner-Fehler ${code}` : '' });
        });
      }),
    };
    return handle;
  }

  return {
    kind,
    note,
    ahkPath: ahk,
    history,
    run(lines, maxMs = 130000) {
      if (inputUnclear) {
        const reason = 'Eingabezustand ungeklärt - bitte Not-Aus drücken';
        return { est: estimate(lines), stop() {}, hardStop() {}, done: Promise.resolve({ ok: false, code: -2, reason }) };
      }
      if (kind !== 'ahk') return runMock(lines);
      const owed = takePending();
      if (!owed.length) return runAhk(lines, maxMs);
      const h = runAhk([...owed, ...lines], maxMs);
      // Lief der neue Effekt gar nicht erst an (Spiel nicht vorn), bleibt die Wiederherstellung offen.
      h.done.then((r) => { if (r.code === 3) deferRestore(owed); }).catch(() => {});
      return h;
    },
    // Engine: true, solange der Spieler wirklich spielt (nicht Menü/Chat/Konsole) - Voraussetzung,
    // damit eine aufgeschobene Wiederherstellung gesendet wird.
    setRestoreGate(fn) { gate = fn; },
    // Stellt Maus-Tasten und Crosshair im Spiel wieder her (Not-Aus, Beenden). Wirkt nur, wenn CS2 im Vordergrund ist.
    restore() {
      if (inputUnclear) { logger.info('Not-Aus: Sperre wegen ungeklärtem Eingabezustand aufgehoben.'); inputUnclear = null; }
      if (kind !== 'ahk') return;
      // Fix 2026-11-15: war CS2 beim Not-Aus nicht vorn, wird die Wiederherstellung nachgeholt
      // (vorher ging sie still verloren). Offene Wiederherstellungen werden gleich mit erledigt.
      const presses = [...new Set([...takePending(), `press ${cfg.keys.fireOn}`, `press ${cfg.keys.zoomOn}`, `press ${cfg.keys.xhOn}`])];
      if (gate && !gate()) { deferRestore(presses); return; } // im Menü/Chat würden sie verpuffen
      try {
        runAhk(presses, 5000).done.then((r) => { if (r.code === 3 || r.aborted === 'focus') deferRestore(presses); }).catch(() => {});
      } catch { /* egal */ }
    },
    panicAll() {
      for (const c of [...active]) { try { c.kill(); } catch { /* egal */ } }
    },
    // Not-Aus-Hotkey (nur AHK)
    // onFail (Session Stats): zweiter Hotkey cfg.bridge.failHotkey im selben Hilfsskript, meldet "fail"
    // über die Standardausgabe. Leerer Hotkey = aus. Wird bei jedem (Neu-)Start des Skripts frisch gelesen.
    startPanicWatcher(onPanic, onFail) {
      if (kind !== 'ahk') return;
      const launch = () => {
        if (panicStopped) return;
        const failKey = onFail ? (cfg.bridge.failHotkey || '') : '';
        panicProc = spawn(ahk, [path.join(ROOT, 'ahk', 'panic.ahk'), cfg.bridge.panicHotkey, failKey], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
        let buf = '';
        panicProc.stdout?.on('data', (d) => {
          buf += d;
          let i;
          while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line === 'fail') onFail?.(); }
          if (buf.length > 1000) buf = '';
        });
        panicProc.on('exit', (code) => {
          if (panicStopped) return;
          if (code === 42) onPanic();
          setTimeout(launch, 500);
        });
        panicProc.on('error', () => {});
      };
      launch();
    },
    // Hilfsskript neu starten, damit ein geänderter Fail-Hotkey sofort gilt.
    restartPanicWatcher() { try { panicProc?.kill(); } catch { /* egal */ } },
    close() {
      panicStopped = true;
      try { panicProc?.kill(); } catch { /* egal */ }
      for (const c of [...active]) { try { c.kill(); } catch { /* egal */ } }
    },
  };
}
