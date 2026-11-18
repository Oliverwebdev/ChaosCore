// Startpunkt: verbindet Twitch, CS2-GSI, Engine, Overlay und Dashboard.
import './safe-console.js';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, DATA, configExists, loadConfig, saveConfig, loadActions, loadRewardMap, setActionEnabled, setActionCost, addAction, removeAction, applyOverlayConfig, applyOverlayLayout, exportProfile, importProfile, previewImport, SCOPES, loadBitsActions, setBitsActionEnabled, setBitsActionCost, addBitsAction, removeBitsAction, applyGameProfile, setOverlayAsset, removeOverlayAsset, readOverlayAsset, applyCommunityGoal, applyAutoIdle, setActionAccess, setBitsActionAccess, ACCESS_LEVELS, applyQueuePolicy, safeConfigSnapshot, applySeasonConfig, applyChatSettings, addChatCommand, removeChatCommand, setChatCommandEnabled, keyPolicy, applyCriticalKeys, pendingCriticalKeys, applyStatsConfig, applyOverlayHidden, applyUpdateChannel, applyBitsMenu, applyBitsCredit, applyOverlayStyles, applyModeLock, CS2_MODES, setViewerBlocked, updateAction, copyAction, restoreAction, defaultAction, exportEffect, importEffect, applyHighlights } from './config.js';
import { BITS_MENU_TEMPLATES } from './bits-menu.js';
import { getProfile, profileIds } from './games/index.js';
import { CRITICAL_KEY_NAMES } from './keys.js';
import { createGsiRecorder } from './gsi-recorder.js';
import { looksLikeClientId } from './twitch.js';
import { Twitch, validateToken } from './twitch.js';
import { openDb } from './db.js';
import { GameState } from './gsi.js';
import { createBridge } from './bridge.js';
import { Engine } from './engine.js';
import { SessionStats } from './session-stats.js';
import { syncRewards, syncOne, deleteRewardFor, explain } from './rewards.js';
import { validateAction, compile } from './steps.js';
import { buildEffect, normalizeSpec, describeSpec, describeAction, BUILDER_KEYS, BUILDER_KEY_LABELS, BUILDER_MODES, BUILDER_MAX_STEPS, BUILDER_MAX_TOTAL_MS, BUILDER_MAX_REPEAT } from './effect-builder.js';
import { hasGameEffect } from './validate.js';
import { Highlights } from './highlights.js';
import { openDashboard } from './util.js';
import { Setup, openExternal } from './setup-core.js';
import { findCs2CfgDir, installCs2Files, cs2FilesInstalled } from './cs2.js';
import { runChecks } from './checks.js';
import { stringsFor, normalizeLocale } from './i18n.js';
import { checkForUpdate, installedVersion, isPrerelease, installInfo, downloadVerified, launchInstaller } from './update-check.js';
import { product } from './product.js';
import { createShortcuts, relaunchSelf } from './shortcuts.js';
import * as logger from './log.js';
import { getLicenseState } from './license.js';

const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
// Build-Kennung (build/build-win.mjs --build=...): nur in einem gebauten Paket vorhanden. Zeigt im
// Dashboard und im Fehlerbericht, aus welchem Quellcode-Stand genau diese Installation stammt.
let buildInfo = null;
try {
  const b = JSON.parse(fs.readFileSync(path.join(ROOT, 'build.json'), 'utf8'));
  if (typeof b.build === 'string' && typeof b.commit === 'string') buildInfo = { build: b.build.slice(0, 40), commit: b.commit.slice(0, 40), builtAt: String(b.builtAt || '').slice(0, 30) };
} catch { /* kein build.json: Start aus dem Quellcode */ }
// Update-Prüfung höchstens alle 10 Minuten wirklich bei GitHub nachfragen (ohne Anmeldung erlaubt
// GitHub 60 Anfragen pro Stunde).
let lastUpdateCheck = null;
let updateJob = { phase: 'idle' };
async function updateCheck(cfg, force = false) {
  if (!force && lastUpdateCheck && Date.now() - lastUpdateCheck.at < 10 * 60 * 1000) return lastUpdateCheck.result;
  const current = installedVersion(pkgVersion, buildInfo);
  const pref = cfg.updates?.channel || 'auto';
  const channel = pref === 'auto' ? (isPrerelease(current) ? 'beta' : 'stable') : pref;
  const result = await checkForUpdate(product.githubRepo, current, { channel, requireSignature: product.releaseKeys.length > 0 });
  const inst = installInfo(ROOT, `${product.name}.exe`);
  Object.assign(result, { channelSetting: pref, canInstall: inst.canInstall, installBlocked: inst.canInstall ? null : inst.reason, signatureCheck: product.releaseKeys.length > 0 });
  lastUpdateCheck = { at: Date.now(), result };
  return result;
}
// Fürs Dashboard ohne die Download-Adressen.
const publicUpdate = ({ setup, sums, sig, ...rest }) => ({ ...rest, size: setup?.size || null });
const WEB = path.join(ROOT, 'web');
const PAGES = { '/overlay': 'overlay.html', '/dashboard': 'dashboard.html', '/setup': 'setup.html' };
const ASSETS = { '/favicon.svg': ['web/favicon.svg', 'image/svg+xml'], '/icon.png': ['assets/icon.png', 'image/png'], '/i18n.js': ['web/i18n.js', 'text/javascript; charset=utf-8'] };
const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'self'";
const PRESETS_DIR = path.join(ROOT, 'config', 'presets');

// One-Click-Setups: eine kleine, mitgelieferte Auswahl fertiger
// Presets (Dateien, kein Code) liegt in config/presets/ - jede Datei dieselbe Form wie ein
// exportiertes Profil (siehe config.js: exportProfile), mit zusätzlichen preset.name/author/
// description/targetGame-Metadaten fürs Dashboard. Wird bei jeder Anfrage frisch gelesen (es sind
// wenige, kleine Dateien) statt beim Start zwischengespeichert - ein neues Preset in diesem Ordner
// braucht darum keinen Neustart.
function listBundledPresets() {
  let files;
  try { files = fs.readdirSync(PRESETS_DIR).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, f), 'utf8'));
      if (data.schema !== 1 || !data.preset?.name) continue;
      out.push({ id: f.replace(/\.json$/, ''), name: data.preset.name, author: data.preset.author || null, description: data.preset.description || '', targetGame: data.game?.profile || 'cs2' });
    } catch { /* eine kaputte Preset-Datei überspringen statt die ganze Liste scheitern zu lassen */ }
  }
  return out;
}

// Unterscheidet den Umschlag { preset, accept } vom Preset selbst. Ein Preset hat immer "schema"
// und trägt seine Metadaten ebenfalls unter "preset" ({ name, author }) - deshalb reicht es nicht,
// nur auf das Feld "preset" zu schauen.
function isImportEnvelope(body) {
  return !!body && typeof body === 'object' && body.schema === undefined && !!body.preset && typeof body.preset === 'object' && !Array.isArray(body.preset);
}

function readBundledPreset(id) {
  if (!/^[a-z0-9_-]{1,40}$/i.test(String(id || ''))) throw new Error('Unbekanntes Preset.');
  const file = path.join(PRESETS_DIR, `${id}.json`);
  if (!fs.existsSync(file)) throw new Error('Unbekanntes Preset.');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function readBody(req, limit = 262144) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Anfrage zu groß'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(Object.assign(new Error('Ungültiges JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function die(msg) {
  console.error(`\n\x1b[31m✖ ${msg}\x1b[0m\n`);
  process.exit(1);
}

const flag = (n) => process.argv.includes(n) || process.env[`UCC_${n.slice(2).replace('-', '_').toUpperCase()}`] === '1';

// Alles, was nur läuft, wenn die Einrichtung abgeschlossen ist (Twitch, Engine, Effekte).
const rt = { ready: false, twitch: null, engine: null, bridge: null, db: null, actions: null, rewardMap: {}, reason: '' };
const gsi = new GameState();
const gsiRecorder = createGsiRecorder(DATA, logger); // echte GSI-Pakete aufzeichnen

// Prüft, ob die Einrichtung fertig ist. Netzwerkprobleme gelten nicht als "nicht eingerichtet".
async function readiness(cfg) {
  // Verantwortung als Produktmerkmal: ohne diese Zustimmung kein Start,
  // geprüft noch vor der Twitch-Verbindung - das Setup-Fenster zeigt den Hinweis in Schritt 1.
  if (!cfg.consent.riskAcknowledgedAt) return { ok: false, reason: 'Die Zustimmung zur Eigenverantwortung fehlt noch.' };
  if (!looksLikeClientId(cfg.twitch.clientId)) return { ok: false, reason: 'Die Twitch-Client-ID fehlt.' };
  const twitch = new Twitch(cfg);
  if (!twitch.hasLogin()) return { ok: false, reason: 'Du bist noch nicht bei Twitch angemeldet.' };
  twitch.on('clientType', (t) => { if (cfg.twitch.clientType !== t) { cfg.twitch.clientType = t; saveConfig(cfg); } });
  try {
    const v = await validateToken(await twitch.accessToken());
    const missing = SCOPES.split(' ').filter((x) => !v.scopes?.includes(x));
    if (missing.length) return { ok: false, reason: `Dem Login fehlen Rechte (${missing.join(', ')}).` };
    if (v.user_id !== cfg.twitch.userId) { cfg.twitch.userId = v.user_id; cfg.twitch.login = v.login; saveConfig(cfg); }
  } catch (e) {
    if (e.code === 'network') { logger.warn(`${e.message} Starte trotzdem, Twitch wird automatisch erneut versucht.`); return { ok: true, offline: true }; }
    // Schon einmal komplett eingerichtet, nur der Login ist abgelaufen: trotzdem ins Dashboard -
    // dort gibt es die schnelle Neu-Anmeldung. Die volle Einrichtung nur, wenn wirklich etwas fehlt.
    if (cfg.twitch.userId && (e.code === 'auth_failed' || e.code === 'invalid_token' || e.status === 400 || e.status === 401)) {
      logger.warn(`Twitch-Login abgelaufen (${e.message}) - starte trotzdem, Neu-Anmeldung im Dashboard.`);
      return { ok: true, relogin: true };
    }
    return { ok: false, reason: e.message };
  }
  return { ok: true };
}

async function main() {
  // VOR jedem Config-/Datenzugriff prüfen, damit eine
  // abgelaufene Testversion den Start klar verweigert, ohne überhaupt erst Daten anzufassen
  // (kein Datenverlust).
  const license = getLicenseState();
  if (license.expired) {
    die(`Diese Testversion ist am ${new Date(license.expiresAt).toLocaleDateString('de-DE')} abgelaufen und kann nicht mehr gestartet werden. Keine Daten wurden dabei verändert.`);
    return;
  }
  if (!configExists()) saveConfig(loadConfig()); // legt Standardwerte und die geheimen Tokens an
  const cfg = loadConfig();

  // Sprache einmalig vom Installer übernehmen: der Installer fragt beim Einrichten danach und
  // legt daneben eine "locale.txt" ab (siehe build/installer.nsi). Nur beim allerersten Start
  // lesen, damit ein späterer manueller Wechsel (Dashboard) nicht wieder überschrieben wird.
  if (!cfg.server.localeSet) {
    try { cfg.server.locale = normalizeLocale(fs.readFileSync(path.join(ROOT, 'locale.txt'), 'utf8')); }
    catch { /* kein Installer-Marker (z. B. Entwickler-Start/portabel ohne Installer) - bleibt Deutsch */ }
    cfg.server.localeSet = true;
    saveConfig(cfg);
  }

  const setup = new Setup();
  const quiet = flag('--minimized');

  // ---------- HTTP ----------
  const clients = new Set();
  const push = (obj) => {
    const line = `data: ${JSON.stringify(obj)}\n\n`;
    for (const res of clients) { try { res.write(line); } catch { clients.delete(res); } }
  };
  setInterval(() => { for (const res of clients) { try { res.write(': ka\n\n'); } catch { clients.delete(res); } } }, 15000).unref();
  gsi.on('change', () => rt.engine?.emitState());
  setInterval(() => gsi.tick(), 5000).unref();

  const allowedHosts = new Set([`127.0.0.1:${cfg.server.port}`, `localhost:${cfg.server.port}`, `[::1]:${cfg.server.port}`]);
  if (cfg.server.host !== '127.0.0.1' && cfg.server.host !== 'localhost') allowedHosts.add(`${cfg.server.host}:${cfg.server.port}`);

  const json = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  // gemeinsamer Kern für /api/diagnostics
  // (ohne Freitext, bestehendes Verhalten, vom bestehenden Test geprüft) und das neue
  // /api/report (mit Freitext "was ist passiert?") - beide bündeln Systeminfo, Status, die
  // letzten Protokoll-Zeilen und die aktive Konfiguration ohne Geheimnisse in eine Datei.
  const buildDiagnostics = async () => {
    const checks = await runChecks('gui');
    const reverse = new Set(Object.values(rt.rewardMap));
    return {
      product: { name: cfg.overlay.brand, version: pkgVersion, build: buildInfo },
      system: { node: process.versions.node, platform: process.platform, arch: process.arch, uptimeSec: Math.round(process.uptime()) },
      checks,
      twitch: { status: rt.twitch.status, login: cfg.twitch.login, clientType: cfg.twitch.clientType || null }, // bewusst ohne userId/Token
      bridge: { kind: rt.bridge.kind },
      gsi: { connected: gsi.get().connected, live: gsi.get().live },
      actions: { total: rt.actions.list.length, enabled: rt.actions.list.filter((a) => a.enabled).length, linked: [...reverse].length },
      config: safeConfigSnapshot(cfg), // ohne Geheimnisse - geprüft vom bestehenden Diagnose-Test
      recentLog: logger.tail(300), // von der Festplatte, nicht nur dem Speicher-Puffer (steht auch nach einem Neustart noch)
    };
  };

  // Alles, was der Effekt-Editor über eine Aktion wissen muss.
  const editInfo = (a) => ({
    id: a.id, title: a.title, cost: a.cost, enabled: !!a.enabled, custom: !!a.custom, access: a.access || 'everyone', invalid: a.invalid || null,
    prompt: a.prompt || '', flavor: a.flavor || '', color: a.color || null, cooldownSec: a.cooldownSec ?? null, onDeath: a.onDeath || 'stop',
    phase: (a.requires || ['live']).includes('live') ? 'live' : 'any', builder: a.builder || null, customEffect: !!a.customEffect,
    describe: describeAction(a, cfg.server.locale), special: !!(a.effect?.dynamic || a.effect?.overlay),
  });
  // Bauplan aus dem Editor prüfen und in Schritte übersetzen (wirft mit verständlichem Text).
  // self: die gerade bearbeitete Aktion. Enthält sie sich selbst als Baustein ("Vorhandener Effekt"),
  // gilt ihr Auslieferungszustand - sonst würde der Ablauf bei jedem Speichern länger.
  const buildChecked = (spec, self = null) => {
    const actionsById = new Map([...rt.actions.list, ...rt.bitsActions.list].map((a) => [a.id, a]));
    if (self && normalizeSpec(spec).blocks.some((b) => b.mode === 'original' && b.from === self.id)) {
      const d = defaultAction(self.kind, self.id, cfg.game.profile);
      if (!d) throw new Error('Ein eigener Effekt kann sich nicht selbst als Baustein enthalten.');
      actionsById.set(self.id, d);
    }
    const built = buildEffect(spec, { profile: cfg.game.profile, actions: actionsById });
    const err = validateAction({ effect: built.effect }, cfg.keys, keyPolicy(cfg));
    if (err) throw new Error(`Der Baukasten hat einen ungültigen Effekt erzeugt: ${err}`);
    return { built, text: describeSpec(spec, { actions: actionsById }, cfg.server.locale) };
  };
  const reloadPoints = () => { rt.actions = loadActions(cfg.game.profile); rt.engine.setActions(rt.actions); };
  const reloadBits = () => { rt.bitsActions = loadBitsActions(); rt.engine.setBitsActions(rt.bitsActions); };

  const status = () => {
    if (!rt.ready) return { setup: true, reason: rt.reason };
    const reverse = new Set(Object.values(rt.rewardMap));
    return {
      state: rt.engine.publicState(),
      twitch: { status: rt.twitch.status, login: cfg.twitch.login, clientType: cfg.twitch.clientType || null },
      bridge: { kind: rt.bridge.kind, note: rt.bridge.note, panicHotkey: cfg.bridge.panicHotkey, failHotkey: cfg.bridge.failHotkey },
      gsi: gsi.get(),
      actions: rt.actions.list.map((a) => ({ ...editInfo(a), category: a.category, legacy: !!a.legacy, linked: reverse.has(a.id), untilStop: false })),
      categories: Object.keys(rt.actions.categories),
      templates: rt.actions.list.filter(hasGameEffect).map((a) => ({ id: a.id, title: a.title })),
      builder: { keys: BUILDER_KEYS, keyLabels: BUILDER_KEY_LABELS, modes: BUILDER_MODES.filter((m) => !m.game || m.game === cfg.game.profile), maxSteps: BUILDER_MAX_STEPS, maxTotalMs: BUILDER_MAX_TOTAL_MS, maxRepeat: BUILDER_MAX_REPEAT,
        sources: [...rt.actions.list, ...rt.bitsActions.list].filter((a) => a.effect?.steps?.length).map((a) => ({ id: a.id, title: a.title })) },
      communityGoal: cfg.communityGoal,
      autoIdle: cfg.autoIdle,
      queuePolicy: { maxQueue: cfg.engine.maxQueue, queueWaitSec: cfg.engine.queueWaitSec, bitsPriority: cfg.bitsPriority },
      chat: cfg.chat,
      gsiRecording: gsiRecorder.status(),
      input: { criticalKeys: cfg.input.criticalKeys, criticalChoices: CRITICAL_KEY_NAMES, pending: pendingCriticalKeys(cfg) },
      bitsActions: rt.bitsActions.list.map((a) => editInfo(a)),
      accessLevels: ACCESS_LEVELS,
      bitsMenu: { ...cfg.bitsMenu, templates: Object.fromEntries(Object.entries(BITS_MENU_TEMPLATES).map(([id, t]) => [id, { title: t.title, title_en: t.title_en, units: t.units, challenge: !!t.challenge }])),
        actionChoices: [...rt.actions.list, ...rt.bitsActions.list].filter(hasGameEffect).map((a) => ({ id: a.id, title: a.title })) },
      bitsCredit: cfg.bitsCredit,
      modeLock: { ...cfg.modeLock, modes: CS2_MODES },
      bitsTemplates: rt.bitsActions.list.filter(hasGameEffect).map((a) => ({ id: a.id, title: a.title })),
      version: pkgVersion, build: buildInfo,
      stats: rt.db.perAction(), avgWaitMs: rt.db.avgWaitMs(), recent: rt.db.recent(15), log: logger.recent.slice(-60),
      info: { port: cfg.server.port, requireGameState: cfg.game.requireGameState, queueMax: cfg.engine.maxQueue },
      game: {
        profile: cfg.game.profile,
        profileName: getProfile(cfg.game.profile).name,
        supportsGsi: getProfile(cfg.game.profile).supportsGsi,
        profiles: profileIds().map((id) => ({
          id, name: getProfile(id).name, supportsGsi: getProfile(id).supportsGsi,
        })),
      },
    };
  };

  // Neuen Login (Notfall-Anmeldung im Dashboard oder erneute Anmeldung in der Einrichtung) ohne Neustart übernehmen.
  function reloadTwitchLogin() {
    if (!rt.twitch) return;
    Object.assign(cfg.twitch, loadConfig().twitch);
    rt.twitch.reloadLogin();
    rt.engine?.emitState();
    logger.info('Neuer Twitch-Login übernommen, verbinde neu.');
  }

  // ---------- Dienste starten (nach Einrichtung oder direkt beim Start) ----------
  async function startServices() {
    if (rt.ready) return;
    const c = loadConfig();
    Object.assign(cfg, c);

    // CS2-Binds automatisch auf den neuesten Stand bringen: eine frühere Installation (vor einem
    // Update dieses Programms) kann eine veraltete unknown_chat_control.cfg hinterlassen haben, die
    // z. B. noch nicht "cl_crosshairstyle 4" setzt - dann greifen Crosshair-Effekte im Spiel nicht,
    // obwohl alles andere stimmt. Ohne diesen Schritt müsste man das von Hand per "npm run cs2"
    // nachholen; das ist für ein Produkt, das andere Leute nutzen sollen, keine gute Erwartung.
    if (cfg.game.profile === 'cs2') try {
      const dir = cfg.game.cs2CfgDir || findCs2CfgDir();
      if (dir) {
        const f = cs2FilesInstalled(dir);
        if (f.gsi && f.binds && !f.current) {
          installCs2Files(dir, cfg.server.port, cfg.server.gsiToken, cfg.game, cfg.keys);
          logger.info(f.gsiCurrent ? 'CS2-Binds waren veraltet und wurden automatisch aktualisiert.'
            : 'CS2-Dateien wurden aktualisiert (neue Spielzustand-Datei für Session Stats). Bitte CS2 einmal neu starten, damit es die neue Datei liest.');
        }
      }
    } catch (e) { logger.warn(`CS2-Binds konnten nicht automatisch aktualisiert werden: ${e.message}`); }

    const twitch = new Twitch(cfg);
    const actions0 = loadActions(cfg.game.profile);
    for (const p of pendingCriticalKeys(cfg)) {
      logger.warn(`Deine Tastenbelegung nutzt die kritische Taste "${p.group}" (${p.bindings.map((b) => `${b.name} = ${b.key}`).join(', ')}). Sie ist noch nicht freigegeben - bitte im Dashboard bestätigen oder ablehnen. Bis dahin bleiben Aktionen, die sie brauchen, aus.`);
    }
    // Ungültige Aktionen hat loadActions() schon deaktiviert und begründet (config.js: markInvalid).
    for (const a of actions0.list) if (a.invalid && a.enabledInFile) logger.error(`Aktion "${a.title}" ist ungültig und wird übersprungen: ${a.invalid}`);
    const bitsActions0 = loadBitsActions();
    for (const a of bitsActions0.list) if (a.invalid && a.enabledInFile) logger.error(`Bits-Stufe "${a.title}" ist ungültig und wird übersprungen: ${a.invalid}`);
    const db = openDb();
    const bridge = createBridge(cfg);
    const rewardMap = loadRewardMap();
    const engine = new Engine({ cfg, twitch, bridge, gsi, db, actions: actions0, rewardMap, bitsActions: bitsActions0 });
    // Session Stats
    const stats = new SessionStats({ cfg, db, logger });
    engine.stats = stats;
    stats.on('change', () => engine.emitState());
    stats.on('fx', (fx) => push({ type: 'fx', fx }));
    stats.on('chaosDeath', ({ user, title }) => engine.announceChaosDeath(user, title));
    // Highlights: starke Momente aus Session Stats und Engine sammeln (Marker, Clips, Liste).
    const highlights = new Highlights({ cfg, db, twitch, gsi, logger, locale: cfg.server.locale });
    stats.on('moment', (m) => highlights.add(m));
    engine.on('moment', (m) => { if (m.type === 'challenge') highlights.add({ type: 'challenge', user: m.user, result: m.result, kills: m.have, goal: m.goal, minutes: m.minutes }); else highlights.add(m); });
    engine.on('fx', (f) => {
      if (f.type === 'alert' && f.bits >= 500) highlights.add({ type: 'bits_big', user: f.user, effect: String(f.title || '').split(' · ')[0], bits: f.bits });
      else if (f.type === 'pot_full') highlights.add({ type: 'pot', user: (f.names || [])[0], effect: f.effect, minutes: f.minutes });
      else if (f.type === 'overload') highlights.add({ type: 'goal', effect: f.name || 'Chaos Overload' });
    });
    highlights.on('change', () => push({ type: 'highlights' }));
    Object.assign(rt, { twitch, db, bridge, engine, stats, highlights, actions: actions0, rewardMap, bitsActions: bitsActions0 });

    if (bridge.note) logger.warn(bridge.note);
    if (!Object.keys(rewardMap).length) logger.warn('Es sind noch keine Belohnungen mit Twitch verbunden. Im Dashboard „Belohnungen mit Twitch abgleichen“ klicken.');

    twitch.on('redemption', (ev) => engine.onRedemption(ev).catch((e) => logger.error(`Einlösung fehlgeschlagen: ${e.stack || e.message}`)));
    twitch.on('cheer', (ev) => engine.onCheer(ev).catch((e) => logger.error(`Bits-Cheer fehlgeschlagen: ${e.stack || e.message}`)));
    twitch.on('chatMessage', (ev) => { try { engine.onChatMessage(ev); } catch (e) { logger.error(`Chat-Nachricht fehlgeschlagen: ${e.stack || e.message}`); } });
    twitch.on('status', () => {
      engine.emitState();
      // Nach (Neu-)Verbindung abgleichen, ob der Stream läuft - ein verpasstes stream.online/offline
      // (ChaosCore war aus oder offline) darf die Statistik-Sitzung nicht falsch offen/zu lassen.
      if (twitch.status === 'connected') twitch.isLive().then((live) => { if (live !== null) { stats.setStreamLive(live); if (live !== (highlights.streamStart !== null)) highlights.setLive(live); } });
    });
    twitch.on('streamOnline', () => { stats.setStreamLive(true); highlights.setLive(true); });
    twitch.on('clientType', (t) => { if (cfg.twitch.clientType !== t) { const c = loadConfig(); c.twitch.clientType = t; saveConfig(c); cfg.twitch.clientType = t; engine.emitState(); } });
    twitch.on('streamOffline', () => { stats.setStreamLive(false); highlights.flushNow(); highlights.setLive(false); });
    engine.on('state', () => push({ type: 'state', state: engine.publicState() }));
    engine.on('fx', (fx) => push({ type: 'fx', fx }));

    twitch.connect();
    bridge.startPanicWatcher(() => engine.panic('Not-Aus-Hotkey'), () => { const r = stats.addFail('hotkey'); if (r.ok) logger.info('Fail per Hotkey gezählt.'); });
    setTimeout(() => engine.recover().catch(() => {}), 4000 * (Number(process.env.UCC_POLL_SCALE) || 1)).unref();
    twitch.listRewards().then((list) => {
      const ids = new Set(list.map((r) => r.id));
      for (const [rid, aid] of Object.entries(rewardMap)) {
        if (!ids.has(rid)) logger.warn(`Belohnung "${rt.actions.byId.get(aid)?.title || aid}" existiert auf Twitch nicht mehr. Im Dashboard „Belohnungen mit Twitch abgleichen“ klicken.`);
      }
    }).catch((e) => logger.warn(`Belohnungen nicht prüfbar: ${e.message}`));

    rt.ready = true;
    rt.reason = '';
    engine.emitState();
    logger.info('ChaosCore läuft.');
  }

  const needReady = (res) => { if (!rt.ready) { json(res, 409, { error: 'ChaosCore ist noch nicht eingerichtet.' }); return false; } return true; };

  const server = http.createServer(async (req, res) => {
    try {
      if (!allowedHosts.has(String(req.headers.host || '').toLowerCase())) { res.writeHead(421); return res.end('Falscher Host'); }
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname;

      if (req.method === 'GET' && (p === '/' || PAGES[p])) {
        if (p === '/') { res.writeHead(302, { Location: rt.ready ? '/dashboard' : '/setup' }); return res.end(); }
        const html = fs.readFileSync(path.join(WEB, PAGES[p]));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return res.end(html);
      }
      if (req.method === 'GET' && ASSETS[p]) {
        res.writeHead(200, { 'Content-Type': ASSETS[p][1], 'Cache-Control': 'max-age=3600' });
        return res.end(fs.readFileSync(path.join(ROOT, ASSETS[p][0])));
      }
      if (req.method === 'GET' && p === '/favicon.ico') { res.writeHead(302, { Location: '/icon.png' }); return res.end(); }

      // Übersetzungstexte: bewusst ohne Admin-Token, genau wie /events - das Setup-Fenster
      // (vor dem Login) UND das OBS-Overlay (ganz ohne Login) brauchen beide Zugriff.
      if (req.method === 'GET' && p === '/api/i18n') return json(res, 200, { lang: cfg.server.locale, strings: stringsFor(cfg.server.locale) });

      // Eigener Overlay-Sound/-Bild: genau wie /events bewusst ohne Admin-Token, weil
      // das OBS-Overlay (browser source, kein Login) sie direkt per <audio>/<img src> laden muss.
      if (req.method === 'GET' && (p === '/overlay-asset/sound' || p === '/overlay-asset/image')) {
        const kind = p.endsWith('sound') ? 'sound' : 'image';
        const meta = cfg.overlay[kind === 'sound' ? 'customSound' : 'customImage'];
        const buf = meta && readOverlayAsset(meta);
        if (!buf) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': meta.mime, 'Cache-Control': 'no-store' });
        return res.end(buf);
      }

      if (req.method === 'GET' && p === '/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        if (rt.ready) res.write(`data: ${JSON.stringify({ type: 'state', state: rt.engine.publicState() })}\n\n`);
        else res.write(': wartet auf Einrichtung\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }

      if (req.method === 'POST' && p === '/gsi') {
        const body = await readBody(req);
        if (!safeEqual(body?.auth?.token, cfg.server.gsiToken)) { res.writeHead(403); return res.end(); }
        gsiRecorder.write(body);
        try { rt.stats?.onGsi(body); } catch (e) { logger.warn(`Session Stats: ${e.message}`); }
        gsi.update(body);
        res.writeHead(200);
        return res.end();
      }

      // ---------- Setup-Fenster ----------
      if (p.startsWith('/setup/api/')) {
        if (!safeEqual(req.headers['x-admin-token'], cfg.server.adminToken)) return json(res, 401, { error: 'Nicht erlaubt' });
        const body = req.method === 'POST' ? await readBody(req, 8192) : {};
        const route = `${req.method} ${p.slice('/setup/api/'.length)}`;
        try {
          switch (route) {
            case 'GET summary': return json(res, 200, { ...setup.summary(), ready: rt.ready, running: rt.ready });
            case 'POST consent': return json(res, 200, setup.giveConsent());
            case 'POST client-id': return json(res, 200, setup.setClientId(body.value));
            case 'POST login/start': return json(res, 200, await setup.startLogin());
            case 'GET login/status': {
              // Läuft ChaosCore schon (z. B. erneute Anmeldung über die Einrichtung), den neuen Login sofort übernehmen.
              if (rt.ready && setup.login?.state === 'ok' && rt.reloadedLogin !== setup.login) { rt.reloadedLogin = setup.login; reloadTwitchLogin(); }
              return json(res, 200, setup.public());
            }
            case 'POST game': {
              const r = setup.saveGame(body);
              return json(res, 200, { ...r, restartNeeded: rt.ready });
            }
            case 'POST ahk/install': return json(res, 200, await setup.installAhk());
            case 'GET rewards': return json(res, 200, { rewards: setup.rewardList(), unmatched: await setup.unmatchedRewards() });
            case 'POST rewards': {
              const r = await setup.applyRewards(body);
              if (rt.ready) { rt.actions = loadActions(cfg.game.profile); rt.engine.setActions(rt.actions); rt.rewardMap = loadRewardMap(); rt.engine.setRewardMap(rt.rewardMap); }
              return json(res, 200, r);
            }
            case 'POST rewards/delete': return json(res, 200, await setup.deleteUnmatchedReward(body.id));
            case 'GET checks': return json(res, 200, { checks: await runChecks('gui') });
            case 'POST open': openExternal(body.url); return json(res, 200, { ok: true });
            case 'POST shortcuts': return json(res, 200, await createShortcuts({ desktop: !!body.desktop, startMenu: !!body.startMenu, autostart: !!body.autostart }));
            case 'POST finish': {
              const r = await readiness(loadConfig());
              if (!r.ok) return json(res, 409, { error: r.reason });
              if (!rt.ready) await startServices();
              else if (rt.reloadedLogin !== setup.login) { rt.reloadedLogin = setup.login; reloadTwitchLogin(); }
              return json(res, 200, { ok: true, dashboard: `http://localhost:${cfg.server.port}/dashboard` });
            }
            default: return json(res, 404, { error: 'Unbekannt' });
          }
        } catch (e) {
          if (e.status) return json(res, e.status, { error: e.message });
          throw e;
        }
      }

      if (p.startsWith('/api/')) {
        if (!safeEqual(req.headers['x-admin-token'], cfg.server.adminToken)) return json(res, 401, { error: 'Nicht erlaubt' });
        if (req.method === 'GET' && p === '/api/status') return json(res, 200, status());
        if (req.method === 'GET' && p === '/api/stats') {
          // Session Stats: alles, was der Dashboard-Bereich "Session" braucht.
          if (!needReady(res)) return;
          const st = rt.stats;
          const sid = Number(url.searchParams.get('id')) || st.session?.id || null;
          return json(res, 200, { state: st.publicState(), config: cfg.stats, sessionId: sid, totals: sid ? st.totals(sid) : null,
            timeline: sid ? st.deathTimeline(sid, 50) : [], torture: sid ? st.torture(sid, 10) : [], history: st.history(20) });
        }
        if (req.method === 'GET' && p === '/api/stats/csv') {
          if (!needReady(res)) return;
          const id = Number(url.searchParams.get('id'));
          const text = rt.stats.csv(id);
          if (text === null) return json(res, 404, { error: 'Sitzung nicht gefunden' });
          res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="chaoscore-session-${id}.csv"`, 'Cache-Control': 'no-store' });
          return res.end('\ufeff' + text); // BOM, damit Excel Umlaute richtig liest
        }
        if (req.method === 'GET' && p === '/api/checks') { if (!needReady(res)) return; return json(res, 200, { checks: await runChecks('gui') }); }
        if (req.method === 'GET' && p === '/api/game/selftest') {
          // Profil-Selbsttest: prueft JEDE konfigurierte Aktion des
          // aktiven Profils einmal gegen die eigene Tastenbelegung - meldet eine kaputte
          // Tastenbelegung verstaendlich statt mit einem rohen Absturz. Reine Pruefung, keine
          // Tasten werden dabei tatsaechlich gesendet (das macht weiterhin der Trocken-/Echt-Test
          // pro Aktion).
          const list = loadActions(cfg.game.profile).list;
          const results = list.map((a) => {
            const error = a.invalid || validateAction(a, cfg.keys, keyPolicy(cfg));
            return { id: a.id, title: a.title, enabled: !!a.enabled, ok: !error, error: error || null };
          });
          return json(res, 200, { profile: cfg.game.profile, results, allOk: results.every((r) => r.ok) });
        }
        if (req.method === 'GET' && p === '/api/diagnostics') {
          if (!needReady(res)) return;
          return json(res, 200, await buildDiagnostics());
        }
        if (req.method === 'GET' && p === '/api/update-check') {
          try { return json(res, 200, publicUpdate(await updateCheck(cfg, url.searchParams.get('force') === '1'))); }
          catch (e) { return json(res, 200, { configured: true, error: e.message }); }
        }
        if (req.method === 'GET' && p === '/api/viewers') {
          if (!needReady(res)) return;
          const blocked = new Set(cfg.viewers.blocked.map((v) => v.id));
          const found = rt.db.searchViewers(url.searchParams.get('q') || '').map((v) => ({ ...v, blocked: blocked.has(v.id) }));
          return json(res, 200, { viewers: found, blocked: cfg.viewers.blocked });
        }
        if (req.method === 'GET' && p === '/api/highlights') {
          if (!needReady(res)) return;
          const tw = rt.twitch;
          return json(res, 200, {
            settings: cfg.highlights, list: rt.highlights.list(100), live: rt.highlights.streamStart !== null,
            scopes: { markers: tw.hasScope('channel:manage:broadcast'), clips: tw.hasScope('clips:edit') },
            login: cfg.twitch.login || '',
          });
        }
        if (req.method === 'GET' && p === '/api/highlights/export') {
          if (!needReady(res)) return;
          const fmt = url.searchParams.get('format') === 'csv' ? 'csv' : 'txt';
          res.writeHead(200, { 'Content-Type': fmt === 'csv' ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="chaoscore-highlights.${fmt}"`, 'Cache-Control': 'no-store' });
          return res.end('\uFEFF' + rt.highlights.exportText(fmt));
        }
        if (req.method === 'GET' && p === '/api/stream/info') {
          if (!needReady(res)) return;
          if (!rt.twitch.hasScope('channel:manage:broadcast')) return json(res, 409, { error: 'Dafür fehlt ein Recht im Twitch-Login - bitte im Highlight-Menü neu anmelden.' });
          try { return json(res, 200, { channel: await rt.twitch.getChannel() }); } catch (e) { return json(res, 502, { error: explain(e) }); }
        }
        if (req.method === 'GET' && p === '/api/stream/categories') {
          if (!needReady(res)) return;
          const qy = String(url.searchParams.get('q') || '').slice(0, 60);
          if (qy.length < 2) return json(res, 200, { categories: [] });
          try { return json(res, 200, { categories: await rt.twitch.searchCategories(qy) }); } catch (e) { return json(res, 502, { error: explain(e) }); }
        }
        if (req.method === 'GET' && p === '/api/update/status') return json(res, 200, updateJob);
        if (req.method === 'GET' && p === '/api/presets') return json(res, 200, { presets: listBundledPresets() });
        if (req.method !== 'POST') return json(res, 405, { error: 'Nur POST' });
        // Profil-Export/-Import und eigene Overlay-Sounds/-Bilder dürfen größer sein.
        const BIG_BODY = ['/api/profile/preview', '/api/profile/import', '/api/profile/export', '/api/overlay/asset', '/api/preset/apply', '/api/overlay/styles'];
        const body = await readBody(req, BIG_BODY.includes(p) ? 4 * 1024 * 1024 : 4096);
        if (p === '/api/quit') { json(res, 200, { ok: true }); setTimeout(() => shutdown('Beenden (Fenster)'), 100); return; }
        if (p === '/api/restart') { json(res, 200, { ok: true }); setTimeout(() => { relaunchSelf(); shutdown('Neustart'); }, 100); return; }
        if (!needReady(res)) return;
        const { engine, twitch } = rt;
        switch (p) {
          case '/api/profile/export': {
            // "Preset teilen" - technisch derselbe Export wie bisher,
            // optional mit Name/Autor fürs Teilen an andere Streamer (rein informativ, keine
            // Auswirkung auf die Technik).
            return json(res, 200, exportProfile(cfg, { name: body.name, author: body.author }));
          }
          case '/api/profile/preview': {
            // Import-Vorschau: zeigt, was ein Preset tun würde,
            // ohne irgendetwas zu ändern. body: { preset, accept } oder direkt das Preset.
            const wrapped = isImportEnvelope(body);
            return json(res, 200, previewImport(cfg, wrapped ? body.preset : body, wrapped ? body.accept || {} : {}));
          }
          case '/api/profile/import': {
            // body: { preset, accept } (Dashboard, nach der Vorschau) oder direkt das Preset. Ohne
            // accept werden die zustimmungspflichtigen Gruppen (Contract-Ziel, Warteschlange,
            // persönliche Spielwerte) nie übernommen.
            const wrapped = isImportEnvelope(body);
            let r;
            try { r = importProfile(cfg, wrapped ? body.preset : body, wrapped ? body.accept || {} : {}); }
            catch (e) { return json(res, 400, { error: e.message }); }
            rt.actions = loadActions(cfg.game.profile);
            engine.setActions(rt.actions);
            engine.emitState();
            return json(res, 200, { ok: true, actionsImported: r.actionsImported });
          }
          case '/api/preset/preview': {
            // auch mitgelieferte Presets zeigen vor der Übernahme
            // die Vorschau (erster Klick), erst der zweite Klick übernimmt - Sicherheit und
            // Transparenz gehen vor einem echten Ein-Klick-Import. Ändert nichts.
            let data;
            try { data = readBundledPreset(body.id); }
            catch (e) { return json(res, 400, { error: e.message }); }
            return json(res, 200, previewImport(cfg, data, body.accept || {}));
          }
          case '/api/preset/apply': {
            // One-Click-Setup: läuft durch denselben, schon getesteten Import-Pfad wie eine von
            // Hand hochgeladene Preset-Datei - keine eigene Übernahme-Logik.
            let r;
            try { r = importProfile(cfg, readBundledPreset(body.id), body.accept || {}); }
            catch (e) { return json(res, 400, { error: e.message }); }
            rt.actions = loadActions(cfg.game.profile);
            engine.setActions(rt.actions);
            engine.emitState();
            return json(res, 200, { ok: true, actionsImported: r.actionsImported });
          }
          case '/api/overlay/asset': {
            // Eigene Overlay-Sounds/-Bilder hochladen.
            let meta;
            try { meta = setOverlayAsset(cfg, String(body.kind), { name: body.name, mime: body.mime, dataBase64: body.dataBase64 }); }
            catch (e) { return json(res, 400, { error: e.message }); }
            engine.emitState();
            return json(res, 200, { ok: true, [body.kind === 'sound' ? 'customSound' : 'customImage']: meta });
          }
          case '/api/overlay/asset/remove': {
            try { removeOverlayAsset(cfg, String(body.kind)); }
            catch (e) { return json(res, 400, { error: e.message }); }
            engine.emitState();
            return json(res, 200, { ok: true });
          }
          case '/api/game/profile': {
            // Schneller Profil-Wechsel: ohne Neustart, ohne die
            // Aktionen/Tasten eines anderen Profils zu verlieren - jede Profil-Aktionen-Datei
            // bleibt für sich bestehen (siehe config.js: actionsFile()).
            let next;
            try { next = applyGameProfile(cfg, String(body.id)); }
            catch (e) { return json(res, 400, { error: e.message }); }
            rt.actions = loadActions(next.game.profile);
            engine.setActions(rt.actions);
            engine.emitState();
            return json(res, 200, { ok: true, profile: next.game.profile });
          }
          case '/api/panic': await engine.panic('Not-Aus (Dashboard)'); return json(res, 200, { ok: true });
          case '/api/pause': engine.setPaused(body.paused); return json(res, 200, { ok: true });
          case '/api/clear': await engine.clearQueue(); return json(res, 200, { ok: true });
          case '/api/skip': engine.skipCurrent(); return json(res, 200, { ok: true });
          case '/api/bits/credit/resume': {
            const err = engine.resumeCredit(body.id);
            return json(res, err ? 409 : 200, err ? { error: err } : { ok: true });
          }
          case '/api/bits/credit/drop': {
            const ok = engine.dropCredit(body.id);
            return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'Dieses Guthaben gibt es nicht (mehr).' });
          }
          case '/api/viewers/block': {
            try { setViewerBlocked(cfg, body); } catch (e) { return json(res, 400, { error: e.message }); }
            logger.info(`Zuschauer ${String(body.name || body.id).slice(0, 40)} ${body.blocked ? 'gesperrt' : 'entsperrt'}.`);
            return json(res, 200, { ok: true, blocked: cfg.viewers.blocked });
          }
          case '/api/viewers/delete': {
            const id = String(body.id || '');
            if (!id || id === 'anon') return json(res, 400, { error: 'Unbekannter Zuschauer.' });
            const n = rt.db.deleteViewer(id);
            engine.refreshViewerCaches();
            logger.info(`Daten eines Zuschauers auf Wunsch gelöscht (${n} Einträge).`);
            return json(res, 200, { ok: true, removed: n });
          }
          case '/api/highlights/settings': {
            try { applyHighlights(cfg, body); } catch (e) { return json(res, 400, { error: e.message }); }
            rt.highlights.setLocale(cfg.server.locale);
            return json(res, 200, { ok: true, settings: cfg.highlights });
          }
          case '/api/highlights/check': {
            // Einrichtungs-Check: Rechte, VODs gespeichert?
            const tw = rt.twitch;
            const out = { markers: tw.hasScope('channel:manage:broadcast'), clips: tw.hasScope('clips:edit'), vods: null, live: rt.highlights.streamStart !== null };
            try { out.vods = await tw.hasArchives(); } catch (e) { out.vodsError = explain(e); }
            return json(res, 200, out);
          }
          case '/api/highlights/clip': {
            // Öffentliche Clip-Adresse nachladen (Twitch braucht nach dem Erstellen ein paar Sekunden).
            const row = rt.highlights.list(1000).find((r) => r.id === Number(body.id));
            if (!row?.clipId) return json(res, 404, { error: 'Zu diesem Highlight gibt es keinen Clip.' });
            try { const c = await rt.twitch.getClip(row.clipId); if (c?.url) rt.db.highlightSet(row.id, { clipUrl: c.url }); return json(res, 200, { ok: true, url: c?.url || null }); }
            catch (e) { return json(res, 502, { error: explain(e) }); }
          }
          case '/api/stream/info': {
            if (!rt.twitch.hasScope('channel:manage:broadcast')) return json(res, 409, { error: 'Dafür fehlt ein Recht im Twitch-Login - bitte im Highlight-Menü neu anmelden.' });
            const patch = {};
            if (typeof body.title === 'string') { const t = body.title.trim(); if (!t || t.length > 140) return json(res, 400, { error: 'Der Titel braucht 1 bis 140 Zeichen.' }); patch.title = t; }
            if (typeof body.gameId === 'string' && /^\d{1,20}$/.test(body.gameId)) patch.game_id = body.gameId;
            if (Array.isArray(body.tags)) {
              const tags = body.tags.map((x) => String(x).trim()).filter(Boolean);
              if (tags.length > 10 || tags.some((x) => !/^[\p{L}\p{N}]{1,25}$/u.test(x))) return json(res, 400, { error: 'Höchstens 10 Tags, je 1-25 Buchstaben/Ziffern ohne Leerzeichen.' });
              patch.tags = tags;
            }
            if (!Object.keys(patch).length) return json(res, 400, { error: 'Nichts zu ändern.' });
            try { await rt.twitch.updateChannel(patch); logger.info('Stream-Infos bei Twitch geändert.'); return json(res, 200, { ok: true }); }
            catch (e) { return json(res, 502, { error: explain(e) }); }
          }
          case '/api/modelock': {
            try { applyModeLock(cfg, body); } catch (e) { return json(res, 400, { error: e.message }); }
            engine.emitState();
            return json(res, 200, { ok: true, modeLock: cfg.modeLock });
          }
          case '/api/bits/credit/settings': return json(res, 200, { ok: true, bitsCredit: applyBitsCredit(cfg, body) });
          case '/api/bitsmenu': {
            let next;
            try { next = applyBitsMenu(cfg, body); }
            catch (e) { return json(res, 400, { error: e.message }); }
            engine.emitState();
            return json(res, 200, { ok: true, bitsMenu: next });
          }
          case '/api/update/channel': {
            try { applyUpdateChannel(cfg, String(body.channel || '')); }
            catch (e) { return json(res, 400, { error: e.message }); }
            return json(res, 200, publicUpdate(await updateCheck(cfg, true)));
          }
          case '/api/update/install': {
            // Nur nach ausdrücklichem Klick im Dashboard. Lädt, prüft (SHA-256) und installiert.
            if (['downloading', 'installing'].includes(updateJob.phase)) return json(res, 409, { error: 'Update läuft schon.' });
            const info = await updateCheck(cfg, true);
            if (!info.newer) return json(res, 409, { error: 'Keine neuere Version verfügbar.' });
            const inst = installInfo(ROOT, `${product.name}.exe`);
            if (!inst.canInstall) return json(res, 409, { error: 'Automatisches Aktualisieren geht nur in der installierten Windows-Version.', reason: inst.reason, url: info.url });
            if (info.awaitingSignature) return json(res, 409, { error: 'Das Update ist noch nicht signiert. Bitte etwas später nochmal versuchen.', url: info.url });
            if (!info.installable) return json(res, 409, { error: 'Dieses Release hat keinen Installer mit Prüfsummen.', url: info.url });
            updateJob = { phase: 'downloading', version: info.latest, bytes: 0, total: info.setup.size || 0, error: null };
            json(res, 200, { ok: true, version: info.latest });
            downloadVerified(info, product.githubRepo, { publicKeys: product.releaseKeys, onProgress: (b, t) => { updateJob.bytes = b; updateJob.total = t; } })
              .then(({ file }) => {
                updateJob.phase = 'installing';
                logger.info(`Update auf ${info.latest}: Installer geprüft, starte Installation - ChaosCore startet gleich neu.`);
                setTimeout(() => { try { launchInstaller(file, inst); } catch (e) { updateJob = { ...updateJob, phase: 'error', error: e.message }; } }, 800);
              })
              .catch((e) => { logger.warn(`Update fehlgeschlagen: ${e.message}`); updateJob = { ...updateJob, phase: 'error', error: e.message }; });
            return;
          }
          case '/api/twitch/reload': {
            // Nach der Notfall-Anmeldung im Dashboard: neuen Login übernehmen, ohne Neustart.
            if (!rt.ready) return json(res, 409, { error: 'Noch nicht eingerichtet.' });
            if (rt.reloadedLogin !== setup.login) { rt.reloadedLogin = setup.login; reloadTwitchLogin(); }
            return json(res, 200, { ok: true });
          }
          case '/api/queue/remove': {
            const ok = await engine.removeQueued(body.qid);
            return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'Nicht (mehr) in der Warteliste.' });
          }
          case '/api/action/copy': case '/api/bits/action/copy': {
            const bits = p.startsWith('/api/bits/');
            let copy;
            try { copy = copyAction(bits ? 'bits' : 'points', String(body.id), cfg.game.profile); } catch (e) { return json(res, 400, { error: e.message }); }
            if (bits) reloadBits(); else reloadPoints();
            return json(res, 200, { ok: true, id: copy.id, title: copy.title });
          }
          case '/api/action/restore': case '/api/bits/action/restore': {
            const bits = p.startsWith('/api/bits/');
            try { restoreAction(bits ? 'bits' : 'points', String(body.id), cfg.game.profile); } catch (e) { return json(res, 400, { error: e.message }); }
            let warning = null;
            if (bits) reloadBits();
            else {
              reloadPoints();
              try { await syncOne(twitch, rt.actions, String(body.id)); rt.rewardMap = loadRewardMap(); engine.setRewardMap(rt.rewardMap); } catch (e) { warning = explain(e); }
            }
            return json(res, 200, { ok: true, warning });
          }
          case '/api/action/export': {
            try { return json(res, 200, { ok: true, data: exportEffect(body.kind === 'bits' ? 'bits' : 'points', String(body.id), cfg.game.profile) }); }
            catch (e) { return json(res, 400, { error: e.message }); }
          }
          case '/api/action/import': {
            const kind = body.kind === 'bits' ? 'bits' : 'points';
            let a;
            try { a = importEffect(body.data, kind, cfg.game.profile, { commit: !!body.commit }); } catch (e) { return json(res, 400, { error: e.message }); }
            if (body.commit) { if (kind === 'bits') reloadBits(); else reloadPoints(); }
            return json(res, 200, { ok: true, committed: !!body.commit, id: a.id, title: a.title, cost: a.cost, describe: describeAction(a, cfg.server.locale) });
          }
          case '/api/builder/preview': {
            try {
              const { built, text } = buildChecked(body.builder, body.self ? { id: String(body.self.id), kind: body.self.kind === 'bits' ? 'bits' : 'points' } : null);
              const lists = built.effect.variants || [built.effect.steps];
              const est = lists.map((l) => compile(l, cfg.keys, keyPolicy(cfg)).est);
              return json(res, 200, { ok: true, text, ms: Math.max(...est.map((e) => e.ms)), untilStop: est.some((e) => e.untilStop) });
            } catch (e) { return json(res, 200, { ok: false, error: e.message }); }
          }
          case '/api/builder/test': {
            try {
              const { built } = buildChecked(body.builder, body.self ? { id: String(body.self.id), kind: body.self.kind === 'bits' ? 'bits' : 'points' } : null);
              engine.enqueueTestAction({ id: 'builder_test', title: String(body.title || 'Test').slice(0, 45), flavor: '', category: 'medium', requires: built.requires, effect: built.effect }, { dry: body.dry !== false });
              return json(res, 200, { ok: true });
            } catch (e) { return json(res, 400, { error: e.message }); }
          }
          case '/api/test':
            try { engine.enqueueTest(String(body.id), { dry: body.dry !== false }); return json(res, 200, { ok: true }); }
            catch (e) { return json(res, 400, { error: e.message }); }
          case '/api/action': {
            // eine ungültige Aktion lässt sich nicht einschalten - mit dem Grund als Antwort.
            if (body.enabled && rt.actions.byId.get(String(body.id))?.invalid) {
              return json(res, 400, { error: `Diese Aktion ist ungültig und bleibt aus: ${rt.actions.byId.get(String(body.id)).invalid}` });
            }
            setActionEnabled(String(body.id), !!body.enabled, cfg.game.profile);
            rt.actions = loadActions(cfg.game.profile);
            engine.setActions(rt.actions);
            let warning = null;
            try { await syncOne(twitch, rt.actions, String(body.id)); rt.rewardMap = loadRewardMap(); engine.setRewardMap(rt.rewardMap); }
            catch (e) { warning = explain(e); }
            return json(res, 200, { ok: true, warning });
          }
          case '/api/action/update': {
            try {
              const keys = Object.keys(body).filter((k) => k !== 'id');
              if (keys.length === 1 && keys[0] === 'cost') setActionCost(String(body.id), body.cost, cfg.game.profile);
              else updateAction('points', String(body.id), { ...body, built: body.builder ? buildChecked(body.builder, { id: String(body.id), kind: 'points' }).built : undefined }, cfg.game.profile);
            } catch (e) { return json(res, 400, { error: e.message }); }
            rt.actions = loadActions(cfg.game.profile);
            engine.setActions(rt.actions);
            let warning = null;
            try { await syncOne(twitch, rt.actions, String(body.id)); rt.rewardMap = loadRewardMap(); engine.setRewardMap(rt.rewardMap); }
            catch (e) { warning = explain(e); }
            return json(res, 200, { ok: true, warning });
          }
          case '/api/action/access': {
            // Zugriffsregel einer Aktion ändern.
            try { setActionAccess(String(body.id), body.access, cfg.game.profile); }
            catch (e) { return json(res, 400, { error: e.message }); }
            rt.actions = loadActions(cfg.game.profile);
            engine.setActions(rt.actions);
            return json(res, 200, { ok: true });
          }
          case '/api/bits/action/access': {
            try { setBitsActionAccess(String(body.id), body.access); }
            catch (e) { return json(res, 400, { error: e.message }); }
            rt.bitsActions = loadBitsActions();
            engine.setBitsActions(rt.bitsActions);
            return json(res, 200, { ok: true });
          }
          case '/api/overlay': {
            try { applyOverlayConfig(cfg, body); }
            catch (e) { return json(res, 400, { error: e.message }); }
            engine.emitState();
            return json(res, 200, { ok: true });
          }
          case '/api/overlay/styles': {
            let next;
            try { next = applyOverlayStyles(cfg, { styles: body.styles, customCss: body.customCss }); }
            catch (e) { return json(res, 400, { error: e.message }); }
            engine.emitState();
            return json(res, 200, { ok: true, ...next });
          }
          case '/api/overlay/hidden': {
            try { applyOverlayHidden(cfg, body.hidden); }
            catch (e) { return json(res, 400, { error: e.message }); }
            engine.emitState();
            return json(res, 200, { ok: true, hidden: cfg.overlay.hidden });
          }
          case '/api/overlay/layout': {
            try { applyOverlayLayout(cfg, body.layout); }
            catch (e) { return json(res, 400, { error: e.message }); }
            engine.emitState();
            return json(res, 200, { ok: true });
          }
          case '/api/goal': {
            // Community-Ziel umbenennen/Grundlage wählen/Schwellen festlegen.
            let next;
            try { next = applyCommunityGoal(cfg, body); }
            catch (e) { return json(res, 400, { error: e.message }); }
            engine.emitState();
            return json(res, 200, { ok: true, communityGoal: next });
          }
          case '/api/autoidle': {
            // "Auto-Lebendig" an/aus, Ruhezeit, Whitelist.
            let next;
            try { next = applyAutoIdle(cfg, body); }
            catch (e) { return json(res, 400, { error: e.message }); }
            engine.emitState();
            return json(res, 200, { ok: true, autoIdle: next });
          }
          case '/api/queuepolicy': {
            // Warteschlangen-Länge und Voll-Politik.
            let next;
            try { next = applyQueuePolicy(cfg, body); }
            catch (e) { return json(res, 400, { error: e.message }); }
            engine.arrange();
            engine.emitState();
            return json(res, 200, { ok: true, engine: next, bitsPriority: cfg.bitsPriority });
          }
          case '/api/gsi/record': {
            // echte GSI-Pakete für Tests aufzeichnen (an/aus).
            const st = body.on ? gsiRecorder.start() : (gsiRecorder.stop(), gsiRecorder.status());
            return json(res, 200, { ok: true, recording: st });
          }
          case '/api/input/critical': {
            // Kritische Tasten ausdrücklich freigeben/zurücknehmen. Gilt nur lokal - ein Preset kann diese Liste nie setzen.
            let next;
            try { next = applyCriticalKeys(cfg, body.keys, body.declined); }
            catch (e) { return json(res, 400, { error: e.message }); }
            logger.info(`Kritische Tasten freigegeben: ${next.length ? next.join(', ') : 'keine'}.`);
            // Die Freigabe ändert, welche Aktionen gültig sind - beide Listen neu laden und prüfen.
            rt.actions = loadActions(cfg.game.profile); engine.setActions(rt.actions);
            rt.bitsActions = loadBitsActions(); engine.setBitsActions(rt.bitsActions);
            engine.emitState();
            return json(res, 200, { ok: true, criticalKeys: next });
          }
          case '/api/season/config': {
            // Season-Dauer - wirkt auch auf die laufende
            // Season, siehe config.js: applySeasonConfig().
            let next;
            try { next = applySeasonConfig(cfg, body); }
            catch (e) { return json(res, 400, { error: e.message }); }
            engine.refreshSeasonLength();
            engine.emitState();
            return json(res, 200, { ok: true, season: next });
          }
          case '/api/stats/session': {
            if (body.action === 'start') { const s2 = rt.stats.start('manual'); if (!s2) return json(res, 400, { error: 'Session Stats sind ausgeschaltet.' }); return json(res, 200, { ok: true, session: s2 }); }
            if (body.action === 'stop') return json(res, 200, { ok: true, session: rt.stats.stop('manual') });
            return json(res, 400, { error: 'action muss "start" oder "stop" sein.' });
          }
          case '/api/stats/fail': {
            const r = rt.stats.addFail('dashboard');
            return json(res, r.ok ? 200 : 409, r.ok ? r : { error: r.reason === 'no_session' ? 'Keine Sitzung aktiv.' : r.reason });
          }
          case '/api/stats/adjust': {
            const r = rt.stats.adjust(String(body.stat || ''), body.delta);
            return json(res, r.ok ? 200 : 400, r.ok ? r : { error: r.reason });
          }
          case '/api/stats/correct': {
            const r = rt.stats.correctDeath(body.id, body.cause);
            return json(res, r.ok ? 200 : 400, r.ok ? r : { error: r.reason });
          }
          case '/api/stats/config': {
            let next;
            try { next = applyStatsConfig(cfg, body); }
            catch (e) { return json(res, 400, { error: e.message }); }
            if (!next.enabled) rt.stats.stop('disabled');
            if (body.failHotkey !== undefined) rt.bridge.restartPanicWatcher?.();
            // Modusfilter wirkt sofort: der Adapter liest cfg.stats.excludeModes bei jedem Paket.
            engine.emitState();
            return json(res, 200, { ok: true, stats: next, failHotkey: cfg.bridge.failHotkey });
          }
          case '/api/season/end': {
            const winner = engine.finishSeason();
            return json(res, 200, { ok: true, winner });
          }
          case '/api/chat/config': {
            // Chat an/aus, welche Ankündigungen, Abklingzeit.
            let next;
            try { next = applyChatSettings(cfg, body); }
            catch (e) { return json(res, 400, { error: e.message }); }
            return json(res, 200, { ok: true, chat: next });
          }
          case '/api/chat/command/add': {
            let created;
            try { created = addChatCommand(cfg, body); }
            catch (e) { return json(res, 400, { error: e.message }); }
            return json(res, 200, { ok: true, command: created });
          }
          case '/api/chat/command/remove': {
            try { removeChatCommand(cfg, body.id); }
            catch (e) { return json(res, 400, { error: e.message }); }
            return json(res, 200, { ok: true });
          }
          case '/api/chat/command/toggle': {
            let next;
            try { next = setChatCommandEnabled(cfg, body.id, body.enabled); }
            catch (e) { return json(res, 400, { error: e.message }); }
            return json(res, 200, { ok: true, command: next });
          }
          case '/api/action/add': {
            let created;
            try {
              let builtEffect;
              if (body.builder) builtEffect = buildChecked(body.builder).built; // geprüft wie jeder andere Effekt
              created = addAction({ ...body, builtEffect }, cfg.game.profile);
            } catch (e) { return json(res, 400, { error: e.message }); }
            rt.actions = loadActions(cfg.game.profile);
            engine.setActions(rt.actions);
            let warning = null;
            try { await syncOne(twitch, rt.actions, created.id); rt.rewardMap = loadRewardMap(); engine.setRewardMap(rt.rewardMap); }
            catch (e) { warning = explain(e); }
            return json(res, 200, { ok: true, id: created.id, warning });
          }
          case '/api/action/delete': {
            // // ERST lokal entfernen (wirft für mitgelieferte/geschützte Aktionen - siehe removeAction()),
            // und NUR wenn das klappt, die Belohnung bei Twitch löschen. Vorher stand das in der
            // falschen Reihenfolge: eine abgelehnte Löschung (z. B. "mitgelieferte Aktion") löschte die
            // Twitch-Belohnung trotzdem schon, bevor der Fehler überhaupt zurückkam - die Aktion blieb
            // lokal bestehen, aber "verwaist" (keine zugehörige Belohnung mehr auf Twitch).
            try { removeAction(String(body.id), cfg.game.profile); }
            catch (e) { return json(res, 400, { error: e.message }); }
            let warning = null;
            try { await deleteRewardFor(twitch, String(body.id)); }
            catch (e) { warning = explain(e); } // Belohnung bei Twitch ggf. nicht löschbar, Aktion lokal trotzdem entfernt
            rt.actions = loadActions(cfg.game.profile);
            engine.setActions(rt.actions);
            rt.rewardMap = loadRewardMap();
            engine.setRewardMap(rt.rewardMap);
            return json(res, 200, { ok: true, warning });
          }
          case '/api/bits/action': {
            if (body.enabled && rt.bitsActions.byId.get(String(body.id))?.invalid) {
              return json(res, 400, { error: `Diese Bits-Stufe ist ungültig und bleibt aus: ${rt.bitsActions.byId.get(String(body.id)).invalid}` });
            }
            try { setBitsActionEnabled(String(body.id), !!body.enabled); }
            catch (e) { return json(res, 400, { error: e.message }); }
            rt.bitsActions = loadBitsActions();
            engine.setBitsActions(rt.bitsActions);
            return json(res, 200, { ok: true });
          }
          case '/api/bits/action/update': {
            try {
              const keys = Object.keys(body).filter((k) => k !== 'id');
              if (keys.length === 1 && keys[0] === 'cost') setBitsActionCost(String(body.id), body.cost);
              else updateAction('bits', String(body.id), { ...body, category: undefined, built: body.builder ? buildChecked(body.builder, { id: String(body.id), kind: 'bits' }).built : undefined });
            } catch (e) { return json(res, 400, { error: e.message }); }
            rt.bitsActions = loadBitsActions();
            engine.setBitsActions(rt.bitsActions);
            return json(res, 200, { ok: true });
          }
          case '/api/bits/action/add': {
            let created;
            try {
              let builtEffect;
              if (body.builder) builtEffect = buildChecked(body.builder).built; // geprüft wie jeder andere Effekt
              created = addBitsAction({ ...body, builtEffect });
            } catch (e) { return json(res, 400, { error: e.message }); }
            rt.bitsActions = loadBitsActions();
            engine.setBitsActions(rt.bitsActions);
            return json(res, 200, { ok: true, id: created.id });
          }
          case '/api/bits/action/delete': {
            try { removeBitsAction(String(body.id)); }
            catch (e) { return json(res, 400, { error: e.message }); }
            rt.bitsActions = loadBitsActions();
            engine.setBitsActions(rt.bitsActions);
            return json(res, 200, { ok: true });
          }
          case '/api/sync': {
            const result = await syncRewards(twitch, rt.actions);
            rt.rewardMap = loadRewardMap();
            engine.setRewardMap(rt.rewardMap);
            return json(res, 200, { ok: true, result });
          }
          case '/api/report': {
            // "Fehlerbericht erstellen": wie /api/diagnostics,
            // zusätzlich mit einem Freitextfeld ("was ist passiert?"), damit man nicht erst
            // per Rückfrage danach fragen muss.
            const note = String(body.note || '').trim().slice(0, 2000);
            const bundle = await buildDiagnostics();
            return json(res, 200, { ...bundle, note, createdAt: new Date().toISOString() });
          }
          default: return json(res, 404, { error: 'Unbekannt' });
        }
      }
      res.writeHead(404);
      res.end('Nicht gefunden');
    } catch (e) {
      const code = e.status || 500;
      if (code === 500) logger.error(`HTTP-Fehler: ${e.stack || e.message}`);
      if (!res.headersSent) json(res, code, { error: code === 500 ? 'Interner Fehler' : e.message });
      else res.end();
    }
  });

  const base = `http://localhost:${cfg.server.port}`;
  let relaunchTries = 0;
  server.on('error', (e) => {
    // Nach "Neustart" hält die alte Instanz den Port noch kurz: bis zu ~12 Sekunden erneut versuchen.
    if (e.code === 'EADDRINUSE' && process.env.UCC_RELAUNCHED === '1' && relaunchTries++ < 40) {
      setTimeout(() => server.listen(cfg.server.port, cfg.server.host), 300);
      return;
    }
    if (e.code === 'EADDRINUSE') {
      // Läuft schon: einfach das vorhandene Fenster öffnen statt abzubrechen.
      console.log(`\nChaosCore läuft schon (Port ${cfg.server.port}). Öffne das Fenster …\n`);
      // "/" leitet je nach Zustand der laufenden Instanz auf Dashboard oder Einrichtung (das Token im # bleibt erhalten)
      if (!quiet) openDashboard(`${base}/#token=${cfg.server.adminToken}`, cfg.server.dashboardMode, path.join(DATA, 'app-profile'));
      setTimeout(() => process.exit(0), 600);
      return;
    }
    die(`Server-Fehler: ${e.message}`);
  });

  await new Promise((resolve) => { server.once('listening', resolve); server.listen(cfg.server.port, cfg.server.host); });

  const ready = await readiness(cfg);
  if (ready.ok) await startServices();
  else { rt.reason = ready.reason; logger.info(`Erst-Einrichtung nötig: ${ready.reason}`); }

  printBanner();
  // nach "Neu starten" im Dashboard KEIN neues
  // Fenster öffnen - das bestehende lädt sich selbst neu (dashboard.html), und ein neues Fenster nahm
  // CS2 mitten im Stream den Fokus. Der primäre Fokus bleibt beim Spiel.
  const relaunched = process.env.UCC_RELAUNCHED === '1';
  if (relaunched) logger.info('Neu gestartet - das Dashboard lädt sich selbst neu, es wird kein neues Fenster geöffnet (das Spiel behält den Fokus).');
  if (!quiet && cfg.server.openDashboard && !relaunched) {
    openDashboard(`${base}/${rt.ready ? 'dashboard' : 'setup'}#token=${cfg.server.adminToken}`, cfg.server.dashboardMode, path.join(DATA, 'app-profile'));
  }

  function printBanner() {
    const line = '\x1b[35m==============================================================\x1b[0m';
    if (!rt.ready) {
      console.log(`
${line}
 \x1b[1m${cfg.overlay.brand} CHAT CONTROL\x1b[0m · Einrichtung
 Das Setup-Fenster öffnet sich automatisch.
 Falls nicht: ${base}/setup
${line}
`);
      return;
    }
    console.log(`
${line}
 \x1b[1m${cfg.overlay.brand} CHAT CONTROL\x1b[0m läuft für Kanal \x1b[1m${cfg.twitch.login}\x1b[0m
 OBS-Overlay : ${base}/overlay   (Browser-Quelle, 1920x1080)
 Dashboard   : ${base}/dashboard   (öffnet sich automatisch; erneut öffnen: npm run dashboard)
 Not-Aus     : Dashboard-Knopf und Hotkey ${cfg.bridge.panicHotkey} (Hotkey nur mit AutoHotkey)
 Effekte     : ${rt.bridge.kind === 'ahk' ? 'AutoHotkey (echt)' : 'Simulation'}
${line}
`);
  }

  async function shutdown(sig) {
    logger.info(`${sig} empfangen, fahre herunter.`);
    if (rt.ready) {
      try { await rt.engine.panic('Programm beendet'); } catch { /* egal */ }
      if (rt.bridge.kind === 'ahk') await new Promise((r) => setTimeout(r, 1200)); // Maustasten/Crosshair im Spiel wiederherstellen
      rt.engine.close(); rt.highlights?.close(); rt.stats?.close(); rt.twitch.close(); rt.bridge.close(); rt.db.close();
    }
    server.close();
    setTimeout(() => process.exit(0), 300).unref();
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (e) => logger.error(`Unbehandelter Fehler: ${e?.stack || e}`));
  // Absturzsicheres Loggen: ohne diesen Handler hätte Node bei einem
  // echten unbehandelten (synchronen) Fehler nur den rohen Stack ins (dann ggf. schon
  // geschlossene) Terminal-Fenster geschrieben und wäre sofort beendet worden - die letzte Zeile
  // vor dem Absturz stand NIE im Protokoll. logger.error() schreibt synchron auf die Festplatte
  // (siehe log.js), die Zeile steht also sicher dort, bevor der Prozess hier bewusst beendet wird.
  process.on('uncaughtException', (e) => {
    logger.error(`Unbehandelter Absturz: ${e?.stack || e}`);
    process.exit(1);
  });
  // Nur für den Test der absturzsicheren Protokollierung - löst
  // absichtlich einen echten unbehandelten Fehler aus, um den obigen Handler zu prüfen; in
  // Produktion nie gesetzt.
  if (process.env.UCC_TEST_CRASH === '1') setTimeout(() => { throw new Error('Testabsturz (UCC_TEST_CRASH)'); }, 300);
}

main().catch((e) => die(e.stack || e.message));
