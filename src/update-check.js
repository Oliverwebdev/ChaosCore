// Updates über GitHub-Releases: prüfen, herunterladen, prüfen (SHA-256), installieren.
// Kein eigener Server nötig. Ohne eingetragenes Repo (product.json: githubRepo) bleibt das komplett
// inaktiv - keine einzige Anfrage ins Netz.
//
// Ablauf beim Aktualisieren (nur in der installierten Windows-Version):
//   1. passendes Release suchen (Kanal "stable" = nur fertige Versionen, "beta" = auch Vorabversionen)
//   2. SHA256SUMS.txt und den Installer aus genau diesem Release laden
//   3. Signatur der Prüfsummen-Datei prüfen (wenn product.json Release-Schlüssel enthält), dann die
//      Prüfsumme des Installers vergleichen - stimmt eins davon nicht, wird nichts ausgeführt
//   4. Installer still (/S) starten; er beendet ChaosCore, ersetzt die Programmdateien und
//      ChaosCore startet danach von selbst neu. Einstellungen liegen in %APPDATA% und bleiben.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { verifySums } from './release-signature.js';

// ---------- Versionen ----------
// "v1.2.3-beta.4" -> { main: [1,2,3], pre: ['beta', 4] }. Eine Version ohne Vorab-Teil ist neuer als
// dieselbe Version mit (1.0.0 > 1.0.0-beta.9), wie bei Semantic Versioning.
function parseVersion(v) {
  const s = String(v || '').trim().replace(/^v/i, '');
  const [main, ...rest] = s.split('-');
  const pre = rest.join('-');
  return {
    main: main.split('.').map((n) => Number(n) || 0),
    pre: pre ? pre.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [],
  };
}

// > 0 wenn a neuer als b, < 0 wenn älter, 0 wenn gleich.
export function compareVersions(a, b) {
  const pa = parseVersion(a); const pb = parseVersion(b);
  for (let i = 0; i < Math.max(pa.main.length, pb.main.length); i++) {
    const d = (pa.main[i] || 0) - (pb.main[i] || 0);
    if (d !== 0) return d;
  }
  if (!pa.pre.length || !pb.pre.length) return (pa.pre.length ? -1 : 0) + (pb.pre.length ? 1 : 0);
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i], y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    if (typeof x === 'number') return -1;
    if (typeof y === 'number') return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

// Version dieser Installation: package.json-Version plus Build-Kennung, wenn die eine Vorabversion
// bezeichnet (Build "beta.1" -> "1.0.0-beta.1"). Andere Kennungen (z. B. Test-Builds) zählen nicht.
export function installedVersion(pkgVersion, build) {
  const label = build?.build || '';
  return /^(alpha|beta|rc)\.\d+$/.test(label) ? `${pkgVersion}-${label}` : pkgVersion;
}
export const isPrerelease = (v) => parseVersion(v).pre.length > 0;

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const API = () => (process.env.UCC_GITHUB_API || 'https://api.github.com').replace(/\/+$/, '');

async function getJson(url, fetchImpl) {
  const res = await fetchImpl(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'chaoscore-updater' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) { const e = new Error(`GitHub-API ${res.status}.`); e.status = res.status; throw e; }
  return res.json();
}

// Neuestes passendes Release. channel: 'stable' (nur fertige Versionen) oder 'beta' (auch Vorabversionen).
export async function checkForUpdate(repo, currentVersion, { channel = 'stable', fetchImpl = fetch, requireSignature = false } = {}) {
  repo = String(repo || '').trim();
  if (!repo) return { configured: false };
  if (!REPO_RE.test(repo)) return { configured: true, error: `Ungültiges Repo-Format in product.json: "${repo}" (erwartet "besitzer/name").` };
  let list;
  try { list = await getJson(`${API()}/repos/${repo}/releases?per_page=20`, fetchImpl); }
  catch (e) { return { configured: true, error: e.status ? e.message : `Keine Verbindung zu GitHub (${e.cause?.code || e.message}).` }; }
  if (!Array.isArray(list)) return { configured: true, error: 'Antwort von GitHub war unerwartet.' };
  const candidates = list.filter((r) => !r.draft && (channel === 'beta' || !r.prerelease) && typeof r.tag_name === 'string');
  candidates.sort((a, b) => compareVersions(b.tag_name, a.tag_name));
  const rel = candidates[0];
  if (!rel) return { configured: true, channel, current: currentVersion, latest: null, newer: false, error: list.length ? null : 'Noch kein Release auf GitHub veröffentlicht.' };
  const latest = rel.tag_name.replace(/^v/i, '');
  const setup = (rel.assets || []).find((a) => /-Setup\.exe$/i.test(a.name));
  const sums = (rel.assets || []).find((a) => a.name === 'SHA256SUMS.txt');
  const sig = (rel.assets || []).find((a) => a.name === 'SHA256SUMS.txt.sig');
  return {
    configured: true, channel, current: currentVersion, latest, prerelease: !!rel.prerelease,
    newer: compareVersions(latest, currentVersion) > 0,
    url: rel.html_url || `https://github.com/${repo}/releases`,
    notes: String(rel.body || '').slice(0, 4000),
    installable: !!(setup && sums && (sig || !requireSignature)),
    signed: !!sig,
    // Release ist da, aber noch nicht signiert (der Entwickler signiert nach dem Build von Hand).
    awaitingSignature: !!(setup && sums && !sig && requireSignature),
    setup: setup ? { name: setup.name, url: setup.browser_download_url, size: setup.size } : null,
    sums: sums ? { url: sums.browser_download_url } : null,
    sig: sig ? { url: sig.browser_download_url } : null,
  };
}

// ---------- Installation ----------
// Woran erkennt man die installierte Windows-Version? ROOT ist <Installationsordner>\app, daneben
// liegen runtime\ucc-node.exe und Uninstall.exe. Die portable Version (portable.flag) und ein Start
// aus dem Quellcode werden nicht automatisch aktualisiert - dort gibt es nur den Download-Link.
export function installInfo(root, exeName, platform = process.platform) {
  const dir = path.dirname(root);
  const has = (f) => fs.existsSync(path.join(dir, f));
  if (platform !== 'win32') return { canInstall: false, reason: 'not_windows' };
  if (has('portable.flag')) return { canInstall: false, reason: 'portable' };
  if (!has('Uninstall.exe') || !has(exeName)) return { canInstall: false, reason: 'not_installed' };
  return { canInstall: true, dir, exe: path.join(dir, exeName) };
}

const MAX_SETUP_BYTES = 300 * 1024 * 1024;

// Downloads nur aus genau diesem Repo (GitHub leitet selbst auf seinen Datei-Server weiter).
function allowedDownload(url, repo) {
  try {
    if (process.env.UCC_GITHUB_DOWNLOAD && url.startsWith(process.env.UCC_GITHUB_DOWNLOAD)) return true; // Tests
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'github.com' && u.pathname.toLowerCase().startsWith(`/${repo.toLowerCase()}/releases/download/`);
  } catch { return false; }
}

async function smallDownload(url, fetchImpl, what, max = 64 * 1024) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${what} nicht ladbar (${res.status}).`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > max) throw new Error(`${what}: Datei ist unerwartet groß - abgebrochen.`);
  return buf;
}

// Lädt den Installer und prüft ihn. Gibt den Pfad der geprüften Datei zurück oder wirft.
// publicKeys: erlaubte Release-Schlüssel (product.json). Leer = nur Prüfsumme (ältere Releases/Forks).
export async function downloadVerified(info, repo, { fetchImpl = fetch, dir = path.join(os.tmpdir(), 'ChaosCore-update'), onProgress, publicKeys = [] } = {}) {
  if (!info?.setup || !info?.sums) throw new Error('Dieses Release hat keinen Installer mit Prüfsummen.');
  if (!/^[\w.-]+-Setup\.exe$/i.test(info.setup.name)) throw new Error('Unerwarteter Dateiname im Release.');
  if (publicKeys.length && !info.sig) throw new Error('Dieses Release ist (noch) nicht signiert - aus Sicherheitsgründen nichts installiert.');
  for (const u of [info.setup.url, info.sums.url, ...(publicKeys.length ? [info.sig.url] : [])]) if (!allowedDownload(u, repo)) throw new Error('Download-Adresse gehört nicht zu diesem Projekt - abgebrochen.');

  const sumsBytes = await smallDownload(info.sums.url, fetchImpl, 'Prüfsummen');
  if (publicKeys.length) {
    const sigText = (await smallDownload(info.sig.url, fetchImpl, 'Signatur', 4096)).toString('utf8');
    const v = verifySums(sumsBytes, sigText, publicKeys);
    if (!v.ok) throw new Error('Die Signatur des Updates passt nicht zum Schlüssel des Entwicklers. Nichts installiert - bitte nur von der offiziellen GitHub-Seite laden.');
  }
  const sumsText = sumsBytes.toString('utf8');
  const line = sumsText.split(/\r?\n/).map((l) => l.trim().split(/\s+\*?/)).find(([, f]) => f === info.setup.name);
  if (!line || !/^[a-f0-9]{64}$/i.test(line[0])) throw new Error('Für den Installer steht keine Prüfsumme im Release.');
  const expected = line[0].toLowerCase();

  const res = await fetchImpl(info.setup.url, { signal: AbortSignal.timeout(15 * 60 * 1000) });
  if (!res.ok || !res.body) throw new Error(`Installer nicht ladbar (${res.status}).`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, info.setup.name);
  const tmp = file + '.part';
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(tmp);
  let bytes = 0;
  const total = Number(res.headers.get('content-length')) || info.setup.size || 0;
  try {
    for await (const chunk of res.body) {
      bytes += chunk.length;
      if (bytes > MAX_SETUP_BYTES) throw new Error('Installer ist unerwartet groß - abgebrochen.');
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      onProgress?.(bytes, total);
    }
    await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  } catch (e) {
    out.destroy(); fs.rmSync(tmp, { force: true });
    throw e;
  }
  const got = hash.digest('hex');
  if (got !== expected) { fs.rmSync(tmp, { force: true }); throw new Error('Prüfsumme stimmt nicht - der Download ist beschädigt oder verändert. Nichts installiert.'); }
  fs.rmSync(file, { force: true });
  fs.renameSync(tmp, file);
  return { file, sha256: got, bytes };
}

// Startet den geprüften Installer still und danach ChaosCore neu. Läuft unabhängig von diesem
// Prozess weiter (der Installer beendet ChaosCore selbst). Das Neustarten übernimmt cmd.exe,
// damit es auch dann klappt, wenn dieser Prozess schon beendet ist.
export function launchInstaller(file, install) {
  const q = (s) => `"${String(s).replace(/"/g, '')}"`;
  const script = `start "" /wait ${q(file)} /S & set UCC_RELAUNCHED=1& start "" ${q(install.exe)}`;
  const p = spawn('cmd.exe', ['/d', '/s', '/c', `"${script}"`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
  p.unref();
}
