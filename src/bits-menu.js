// Bits-Menü: Zuschauer wählen den Effekt über ein Stichwort in der Cheer-Nachricht
// ("Cheer300 maus" = 3 Minuten Maus invertiert), die Menge bestimmt, wie viel sie bekommen.
//
// Jeder Menüpunkt hat einen Preis pro Einheit und eine Abrechnung:
//   minute = Spielzeit in Minuten (läuft in Abschnitten von höchstens einer Minute, siehe steps.js;
//            unterbrochene Zeit läuft weiter, sobald wieder gespielt wird - gekauft ist Spielzeit)
//   round  = ganze Runden (der Effekt läuft bis Rundenende, jede Runde zählt eine Einheit)
//   once   = einmaliger Effekt (z. B. ein eigener Effekt aus dem Baukasten oder die Herausforderung)
//
// Zu kleine Cheers und Cheers mit dem Topf-Stichwort landen im Gemeinschaftstopf: viele kleine
// Beträge lösen zusammen einen großen Effekt aus.

// Lauf-Vorlagen: Schritte für einen Abschnitt. Nur Tasten aus der eigenen Belegung (@...).
const T = {
  walk: (ms) => [`hold @walk ${ms}`],
  mouse: (ms) => ['oncleanup press @restoreExtra', 'press @mouseInv', `wait ${ms}`, 'press @restoreExtra'],
  wasd: (ms) => ['release @forward @left @back @right', 'swap @forward @back', 'swap @back @forward', 'swap @left @right', 'swap @right @left', `wait ${ms}`, 'unblock'],
  crosshair: (ms) => ['oncleanup press @restoreExtra', 'press @xhBig', `wait ${ms}`, 'press @restoreExtra'],
};
// Mehrere Vorlagen gleichzeitig (für die Eskalation): Vorbereitungen, eine gemeinsame Wartezeit, Aufräumen.
function combo(ids, ms) {
  const pre = [], post = [];
  for (const id of ids) {
    if (id === 'mouse') { pre.push('oncleanup press @restoreExtra', 'press @mouseInv'); post.push('press @restoreExtra'); }
    if (id === 'crosshair') { pre.push('oncleanup press @restoreExtra', 'press @xhBig'); post.push('press @restoreExtra'); }
    if (id === 'wasd') { pre.push('release @forward @left @back @right', 'swap @forward @back', 'swap @back @forward', 'swap @left @right', 'swap @right @left'); post.push('unblock'); }
    if (id === 'walk') { pre.push('release @walk', 'block @walk'); post.push('unblock'); }
  }
  if (ids.length === 1 && ids[0] === 'walk') return T.walk(ms);
  return [...pre, `wait ${ms}`, ...new Set(post)];
}
const ESCALATION = [['walk'], ['mouse'], ['wasd'], ['wasd', 'crosshair'], ['wasd', 'mouse', 'crosshair']];
export const ROULETTE_POOL = ['walk', 'mouse', 'wasd', 'crosshair'];

export const BITS_MENU_TEMPLATES = {
  walk: { title: 'Nur Schleichen', title_en: 'Walk only', units: ['minute'], steps: (ms) => T.walk(ms) }, // Halten hat eine feste Dauer - keine Runden
  mouse: { title: 'Maus invertiert', title_en: 'Inverted mouse', units: ['minute', 'round'], steps: (ms) => T.mouse(ms) },
  wasd: { title: 'WASD invertiert', title_en: 'WASD inverted', units: ['minute', 'round'], steps: (ms) => T.wasd(ms) },
  crosshair: { title: 'Fadenkreuz riesig', title_en: 'Huge crosshair', units: ['minute', 'round'], steps: (ms) => T.crosshair(ms) },
  buylock: {
    title: 'Kauf-Sperre', title_en: 'Buy lock', units: ['minute', 'round'],
    steps: (ms) => ['release @buy', 'block @buy', `wait ${ms}`, 'unblock'],
    anyPhase: true, // Kaufen geht gerade in der Kaufzeit - läuft also auch außerhalb der laufenden Runde
  },
  // Wird jede Minute schlimmer.
  escalate: { title: 'Chaos-Eskalation', title_en: 'Chaos escalation', units: ['minute'], steps: (ms, part) => combo(ESCALATION[Math.min(part, ESCALATION.length - 1)], ms) },
  // Jede Minute ein anderer leichter Effekt - die Reihenfolge steht beim Kauf fest und wird angesagt.
  roulette: { title: 'Chaos-Roulette', title_en: 'Chaos roulette', units: ['minute'], steps: (ms, part, ctx) => T[ctx?.seq?.[part] || 'walk'](ms) },
  // Kein Tasten-Effekt: eine Aufgabe mit Zeitlimit für den Streamer (siehe engine.js runChallenge).
  challenge: { title: 'Herausforderung', title_en: 'Challenge', units: ['once'], challenge: true, steps: () => [] },
};

const DEFAULT_PRICE = { challenge: 500 };

export const BITS_MENU_DEFAULT = {
  enabled: true,
  bitsPerMinute: 100,
  maxMinutes: 5,
  maxPerStream: 0, // Einheiten pro Stream, 0 = unbegrenzt
  noKeyword: 'random', // 'random' = zufällig aus dem Menü, 'none' = nur Danke, sonst ein Menüpunkt
  items: [
    { id: 'walk', keyword: 'shift', enabled: true },
    { id: 'mouse', keyword: 'maus', enabled: true },
    { id: 'wasd', keyword: 'wasd', enabled: true },
    { id: 'crosshair', keyword: 'fadenkreuz', enabled: false },
    { id: 'buylock', keyword: 'kauf', enabled: false },
    { id: 'escalate', keyword: 'eskalation', enabled: false },
    { id: 'roulette', keyword: 'roulette', enabled: false },
    { id: 'challenge', keyword: 'challenge', enabled: false, price: 500 },
  ],
  custom: [], // eigene Effekte: { actionId, keyword, enabled, price } - immer einmalig
  challenge: { kills: 3, minutes: 5, weapon: 'any' },
  pot: { enabled: true, goal: 500, keyword: 'topf', effect: 'escalate', minutes: 3 },
};

export const CHUNK_MS = 60000;
const KEYWORD_RE = /^[a-z0-9äöüß]{2,20}$/;
const intIn = (v, lo, hi, what) => {
  const n = Math.round(Number(v));
  if (!(n >= lo && n <= hi)) throw new Error(`${what}: ${lo} bis ${hi}.`);
  return n;
};

export function normalizeBitsMenu(menu) {
  const m = menu && typeof menu === 'object' ? menu : {};
  const D = BITS_MENU_DEFAULT;
  const bpm = intIn(m.bitsPerMinute ?? D.bitsPerMinute, 1, 100000, 'Bits pro Minute');
  const max = intIn(m.maxMinutes ?? D.maxMinutes, 1, 30, 'Höchstens am Stück');
  const maxPerStream = intIn(m.maxPerStream ?? D.maxPerStream, 0, 1000, 'Obergrenze pro Stream');
  const given = Array.isArray(m.items) ? m.items : D.items;
  for (const x of given) if (x && !BITS_MENU_TEMPLATES[x.id]) throw new Error(`Unbekannter Bits-Menü-Effekt: ${String(x.id).slice(0, 30)}`);
  const seen = new Set();
  const useKeyword = (kw, label) => {
    const keyword = String(kw ?? '').trim().toLowerCase();
    if (!KEYWORD_RE.test(keyword)) throw new Error(`Stichwort für "${label}": 2-20 Buchstaben/Ziffern, keine Leerzeichen.`);
    if (seen.has(keyword)) throw new Error(`Das Stichwort "${keyword}" ist doppelt vergeben.`);
    seen.add(keyword);
    return keyword;
  };
  const items = [];
  for (const id of Object.keys(BITS_MENU_TEMPLATES)) {
    const t = BITS_MENU_TEMPLATES[id];
    const it = given.find((x) => x && x.id === id) || D.items.find((x) => x.id === id);
    const unit = t.units.includes(it.unit) ? it.unit : t.units[0];
    const price = it.price === undefined || it.price === null || it.price === '' ? (DEFAULT_PRICE[id] ?? null) : intIn(it.price, 1, 100000, `Preis für "${t.title}"`);
    items.push({ id, keyword: useKeyword(it.keyword, t.title), enabled: it.enabled !== false, unit, price,
      cooldownSec: intIn(it.cooldownSec ?? 0, 0, 3600, `Cooldown für "${t.title}"`) });
  }
  const custom = (Array.isArray(m.custom) ? m.custom : D.custom).slice(0, 10).map((c) => {
    if (!c || typeof c.actionId !== 'string' || !/^[\w-]{1,64}$/.test(c.actionId)) throw new Error('Eigener Bits-Menü-Effekt ohne gültige Aktion.');
    return { actionId: c.actionId, keyword: useKeyword(c.keyword, c.actionId), enabled: c.enabled !== false, price: intIn(c.price ?? bpm, 1, 100000, 'Preis eines eigenen Effekts'),
      cooldownSec: intIn(c.cooldownSec ?? 0, 0, 3600, 'Cooldown eines eigenen Effekts') };
  });
  const ids = [...items.map((i) => i.id), ...custom.map((c) => `act:${c.actionId}`)];
  const noKeyword = m.noKeyword ?? D.noKeyword;
  if (!['random', 'none'].includes(noKeyword) && !ids.includes(noKeyword)) throw new Error('Ohne Stichwort: "random", "none" oder ein Menüpunkt.');
  const ch = m.challenge && typeof m.challenge === 'object' ? m.challenge : D.challenge;
  const challenge = { kills: intIn(ch.kills ?? 3, 1, 20, 'Kills der Herausforderung'), minutes: intIn(ch.minutes ?? 5, 1, 15, 'Minuten der Herausforderung'),
    weapon: ['any', 'pistol', 'knife'].includes(ch.weapon) ? ch.weapon : 'any' };
  const p = m.pot && typeof m.pot === 'object' ? m.pot : D.pot;
  const potEffect = BITS_MENU_TEMPLATES[p.effect]?.units.includes('minute') ? p.effect : 'escalate';
  const pot = { enabled: p.enabled !== false, goal: intIn(p.goal ?? 500, 50, 100000, 'Ziel des Gemeinschaftstopfs'), keyword: useKeyword(p.keyword ?? 'topf', 'Gemeinschaftstopf'),
    effect: potEffect, minutes: intIn(p.minutes ?? 3, 1, 10, 'Minuten des Topf-Effekts') };
  return { enabled: m.enabled !== undefined ? !!m.enabled : D.enabled, bitsPerMinute: bpm, maxMinutes: max, maxPerStream, noKeyword, items, custom, challenge, pot };
}

// Preis einer Einheit eines Menüpunkts.
export const unitPrice = (menu, entry) => entry.price || menu.bitsPerMinute;

// Alle aktiven Menüpunkte einheitlich: { key, id, kind: 'template'|'action', keyword, unit, price, cooldownSec }
export function menuEntries(menu, actionsById = null) {
  const out = [];
  for (const it of menu.items) if (it.enabled) out.push({ key: it.id, id: it.id, kind: 'template', keyword: it.keyword, unit: it.unit, price: unitPrice(menu, it), cooldownSec: it.cooldownSec });
  for (const c of menu.custom || []) {
    if (!c.enabled || (actionsById && !actionsById.get(c.actionId))) continue;
    out.push({ key: `act:${c.actionId}`, id: c.actionId, kind: 'action', keyword: c.keyword, unit: 'once', price: c.price, cooldownSec: c.cooldownSec });
  }
  return out;
}

const words = (message) => String(message || '').toLowerCase().replace(/\b[a-z]+\d+\b/g, ' ').split(/[^a-z0-9äöüß]+/).filter(Boolean);

// Stichwort aus der Cheer-Nachricht. Cheermotes ("Cheer100", "Kappa50") werden vorher entfernt.
export function findKeyword(message, entries) {
  for (const w of words(message)) {
    const hit = entries.find((i) => i.keyword === w);
    if (hit) return hit;
  }
  return null;
}

// Aus einem Cheer: was passiert. Ergebnis:
//   { blocks: [{ key, id, kind, unit, units, chosenBy, seq? }], pot: <Bits für den Topf> }
// Mehr Einheiten als maxMinutes werden zu weiteren Blöcken.
export function planCheer(menu, bits, message, rand = Math.random, actionsById = null) {
  if (!menu?.enabled) return { blocks: [], pot: 0 };
  const toPot = menu.pot?.enabled ? bits : 0;
  const entries = menuEntries(menu, actionsById);
  if (menu.pot?.enabled && words(message).includes(menu.pot.keyword)) return { blocks: [], pot: bits };
  let entry = findKeyword(message, entries);
  let chosenBy = 'keyword';
  if (!entry) {
    if (menu.noKeyword === 'none') return { blocks: [], pot: toPot };
    if (menu.noKeyword !== 'random') entry = entries.find((e) => e.key === menu.noKeyword);
    else {
      // Zufällig nur aus Punkten, die man sich mit diesem Betrag leisten kann.
      const affordable = entries.filter((e) => bits >= e.price);
      entry = affordable[Math.floor(rand() * affordable.length)];
    }
    chosenBy = 'random';
  }
  if (!entry) return { blocks: [], pot: toPot };
  const units = Math.floor(Number(bits) / entry.price);
  if (units < 1) return { blocks: [], pot: toPot }; // zu wenig für diesen Punkt: geht in den Topf
  const blocks = [];
  for (let left = units; left > 0; left -= menu.maxMinutes) {
    const n = Math.min(left, menu.maxMinutes);
    const b = { key: entry.key, id: entry.id, kind: entry.kind, unit: entry.unit, units: n, chosenBy, minutes: n };
    if (entry.id === 'roulette') b.seq = rouletteSeq(n, rand);
    blocks.push(b);
  }
  return { blocks, pot: 0 };
}

// Roulette-Reihenfolge: nie zweimal derselbe Effekt direkt hintereinander.
export function rouletteSeq(n, rand = Math.random) {
  const seq = [];
  for (let i = 0; i < n; i++) {
    const pool = ROULETTE_POOL.filter((x) => x !== seq[i - 1]);
    seq.push(pool[Math.floor(rand() * pool.length)]);
  }
  return seq;
}

export const templateTitle = (id, locale) => (locale === 'en' ? BITS_MENU_TEMPLATES[id]?.title_en : BITS_MENU_TEMPLATES[id]?.title) || id;

// "bis Rundenende" statt fester Dauer: die erste feste Wartezeit wird zu until_stop.
function roundify(steps) {
  let done = false;
  return steps.map((l) => (!done && /^wait \d+$/.test(l) ? ((done = true), 'until_stop') : l));
}

// Die Aktion für einen Abschnitt einer Vorlage (ms <= CHUNK_MS bei Minuten).
export function menuAction(id, ms, unitsTotal, locale = 'de', { unit = 'minute', part = 0, seq = null } = {}) {
  const t = BITS_MENU_TEMPLATES[id];
  const title = templateTitle(id, locale);
  const en = locale === 'en';
  const amount = unit === 'round' ? (en ? `${unitsTotal} round(s)` : `${unitsTotal} Runde(n)`) : unit === 'once' ? '' : (en ? `${unitsTotal} min` : `${unitsTotal} Min.`);
  let steps = t.steps(Math.round(ms), part, { seq });
  if (unit === 'round') steps = roundify(steps);
  return {
    id: `bitsmenu_${id}`, title, category: 'bits', enabled: true,
    flavor: amount ? (en ? `${amount} bought with Bits` : `${amount} mit Bits gekauft`) : (en ? 'bought with Bits' : 'mit Bits gekauft'),
    requires: t.anyPhase ? [] : ['live'],
    effect: t.challenge ? {} : { steps },
  };
}

export const rouletteText = (seq, locale = 'de') => seq.map((x) => templateTitle(x, locale)).join(' → ');

// Text für "!bits" im Chat.
export function menuChatText(menu, locale = 'de', actionsById = null) {
  const en = locale === 'en';
  const unitWord = (u) => (u === 'round' ? (en ? 'round' : 'Runde') : u === 'once' ? (en ? 'once' : 'einmal') : (en ? 'min' : 'Min.'));
  const entries = menuEntries(menu, actionsById);
  const list = entries.map((e) => {
    const name = e.kind === 'action' ? (actionsById?.get(e.id)?.title || e.id) : templateTitle(e.id, locale);
    return `${e.keyword} (${name}, ${e.price} Bits/${unitWord(e.unit)})`;
  }).join(', ');
  const first = entries[0];
  const pot = menu.pot?.enabled ? (en ? ` Smaller cheers or "${menu.pot.keyword}" fill the community pot.` : ` Kleinere Cheers oder „${menu.pot.keyword}“ füllen den Gemeinschaftstopf.`) : '';
  return en
    ? `💜 Bits menu: put a keyword in your cheer, e.g. "Cheer${(first?.price || menu.bitsPerMinute) * 2} ${first?.keyword || ''}": ${list}. Max ${menu.maxMinutes} at once.${pot}`
    : `💜 Bits-Menü: Stichwort in die Cheer-Nachricht, z. B. "Cheer${(first?.price || menu.bitsPerMinute) * 2} ${first?.keyword || ''}": ${list}. Max. ${menu.maxMinutes} am Stück.${pot}`;
}
