#!/usr/bin/env node
// Baut das Windows-Paket: Programm-.exe (mit Icon), Installer (Setup.exe) und portables ZIP.
// Läuft auf Linux/WSL (mingw-w64, NSIS, unzip, zip, python3 mit Pillow nötig) und erzeugt dist/.
//   npm run build:win            alles bauen
//   npm run build:win -- --assets   Icon/Installer-Grafiken neu zeichnen (aus product.json)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readProduct } from '../src/product.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'build');
const DIST = path.join(ROOT, 'dist');
const CACHE = path.join(BUILD, 'cache');
const STAGE = path.join(DIST, 'stage');
const NODE_VERSION = '24.22.1';        // Node.js 24 LTS für Windows (npm-Paket node-win-x64)
const AHK_VERSION = '2.0.19';
const AHK_SHA256 = '4e0d0e65655066a646a210951320feaef0729a3597177131adaec4066bef5869';
const AHK_URL = `https://github.com/AutoHotkey/AutoHotkey/releases/download/v${AHK_VERSION}/AutoHotkey_${AHK_VERSION}.zip`;

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const product = readProduct();
const version = pkg.version;
const v4 = version.split('.').concat(['0', '0', '0']).slice(0, 4).join('.');
const exeName = `${product.name}.exe`;
const flag = (n) => process.argv.includes(n);
// --testversion=YYYY-MM-DD baut eine zeitlich
// befristete, als Testversion gekennzeichnete Fassung (siehe src/license.js) - bewusst nur hier
// beim Bauen setzbar, NICHT nachträglich im laufenden Programm umschaltbar.
const argVal = (prefix) => { const a = process.argv.find((x) => x.startsWith(prefix)); return a ? a.slice(prefix.length) : null; };

// Eindeutige Build-Kennung: --build=<Kennung> hängt die Kennung an die
// Dateinamen und legt build.json ins Paket (Version, Kennung, Quellcode-Commit, Zeitpunkt), damit
// sich jede ausgelieferte Datei eindeutig einem Quellcode-Stand zuordnen lässt. Die Programmversion
// (package.json) bleibt davon unberührt - "1.0.0" ist die Nummer der Entwicklungs-Builds, keine
// freigegebene 1.0. Ohne --build verhält sich das Skript wie bisher.
const buildLabel = argVal('--build=');
if (buildLabel !== null && !/^[A-Za-z0-9][A-Za-z0-9.-]{0,39}$/.test(buildLabel)) throw new Error('--build= erwartet eine Kennung aus Buchstaben, Ziffern, Punkt und Bindestrich (höchstens 40 Zeichen).');
// --testpresets legt zusätzlich die Angriffs-/Fehler-Presets (test/fixtures/presets) als ZIP in dist/.
const withTestPresets = flag('--testpresets');

const log = (m) => console.log(`\x1b[35m▸\x1b[0m ${m}`);
function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: opts.quiet ? 'pipe' : 'inherit', cwd: opts.cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    if (opts.quiet) process.stderr.write(`${r.stdout || ''}${r.stderr || ''}`);
    throw new Error(`${cmd} ${args.join(' ')} ist fehlgeschlagen (Code ${r.status}).`);
  }
  return r.stdout;
}
const have = (c) => spawnSync('sh', ['-c', `command -v ${c}`], { encoding: 'utf8' }).status === 0;
const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function need(cmds) {
  const missing = cmds.filter((c) => !have(c));
  if (missing.length) {
    throw new Error(`Es fehlen Werkzeuge: ${missing.join(', ')}.\nUbuntu/WSL: sudo apt install gcc-mingw-w64-x86-64-win32 binutils-mingw-w64-x86-64 nsis unzip zip python3-pil`);
  }
}

async function download(url, file) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Download fehlgeschlagen (${res.status}): ${url}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

function copyTree(from, to, skip = () => false) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip(e.name)) continue;
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyTree(a, b, skip); else fs.copyFileSync(a, b);
  }
}

async function main() {
  console.log(`\n${product.name} ${version}: Windows-Paket bauen\n`);
  need(['x86_64-w64-mingw32-gcc', 'x86_64-w64-mingw32-windres', 'makensis', 'unzip', 'zip', 'python3', 'npm']);
  fs.mkdirSync(CACHE, { recursive: true });
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });

  // 1) Icon und Grafiken
  if (flag('--assets') || !fs.existsSync(path.join(ROOT, 'assets', 'icon.ico'))) {
    log('Zeichne Icon und Installer-Grafiken');
    sh('python3', [path.join(BUILD, 'make-assets.py'), product.accent, product.brand]);
  }

  // 2) Programmdateien
  log('Kopiere Programmdateien');
  const app = path.join(STAGE, 'app');
  for (const d of ['src', 'web', 'ahk', 'config']) copyTree(path.join(ROOT, d), path.join(app, d), (n) => n === 'web' && d === 'src');
  for (const f of ['package.json', 'product.json']) fs.copyFileSync(path.join(ROOT, f), path.join(app, f));
  fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(app, 'LICENSE.txt')); // GPL-3.0: Lizenztext gehört zum Programm

  // --testversion=YYYY-MM-DD legt testversion.json
  // direkt neben src/ ab (ROOT aus Sicht von src/license.js, das diese Datei zur Laufzeit liest).
  const testExpiry = argVal('--testversion=');
  if (testExpiry) {
    const exp = new Date(testExpiry);
    if (Number.isNaN(exp.getTime())) throw new Error(`--testversion=${testExpiry} ist kein gültiges Datum (erwartet: YYYY-MM-DD).`);
    log(`Testversion-Modus: läuft bis ${testExpiry} ab`);
    fs.writeFileSync(path.join(app, 'testversion.json'), JSON.stringify({ expiresAt: exp.toISOString(), builtAt: new Date().toISOString() }, null, 2));
  }
  if (buildLabel) {
    const git = (args) => { const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : ''; };
    const commit = git(['rev-parse', 'HEAD']);
    const dirty = git(['status', '--porcelain']) !== '';
    if (!commit) throw new Error('--build= braucht ein Git-Repository, um den Quellcode-Stand festzuhalten.');
    if (dirty) throw new Error('--build= verlangt einen sauberen Arbeitsstand (alles committet), sonst passt die Kennung nicht zum Quellcode.');
    log(`Build-Kennung ${buildLabel} (Quellcode-Commit ${commit.slice(0, 12)})`);
    fs.writeFileSync(path.join(app, 'build.json'), JSON.stringify({ version, build: buildLabel, commit, builtAt: new Date().toISOString() }, null, 2));
  }
  copyTree(path.join(ROOT, 'assets'), path.join(app, 'assets'), (n) => /^icon-1024|installer-/.test(n));
  // Beim Verkauf ist die Entwickler-Doku nicht nötig; die Kunden-Hilfe liegt im Programm.
  if (fs.existsSync(path.join(ROOT, 'docs'))) copyTree(path.join(ROOT, 'docs'), path.join(STAGE, 'docs'), (n) => n === 'images'); // Bilder sind nur fürs GitHub-README

  // 3) Node.js-Laufzeit (umbenannt, damit der Installer nur diese Prozesse beendet)
  log(`Node.js ${NODE_VERSION} für Windows holen`);
  const nodeTgz = path.join(CACHE, `node-win-x64-${NODE_VERSION}.tgz`);
  if (!fs.existsSync(nodeTgz)) sh('npm', ['pack', `node-win-x64@${NODE_VERSION}`, '--pack-destination', CACHE], { quiet: true });
  const rt = path.join(STAGE, 'runtime');
  fs.mkdirSync(rt, { recursive: true });
  const nodeTmp = path.join(CACHE, 'node-extract');
  fs.rmSync(nodeTmp, { recursive: true, force: true }); fs.mkdirSync(nodeTmp, { recursive: true });
  sh('tar', ['-xzf', nodeTgz, '-C', nodeTmp, 'package/bin/node.exe']);
  fs.copyFileSync(path.join(nodeTmp, 'package', 'bin', 'node.exe'), path.join(rt, 'ucc-node.exe'));

  // 4) AutoHotkey v2 (Tasten-Effekte), geprüft per Hash
  log(`AutoHotkey ${AHK_VERSION} holen`);
  const ahkZip = path.join(CACHE, `AutoHotkey_${AHK_VERSION}.zip`);
  if (!fs.existsSync(ahkZip)) await download(AHK_URL, ahkZip);
  if (sha256(ahkZip) !== AHK_SHA256) { fs.rmSync(ahkZip); throw new Error('Die AutoHotkey-Datei hat eine unerwartete Prüfsumme. Abbruch.'); }
  const tools = path.join(STAGE, 'tools');
  fs.mkdirSync(tools, { recursive: true });
  const ahkTmp = path.join(CACHE, 'ahk-extract');
  fs.rmSync(ahkTmp, { recursive: true, force: true }); fs.mkdirSync(ahkTmp, { recursive: true });
  sh('unzip', ['-o', '-q', ahkZip, 'AutoHotkey64.exe', 'license.txt', '-d', ahkTmp]);
  fs.copyFileSync(path.join(ahkTmp, 'AutoHotkey64.exe'), path.join(tools, 'AutoHotkey64.exe'));
  fs.copyFileSync(path.join(ahkTmp, 'license.txt'), path.join(tools, 'AutoHotkey-LICENSE.txt'));

  // 5) Hinweise zu mitgelieferter Software (Installer-Seite und Datei im Programm)
  const notice = [
    `${product.name} ${version}`,
    product.publisher ? `Herausgeber: ${product.publisher}` : '',
    '',
    `${product.name} ist freie Software unter der GNU General Public License v3.0 oder neuer (Datei LICENSE.txt).`,
    'Quellcode: https://github.com/Oliverwebdev/ChaosCore',
    'Es gibt KEINE GARANTIE, soweit gesetzlich zulässig. Nutzung auf eigenes Risiko.',
    '',
    'Dieses Programm bringt folgende freie Software mit:',
    '',
    `- Node.js ${NODE_VERSION} (MIT-Lizenz) - https://nodejs.org`,
    '  Laufzeit des Programms (runtime\\ucc-node.exe), unverändert.',
    `- AutoHotkey ${AHK_VERSION} (GNU GPL v2) - https://www.autohotkey.com`,
    '  Sendet die Tasten-Effekte (tools\\AutoHotkey64.exe), unverändert. Lizenztext: tools\\AutoHotkey-LICENSE.txt',
    '  Quellcode: https://github.com/AutoHotkey/AutoHotkey',
    '',
    'Twitch ist eine Marke von Twitch Interactive, Inc. Dieses Programm ist nicht mit Twitch, Valve oder Counter-Strike verbunden.',
    'Counter-Strike und CS2 sind Marken von Valve Corporation.',
    '',
  ].filter((l) => l !== null).join('\r\n');
  const noticeFile = path.join(STAGE, 'THIRD-PARTY-NOTICES.txt');
  fs.writeFileSync(noticeFile, notice);

  // 6) Programm-.exe (Starter) mit Icon und Versionsinfo
  log('Baue die Programm-.exe');
  const rc = path.join(DIST, 'launcher.rc');
  const q = (s) => String(s).replace(/"/g, '\\"');
  fs.writeFileSync(rc, [
    '#include <windows.h>',
    `1 ICON "${path.join(ROOT, 'assets', 'icon.ico').replace(/\\/g, '/')}"`,
    'VS_VERSION_INFO VERSIONINFO',
    ` FILEVERSION ${v4.replace(/\./g, ',')}`,
    ` PRODUCTVERSION ${v4.replace(/\./g, ',')}`,
    ' FILEOS VOS_NT_WINDOWS32',
    ' FILETYPE VFT_APP',
    '{ BLOCK "StringFileInfo" { BLOCK "040704B0" {',
    `  VALUE "ProductName", "${q(product.name)}"`,
    `  VALUE "FileDescription", "${q(product.name)}"`,
    `  VALUE "CompanyName", "${q(product.publisher)}"`,
    `  VALUE "FileVersion", "${version}"`,
    `  VALUE "ProductVersion", "${version}"`,
    `  VALUE "OriginalFilename", "${q(exeName)}"`,
    '} } BLOCK "VarFileInfo" { VALUE "Translation", 0x0407, 1200 } }',
  ].join('\n'));
  const res = path.join(DIST, 'launcher.res.o');
  sh('x86_64-w64-mingw32-windres', ['-i', rc, '-o', res, '--codepage=65001']);
  sh('x86_64-w64-mingw32-gcc', [
    '-municode', '-mwindows', '-O2', '-s', '-static', `-DAPP_NAME=L"${product.name}"`,
    path.join(BUILD, 'launcher.c'), res, '-o', path.join(STAGE, exeName), '-lshell32',
  ]);

  // 7) Portables ZIP (Daten bleiben im Ordner "data" daneben)
  const baseName = `${product.name.replace(/ /g, '-')}-${version}${buildLabel ? `-${buildLabel}` : ''}`;
  log('Packe das portable ZIP');
  const port = path.join(DIST, 'portable-stage');
  copyTree(STAGE, path.join(port, product.name.replace(/ /g, '-')));
  fs.writeFileSync(path.join(port, product.name.replace(/ /g, '-'), 'portable.flag'), 'Daten liegen im Ordner "data" neben dieser Datei.\n');
  fs.rmSync(path.join(DIST, `${baseName}-portable.zip`), { force: true });
  sh('zip', ['-r', '-q', '-9', path.join(DIST, `${baseName}-portable.zip`), product.name.replace(/ /g, '-')], { cwd: port });
  fs.rmSync(port, { recursive: true, force: true });

  // 8) Installer
  log('Baue den Installer (Setup.exe)');
  const setupFile = path.join(DIST, `${baseName}-Setup.exe`);
  const defs = {
    APP_NAME: product.name, APP_VERSION: version, APP_VERSION_4: v4, PUBLISHER: product.publisher || product.name,
    EXE_NAME: exeName, SRC_DIR: STAGE, OUT_FILE: setupFile, ASSETS: path.join(ROOT, 'assets'), NOTICE_FILE: noticeFile,
  };
  if (product.website) defs.WEBSITE = product.website;
  sh('makensis', ['-V2', ...Object.entries(defs).map(([k, v]) => `-D${k}=${v}`), path.join(BUILD, 'installer.nsi')]);

  // 8b) Angriffs-/Fehler-Presets für den Handtest - kein Teil des Programms
  if (withTestPresets) {
    log('Packe die Sicherheitstest-Presets');
    const zipFile = path.join(DIST, `${product.name.replace(/ /g, '-')}-Sicherheitstest-Presets${buildLabel ? `-${buildLabel}` : ''}.zip`);
    sh('zip', ['-r', '-q', '-9', zipFile, 'presets'], { cwd: path.join(ROOT, 'test', 'fixtures') });
  }

  // 9) Prüfsummen
  const sums = fs.readdirSync(DIST).filter((f) => /\.(exe|zip)$/.test(f)).map((f) => `${sha256(path.join(DIST, f))}  ${f}`).join('\n');
  fs.writeFileSync(path.join(DIST, 'SHA256SUMS.txt'), sums + '\n');
  fs.rmSync(rc, { force: true }); fs.rmSync(res, { force: true });

  console.log('\n\x1b[32m✔ Fertig.\x1b[0m Ergebnisse in dist/:');
  for (const f of fs.readdirSync(DIST).filter((x) => /\.(exe|zip|txt)$/.test(x))) console.log(`   ${f}  (${(fs.statSync(path.join(DIST, f)).size / 1048576).toFixed(1)} MB)`);
  console.log('');
}

main().catch((e) => { console.error(`\n\x1b[31m✖ ${e.message}\x1b[0m\n`); process.exit(1); });
