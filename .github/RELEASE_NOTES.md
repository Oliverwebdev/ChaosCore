**ChaosCore 2.0 beta — a new dashboard for every screen, an overlay stage that respects the CS2 HUD, and Bits that feel golden.**
*Deutsch weiter unten.*

> **Beta:** please report anything odd. Windows SmartScreen may warn because the installer isn't code-signed yet ("More info" → "Run anyway").

### New
- **New dashboard:** eight clear areas and a live panel with the emergency stop that stays visible everywhere. Works from a narrow OBS dock to an ultrawide monitor — no empty side bars. Three designs: Dark, Unknown (neon) and Light.
- **Live cockpit:** a ring with the time left of the running effect and a "Needs you" inbox that only shows what needs an action, each with the right button.
- **Overlay stage:** your overlay over a CS2 view with the HUD marked (radar, kill feed, health, ammo). ChaosCore warns when a window covers it. Click a window for its profile card: visibility, size, position and style. The default layout now keeps the HUD free.
- **Highlights timeline:** the last stream at a glance; rules read as sentences. New: clip limit per stream, replay buffer length set from ChaosCore, crop and logo for the vertical Shorts version.
- **Effects gallery:** search and filter; every effect says in one sentence what it does. The editor opens on the side.
- **Bits ladder (optional):** Golden Kill (100), Round Naming (150), Golden Frame (200), Round Curse (300), Boss Round (500), Chaos Parliament (800). No randomness, no bets — viewers get exactly what the tier says.
- **One-click ffmpeg** for the vertical Shorts version: downloaded only on click, checked against a pinned SHA-256, removable again.
- **Huge Crosshair works with every crosshair:** ChaosCore reads your own crosshair from CS2 and restores exactly that; your crosshair style is no longer overwritten.
- **Your own OBS overlays** loaded as a local file can read the live event stream (`/events`).
- **First test in CS2:** a checklist from offline bots to official Casual, with "works / problem" for every step.
- **CS2 only:** the Fortnite profile is gone; everything is built around CS2.

**Upgrading from 1.x:** your settings stay. Restart CS2 once after the first start so it loads the new binds. The old Bits tiers stay in the list as "old" and are switched off, because the new ladder uses the same prices — switch them back on if you prefer them.

### Download
- **`…-Setup.exe`** — installer, recommended (no admin rights needed)
- `…-portable.zip` — no installation, just unzip and start
- `SHA256SUMS.txt` + `SHA256SUMS.txt.sig` — checksums and the developer's signature

---

### Deutsch
- **Neues Dashboard:** acht klare Bereiche und ein Live-Feld mit Not-Aus, das überall sichtbar bleibt. Passt vom schmalen OBS-Dock bis zum Ultrawide-Monitor — ohne leere Ränder. Drei Designs: Dunkel, Unknown (Neon) und Hell.
- **Live-Cockpit:** Ring mit der Restzeit des laufenden Effekts und ein Postfach „Braucht dich“, das nur zeigt, was eine Handlung braucht — jeweils mit dem passenden Knopf.
- **Overlay-Bühne:** dein Overlay über einem CS2-Bild mit markierten Anzeigen (Radar, Killfeed, Leben, Munition). ChaosCore warnt, wenn ein Fenster sie verdeckt. Ein Klick auf ein Fenster öffnet seinen Steckbrief: sichtbar, Größe, Position, Aussehen. Die Standard-Anordnung lässt die Anzeigen jetzt frei.
- **Highlights als Zeitleiste:** der letzte Stream auf einen Blick, Regeln als Sätze. Neu: Clip-Obergrenze pro Stream, Puffer-Länge direkt aus ChaosCore, Ausschnitt und Logo für die Hochkant-Version.
- **Effekt-Galerie:** Suche und Filter, jeder Effekt sagt in einem Satz, was er tut. Der Editor öffnet sich an der Seite.
- **Bits-Leiter (optional):** Goldener Kill (100), Rundentaufe (150), Goldener Rahmen (200), Fluch der Runde (300), Boss-Runde (500), Chaos-Parlament (800). Kein Zufall, keine Wetten — wer cheert, bekommt genau, was auf der Stufe steht.
- **ffmpeg per Knopf** für die Hochkant-Version: wird nur nach Klick geladen, gegen eine feste SHA-256-Prüfsumme geprüft und ist wieder entfernbar.
- **Fadenkreuz riesig mit jedem Fadenkreuz:** ChaosCore liest dein eigenes Fadenkreuz aus CS2 und stellt genau das wieder her; dein Stil wird nicht mehr überschrieben.
- **Eigene OBS-Overlays** als „Lokale Datei“ können den Live-Datenstrom (`/events`) lesen.
- **Erst-Test in CS2:** Checkliste vom Offline-Spiel mit Bots bis zum offiziellen Casual, mit „Klappt / Problem“ für jeden Schritt.
- **Nur noch CS2:** das Fortnite-Profil ist entfernt, alles ist auf CS2 ausgerichtet.

**Update von 1.x:** deine Einstellungen bleiben. Nach dem ersten Start CS2 einmal neu starten, damit es die neuen Binds lädt. Die alten Bits-Stufen stehen als „alt“ in der Liste und sind aus, weil die neue Leiter dieselben Preise nutzt — bei Bedarf einfach wieder einschalten.

Built automatically from this repository by GitHub Actions · License: GPL-3.0-or-later
