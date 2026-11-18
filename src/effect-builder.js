// Effekt-Baukasten (Dashboard): erzeugt Effekt-Schritte aus wenigen, sicheren Bausteinen statt
// freier Skripte. Jeder Baustein nutzt nur Tasten aus der eigenen Belegung (config.keys) und die
// festen CS2-Befehls-Tasten, die ChaosCore selbst anlegt (cs2.js). Das Ergebnis läuft danach durch
// dieselbe Prüfung (validateAction/compile) wie jeder mitgelieferte Effekt.
//
// Jeder Baustein räumt hinter sich auf (endet nie mit einer dauerhaft belegten Taste und stellt
// geänderte Spielwerte wieder her). Darum ist eine Kette aus Bausteinen genauso sicher wie einer.
//
// Bauplan (wird beim Effekt gespeichert, damit er sich später wieder öffnen lässt):
//   { blocks: [Baustein, ...], order: 'all' | 'random', repeat: 1..5 }
//   order 'all'    = nacheinander (repeat = so oft hintereinander)
//   order 'random' = bei jeder Einlösung zufällig EINER der Bausteine
// Baustein: { mode, key?, key2?, ms?, intervalMs?, round?, from?, scale? }
//   round: true = bis Rundenende statt fester Dauer (nur als letzter Baustein)
//
// Ältere Formen bleiben gültig: ein einzelner Baustein { mode, key, ... } und { steps: [...] }.
import { estimate, expand } from './steps.js';

// Physische Tasten, die der Streamer selbst im Spiel belegt hat (keine internen Befehls-Tasten).
export const BUILDER_KEYS = [
  'forward', 'left', 'back', 'right', 'jump', 'duck', 'use', 'drop', 'inspect', 'walk',
  'scoreboard', 'buy', 'primary', 'secondary', 'knife', 'grenades', 'c4', 'last', 'flash',
];
const MOVE_KEYS = ['forward', 'left', 'back', 'right'];

const KEY_LABELS = {
  forward: ['Vorwärts', 'Forward'], left: ['Links', 'Left'], back: ['Rückwärts', 'Back'], right: ['Rechts', 'Right'],
  jump: ['Springen', 'Jump'], duck: ['Ducken', 'Crouch'], use: ['Benutzen', 'Use'], drop: ['Waffe fallen lassen', 'Drop weapon'],
  inspect: ['Inspizieren', 'Inspect'], walk: ['Schleichen', 'Walk'], scoreboard: ['Scoreboard', 'Scoreboard'], buy: ['Kaufmenü', 'Buy menu'],
  primary: ['Hauptwaffe', 'Primary'], secondary: ['Pistole', 'Pistol'], knife: ['Messer', 'Knife'], grenades: ['Granaten', 'Grenades'],
  c4: ['C4', 'C4'], last: ['Letzte Waffe', 'Last weapon'], flash: ['Blendgranate', 'Flashbang'],
};
export const keyLabel = (k, locale = 'de') => (KEY_LABELS[k] ? KEY_LABELS[k][locale === 'en' ? 1 : 0] : k);
export const BUILDER_KEY_LABELS = KEY_LABELS;

// needsKey: braucht eine Taste. game: nur in diesem Spiel-Profil (nutzt dessen eigene Befehls-Tasten).
// canRound: kann "bis Rundenende" laufen.
export const BUILDER_MODES = [
  { id: 'block', label: 'Sperren', label_en: 'Block', desc: 'Taste für eine Dauer sperren (z. B. Springen sperren).', needsKey: true, canRound: true },
  { id: 'hold', label: 'Halten', label_en: 'Hold', desc: 'Taste für eine Dauer automatisch gedrückt halten (z. B. Ducken).', needsKey: true },
  { id: 'spam', label: 'Spam', label_en: 'Spam', desc: 'Taste in kurzen Abständen wiederholt drücken.', needsKey: true },
  { id: 'swap', label: 'Tauschen', label_en: 'Swap', desc: 'Zwei Bewegungstasten für eine Dauer vertauschen.', needsKey: true, canRound: true },
  { id: 'fire', label: 'Schießen sperren', label_en: 'No shooting', desc: 'Linke Maustaste wirkt nicht.', game: 'cs2', canRound: true },
  { id: 'zoom', label: 'Zielen sperren', label_en: 'No aiming', desc: 'Rechte Maustaste wirkt nicht.', game: 'cs2', canRound: true },
  { id: 'mouseinv', label: 'Maus invertieren', label_en: 'Invert mouse', desc: 'Hoch und runter vertauscht.', game: 'cs2', canRound: true },
  { id: 'xhhide', label: 'Fadenkreuz weg', label_en: 'Hide crosshair', desc: 'Kein Fadenkreuz.', game: 'cs2', canRound: true },
  { id: 'xhbig', label: 'Fadenkreuz riesig', label_en: 'Huge crosshair', desc: 'Riesiges Fadenkreuz.', game: 'cs2', canRound: true },
  { id: 'pause', label: 'Pause', label_en: 'Pause', desc: 'Kurz nichts tun (zwischen zwei Bausteinen).' },
  { id: 'original', label: 'Vorhandener Effekt', label_en: 'Existing effect', desc: 'Ein vorhandener Effekt, auf Wunsch kürzer oder länger.' },
];

export const BUILDER_MAX_STEPS = 8;
export const BUILDER_MAX_TOTAL_MS = 90000;
export const BUILDER_MAX_REPEAT = 5;

function clampMs(v, min, max, fallback) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

// Dauer eines vorhandenen Effekts strecken/stauchen: Wartezeiten, Haltedauern und Wiederholungen.
export function scaleSteps(steps, scale) {
  const f = Math.min(3, Math.max(0.25, Number(scale) || 1));
  if (f === 1) return [...steps];
  const ms = (n) => String(Math.min(60000, Math.max(1, Math.round(Number(n) * f))));
  return steps.map((l) => {
    let m = l.match(/^wait (\d+)$/);
    if (m) return `wait ${ms(m[1])}`;
    m = l.match(/^(hold \S+) (\d+)$/);
    if (m) return `${m[1]} ${ms(m[2])}`;
    m = l.match(/^repeat (\d+)$/);
    if (m) return `repeat ${Math.max(1, Math.min(200, Math.round(Number(m[1]) * f)))}`;
    return l;
  });
}

// Ein Baustein -> Schritte. ctx.actions: Map id -> Aktion (für "Vorhandener Effekt").
function buildStep(spec, ctx = {}) {
  const { mode, key, key2 } = spec || {};
  const mdef = BUILDER_MODES.find((m) => m.id === mode);
  if (!mdef) throw new Error(`Unbekannter Effekt-Typ "${mode}".`);
  if (mdef.game && ctx.profile && ctx.profile !== mdef.game) throw new Error(`„${mdef.label}“ gibt es nur für CS2.`);
  if (mdef.needsKey && !BUILDER_KEYS.includes(key)) throw new Error(`Unbekannte Taste "${key}".`);
  const round = !!spec.round;
  if (round && !mdef.canRound) throw new Error(`„${mdef.label}“ kann nicht bis Rundenende laufen.`);
  const dur = clampMs(spec.ms, 500, 60000, 3000);
  const hold = round ? 'until_stop' : `wait ${dur}`;
  switch (mode) {
    case 'block':
      return { requires: ['live'], steps: [`release @${key}`, `block @${key}`, hold, 'unblock'] };
    case 'hold':
      return { requires: ['live'], steps: [`hold @${key} ${dur}`] };
    case 'spam': {
      const interval = clampMs(spec.intervalMs, 80, 2000, 150);
      const n = Math.max(1, Math.min(200, Math.round(dur / interval)));
      return { requires: ['live'], steps: [`repeat ${n}`, `press @${key} 60`, `wait ${interval}`, 'endrepeat'] };
    }
    case 'swap': {
      if (!MOVE_KEYS.includes(key) || !MOVE_KEYS.includes(key2) || key === key2) {
        throw new Error('Tauschen geht nur zwischen zwei verschiedenen Bewegungstasten (vor/links/zurück/rechts).');
      }
      return { requires: ['live'], steps: [`release @${key} @${key2}`, `swap @${key} @${key2}`, `swap @${key2} @${key}`, hold, 'unblock'] };
    }
    case 'fire':
      return { requires: ['live'], steps: ['oncleanup press @fireOn', 'press @fireOff', 'release LButton', 'block LButton', hold, 'unblock', 'press @fireOn'] };
    case 'zoom':
      return { requires: ['live'], steps: ['oncleanup press @zoomOn', 'press @zoomOff', 'release RButton', 'block RButton', hold, 'unblock', 'press @zoomOn'] };
    case 'mouseinv':
      return { requires: ['live'], steps: ['oncleanup press @restoreExtra', 'press @mouseInv', hold, 'press @restoreExtra'] };
    case 'xhhide':
      return { requires: ['live'], steps: ['oncleanup press @xhOn', 'press @xhOff', hold, 'press @xhOn'] };
    case 'xhbig':
      return { requires: ['live'], steps: ['oncleanup press @restoreExtra', 'press @xhBig', hold, 'press @restoreExtra'] };
    case 'pause':
      return { requires: [], steps: [`wait ${dur}`] };
    case 'original': {
      const src = ctx.actions?.get?.(String(spec.from || ''));
      if (!src) throw new Error('Der gewählte vorhandene Effekt existiert nicht.');
      if (src.effect?.variants) throw new Error(`„${src.title}“ ist selbst zufällig und lässt sich nicht als Baustein verwenden.`);
      const steps = src.effect?.steps;
      if (!Array.isArray(steps) || !steps.length) throw new Error(`„${src.title}“ ist ein Sondereffekt und lässt sich nicht als Baustein verwenden.`);
      return { requires: src.requires || ['live'], steps: scaleSteps(steps, spec.scale) };
    }
    default:
      throw new Error(`Unbekannter Effekt-Typ "${mode}".`);
  }
}

// Nur die Felder eines Bausteins, die es gibt (der Bauplan wird gespeichert und wieder angezeigt).
function cleanBlock(b) {
  const o = { mode: String(b?.mode || '') };
  for (const k of ['key', 'key2', 'from']) if (typeof b?.[k] === 'string') o[k] = b[k].slice(0, 64);
  for (const k of ['ms', 'intervalMs', 'scale']) if (Number.isFinite(Number(b?.[k])) && b?.[k] !== undefined && b?.[k] !== null && b?.[k] !== '') o[k] = Number(b[k]);
  if (b?.round) o.round = true;
  return o;
}

// Bauplan aus allen erlaubten Formen in die eine aktuelle Form bringen.
export function normalizeSpec(spec) {
  let s;
  if (spec && Array.isArray(spec.blocks)) s = { blocks: spec.blocks, order: spec.order === 'random' ? 'random' : 'all', repeat: Math.max(1, Math.min(BUILDER_MAX_REPEAT, Math.round(Number(spec.repeat) || 1))) };
  else if (spec && Array.isArray(spec.steps)) s = { blocks: spec.steps, order: 'all', repeat: 1 };
  else s = { blocks: [spec], order: 'all', repeat: 1 };
  return { ...s, blocks: s.blocks.slice(0, BUILDER_MAX_STEPS + 1).map(cleanBlock) };
}

const usesUntilStop = (steps) => steps.some((l) => l.trim() === 'until_stop');

// Wirft bei ungültiger Eingabe; gibt sonst { requires, effect, builder } zurück.
export function buildEffect(input, ctx = {}) {
  const spec = normalizeSpec(input);
  if (!spec.blocks.length) throw new Error('Der Effekt braucht mindestens einen Baustein.');
  if (spec.blocks.length > BUILDER_MAX_STEPS) throw new Error(`Maximal ${BUILDER_MAX_STEPS} Bausteine pro Effekt.`);
  const built = spec.blocks.map((b) => buildStep(b, ctx));
  const requires = new Set();
  for (const b of built) for (const r of b.requires) requires.add(r);
  const check = (steps) => {
    const { ms } = estimate(expand(steps));
    if (ms > BUILDER_MAX_TOTAL_MS) throw new Error(`Der Effekt dauert zusammen ${Math.round(ms / 1000)} s - maximal ${BUILDER_MAX_TOTAL_MS / 1000} s erlaubt.`);
  };
  if (spec.order === 'random') {
    if (built.length < 2) throw new Error('„Zufällig einer“ braucht mindestens zwei Bausteine.');
    const variants = built.map((b) => b.steps);
    variants.forEach(check);
    return { requires: [...requires], effect: { variants }, builder: spec };
  }
  built.forEach((b, i) => { if (usesUntilStop(b.steps) && i < built.length - 1) throw new Error('„Bis Rundenende“ geht nur beim letzten Baustein.'); });
  let steps = built.flatMap((b) => b.steps);
  if (spec.repeat > 1) {
    if (usesUntilStop(steps)) throw new Error('„Bis Rundenende“ lässt sich nicht wiederholen.');
    // Bausteine mit eigener Wiederholung (Spam) oder schon tief verschachtelt: die Kette ausschreiben.
    if (steps.some((l) => /^repeat /.test(l))) steps = Array.from({ length: spec.repeat }, () => steps).flat();
    else steps = [`repeat ${spec.repeat}`, ...steps, 'endrepeat'];
  }
  check(steps);
  return { requires: [...requires], effect: { steps }, builder: spec };
}

// ---------- Klartext ----------
const sec = (ms, en) => {
  const s = Math.round((Number(ms) || 0) / 100) / 10;
  return en ? `${s} s` : `${String(s).replace('.', ',')} Sek.`;
};

function describeBlock(b, en, ctx) {
  const dur = b.round ? (en ? 'until the round ends' : 'bis Rundenende') : (en ? `for ${sec(b.ms ?? 3000, en)}` : `${sec(b.ms ?? 3000, en)} lang`);
  const k = (x) => keyLabel(x, en ? 'en' : 'de');
  switch (b.mode) {
    case 'block': return en ? `${k(b.key)} is blocked ${dur}` : `${k(b.key)} ist ${dur} gesperrt`;
    case 'hold': return en ? `${k(b.key)} is held down ${dur}` : `${k(b.key)} wird ${dur} gedrückt gehalten`;
    case 'spam': return en ? `${k(b.key)} is spammed ${dur}` : `${k(b.key)} wird ${dur} dauernd gedrückt`;
    case 'swap': return en ? `${k(b.key)} and ${k(b.key2)} are swapped ${dur}` : `${k(b.key)} und ${k(b.key2)} sind ${dur} vertauscht`;
    case 'fire': return en ? `no shooting ${dur}` : `${dur} kein Schießen`;
    case 'zoom': return en ? `no aiming ${dur}` : `${dur} kein Zielen`;
    case 'mouseinv': return en ? `the mouse is inverted ${dur}` : `die Maus ist ${dur} invertiert`;
    case 'xhhide': return en ? `no crosshair ${dur}` : `${dur} kein Fadenkreuz`;
    case 'xhbig': return en ? `a huge crosshair ${dur}` : `${dur} ein riesiges Fadenkreuz`;
    case 'pause': return en ? `a pause of ${sec(b.ms ?? 3000, en)}` : `${sec(b.ms ?? 3000, en)} Pause`;
    case 'original': {
      const src = ctx.actions?.get?.(String(b.from || ''));
      const name = src ? `„${src.title}“` : (en ? 'an existing effect' : 'ein vorhandener Effekt');
      const f = Math.round((Number(b.scale) || 1) * 100);
      return f === 100 ? name : `${name} (${f} %)`;
    }
    default: return '?';
  }
}

// Ein Satz in Klartext, was der Effekt macht - für Anfänger unter dem Bauplan.
export function describeSpec(input, ctx = {}, locale = 'de') {
  const en = locale === 'en';
  const spec = normalizeSpec(input);
  const parts = spec.blocks.map((b) => describeBlock(b, en, ctx));
  if (!parts.length) return '';
  let text;
  if (spec.order === 'random') text = (en ? 'Randomly one of: ' : 'Zufällig eins davon: ') + parts.join(en ? ' or ' : ' oder ');
  else text = parts.join(en ? ', then ' : ', danach ');
  if (spec.order === 'all' && spec.repeat > 1) text += en ? ` - all of that ${spec.repeat} times` : ` - das Ganze ${spec.repeat}-mal`;
  text = text.charAt(0).toUpperCase() + text.slice(1);
  return text.endsWith('.') ? text : `${text}.`;
}

// Klartext für fertige Schritte (mitgelieferte Effekte), damit man sieht, wie sie gebaut sind.
const CMD_TEXT = {
  fireOff: ['Schießen aus', 'shooting off'], fireOn: ['Schießen wieder an', 'shooting back on'], zoomOff: ['Zielen aus', 'aiming off'], zoomOn: ['Zielen wieder an', 'aiming back on'],
  xhOff: ['Fadenkreuz weg', 'crosshair hidden'], xhOn: ['Fadenkreuz wieder da', 'crosshair back'], xhBig: ['Fadenkreuz riesig', 'crosshair huge'],
  xhColor: ['Fadenkreuz-Farbe wechselt', 'crosshair color changes'], mouseInv: ['Maus invertiert', 'mouse inverted'], restoreExtra: ['eigene Werte zurück', 'own settings restored'],
  lastInv: ['zurück zur letzten Waffe', 'back to the last weapon'],
};
export function describeSteps(steps, locale = 'de') {
  const en = locale === 'en';
  const L = (x) => (x.startsWith('@') ? (CMD_TEXT[x.slice(1)]?.[en ? 1 : 0] || keyLabel(x.slice(1), locale)) : ({ LButton: en ? 'left mouse' : 'linke Maustaste', RButton: en ? 'right mouse' : 'rechte Maustaste' }[x] || x));
  const out = [];
  let blocked = [];
  for (const raw of steps || []) {
    const p = String(raw).trim().split(/\s+/);
    switch (p[0]) {
      case 'press': out.push(CMD_TEXT[p[1]?.slice(1)] ? L(p[1]) : (en ? `press ${L(p[1])}` : `${L(p[1])} drücken`)); break;
      case 'hold': out.push(en ? `hold ${L(p[1])} for ${sec(p[2], en)}` : `${L(p[1])} ${sec(p[2], en)} halten`); break;
      case 'block': blocked = p.slice(1).map(L); break;
      case 'swap': if (!out.some((x) => x.includes('⇄'))) out.push(`${L(p[1])} ⇄ ${L(p[2])}`); break;
      case 'wait': out.push(blocked.length ? (en ? `${blocked.join(', ')} blocked for ${sec(p[1], en)}` : `${blocked.join(', ')} ${sec(p[1], en)} gesperrt`) : (en ? `wait ${sec(p[1], en)}` : `${sec(p[1], en)} warten`)); break;
      case 'until_stop': out.push(blocked.length ? (en ? `${blocked.join(', ')} blocked until the round ends` : `${blocked.join(', ')} bis Rundenende gesperrt`) : (en ? 'until the round ends' : 'bis Rundenende')); break;
      case 'unblock': blocked = []; break;
      case 'repeat': out.push(`${p[1]}×:`); break;
      case 'click': out.push(en ? 'click' : 'Klick'); break;
      case 'look': case 'mouse': out.push(en ? 'the view is turned' : 'der Blick wird gedreht'); break;
      default: break;
    }
  }
  const text = out.filter((x, i) => x !== out[i - 1]).join(' → ');
  return text || (en ? 'Overlay message only' : 'Nur eine Einblendung im Overlay');
}

// Klartext für eine ganze Aktion (auch Sondereffekte).
export function describeAction(a, locale = 'de') {
  const en = locale === 'en';
  const eff = a?.effect || {};
  if (eff.dynamic === 'curse') return en ? 'Spins a wheel and runs a random challenge.' : 'Dreht ein Glücksrad und startet eine zufällige Herausforderung.';
  if (eff.dynamic === 'utility') return en ? 'Throws the next grenade in your inventory.' : 'Wirft die nächste Granate aus deinem Inventar.';
  if (eff.dynamic === 'flash') return en ? 'Throws your own flashbang.' : 'Wirft deine eigene Blendgranate.';
  if (eff.overlay) return en ? 'Shows a random choice in the overlay.' : 'Zeigt eine zufällige Auswahl im Overlay.';
  if (eff.variants) return (en ? 'Randomly one of: ' : 'Zufällig eins davon: ') + eff.variants.map((v) => describeSteps(v, locale)).join(en ? ' | ' : ' | ');
  return describeSteps(eff.steps, locale);
}
