// - Die eigene Installation ist IMMER die volle, uneingeschränkte Version - keine Ausnahme im
//   Code, sondern schlicht: ohne Testversion-Marker (siehe unten) ist jede Installation voll
//   freigeschaltet. Es gibt für 1.0 noch keine Basis-/Pro-Trennung (was genau "Pro" einmal umfasst,
//   ist noch offen) - aber schon JETZT eine einzige, zentrale
//   Stelle (isUnlocked()), damit eine künftige Pro-Freischaltung später andocken kann, ohne den
//   restlichen Code umzubauen.
// - Testversionen für sichere Weitergabe (an einen Anwalt, für einen Pitch, an vertrauenswürdige
//   Tester): ein Testversion-Modus, der beim BAUEN des Installers aktiviert wird (siehe
//   build/build-win.mjs, Flag --testversion=YYYY-MM-DD), NICHT nachträglich im laufenden Programm
//   umschaltbar, mit festem Ablaufdatum. Danach verweigert das Programm mit klarer Meldung den
//   Start, ohne Daten zu zerstören (siehe server.js: der Lizenz-Check läuft vor jedem Config-/
//   Datenzugriff). Bewusst KEIN Selbstlöschungs-Mechanismus (unzuverlässig, leicht umgangen).
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

// Liegt neben src/ (im Installer-Stage-Ordner "app/", siehe build-win.mjs) - existiert nur, wenn
// der Installer mit --testversion=... gebaut wurde. UCC_TESTVERSION_FILE überschreibt den Pfad nur
// für Tests (genau wie UCC_DATA_DIR bei config.js) - ohne das müsste ein Test die echte
// Projektdatei testversion.json anlegen/löschen und würde damit parallel laufende Prozesse stören.
const MARKER_FILE = process.env.UCC_TESTVERSION_FILE ? path.resolve(process.env.UCC_TESTVERSION_FILE) : path.join(ROOT, 'testversion.json');

let cached = null;
export function getLicenseState() {
  if (cached) return cached;
  cached = { testVersion: false, expiresAt: null, expired: false };
  try {
    const raw = JSON.parse(fs.readFileSync(MARKER_FILE, 'utf8'));
    if (raw?.expiresAt) {
      const exp = new Date(raw.expiresAt).getTime();
      if (!Number.isNaN(exp)) {
        cached.testVersion = true;
        cached.expiresAt = raw.expiresAt;
        cached.expired = Date.now() > exp;
      }
    }
  } catch { /* keine Marker-Datei -> normale (volle) Version, siehe Dateikopf */ }
  return cached;
}

// Nur für Tests: der Marker wird einmal pro Prozess gelesen und zwischengespeichert (er ändert
// sich zur Laufzeit nie) - ein Test, der mit verschiedenen Marker-Ständen arbeitet, braucht diesen
// Reset zwischen den Ständen.
export function resetLicenseCache() { cached = null; }

// Die eine zentrale Freischaltungs-Prüfung. Heute schaltet jede Installation
// (auch eine Testversion, solange sie nicht abgelaufen ist - server.js verweigert den Start schon
// vorher) jede Funktion frei; der Haken dafür ist absichtlich schon hier statt verstreut im
// restlichen Code.
export function isUnlocked(_feature) { return true; }
