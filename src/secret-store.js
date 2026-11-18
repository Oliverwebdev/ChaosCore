// Twitch-Login verschlüsselt speichern. Unter Windows mit der eingebauten Benutzer-Verschlüsselung
// (DPAPI, "CurrentUser"): nur dieses Windows-Konto auf diesem PC kann die Datei wieder lesen - ein
// anderes Programm, das die Datei kopiert, kann damit auf einem anderen PC nichts anfangen.
// Andere Systeme: wie bisher als Datei mit eingeschränkten Rechten.
//
// Node hat keinen direkten DPAPI-Zugang; PowerShell (gehört zu jedem Windows) übernimmt das. Die
// Daten laufen über stdin/stdout, nie über die Befehlszeile.
import { spawnSync } from 'node:child_process';

const PS_PROTECT = `
Add-Type -AssemblyName System.Security
$in = [Console]::In.ReadToEnd().Trim()
$b = [Convert]::FromBase64String($in)
$e = [Text.Encoding]::UTF8.GetBytes('ChaosCore')
$o = [Security.Cryptography.ProtectedData]::__OP__($b, $e, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($o))
`;

function powershell(op, b64) {
  const script = PS_PROTECT.replace('__OP__', op);
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { input: b64, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  if (r.status !== 0 || !r.stdout) throw new Error((r.stderr || r.error?.message || 'PowerShell-Fehler').trim().slice(0, 200));
  return r.stdout.trim();
}

// Nur für Tests: umkehrbare Ersatz-"Verschlüsselung", damit der Weg auch ohne Windows prüfbar ist.
const testCrypt = {
  protect: (b64) => Buffer.from(b64, 'base64').map((x) => x ^ 0x5a).toString('base64'),
  unprotect: (b64) => Buffer.from(b64, 'base64').map((x) => x ^ 0x5a).toString('base64'),
};

export function cryptoAvailable() {
  return process.env.UCC_TEST_TOKEN_CRYPT === '1' || (process.platform === 'win32' && process.env.UCC_NO_DPAPI !== '1');
}

export function protect(text) {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  return process.env.UCC_TEST_TOKEN_CRYPT === '1' ? testCrypt.protect(b64) : powershell('Protect', b64);
}

export function unprotect(b64) {
  const out = process.env.UCC_TEST_TOKEN_CRYPT === '1' ? testCrypt.unprotect(b64) : powershell('Unprotect', b64);
  return Buffer.from(out, 'base64').toString('utf8');
}
