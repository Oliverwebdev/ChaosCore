// Lokale Clips (Paket H): bei starken Momenten speichert OBS seinen Wiederholungspuffer. ChaosCore
// benennt die Datei nach dem Highlight-Titel und legt sie in einen Ordner pro Stream - so findet man
// nach dem Stream jede Szene sofort, verknüpft mit der Highlight-Liste.
//
// Die Länge VOR dem Moment ist die Puffer-Länge in OBS (Einstellungen → Ausgabe → Wiederholungspuffer).
// Die Länge DANACH steuert ChaosCore: es wartet afterSec Sekunden, bevor es speichern lässt.
//
// Optional (H4): eine Hochkant-Version für Shorts/TikTok mit Titel und eigenem Logo. Dafür braucht es
// ffmpeg (kostenloses Video-Werkzeug, separater Download) - ohne ffmpeg bleibt die Funktion einfach aus.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { TIME_SCALE } from './util.js';

const real = (ms) => ms * TIME_SCALE;

// shortsCrop: welcher Teil des Spielbilds in der Hochkant-Version groß zu sehen ist
// (full = ganzes Bild klein mit unscharfem Rand, center/left/right = Ausschnitt groß).
export const SHORTS_CROPS = ['full', 'center', 'left', 'right'];
export const LOCAL_CLIPS_DEFAULT = { enabled: false, minScore: 4, afterSec: 8, folder: '', perStream: true, shorts: false, ffmpeg: '', shortsCrop: 'center', logoPath: '', shortsWhen: 'now' };
// Shorts dürfen höchstens 60 Sekunden lang sein - die Hochkant-Version wird auf 59 s gekürzt.
export const SHORTS_MAX_SEC = 59;

const cleanPath = (p) => String(p ?? '').replace(/[\u0000-\u001f\u007f"<>|]/g, '').trim().slice(0, 400);

export function normalizeLocalClips(v) {
  const o = v && typeof v === 'object' ? v : {};
  const n = (x, d, lo, hi) => { const k = Math.round(Number(x ?? d)); return k >= lo && k <= hi ? k : d; };
  const folder = cleanPath(o.folder);
  const ffmpeg = cleanPath(o.ffmpeg);
  return {
    enabled: o.enabled === true,
    minScore: n(o.minScore, 4, 1, 8),
    afterSec: n(o.afterSec, 8, 0, 60),
    folder: folder && path.isAbsolute(folder) ? folder : '',
    perStream: o.perStream !== false,
    shorts: o.shorts === true,
    shortsCrop: SHORTS_CROPS.includes(o.shortsCrop) ? o.shortsCrop : 'center',
    // Hochkant-Version gleich rechnen oder erst nach Stream-Ende (schont die CPU während des Streams)
    shortsWhen: o.shortsWhen === 'after_stream' ? 'after_stream' : 'now',
    logoPath: (() => { const l = cleanPath(o.logoPath); return l && path.isAbsolute(l) && /\.(png|jpe?g|webp)$/i.test(l) ? l : ''; })(),
    ffmpeg: ffmpeg && path.isAbsolute(ffmpeg) ? ffmpeg : '',
  };
}

// "21-14-03 Lena schickt Maus-Drift - 7 Sekunden später tot" - Windows-taugliche Zeichen, nicht zu lang.
export function clipBaseName(title, ts) {
  const d = new Date(ts);
  const hh = [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, '0')).join('-');
  const safe = String(title || 'Highlight').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').replace(/[. ]+$/, '').trim().slice(0, 90);
  return `${hh} ${safe || 'Highlight'}`;
}

export function streamFolderName(ts) {
  const d = new Date(ts);
  return `ChaosCore ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function moveFile(from, to) {
  try { fs.renameSync(from, to); } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.copyFileSync(from, to); fs.unlinkSync(from);
  }
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms).unref?.(); });

// Von ChaosCore selbst geladenes ffmpeg (data/tools/ffmpeg, siehe ffmpeg-install.js) - setzt server.js.
let toolFfmpeg = null;
export function useFfmpegTool(p) { toolFfmpeg = p; }

export function findFfmpeg(configured) {
  const candidates = [configured, process.env.UCC_FFMPEG, toolFfmpeg, 'ffmpeg'].filter(Boolean);
  for (const c of candidates) {
    if (c !== 'ffmpeg' && !fs.existsSync(c)) continue;
    try { const r = spawnSync(c, ['-version'], { encoding: 'utf8', timeout: 8000, windowsHide: true }); if (r.status === 0) return c; } catch { /* nächster */ }
  }
  return null;
}

export class LocalClips extends EventEmitter {
  constructor({ cfg, obs, db, logger, logoFile = () => null }) {
    super();
    Object.assign(this, { cfg, obs, db, logger, logoFile });
    this.busy = Promise.resolve();
    this.streamStart = null;
    this.pendingShorts = []; // Highlight-IDs, deren Hochkant-Version nach Stream-Ende gerechnet wird
    this.wantShort = () => false; // setzt server.js: automatische Uploads brauchen eine Hochkant-Version
  }

  ready() {
    const c = this.cfg.localClips;
    return !!(c?.enabled && this.obs?.status === 'connected' && this.obs.replayActive);
  }

  // Wird von highlights.js für jedes gespeicherte Highlight aufgerufen.
  maybeCapture(row, type) {
    const c = this.cfg.localClips;
    if (!c?.enabled || row.score < c.minScore) return false;
    if (this.cfg.highlights?.types?.[type] === false) return false;
    if (!this.ready()) {
      if (this.obs?.status === 'connected' && this.obs.replayActive === false) this.logger.warn('Lokaler Clip übersprungen: Der Wiederholungspuffer in OBS ist aus.');
      return false;
    }
    // nacheinander, damit sich zwei Speicherungen nicht in die Quere kommen
    this.busy = this.busy.then(() => this.capture(row)).catch((e) => this.logger.warn(`Lokaler Clip nicht gespeichert: ${e.message}`));
    return true;
  }

  // Ohne Punkte-Schwelle (Zuschauer-Clip): der Moment liegt schon im Puffer, darum kaum Nachlauf.
  captureNow(row) {
    if (!this.ready()) return false;
    this.busy = this.busy.then(() => this.capture(row, 2)).catch((e) => this.logger.warn(`Lokaler Clip nicht gespeichert: ${e.message}`));
    return true;
  }

  async capture(row, afterSec = null) {
    const c = this.cfg.localClips;
    await sleep(real((afterSec ?? c.afterSec) * 1000));
    const saved = await this.obs.saveReplay();
    if (!saved || !fs.existsSync(saved)) throw new Error('OBS hat keine Datei gemeldet');
    let dir = c.folder || path.dirname(saved);
    if (c.perStream) dir = path.join(dir, streamFolderName(this.streamStart || row.ts));
    fs.mkdirSync(dir, { recursive: true });
    const ext = path.extname(saved) || '.mp4';
    let dest = path.join(dir, `${clipBaseName(row.title, row.ts)}${ext}`);
    for (let i = 2; fs.existsSync(dest); i++) dest = path.join(dir, `${clipBaseName(row.title, row.ts)} (${i})${ext}`);
    for (let i = 0; ; i++) { // OBS gibt die Datei manchmal zu spät frei (langsame Platten: bis zu 10 s)
      try { moveFile(saved, dest); break; } catch (e) { if (i >= 25 || !['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) throw e; await sleep(400); }
    }
    this.db.highlightSet(row.id, { videoFile: dest });
    this.logger.info(`Lokaler Clip gespeichert: ${path.basename(dest)}`);
    this.emit('change');
    this.emit('video', { ...row, videoFile: dest }); // z. B. für die KI-Analyse
    if ((c.shorts || this.wantShort(row)) && findFfmpeg(c.ffmpeg)) {
      if (c.shortsWhen === 'after_stream' && this.streamStart !== null) this.pendingShorts.push(row.id);
      else await this.makeShort(row.id).catch((e) => this.logger.warn(`Hochkant-Version nicht erstellt: ${e.message}`));
    }
    return dest;
  }

  // Stream vorbei: aufgeschobene Hochkant-Versionen nacheinander rechnen.
  flushPendingShorts() {
    const ids = this.pendingShorts.splice(0);
    if (!ids.length) return;
    this.logger.info(`Stream beendet: ${ids.length} Hochkant-Version(en) werden erstellt.`);
    for (const id of ids) this.busy = this.busy.then(() => this.makeShort(id)).catch((e) => this.logger.warn(`Hochkant-Version nicht erstellt: ${e.message}`));
  }

  // Hochkant 1080x1920: Spielbild mittig, unscharfer Hintergrund, Titel oben, Logo unten.
  async makeShort(id) {
    const row = this.db.highlightList(2000).find((r) => r.id === Number(id));
    if (!row?.videoFile || !fs.existsSync(row.videoFile)) throw new Error('Kein lokaler Clip zu diesem Highlight');
    const ff = findFfmpeg(this.cfg.localClips.ffmpeg);
    if (!ff) throw new Error('ffmpeg nicht gefunden');
    const dir = path.dirname(row.videoFile);
    const base = path.basename(row.videoFile, path.extname(row.videoFile));
    const out = path.join(dir, `${base} (hochkant).mp4`);
    // Eine Datei pro Zeile, jede Zeile einzeln mittig gesetzt; relativ zum Clip-Ordner, damit keine
    // Laufwerks-Doppelpunkte im Filter stehen.
    const lines = wrap(row.title, 24).split('\n');
    const titleFiles = lines.map((_, i) => `.chaoscore-title-${row.id}-${i}.txt`);
    lines.forEach((l, i) => fs.writeFileSync(path.join(dir, titleFiles[i]), l));
    const c = this.cfg.localClips;
    const logo = c.logoPath && fs.existsSync(c.logoPath) ? c.logoPath : this.logoFile();
    const bg = '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:2[bg]';
    // Ausschnitt: 3:4 aus dem 16:9-Bild (Mitte/links/rechts), groß auf 1080 x 1440 - oder das ganze Bild.
    const cropX = { center: '(iw-ow)/2', left: '0', right: 'iw-ow' }[c.shortsCrop];
    const fg = cropX ? `[0:v]crop=ih*3/4:ih:${cropX}:0,scale=1080:1440[fg]` : '[0:v]scale=1080:-2[fg]';
    const base9x16 = `${bg};${fg};[bg][fg]overlay=(W-w)/2:(H-h)/2[v0]`;
    const lineH = 76;
    const top = 150;
    const text = lines.map((_, i) => `drawtext=textfile=${titleFiles[i]}:expansion=none:fontcolor=white:fontsize=60:x=(w-text_w)/2:y=${top + i * lineH}:box=1:boxcolor=black@0.6:boxborderw=14`).join(',');
    const textChain = `[v0]${text}[v1]`;
    const withLogo = logo ? ';[1:v]scale=280:-1[lg];[v1][lg]overlay=(W-w)/2:H-h-170[v]' : ';[v1]null[v]';
    const run = (filter) => new Promise((resolve, reject) => {
      const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', row.videoFile, ...(logo ? ['-i', logo] : []),
        '-t', String(SHORTS_MAX_SEC), '-filter_complex', filter, '-map', '[v]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-c:a', 'aac', '-movflags', '+faststart', out];
      const p = spawn(ff, args, { cwd: dir, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      // Niedrige Priorität: das Kodieren darf dem Spiel und OBS keine Leistung wegnehmen.
      try { os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* nicht überall erlaubt */ }
      let err = '';
      p.stderr.on('data', (d) => { err = (err + d).slice(-600); });
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim().split('\n').pop() || `ffmpeg Fehler ${code}`))));
    });
    try {
      try { await run(`${base9x16};${textChain}${withLogo}`); }
      catch { await run(`${base9x16};[v0]null[v1]${withLogo}`); } // ohne Schrift (z. B. ffmpeg ohne Schriftarten)
    } finally { for (const f of titleFiles) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* egal */ } } }
    this.db.highlightSet(row.id, { shortFile: out });
    this.logger.info(`Hochkant-Version erstellt: ${path.basename(out)}`);
    this.emit('change');
    this.emit('short', { ...row, shortFile: out });
    return out;
  }
}

function wrap(text, width) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > width && cur) { lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim();
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 4).join('\n');
}
