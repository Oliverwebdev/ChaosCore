// Verknüpfungen (Desktop, Startmenü, Autostart) und Neustart des Programms. Nur unter Windows wirksam.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT } from './config.js';
import { product } from './product.js';

export const APP_NAME = product.name;
export const isPackaged = () => process.env.UCC_PACKAGED === '1';

// Worauf die Verknüpfungen zeigen: gepackt die .exe selbst, in der Entwicklung start.bat.
export function launcher() {
  // Gepackt startet die kleine Programm-.exe (Icon, Startname) den eigentlichen Server; sie meldet sich über UCC_EXE.
  if (process.env.UCC_EXE) return { target: process.env.UCC_EXE, icon: process.env.UCC_EXE, cwd: path.dirname(process.env.UCC_EXE) };
  if (isPackaged()) return { target: process.execPath, icon: process.execPath, cwd: path.dirname(process.execPath) };
  return { target: path.join(ROOT, 'start.bat'), icon: path.join(ROOT, 'assets', 'icon.ico'), cwd: ROOT };
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`; // PowerShell: Einzelstrings

// Baut das PowerShell-Skript. places: { desktop, startMenu, autostart } (true/false)
export function shortcutScript(places, l = launcher(), name = APP_NAME) {
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    '$sh = New-Object -ComObject WScript.Shell',
    'function Make($dir, $args2) {',
    `  $p = Join-Path $dir ${q(name + '.lnk')}`,
    '  $s = $sh.CreateShortcut($p)',
    `  $s.TargetPath = ${q(l.target)}`,
    '  $s.Arguments = $args2',
    `  $s.WorkingDirectory = ${q(l.cwd)}`,
    `  $s.IconLocation = ${q(l.icon + ',0')}`,
    `  $s.Description = ${q(name)}`,
    '  $s.Save()',
    '  Write-Output $p',
    '}',
  ];
  if (places.desktop) lines.push("Make ([Environment]::GetFolderPath('Desktop')) ''");
  if (places.startMenu) lines.push("Make ([Environment]::GetFolderPath('Programs')) ''");
  if (places.autostart) lines.push("Make ([Environment]::GetFolderPath('Startup')) '--minimized'");
  return lines.join('\r\n');
}

export function removeScript(name = APP_NAME) {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `foreach ($f in 'Desktop','Programs','Startup') { Remove-Item (Join-Path ([Environment]::GetFolderPath($f)) ${q(name + '.lnk')}) }`,
  ].join('\r\n');
}

function runPowerShell(script, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const enc = Buffer.from(script, 'utf16le').toString('base64');
    let out = '', err = '';
    let p;
    try {
      p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], { windowsHide: true });
    } catch (e) { return resolve({ ok: false, error: e.message }); }
    const timer = setTimeout(() => { try { p.kill(); } catch { /* egal */ } resolve({ ok: false, error: 'PowerShell hat zu lange gebraucht.' }); }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    p.on('exit', (code) => { clearTimeout(timer); resolve(code === 0 ? { ok: true, out: out.trim() } : { ok: false, error: (err || out || `Fehlercode ${code}`).trim().slice(0, 300) }); });
  });
}

export async function createShortcuts(places) {
  if (!places.desktop && !places.startMenu && !places.autostart) return { ok: true, created: [] };
  if (process.platform !== 'win32') return { ok: false, error: 'Verknüpfungen gibt es nur unter Windows.' };
  const r = await runPowerShell(shortcutScript(places));
  return r.ok ? { ok: true, created: r.out.split(/\r?\n/).filter(Boolean) } : r;
}

export async function removeShortcuts() {
  if (process.platform !== 'win32') return { ok: false, error: 'Nur unter Windows.' };
  return runPowerShell(removeScript());
}

// Startet das Programm neu (eigene Datei, gleiche Argumente), ohne den Aufrufer zu blockieren.
export function relaunchSelf() {
  // Gepackte Windows-Version: die Programm-.exe startet den Server neu (Argumente nach dem Skript durchreichen).
  if (process.env.UCC_EXE) {
    const flags = process.argv.slice(2).filter((a) => a !== '--no-open');
    spawn(process.env.UCC_EXE, flags, { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, UCC_RELAUNCHED: '1' } }).unref();
    return;
  }
  // Gepackt (SEA) steht die .exe zweimal in argv, sonst Node + Skript.
  const args = process.argv.slice(isPackaged() && process.argv[1] === process.execPath ? 2 : 1);
  if (!isPackaged() && !args.length) return;
  const clean = args.filter((a) => a !== '--no-open');
  spawn(process.execPath, clean, { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, UCC_RELAUNCHED: '1' } }).unref();
}
