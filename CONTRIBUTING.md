# Contributing to ChaosCore

Thanks for wanting to help! *Deutsch weiter unten.*

## Ways to help
- **Report bugs** with the bug template. The dashboard's *"Create error report"* button bundles
  everything useful without secrets.
- **Suggest effects or games** with the idea template — the best ideas come from streams.
- **Send pull requests.** For bigger changes please open an issue first so we can agree on the approach.

## Development
- Node.js ≥ 22.13, no npm dependencies. `npm start` runs the server, `npm test` runs the full
  self-test against a simulated Twitch (about 4 minutes). It must stay green.
- Keep changes small and focused. CS2 behavior is protected by a reference test
  (`scripts/cs2-reference.mjs`) — if you change an effect on purpose, regenerate it with
  `node scripts/cs2-reference.mjs --write` and explain why in the PR.
- Input-related changes (AutoHotkey runner, focus handling) can only be verified on Windows —
  please say in the PR what you tested there.
- User-facing text goes into `locale/de.json` **and** `locale/en.json`.
- Safety first: no feature may send input outside the game window, run chat text as commands, or
  weaken the preset-import checks.

## License
By contributing you agree that your work is licensed under the GNU GPL v3.0 or later.

---

## Mitmachen (Deutsch)
- **Fehler** über die Vorlage „Bug report" melden — der Knopf „Fehlerbericht erstellen" im
  Dashboard bündelt alles Nötige ohne Geheimnisse.
- **Ideen** für Effekte oder Spiele über die Vorlage „Idee".
- **Pull Requests** gern; bei größeren Änderungen bitte vorher ein Issue öffnen.
- `npm test` muss grün bleiben, Texte immer in `locale/de.json` und `locale/en.json`.
- Mit einem Beitrag stimmst du zu, dass er unter der GPL v3.0 oder neuer steht.
