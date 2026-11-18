// Mini-Sprache für Effekte. Jede Zeile ist ein Befehl:
//   press KEY [ms] | hold KEY ms | wait ms | click [ms] | mouse DX DY SCHRITTE VERZÖGERUNG
//   block KEY... | unblock | swap A B | oncleanup press KEY | until_stop
//   release KEY...  (lässt gehaltene Tasten im Spiel los) | look GRAD_X GRAD_Y SCHRITTE VERZÖGERUNG (Blickwinkel in Grad)
//   repeat N ... endrepeat   (wird hier aufgelöst)
// "@primary" usw. werden durch die Tasten aus config.keys ersetzt.

import { keyError, comboError } from './keys.js';

// Zentrale Grenzen für Ressourcenverbrauch und Ausführungszeit. Sie gelten für JEDEN Weg, auf dem Schritte ins Programm
// kommen (mitgeliefert, Baukasten, Import, lokale Datei) und stehen bewusst als eingefrorene
// Konstante im Code statt in der Konfiguration: ein importiertes Preset kann sie deshalb nie
// überschreiben. Die mitgelieferten Aktionen liegen weit darunter
// (höchstens 40 Zeilen nach Auflösung, 25 s, Verschachtelung 1; von einem Test abgesichert).
export const LIMITS = Object.freeze({
  maxSourceLines: 100,     // Zeilen einer Aktion, wie sie in der Datei stehen
  maxRepeatDepth: 2,       // repeat in repeat: ja, tiefer: nein
  maxRepeatCount: 200,     // höhere Werte werden wie bisher auf 200 gekappt (kein Fehler)
  maxExpandedLines: 2000,  // Zeilen nach dem Auflösen aller repeat-Blöcke
  maxStepMs: 60000,        // ein einzelnes wait/hold/press/click
  maxActionMs: 120000,     // geschätzte Gesamtdauer einer Aktion (ohne until_stop)
  maxRunMs: 180000,        // harte Obergrenze für EINEN Lauf im Runner, egal was konfiguriert ist
  maxMoveCounts: 20000,    // mouse: Betrag von DX/DY
  maxLookDeg: 720,         // look: Betrag von GRAD_X/GRAD_Y
  maxMoveSteps: 500,       // mouse/look: Anzahl Teilschritte
  maxMoveDelayMs: 1000,    // mouse/look: Pause je Teilschritt
});

// An welchen Argument-Positionen eines Befehls eine TASTE steht (Rest: Zahlen/Schlüsselwörter).
// 'all' = jedes Argument. Jede dieser Tasten läuft durch die Erlaubnisliste in keys.js.
const KEY_POS = { press: [0], hold: [0], swap: [0, 1], oncleanup: [1], block: 'all', release: 'all' };

const ARGS = {
  press: [1, 2], hold: [2, 2], wait: [1, 1], click: [0, 1], mouse: [4, 4],
  block: [1, 20], unblock: [0, 0], swap: [2, 2], oncleanup: [2, 2], until_stop: [0, 0],
  release: [1, 20], look: [4, 4],
};
const TOKEN = /^[A-Za-z0-9_]{1,24}$/;
const INT = /^-?\d{1,9}$/;

// Zahlen-Argumente je Befehl: [Position (0 = erstes Argument), Minimum, Maximum]. Alles, was hier
// steht, MUSS eine ganze Zahl im Bereich sein - vorher ging z. B. "wait abc" durch die Prüfung und
// scheiterte erst im AutoHotkey-Runner.
const M = LIMITS;
const NUM = {
  press: [[1, 1, M.maxStepMs]],
  hold: [[1, 1, M.maxStepMs]],
  wait: [[0, 0, M.maxStepMs]],
  click: [[0, 1, M.maxStepMs]],
  mouse: [[0, -M.maxMoveCounts, M.maxMoveCounts], [1, -M.maxMoveCounts, M.maxMoveCounts], [2, 1, M.maxMoveSteps], [3, 0, M.maxMoveDelayMs]],
  look: [[0, -M.maxLookDeg, M.maxLookDeg], [1, -M.maxLookDeg, M.maxLookDeg], [2, 1, M.maxMoveSteps], [3, 0, M.maxMoveDelayMs]],
};

// Löst repeat-Blöcke auf. Bricht WÄHREND des Auflösens ab, sobald eine Grenze überschritten würde -
// nicht erst danach: drei verschachtelte "repeat 200" ergaben vorher 8 Mio. Zeilen im Speicher.
export function expand(lines) {
  if (!Array.isArray(lines)) throw new Error('Effekt-Schritte müssen eine Liste sein.');
  if (lines.length > LIMITS.maxSourceLines) throw new Error(`Zu viele Schritte (${lines.length}) - maximal ${LIMITS.maxSourceLines} Zeilen pro Aktion.`);
  let i = 0;
  const tooMany = () => new Error(`Die Aktion ergibt nach dem Auflösen der Wiederholungen mehr als ${LIMITS.maxExpandedLines} Schritte.`);
  const block = (depth) => {
    const out = [];
    while (i < lines.length) {
      if (typeof lines[i] !== 'string') throw new Error('Jeder Effekt-Schritt muss eine Textzeile sein.');
      const l = lines[i++].trim().replace(/\s+/g, ' ');
      if (l.length > 400) throw new Error('Ein Effekt-Schritt ist zu lang.');
      if (!l) continue;
      if (l === 'endrepeat') {
        if (depth === 0) throw new Error('"endrepeat" ohne zugehöriges "repeat".');
        return out;
      }
      const m = l.match(/^repeat (\d{1,6})$/);
      if (m) {
        if (depth >= LIMITS.maxRepeatDepth) throw new Error(`"repeat" ist höchstens ${LIMITS.maxRepeatDepth}-fach verschachtelbar.`);
        const n = Math.min(Number(m[1]), LIMITS.maxRepeatCount);
        const inner = block(depth + 1);
        if (out.length + inner.length * n > LIMITS.maxExpandedLines) throw tooMany();
        for (let k = 0; k < n; k++) out.push(...inner);
      } else {
        out.push(l);
        if (out.length > LIMITS.maxExpandedLines) throw tooMany();
      }
    }
    if (depth > 0) throw new Error('"repeat" ohne abschließendes "endrepeat".');
    return out;
  };
  return block(0);
}

// policy.critical: freigegebene kritische Tasten-Gruppen (siehe keys.js). Ohne Angabe gilt die
// strengste Stufe - keine kritische Taste. policy.rawCritical: dasselbe nur für roh geschriebene
// Tasten (Standard: wie policy.critical). policy.used (optional): Set, in dem alle tatsächlich
// verwendeten Tasten gesammelt werden (für die Kombinations-Prüfung in compile()).
export function resolve(lines, keys, policy = {}) {
  return lines.map((line) => {
    const parts = line.split(' ');
    const cmd = parts[0];
    if (!Object.hasOwn(ARGS, cmd)) throw new Error(`Unbekannter Effekt-Befehl: "${cmd}"`);
    const fromRef = []; // je Argument: kam die Taste über "@name" aus der Tastenbelegung?
    const rest = parts.slice(1).map((t, idx) => {
      fromRef[idx] = t.startsWith('@');
      if (t.startsWith('@')) {
        const name = t.slice(1);
        const k = Object.hasOwn(keys, name) ? keys[name] : null;
        if (!k) throw new Error(`Taste "${t}" ist in config.keys nicht definiert`);
        return String(k);
      }
      if (!TOKEN.test(t) && !INT.test(t)) throw new Error(`Ungültiges Zeichen im Effekt: "${t}"`);
      return t;
    });
    const [min, max] = ARGS[cmd];
    if (rest.length < min || rest.length > max) throw new Error(`"${cmd}" erwartet ${min}-${max} Argumente`);
    for (const [pos, lo, hi] of NUM[cmd] || []) {
      if (rest[pos] === undefined) continue; // optionales Argument weggelassen
      const n = Number(rest[pos]);
      if (!INT.test(rest[pos]) || n < lo || n > hi) throw new Error(`"${cmd}": Wert "${rest[pos]}" ist ungültig (erlaubt: ganze Zahl von ${lo} bis ${hi}).`);
    }
    const kp = KEY_POS[cmd];
    if (kp) {
      rest.forEach((t, idx) => {
        if (kp !== 'all' && !kp.includes(idx)) return;
        // Roh geschriebene Tasten ("press Enter") können strenger behandelt werden als Tasten, die
        // über "@name" aus der eigenen Belegung kommen - so prüft der Import (siehe config.js).
        const err = keyError(t, fromRef[idx] ? policy.critical : (policy.rawCritical ?? policy.critical));
        if (err) throw new Error(err);
        policy.used?.add(t);
      });
    }
    if (cmd === 'oncleanup' && rest[0] !== 'press') throw new Error('"oncleanup" kennt nur die Form "oncleanup press TASTE".');
    return [cmd, ...rest].join(' ');
  });
}

export function estimate(lines) {
  let ms = 0;
  let untilStop = false;
  for (const l of lines) {
    const p = l.split(' ');
    if (p[0] === 'wait') ms += Number(p[1]);
    else if (p[0] === 'hold') ms += Number(p[2]);
    else if (p[0] === 'press') ms += Number(p[2] || 50);
    else if (p[0] === 'click') ms += Number(p[1] || 60);
    else if (p[0] === 'mouse' || p[0] === 'look') ms += Number(p[3]) * Number(p[4]);
    else if (p[0] === 'until_stop') untilStop = true;
  }
  return { ms, untilStop };
}

// Der eine Weg von "Schritte aus der Datei" zu "Zeilen für den Runner": auflösen, Tasten einsetzen,
// Bereiche prüfen, Dauer schätzen und gegen die Gesamtgrenze prüfen. Engine UND Validierung nutzen
// genau diese Funktion - was die Prüfung besteht, ist dasselbe, was später ausgeführt wird.
export function compile(steps, keys, policy = {}) {
  const used = new Set();
  const lines = resolve(expand(steps), keys, { critical: policy.critical, rawCritical: policy.rawCritical, used });
  const combo = comboError(used);
  if (combo) throw new Error(combo);
  const est = estimate(lines);
  if (est.ms > LIMITS.maxActionMs) {
    throw new Error(`Die Aktion dauert zusammen ${Math.round(est.ms / 1000)} s - maximal ${LIMITS.maxActionMs / 1000} s erlaubt.`);
  }
  return { lines, est, keys: [...used] }; // keys: jede Taste, die diese Schritte anfassen (für die Import-Vorschau)
}

// Prüft die Effekte einer Aktion (für Doctor und Serverstart). Gibt Fehlertext oder null zurück.
// policy: siehe resolve() - ohne Angabe die strengste Stufe (so prüft der Import).
export function validateAction(action, keys, policy = {}) {
  const lists = action.effect?.variants || (action.effect?.steps ? [action.effect.steps] : []);
  try { for (const steps of lists) compile(steps, keys, policy); return null; } catch (e) { return e.message; }
}
