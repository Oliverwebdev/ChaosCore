// Wenn das Programm ohne Konsolenfenster läuft (Start über die .exe), kann das Schreiben nach stdout/stderr
// in seltenen Fällen fehlschlagen. Ausgaben dürfen das Programm niemals zum Absturz bringen.
for (const m of ['log', 'info', 'warn', 'error', 'debug']) {
  const orig = console[m].bind(console);
  console[m] = (...a) => { try { orig(...a); } catch { /* keine Konsole: ignorieren */ } };
}
