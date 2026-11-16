// Geführter Einrichtungs-Assistent.
//   npm run setup     alles Schritt für Schritt
//   npm run login     nur Twitch-Login
//   npm run rewards   nur Belohnungen abgleichen
//   npm run cs2       nur CS2-Dateien installieren
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  SCOPES, loadConfig, saveConfig, loadActions, saveTokens, ensureData, configExists, setActionEnabled, acknowledgeRisk,
} from '../src/config.js';
import { Twitch, TwitchError, looksLikeClientId, startDeviceFlow, pollDeviceFlow, validateToken } from '../src/twitch.js';
import { findCs2CfgDir, installCs2Files, cs2FilesInstalled } from '../src/cs2.js';
import { findAhk } from '../src/bridge.js';
import { syncRewards } from '../src/rewards.js';
import { runChecks, nodeOk, MIN_NODE } from './lib/checks.js';
import { c, say, ok, warn, fail, info, step, ask, confirm, openUrl, closeInput } from './lib/ui.js';

const mode = process.argv[2] || 'all';
const TOTAL = 6;

function banner() {
  say(c.purple(`
  ╔══════════════════════════════════════════════╗
  ║        CHAT CONTROL  ·  Einrichtung          ║
  ║   Zuschauer steuern dein Gameplay (CS2)      ║
  ╚══════════════════════════════════════════════╝`));
  say(c.dim('  Dauer: ca. 5 Minuten. Du kannst jederzeit mit Strg+C abbrechen und später weitermachen.\n'));
}

// ---------- Schritt 1: Voraussetzungen ----------
async function stepRequirements(cfg) {
  step(1, TOTAL, 'Voraussetzungen prüfen');
  if (!nodeOk()) {
    fail(`Node.js ${process.versions.node} ist zu alt. Benötigt wird ${MIN_NODE.join('.')} oder neuer (https://nodejs.org).`);
    process.exit(1);
  }
  ok(`Node.js ${process.versions.node}`);
  ok(process.platform === 'win32' ? 'Windows erkannt' : `${process.platform} erkannt`);
  if (process.platform !== 'win32') warn('Die Tasten-Effekte laufen nur unter Windows. Hier kannst du alles einrichten und im Simulationsmodus testen.');
  ensureData();

  // Verantwortung als Produktmerkmal: kein Start ohne diese Zustimmung,
  // einmalig mit Zeitstempel in der Config festgehalten statt nur angezeigt und vergessen.
  if (!cfg.consent.riskAcknowledgedAt) {
    say('');
    say('  ChaosCore führt jede festgelegte Aktion zuverlässig aus, bei jedem Spiel, das du einrichtest.');
    say('  Dass ein Anti-Cheat-System darauf reagiert (Sperre), kann ChaosCore nicht ausschließen –');
    say('  manche Spiele (z. B. CS2) sind dabei deutlich entspannter als andere.');
    say(`  ${c.b('Die Nutzung erfolgt auf eigenes Risiko.')}`);
    say('');
    if (!(await confirm('Stimmst du dem zu?', false))) {
      fail('Ohne diese Zustimmung kann ChaosCore nicht gestartet werden.');
      process.exit(1);
    }
    acknowledgeRisk(cfg);
    ok('Zustimmung gespeichert.');
  }
}

// ---------- Schritt 2: Twitch-Anwendung (Client-ID) ----------
async function askClientId(cfg, { firstTry }) {
  if (firstTry) {
    say('');
    say('  Damit sich das Programm bei Twitch anmelden darf, brauchst du eine eigene, kostenlose');
    say('  Twitch-Anwendung (einmalig, ca. 2 Minuten):');
    say('');
    say(`    1. Öffne ${c.cyan('https://dev.twitch.tv/console/apps')} und melde dich an`);
    say('       (Twitch verlangt dafür Zwei-Faktor-Authentifizierung).');
    say('    2. Klicke auf „Anwendung registrieren“.');
    say('    3. Name: etwas Einmaliges, z. B. „DeinName ChaosCore“.');
    say(`    4. OAuth-Umleitungs-URL: ${c.cyan('http://localhost')}`);
    say('    5. Kategorie: „Application Integration“.');
    say(`    6. Client-Typ: ${c.b('Öffentlich')} (Public).`);
    say('    7. „Erstellen“, dann bei deiner App „Verwalten“ klicken und die Client-ID kopieren.');
    say('');
    say(c.dim('  Wichtig: Deinen Stream-Key brauchst du hier NICHT. Gib ihn niemals irgendwo ein.'));
    say('');
    if (await confirm('Soll ich die Twitch-Entwicklerseite im Browser öffnen?', true)) openUrl('https://dev.twitch.tv/console/apps');
  }
  return ask('Füge hier deine Client-ID ein:', {
    def: cfg.twitch.clientId,
    validate: (v) => {
      if (/^live_/i.test(v)) return 'Das sieht nach einem STREAM-KEY aus! Bitte nicht eingeben. Du brauchst die Client-ID deiner Twitch-Anwendung.';
      if (!looksLikeClientId(v)) return 'Eine Client-ID hat genau 30 Zeichen (Buchstaben und Ziffern). Bitte nochmal kopieren.';
      return null;
    },
  });
}

// ---------- Schritt 3: Login ----------
async function stepLogin(cfg) {
  step(3, TOTAL, 'Bei Twitch einloggen');
  if (!cfg.twitch.clientId) { fail('Es fehlt die Client-ID. Starte "npm run setup".'); process.exit(1); }

  // Schon eingeloggt?
  const t = new Twitch(cfg);
  if (t.hasLogin() && mode !== 'login') {
    try {
      const v = await validateToken(await t.accessToken());
      if (SCOPES.split(' ').every((s) => v.scopes?.includes(s))) {
        ok(`Bereits eingeloggt als ${c.b(v.login)}.`);
        if (!(await confirm('Neu einloggen (z. B. anderer Kanal)?', false))) return t;
      }
    } catch { /* neu einloggen */ }
  }

  let clientId = cfg.twitch.clientId;
  let dev;
  for (;;) {
    try { dev = await startDeviceFlow(clientId); break; }
    catch (e) {
      fail(e.message);
      if (e.code === 'network') process.exit(1);
      clientId = await askClientId({ twitch: { clientId: '' } }, { firstTry: false });
      cfg.twitch.clientId = clientId;
      saveConfig(cfg);
    }
  }
  ok('Client-ID wurde von Twitch akzeptiert.');
  say('');
  say(`  Melde dich jetzt mit dem ${c.b('Twitch-Konto deines Kanals')} an (nicht mit einem Zweitkonto):`);
  say(`    1. Öffne ${c.cyan(dev.verification_uri)}`);
  say(`    2. Falls gefragt, gib diesen Code ein: ${c.b(c.purple(dev.user_code))}`);
  say('    3. Klicke auf „Autorisieren“.');
  say('');
  openUrl(dev.verification_uri);
  process.stdout.write('  Warte auf deine Bestätigung ');
  let tokens;
  try {
    tokens = await pollDeviceFlow(clientId, dev, { onWait: () => process.stdout.write('.') });
  } catch (e) {
    say('');
    fail(e.message);
    process.exit(1);
  }
  say('');
  const v = await validateToken(tokens.accessToken);
  saveTokens(tokens);
  cfg.twitch = { clientId, userId: v.user_id, login: v.login };
  saveConfig(cfg);
  ok(`Eingeloggt als ${c.b(v.login)}.`);
  const tw = new Twitch(cfg);
  try {
    const me = await tw.getMe();
    // Seit Mai 2026 öffnet Twitch Kanalpunkte UND Bits für jeden Kanal, unabhängig vom
    // Affiliate-/Partner-Status - diese Meldung war vorher irreführend hart.
    if (!me.broadcaster_type) ok('Kanalpunkte & Bits einsatzbereit (kein Affiliate/Partner nötig).');
    else ok(`Kanalstatus: ${me.broadcaster_type}`);
  } catch (e) { warn(`Kanalstatus nicht prüfbar: ${e.message}`); }
  return tw;
}

// ---------- Schritt 4: CS2 und Tasten-Steuerung ----------
async function stepCs2(cfg) {
  step(4, TOTAL, 'CS2 und Tasten-Steuerung verbinden');

  let dir = cfg.game.cs2CfgDir || findCs2CfgDir();
  if (dir) ok(`CS2-Ordner gefunden: ${dir}`);
  else {
    warn('Ich habe deinen CS2-Ordner nicht automatisch gefunden.');
    info('Er endet auf …\\Counter-Strike Global Offensive\\game\\csgo\\cfg');
    const given = await ask('Pfad zum cfg-Ordner (leer = später):', {
      validate: (v) => (!v || fs.existsSync(v) ? null : 'Diesen Ordner gibt es nicht.'),
    });
    dir = given || null;
  }
  // Deine Einstellungen, damit Blick-Effekt und Blendgranate passen
  say('');
  info('Für den Effekt "UNKNOWN entdeckt dich" (Blick nach oben) brauche ich deine CS2-Mausempfindlichkeit.');
  info('Du findest sie in der CS2-Konsole mit dem Befehl: sensitivity');
  const sens = await ask('Deine CS2-Sensitivity:', {
    def: String(cfg.game.sensitivity || 1),
    validate: (v) => (Number(v.replace(',', '.')) > 0 && Number(v.replace(',', '.')) <= 30 ? null : 'Bitte eine Zahl größer als 0 eingeben, z. B. 1.2'),
  });
  cfg.game.sensitivity = Number(sens.replace(',', '.'));
  const flashKey = await ask('Auf welcher Taste liegt deine Blendgranate (Flashbang)?', {
    def: cfg.keys.flash || '7',
    validate: (v) => (/^[A-Za-z0-9]{1,20}$/.test(v) ? null : 'Nur Buchstaben/Ziffern, z. B. 7 oder x'),
  });
  cfg.keys.flash = flashKey;
  saveConfig(cfg);
  ok(`Sensitivity ${cfg.game.sensitivity}, Blendgranate auf Taste ${cfg.keys.flash}.`);

  if (dir) {
    const already = cs2FilesInstalled(dir);
    const complete = already.gsi && already.binds && already.autoexec;
    const needs = !complete || !already.current;
    if (!needs) ok('CS2-Dateien sind bereits installiert und aktuell.');
    else if (await confirm(complete ? 'Die CS2-Dateien sind veraltet (neue Maus-Sperre u. a.). Jetzt aktualisieren?' : 'Jetzt die CS2-Dateien (Spielstatus-Anbindung und Tasten-Binds) installieren?', true)) {
      installCs2Files(dir, cfg.server.port, cfg.server.gsiToken, cfg.game, cfg.keys);
      ok('Installiert. Starte CS2 neu (oder tippe einmal in die Konsole: exec unknown_chat_control).');
      info('Die internen Binds nutzen Nummernblock-Tasten (Numpad 1-5, 7-9 und / * - +). Belege diese im Spiel nicht anderweitig.');
    }
    cfg.game.cs2CfgDir = dir;
    saveConfig(cfg);
  }

  if (process.platform === 'win32') {
    if (findAhk(cfg.bridge.ahkPath)) ok('AutoHotkey v2 ist installiert.');
    else {
      warn('AutoHotkey v2 fehlt. Ohne laufen die Effekte nur als Simulation.');
      if (await confirm('Jetzt mit winget installieren?', true)) {
        const r = spawnSync('winget', ['install', '-e', '--id', 'AutoHotkey.AutoHotkey', '--accept-package-agreements', '--accept-source-agreements'], { stdio: 'inherit', shell: true });
        if (r.status === 0 && findAhk(cfg.bridge.ahkPath)) ok('AutoHotkey v2 installiert.');
        else warn('Das hat nicht geklappt. Lade AutoHotkey v2 manuell von https://www.autohotkey.com und starte dann "npm run doctor".');
      }
    }
  }
}

// ---------- Schritt 5: Belohnungen ----------
async function stepRewards(twitch, { ask: doAsk = true } = {}) {
  step(5, TOTAL, 'Belohnungen auf Twitch anlegen');
  let actions = loadActions();
  const legacy = actions.list.filter((a) => a.legacy);
  if (doAsk && legacy.some((a) => !a.enabled)) {
    say(`  Zusätzlich gibt es ${legacy.length} „alte“ Belohnungen (${legacy.map((a) => a.title).join(', ')}).`);
    if (await confirm('Diese auch anlegen?', false)) {
      for (const a of legacy) setActionEnabled(a.id, true);
      actions = loadActions();
      info('Hast du genau diese Belohnungen früher von Hand auf Twitch angelegt? Dann lösche die alten dort zuerst, sonst meldet Twitch doppelte Namen.');
    }
  }
  const active = actions.list.filter((a) => a.enabled);
  say('');
  for (const a of active) say(`    ${String(a.cost).padStart(4)}  ${a.title}`);
  say('');
  if (!(await confirm(`${active.length} Belohnungen jetzt auf Twitch anlegen/aktualisieren?`, true))) { info('Übersprungen. Später: npm run rewards'); return; }
  const res = await syncRewards(twitch, actions);
  for (const r of res.filter((x) => x.state !== 'übersprungen')) {
    if (r.state === 'fehler') fail(`${r.title}: ${r.message}`);
    else ok(`${r.title} (${r.cost}): ${r.state}`);
  }
  if (res.some((r) => r.state === 'fehler')) warn('Einige Belohnungen konnten nicht angelegt werden. Behebe das und starte "npm run rewards" nochmal.');
}

// ---------- Schritt 6: Abschluss ----------
async function stepFinish(cfg) {
  step(6, TOTAL, 'Abschlusscheck');
  const res = await runChecks();
  for (const r of res) {
    (r.level === 'ok' ? ok : r.level === 'warn' ? warn : fail)(r.label);
    if (r.hint && r.level !== 'ok') info('→ ' + r.hint);
  }
  const base = `http://localhost:${cfg.server.port}`;
  say(`
  ${c.green('Fertig!')} So geht es weiter:

    ${c.b('1. Starten:')}        ${process.platform === 'win32' ? 'start.bat doppelklicken' : 'npm start'}
    ${c.b('2. Overlay in OBS:')} Quelle → Browser → ${c.cyan(base + '/overlay')}  (1920×1080)
    ${c.b('3. Dashboard:')}      öffnet sich beim Start automatisch (erneut: npm run dashboard)
    ${c.b('4. Testen:')}         im Dashboard bei einer Aktion auf „Trocken“ klicken

  ${c.dim('Not-Aus im Spiel: ' + cfg.bridge.panicHotkey + '  ·  Probleme? „npm run doctor“')}
`);
}

// ---------- Ablauf ----------
async function main() {
  if (!configExists()) saveConfig(loadConfig()); // legt Standardwerte und Tokens an
  const cfg = loadConfig();
  try {
    if (mode === 'login') { await stepLogin(cfg); return; }
    if (mode === 'rewards') {
      const tw = new Twitch(cfg);
      if (!tw.hasLogin()) { fail('Du bist nicht eingeloggt. Führe zuerst "npm run login" aus.'); process.exit(1); }
      await stepRewards(tw, { ask: false });
      return;
    }
    if (mode === 'cs2') { await stepCs2(cfg); return; }

    banner();
    await stepRequirements(cfg);

    step(2, TOTAL, 'Twitch-Anwendung (Client-ID)');
    const existing = looksLikeClientId(cfg.twitch.clientId);
    if (existing) ok(`Client-ID bereits eingetragen (${cfg.twitch.clientId.slice(0, 6)}…).`);
    if (!existing || (await confirm('Andere Client-ID verwenden?', false))) {
      cfg.twitch.clientId = await askClientId(cfg, { firstTry: true });
      saveConfig(cfg);
    }

    const twitch = await stepLogin(cfg);
    await stepCs2(cfg);
    await stepRewards(twitch);
    await stepFinish(cfg);

    if (await confirm('ChaosCore jetzt starten?', true)) {
      closeInput();
      await import('../src/server.js');
      return; // Server hält den Prozess am Leben
    }
  } catch (e) {
    if (e.message === 'EOF') { say(''); fail('Eingabe beendet. Starte "npm run setup" einfach erneut, bereits erledigte Schritte werden übersprungen.'); process.exit(1); }
    if (e instanceof TwitchError) { fail(e.message); process.exit(1); }
    throw e;
  }
  closeInput();
}

await main();
if (mode !== 'all') process.exit(0);
