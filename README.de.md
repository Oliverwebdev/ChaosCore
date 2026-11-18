<p align="center">
  <img src="docs/images/banner.png" alt="ChaosCore – Dein Twitch-Chat spielt dein Spiel" width="100%">
</p>

<!-- download:start (updated automatically by the release workflow) -->
<p align="center">
  <a href="https://github.com/Oliverwebdev/ChaosCore/releases/download/v1.0.0-beta.1/ChaosCore-1.0.0-beta.1-Setup.exe"><img src="docs/images/download-windows-de.png" alt="ChaosCore für Windows herunterladen" width="440"></a>
  <br>
  <sub><b>v1.0.0-beta.1</b> · <a href="https://github.com/Oliverwebdev/ChaosCore/releases/download/v1.0.0-beta.1/ChaosCore-1.0.0-beta.1-Setup.exe">Setup.exe</a> · <a href="https://github.com/Oliverwebdev/ChaosCore/releases/download/v1.0.0-beta.1/ChaosCore-1.0.0-beta.1-portable.zip">portable ZIP (ohne Installation)</a> · <a href="https://github.com/Oliverwebdev/ChaosCore/releases">alle Versionen</a></sub>
</p>
<!-- download:end -->

<p align="center">
  <a href="https://github.com/Oliverwebdev/ChaosCore/releases"><img alt="Download" src="https://img.shields.io/github/v/release/Oliverwebdev/ChaosCore?include_prereleases&label=download&color=B026FF&style=for-the-badge"></a>
  <a href="https://github.com/Oliverwebdev/ChaosCore/actions/workflows/tests.yml"><img alt="Tests" src="https://img.shields.io/github/actions/workflow/status/Oliverwebdev/ChaosCore/tests.yml?branch=main&label=tests&style=for-the-badge"></a>
  <img alt="Windows 10/11" src="https://img.shields.io/badge/Windows-10%20%7C%2011-00f0ff?style=for-the-badge">
  <a href="LICENSE"><img alt="License: GPL-3.0" src="https://img.shields.io/badge/license-GPL--3.0-5cff9a?style=for-the-badge"></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <b>Deutsch</b>
</p>

---

**ChaosCore macht deine Zuschauer zum unberechenbarsten Teammate, das du je hattest.**
Sie geben Twitch-**Kanalpunkte** oder **Bits** aus, und in deinem Spiel passiert etwas — *live*:
WASD dreht sich um, dein Fadenkreuz wird so groß wie eine Wand, du darfst nur noch das Messer
halten. Und wenn du deswegen stirbst, merkt sich ChaosCore, **wer es war**.

Läuft komplett auf deinem PC. Keine Cloud, kein Konto bei uns, kein Stream-Key, kein Speicherzugriff aufs Spiel.

<p align="center">
  <img src="docs/images/overlay.png" alt="ChaosCore OBS overlay: alert, queue, history, chaos meter and session stats" width="100%">
  <br><sub>Das OBS-Overlay im Stream: Alert, Warteschlange, letzte Effekte, Chaos-Level, Top-Einlöser und Session Stats (Beispieldaten).</sub>
</p>

## Warum es ChaosCore gibt

Ich streame CS2 als [Mr.Unknown_GER](https://twitch.tv/mr_unknown_ger). Kanalpunkte enden meistens
als Sound oder Chatzeile — kurz lustig, dann vergessen. Ich wollte, dass meine Zuschauer wirklich
*ins Spiel greifen*: meine Steuerung umdrehen, mir das Gewehr wegnehmen, mich im dümmsten Moment
blenden. Und es sollte hinterher zählen — sterbe ich, weil jemand mein WASD invertiert hat, soll
genau dieser Zuschauer den Kill gutgeschrieben bekommen. Das ist ChaosCore: zuerst für meinen
eigenen Stream gebaut, so gemacht, dass jeder Streamer es in ein paar Minuten einrichten kann.

## Download

Kein Git, keine Befehle — einfach oben auf den großen Download-Knopf klicken.

1. Die `Setup.exe` herunterladen und doppelklicken. Keine Administrator-Rechte, nichts
   nachzuinstallieren — Node.js und AutoHotkey sind dabei.
2. Das Einrichtungs-Fenster führt dich in etwa fünf Minuten durch alles (Twitch-App, Anmeldung,
   Spiel, Belohnungen). Jeder Schritt wird geprüft und erklärt.
3. In OBS eine **Browser-Quelle** anlegen: `http://127.0.0.1:7788/overlay`, 1920 × 1080. Fertig.

Lieber ohne Installer? `portable.zip` entpacken und die `.exe` starten.

> **Early Access:** ChaosCore wird aktiv entwickelt (aktuell: **Beta**). Die CS2-Effekte sind
> live im Spiel getestet, neuere Funktionen wie Session Stats werden gerade auf Windows getestet.
> Rechne mit Ecken und Kanten — [Fehlermeldungen](https://github.com/Oliverwebdev/ChaosCore/issues/new/choose)
> sind sehr willkommen. Windows SmartScreen kann warnen, weil der Installer noch nicht signiert ist.

## Was es kann

| | |
|---|---|
| **Echte Effekte im Spiel** | 23 fertige CS2-Effekte (WASD invertiert, Feuerpause, Knife Time, Fadenkreuz riesig, Maus invertiert, Utility-Steuer, Kauf-Sperre, …) und ein Fortnite-Profil. |
| **Kanalpunkte *und* Bits** | Für jeden Kanal nutzbar, seit Twitch im Mai 2026 [Monetarisierung für alle](https://blog.twitch.tv/en/2026/05/13/monetization-for-all/) geöffnet hat — kein Affiliate nötig. |
| **Bits-Menü: 100 Bits = 1 Minute** | Zuschauer wählen den Effekt per Stichwort im Cheer (`Cheer300 wasd` = 3 Minuten WASD invertiert). Gekauft ist Spielzeit: Stirbst du, läuft der Rest in der nächsten Runde weiter. |
| **Session Stats** | Kills, Tode, K/D, Fails, Runden und Matches pro Stream — Tode getrennt in *natürlich* und *durch Chaos*. Wer dich erwischt hat, landet in der **Folter-Rangliste**. |
| **Effekt-Baukasten ohne Code** | Sperren, Halten, Spam und Tauschen direkt im Dashboard zu eigenen Effekten verketten. |
| **OBS-Overlay** | Alerts, Warteschlange, Verlauf, Chaos-Level, Community-Ziel, Season-Ranking, Session Stats. Layout per Drag & Drop, Fenster einzeln ein/aus, jedes Fenster eigenes Design (Dunkel, Hell, Glas, eigene Farben). |
| **Mini-Ansicht & Updates per Klick** | Kleine Ansicht mit der Warteliste im Fokus zum Danebenlegen, und Updates direkt von GitHub — geprüft und mit einem Klick installiert. |
| **Community** | Community-Ziel mit Schwellen, Seasons über mehrere Streams mit Chaos-Score, Daily Contract, Auto-Lebendig, Chat-Befehle. |
| **Presets teilen** | Dein ganzes Setup (Tasten, Effekte, Layout, sogar eigene Sounds/Bilder) als eine Datei — mit Vorschau vor jedem Import. |
| **Deutsch & Englisch** | Einrichtung, Dashboard, Overlay und Chat-Meldungen. |

<p align="center">
  <img src="docs/images/session-stats.png" alt="Session Stats in the ChaosCore dashboard" width="85%">
  <br><sub>Session Stats: jeder Tod, wer ihn verursacht hat, und Umbuchen mit einem Klick (Beispieldaten).</sub>
</p>

## Sicher im Stream

- **Feste Effektliste.** Zuschauer wählen nur, was *du* eingerichtet hast — nie Konsolenbefehle aus dem Chat.
- **Eingaben nur ins Spiel.** Der Fokus wird vor jeder einzelnen Eingabe geprüft. Wechselst du
  mitten im Effekt das Fenster, bricht er sofort ab und alle Tasten werden losgelassen.
- **Not-Aus** im Dashboard und per Hotkey `Strg+Alt+Ende`.
- **Warteschlange, Cooldowns, Limits pro Zuschauer.** Ungültige Einlösungen werden automatisch mit Begründung erstattet.
- **Gehärteter Preset-Import.** Fremde Presets können weder Windows-/Enter-/Escape-/Alt-Tasten
  nutzen noch Fokusprüfung oder Not-Aus ändern; eine fehlerhafte Datei wird komplett abgelehnt.
- **Nur lokal.** Der Server hört nur auf `127.0.0.1`, Tokens bleiben in deinem Datenordner, und der
  Fehlerbericht wird nie automatisch verschickt.

> **Eigenverantwortung:** ChaosCore simuliert Tastatur- und Mauseingaben wie ein Makro. Ob ein
> Anti-Cheat-System darauf reagiert, kann sich jederzeit ändern und liegt außerhalb von ChaosCore.
> Nutzung auf eigenes Risiko: Nutze nur Effekte ohne Vorteil im Spiel und prüfe die aktuellen Regeln
> des Spiels und von Twitch. ChaosCore lässt dich das beim ersten Start einmal bestätigen.

## So funktioniert's

```mermaid
flowchart LR
  V[Zuschauer] -- Kanalpunkte / Bits --> T[Twitch EventSub]
  T --> E[ChaosCore-Engine<br/>Warteschlange · Limits · Erstattung]
  E -- simulierte Eingaben --> G[Spiel]
  G -- Game State Integration --> E
  E --> O[OBS-Overlay]
  E --> D[Dashboard]
```

ChaosCore ist ein kleiner lokaler Node.js-Server. Er empfängt Twitch EventSub, schickt Effekte
über AutoHotkey ins Spielfenster, liest den Spielzustand über Valves offizielle Game State
Integration (CS2, kein Speicherzugriff) und liefert Dashboard und Overlay an Browser und OBS.

## Aus dem Quellcode bauen

Benötigt Node.js ≥ 22.13 (nutzt das eingebaute `node:sqlite`; keine npm-Abhängigkeiten).

```bash
git clone https://github.com/Oliverwebdev/ChaosCore.git
cd ChaosCore
npm run setup     # geführte Einrichtung im Terminal
npm start         # Server starten
npm test          # kompletter Selbsttest gegen simuliertes Twitch (~4 Min.)
```

Der Windows-Installer wird unter Linux/WSL mit `npm run build:win` gebaut
(braucht `gcc-mingw-w64-x86-64-win32`, `nsis`, `zip`, `unzip`, `python3-pil`).

Schnellstart: [`docs/ANLEITUNG.md`](docs/ANLEITUNG.md) · Alle Funktionen und Einstellungen:
[`docs/HANDBUCH.md`](docs/HANDBUCH.md).

## Stand & Roadmap

- [x] CS2-Profil mit 23 Effekten, Bits-Stufen, Overlay, Dashboard, Presets, Seasons, Community-Ziel
- [x] Session Stats mit Chaos-Tod-Zuordnung (Beta)
- [x] Bits-Menü, Mini-Ansicht, eigenes Design je Overlay-Fenster, Updates per Klick (Beta)
- [ ] Praxistests auf Windows in echten Streams
- [ ] Weitere Spiel-Profile über eine gemeinsame Adapter-Schnittstelle
- [ ] Signierter Installer

Den Fortschritt siehst du unter [Releases](https://github.com/Oliverwebdev/ChaosCore/releases) und im Commit-Verlauf.

## Mitmachen

Ideen, Fehlermeldungen und Pull Requests sind willkommen — siehe [CONTRIBUTING.md](CONTRIBUTING.md).
Sicherheitslücke gefunden? Bitte zuerst [SECURITY.md](SECURITY.md) lesen.

## Lizenz

ChaosCore ist freie Software unter der [GNU General Public License v3.0](LICENSE) oder neuer.
Mitgelieferte Fremdsoftware (Node.js, AutoHotkey) behält ihre eigenen Lizenzen — siehe
[THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md).

Gemacht von [WebDevOli](https://github.com/Oliverwebdev) · live auf Twitch als
[Mr.Unknown_GER](https://twitch.tv/mr_unknown_ger).

<sub>ChaosCore ist nicht mit Twitch, Valve oder Epic Games verbunden. Twitch ist eine Marke von
Twitch Interactive, Inc. Counter-Strike und CS2 sind Marken der Valve Corporation. Fortnite ist eine
Marke von Epic Games, Inc.</sub>
