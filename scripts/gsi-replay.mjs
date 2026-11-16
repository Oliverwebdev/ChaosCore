// Spielt eine GSI-Aufzeichnung gegen ein laufendes ChaosCore ab.
// Nutzung: node scripts/gsi-replay.mjs <datei.jsonl> [--fast]
// Liest Port und GSI-Token aus der eigenen config.json; --fast spielt ohne Pausen ab.
import fs from 'node:fs';
import { loadConfig } from '../src/config.js';
import { readRecording } from '../src/gsi-recorder.js';

const file = process.argv[2];
if (!file) { console.error('Nutzung: node scripts/gsi-replay.mjs <datei.jsonl> [--fast]'); process.exit(1); }
const fast = process.argv.includes('--fast');
const cfg = loadConfig();
const url = `http://127.0.0.1:${cfg.server.port}/gsi`;
const rec = readRecording(fs.readFileSync(file, 'utf8'));
let last = 0;
for (const { t, body } of rec) {
  if (!fast) await new Promise((r) => setTimeout(r, Math.max(0, t - last)));
  last = t;
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, auth: { token: cfg.server.gsiToken } }) });
  if (!res.ok) { console.error(`Abbruch: ${res.status}`); process.exit(1); }
}
console.log(`${rec.length} Pakete abgespielt.`);
