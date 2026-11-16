import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Kleine Helfer. UCC_TIME_SCALE verkürzt alle Wartezeiten (nur für Tests).
export const TIME_SCALE = Number(process.env.UCC_TIME_SCALE) || 1;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms * TIME_SCALE));
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
export const clean = (s, max = 120) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

// Chromium-Browser für das Dashboard als eigenes App-Fenster (ohne Tabs und Erweiterungen) finden.
export function findAppBrowser() {
  const env = process.env;
  const c = [];
  if (process.platform === 'win32') {
    for (const b of [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA]) {
      if (!b) continue;
      c.push(path.join(b, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(b, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
  } else if (process.platform === 'darwin') {
    c.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  } else {
    for (const d of String(env.PATH || '').split(path.delimiter)) {
      for (const n of ['microsoft-edge', 'google-chrome', 'chromium', 'chromium-browser']) if (d) c.push(path.join(d, n));
    }
  }
  return c.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

// Dashboard öffnen: 'app' = eigenes schlankes Fenster mit eigenem Profil, sonst (oder ohne Chromium) normaler Browser.
export function openDashboard(url, mode, profileDir) {
  if (process.env.UCC_NO_OPEN) return;
  const exe = mode === 'browser' ? null : findAppBrowser();
  if (!exe) return openUrl(url);
  try {
    spawn(exe, [
      `--app=${url}`, `--user-data-dir=${profileDir}`, '--window-size=1200,820',
      '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
      '--disable-background-networking', '--disable-component-update', '--disable-features=Translate,MediaRouter,OptimizationHints',
    ], { stdio: 'ignore', detached: true }).on('error', () => openUrl(url)).unref();
  } catch { openUrl(url); }
}

// Öffnet eine URL im Standardbrowser (best effort). UCC_NO_OPEN=1 unterdrückt das (Tests).
export function openUrl(url) {
  if (process.env.UCC_NO_OPEN) return;
  try {
    const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch { /* egal */ }
}
