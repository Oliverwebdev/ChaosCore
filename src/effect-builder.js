// Geführter Effekt-Baukasten (Dashboard): erzeugt Effekt-Schritte aus wenigen, sicheren Bausteinen,
// statt freie Skripte zuzulassen. Nutzt nur Tasten, die schon anderswo im Projekt als "deine echten
// Tasten in CS2" gelten (config.keys) - keine internen Nummernblock-Binds, kein Mausinvertieren/
// Crosshair-Cvars (die bräuchten eigene Binds, siehe cs2.js). Das Ergebnis läuft durch dieselbe
// Validierung (validateAction) wie jeder mitgelieferte Effekt.
//
// statt eines Parallelsystems wird
// genau dieser Baukasten um Ketten erweitert - jeder einzelne Baustein (block/hold/spam/swap) ist
// schon für sich "selbst aufräumend" (siehe buildStep unten: endet immer mit unblock/wait, nie mit
// einer dauerhaft belegten Taste), darum ergibt das Aneinanderreihen mehrerer Bausteine automatisch
// eine ebenso selbst aufräumende Sequenz - kein neues Cleanup-Konzept nötig.
import { estimate, expand } from './steps.js';

// Physische Tasten, die der Streamer selbst in CS2 belegt hat (keine internen Cvar-Binds).
export const BUILDER_KEYS = [
  'forward', 'left', 'back', 'right', 'jump', 'duck', 'use', 'drop', 'inspect', 'walk',
  'scoreboard', 'buy', 'primary', 'secondary', 'knife', 'grenades', 'c4', 'last', 'flash',
];
const MOVE_KEYS = ['forward', 'left', 'back', 'right'];

export const BUILDER_MODES = [
  { id: 'block', label: 'Sperren', desc: 'Taste für eine Dauer sperren (z. B. Springen sperren).' },
  { id: 'hold', label: 'Halten', desc: 'Taste für eine Dauer automatisch gedrückt halten (z. B. Ducken).' },
  { id: 'spam', label: 'Spam', desc: 'Taste in kurzen Abständen wiederholt drücken.' },
  { id: 'swap', label: 'Tauschen', desc: 'Zwei Bewegungstasten für eine Dauer vertauschen.' },
];

// Eingebaute Bremsen für die freie Sequenz: nicht beliebig viele Bausteine, nicht
// beliebig lang in der Summe - unabhängig davon, dass jeder einzelne Baustein schon für sich auf
// max. 60s gedeckelt ist (clampMs unten).
export const BUILDER_MAX_STEPS = 8;
export const BUILDER_MAX_TOTAL_MS = 90000;

function clampMs(v, min, max, fallback) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

// Ein einzelner Baustein - das war früher der gesamte buildEffect(). Jeder Zweig endet garantiert
// mit einer Taste, die wieder frei ist (unblock/wait ohne gehaltene Taste) - das ist die Grundlage
// dafür, dass eine Kette aus mehreren Bausteinen (buildSequence) ohne weiteres Cleanup-Konzept
// genauso sicher ist wie ein einzelner.
function buildStep({ mode, key, key2, ms, intervalMs }) {
  if (!BUILDER_KEYS.includes(key)) throw new Error(`Unbekannte Taste "${key}".`);
  const dur = clampMs(ms, 500, 60000, 3000);
  switch (mode) {
    case 'block':
      return { requires: ['live'], steps: [`release @${key}`, `block @${key}`, `wait ${dur}`, 'unblock'] };
    case 'hold':
      return { requires: ['live'], steps: [`hold @${key} ${dur}`] };
    case 'spam': {
      const interval = clampMs(intervalMs, 80, 2000, 150);
      const n = Math.max(1, Math.min(200, Math.round(dur / interval)));
      return { requires: ['live'], steps: [`repeat ${n}`, `press @${key} 60`, `wait ${interval}`, 'endrepeat'] };
    }
    case 'swap': {
      if (!MOVE_KEYS.includes(key) || !MOVE_KEYS.includes(key2) || key === key2) {
        throw new Error('Tauschen geht nur zwischen zwei verschiedenen Bewegungstasten (vor/links/zurück/rechts).');
      }
      return { requires: ['live'], steps: [`release @${key} @${key2}`, `swap @${key} @${key2}`, `swap @${key2} @${key}`, `wait ${dur}`, 'unblock'] };
    }
    default:
      throw new Error(`Unbekannter Effekt-Typ "${mode}".`);
  }
}

// Mehrere Bausteine zu einer Sequenz verketten.
// Läuft in der angegebenen Reihenfolge, Baustein für Baustein nacheinander ab.
function buildSequence(stepSpecs) {
  if (!Array.isArray(stepSpecs) || stepSpecs.length === 0) throw new Error('Die Sequenz braucht mindestens einen Schritt.');
  if (stepSpecs.length > BUILDER_MAX_STEPS) throw new Error(`Maximal ${BUILDER_MAX_STEPS} Schritte pro Sequenz.`);
  const steps = [];
  const requires = new Set();
  for (const spec of stepSpecs) {
    const built = buildStep(spec);
    steps.push(...built.steps);
    for (const r of built.requires) requires.add(r);
  }
  const { ms: totalMs } = estimate(expand(steps));
  if (totalMs > BUILDER_MAX_TOTAL_MS) {
    throw new Error(`Die Sequenz dauert zusammen ${Math.round(totalMs / 1000)}s - maximal ${BUILDER_MAX_TOTAL_MS / 1000}s erlaubt.`);
  }
  return { requires: [...requires], effect: { steps } };
}

// Wirft bei ungültiger Eingabe; gibt sonst { requires, effect } zurück (passend für addAction).
// spec.steps (Array) → freie Sequenz aus mehreren Bausteinen; sonst ein einzelner Baustein wie
// bisher - beide Formen laufen am Ende durch dieselbe Validierung (validateAction).
export function buildEffect(spec) {
  if (spec && Array.isArray(spec.steps)) return buildSequence(spec.steps);
  const built = buildStep(spec);
  return { requires: built.requires, effect: { steps: built.steps } };
}
