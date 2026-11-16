// Aufzeichnung echter GSI-Pakete. Zweck: Session Stats an ECHTEN
// CS2-Daten prüfen (Feldnamen, Moduswerte, was beim Tod genau ankommt) und daraus Test-Fixtures
// machen. Schreibt eine Zeile JSON je Paket nach <Datenordner>/gsi-recordings/*.jsonl.
// Das GSI-Token wird nie mitgeschrieben. Die Steam-ID bleibt drin (ohne sie lässt sich "spiele ich
// selbst oder schaue ich zu" nicht prüfen) - die Datei bleibt lokal, Weitergabe nur bewusst.
// Begrenzt auf 50 MB bzw. 3 Stunden, dann endet die Aufzeichnung von selbst.
import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_MS = 3 * 60 * 60 * 1000;

export function createGsiRecorder(dataDir, logger) {
  let cur = null; // { file, fd, startedAt, count, bytes }
  const dir = path.join(dataDir, 'gsi-recordings');
  function stop(reason) {
    if (!cur) return null;
    const done = { file: cur.file, count: cur.count, bytes: cur.bytes };
    try { fs.closeSync(cur.fd); } catch { /* egal */ }
    cur = null;
    logger?.info(`GSI-Aufzeichnung beendet${reason ? ` (${reason})` : ''}: ${done.count} Pakete in ${path.basename(done.file)}.`);
    return done;
  }
  return {
    start() {
      if (cur) return this.status();
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = path.join(dir, `gsi-${stamp}.jsonl`);
      cur = { file, fd: fs.openSync(file, 'a'), startedAt: Date.now(), count: 0, bytes: 0 };
      logger?.info(`GSI-Aufzeichnung gestartet: ${path.basename(file)}`);
      return this.status();
    },
    stop() { return stop(); },
    write(body) {
      if (!cur) return;
      if (Date.now() - cur.startedAt > MAX_MS) { stop('3 Stunden erreicht'); return; }
      const clean = { ...body };
      delete clean.auth; // Token nie speichern
      const line = JSON.stringify({ t: Date.now() - cur.startedAt, body: clean }) + '\n';
      if (cur.bytes + line.length > MAX_BYTES) { stop('50 MB erreicht'); return; }
      fs.writeSync(cur.fd, line);
      cur.bytes += line.length; cur.count++;
    },
    status() {
      return cur ? { on: true, file: path.basename(cur.file), dir, count: cur.count, since: cur.startedAt } : { on: false, dir };
    },
  };
}

// Liest eine Aufzeichnung (jsonl) - für Tests und das Abspielen (scripts/gsi-replay.mjs).
export function readRecording(text) {
  return text.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}
