# Kurzanleitung

## 1. Einrichten (einmalig, ca. 5 Minuten)
Beim ersten Start öffnet sich das Einrichtungs-Fenster. Es führt dich durch sechs Schritte:
1. **Willkommen:** Übersicht, was schon passt.
2. **Twitch-App:** Du legst auf dev.twitch.tv eine kostenlose Anwendung an und trägst die Client-ID ein (Client-Typ "Öffentlich"). Wird geprüft.
3. **Anmelden:** Du bestätigst die Anmeldung bei Twitch mit einem Code. Dein Stream-Key wird nie gebraucht.
4. **Spiel:** CS2-Ordner, Mausempfindlichkeit (Konsole: `sensitivity`), Taste deiner Blendgranate. Die nötigen CS2-Dateien werden installiert.
5. **Belohnungen:** Die Kanalpunkte-Belohnungen werden auf deinem Kanal angelegt (seit Mai 2026 für jeden Twitch-Kanal möglich, kein Affiliate nötig).
6. **Fertig:** Optional Desktop-Icon, Startmenü und Autostart.

## 2. OBS einrichten
Neue **Browser-Quelle**, Adresse `http://127.0.0.1:7788/overlay`, Größe 1920 x 1080. In der Quelle "Quelle beenden, wenn nicht sichtbar" aktivieren und FPS auf 30 stellen.

## 3. Im Stream
- Programm über das Icon starten, danach CS2 starten (oder neu starten, damit die Dateien geladen werden).
- Das Dashboard zeigt Status, Warteschlange, Testlauf pro Effekt und den **Not-Aus** (Hotkey `Strg+Alt+Ende`).
- Du kannst das Dashboard-Fenster schließen. Das Programm läuft im Hintergrund weiter. Zum Beenden: Dashboard öffnen (Icon erneut anklicken) und "Beenden".

## 4. Hilfe
- Maustaste oder Crosshair hängt nach einem Abbruch? CS2-Konsole: `ucc_restore`
- Effekte reagieren nicht? Läuft CS2 als Administrator, muss auch dieses Programm als Administrator laufen.
- Blick-Effekt dreht zu weit oder zu wenig: Sensitivity in den Einstellungen prüfen.
- Probleme melden: Protokolldatei `ucc.log` im Datenordner (`%APPDATA%\<Programmname>`) mitschicken.

## 5. Hinweise
- Die Effekte simulieren Tasten wie ein Makro. Nutze nur Effekte ohne Vorteil im Spiel und prüfe die aktuellen Regeln von Valve (CS2/VAC) und Twitch selbst.
- Dieses Programm ist nicht mit Twitch oder Valve verbunden.
