# Lizenzen mitgelieferter Drittkomponenten

ChaosCore selbst steht unter der GNU General Public License v3.0 oder neuer (siehe `LICENSE`). Der Windows-Installer und das
portable Paket enthalten zusätzlich zwei fremde, unveränderte Programme, die unter eigenen
Bedingungen stehen. Dieses Dokument listet sie, damit Lizenzpflichten nachvollziehbar erfüllt
sind. Es ersetzt keine Rechtsberatung — bei kommerziellem Vertrieb empfiehlt sich eine kurze
Prüfung durch jemanden mit IT-Rechts-Hintergrund.

## AutoHotkey v2

- **Zweck im Projekt:** führt die Effekt-Skripte aus (Tasten drücken/halten/sperren), die ChaosCore
  zur Laufzeit erzeugt. Läuft als eigener, unveränderter Prozess neben dem Node.js-Programm — wird
  nicht in den eigenen Code eingebunden oder verändert.
- **Lizenz:** GNU General Public License (GPL). Vollständiger Lizenztext:
  https://www.gnu.org/licenses/old-licenses/gpl-2.0.html (AutoHotkey verwendet historisch GPLv2;
  aktuellen Stand vor Weitergabe auf https://github.com/AutoHotkey/AutoHotkey prüfen).
- **Herkunft/Quellcode:** offiziell, unverändert von https://github.com/AutoHotkey/AutoHotkey,
  Version wie in `build/build-win.mjs` (`AHK_VERSION`) angegeben. Die Build-Pipeline prüft die
  SHA256-Prüfsumme der heruntergeladenen Datei gegen einen fest hinterlegten Wert, bevor sie
  mitgeliefert wird.
- **Was das für Weitergabe bedeutet:** Weil die Binärdatei unverändert mitgeliefert und als
  getrennter Prozess aufgerufen wird (keine Verlinkung/kein Einbetten in den eigenen Code), muss
  nach gängiger GPL-Auslegung nicht der eigene ChaosCore-Code unter GPL gestellt werden ("bloße
  Aggregation" statt "abgeleitetes Werk"). Diese Einschätzung sollte vor einem größeren
  kommerziellen Vertrieb von jemandem mit IT-Rechts-Hintergrund bestätigt werden.

## Node.js (gebündelte Laufzeit)

- **Zweck im Projekt:** führt den eigentlichen ChaosCore-Server aus (`runtime\ucc-node.exe` im
  Installer), damit Käufer nichts selbst installieren müssen.
- **Lizenz:** Node.js-eigene Lizenz (im Wesentlichen MIT-artig mit zusätzlichen Hinweisen für
  gebündelte Abhängigkeiten). Vollständiger Text: https://github.com/nodejs/node/blob/main/LICENSE
- **Herkunft:** offizielles, unverändertes Release von nodejs.org, bezogen über das npm-Paket
  `node-win-x64` (siehe `build/build-win.mjs`).

## ffmpeg (optional, nur nach Klick geladen)

- **Zweck im Projekt:** erstellt Hochkant-Versionen lokaler Clips. Wird **nicht** mitgeliefert;
  „ffmpeg installieren“ im Dashboard lädt es auf Wunsch in den Datenordner (`data/tools/ffmpeg`).
- **Lizenz:** GNU GPL v3 (Build mit GPL-Bibliotheken). Der Lizenztext wird mit abgelegt.
- **Herkunft:** unverändertes Windows-Build von Gyan Doshi (https://www.gyan.dev/ffmpeg/builds/),
  bezogen über https://github.com/GyanD/codexffmpeg/releases; Version und SHA-256-Prüfsumme sind
  fest in `src/ffmpeg-install.js` hinterlegt. Quellcode von FFmpeg: https://ffmpeg.org

## Eigener Code

Der gesamte übrige Quellcode (`src/`, `web/`, `scripts/`, `build/`) ist eigene Arbeit und steht
unter der GNU General Public License v3.0 oder neuer (`LICENSE`). Quellcode:
https://github.com/Oliverwebdev/ChaosCore
