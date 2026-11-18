// Seiten ausliefern. Das Dashboard ist zur besseren Pflege in mehrere Dateien aufgeteilt
// (web/dashboard/*.js, *.css). Beim Ausliefern setzt ChaosCore sie wieder in dashboard.html ein,
// sodass der Browser - wie bisher - EIN Skript bekommt (gleiche Reihenfolge, gleicher Gültigkeitsbereich).
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

export const WEB = path.join(ROOT, 'web');
const INCLUDE = /^[ \t]*(?:\/\/@include ([\w./-]+)|\/\*@include ([\w./-]+)\*\/)[ \t]*$/gm;

export function renderPage(file) {
  const html = fs.readFileSync(path.join(WEB, file), 'utf8');
  return html.replace(INCLUDE, (_, a, b) => {
    const rel = a || b;
    const full = path.join(WEB, rel);
    if (!full.startsWith(WEB + path.sep) || rel.includes('..')) throw new Error(`Ungültiges include: ${rel}`);
    return fs.readFileSync(full, 'utf8').replace(/\n$/, '');
  });
}
