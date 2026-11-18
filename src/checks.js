// Gemeinsame Prüfungen für "npm run doctor"/den Terminal-Assistenten UND das Einrichtungsfenster
// der fertigen exe (kein Terminal dort!). Die Hinweise unterscheiden sich deshalb je nach `mode`:
// 'cli' nennt npm-Befehle (Entwickler/Terminal-Nutzung), 'gui' verweist auf die passende Stelle im
// Einrichtungsfenster bzw. Dashboard - siehe nach dem ersten echten Test der
// 1.0-exe: ein npm-Befehl ist für jemanden, der nur die exe hat, nicht ausführbar.
import net from 'node:net';
import { loadConfig, loadActions, loadRewardMap, loadTokens, tokensProtected, SCOPES, ACCESS_SCOPES, configExists } from './config.js';
import { cryptoAvailable } from './secret-store.js';
import { Twitch, validateToken, looksLikeClientId } from './twitch.js';
import { findCs2CfgDir, cs2FilesInstalled } from './cs2.js';
import { findAhk } from './bridge.js';
import { getProfile } from './games/index.js';

export const MIN_NODE = [22, 13];
export function nodeOk() {
  const [ma, mi] = process.versions.node.split('.').map(Number);
  return ma > MIN_NODE[0] || (ma === MIN_NODE[0] && mi >= MIN_NODE[1]);
}

function portBusy(port, host) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', (e) => resolve(e.code === 'EADDRINUSE'));
    s.once('listening', () => s.close(() => resolve(false)));
    s.listen(port, host);
  });
}

// liefert [{level: 'ok'|'warn'|'fail', label, hint?}]
export async function runChecks(mode = 'cli') {
  const gui = mode === 'gui';
  const hint = (cli, g) => (gui ? g : cli);
  const out = [];
  const add = (level, label, h) => out.push({ level, label, hint: h });

  if (nodeOk()) add('ok', `Node.js ${process.versions.node}`);
  else add('fail', `Node.js ${process.versions.node} ist zu alt`, `Installiere Node.js ${MIN_NODE.join('.')} oder neuer (https://nodejs.org).`);

  if (!configExists()) { add('fail', 'Noch nicht eingerichtet', hint('Führe "npm run setup" aus.', 'Starte das Programm neu - das Einrichtungsfenster öffnet sich automatisch.')); return out; }
  const cfg = loadConfig();

  // Verantwortung als Produktmerkmal: ohne diese Zustimmung startet das
  // Programm gar nicht erst (siehe readiness() in server.js) - wenn dieser Check überhaupt läuft,
  // ist sie also eigentlich immer vorhanden; trotzdem hier sichtbar, nicht nur stillschweigend.
  if (cfg.consent.riskAcknowledgedAt) add('ok', `Zustimmung zur Eigenverantwortung gegeben (${cfg.consent.riskAcknowledgedAt})`);
  else add('fail', 'Zustimmung zur Eigenverantwortung fehlt', hint('Führe "npm run setup" aus.', 'Öffne das Einrichtungsfenster und setze den Haken.'));

  if (looksLikeClientId(cfg.twitch.clientId)) add('ok', 'Twitch-Client-ID eingetragen');
  else { add('fail', 'Twitch-Client-ID fehlt oder ist ungültig', hint('Führe "npm run setup" aus.', 'Öffne das Einrichtungsfenster und trage deine Client-ID ein.')); return out; }

  const twitch = new Twitch(cfg);
  let loggedIn = false;
  if (!loadTokens()) add('fail', 'Nicht bei Twitch eingeloggt', hint('Führe "npm run login" aus.', 'Öffne das Einrichtungsfenster und melde dich bei Twitch an.'));
  else {
    if (cryptoAvailable()) add(tokensProtected() ? 'ok' : 'warn', tokensProtected() ? 'Twitch-Login verschlüsselt gespeichert (Windows-Benutzerkonto)' : 'Twitch-Login liegt unverschlüsselt vor - wird beim nächsten Speichern verschlüsselt');
    try {
      const v = await validateToken(await twitch.accessToken());
      const missing = SCOPES.split(' ').filter((s) => !v.scopes?.includes(s));
      if (missing.length) add('fail', `Dem Login fehlen Rechte (${missing.join(', ')})`, hint('Führe "npm run login" aus.', 'Öffne das Einrichtungsfenster und melde dich erneut an.'));
      else {
        add('ok', `Twitch-Login gültig (${v.login})`); loggedIn = true;
        // diese drei Scopes sind optional - ohne sie läuft ChaosCore
        // normal weiter, nur Zugriffsregeln ("Nur Abonnenten/VIPs/Moderatoren") greifen dann nie.
        const missingAccess = ACCESS_SCOPES.split(' ').filter((s) => !v.scopes?.includes(s));
        if (missingAccess.length) add('warn', `Zugriffsregeln (Abo/VIP/Mod) brauchen zusätzliche Rechte (${missingAccess.join(', ')})`, hint('Nur nötig, falls du "Nur Abonnenten/VIPs/Moderatoren" bei einer Aktion nutzt - dann "npm run login" erneut ausführen.', 'Nur nötig, falls du „Nur Abonnenten/VIPs/Moderatoren" bei einer Aktion nutzt - dann im Einrichtungsfenster erneut anmelden.'));
      }
    } catch (e) {
      add(e.code === 'network' ? 'warn' : 'fail', `Twitch-Login: ${e.message}`, e.code === 'network' ? 'Internetverbindung prüfen.' : hint('Führe "npm run login" aus.', 'Öffne das Einrichtungsfenster und melde dich erneut an.'));
    }
  }

  const profile = getProfile(cfg.game.profile);
  let actions = null;
  try {
    actions = loadActions(cfg.game.profile);
    // loadActions() hat ungültige Aktionen schon deaktiviert und begründet (config.js: markInvalid).
    const bad = actions.list.filter((a) => a.invalid && a.enabledInFile).map((a) => [a, a.invalid]);
    if (bad.length) for (const [a, e] of bad) add('fail', `Aktion "${a.title}" ist ungültig: ${e}`, 'Korrigiere die Aktionen-Datei.');
    else add('ok', `${actions.list.filter((a) => a.enabled).length} Aktionen aktiv (${profile.name}), alle Effekte gültig`);
  } catch (e) { add('fail', `Aktionen-Datei: ${e.message}`); }

  if (loggedIn && actions) {
    try {
      const me = await twitch.getMe();
      // Seit Mai 2026 öffnet Twitch Kanalpunkte UND Bits für jeden Kanal von der ersten Sekunde an -
      // Affiliate/Partner ist dafür nicht (mehr) nötig, nur noch für Auszahlungen in bar (für
      // ChaosCore ohne Bedeutung). Deshalb hier bewusst kein Warn-/Fail-Status mehr -
      // dass jeder Kanal Kanalpunkte nutzen kann, ist gerade der Punkt, nicht eine Einschränkung.
      add('ok', me.broadcaster_type ? `Kanalstatus: ${me.broadcaster_type}` : 'Kanalpunkte & Bits einsatzbereit (kein Affiliate/Partner nötig)');
      const list = await twitch.listRewards();
      const ids = new Set(list.map((r) => r.id));
      const map = loadRewardMap();
      const want = actions.list.filter((a) => a.enabled);
      const linked = new Set(Object.entries(map).filter(([rid]) => ids.has(rid)).map(([, aid]) => aid));
      const missing = want.filter((a) => !linked.has(a.id));
      if (!missing.length) add('ok', `${want.length} Belohnungen auf Twitch verbunden`);
      // Kanalpunkte-Belohnungen anlegen geht seit Mai 2026 unabhängig vom Affiliate-Status - dieser
      // Hinweis gilt also für jeden Kanal, nicht nur für Affiliates/Partner.
      else add('warn', `${missing.length} Belohnung(en) fehlen auf Twitch: ${missing.map((a) => a.title).join(', ')}`, hint('Führe "npm run rewards" aus.', 'Öffne das Einrichtungsfenster oder klicke im Dashboard auf „Belohnungen mit Twitch abgleichen".'));
    } catch (e) { add('warn', `Belohnungen nicht prüfbar: ${e.message}`); }
  }

  if (cfg.game.profile === 'cs2') {
    const dir = cfg.game.cs2CfgDir || findCs2CfgDir();
    if (!dir) add('warn', 'CS2-Ordner nicht gefunden', hint('Führe "npm run cs2" aus und gib den Pfad an.', 'Öffne das Einrichtungsfenster und gib den Pfad an.'));
    else {
      const f = cs2FilesInstalled(dir);
      if (f.gsi && f.binds && f.autoexec && f.current) add('ok', 'CS2-Dateien installiert und aktuell (GSI und Binds)');
      else if (f.gsi && f.binds && f.autoexec) add('warn', f.gsiCurrent ? 'CS2-Dateien sind veraltet (Maus-Sperre und neue Effekte brauchen die neuen Binds)' : 'CS2-Spielzustand-Datei ist veraltet (Session Stats brauchen die neue Datei; danach CS2 neu starten)', hint('Führe "npm run cs2" aus.', 'Öffne das Einrichtungsfenster und klicke auf „Speichern und CS2-Dateien installieren".'));
      else add('warn', 'CS2-Dateien fehlen oder sind unvollständig', hint('Führe "npm run cs2" aus.', 'Öffne das Einrichtungsfenster und klicke auf „Speichern und CS2-Dateien installieren".'));
    }
  } else if (!profile.supportsGsi) {
    add('ok', `${profile.name}: keine Spielzustand-Schnittstelle nötig (läuft im blinden Modus)`);
  }

  if (process.platform === 'win32') {
    const p = findAhk(cfg.bridge.ahkPath);
    if (p) add('ok', 'AutoHotkey v2 gefunden');
    else add('warn', 'AutoHotkey v2 fehlt (Effekte laufen nur als Simulation)', hint('Führe "npm run setup" aus oder installiere es: winget install AutoHotkey.AutoHotkey', 'Öffne das Einrichtungsfenster und klicke auf „AutoHotkey jetzt installieren".'));
  } else add('warn', 'Kein Windows: Effekte laufen nur als Simulation');

  if (await portBusy(cfg.server.port, cfg.server.host)) add('ok', `Port ${cfg.server.port} ist belegt (läuft ChaosCore schon?)`);
  else add('ok', `Port ${cfg.server.port} ist frei`);
  return out;
}
