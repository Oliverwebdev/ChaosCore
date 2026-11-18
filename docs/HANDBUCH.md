# ChaosCore — Handbuch

Ausführliche Referenz zu allen Funktionen. Einstieg und Download: [README](../README.de.md). Schnellstart: [ANLEITUNG.md](ANLEITUNG.md).

## OBS
Browser-Quelle hinzufügen: `http://127.0.0.1:7788/overlay`, 1920×1080 (die genaue Adresse zeigt der Server beim Start).
Einzelne Panels pro Quelle ausblenden: `?history=0` (Verlauf), `?top=0` (Top Einlöser), `?chaos=0` (Chaos-Level).
Ressourcen sparen: in der OBS-Quelle „Quelle beenden, wenn nicht sichtbar“ aktivieren und die FPS auf 30 stellen.

## Dashboard
Öffnet sich beim Start als eigenes, schlankes App-Fenster (ohne Tabs und Erweiterungen, eigenes Profil in `data/app-profile`).
Fenster geschlossen? Einfach das Desktop-/Startmenü-Symbol nochmal anklicken (läuft das Programm schon, öffnet sich nur das Fenster neu).
Entwickler ohne Installer: `npm run dashboard`. Normaler Browser statt App-Fenster: in `data/config.json` bei `server` `"dashboardMode": "browser"` setzen.
Das Fenster fragt nur ab, solange es sichtbar ist (minimiert oder verdeckt = Pause).

**Mini-Ansicht** (Knopf „▭ Mini-Ansicht" oben): dasselbe Fenster zeigt nur noch den laufenden Effekt
mit Restzeit, die Warteliste (einzelne Einträge per ✕ herausnehmen, der Zuschauer bekommt seine
Punkte zurück) und Pause, Leeren und Not-Aus. Zum Danebenlegen während des Spielens; „Volle Ansicht"
bringt alles zurück. Die Ansicht wird gemerkt.

## Overlay-Anzeige
- **Alert:** Name des Zuschauers und Aktion bei jeder Einlösung.
- **Zuletzt ausgelöst:** die letzten 5 Einlösungen mit Name, Aktion und Zeit (bleibt auch nach einem Neustart erhalten).
- **Top Einlöser:** wechselt automatisch zwischen **Heute** (aktueller Stream) und **Gesamt** (alle Streams).
  Ein neuer Stream beginnt nach 6 Stunden Pause.
- **Neuer Platz 1:** Überholt jemand den Spitzenreiter (heute oder gesamt), erscheint eine Meldung mit Name und Zähler.
  Die erste Einlösung überhaupt löst sie nicht aus.
- Einstellungen in `data/config.json` unter `overlay`: `history`, `top`, `historyCount`, `topCount`,
  `topMode` (`"both"`, `"today"` oder `"all"`) und `topRotateSec` (Wechselzeit, 4 bis 120 Sekunden).

## Wichtige Befehle
| Befehl | Zweck |
|---|---|
| `npm run setup` | Geführte Einrichtung im Terminal (jederzeit wiederholbar) |
| `npm run build:win` | Baut Setup.exe und portables ZIP |
| `npm start` | Server starten |
| `npm run doctor` | Prüft Verbindung, Token, Belohnungen, CS2-Dateien |
| `npm test` | Selbsttest mit simuliertem Twitch |

## Anpassen
Preise, Cooldowns, Limits und Effekte stehen in `data/actions.json` (Vorlage: `config/actions.default.json`).
Danach im Dashboard oben auf „⚙ Einrichtung" (Schritt 5) klicken, um Twitch abzugleichen — oder, ohne Installer, `npm run rewards`.
Tasten-Belegung und Port stehen in `data/config.json`.
Eigene Effekte baust du direkt im Dashboard ("Builder") aus Bausteinen (Sperren/Halten/Spam/
Tauschen, bis zu 8 verkettet), ohne eine Zeile Code zu schreiben.

## Spiele wechseln
Dashboard → Spiel-Profil-Dropdown. Eigene Tastenbelegung bleibt beim Wechsel erhalten (additiv
zusammengeführt, nichts geht verloren). Jedes Profil hat einen eigenen Selbsttest-Knopf, der jede
konfigurierte Aktion gegen die aktuelle Tastenbelegung prüft, bevor du live gehst.

## Bits-Menü
Standardmäßig aktiv: **100 Bits = 1 Minute Chaos** (im Dashboard unter „Bits-Effekte" einstellbar).
Zuschauer schreiben ein Stichwort in ihre Cheer-Nachricht, z. B. `Cheer300 maus` = 3 Minuten Maus
invertiert. Ohne Stichwort gibt es einen zufälligen Effekt aus dem Menü (oder, wenn so eingestellt,
gar keinen). Mitgeliefert: Nur Schleichen (`shift`), Maus invertiert (`maus`), WASD invertiert
(`wasd`), dazu ausgeschaltet Fadenkreuz riesig (`fadenkreuz`) und Kauf-Sperre (`kauf`). Stichwörter
lassen sich ändern.
- Gekauft ist **Spielzeit**: Stirbst du oder endet die Runde, wird die restliche Zeit vorne in die
  Warteliste gelegt und läuft in der nächsten Runde weiter.
- Mehr als die eingestellte Höchstdauer am Stück (Standard 5 Minuten) wird zu weiteren Blöcken in der
  Warteliste.
- `!bits` im Chat erklärt das Menü (wenn die Chat-Funktion an ist).
- Solange das Bits-Menü aktiv ist, sind die klassischen Bits-Stufen (unten) aus.

## Bits-Stufen (klassisch)
Eigene Bits-Stufen (unabhängig von den Kanalpunkte-Belohnungen, da Cheers beliebige Beträge haben
können) im Dashboard unter "Bits-Stufen" einrichten. Ein Cheer löst die höchste erreichte Stufe
aus. Braucht beim Login den Scope `bits:read` — bei einem älteren Login einmal `npm run login`
erneut ausführen. Bits sind nicht erstattbar (Twitch bietet dafür keine API).

## Zugriffsregeln (Sub/VIP/Mod)
Jede Aktion (Kanalpunkte und Bits) lässt sich im Dashboard auf "Nur Abonnenten"/"Nur VIPs"/"Nur
Moderatoren" einschränken (Standard: jeder). Fehlt die Rolle, wird die Einlösung sofort mit einer
klaren Begründung erstattet statt stillschweigend ignoriert.

## Community-Ziel
Ein gemeinsames Fortschrittsziel für den ganzen Chat (Dashboard → "Community-Ziel"): eigener
Name, Grundlage (Kanalpunkte, Bits oder beides) und bis zu 5 Schwellen, jede optional mit einer
fest hinterlegten Aktion statt einer zufälligen. Ohne eigene Konfiguration verhält es sich wie das
klassische "Chaos Overload" bei 100%.

## Auto-Lebendig
Löst nach einer einstellbaren Ruhezeit ohne echte Einlösung automatisch eine zufällige Aktion aus
einer eigenen Whitelist aus (Dashboard → "Auto-Lebendig") — damit der Stream nie komplett still
steht, wenn gerade niemand einlöst. Standardmäßig ausgeschaltet.

## Warteschlange
`cfg.engine.maxQueue` (1-50) und eine optionale Wartezeit auf einen freien Platz
(`cfg.engine.queueWaitSec`) stellst du im Dashboard unter "Warteschlange" ein — wichtig für
Kanäle mit vielen gleichzeitigen Einlösungen. Reine Overlay-Meldungen ohne Tastendruck laufen
unabhängig davon immer sofort parallel.

## Season / Chaos-Score
Ein laufender Punktestand pro Zuschauer über eine einstellbare Zeitspanne (`season.lengthDays`,
im Dashboard einstellbar), mit Spitzenreiter-Anzeige im Overlay. "Season beenden" hält den
Gewinner fest und setzt zurück.

## Session Stats
Zählt pro Stream Kills, Tode, K/D, Fails sowie Runden und Matches (CS2 über Game State Integration,
kein Speicherzugriff) und trennt Tode in „natürlich" und „durch Chaos": Stirbst du während eines
Zuschauer-Effekts oder bis zu 5 Sekunden danach, bekommt der Zuschauer den Tod gutgeschrieben
(Folter-Rangliste). Die Sitzung startet und endet mit dem Stream oder von Hand. Fails per Hotkey
(Strg+Alt+F), `!fail` (Mods) oder Dashboard. Im Dashboard unter „Session Stats": Werte wählen,
Tode umbuchen, Historie, CSV-Export. Im Overlay als eigenes Panel (drei Designs, eigene OBS-Quelle
mit `?only=stats`). Nach dem Update CS2 einmal neu starten (neue GSI-Datei).

## Overlay-Layout anpassen
Im Dashboard unter "Overlay-Layout": jedes Panel lässt sich per Drag & Drop frei positionieren und
über einen Schieberegler in der Größe anpassen (50%-200%) — wirkt sofort im laufenden OBS-Overlay.
Darunter schaltest du einzelne Fenster ganz aus.

## Aussehen der Fenster
Jedes Overlay-Fenster bekommt auf Wunsch ein eigenes Design: Unknown, Dunkel, Hell oder Glas,
eigene Akzentfarbe, Deckkraft, abgeschrägte oder runde Ecken, Rahmen und Leuchten. „Auf alle
Fenster übertragen" setzt denselben Stil überall. Für Profis gibt es zusätzlich ein Feld für eigenes
CSS — das bleibt nur auf deinem PC und wird weder exportiert noch aus fremden Presets übernommen.

## Presets teilen / One-Click-Setups
"Preset teilen" exportiert dein komplettes Setup (Tastenbelegung, Aktionen, Overlay-Layout, sogar
eigene Sounds/Bilder) als eine einzelne Datei inklusive Name/Autor — "Preset importieren" wendet
sie bei jemand anderem an. Mitgelieferte, fertige Presets stehen im Dashboard unter "Vorgefertigte
Presets" und lassen sich mit einem Klick übernehmen.

## Diagnose & Fehlerbericht
Dashboard → "Fehlerbericht erstellen" bündelt Systeminfo, die letzten Protokollzeilen, die aktive
Konfiguration (ohne Geheimnisse) und dein eigenes Freitextfeld in einer Datei zum Weitergeben —
wird NIE automatisch irgendwohin verschickt, das entscheidest du selbst.

## Die Effekte
| Belohnung | Was passiert |
|---|---|
| UNKNOWN entdeckt dich | Der Blick geht automatisch ca. 55° nach oben und wieder zurück |
| Feuerpause | Linke Maustaste 3 Sekunden gesperrt (im Programm **und** direkt in CS2) |
| Kein Zoom | Rechte Maustaste 15 Sekunden gesperrt (ebenso doppelt gesichert) |
| Utility-Steuer | Wählt die nächste Granate im Inventar, prüft per Spielstatus, dass sie in der Hand ist, und wirft sie. Ist keine Granate in der Hand, wird **nicht** geklickt und die Punkte werden erstattet |
| Eigene Flashbang | Wählt die Blendgranate (deine Taste, Standard 7), prüft und wirft sie |
| Bewegungssperre | WASD 5 Sekunden gesperrt (gehaltene Tasten werden sofort losgelassen) |
| WASD invertiert | 20 Sekunden vor/zurück und links/rechts vertauscht |
| Crosshair unsichtbar | 20 Sekunden ohne Crosshair, danach garantiert wieder sichtbar |
| Ducken-Spam | Ca. 3 Sekunden Ducken-Spam |
| Sprung-Spam | Presst die Sprungtaste ca. 3 Sekunden wiederholt |
| Scoreboard-Sicht | Hält die Scoreboard-Taste (Standard Tab) 4 Sekunden gedrückt — blockt die Sicht |
| Fadenkreuz riesig | 15 Sekunden ein riesiges Crosshair, danach garantiert wieder normale Größe |
| Maus invertiert | 10 Sekunden vertikal invertierte Maus (hoch/runter vertauscht), danach garantiert zurückgestellt |
| Kauf-Sperre | Kaufmenü ca. 25 Sekunden gesperrt (deckt meist die nächste Kaufphase ab, kein exaktes Runden-Timing) |
| Shift-Polizei, Knife Time, Waffensteuer, Pistol Only, Routenwechsel, UNKNOWN-Fluch | siehe Dashboard |

## Einstellungen (data/config.json)
- `game.sensitivity`: deine CS2-Mausempfindlichkeit (Konsole: `sensitivity`). Bestimmt, wie weit der Blick-Effekt dreht. Der Assistent fragt danach.
- `keys.flash`: deine Taste für die Blendgranate (Standard `7`).
- `keys.forward/left/back/right`: Bewegungstasten (Standard WASD).
- `game.crosshairAlpha`: Deckkraft, auf die das Crosshair nach "Crosshair unsichtbar" zurückgestellt wird.
- `game.crosshairSize` / `game.crosshairBigSize`: normale bzw. Größe für "Fadenkreuz riesig" (Konsole: `cl_crosshairsize`).
- `game.mPitch`: deine normale vertikale Mausempfindlichkeit (Konsole: `m_pitch`), auf die nach "Maus invertiert" zurückgestellt wird.
- `keys.jump/scoreboard/buy`: deine Tasten für Springen, Scoreboard und Kaufmenü (Standard Leertaste, Tab, `b`).
- Interne Binds liegen auf dem Nummernblock (Numpad 1-5, 7-9, `/ * - +`), weil die Source-Engine F13-F24 nicht kennt.
  Funktioniert auch ohne echten Nummernblock. Belege diese Tasten im Spiel nicht selbst.

## Updates
Das Dashboard fragt beim Öffnen (höchstens alle 10 Minuten) bei GitHub nach, ob es eine neuere
Version gibt. Wenn ja, erscheint oben „⬆ Update". Unter System & Presets → Version reicht dann ein
Klick auf **Jetzt aktualisieren**: ChaosCore lädt den Installer aus dem offiziellen Release, prüft
ihn gegen die veröffentlichten SHA-256-Prüfsummen, installiert ihn still und startet neu. Deine
Einstellungen, Statistiken und dein Twitch-Login bleiben erhalten.
- „Welche Versionen anbieten?": Automatisch (Beta-Versionen nur, solange du selbst eine Beta nutzt),
  nur fertige Versionen oder auch Betas.
- Ohne Klick wird nie etwas installiert. Die portable Version und ein Start aus dem Quellcode zeigen
  nur den Download-Link.
- Wer gar keine Anfrage ins Netz möchte: `githubRepo` in `product.json` leeren.

## Fehlersuche
- Nach einem Update einmal „⚙ Einrichtung" im Dashboard öffnen und bei Schritt 4/5 auf „Speichern und CS2-Dateien installieren" bzw. „Auf Twitch anlegen" klicken: erneuert die CS2-Dateien und gleicht die Belohnungen ab. (Ohne Installer: `npm run setup` bzw. `npm run cs2`.)
- Maustaste im Spiel plötzlich tot? In der CS2-Konsole `ucc_restore` eingeben. Das stellt linke/rechte Maustaste und Crosshair zurück.
- Blick-Effekt dreht zu weit oder zu wenig: `game.sensitivity` prüfen.
- Läuft CS2 als Administrator, muss auch das Programm als Administrator laufen (Windows blockiert sonst die simulierten Tasten).
- Mit "Testlauf" im Dashboard kannst du jeden Effekt prüfen, ohne dass etwas bei Twitch eingelöst wird.
