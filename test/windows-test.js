// Windows-Prüfungen (läuft in GitHub Actions auf windows-latest, lokal auf jedem System).
// Der große Ende-zu-Ende-Test (run-test.js) simuliert Einrichtung und Spiel unter Linux. Hier wird
// geprüft, was sich nur auf echtem Windows zeigt: Verschlüsselung mit DPAPI, Pfade und Dateinamen,
// Zeilenenden, Programmstart-Regeln, OBS-Verbindung, CS2-Dateien.
// Aufruf: node test/windows-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { startObsMock } from './mock-obs.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ucc-win-'));
process.env.UCC_DATA_DIR = path.join(tmp, 'data'); // vor dem Laden der Module setzen
fs.mkdirSync(process.env.UCC_DATA_DIR, { recursive: true });
const WIN = process.platform === 'win32';

let passed = 0, failed = 0, skipped = 0;
async function t(name, fn, { winOnly = false } = {}) {
  if (winOnly && !WIN) { skipped++; console.log(`  - ${name} (nur Windows)`); return; }
  try { await fn(); passed++; console.log(`  ✔ ${name}`); } catch (e) { failed++; console.log(`  ✖ ${name}\n      ${e.stack || e.message}`); }
}
const eq = (a, b, msg) => { if (a !== b) throw new Error(`${msg || 'ungleich'}: erwartet ${JSON.stringify(b)}, erhalten ${JSON.stringify(a)}`); };
const yes = (v, msg) => { if (!v) throw new Error(msg || 'erwartet true'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, ms = 8000, what = 'Bedingung') {
  const end = Date.now() + ms;
  for (;;) { if (await cond()) return; if (Date.now() > end) throw new Error(`Zeitüberschreitung: ${what}`); await sleep(50); }
}

const store = await import('../src/secret-store.js');
const config = await import('../src/config.js');
const obsMod = await import('../src/obs.js');
const sys = await import('../src/system-config.js');
const clips = await import('../src/local-clips.js');
const pages = await import('../src/web-pages.js');
const cs2 = await import('../src/cs2.js');
const sig = await import('../src/release-signature.js');

console.log(`Windows-Prüfungen auf ${process.platform} (${os.release()}), Node ${process.version}`);

await t('DPAPI: Text verschlüsseln und wieder lesen, mit Umlauten', () => {
  yes(store.cryptoAvailable(), 'DPAPI nicht verfügbar');
  const secret = 'Zugang äöü 🔒 ' + crypto.randomBytes(8).toString('hex');
  const enc = store.protect(secret);
  yes(!enc.includes(secret) && enc.length > 40, 'nicht verschlüsselt');
  eq(store.unprotect(enc), secret);
}, { winOnly: true });

await t('Twitch-Login wird verschlüsselt gespeichert und gelesen', () => {
  const tok = { accessToken: 'AT-' + crypto.randomUUID(), refreshToken: 'RT-' + crypto.randomUUID(), scopes: ['bits:read'] };
  config.saveTokens(tok);
  yes(config.tokensProtected(), 'nicht verschlüsselt gespeichert');
  const raw = fs.readFileSync(path.join(process.env.UCC_DATA_DIR, 'tokens.json'), 'utf8');
  yes(!raw.includes(tok.refreshToken), 'Klartext in der Datei');
  eq(config.loadTokens().refreshToken, tok.refreshToken);
}, { winOnly: true });

await t('OBS-Passwort wird verschlüsselt gespeichert', () => {
  obsMod.saveObsPassword('obs-geheim-123');
  const raw = JSON.parse(fs.readFileSync(path.join(process.env.UCC_DATA_DIR, 'obs-secret.json'), 'utf8'));
  eq(raw.protected, true);
  yes(!JSON.stringify(raw).includes('obs-geheim-123'));
  eq(obsMod.loadObsPassword(), 'obs-geheim-123');
}, { winOnly: true });

await t('Dashboard wird auch mit Windows-Zeilenenden (CRLF) vollständig zusammengesetzt', () => {
  const dir = path.join(tmp, 'web-crlf');
  const html = pages.renderPage('dashboard.html');
  yes(!/@include/.test(html), 'Platzhalter übrig');
  // CRLF-Variante prüfen, wie sie ein Git-Checkout unter Windows erzeugen kann
  const raw = fs.readFileSync(path.join(pages.WEB, 'dashboard.html'), 'utf8').replace(/\r?\n/g, '\r\n');
  fs.mkdirSync(dir, { recursive: true });
  const inc = raw.match(/\/\/@include ([\w./-]+)\r?$/m);
  yes(inc, 'kein include gefunden');
  const INCLUDE = /^[ \t]*(?:\/\/@include ([\w./-]+)|\/\*@include ([\w./-]+)\*\/)[ \t]*\r?$/gm;
  yes([...raw.matchAll(INCLUDE)].length >= 10, 'CRLF-Zeilen werden nicht erkannt');
});

await t('Programme: .exe erlaubt, Skripte und Sonderzeichen nicht, Steam-Adressen ja', () => {
  eq(sys.checkProgramTarget('steam://rungameid/730').uri, true);
  let err = null;
  try { sys.checkProgramTarget('C:\\Windows\\System32\\calc.exe & del x'); } catch (e) { err = e.message; }
  yes(/unerlaubte Zeichen/.test(err || ''), String(err));
  if (WIN) {
    eq(sys.checkProgramTarget(process.execPath).uri, false);
    const bat = path.join(tmp, 'boese.bat');
    fs.writeFileSync(bat, 'echo hi');
    err = null;
    try { sys.checkProgramTarget(bat); } catch (e) { err = e.message; }
    yes(/\.exe/.test(err || ''), '.bat darf nicht durchgehen');
  }
});

await t('Lokale Clips: Dateinamen ohne verbotene Zeichen, Ordner pro Stream, Verschieben klappt', async () => {
  const name = clips.clipBaseName('Lena: "Maus?" <Drift> | 7s * 2 / ok.', Date.UTC(2026, 10, 18, 20, 14, 3));
  yes(!/[\\/:*?"<>|]/.test(name) && !name.endsWith('.'), name);
  const om = await startObsMock({ password: '', dir: path.join(tmp, 'obs') });
  const cfg = { obs: { enabled: true, host: '127.0.0.1', port: om.port }, highlights: { types: {} }, localClips: clips.normalizeLocalClips({ enabled: true, minScore: 1, afterSec: 0, folder: path.join(tmp, 'Meine Clips') }) };
  const obs = new obsMod.Obs(cfg);
  const rows = [];
  const db = { highlightSet: (id, p) => rows.push({ id, ...p }), highlightList: () => [] };
  try {
    obs.start();
    await waitFor(() => obs.status === 'connected' && obs.replayActive === true, 8000, 'OBS verbunden');
    const lc = new clips.LocalClips({ cfg, obs, db, logger: { info() {}, warn() {} } });
    const dest = await lc.capture({ id: 1, score: 5, title: 'Raid von Kai: "Willkommen!"', ts: Date.now() });
    yes(fs.existsSync(dest) && dest.includes(clips.streamFolderName(Date.now())), dest);
    eq(rows[0].videoFile, dest);
  } finally { obs.stop(); om.close(); }
});

await t('CS2-Dateien: GSI, Binds und autoexec werden geschrieben (Windows-Pfade)', () => {
  const dir = path.join(tmp, 'Counter-Strike Global Offensive', 'game', 'csgo', 'cfg');
  fs.mkdirSync(dir, { recursive: true });
  cs2.installCs2Files(dir, 7788, 'tok', {}, config.DEFAULTS?.keys || {});
  yes(cs2.cs2FilesInstalled(dir), 'nicht installiert');
  cs2.installCs2Files(dir, 7788, 'tok', {}, config.DEFAULTS?.keys || {});
  eq(fs.readFileSync(path.join(dir, 'autoexec.cfg'), 'utf8').match(/exec unknown_chat_control/g).length, 1, 'autoexec doppelt');
});

await t('Release-Signatur: gültig, verändert, falscher Schlüssel', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const other = crypto.generateKeyPairSync('ed25519').publicKey;
  const sums = Buffer.from('abc  ChaosCore-1.2.0-Setup.exe\r\n');
  const s = sig.signSums(sums, privateKey);
  eq(sig.verifySums(sums, s, [publicKey]).ok, true);
  eq(sig.verifySums(Buffer.from('abd  ChaosCore-1.2.0-Setup.exe\r\n'), s, [publicKey]).ok, false);
  eq(sig.verifySums(sums, s, [other]).ok, false);
  eq(sig.verifySums(sums, s.replace(/\n/g, '\r\n'), [publicKey]).ok, true, 'Signaturdatei mit CRLF');
});

console.log(`\n${failed ? '✖' : '✔'} ${passed} bestanden, ${failed} fehlgeschlagen${skipped ? `, ${skipped} nur unter Windows` : ''}`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
