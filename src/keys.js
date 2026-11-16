// Tasten-Erlaubnisliste in drei Stufen:
//
//   normal    überall erlaubt (mitgeliefert, Baukasten, lokale Aktionen, importierte Presets)
//   kritisch  in vielen Spielen reguläre Steuerung (Enter, Escape, Alt, ...), außerhalb des Spiels
//             aber folgenreich. In IMPORTIERTEN Presets nie erlaubt; in lokalen Aktionen erst,
//             nachdem der Nutzer die Taste ausdrücklich freigegeben hat (cfg.input.criticalKeys).
//   gesperrt  alles andere - insbesondere die Windows-Tasten. Nie erlaubt, auch nicht nach Freigabe.
//
// Bewusst eine ERLAUBNIS-Liste: was hier nicht steht, ist gesperrt. Das schließt auch AutoHotkeys
// Roh-Codes ("vk5B", "sc15B") aus, mit denen sich jede Taste an einer Verbotsliste vorbei benennen
// ließe. Namen sind AutoHotkey-Tastennamen; Groß-/Kleinschreibung ist wie in AutoHotkey egal.
//
// Diese Datei hat keine Abhängigkeiten und keinen Zustand - sie wird von steps.js (jede Taste, die
// tatsächlich gesendet wird) und config.js (Import, Freigabe-Einstellung) benutzt.

const range = (prefix, from, to) => Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`);

const NORMAL = new Set([
  ...'abcdefghijklmnopqrstuvwxyz0123456789',
  ...range('f', 1, 12),
  'space', 'tab', 'capslock',
  'shift', 'lshift', 'rshift', 'ctrl', 'lctrl', 'rctrl', 'control', 'lcontrol', 'rcontrol',
  'up', 'down', 'left', 'right',
  ...range('numpad', 0, 9), 'numpaddot', 'numpaddiv', 'numpadmult', 'numpadadd', 'numpadsub',
  // NumpadEnter zählt als normal: die mitgelieferten CS2-Binds liegen auf dem Nummernblock
  // (cs2.js), "Maus invertieren" standardmäßig genau auf dieser Taste.
  'numpadenter',
  'lbutton', 'rbutton', 'mbutton', 'xbutton1', 'xbutton2', 'wheelup', 'wheeldown',
]);

// Anzeigename -> alle AutoHotkey-Schreibweisen derselben Taste. Die Freigabe gilt immer für die
// ganze Zeile (wer "Alt" freigibt, gibt LAlt/RAlt mit frei).
export const CRITICAL_KEY_GROUPS = Object.freeze({
  Enter: ['enter', 'return'],
  Escape: ['escape', 'esc'],
  Alt: ['alt', 'lalt', 'ralt'],
  Backspace: ['backspace', 'bs'],
  Delete: ['delete', 'del'],
  Insert: ['insert', 'ins'],
  Home: ['home'],
  End: ['end'],
  PgUp: ['pgup'],
  PgDn: ['pgdn'],
});
const CRITICAL = new Map(); // Schreibweise -> Anzeigename
for (const [group, names] of Object.entries(CRITICAL_KEY_GROUPS)) for (const n of names) CRITICAL.set(n, group);

export const CRITICAL_KEY_NAMES = Object.freeze(Object.keys(CRITICAL_KEY_GROUPS));

// Gibt 'normal' | 'critical' | 'blocked' zurück.
export function classifyKey(name) {
  const k = String(name).toLowerCase();
  if (NORMAL.has(k)) return 'normal';
  if (CRITICAL.has(k)) return 'critical';
  return 'blocked';
}

// Für welche Freigabe-Gruppe steht diese Schreibweise? (null, wenn keine kritische Taste)
export function criticalGroup(name) {
  return CRITICAL.get(String(name).toLowerCase()) || null;
}

// Prüft EINE Taste gegen eine Freigabe. allowed: Iterable von Gruppennamen (z. B. ['Alt']) oder
// leer/undefined für "keine kritische Taste erlaubt" (das gilt für jeden Import).
// Gibt einen Fehlertext zurück oder null.
export function keyError(name, allowed) {
  const cls = classifyKey(name);
  if (cls === 'normal') return null;
  if (cls === 'critical') {
    const group = criticalGroup(name);
    for (const a of allowed || []) if (a === group) return null;
    return `Die Taste "${name}" ist eine kritische Taste (${group}) und nicht freigegeben.`;
  }
  return `Die Taste "${name}" ist gesperrt oder unbekannt.`;
}

// Besonders gefährliche Systemkombinationen: nie erlaubt, auch wenn jede einzelne Taste erlaubt
// oder freigegeben wäre. Die Schritt-Sprache kann zwar keine zwei Tasten gleichzeitig HALTEN (hold
// wartet, bis losgelassen ist), aber eine vom Zuschauer ausgelöste Aktion läuft, während der
// Streamer selbst Tasten gedrückt hält, und swap/block verändern, was dessen Tasten bewirken -
// deshalb gilt die Regel für die Menge aller Tasten EINER Aktion.
const FAMILY = (k) => (/^[lr]?alt$/.test(k) ? 'alt' : /^[lr]?(ctrl|control)$/.test(k) ? 'ctrl' : k === 'esc' ? 'escape' : k === 'del' ? 'delete' : k);
const COMBOS = [
  ['alt', 'f4'], ['alt', 'tab'], ['alt', 'escape'], ['alt', 'space'], ['alt', 'delete'], ['ctrl', 'escape'],
];
export function comboError(keyNames) {
  const fam = new Set([...keyNames].map((k) => FAMILY(String(k).toLowerCase())));
  for (const [a, b] of COMBOS) {
    if (fam.has(a) && fam.has(b)) return `Die Tasten "${a}" und "${b}" dürfen nicht in derselben Aktion vorkommen (gesperrte Systemkombination).`;
  }
  return null;
}
