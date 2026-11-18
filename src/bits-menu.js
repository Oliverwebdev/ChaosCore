// Bits-Menü: "100 Bits = 1 Minute Chaos". Der Zuschauer wählt den Effekt über ein Stichwort in
// seiner Cheer-Nachricht (z. B. "Cheer300 maus" = 3 Minuten Maus invertiert), die Menge bestimmt
// die Dauer. Ohne Stichwort gibt es einen zufälligen Effekt aus dem Menü.
//
// Lange Effekte laufen in Abschnitten von höchstens einer Minute (Grenze eines einzelnen Schritts,
// siehe steps.js). Wird ein Abschnitt unterbrochen (Tod, Rundenende, Menü), wird die restliche
// Zeit vorne in die Warteliste gelegt und läuft weiter, sobald wieder gespielt wird - gekauft ist
// Spielzeit, nicht Uhrzeit.

// Effekt-Vorlagen: ms = Dauer dieses Abschnitts. Nur Tasten aus der eigenen Belegung (@...).
export const BITS_MENU_TEMPLATES = {
  walk: {
    title: 'Nur Schleichen', title_en: 'Walk only',
    steps: (ms) => [`hold @walk ${ms}`],
  },
  mouse: {
    title: 'Maus invertiert', title_en: 'Inverted mouse',
    steps: (ms) => ['oncleanup press @restoreExtra', 'press @mouseInv', `wait ${ms}`],
  },
  wasd: {
    title: 'WASD invertiert', title_en: 'WASD inverted',
    steps: (ms) => ['release @forward @left @back @right', 'swap @forward @back', 'swap @back @forward', 'swap @left @right', 'swap @right @left', `wait ${ms}`, 'unblock'],
  },
  crosshair: {
    title: 'Fadenkreuz riesig', title_en: 'Huge crosshair',
    steps: (ms) => ['oncleanup press @restoreExtra', 'press @xhBig', `wait ${ms}`],
  },
  buylock: {
    title: 'Kauf-Sperre', title_en: 'Buy lock',
    steps: (ms) => ['release @buy', 'block @buy', `wait ${ms}`, 'unblock'],
    anyPhase: true, // Kaufen geht gerade in der Kaufzeit - läuft also auch außerhalb der laufenden Runde
  },
};

export const BITS_MENU_DEFAULT = {
  enabled: true,
  bitsPerMinute: 100,
  maxMinutes: 5,
  noKeyword: 'random', // 'random' = zufälliger Effekt aus dem Menü, 'none' = nur Danke, kein Effekt
  items: [
    { id: 'walk', keyword: 'shift', enabled: true },
    { id: 'mouse', keyword: 'maus', enabled: true },
    { id: 'wasd', keyword: 'wasd', enabled: true },
    { id: 'crosshair', keyword: 'fadenkreuz', enabled: false },
    { id: 'buylock', keyword: 'kauf', enabled: false },
  ],
};

export const CHUNK_MS = 60000;

const KEYWORD_RE = /^[a-z0-9äöüß]{2,20}$/;

export function normalizeBitsMenu(menu) {
  const m = menu && typeof menu === 'object' ? menu : {};
  const bpm = Math.round(Number(m.bitsPerMinute ?? BITS_MENU_DEFAULT.bitsPerMinute));
  if (!(bpm >= 1 && bpm <= 100000)) throw new Error('Bits pro Minute müssen zwischen 1 und 100000 liegen.');
  const max = Math.round(Number(m.maxMinutes ?? BITS_MENU_DEFAULT.maxMinutes));
  if (!(max >= 1 && max <= 30)) throw new Error('Maximale Dauer am Stück muss zwischen 1 und 30 Minuten liegen.');
  const noKeyword = m.noKeyword ?? BITS_MENU_DEFAULT.noKeyword;
  if (!['random', 'none'].includes(noKeyword)) throw new Error('Ohne Stichwort: "random" oder "none".');
  const given = Array.isArray(m.items) ? m.items : BITS_MENU_DEFAULT.items;
  const items = [];
  const seen = new Set();
  for (const id of Object.keys(BITS_MENU_TEMPLATES)) {
    const it = given.find((x) => x && x.id === id) || BITS_MENU_DEFAULT.items.find((x) => x.id === id);
    const keyword = String(it.keyword ?? '').trim().toLowerCase();
    if (!KEYWORD_RE.test(keyword)) throw new Error(`Stichwort für "${BITS_MENU_TEMPLATES[id].title}": 2-20 Buchstaben/Ziffern, keine Leerzeichen.`);
    if (seen.has(keyword)) throw new Error(`Das Stichwort "${keyword}" ist doppelt vergeben.`);
    seen.add(keyword);
    items.push({ id, keyword, enabled: it.enabled !== false });
  }
  for (const x of given) if (x && !BITS_MENU_TEMPLATES[x.id]) throw new Error(`Unbekannter Bits-Menü-Effekt: ${String(x.id).slice(0, 30)}`);
  return { enabled: m.enabled !== undefined ? !!m.enabled : BITS_MENU_DEFAULT.enabled, bitsPerMinute: bpm, maxMinutes: max, noKeyword, items };
}

// Stichwort aus der Cheer-Nachricht. Cheermotes ("Cheer100", "Kappa50") werden vorher entfernt.
export function findKeyword(message, items) {
  const words = String(message || '').toLowerCase()
    .replace(/\b[a-z]+\d+\b/g, ' ')
    .split(/[^a-z0-9äöüß]+/).filter(Boolean);
  for (const w of words) {
    const hit = items.find((i) => i.enabled && i.keyword === w);
    if (hit) return hit;
  }
  return null;
}

// Aus einem Cheer: welche Effekte, wie lange. Ergebnis: [] (zu wenig Bits / nichts passendes)
// oder eine Liste von Blöcken zu höchstens maxMinutes (mehr Bits = weitere Blöcke).
export function planCheer(menu, bits, message, rand = Math.random) {
  if (!menu?.enabled) return [];
  const minutes = Math.floor(Number(bits) / menu.bitsPerMinute);
  if (minutes < 1) return [];
  const enabled = menu.items.filter((i) => i.enabled);
  if (!enabled.length) return [];
  let entry = findKeyword(message, menu.items);
  let chosenBy = 'keyword';
  if (!entry) {
    if (menu.noKeyword !== 'random') return [];
    entry = enabled[Math.floor(rand() * enabled.length)];
    chosenBy = 'random';
  }
  const blocks = [];
  for (let left = minutes; left > 0; left -= menu.maxMinutes) blocks.push(Math.min(left, menu.maxMinutes));
  return blocks.map((m) => ({ id: entry.id, keyword: entry.keyword, minutes: m, chosenBy }));
}

// Die Aktion für einen Abschnitt (ms <= CHUNK_MS).
export function menuAction(id, ms, minutesTotal, locale = 'de') {
  const t = BITS_MENU_TEMPLATES[id];
  const title = locale === 'en' ? t.title_en : t.title;
  return {
    id: `bitsmenu_${id}`, title, category: 'bits', enabled: true,
    flavor: locale === 'en' ? `${minutesTotal} min bought with Bits` : `${minutesTotal} Min. mit Bits gekauft`,
    requires: t.anyPhase ? [] : ['live'],
    effect: { steps: t.steps(Math.round(ms)) },
  };
}

// Text für "!bits" im Chat.
export function menuChatText(menu, locale = 'de') {
  const list = menu.items.filter((i) => i.enabled)
    .map((i) => `${i.keyword} (${locale === 'en' ? BITS_MENU_TEMPLATES[i.id].title_en : BITS_MENU_TEMPLATES[i.id].title})`).join(', ');
  return locale === 'en'
    ? `💜 Bits menu: ${menu.bitsPerMinute} Bits = 1 minute. Put a keyword in your cheer, e.g. "Cheer${menu.bitsPerMinute * 2} ${menu.items.find((i) => i.enabled)?.keyword || ''}": ${list}. Max ${menu.maxMinutes} min at once.`
    : `💜 Bits-Menü: ${menu.bitsPerMinute} Bits = 1 Minute. Stichwort in die Cheer-Nachricht, z. B. "Cheer${menu.bitsPerMinute * 2} ${menu.items.find((i) => i.enabled)?.keyword || ''}": ${list}. Max. ${menu.maxMinutes} Min. am Stück.`;
}
