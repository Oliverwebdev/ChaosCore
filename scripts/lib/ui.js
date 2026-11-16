// Kleine Terminal-Helfer ohne Abhängigkeiten. Funktioniert interaktiv und mit Pipe (Tests).
import readline from 'node:readline';

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (n) => (s) => (tty ? `\x1b[${n}m${s}\x1b[0m` : String(s));
export const c = { b: paint('1'), dim: paint('2'), red: paint('31'), green: paint('32'), yellow: paint('33'), purple: paint('35'), cyan: paint('36') };

const lines = [];
let waiter = null;
let closed = false;
let rl = null;

function init() {
  if (rl) return;
  rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (l) => { if (waiter) { const w = waiter; waiter = null; w.resolve(l); } else lines.push(l); });
  rl.on('close', () => { closed = true; if (waiter) { const w = waiter; waiter = null; w.reject(new Error('EOF')); } });
}

export function closeInput() { try { rl?.close(); } catch { /* egal */ } rl = null; }

function nextLine() {
  init();
  if (lines.length) return Promise.resolve(lines.shift());
  if (closed) return Promise.reject(new Error('EOF'));
  return new Promise((resolve, reject) => { waiter = { resolve, reject }; });
}

export const say = (s = '') => console.log(s);
export const ok = (s) => console.log(`  ${c.green('✔')} ${s}`);
export const warn = (s) => console.log(`  ${c.yellow('!')} ${s}`);
export const fail = (s) => console.log(`  ${c.red('✖')} ${s}`);
export const info = (s) => console.log(`  ${c.dim(s)}`);
export const step = (n, total, title) => console.log(`\n${c.purple(`[${n}/${total}]`)} ${c.b(title)}`);

export async function ask(question, { def = '', validate } = {}) {
  for (;;) {
    process.stdout.write(`  ${c.cyan('?')} ${question}${def ? c.dim(` [${def}]`) : ''} `);
    const raw = (await nextLine()).trim();
    const val = raw || def;
    if (!validate) return val;
    const err = validate(val);
    if (!err) return val;
    fail(err);
  }
}

export async function confirm(question, def = true) {
  for (;;) {
    process.stdout.write(`  ${c.cyan('?')} ${question} ${c.dim(def ? '[J/n]' : '[j/N]')} `);
    const raw = (await nextLine()).trim().toLowerCase();
    if (!raw) return def;
    if (['j', 'ja', 'y', 'yes'].includes(raw)) return true;
    if (['n', 'nein', 'no'].includes(raw)) return false;
    warn('Bitte "j" oder "n" eingeben.');
  }
}

export { openUrl } from '../../src/util.js';
