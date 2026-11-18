#!/usr/bin/env node
// Releases signieren - läuft auf dem eigenen PC, nicht bei GitHub.
//
//   node scripts/release-sign.mjs keygen                 einmalig: Schlüsselpaar erzeugen
//   node scripts/release-sign.mjs sign v1.2.0-beta.1     Release prüfen und signieren
//   node scripts/release-sign.mjs sign-file SHA256SUMS.txt   eine lokale Prüfsummen-Datei signieren
//   node scripts/release-sign.mjs verify SHA256SUMS.txt SHA256SUMS.txt.sig
//
// Der private Schlüssel liegt passwortgeschützt in ~/.chaoscore/release-key.pem (änderbar mit
// --key <datei>) und gehört NIE ins Repo oder in GitHub-Secrets. Den öffentlichen Schlüssel trägt
// man in product.json unter "releaseKeys" ein.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readProduct } from '../src/product.js';
import { signSums, verifySums, publicKeyBase64, keyId } from '../src/release-signature.js';

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const flag = (name) => args.includes(name);
const KEY_FILE = opt('--key') || path.join(os.homedir(), '.chaoscore', 'release-key.pem');
const product = readProduct();

function die(msg) { console.error(`\n✖ ${msg}\n`); process.exit(1); }

// Passwort-Abfrage ohne Anzeige. CHAOSCORE_KEY_PASSPHRASE nur für Tests/Automatisierung.
async function askHidden(question) {
  if (process.env.CHAOSCORE_KEY_PASSPHRASE) return process.env.CHAOSCORE_KEY_PASSPHRASE;
  if (!process.stdin.isTTY) die('Passwort-Eingabe braucht ein Terminal.');
  process.stdout.write(question);
  return new Promise((resolve) => {
    let s = '';
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', onData); process.stdout.write('\n'); return resolve(s); }
        if (c === '\u0003') { process.stdout.write('\n'); process.exit(130); }
        if (c === '\u007f' || c === '\b') s = s.slice(0, -1); else s += c;
      }
    };
    process.stdin.on('data', onData);
  });
}
async function ask(question) {
  if (flag('--yes')) return 'ja';
  process.stdout.write(question);
  return new Promise((resolve) => { process.stdin.resume(); process.stdin.once('data', (d) => { process.stdin.pause(); resolve(String(d).trim().toLowerCase()); }); });
}

async function loadPrivateKey() {
  if (!fs.existsSync(KEY_FILE)) die(`Kein Schlüssel unter ${KEY_FILE}. Zuerst: node scripts/release-sign.mjs keygen`);
  const pass = await askHidden('Passwort für den Release-Schlüssel: ');
  try { return crypto.createPrivateKey({ key: fs.readFileSync(KEY_FILE), passphrase: pass }); }
  catch { die('Passwort falsch oder Schlüsseldatei beschädigt.'); }
}

function checkKnown(priv) {
  const pub = crypto.createPublicKey(priv);
  if (!product.releaseKeys.some((k) => k.equals(pub))) {
    console.log(`\n⚠ Dieser Schlüssel (${keyId(pub)}) steht nicht in product.json -> releaseKeys.`);
    console.log('  Installationen würden die Signatur ablehnen. Öffentlicher Schlüssel zum Eintragen:');
    console.log(`  "${publicKeyBase64(pub)}"\n`);
    return false;
  }
  return true;
}

async function keygen() {
  if (fs.existsSync(KEY_FILE)) die(`Es gibt schon einen Schlüssel: ${KEY_FILE}\nNicht überschreiben - ohne ihn kannst du keine Updates mehr signieren. Anderen Pfad mit --key wählen.`);
  console.log('\nNeuer Release-Schlüssel. Wähle ein langes Passwort (mind. 12 Zeichen) und speichere es im Passwort-Manager.\n');
  const p1 = await askHidden('Passwort: ');
  if (p1.length < 12) die('Passwort zu kurz (mind. 12 Zeichen).');
  const p2 = await askHidden('Passwort wiederholen: ');
  if (p1 !== p2) die('Die Passwörter sind verschieden.');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8', cipher: 'aes-256-cbc', passphrase: p1 });
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  fs.writeFileSync(KEY_FILE, pem, { mode: 0o600, flag: 'wx' });
  const b64 = publicKeyBase64(publicKey);
  console.log(`\n✔ Privater Schlüssel gespeichert: ${KEY_FILE}`);
  console.log('  -> Diese Datei zusätzlich sichern (z. B. USB-Stick + Passwort-Manager). Geht sie verloren,');
  console.log('     können bestehende Installationen keine Updates mehr automatisch installieren.');
  console.log('  -> NIE ins Repo, in GitHub-Secrets oder in einen Chat kopieren.\n');
  console.log(`Öffentlicher Schlüssel (darf jeder sehen), Kennung ${keyId(publicKey)}:`);
  console.log(`\n  "releaseKeys": ["${b64}"]\n`);
  console.log('Diese Zeile in product.json eintragen (oder den Schlüssel weitergeben, damit er eingetragen wird).\n');
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

async function getBuf(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'chaoscore-release-sign' } });
  if (!res.ok) die(`Laden fehlgeschlagen (${res.status}): ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function signRelease(tag) {
  if (!tag) die('Welches Release? Beispiel: node scripts/release-sign.mjs sign v1.2.0-beta.1');
  const repo = product.githubRepo || die('product.json: githubRepo fehlt.');
  const api = (process.env.UCC_GITHUB_API || 'https://api.github.com').replace(/\/+$/, '');
  const res = await fetch(`${api}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'chaoscore-release-sign' } });
  if (!res.ok) die(`Release ${tag} nicht gefunden (${res.status}).`);
  const rel = await res.json();
  const assets = rel.assets || [];
  const sumsAsset = assets.find((a) => a.name === 'SHA256SUMS.txt') || die('Im Release fehlt SHA256SUMS.txt.');

  console.log(`\nRelease ${rel.tag_name} - ${rel.name || ''}`);
  console.log(`  erstellt:  ${rel.created_at}   von: ${rel.author?.login || '?'}   Commit/Branch: ${rel.target_commitish}`);
  console.log(`  Dateien:   ${assets.map((a) => a.name).join(', ')}`);

  // Prüfen, dass die Prüfsummen zu den Dateien im Release passen - signiert wird genau das, was Nutzer laden.
  const sums = await getBuf(sumsAsset.browser_download_url);
  const lines = sums.toString('utf8').split(/\r?\n/).filter(Boolean).map((l) => l.trim().split(/\s+\*?/));
  if (!lines.length) die('SHA256SUMS.txt ist leer.');
  for (const [hash, name] of lines) {
    const a = assets.find((x) => x.name === name);
    if (!a) die(`${name} steht in SHA256SUMS.txt, fehlt aber im Release.`);
    process.stdout.write(`  prüfe ${name} … `);
    const got = sha256(await getBuf(a.browser_download_url));
    if (got !== hash.toLowerCase()) die(`Prüfsumme von ${name} stimmt nicht - NICHT signieren.`);
    console.log('ok');
  }
  const unlisted = assets.filter((a) => !['SHA256SUMS.txt', 'SHA256SUMS.txt.sig'].includes(a.name) && !lines.some(([, n]) => n === a.name));
  if (unlisted.length) console.log(`  ⚠ nicht in den Prüfsummen (wird nicht abgesichert): ${unlisted.map((a) => a.name).join(', ')}`);

  console.log('\nSignieren heißt: „Dieses Release stammt von mir.“ Hast du es selbst gestartet und ist der Commit der richtige?');
  if (!['ja', 'j', 'yes', 'y'].includes(await ask('Signieren? (ja/nein) '))) die('Abgebrochen, nichts signiert.');

  const priv = await loadPrivateKey();
  checkKnown(priv);
  const sigText = signSums(sums, priv);
  if (!verifySums(sums, sigText, [crypto.createPublicKey(priv)]).ok) die('Selbstprüfung der Signatur fehlgeschlagen.');
  const out = path.resolve(opt('--out') || 'SHA256SUMS.txt.sig');
  fs.writeFileSync(out, sigText);
  console.log(`\n✔ Signatur geschrieben: ${out}`);

  if (flag('--upload')) {
    const r = spawnSync('gh', ['release', 'upload', tag, out, '--clobber', '-R', repo], { stdio: 'inherit' });
    if (r.status === 0) { console.log('✔ Signatur zum Release hochgeladen. Updates sind jetzt installierbar.\n'); return; }
    console.log('⚠ Hochladen mit gh hat nicht geklappt - bitte von Hand (siehe unten).');
  }
  console.log(`\nJetzt hochladen: ${rel.html_url}`);
  console.log('  -> „Edit“ (Stift) -> die Datei SHA256SUMS.txt.sig in die Anhänge ziehen -> „Update release“.');
  console.log('  Erst danach installieren bestehende ChaosCore-Installationen dieses Update automatisch.\n');
}

async function signFile(file) {
  if (!file || !fs.existsSync(file)) die('Datei fehlt. Beispiel: node scripts/release-sign.mjs sign-file dist/SHA256SUMS.txt');
  const priv = await loadPrivateKey();
  checkKnown(priv);
  const out = opt('--out') || `${file}.sig`;
  fs.writeFileSync(out, signSums(fs.readFileSync(file), priv));
  console.log(`✔ Signatur geschrieben: ${out}`);
}

function verify(file, sigFile) {
  if (!file || !sigFile) die('Beispiel: node scripts/release-sign.mjs verify SHA256SUMS.txt SHA256SUMS.txt.sig');
  if (!product.releaseKeys.length) die('In product.json ist kein Release-Schlüssel eingetragen.');
  const v = verifySums(fs.readFileSync(file), fs.readFileSync(sigFile, 'utf8'), product.releaseKeys);
  if (!v.ok) die('Signatur UNGÜLTIG - diese Dateien stammen nicht vom ChaosCore-Entwickler.');
  console.log(`✔ Signatur gültig (Schlüssel ${v.keyId}). Prüfe jetzt die Dateien gegen ${path.basename(file)}, z. B. mit: certutil -hashfile <datei> SHA256`);
}

switch (cmd) {
  case 'keygen': await keygen(); break;
  case 'sign': await signRelease(args[1]); break;
  case 'sign-file': await signFile(args[1]); break;
  case 'verify': verify(args[1], args[2]); break;
  default:
    console.log('Benutzung:\n  node scripts/release-sign.mjs keygen\n  node scripts/release-sign.mjs sign <tag> [--upload]\n  node scripts/release-sign.mjs sign-file <SHA256SUMS.txt>\n  node scripts/release-sign.mjs verify <SHA256SUMS.txt> <SHA256SUMS.txt.sig>');
    process.exit(cmd ? 1 : 0);
}
