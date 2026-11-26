// ffmpeg auf Knopfdruck (für die Hochkant-Versionen der lokalen Clips).
//
// ChaosCore lädt eine fest gewählte ffmpeg-Version aus dem offiziellen GitHub-Release von Gyan Doshi
// (gyan.dev, die Windows-Builds, auf die auch ffmpeg.org verweist), prüft die SHA-256-Prüfsumme und
// legt nur ffmpeg.exe und die Lizenz in den Datenordner (data/tools/ffmpeg). Nichts wird ohne Klick
// geladen, nichts wird systemweit installiert, und eine Datei mit falscher Prüfsumme wird verworfen.
//
// Das ZIP wird ohne Zusatzprogramm entpackt (kleiner Leser für das ZIP-Format, siehe readZipEntry).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { EventEmitter } from 'node:events';
import { DATA } from './config.js';

// Neue Version: URL, Größe und Prüfsumme gemeinsam ändern (Prüfsumme der heruntergeladenen ZIP-Datei).
export const FFMPEG_PKG = {
  version: '9.0.2',
  url: 'https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip',
  size: 114768076,
  sha256: '60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba',
  license: 'GNU GPL v3',
  source: 'https://www.gyan.dev/ffmpeg/builds/',
};

// Für die Tests lässt sich das Paket über Umgebungsvariablen austauschen (eigener Mini-Server).
function pkg() {
  if (process.env.UCC_FFMPEG_PKG_URL) {
    return { ...FFMPEG_PKG, url: process.env.UCC_FFMPEG_PKG_URL, sha256: process.env.UCC_FFMPEG_PKG_SHA256 || '', size: 0 };
  }
  return FFMPEG_PKG;
}

export const ffmpegToolDir = () => path.join(DATA, 'tools', 'ffmpeg');
export const ffmpegToolPath = () => path.join(ffmpegToolDir(), 'ffmpeg.exe');

// ---------- ZIP lesen (nur was wir brauchen: gespeichert oder "deflate", kein ZIP64) ----------
function readAt(fd, pos, len) {
  const b = Buffer.alloc(len);
  let off = 0;
  while (off < len) {
    const n = fs.readSync(fd, b, off, len - off, pos + off);
    if (!n) throw new Error('ZIP-Datei ist unvollständig');
    off += n;
  }
  return b;
}

export function listZip(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 65557);
    const tail = readAt(fd, size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('Keine gültige ZIP-Datei');
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOff = tail.readUInt32LE(eocd + 16);
    if (cdOff === 0xffffffff || count === 0xffff) throw new Error('ZIP64 wird nicht unterstützt');
    const cd = readAt(fd, cdOff, cdSize);
    const out = [];
    for (let p = 0, i = 0; i < count; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP-Verzeichnis beschädigt');
      const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commentLen = cd.readUInt16LE(p + 32);
      out.push({
        name: cd.toString('utf8', p + 46, p + 46 + nameLen),
        method: cd.readUInt16LE(p + 10), crc: cd.readUInt32LE(p + 16),
        compSize: cd.readUInt32LE(p + 20), size: cd.readUInt32LE(p + 24), localOff: cd.readUInt32LE(p + 42),
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  } finally { fs.closeSync(fd); }
}

export function readZipEntry(file, entry) {
  const fd = fs.openSync(file, 'r');
  try {
    const lh = readAt(fd, entry.localOff, 30);
    if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('ZIP-Eintrag beschädigt');
    const start = entry.localOff + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
    const raw = readAt(fd, start, entry.compSize);
    let data;
    if (entry.method === 0) data = raw;
    else if (entry.method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`ZIP-Kompression ${entry.method} wird nicht unterstützt`);
    if (data.length !== entry.size || zlib.crc32(data) >>> 0 !== entry.crc >>> 0) throw new Error(`${path.basename(entry.name)}: Inhalt beschädigt`);
    return data;
  } finally { fs.closeSync(fd); }
}

// ---------- Installation ----------
export class FfmpegInstaller extends EventEmitter {
  constructor({ logger }) {
    super();
    this.logger = logger;
    this.state = 'idle'; // idle | downloading | verifying | extracting | done | error
    this.received = 0;
    this.total = 0;
    this.error = '';
    this.running = null;
  }

  publicState() {
    const installed = fs.existsSync(ffmpegToolPath());
    return { state: this.state, received: this.received, total: this.total, error: this.error, installed, version: FFMPEG_PKG.version, sizeMb: Math.round(FFMPEG_PKG.size / 1e6), license: FFMPEG_PKG.license, source: FFMPEG_PKG.source };
  }

  set(state, extra = {}) { Object.assign(this, { state }, extra); this.emit('change', this.publicState()); }

  install() {
    if (this.running) return this.running;
    this.running = this.run().finally(() => { this.running = null; });
    return this.running;
  }

  async run() {
    const p = pkg();
    if (process.platform !== 'win32' && !process.env.UCC_FFMPEG_PKG_URL) { this.set('error', { error: 'ffmpeg auf Knopfdruck gibt es nur unter Windows.' }); return null; }
    const dir = ffmpegToolDir();
    fs.mkdirSync(dir, { recursive: true });
    const zip = path.join(dir, 'download.zip.part');
    try {
      this.set('downloading', { received: 0, total: p.size, error: '' });
      this.logger.info(`ffmpeg ${p.version} wird geladen: ${p.url}`);
      const res = await fetch(p.url, { redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`Download fehlgeschlagen (HTTP ${res.status})`);
      const total = Number(res.headers.get('content-length')) || p.size;
      this.total = total;
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(zip);
      let lastEmit = 0;
      for await (const chunk of res.body) {
        hash.update(chunk);
        this.received += chunk.length;
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        if (Date.now() - lastEmit > 400) { lastEmit = Date.now(); this.emit('change', this.publicState()); }
      }
      await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
      this.set('verifying');
      const sum = hash.digest('hex');
      if (!p.sha256 || sum !== p.sha256) throw new Error('Die Prüfsumme der geladenen Datei stimmt nicht - sie wurde verworfen.');
      this.set('extracting');
      const entries = listZip(zip);
      const exe = entries.find((e) => /(^|\/)bin\/ffmpeg\.exe$/i.test(e.name) || /^ffmpeg\.exe$/i.test(e.name));
      if (!exe) throw new Error('ffmpeg.exe nicht im Paket gefunden');
      fs.writeFileSync(path.join(dir, 'ffmpeg.exe.new'), readZipEntry(zip, exe));
      fs.renameSync(path.join(dir, 'ffmpeg.exe.new'), ffmpegToolPath());
      fs.chmodSync(ffmpegToolPath(), 0o755);
      const lic = entries.find((e) => /(^|\/)LICENSE(\.txt)?$/i.test(e.name));
      if (lic) fs.writeFileSync(path.join(dir, 'LICENSE.txt'), readZipEntry(zip, lic));
      fs.writeFileSync(path.join(dir, 'QUELLE.txt'), `ffmpeg ${p.version} (${FFMPEG_PKG.license})\nGeladen von: ${p.url}\nSHA-256 des Pakets: ${sum}\nProjekt: ${FFMPEG_PKG.source}\n`);
      this.logger.info(`ffmpeg ${p.version} installiert: ${ffmpegToolPath()}`);
      this.set('done');
      return ffmpegToolPath();
    } catch (e) {
      this.logger.warn(`ffmpeg nicht installiert: ${e.message}`);
      this.set('error', { error: e.message });
      return null;
    } finally {
      try { fs.rmSync(zip, { force: true }); } catch { /* egal */ }
      try { fs.rmSync(path.join(dir, 'ffmpeg.exe.new'), { force: true }); } catch { /* egal */ }
    }
  }

  remove() {
    if (this.running) throw new Error('Installation läuft gerade');
    fs.rmSync(ffmpegToolDir(), { recursive: true, force: true });
    this.set('idle', { received: 0, total: 0, error: '' });
  }
}
