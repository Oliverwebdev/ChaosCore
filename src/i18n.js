// Mehrsprachigkeit: lädt locale/<sprache>.json und liefert sie an Dashboard/Overlay/Setup.
// Deutsch ist immer die Grundlage (Fallback) - fehlt ein Text in einer anderen Sprache, bleibt
// er auf Deutsch stehen statt leer oder als rohen Schlüssel anzuzeigen.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

export const SUPPORTED_LOCALES = ['de', 'en'];
const LOCALE_DIR = path.join(ROOT, 'locale');
const cache = {};

function loadRaw(lang) {
  if (cache[lang]) return cache[lang];
  let data = {};
  try { data = JSON.parse(fs.readFileSync(path.join(LOCALE_DIR, `${lang}.json`), 'utf8')); }
  catch { data = {}; } // Datei fehlt/kaputt -> leer, Fallback greift trotzdem
  cache[lang] = data;
  return data;
}

// Verschachteltes JSON ("setup": { "title": "..." }) zu flachen Schlüsseln ("setup.title").
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

export function normalizeLocale(lang) {
  const l = String(lang || '').trim().toLowerCase().slice(0, 2);
  return SUPPORTED_LOCALES.includes(l) ? l : 'de';
}

// Alle Texte für eine Sprache, immer vollständig (fehlende Schlüssel kommen aus Deutsch).
export function stringsFor(lang) {
  const base = flatten(loadRaw('de'));
  const lc = normalizeLocale(lang);
  if (lc === 'de') return base;
  return { ...base, ...flatten(loadRaw(lc)) };
}

// Für Server-seitige Texte (Log, E-Mail an dich selbst o.ä.), nicht für die Weboberflächen.
export function t(lang, key, fallback = key) {
  const s = stringsFor(lang);
  return s[key] ?? fallback;
}

// Fehlermeldungen: im Code stehen sie auf Deutsch. Für Englisch übersetzt eine Liste
// (locale/errors-en.json) die bekannten Meldungen; {1}, {2} … stehen für eingesetzte Werte.
// Unbekannte Meldungen bleiben, wie sie sind.
let errorRules = null;
function loadErrorRules() {
  if (errorRules) return errorRules;
  let list = [];
  try { list = JSON.parse(fs.readFileSync(path.join(LOCALE_DIR, 'errors-en.json'), 'utf8')); } catch { list = []; }
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  errorRules = list.map(({ de, en }) => {
    const parts = de.split(/\{(\d)\}/);
    const order = [];
    let src = '';
    parts.forEach((p, i) => { if (i % 2) { order.push(Number(p)); src += '([\\s\\S]+?)'; } else src += esc(p); });
    return { re: new RegExp(`^${src}$`), order, en, literal: parts.filter((_, i) => i % 2 === 0).join('').length };
  }).sort((a, b) => b.literal - a.literal); // genaueste Muster zuerst
  return errorRules;
}

export function translateError(msg, lang) {
  if (normalizeLocale(lang) !== 'en' || typeof msg !== 'string') return msg;
  for (const r of loadErrorRules()) {
    const m = msg.match(r.re);
    if (!m) continue;
    const vals = {};
    r.order.forEach((n, i) => { vals[n] = m[i + 1]; });
    return r.en.replace(/\{(\d)\}/g, (_, n) => vals[n] ?? '');
  }
  return msg;
}
