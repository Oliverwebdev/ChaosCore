// Die eine zentrale Prüfstelle für Aktionen.
//
// Jeder Weg, auf dem Aktionen ins Programm kommen, läuft hier durch:
//   - Import eines Presets / One-Click-Preset  -> streng: der erste Fehler lehnt ALLES ab
//   - Laden der lokalen Aktionen-Dateien       -> nachsichtig: eine ungültige Aktion wird
//     deaktiviert und bekommt einen verständlichen Grund (a.invalid), das Profil bleibt nutzbar
//    
// Geprüft wird JEDE Aktion, auch eine deaktivierte - sie könnte später mit einem Klick aktiviert
// werden. Die Schritte selbst (Befehle, Grenzen, Tasten-Stufen) prüft steps.js: compile().
//
// Keine Abhängigkeit zu config.js (kein Dateizugriff, kein Zustand).
import { compile } from './steps.js';

export const ACCESS_LEVELS = ['everyone', 'subscriber', 'vip', 'moderator'];
// Bedingungen an den Spielzustand und Sonderaktionen, die die Engine kennt (engine.js: evaluate(),
// runAction()/runBody()). Mit Abschnitt A werden sie zu Fähigkeiten des aktiven Spiel-Profils.
export const KNOWN_REQUIRES = ['live', 'primary', 'grenade', 'flash'];
// goldenKill/roundName/goldenFrame/parliament: Bits-Effekte ab 2.0 (engine.js: runGolden, runParliament)
export const KNOWN_DYNAMIC = ['curse', 'utility', 'flash', 'goldenKill', 'roundName', 'goldenFrame', 'parliament', 'clip'];
export const MAX_ACTIONS = 200;
export const MAX_CATEGORIES = 20;

const ACTION_FIELDS = new Set([
  'id', 'title', 'title_en', 'cost', 'category', 'enabled', 'prompt', 'prompt_en', 'flavor', 'flavor_en',
  'requires', 'effect', 'access', 'legacy', 'custom', 'customEffect', 'templateId',
  'color', 'cooldownSec', 'onDeath', 'builder', 'customText', 'since',
]);
const EFFECT_FIELDS = new Set(['steps', 'variants', 'dynamic', 'overlay', 'displayMs', 'options']);
export const MAX_VARIANTS = 8;
export const ON_DEATH = ['stop', 'continue'];

// Hat die Aktion eine echte Spiel-Wirkung (Tasten oder Sonderaktion) - im Gegensatz zu einer reinen
// Overlay-Meldung?
export const hasGameEffect = (a) => !!(a?.effect && (a.effect.steps?.length || a.effect.variants?.length || a.effect.dynamic));
const CATEGORY_FIELDS = new Set(['cooldownSec', 'perUser', 'chaos', 'color']);
const FILE_FIELDS = new Set(['schema', 'categories', 'curse', 'actions']);
const TEXT_FIELDS = { title_en: 45, prompt: 300, prompt_en: 300, flavor: 300, flavor_en: 300, templateId: 64 };
const ID = /^[A-Za-z0-9_-]{1,64}$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const unknownField = (obj, allowed) => Object.keys(obj).find((k) => !allowed.has(k));

// Prüft EINE Aktion. Gibt einen Fehlertext (ohne Aktionsnamen) zurück oder null.
//   ctx.categories  Kategorien der Datei (für "Kategorie vorhanden")
//   ctx.keys        Tastenbelegung, gegen die "@name" aufgelöst wird
//   ctx.policy      Tasten-Freigabe, siehe steps.js: resolve()
//   ctx.strict      true = Import: auch unbekannte Felder und falsche Typen bei Textfeldern sind
//                   Fehler. false = lokale Datei: Unbekanntes wird ignoriert (ältere Versionen
//                   könnten Felder geschrieben haben, die es heute nicht mehr gibt).
export function actionProblem(a, ctx) {
  if (!isObj(a)) return 'ist kein Objekt';
  if (typeof a.id !== 'string' || !ID.test(a.id)) return 'hat keine gültige id (Buchstaben, Ziffern, _ und -, höchstens 64 Zeichen)';
  if (typeof a.title !== 'string' || !a.title.trim() || a.title.length > 45) return 'braucht einen Titel mit 1 bis 45 Zeichen';
  if (typeof a.category !== 'string' || !Object.hasOwn(ctx.categories, a.category)) return `verweist auf die unbekannte Stufe "${a.category}"`;
  if (!intIn(a.cost, 1, 1000000)) return 'braucht einen Preis als ganze Zahl von 1 bis 1.000.000';
  if (a.access !== undefined && !ACCESS_LEVELS.includes(a.access)) return `hat eine unbekannte Zugriffsregel "${a.access}"`;
  if (a.color !== undefined && a.color !== null && (typeof a.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(a.color))) return 'hat keine gültige Farbe (z. B. #B026FF)';
  if (a.cooldownSec !== undefined && a.cooldownSec !== null && !intIn(a.cooldownSec, 0, 3600)) return 'braucht einen Cooldown von 0 bis 3600 Sekunden';
  if (a.onDeath !== undefined && !ON_DEATH.includes(a.onDeath)) return `hat eine unbekannte Regel bei Tod "${a.onDeath}"`;
  if (a.builder !== undefined && (!isObj(a.builder) || JSON.stringify(a.builder).length > 4000)) return 'hat einen ungültigen Bauplan';
  if (ctx.strict) {
    const extra = unknownField(a, ACTION_FIELDS);
    if (extra !== undefined) return `enthält das unbekannte Feld "${extra}"`;
    for (const f of ['enabled', 'legacy', 'custom', 'customEffect']) {
      if (a[f] !== undefined && typeof a[f] !== 'boolean') return `"${f}" muss wahr oder falsch sein`;
    }
    for (const [f, max] of Object.entries(TEXT_FIELDS)) {
      if (a[f] !== undefined && (typeof a[f] !== 'string' || a[f].length > max)) return `"${f}" muss ein Text mit höchstens ${max} Zeichen sein`;
    }
  }
  if (a.requires !== undefined) {
    if (!Array.isArray(a.requires) || a.requires.length > KNOWN_REQUIRES.length) return '"requires" muss eine kurze Liste sein';
    const bad = a.requires.find((r) => !KNOWN_REQUIRES.includes(r));
    if (bad !== undefined) return `verlangt die unbekannte Bedingung "${bad}" (bekannt: ${KNOWN_REQUIRES.join(', ')})`;
  }
  const eff = a.effect;
  if (eff === undefined) return null;
  if (!isObj(eff)) return '"effect" muss ein Objekt sein';
  const extraEff = unknownField(eff, EFFECT_FIELDS);
  if (extraEff !== undefined) return `"effect" enthält das unbekannte Feld "${extraEff}"`;
  const forms = [eff.steps !== undefined, eff.variants !== undefined, eff.dynamic !== undefined, eff.overlay !== undefined].filter(Boolean).length;
  if (forms > 1) return '"effect" darf nur eine Form haben (steps, variants, dynamic oder overlay)';
  if (eff.dynamic !== undefined && !KNOWN_DYNAMIC.includes(eff.dynamic)) return `nutzt die unbekannte Sonderaktion "${eff.dynamic}" (bekannt: ${KNOWN_DYNAMIC.join(', ')})`;
  if (eff.overlay !== undefined) {
    if (eff.overlay !== true) return '"effect.overlay" muss true sein';
    if (!Array.isArray(eff.options) || eff.options.length < 1 || eff.options.length > 12
      || eff.options.some((o) => typeof o !== 'string' || !o.trim() || o.length > 40)) return '"effect.options" braucht 1 bis 12 Texte mit höchstens 40 Zeichen';
    if (!intIn(eff.displayMs, 1000, 60000)) return '"effect.displayMs" muss eine ganze Zahl von 1000 bis 60000 sein';
  } else if (eff.options !== undefined || eff.displayMs !== undefined) {
    return '"effect.options"/"effect.displayMs" gibt es nur zusammen mit "effect.overlay"';
  }
  if (eff.steps !== undefined) {
    try { compile(eff.steps, ctx.keys, ctx.policy); } catch (e) { return e.message; }
  }
  if (eff.variants !== undefined) {
    if (!Array.isArray(eff.variants) || eff.variants.length < 2 || eff.variants.length > MAX_VARIANTS) return `"effect.variants" braucht 2 bis ${MAX_VARIANTS} Abläufe`;
    for (const v of eff.variants) {
      try { compile(v, ctx.keys, ctx.policy); } catch (e) { return e.message; }
    }
  }
  return null;
}

function categoriesProblem(categories) {
  if (!isObj(categories)) return 'Die Stufen ("categories") fehlen oder sind kein Objekt.';
  const names = Object.keys(categories);
  if (!names.length || names.length > MAX_CATEGORIES) return `Es muss 1 bis ${MAX_CATEGORIES} Stufen geben.`;
  for (const n of names) {
    const c = categories[n];
    if (!/^[A-Za-z0-9_-]{1,24}$/.test(n) || !isObj(c)) return `Stufe "${n}" ist ungültig.`;
    const extra = unknownField(c, CATEGORY_FIELDS);
    if (extra !== undefined) return `Stufe "${n}" enthält das unbekannte Feld "${extra}".`;
    if (!intIn(c.cooldownSec, 0, 86400)) return `Stufe "${n}": cooldownSec muss eine ganze Zahl von 0 bis 86400 sein.`;
    if (!intIn(c.perUser, 0, 100000)) return `Stufe "${n}": perUser muss eine ganze Zahl von 0 bis 100000 sein.`;
    if (!intIn(c.chaos, 0, 1000)) return `Stufe "${n}": chaos muss eine ganze Zahl von 0 bis 1000 sein.`;
    if (typeof c.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(c.color)) return `Stufe "${n}": color muss eine Farbe wie #B026FF sein.`;
  }
  return null;
}

// Strenge Prüfung einer ganzen Aktionen-Datei (Import). Gibt den ERSTEN Fehler als Text zurück
// oder null. ctx: { keys, policy }.
export function actionsFileProblem(raw, ctx) {
  if (!isObj(raw)) return 'Der Aktionen-Teil ist kein Objekt.';
  const extra = unknownField(raw, FILE_FIELDS);
  if (extra !== undefined) return `Der Aktionen-Teil enthält das unbekannte Feld "${extra}".`;
  const catErr = categoriesProblem(raw.categories);
  if (catErr) return catErr;
  if (!Array.isArray(raw.actions)) return 'Die Aktionen-Liste fehlt.';
  if (raw.actions.length > MAX_ACTIONS) return `Zu viele Aktionen (${raw.actions.length}) - höchstens ${MAX_ACTIONS}.`;
  const ids = new Set();
  for (const a of raw.actions) {
    const label = isObj(a) && typeof a.title === 'string' && a.title ? a.title.slice(0, 45) : (isObj(a) && typeof a.id === 'string' ? a.id.slice(0, 64) : '?');
    const err = actionProblem(a, { categories: raw.categories, keys: ctx.keys, policy: ctx.policy, strict: true });
    if (err) return `Aktion "${label}": ${err}.`.replace(/\.\.$/, '.');
    if (ids.has(a.id)) return `Die id "${a.id}" kommt mehrfach vor.`;
    ids.add(a.id);
  }
  if (raw.curse !== undefined) {
    if (!isObj(raw.curse) || unknownField(raw.curse, new Set(['pool'])) !== undefined || !Array.isArray(raw.curse.pool) || raw.curse.pool.length > MAX_ACTIONS) return 'Das Fluchrad ("curse.pool") ist ungültig.';
    const missing = raw.curse.pool.find((id) => !ids.has(id));
    if (missing !== undefined) return `Das Fluchrad verweist auf die unbekannte Aktion "${String(missing).slice(0, 64)}".`;
  }
  return null;
}
