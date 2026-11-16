# GSI-Fixtures für Session Stats

`synthetic-*.jsonl` sind **nachgebaute** Pakete nach dem dokumentierten GSI-Format (eine Zeile je
Paket: `{ "t": ms, "body": { ... } }`). Sie prüfen die Zähl-Logik, beweisen aber nicht, dass echtes
CS2 genau so sendet.

Echte Aufzeichnungen (Dashboard → System → „Spielzustand aufzeichnen") gehören als `real-*.jsonl`
hierher, sobald welche von einem echten CS2 unter Windows vorliegen; der Test spielt jede Datei in
diesem Ordner ab, zu der es eine `*.expect.json` gibt.
