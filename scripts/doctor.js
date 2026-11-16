import { runChecks } from './lib/checks.js';
import { c, say, ok, warn, fail, info } from './lib/ui.js';

say(c.b('\nUNKNOWN CHAT CONTROL: Systemcheck\n'));
const res = await runChecks();
for (const r of res) {
  (r.level === 'ok' ? ok : r.level === 'warn' ? warn : fail)(r.label);
  if (r.hint && r.level !== 'ok') info('→ ' + r.hint);
}
const bad = res.filter((r) => r.level === 'fail').length;
const w = res.filter((r) => r.level === 'warn').length;
say(`\n${bad ? c.red(`${bad} Problem(e)`) : c.green('Keine Fehler')}${w ? c.yellow(`, ${w} Hinweis(e)`) : ''}.\n`);
process.exit(bad ? 1 : 0);
