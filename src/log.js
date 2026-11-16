import fs from 'node:fs';
import path from 'node:path';
import { DATA, ensureData } from './config.js';

const FILE = path.join(DATA, 'ucc.log');
const MAX_BYTES = 5_000_000;
let ready = false;
let approxSize = 0;
export const recent = [];

// Log-Rotation: die alte Prüfung lief nur EINMAL beim allerersten
// Schreiben nach dem Programmstart - wuchs die Datei danach während der Laufzeit über das Limit,
// wurde nie mehr rotiert (ucc.log konnte unbegrenzt wachsen). Jetzt wird approxSize bei jeder
// Zeile mitgeführt (kein teurer fs.statSync je Zeile) und bei Bedarf sofort rotiert.
function rotateIfNeeded() {
  if (approxSize < MAX_BYTES) return;
  try {
    fs.copyFileSync(FILE, FILE + '.1'); // überschreibt bewusst eine evtl. vorhandene ältere .1 - wir behalten nur die letzte Generation
    fs.writeFileSync(FILE, '');
    approxSize = 0;
  } catch { /* Rotation darf das Logging nie zum Stillstand bringen */ }
}

export function log(level, msg) {
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}`;
  (level === 'error' ? console.error : console.log)(line);
  recent.push(line);
  // 300 statt vorher 120: genug Zeilen, damit der Fehlerbericht auch direkt nach dem
  // Start noch etwas zum Zeigen hat, nicht nur tail() von der Festplatte (siehe unten).
  if (recent.length > 300) recent.shift();
  try {
    if (!ready) {
      ensureData();
      try { approxSize = fs.statSync(FILE).size; } catch { approxSize = 0; }
      ready = true;
    }
    fs.appendFileSync(FILE, line + '\n'); // synchron - absturzsicher: steht die Zeile hier, steht sie auch auf der Festplatte
    approxSize += Buffer.byteLength(line, 'utf8') + 1;
    rotateIfNeeded();
  } catch { /* Logging darf nie crashen */ }
}
export const info = (m) => log('info', m);
export const warn = (m) => log('warn', m);
export const error = (m) => log('error', m);

// Letzte Zeilen für den Fehlerbericht: liest direkt von der
// Festplatte statt nur aus dem Speicher-Puffer oben - so stehen im Bericht auch noch Zeilen von
// VOR einem automatischen Neustart (z. B. nach einem Absturz), nicht nur das, was seit dem
// letzten Prozessstart im Speicher gesammelt wurde.
export function tail(n = 300) {
  try {
    const text = fs.readFileSync(FILE, 'utf8');
    const lines = text.split('\n').filter(Boolean);
    return lines.slice(-n);
  } catch { return recent.slice(-n); }
}
