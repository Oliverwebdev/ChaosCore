// Erzeugt bzw. prüft die CS2-Referenz: was ChaosCore heute für
// jede mitgelieferte CS2-Aktion tatsächlich an den Runner schickt, und die erzeugte Bind-Datei.
// Diese Referenz darf sich durch Umbauten (Abschnitt A, Session Stats) NICHT unbeabsichtigt ändern.
// Eine gewollte Änderung (z. B. neue Binds nach einem Live-Test) wird bewusst neu erzeugt:
//   node scripts/cs2-reference.mjs --write
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '../src/steps.js';
import { bindsCfg, BINDS_VERSION, GRENADE_BIND } from '../src/cs2.js';
import { CS2_PROFILE } from '../src/games/index.js';
import { DEFAULTS } from '../src/config.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test', 'fixtures', 'cs2-reference.json');
const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));

export function buildReference() {
  const keys = { ...DEFAULTS.keys, ...CS2_PROFILE.keyDefaults };
  const sets = {
    'config/actions.default.json': read('config/actions.default.json').actions,
    'config/actions-bits.default.json': read('config/actions-bits.default.json').actions,
    'config/presets/cs2-klassisch.json': read('config/presets/cs2-klassisch.json').actions.actions,
  };
  const actions = {};
  for (const [file, list] of Object.entries(sets)) {
    for (const a of list) {
      const e = a.effect || {};
      const entry = { requires: a.requires || [] };
      if (e.steps) { const c = compile(e.steps, keys); entry.lines = c.lines; entry.ms = c.est.ms; entry.untilStop = c.est.untilStop; }
      else if (e.dynamic) entry.dynamic = e.dynamic;
      else if (e.overlay) entry.overlay = true;
      actions[`${file}#${a.id}`] = entry;
    }
  }
  return {
    note: 'Automatisch erzeugt von scripts/cs2-reference.mjs. Nicht von Hand bearbeiten.',
    bindsVersion: BINDS_VERSION,
    keys,
    grenadeBind: GRENADE_BIND,
    actions,
    bindsCfg: bindsCfg(DEFAULTS.game, keys).split('\n'),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ref = buildReference();
  if (process.argv.includes('--write')) { fs.writeFileSync(OUT, JSON.stringify(ref, null, 2) + '\n'); console.log(`geschrieben: ${path.relative(ROOT, OUT)}`); }
  else console.log(JSON.stringify(ref, null, 2));
}
