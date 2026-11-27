// Material für die Clip-Analyse: eine kleine Vorschau-Version des Videos (für KIs, die Videos sehen)
// oder vier Standbilder (für KIs, die Bilder sehen). Beides mit ffmpeg, niedriger Priorität, in einem
// Zwischenordner, der danach wieder gelöscht wird. Das Original bleibt unangetastet.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA } from './config.js';
import { findFfmpeg } from './local-clips.js';

export const PROXY_MAX_BYTES = 15e6; // darüber nimmt die KI Standbilder statt Video (Grenze für Anfragen ohne Datei-Upload)

function run(ff, args, cwd, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const p = spawn(ff, args, { cwd, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    try { os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* egal */ }
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    const t = setTimeout(() => p.kill(), timeoutMs);
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => { clearTimeout(t); resolve({ code, err }); });
  });
}

// Länge in Sekunden (aus der ffmpeg-Ausgabe "Duration: 00:00:12.34").
export async function duration(ff, file) {
  const { err } = await run(ff, ['-hide_banner', '-i', file], path.dirname(file), 20000);
  const m = err.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}

function tmpDir() {
  const d = path.join(DATA, 'tmp', `ai-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// sees: 'video' | 'images' | 'text' -> { video?: Buffer, images?: Buffer[], used: 'video'|'images'|'text' }
export async function clipMaterial(file, sees, ffmpegSetting = '') {
  if (sees === 'text' || !file || !fs.existsSync(file)) return { used: 'text' };
  const ff = findFfmpeg(ffmpegSetting);
  if (!ff) return { used: 'text' };
  const dir = tmpDir();
  try {
    const dur = Math.min(59, (await duration(ff, file)) || 30);
    if (sees === 'video') {
      // 360p, 2 Bilder pro Sekunde, Mono-Ton: genug, um zu verstehen, was passiert - und klein.
      const out = path.join(dir, 'vorschau.mp4');
      const r = await run(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-t', String(dur), '-vf', 'scale=-2:360,fps=2',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '34', '-c:a', 'aac', '-b:a', '32k', '-ac', '1', '-movflags', '+faststart', out], dir);
      if (r.code === 0 && fs.existsSync(out) && fs.statSync(out).size <= PROXY_MAX_BYTES) return { video: fs.readFileSync(out), used: 'video' };
    }
    // Vier Standbilder gleichmäßig verteilt (512 px breit)
    const images = [];
    for (const f of [0.15, 0.4, 0.65, 0.9]) {
      const out = path.join(dir, `bild-${images.length}.jpg`);
      const r = await run(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', (dur * f).toFixed(2), '-i', file, '-frames:v', '1', '-vf', 'scale=512:-2', '-q:v', '5', out], dir, 30000);
      if (r.code === 0 && fs.existsSync(out)) images.push(fs.readFileSync(out));
    }
    return images.length ? { images, used: 'images' } : { used: 'text' };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* egal */ }
  }
}
