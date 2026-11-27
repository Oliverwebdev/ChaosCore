// Konfiguration, Pfade und Dateizugriff. Keine externen Abhängigkeiten.
import { BITS_MENU_DEFAULT, normalizeBitsMenu } from './bits-menu.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { product } from './product.js';
import { validateAction, compile } from './steps.js';
import { actionProblem, actionsFileProblem, ACCESS_LEVELS } from './validate.js';
import { getProfile, isKnownProfile, profileIds } from './games/index.js';
import { classifyKey, criticalGroup, CRITICAL_KEY_NAMES } from './keys.js';
import { cryptoAvailable, protect, unprotect } from './secret-store.js';
import { HIGHLIGHT_DEFAULT, normalizeHighlights, normalizeCustomTitles } from './highlights.js';
import { STREAM_EVENTS_DEFAULT, normalizeStreamEvents, EVENT_SCOPES } from './stream-events.js';
import { OBS_DEFAULT, normalizeObs, SYSTEM_DEFAULT, normalizeSystem, checkProgramTarget } from './system-config.js';
import { LOCAL_CLIPS_DEFAULT, normalizeLocalClips } from './local-clips.js';
import { UPLOADS_DEFAULT, normalizeUploads } from './upload-settings.js';
import { AI_DEFAULT, normalizeAi } from './ai-settings.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = process.env.UCC_DATA_DIR ? path.resolve(process.env.UCC_DATA_DIR) : path.join(ROOT, 'data');
const CONFIG_FILE = path.join(DATA, 'config.json');
const TOKEN_FILE = path.join(DATA, 'tokens.json');
const REWARD_FILE = path.join(DATA, 'rewards.json');
const BITS_FILE = path.join(DATA, 'actions-bits.json');
const BITS_DEFAULT = path.join(ROOT, 'config', 'actions-bits.default.json');
const UPLOADS_DIR = path.join(DATA, 'uploads');

// eigene Overlay-Sounds/-Bilder. Die Datei selbst liegt in data/uploads/
// (nicht in config.json - das würde die Konfiguration unnötig aufblähen), cfg.overlay trägt nur die
// Metadaten (Name, Mime-Typ, Dateiname). Nur beim Export/Import (siehe exportProfile/importProfile
// unten) wird die Datei zusätzlich als Base64 eingebettet, damit ein Preset als EINE Datei geteilt
// werden kann.
const OVERLAY_ASSET_MAX_BYTES = 900 * 1024; // knapp unter 1 MB roh, bewusst klein gehalten
const OVERLAY_ASSET_MIME = {
  sound: ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm'],
  image: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
};
const OVERLAY_ASSET_EXT = {
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/webm': 'weba',
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
};

// Aktionen-Dateien sind pro Spiel-Profil getrennt. "cs2" behält
// bewusst exakt die alten Dateinamen, damit ein bestehender Nutzer beim Update nichts verliert
// oder migrieren muss. Ein neues Profil bekommt eigene Dateien nach demselben Muster.
function actionsFile(profileId = 'cs2') {
  return path.join(DATA, profileId === 'cs2' ? 'actions.json' : `actions-${profileId}.json`);
}
function actionsDefaultFile(profileId = 'cs2') {
  return path.join(ROOT, 'config', profileId === 'cs2' ? 'actions.default.json' : `actions.${profileId}.default.json`);
}

// bits:read wird für Cheer-EventSub gebraucht (Bits-Belohnungen). Bestehende Logins müssen sich
// einmal neu einloggen ("npm run login"), damit der Scope dazukommt.
// SCOPES bleibt die STRENGE Mindestanforderung zum Starten (readiness() in server.js, Doctor/Setup-
// Abschluss) - unverändert, damit ein bestehender Login nach einem Update weiterläuft, ohne sich
// neu einloggen zu müssen. Zugriffsregeln (Abo/VIP/Mod) brauchen drei zusätzliche, rein lesende Scopes - die sind bewusst NICHT Teil von SCOPES,
// sondern nur von LOGIN_SCOPES (bei einem Login/"npm run login" mit angefragt): ohne sie startet
// ChaosCore ganz normal weiter, nur Aktionen mit einer solchen Zugriffsregel würden dann nie
// zutreffen (checkAccess() in engine.js schlägt fehl -> sicherer Standard: ablehnen statt erlauben).
export const SCOPES = 'channel:read:redemptions channel:manage:redemptions bits:read';
export const ACCESS_SCOPES = 'moderation:read channel:read:vips channel:read:subscriptions';
// Chat lesen (Befehle erkennen) und selbst schreiben (Ankündigungen,
// Befehls-Antworten). Genauso wie ACCESS_SCOPES bewusst NICHT Teil von SCOPES - ein bestehender
// Login funktioniert nach einem Update ohne erneutes Einloggen weiter, nur die Chat-Funktion
// selbst bleibt dann inaktiv (cfg.chat.enabled hat ohnehin keine Wirkung ohne diese Scopes, siehe
// engine.js: onChatMessage/announce* - ein fehlender Scope führt zu einer weichen Warnung beim
// Abonnieren, siehe twitch.js: subscribe(), statt den Start zu blockieren).
export const CHAT_SCOPES = 'user:read:chat user:write:chat';
// Highlights (Stream-Marker, Clips) und Stream-Infos (Titel, Kategorie, Tags) aus ChaosCore heraus.
// Wie Chat: fehlt der Scope bei einem älteren Login, bleibt nur diese Funktion aus (Hinweis im Dashboard).
export const HIGHLIGHT_SCOPES = 'channel:manage:broadcast clips:edit';
export { EVENT_SCOPES };
export const LOGIN_SCOPES = `${SCOPES} ${ACCESS_SCOPES} ${CHAT_SCOPES} ${HIGHLIGHT_SCOPES} ${EVENT_SCOPES}`;
// Eingebaute Bremse: Obergrenze gleichzeitig aktiver, selbst angelegter
// Chat-Befehle - verhindert eine endlos wachsende Liste, die den Chat bei vielen Auslösungen
// zuspammen könnte. Der eingebaute Statistik-Befehl zählt NICHT dazu (fest im Code, kein Eintrag
// in cfg.chat.commands).
export const CHAT_MAX_COMMANDS = 30;
// Fest eingebauter Statistik-Befehl
// - bewusst NICHT lokalisiert/umbenennbar, damit er in jeder Sprache gleich funktioniert und nie
// mit einem eigenen Befehl kollidieren kann (siehe addChatCommand: diese Kennung ist reserviert).
export const CHAT_STATS_TRIGGER = '!chaosstats';

export const DEFAULTS = {
  version: 1,
  twitch: { clientId: product.twitchClientId, userId: '', login: '' }, // eine in product.json fest eingebaute ID überspringt den Client-ID-Schritt
  server: { host: '127.0.0.1', port: 7788, gsiToken: '', adminToken: '', openDashboard: true, dashboardMode: 'app', locale: 'de', localeSet: false }, // 'app' = eigenes schlankes Fenster, 'browser' = normaler Browser. locale: 'de'/'en' (einmalig aus dem Installer übernommen, siehe locale.txt); localeSet merkt, ob das schon passiert ist, damit ein späterer manueller Wechsel nicht wieder überschrieben wird.
  game: {
    profile: 'cs2',            // Spiel-Profil (siehe src/games/index.js) - "cs2" ist der bisherige, unveränderte Standard
    requireGameState: false, requireFocus: true, cs2CfgDir: '', windowExe: 'cs2.exe',
    sensitivity: 1.0,          // deine CS2-Mausempfindlichkeit (Konsole: sensitivity). Wichtig für "UNKNOWN entdeckt dich".
    crosshairAlpha: 255,       // Crosshair-Deckkraft, auf die nach "Crosshair unsichtbar" zurückgestellt wird
    crosshairSize: 5,          // Ersatzwert für deine Linienlänge (cl_crosshair_length), falls ChaosCore dein Fadenkreuz nicht aus CS2 lesen kann
    crosshairBigSize: 80,      // Größe für "Fadenkreuz riesig"
    mPitch: 0.022,             // deine normale vertikale Mausempfindlichkeit (Konsole: m_pitch), auf die nach "Maus invertieren" zurückgestellt wird
    // Deine normale Fadenkreuz-Farbe (Konsole: cl_crosshaircolor_r / _g / _b), auf die nach
    // "Zufällige Crosshair-Farbe" zurückgestellt wird.
    // Standard = CS2-Standardfarbe Grün.
    crosshairColor: [50, 250, 50],
    restoreMouseBinds: true,   // Sicherheitsnetz: bindet Maustasten beim Laden der cfg auf Standard (mouse1/mouse2) zurück
  },
  bridge: { type: 'auto', ahkPath: '', panicHotkey: '^!End', failHotkey: '^!f' }, // failHotkey: Session Stats, leer = aus
  // Deine Tasten in CS2 (AutoHotkey-Namen). Anpassen, falls du sie umgebaut hast.
  keys: {
    primary: '1', secondary: '2', knife: '3', grenades: '4', c4: '5',
    last: 'q', walk: 'Shift', use: 'e', drop: 'g', duck: 'LCtrl', inspect: 'f',
    flash: '7',                              // deine Taste für die Blendgranate
    forward: 'w', left: 'a', back: 's', right: 'd',
    jump: 'Space', scoreboard: 'Tab', buy: 'b', // Standard-CS2-Tasten für Springen, Scoreboard und Kaufmenü
    // Interne Binds (Nummernblock, weil Source/CS2 F13-F24 nicht kennt). Nur ändern, wenn du sie selbst belegt hast.
    gHe: 'Numpad7', gFlash: 'Numpad8', gSmoke: 'Numpad9', gMolly: 'Numpad4', gDecoy: 'Numpad5',
    xhOff: 'Numpad1', xhOn: 'Numpad2', xhColor: 'Numpad3',
    fireOff: 'NumpadDiv', fireOn: 'NumpadMult', zoomOff: 'NumpadSub', zoomOn: 'NumpadAdd',
    // Fadenkreuz riesig, Maus invertieren und deren gemeinsame Wiederherstellung (nur eine Aktion läuft je gleichzeitig)
    xhBig: 'Numpad0', mouseInv: 'NumpadEnter', restoreExtra: 'NumpadDot',
    // Eigener Bind für 'letzte Waffe' (lastinv) - unabhängig davon, was der Streamer auf Q gelegt hat.
    lastInv: 'Numpad6',
  },
  // queueWaitSec: 0 (Standard, bisheriges Verhalten) = bei voller
  // Warteschlange sofort erstatten; >0 = bis zu so viele Sekunden auf einen freien Platz warten,
  // bevor erstattet wird. Ein bestehender Nutzer merkt beim Update nichts (Standard = altes Verhalten).
  engine: { maxQueue: 3, holdTimeoutSec: 180, roundMaxSec: 125, autoRefund: true, queueWaitSec: 0 },
  contract: { distinctViewers: 2 },
  overlay: { sound: true, brand: product.brand, accent: product.accent, history: true, top: true, historyCount: 5, topCount: 5, topMode: 'both', topRotateSec: 12, reduceFlash: false, layout: {}, hidden: [], styles: {}, customCss: '', customSound: null, customImage: null }, // layout: { panelId: { x, y } } in Prozent (0-100), per Drag & Drop im Dashboard gesetzt. Fehlt ein Panel hier, bleibt es bei seiner festen Standardposition im Overlay-CSS. customSound/customImage: { name, mime, filename } oder null - die Datei selbst liegt in data/uploads/, siehe setOverlayAsset().
  season: { lengthDays: 7 }, // Zeitraum für das Season-Chaos-Score-Ranking (Alleinstellungsmerkmal ggü. Crowd Control); läuft automatisch ab, im Dashboard auch jederzeit von Hand eine neue Season starten.
  // das bisher fest "Chaos Overload" genannte Ziel bei 100% ist jetzt ein
  // frei benennbares, aus mehreren Schwellen bestehendes "Community-Ziel" - die Standard-Einstellung
  // hier entspricht exakt dem bisherigen, immer schon vorhandenen Verhalten (eine Schwelle bei 100,
  // zufälliger Effekt aus dem Pool, zählt Punkte UND Bits zusammen), damit ein bestehender Nutzer
  // beim Update ohne jede Änderung weiterläuft. basis: 'points' | 'bits' | 'both'. Jede Schwelle:
  // { id, name, value, actionId } - actionId: null heißt "zufälliger Effekt aus dem aktivierten Pool"
  // (wie bisher), sonst eine feste, vom Streamer gewählte Aktions-ID (Kanalpunkte- oder Bits-Pool).
  communityGoal: { name: 'Chaos Overload', basis: 'both', thresholds: [{ id: 'overload', name: 'Chaos Overload', value: 100, actionId: null }] },
  // Verantwortung als Produktmerkmal, nicht nur Text im Kleingedruckten:
  // riskAcknowledgedAt wird einmalig beim Setup gesetzt (kein Start ohne diese Zustimmung, siehe
  // readiness() in server.js) - gilt einheitlich für jedes Spiel-Profil, auch zukünftige.
  consent: { riskAcknowledgedAt: null },
  // kritische Tasten (Enter, Escape, Alt, ... -
  // siehe src/keys.js) dürfen in lokalen Aktionen erst verwendet werden, nachdem sie hier
  // ausdrücklich freigegeben wurden. Wird NIE aus einem Preset importiert.
  // KEINE stillschweigende Freigabe beim Update. Wer schon vorher
  // selbst eine kritische Taste belegt hatte, behält die Belegung, wird aber im Dashboard gefragt
  // (siehe pendingCriticalKeys). criticalDeclined: Gruppen, zu denen der Nutzer "nein" gesagt hat -
  // nur damit die Nachfrage nicht bei jedem Start wiederkommt.
  input: { criticalKeys: [], criticalDeclined: [] },
  // "Auto-Lebendig" - wenn eine einstellbare Zeit lang niemand etwas
  // ausgelöst hat, darf ChaosCore optional selbst eine harmlose Aktion aus einer eigens dafür
  // gewählten Whitelist auslösen (nie aus dem vollen Aktions-Pool). Standardmäßig AUS und mit
  // leerer Whitelist, damit ein bestehender Nutzer beim Update ohne jede Verhaltensänderung
  // weiterläuft. idleSec: Sekunden ohne echte Einlösung, bis ausgelöst wird.
  autoIdle: { enabled: false, idleSec: 300, whitelist: [] },
  // ChaosCore meldet sich selbst im Chat (ausgelöster Effekt, Season
  // endet in Kürze, neuer Season-Sieger) und beantwortet eigene, statische Befehle - bewusst KEIN
  // Nachbau von Nightbot/StreamElements (keine Moderation, keine Verlosungen). Standardmäßig AUS
  // (braucht ohnehin die optionalen CHAT_SCOPES, siehe oben), damit ein bestehender Nutzer beim
  // Update ohne Verhaltensänderung weiterläuft. commands: [{ id, trigger, response, enabled }].
  chat: { enabled: false, announceEffect: true, announceSeasonEndingSoon: true, announceSeasonWinner: true, cooldownSec: 10, commands: [] },
  // Bits-Menü (bits-menu.js): 100 Bits = 1 Minute, Stichwort in der Cheer-Nachricht wählt den Effekt.
  bitsMenu: structuredClone(BITS_MENU_DEFAULT),
  // Bits-Guthaben: nicht gelaufene Bits-Zeit läuft automatisch weiter (autoResume) und der Zuschauer
  // bekommt im Chat Bescheid (announce, nur wenn die Chat-Funktion an ist).
  bitsCredit: { autoResume: true, announce: true },
  // Bits-Vorrang: Bits-Effekte laufen vor wartenden Kanalpunkte-Effekten. Kanalpunkte-Schutz: nach
  // maxInRow Bits-Effekten hintereinander ist ein Kanalpunkte-Effekt dran, und keiner wartet länger
  // als maxWaitSec.
  bitsPriority: { enabled: true, maxInRow: 2, maxWaitSec: 180 },
  // Spielmodus-Sperre (CS2, über den Spielzustand): in diesen Modi laufen keine Effekte, weil dort
  // fremde Mitspieler mitverlieren würden. Kanalpunkte werden erstattet, Bits gutgeschrieben.
  modeLock: { enabled: true, blocked: ['competitive', 'scrimcomp2v2', 'premier'] },
  // Gesperrte Zuschauer: lösen keine Effekte aus (Kanalpunkte zurück, Bits als Guthaben zur Entscheidung).
  viewers: { blocked: [] },
  highlights: structuredClone(HIGHLIGHT_DEFAULT),
  // Raid/Follow/Sub/Hype Train als Auslöser (stream-events.js), Standard: alles aus.
  events: structuredClone(STREAM_EVENTS_DEFAULT),
  // OBS-WebSocket (lokale Clips, System-Aktionen). Passwort liegt getrennt in data/obs-secret.json.
  obs: structuredClone(OBS_DEFAULT),
  // Lokale Clips über den OBS-Wiederholungspuffer (local-clips.js)
  localClips: structuredClone(LOCAL_CLIPS_DEFAULT),
  uploads: structuredClone(UPLOADS_DEFAULT),
  ai: structuredClone(AI_DEFAULT),
  // System-Aktionen (Experte, system-actions.js): nie in Presets/Exporten
  system: structuredClone(SYSTEM_DEFAULT),
  // Updates: 'auto' = Vorabversionen nur anbieten, wenn schon eine Vorabversion installiert ist.
  updates: { channel: 'auto' },
  // Session Stats. autoStream: Sitzung startet/endet mit dem Stream.
  // chaosWindowSec: so lange nach Effekt-Ende zählt ein Tod noch als "durch Chaos". excludeModes:
  // Spielmodi (CS2: map.mode, z. B. "deathmatch"), die nicht gezählt werden - Warmup zählt nie.
  // show: welche Werte Dashboard-Kacheln und Overlay-Leiste zeigen (Reihenfolge = Anzeige).
  // failCommand: "!fail" im Chat (nur Mods/Streamer). announceChaosDeath: Chat-Meldung bei Chaos-Tod
  // (nur wenn der Chat eingeschaltet ist).
  stats: { enabled: true, autoStream: true, chaosWindowSec: 5, streakMin: 3, excludeModes: [],
    show: ['kills', 'deaths', 'kd', 'fails', 'deathsChaos'], failCommand: true, failCooldownSec: 3, announceChaosDeath: true,
    // Overlay-Teil (Panel "stats" im Layout-Editor): Design und
    // welche Elemente sichtbar sind.
    overlayTheme: 'unknown', overlay: { bar: true, split: true, torture: true, popups: true } },
};

function merge(base, extra) {
  for (const [k, v] of Object.entries(extra || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') merge(base[k], v);
    else base[k] = v;
  }
  return base;
}

export function ensureData() {
  fs.mkdirSync(DATA, { recursive: true });
}

export function configExists() {
  return fs.existsSync(CONFIG_FILE);
}

export function loadConfig() {
  ensureData();
  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`data/config.json ist kaputt: ${e.message}`);
  }
  const cfg = merge(structuredClone(DEFAULTS), user);
  let dirty = false;
  for (const k of ['gsiToken', 'adminToken']) {
    if (!cfg.server[k]) { cfg.server[k] = crypto.randomBytes(16).toString('hex'); dirty = true; }
  }
  validatePortable(cfg);
  if (!Number.isInteger(cfg.server.port) || cfg.server.port < 1024 || cfg.server.port > 65535) throw new Error('server.port muss zwischen 1024 und 65535 liegen.');
  if (!/^[A-Za-z0-9.:-]{1,64}$/.test(cfg.server.host)) throw new Error('server.host ist ungültig.');
  try { cfg.overlay.hidden = normalizeHidden(cfg.overlay.hidden); } catch { cfg.overlay.hidden = []; }
  if (!['auto', 'stable', 'beta'].includes(cfg.updates?.channel)) cfg.updates = { channel: 'auto' };
  cfg.bitsCredit = { autoResume: cfg.bitsCredit?.autoResume !== false, announce: cfg.bitsCredit?.announce !== false };
  try { cfg.bitsPriority = normalizeBitsPriority(cfg.bitsPriority); } catch { cfg.bitsPriority = structuredClone(DEFAULTS.bitsPriority); }
  try { cfg.modeLock = normalizeModeLock(cfg.modeLock); } catch { cfg.modeLock = structuredClone(DEFAULTS.modeLock); }
  cfg.highlights = normalizeHighlights(cfg.highlights);
  cfg.events = normalizeStreamEvents(cfg.events);
  // 2.0: Fortnite-Profil entfernt - frühere Fortnite-Einstellung wird wieder CS2.
  if (cfg.game?.profile && !isKnownProfile(cfg.game.profile)) { cfg.game.profile = 'cs2'; dirty = true; }
  cfg.obs = normalizeObs(cfg.obs);
  cfg.localClips = normalizeLocalClips(cfg.localClips);
  cfg.uploads = normalizeUploads(cfg.uploads);
  cfg.ai = normalizeAi(cfg.ai);
  cfg.system = normalizeSystem(cfg.system, { profiles: profileIds() });
  cfg.viewers = { blocked: (Array.isArray(cfg.viewers?.blocked) ? cfg.viewers.blocked : [])
    .filter((v) => v && typeof v.id === 'string' && v.id.length <= 64).slice(0, 500).map((v) => ({ id: v.id, name: String(v.name || '').slice(0, 40) })) };
  try { cfg.overlay.styles = normalizeStyles(cfg.overlay.styles); } catch { cfg.overlay.styles = {}; }
  if (typeof cfg.overlay.customCss !== 'string') cfg.overlay.customCss = '';
  try { cfg.bitsMenu = normalizeBitsMenu(cfg.bitsMenu); } catch (e) { console.warn(`Bits-Menü ungültig, Standard wird benutzt: ${e.message}`); cfg.bitsMenu = normalizeBitsMenu(BITS_MENU_DEFAULT); }
  // Früher gab es nur den Schalter "Verlauf anzeigen" - der lebt jetzt als ausgeblendetes Fenster weiter.
  if (cfg.overlay.history === false) { cfg.overlay.hidden = normalizeHidden([...cfg.overlay.hidden, 'history']); cfg.overlay.history = true; }
  try { cfg.stats = normalizeStats(cfg.stats); } catch (e) { console.warn(`stats-Einstellungen ungültig, Standard wird benutzt: ${e.message}`); cfg.stats = structuredClone(DEFAULTS.stats); }
  if (!['de', 'en'].includes(cfg.server.locale)) cfg.server.locale = 'de'; // unbekannter Wert -> sicherer Standard statt Absturz
  if (dirty) saveConfig(cfg);
  return cfg;
}

// Prüft den Teil von cfg, der auch Teil eines exportierten/importierten Profils ist
// (Tasten, Spiel-Einstellungen, Overlay, Not-Aus-Hotkey) — ohne Server/Host/Port (maschinenspezifisch).
// Wirft bei einem ungültigen Wert; verändert cfg sonst in-place auf die normalisierten Werte.
export function validatePortable(cfg) {
  if (!isKnownProfile(cfg.game.profile)) throw new Error(`game.profile ist unbekannt: "${cfg.game.profile}". Erlaubt: ${profileIds().join(', ')}.`);
  validateKeys(cfg.keys, cfg.game.profile);
  if (!['both', 'today', 'all'].includes(cfg.overlay.topMode)) throw new Error('overlay.topMode muss "both", "today" oder "all" sein.');
  cfg.overlay.topRotateSec = Math.min(120, Math.max(4, Number(cfg.overlay.topRotateSec) || 12));
  const sens = Number(cfg.game.sensitivity);
  if (!(sens > 0 && sens <= 30)) throw new Error('game.sensitivity muss eine Zahl zwischen 0.01 und 30 sein (deine CS2-Mausempfindlichkeit).');
  cfg.game.sensitivity = sens;
  const alpha = Number(cfg.game.crosshairAlpha);
  if (!Number.isInteger(alpha) || alpha < 1 || alpha > 255) throw new Error('game.crosshairAlpha muss zwischen 1 und 255 liegen.');
  const xhSize = Number(cfg.game.crosshairSize);
  if (!(xhSize >= 1 && xhSize <= 50)) throw new Error('game.crosshairSize muss zwischen 1 und 50 liegen.');
  cfg.game.crosshairSize = xhSize;
  const xhBigSize = Number(cfg.game.crosshairBigSize);
  if (!(xhBigSize >= 1 && xhBigSize <= 200)) throw new Error('game.crosshairBigSize muss zwischen 1 und 200 liegen.');
  cfg.game.crosshairBigSize = xhBigSize;
  const mPitch = Number(cfg.game.mPitch);
  if (!(mPitch > 0 && mPitch <= 1)) throw new Error('game.mPitch muss größer als 0 und höchstens 1 sein (CS2-Standard: 0.022).');
  cfg.game.mPitch = mPitch;
  const xc = cfg.game.crosshairColor;
  if (!Array.isArray(xc) || xc.length !== 3 || xc.some((v) => !Number.isInteger(v) || v < 0 || v > 255)) {
    throw new Error('game.crosshairColor muss drei ganze Zahlen von 0 bis 255 sein (Rot, Grün, Blau), z. B. [50, 250, 50].');
  }
  if (!/^[A-Za-z0-9_.-]{1,40}$/.test(cfg.game.windowExe)) throw new Error('game.windowExe ist ungültig.');
  if (!Array.isArray(cfg.input?.criticalKeys) || cfg.input.criticalKeys.some((k) => !CRITICAL_KEY_NAMES.includes(k))) {
    throw new Error(`input.criticalKeys darf nur diese Tasten enthalten: ${CRITICAL_KEY_NAMES.join(', ')}.`);
  }
  cfg.input.criticalKeys = [...new Set(cfg.input.criticalKeys)];
  if (!Array.isArray(cfg.input.criticalDeclined)) cfg.input.criticalDeclined = [];
  cfg.input.criticalDeclined = [...new Set(cfg.input.criticalDeclined.filter((k) => CRITICAL_KEY_NAMES.includes(k) && !cfg.input.criticalKeys.includes(k)))];
  if (!/^[\^!+#]*[A-Za-z0-9]+$/.test(cfg.bridge.panicHotkey)) throw new Error('bridge.panicHotkey ist ungültig (z. B. ^!End).');
  if (cfg.bridge.failHotkey === undefined || cfg.bridge.failHotkey === null) cfg.bridge.failHotkey = '';
  if (cfg.bridge.failHotkey !== '' && !/^[\^!+#]*[A-Za-z0-9]+$/.test(cfg.bridge.failHotkey)) throw new Error('bridge.failHotkey ist ungültig (z. B. ^!f, leer = aus).');
  if (cfg.bridge.failHotkey && cfg.bridge.failHotkey.toLowerCase() === cfg.bridge.panicHotkey.toLowerCase()) throw new Error('Fail-Hotkey und Not-Aus-Hotkey dürfen nicht gleich sein.');
  const seasonDays = Math.round(Number(cfg.season?.lengthDays));
  if (!(seasonDays >= 1 && seasonDays <= 90)) throw new Error('season.lengthDays muss zwischen 1 und 90 liegen.');
  cfg.season.lengthDays = seasonDays;
  const idleSec = Math.round(Number(cfg.autoIdle?.idleSec));
  if (!(idleSec >= 30 && idleSec <= 3600)) throw new Error('autoIdle.idleSec muss zwischen 30 und 3600 liegen.');
  cfg.autoIdle.idleSec = idleSec;
  // Warteschlangen-Politik.
  const maxQueue = Math.round(Number(cfg.engine?.maxQueue));
  if (!(maxQueue >= 1 && maxQueue <= 50)) throw new Error('engine.maxQueue muss zwischen 1 und 50 liegen.');
  cfg.engine.maxQueue = maxQueue;
  const queueWaitSec = Math.round(Number(cfg.engine?.queueWaitSec));
  if (!(queueWaitSec >= 0 && queueWaitSec <= 120)) throw new Error('engine.queueWaitSec muss zwischen 0 und 120 liegen.');
  cfg.engine.queueWaitSec = queueWaitSec;
}

export function saveConfig(cfg) {
  ensureData();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// Overlay-Einstellungen aus dem Dashboard übernehmen (Farbe, Verlauf/Top an/aus, Anzahl, Modus, Sound).
// Ändert cfg direkt (dieselbe Referenz, die Engine/Server halten) und speichert.
export function applyOverlayConfig(cfg, patch) {
  const accent = String(patch.accent ?? cfg.overlay.accent);
  if (!/^#[0-9a-f]{6}$/i.test(accent)) throw new Error('Farbe muss ein Hex-Code sein, z. B. #B026FF.');
  const topMode = String(patch.topMode ?? cfg.overlay.topMode);
  if (!['both', 'today', 'all'].includes(topMode)) throw new Error('Top-Modus muss "both", "today" oder "all" sein.');
  const topRotateSec = Math.min(120, Math.max(4, Number(patch.topRotateSec ?? cfg.overlay.topRotateSec) || 12));
  const historyCount = Math.min(15, Math.max(1, Math.round(Number(patch.historyCount ?? cfg.overlay.historyCount) || 5)));
  const topCount = Math.min(15, Math.max(1, Math.round(Number(patch.topCount ?? cfg.overlay.topCount) || 5)));
  Object.assign(cfg.overlay, {
    accent,
    sound: patch.sound !== undefined ? !!patch.sound : cfg.overlay.sound,
    history: true, // Sichtbarkeit des Verlaufs steuert jetzt overlay.hidden
    top: patch.top !== undefined ? !!patch.top : cfg.overlay.top,
    reduceFlash: patch.reduceFlash !== undefined ? !!patch.reduceFlash : cfg.overlay.reduceFlash,
    historyCount, topCount, topMode, topRotateSec,
  });
  if (patch.history !== undefined) {
    const h = new Set(cfg.overlay.hidden || []);
    if (patch.history) h.delete('history'); else h.add('history');
    cfg.overlay.hidden = normalizeHidden([...h]);
  }
  saveConfig(cfg);
  return cfg.overlay;
}

// Welche Overlay-Panels per Drag & Drop im Dashboard verschiebbar sind. Transiente Effekte
// (Alert, Rad, Toast) sind absichtlich nicht verschiebbar — die sind zentriert/eventgesteuert,
// kein feststehendes Panel.
export const LAYOUT_PANELS = ['chaos', 'queue', 'history', 'hall', 'effect', 'season', 'stats', 'bits'];

// Layout-Positionen (Drag & Drop im Dashboard) übernehmen. layout: { panelId: { x, y, scale } },
// x/y in Prozent (0-100) der 1920x1080-Overlay-Fläche, oben-links verankert. scale ist optional, 0.5-2.0, Standard 1 -
// bewusst vom Positions-Feature getrennt gehalten, aber in
// derselben Struktur, weil beides zusammen im Layout-Editor bedient wird. Ein Panel, das hier
// fehlt, bleibt bei seiner festen CSS-Standardposition/-größe in overlay.html — nichts bricht für
// Leute, die nie etwas verschieben/skalieren. Ersetzt das gesamte Layout-Objekt (nicht nur
// einzelne Panels), weil das Dashboard immer den vollständigen aktuellen Stand mitschickt.
export function applyOverlayLayout(cfg, layout) {
  cfg.overlay.layout = normalizeLayout(layout);
  saveConfig(cfg);
  return cfg.overlay.layout;
}

export function applyBitsCredit(cfg, patch) {
  for (const k of ['autoResume', 'announce']) if (patch && typeof patch[k] === 'boolean') cfg.bitsCredit[k] = patch[k];
  saveConfig(cfg);
  return cfg.bitsCredit;
}

export function applyBitsMenu(cfg, patch) {
  const next = { ...cfg.bitsMenu };
  for (const k of ['enabled', 'bitsPerMinute', 'maxMinutes', 'maxPerStream', 'noKeyword', 'items', 'custom', 'challenge', 'pot']) if (patch && patch[k] !== undefined) next[k] = patch[k];
  cfg.bitsMenu = normalizeBitsMenu(next);
  saveConfig(cfg);
  return cfg.bitsMenu;
}

export function applyUpdateChannel(cfg, channel) {
  if (!['auto', 'stable', 'beta'].includes(channel)) throw new Error('Update-Kanal muss "auto", "stable" oder "beta" sein.');
  cfg.updates = { ...(cfg.updates || {}), channel };
  saveConfig(cfg);
  return cfg.updates;
}

// Aussehen einzelner Overlay-Fenster. Feste Regler statt freiem Code, damit geteilte Presets das
// Overlay nicht beliebig verändern können. Eigenes CSS gibt es zusätzlich, aber nur lokal (wird
// weder exportiert noch importiert).
export const STYLE_PANELS = ['chaos', 'queue', 'history', 'hall', 'effect', 'season', 'bits'];
export function normalizeStyles(styles) {
  if (styles === null || styles === undefined) return {};
  if (typeof styles !== 'object' || Array.isArray(styles)) throw new Error('styles muss ein Objekt sein.');
  const out = {};
  for (const [id, st] of Object.entries(styles)) {
    if (!STYLE_PANELS.includes(id)) throw new Error(`Unbekanntes Overlay-Fenster für Stil: ${String(id).slice(0, 30)}`);
    if (!st || typeof st !== 'object') throw new Error(`Stil für "${id}" ist ungültig.`);
    const theme = st.theme ?? 'unknown';
    if (!['unknown', 'dark', 'light', 'glass'].includes(theme)) throw new Error(`Design für "${id}" muss unknown, dark, light oder glass sein.`);
    const accent = st.accent ?? '';
    if (accent !== '' && !/^#[0-9a-f]{6}$/i.test(accent)) throw new Error(`Akzentfarbe für "${id}" muss ein Hex-Code sein.`);
    const opacity = Math.round(Number(st.opacity ?? 82));
    if (!(opacity >= 0 && opacity <= 100)) throw new Error(`Deckkraft für "${id}" muss zwischen 0 und 100 liegen.`);
    const shape = st.shape ?? 'cut';
    if (!['cut', 'round'].includes(shape)) throw new Error(`Form für "${id}" muss cut oder round sein.`);
    const radius = Math.round(Number(st.radius ?? 12));
    if (!(radius >= 0 && radius <= 28)) throw new Error(`Rundung für "${id}" muss zwischen 0 und 28 liegen.`);
    out[id] = { theme, accent, opacity, shape, radius, border: st.border !== false, glow: st.glow !== false };
  }
  return out;
}
export function applyOverlayStyles(cfg, { styles, customCss } = {}) {
  if (styles !== undefined) cfg.overlay.styles = normalizeStyles(styles);
  if (customCss !== undefined) {
    const css = String(customCss ?? '');
    if (css.length > 20000) throw new Error('Eigenes CSS ist zu lang (höchstens 20.000 Zeichen).');
    if (/<\/?\s*style|<\s*script/i.test(css)) throw new Error('Eigenes CSS darf keine HTML-Tags enthalten.');
    cfg.overlay.customCss = css;
  }
  saveConfig(cfg);
  return { styles: cfg.overlay.styles, customCss: cfg.overlay.customCss };
}

// Overlay-Fenster komplett ausblenden: Liste der Panel-IDs, die im Overlay nicht erscheinen.
export function normalizeHidden(hidden) {
  if (hidden === null || hidden === undefined) return [];
  if (!Array.isArray(hidden)) throw new Error('hidden muss eine Liste von Overlay-Fenstern sein.');
  for (const id of hidden) if (!LAYOUT_PANELS.includes(id)) throw new Error(`Unbekanntes Overlay-Fenster: ${String(id).slice(0, 30)}`);
  return LAYOUT_PANELS.filter((id) => hidden.includes(id));
}
export function applyOverlayHidden(cfg, hidden) {
  cfg.overlay.hidden = normalizeHidden(hidden);
  saveConfig(cfg);
  return cfg.overlay.hidden;
}

// Reine Prüfung/Normalisierung eines Layout-Objekts (ohne zu speichern) - gemeinsam für das
// Dashboard (applyOverlayLayout) und den Preset-Import.
function normalizeLayout(layout) {
  if (layout === null || layout === undefined) return {};
  if (typeof layout !== 'object' || Array.isArray(layout)) throw new Error('layout muss ein Objekt sein.');
  const next = {};
  for (const [id, pos] of Object.entries(layout)) {
    if (!LAYOUT_PANELS.includes(id)) throw new Error(`Unbekanntes Overlay-Panel: ${id}`);
    const x = Number(pos?.x), y = Number(pos?.y);
    if (!(x >= 0 && x <= 100) || !(y >= 0 && y <= 100)) throw new Error(`Position für "${id}" muss x/y zwischen 0 und 100 sein.`);
    const entry = { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
    if (pos?.scale !== undefined && pos?.scale !== null) {
      const scale = Number(pos.scale);
      if (!(scale >= 0.5 && scale <= 2)) throw new Error(`Größe für "${id}" muss zwischen 0.5 und 2.0 liegen.`);
      entry.scale = Math.round(scale * 100) / 100;
    }
    next[id] = entry;
  }
  return next;
}

// ---------- Eigene Overlay-Sounds/-Bilder ----------
export function overlayAssetFile(filename) {
  return path.join(UPLOADS_DIR, filename);
}

// Base64-Eingabe prüfen (Mime erlaubt? Größe im Rahmen?) und als Datei in data/uploads/ ablegen.
// Wirft bei ungültiger Eingabe, OHNE vorher etwas zu schreiben. kind: 'sound' oder 'image'.
// Dateisignaturen ("magic bytes") der erlaubten Typen. ("importierte Medien
// müssen validiert werden"): der angegebene Mime-Typ allein ist nur eine Behauptung der Datei, die
// hochgeladen oder importiert wird - hier wird geprüft, dass der Inhalt wirklich so anfängt.
const at = (buf, off, str) => buf.length >= off + str.length && buf.subarray(off, off + str.length).toString('latin1') === str;
const OVERLAY_ASSET_SIGNATURE = {
  'image/png': (b) => at(b, 0, '\x89PNG\r\n\x1a\n'),
  'image/jpeg': (b) => at(b, 0, '\xff\xd8\xff'),
  'image/gif': (b) => at(b, 0, 'GIF87a') || at(b, 0, 'GIF89a'),
  'image/webp': (b) => at(b, 0, 'RIFF') && at(b, 8, 'WEBP'),
  'audio/wav': (b) => at(b, 0, 'RIFF') && at(b, 8, 'WAVE'),
  'audio/ogg': (b) => at(b, 0, 'OggS'),
  'audio/webm': (b) => at(b, 0, '\x1a\x45\xdf\xa3'),
  // MP3: entweder ein ID3-Kopf oder direkt ein MPEG-Audio-Frame (Sync 0xFF 0xE0-0xFF).
  'audio/mpeg': (b) => at(b, 0, 'ID3') || (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0),
};

// Prüft eine Sound-/Bild-Datei vollständig, OHNE etwas zu schreiben: Art, Mime-Typ, Base64,
// Größe, Dateisignatur. Gemeinsam für den Upload im Dashboard und für eingebettete Dateien in
// einem importierten Preset. Gibt { meta, buf } zurück oder wirft mit verständlichem Grund.
function checkOverlayAsset(kind, { name, mime, dataBase64 }) {
  const what = kind === 'sound' ? 'Sound' : 'Bild';
  if (!['sound', 'image'].includes(kind)) throw new Error(`Unbekannte Art "${kind}".`);
  const ext = Object.hasOwn(OVERLAY_ASSET_EXT, mime) ? OVERLAY_ASSET_EXT[mime] : null;
  if (typeof mime !== 'string' || !OVERLAY_ASSET_MIME[kind].includes(mime) || !ext) {
    throw new Error(`Dateityp "${String(mime).slice(0, 60)}" ist für ${kind === 'sound' ? 'eigene Sounds' : 'eigene Bilder'} nicht erlaubt.`);
  }
  if (typeof dataBase64 !== 'string' || !dataBase64) throw new Error(`${what}-Datei ist leer.`);
  // Größe schon am Text prüfen, bevor überhaupt dekodiert wird.
  if (dataBase64.length > Math.ceil(OVERLAY_ASSET_MAX_BYTES / 3) * 4 + 4) throw new Error(`${what}-Datei ist zu groß (max. ${Math.round(OVERLAY_ASSET_MAX_BYTES / 1024)} KB).`);
  // Buffer.from(..., 'base64') wirft nie, sondern überspringt ungültige Zeichen stillschweigend.
  if (dataBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64)) throw new Error(`${what}-Datei ist kein gültiges Base64.`);
  const buf = Buffer.from(dataBase64, 'base64');
  if (!buf.length) throw new Error(`${what}-Datei ist leer.`);
  if (buf.length > OVERLAY_ASSET_MAX_BYTES) throw new Error(`${what}-Datei ist zu groß (max. ${Math.round(OVERLAY_ASSET_MAX_BYTES / 1024)} KB).`);
  if (!OVERLAY_ASSET_SIGNATURE[mime](buf)) throw new Error(`Der Inhalt der ${what}-Datei passt nicht zum angegebenen Typ "${mime}".`);
  const cleanName = String(name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60) || `eigener-${kind}`;
  return { meta: { name: cleanName, mime, filename: `overlay-${kind}.${ext}` }, buf };
}

export function setOverlayAsset(cfg, kind, { name, mime, dataBase64 }) {
  const { meta, buf } = checkOverlayAsset(kind, { name, mime, dataBase64 });
  const { filename } = meta;
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  // alte Datei dieser Art ggf. mit anderer Endung entfernen, bevor die neue geschrieben wird
  const prev = cfg.overlay[kind === 'sound' ? 'customSound' : 'customImage'];
  if (prev?.filename && prev.filename !== filename) { try { fs.unlinkSync(overlayAssetFile(prev.filename)); } catch { /* war schon weg */ } }
  fs.writeFileSync(overlayAssetFile(filename), buf);
  cfg.overlay[kind === 'sound' ? 'customSound' : 'customImage'] = meta;
  saveConfig(cfg);
  return meta;
}

export function removeOverlayAsset(cfg, kind) {
  if (!['sound', 'image'].includes(kind)) throw new Error(`Unbekannte Art "${kind}".`);
  const key = kind === 'sound' ? 'customSound' : 'customImage';
  const prev = cfg.overlay[key];
  if (prev?.filename) { try { fs.unlinkSync(overlayAssetFile(prev.filename)); } catch { /* war schon weg */ } }
  cfg.overlay[key] = null;
  saveConfig(cfg);
}

// Datei zu Metadaten lesen, für die Auslieferung ans Overlay (GET /overlay-asset/<kind>).
export function readOverlayAsset(meta) {
  if (!meta?.filename) return null;
  try { return fs.readFileSync(overlayAssetFile(meta.filename)); } catch { return null; }
}

// ---------- Community-Ziel ----------
// Bewusst EINE Schwelle mindestens, mehrere möglich - jede mit eigenem Namen/Wert/Aktion. Ersetzt
// das gesamte Objekt (wie bei applyOverlayConfig), weil das Dashboard immer den vollständigen
// aktuellen Stand mitschickt.
const GOAL_MAX_THRESHOLDS = 5;

export function applyCommunityGoal(cfg, patch) {
  const name = String(patch?.name ?? cfg.communityGoal.name).trim().slice(0, 40) || 'Community-Ziel';
  if (patch?.basis !== undefined && !['points', 'bits', 'both'].includes(patch.basis)) {
    throw new Error('Grundlage muss "points", "bits" oder "both" sein.');
  }
  const basis = patch?.basis !== undefined ? patch.basis : cfg.communityGoal.basis;
  const rawThresholds = Array.isArray(patch?.thresholds) ? patch.thresholds : cfg.communityGoal.thresholds;
  if (!rawThresholds.length) throw new Error('Mindestens eine Schwelle nötig.');
  if (rawThresholds.length > GOAL_MAX_THRESHOLDS) throw new Error(`Maximal ${GOAL_MAX_THRESHOLDS} Schwellen.`);
  // Bekannte Aktions-IDs (Kanalpunkte UND Bits) - eine Schwelle darf eine feste Aktion aus BEIDEN
  // Pools wählen, nicht nur Kanalpunkte.
  const knownActionIds = new Set();
  try { for (const a of loadActions(cfg.game.profile).list) knownActionIds.add(a.id); } catch { /* dann eben leer */ }
  try { for (const a of loadBitsActions().list) knownActionIds.add(a.id); } catch { /* egal */ }
  const seenIds = new Set();
  const thresholds = rawThresholds.map((t, i) => {
    const id = String(t.id || '').trim().slice(0, 30) || `stufe${i + 1}`;
    if (seenIds.has(id)) throw new Error(`Schwellen-ID "${id}" kommt doppelt vor.`);
    seenIds.add(id);
    const tName = String(t.name || '').trim().slice(0, 40) || `Stufe ${i + 1}`;
    const value = Math.round(Number(t.value));
    if (!(value >= 1 && value <= 100000)) throw new Error(`Schwelle "${tName}": Wert muss zwischen 1 und 100000 liegen.`);
    const actionId = t.actionId ? String(t.actionId) : null;
    if (actionId && !knownActionIds.has(actionId)) throw new Error(`Schwelle "${tName}": unbekannte Aktion "${actionId}".`);
    return { id, name: tName, value, actionId };
  }).sort((a, b) => a.value - b.value);
  cfg.communityGoal = { name, basis, thresholds };
  saveConfig(cfg);
  return cfg.communityGoal;
}

export const AUTO_IDLE_MAX_WHITELIST = 20;

// "Auto-Lebendig" - an/aus, Ruhezeit und eine eigene, begrenzte
// Whitelist (nie der volle Aktions-Pool). Jede Whitelist-ID muss eine bekannte, aktuell
// existierende Aktion sein (Kanalpunkte ODER Bits) - unbekannte IDs werden abgelehnt statt
// stillschweigend ignoriert, damit im Dashboard kein Eintrag "verschwindet", ohne dass der
// Streamer das merkt.
export function applyAutoIdle(cfg, patch) {
  const enabled = !!patch?.enabled;
  const idleSec = Math.round(Number(patch?.idleSec ?? cfg.autoIdle.idleSec));
  if (!(idleSec >= 30 && idleSec <= 3600)) throw new Error('Ruhezeit muss zwischen 30 und 3600 Sekunden liegen.');
  const rawWhitelist = Array.isArray(patch?.whitelist) ? patch.whitelist : cfg.autoIdle.whitelist;
  if (rawWhitelist.length > AUTO_IDLE_MAX_WHITELIST) throw new Error(`Maximal ${AUTO_IDLE_MAX_WHITELIST} Aktionen in der Whitelist.`);
  const knownActionIds = new Set();
  try { for (const a of loadActions(cfg.game.profile).list) knownActionIds.add(a.id); } catch { /* dann eben leer */ }
  try { for (const a of loadBitsActions().list) knownActionIds.add(a.id); } catch { /* egal */ }
  const whitelist = [...new Set(rawWhitelist.map((id) => String(id)))];
  for (const id of whitelist) {
    if (!knownActionIds.has(id)) throw new Error(`Whitelist: unbekannte Aktion "${id}".`);
  }
  cfg.autoIdle = { enabled, idleSec, whitelist };
  saveConfig(cfg);
  return cfg.autoIdle;
}

// Warteschlangen-Länge und Voll-Politik aus dem Dashboard übernehmen.
// maxQueue betrifft nur echte Tasten-/Spiel-Effekte (die "schnelle Spur" für reine Overlay-
// Meldungen ohne Tastendruck braucht keine Warteschlangen-Länge, siehe engine.js: isOverlayOnly()).
// Bekannte CS2-Modi (map.mode im Spielzustand) - für die Auswahl im Dashboard.
export const CS2_MODES = ['casual', 'competitive', 'premier', 'scrimcomp2v2', 'deathmatch', 'gungameprogressive', 'gungametrbomb', 'custom'];

export function normalizeModeLock(m) {
  const v = m && typeof m === 'object' ? m : DEFAULTS.modeLock;
  const blocked = Array.isArray(v.blocked) ? v.blocked : DEFAULTS.modeLock.blocked;
  if (blocked.some((x) => typeof x !== 'string' || !/^[a-z0-9_]{1,32}$/.test(x))) throw new Error('Spielmodi: nur kurze Namen wie "competitive".');
  return { enabled: v.enabled !== false, blocked: [...new Set(blocked)].slice(0, 20) };
}

export function applyModeLock(cfg, patch) {
  cfg.modeLock = normalizeModeLock({ ...cfg.modeLock, ...(patch || {}) });
  saveConfig(cfg);
  return cfg.modeLock;
}

export function applyHighlights(cfg, patch) {
  if (patch?.customTitles !== undefined) normalizeCustomTitles(patch.customTitles); // wirft bei falschem Platzhalter
  cfg.highlights = normalizeHighlights({ ...cfg.highlights, ...(patch || {}), types: { ...cfg.highlights.types, ...(patch?.types || {}) } });
  saveConfig(cfg);
  return cfg.highlights;
}

export function applyStreamEvents(cfg, patch) {
  const next = { ...cfg.events };
  for (const [k, v] of Object.entries(patch || {})) if (next[k] && v && typeof v === 'object') next[k] = { ...next[k], ...v };
  cfg.events = normalizeStreamEvents(next, cfg.events); // ungültige Werte: der bisherige bleibt
  saveConfig(cfg);
  return cfg.events;
}

export function applyObs(cfg, patch) {
  cfg.obs = normalizeObs({ ...cfg.obs, ...(patch || {}) });
  saveConfig(cfg);
  return cfg.obs;
}

export function applyLocalClips(cfg, patch) {
  const p = patch || {};
  for (const k of ['folder', 'ffmpeg']) {
    if (p[k] && !path.isAbsolute(String(p[k]).trim())) throw new Error(k === 'folder' ? 'Bitte einen vollständigen Ordnerpfad angeben (z. B. D:\\Clips)' : 'Bitte den vollständigen Pfad zu ffmpeg.exe angeben');
  }
  if (p.ffmpeg && !fs.existsSync(String(p.ffmpeg).trim())) throw new Error('ffmpeg nicht gefunden');
  if (p.logoPath) {
    const l = String(p.logoPath).trim();
    if (!path.isAbsolute(l) || !/\.(png|jpe?g|webp)$/i.test(l)) throw new Error('Logo: bitte den vollständigen Pfad zu einer PNG-, JPG- oder WebP-Datei angeben');
    if (!fs.existsSync(l)) throw new Error('Logo-Datei nicht gefunden');
  }
  cfg.localClips = normalizeLocalClips({ ...cfg.localClips, ...p });
  saveConfig(cfg);
  return cfg.localClips;
}

// KI-Assistent: Uploads-Texte an/aus, Ton, Sprache (Schlüssel liegt getrennt, siehe ai.js).
export function applyAi(cfg, patch) {
  cfg.ai = normalizeAi({ ...cfg.ai, ...(patch && typeof patch === 'object' ? patch : {}) });
  saveConfig(cfg);
  return cfg.ai;
}

// Uploads (YouTube/TikTok): Zeitpunkt, Grenzen, YouTube-Sichtbarkeit und Texte.
export function applyUploads(cfg, patch) {
  const p = patch && typeof patch === 'object' ? patch : {};
  cfg.uploads = normalizeUploads({ ...cfg.uploads, ...p, youtube: { ...cfg.uploads.youtube, ...(p.youtube || {}) }, tiktok: { ...cfg.uploads.tiktok, ...(p.tiktok || {}) } });
  saveConfig(cfg);
  return cfg.uploads;
}

// System-Aktionen: Freischaltung, Bestätigung, Verknüpfungen (Effekt -> Aktion) und Programmliste.
export function applySystem(cfg, patch) {
  const p = patch || {};
  const next = structuredClone(cfg.system);
  if (p.enabled !== undefined) next.enabled = p.enabled === true;
  if (p.confirm !== undefined) next.confirm = p.confirm !== false;
  if (p.program) { // hinzufügen/ändern
    const { target } = checkProgramTarget(p.program.target);
    const id = p.program.id && /^[\w-]{1,40}$/.test(p.program.id) ? p.program.id : `p${Date.now().toString(36)}`;
    const prog = { id, name: String(p.program.name || '').slice(0, 40) || path.basename(target), target, args: String(p.program.args || ''), profile: p.program.profile || null };
    if (prog.profile && !isKnownProfile(prog.profile)) throw new Error('Unbekanntes Spiel-Profil');
    next.programs = [...next.programs.filter((x) => x.id !== id), prog];
    if (next.programs.length > 20) throw new Error('Höchstens 20 Programme');
  }
  if (p.removeProgram) {
    next.programs = next.programs.filter((x) => x.id !== p.removeProgram);
    for (const [k, l] of Object.entries(next.links)) if (l.kind === 'game' && l.programId === p.removeProgram) delete next.links[k];
  }
  if (p.link) {
    const { actionId, ...link } = p.link;
    if (!/^[\w.-]{1,64}$/.test(String(actionId))) throw new Error('Unbekannter Effekt');
    if (link.kind === null || link.kind === 'none') delete next.links[actionId];
    else {
      const probe = normalizeSystem({ ...next, links: { [actionId]: link } }, { profiles: profileIds() });
      if (!probe.links[actionId]) throw new Error('Bitte alle Felder der System-Aktion ausfüllen');
      next.links[actionId] = probe.links[actionId];
    }
  }
  cfg.system = normalizeSystem(next, { profiles: profileIds() });
  saveConfig(cfg);
  return cfg.system;
}

export function setViewerBlocked(cfg, { id, name, blocked }) {
  id = String(id || '');
  if (!id || id.length > 64 || id === 'anon') throw new Error('Unbekannter Zuschauer.');
  const list = cfg.viewers.blocked.filter((v) => v.id !== id);
  if (blocked) {
    if (list.length >= 500) throw new Error('Die Sperrliste ist voll (500).');
    list.push({ id, name: String(name || '').slice(0, 40) });
  }
  cfg.viewers.blocked = list;
  saveConfig(cfg);
  return cfg.viewers.blocked;
}

export function normalizeBitsPriority(p) {
  const v = { ...DEFAULTS.bitsPriority, ...(p && typeof p === 'object' ? p : {}) };
  const maxInRow = Math.round(Number(v.maxInRow));
  if (!(maxInRow >= 1 && maxInRow <= 10)) throw new Error('Bits hintereinander: 1 bis 10.');
  const maxWaitSec = Math.round(Number(v.maxWaitSec));
  if (!(maxWaitSec >= 30 && maxWaitSec <= 1800)) throw new Error('Längste Wartezeit für Kanalpunkte: 30 bis 1800 Sekunden.');
  return { enabled: v.enabled !== false, maxInRow, maxWaitSec };
}

export function applyQueuePolicy(cfg, patch) {
  const maxQueue = Math.round(Number(patch?.maxQueue ?? cfg.engine.maxQueue));
  if (!(maxQueue >= 1 && maxQueue <= 50)) throw new Error('Warteschlangen-Länge muss zwischen 1 und 50 liegen.');
  const queueWaitSec = Math.round(Number(patch?.queueWaitSec ?? cfg.engine.queueWaitSec));
  if (!(queueWaitSec >= 0 && queueWaitSec <= 120)) throw new Error('Wartezeit muss zwischen 0 und 120 Sekunden liegen (0 = sofort erstatten).');
  const bitsPriority = patch?.bitsPriority ? normalizeBitsPriority({ ...cfg.bitsPriority, ...patch.bitsPriority }) : cfg.bitsPriority;
  Object.assign(cfg.engine, { maxQueue, queueWaitSec });
  cfg.bitsPriority = bitsPriority;
  saveConfig(cfg);
  return cfg.engine;
}

// season.lengthDays war bisher nur per Hand in
// data/config.json änderbar - jetzt über das Dashboard. Wirkt SOFORT auch auf die laufende Season
// (ihr Enddatum verschiebt sich entsprechend) - server.js aktualisiert direkt danach die
// zwischengespeicherte Anzeige (engine.refreshSeasonLength()), damit das Dashboard nicht das alte
// Enddatum zeigt.
export function applySeasonConfig(cfg, patch) {
  const lengthDays = Math.round(Number(patch?.lengthDays ?? cfg.season.lengthDays));
  if (!(lengthDays >= 1 && lengthDays <= 90)) throw new Error('Season-Dauer muss zwischen 1 und 90 Tagen liegen.');
  cfg.season.lengthDays = lengthDays;
  saveConfig(cfg);
  return cfg.season;
}

// ---------- Chat-Befehle & Chat-Ankündigungen ----------

// Nur die vier An/Aus-Schalter und die Abklingzeit - die Befehlsliste selbst hat eigene,
// dedizierte Funktionen unten (add/remove/toggle), damit ein einzelner Befehl ändern nicht
// versehentlich die ganze Liste überschreiben kann (anders als bei den Schaltern hier, wo ein
// "voller" Patch unproblematisch ist).
// Session-Stats-Einstellungen aus dem Dashboard.
export const STATS_SHOW_KEYS = ['kills', 'deaths', 'kd', 'fails', 'deathsChaos', 'deathsNatural', 'killsUnderChaos',
  'roundsWon', 'roundsLost', 'matchesWon', 'matchesLost', 'bestStreak'];
export function normalizeStats(st) {
  const win = Number(st.chaosWindowSec);
  if (!(win >= 0 && win <= 30)) throw new Error('Chaos-Zeitfenster muss zwischen 0 und 30 Sekunden liegen.');
  const streak = Math.round(Number(st.streakMin));
  if (!(streak >= 2 && streak <= 10)) throw new Error('Kill-Serie muss zwischen 2 und 10 liegen.');
  const failCd = Number(st.failCooldownSec);
  if (!(failCd >= 0 && failCd <= 60)) throw new Error('Fail-Sperre muss zwischen 0 und 60 Sekunden liegen.');
  if (!Array.isArray(st.show) || st.show.some((k) => !STATS_SHOW_KEYS.includes(k))) throw new Error(`stats.show darf nur enthalten: ${STATS_SHOW_KEYS.join(', ')}.`);
  if (!Array.isArray(st.excludeModes) || st.excludeModes.some((m) => typeof m !== 'string' || !/^[a-z0-9_]{1,32}$/.test(m))) throw new Error('stats.excludeModes: nur kurze Modus-Namen wie "deathmatch".');
  if (!['unknown', 'dark', 'light'].includes(st.overlayTheme)) throw new Error('stats.overlayTheme muss "unknown", "dark" oder "light" sein.');
  const ov = st.overlay && typeof st.overlay === 'object' ? st.overlay : {};
  return { enabled: !!st.enabled, autoStream: !!st.autoStream, chaosWindowSec: Math.round(win * 10) / 10, streakMin: streak,
    excludeModes: [...new Set(st.excludeModes)], show: [...new Set(st.show)], failCommand: !!st.failCommand, failCooldownSec: failCd,
    announceChaosDeath: !!st.announceChaosDeath, overlayTheme: st.overlayTheme,
    overlay: { bar: ov.bar !== false, split: ov.split !== false, torture: ov.torture !== false, popups: ov.popups !== false } };
}
export function applyStatsConfig(cfg, patch) {
  const allowed = ['enabled', 'autoStream', 'chaosWindowSec', 'streakMin', 'excludeModes', 'show', 'failCommand', 'failCooldownSec', 'announceChaosDeath', 'overlayTheme'];
  const next = { ...cfg.stats, overlay: { ...cfg.stats.overlay } };
  for (const k of allowed) if (patch && patch[k] !== undefined) next[k] = patch[k];
  if (patch?.overlay && typeof patch.overlay === 'object') for (const k of ['bar', 'split', 'torture', 'popups']) if (patch.overlay[k] !== undefined) next.overlay[k] = !!patch.overlay[k];
  const stats = normalizeStats(next);
  if (patch && patch.failHotkey !== undefined) {
    const k = String(patch.failHotkey || '').trim();
    if (k !== '' && !/^[\^!+#]*[A-Za-z0-9]+$/.test(k)) throw new Error('Fail-Hotkey ist ungültig (z. B. ^!f für Strg+Alt+F, leer = aus).');
    if (k && k.toLowerCase() === cfg.bridge.panicHotkey.toLowerCase()) throw new Error('Fail-Hotkey und Not-Aus-Hotkey dürfen nicht gleich sein.');
    cfg.bridge.failHotkey = k;
  }
  cfg.stats = stats;
  saveConfig(cfg);
  return cfg.stats;
}

export function applyChatSettings(cfg, patch) {
  const cooldownSec = Math.round(Number(patch?.cooldownSec ?? cfg.chat.cooldownSec));
  if (!(cooldownSec >= 0 && cooldownSec <= 300)) throw new Error('Abklingzeit muss zwischen 0 und 300 Sekunden liegen.');
  cfg.chat = {
    ...cfg.chat,
    enabled: !!(patch?.enabled ?? cfg.chat.enabled),
    announceEffect: !!(patch?.announceEffect ?? cfg.chat.announceEffect),
    announceSeasonEndingSoon: !!(patch?.announceSeasonEndingSoon ?? cfg.chat.announceSeasonEndingSoon),
    announceSeasonWinner: !!(patch?.announceSeasonWinner ?? cfg.chat.announceSeasonWinner),
    cooldownSec,
  };
  saveConfig(cfg);
  return cfg.chat;
}

function normalizeChatTrigger(trigger) {
  const t = String(trigger || '').trim().toLowerCase();
  if (!t) throw new Error('Ein Trigger-Wort wird gebraucht (z. B. "!discord").');
  if (t.length > 30) throw new Error('Trigger-Wort darf höchstens 30 Zeichen lang sein.');
  if (/\s/.test(t)) throw new Error('Trigger-Wort darf keine Leerzeichen enthalten (sonst würde es im Chat nie exakt passen).');
  if (t === CHAT_STATS_TRIGGER) throw new Error(`"${CHAT_STATS_TRIGGER}" ist der fest eingebaute Statistik-Befehl und kann nicht überschrieben werden.`);
  return t;
}

// Statische Befehle: Text-Trigger -> fester Text als Antwort, ohne Logik/Variablen/Moderations-
// rechte.
export function addChatCommand(cfg, { trigger, response }) {
  if (cfg.chat.commands.length >= CHAT_MAX_COMMANDS) throw new Error(`Maximal ${CHAT_MAX_COMMANDS} Chat-Befehle.`);
  const t = normalizeChatTrigger(trigger);
  if (cfg.chat.commands.some((c) => c.trigger === t)) throw new Error(`Der Trigger "${t}" existiert schon.`);
  const r = String(response || '').trim().slice(0, 450);
  if (!r) throw new Error('Die Antwort darf nicht leer sein.');
  const cmd = { id: crypto.randomUUID(), trigger: t, response: r, enabled: true };
  cfg.chat.commands.push(cmd);
  saveConfig(cfg);
  return cmd;
}

export function removeChatCommand(cfg, id) {
  const before = cfg.chat.commands.length;
  cfg.chat.commands = cfg.chat.commands.filter((c) => c.id !== id);
  if (cfg.chat.commands.length === before) throw new Error('Chat-Befehl nicht gefunden.');
  saveConfig(cfg);
}

export function setChatCommandEnabled(cfg, id, enabled) {
  const c = cfg.chat.commands.find((c) => c.id === id);
  if (!c) throw new Error('Chat-Befehl nicht gefunden.');
  c.enabled = !!enabled;
  saveConfig(cfg);
  return c;
}

// Welche kritischen Tasten der Nutzer lokal freigegeben hat - in der Form, die steps.js erwartet.
// Jede Prüfung und jede Ausführung LOKALER Aktionen benutzt genau diese Funktion.
export function keyPolicy(cfg) {
  return { critical: cfg.input?.criticalKeys || [] };
}

// Welche kritischen Tasten stecken in der eigenen Tastenbelegung, ohne dass der Nutzer dazu schon
// ja oder nein gesagt hat? Für jede davon fragt das Dashboard einmal nach. Solange die
// Antwort aussteht, gilt die Taste als NICHT freigegeben - Aktionen, die sie brauchen, sind
// deaktiviert und zeigen den Grund.
// Rückgabe: [{ group: 'Alt', bindings: [{ name: 'walk', key: 'LAlt' }] }]
export function pendingCriticalKeys(cfg) {
  const byGroup = new Map();
  for (const [name, key] of Object.entries(cfg.keys || {})) {
    const group = criticalGroup(key);
    if (!group || cfg.input.criticalKeys.includes(group) || cfg.input.criticalDeclined.includes(group)) continue;
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group).push({ name, key: String(key) });
  }
  return [...byGroup].map(([group, bindings]) => ({ group, bindings }));
}

// Kritische Tasten ausdrücklich freigeben oder die Freigabe zurücknehmen.
// keys: vollständige neue Liste der freigegebenen Gruppen (z. B. ['Enter', 'Alt']).
// declined (optional): Gruppen, deren Nachfrage mit "nein" beantwortet wurde.
export function applyCriticalKeys(cfg, keys, declined) {
  const bad = (list) => !Array.isArray(list) || list.some((k) => !CRITICAL_KEY_NAMES.includes(k));
  if (bad(keys) || (declined !== undefined && bad(declined))) {
    throw new Error(`Unbekannte Taste. Freigebbar sind: ${CRITICAL_KEY_NAMES.join(', ')}.`);
  }
  cfg.input.criticalKeys = [...new Set(keys)];
  const nextDeclined = declined !== undefined ? [...cfg.input.criticalDeclined, ...declined] : cfg.input.criticalDeclined;
  cfg.input.criticalDeclined = [...new Set(nextDeclined)].filter((k) => !cfg.input.criticalKeys.includes(k));
  saveConfig(cfg);
  return cfg.input.criticalKeys;
}

// Zwei Ebenen: eine für jedes Profil gleiche Syntax-Prüfung (gültiger AHK-Tastenname), plus die
// profil-eigenen Zusatzregeln aus src/games/index.js (bisher nur CS2s Nummernblock-Zwang).
export function validateKeys(keys, profileId = 'cs2') {
  for (const [name, value] of Object.entries(keys)) {
    if (!/^[A-Za-z0-9]{1,20}$/.test(String(value))) {
      throw new Error(`Ungültige Taste "${value}" für "${name}" (nur Buchstaben/Ziffern, z. B. Shift, LCtrl, q, 1).`);
    }
  }
  getProfile(profileId).extraKeyCheck(keys);
}

// Spiel-Profil wechseln (Dashboard: schneller Profil-Wechsel).
// Ergänzt NUR fehlende Tasten aus der Profil-Vorlage - eine schon vom Streamer angepasste Taste
// bleibt unangetastet, auch wenn derselbe Tastenname in beiden Profilen vorkommt.
// Verantwortung als Produktmerkmal: die eine, generelle
// Zustimmung beim Setup deckt jedes Spiel-Profil gleich ab - kein zweites Nachfragen beim Wechsel.
export function applyGameProfile(cfg, profileId) {
  if (!isKnownProfile(profileId)) throw new Error(`Unbekanntes Spiel-Profil: "${profileId}". Erlaubt: ${profileIds().join(', ')}.`);
  const profile = getProfile(profileId);
  const defaults = profile.keyDefaults;
  for (const [name, value] of Object.entries(defaults)) {
    if (!(name in cfg.keys)) cfg.keys[name] = value;
  }
  cfg.game.profile = profileId;
  validatePortable(cfg);
  saveConfig(cfg);
  return cfg;
}

// Verantwortung als Produktmerkmal: die eine, generelle Zustimmung,
// mit Zeitstempel protokolliert statt nur angezeigt und vergessen - einmalig beim Setup, deckt
// jedes Spiel gleich ab ("ChaosCore führt jede Aktion zuverlässig aus, eine Anti-Cheat-Reaktion
// kann nicht ausgeschlossen werden") - ohne das kein Start, siehe readiness() in server.js.
export function acknowledgeRisk(cfg) {
  cfg.consent.riskAcknowledgedAt = new Date().toISOString();
  saveConfig(cfg);
  return cfg.consent.riskAcknowledgedAt;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw new Error(`${path.basename(file)} ist kaputt: ${e.message}`);
  }
}

function writePrivate(file, obj) {
  ensureData();
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* Windows */ }
}

// Twitch-Login: unter Windows verschlüsselt (secret-store.js). Eine alte, unverschlüsselte Datei wird
// beim ersten Lesen gleich umgestellt. Lässt sich eine Datei nicht entschlüsseln (z. B. auf einen
// anderen PC kopiert), gilt der Login als abgelaufen - das Dashboard bietet dann die Neu-Anmeldung.
export function loadTokens() {
  const raw = readJson(TOKEN_FILE, null);
  if (!raw) return null;
  if (typeof raw.protected === 'string') {
    try { return JSON.parse(unprotect(raw.protected)); }
    catch (e) { console.warn(`Twitch-Login konnte nicht entschlüsselt werden (${e.message}) - bitte neu anmelden.`); return null; }
  }
  if (cryptoAvailable()) { try { saveTokens(raw); } catch { /* bleibt vorerst unverschlüsselt */ } }
  return raw;
}
export function saveTokens(t) {
  if (cryptoAvailable()) {
    try { return writePrivate(TOKEN_FILE, { protected: protect(JSON.stringify(t)), v: 1 }); }
    catch (e) { console.warn(`Twitch-Login konnte nicht verschlüsselt werden (${e.message}) - wird ohne Verschlüsselung gespeichert.`); }
  }
  return writePrivate(TOKEN_FILE, t);
}
export const tokensProtected = () => typeof readJson(TOKEN_FILE, null)?.protected === 'string';
export const loadRewardMap = () => readJson(REWARD_FILE, {});
export const saveRewardMap = (m) => writePrivate(REWARD_FILE, m);

// title/prompt/flavor sind Zuschauer-
// sichtbar (Twitch-Belohnungsname, Overlay-Meldung) - das sind Dateninhalte, keine normalen
// UI-Strings, darum nicht über locale/*.json übersetzt, sondern direkt in den mitgelieferten
// Aktionen-Dateien mit einem optionalen "<feld>_en"-Feld je Aktion. Wird NUR beim allerersten
// Anlegen von data/actions(-bits).json und bei einer Schema-Migration angewendet (siehe
// migrateActions/loadActions/loadBitsActions unten) - eine schon laufende, vom Streamer ggf.
// individuell umbenannte Installation wird dadurch nie nachträglich überschrieben (title bleibt
// bei einer Migration sowieso unberührt, siehe migrateActions).
function pickText(obj, field, locale) {
  return (locale === 'en' && obj[`${field}_en`]) || obj[field];
}
function localizeAction(a, locale) {
  const { title_en, prompt_en, flavor_en, since, ...rest } = a; // since: nur für die Migration (Schema, mit dem die Aktion kam)
  return { ...rest, title: pickText(a, 'title', locale), prompt: pickText(a, 'prompt', locale), flavor: pickText(a, 'flavor', locale) };
}
function localizeDefaultActions(def, locale) {
  return { ...def, actions: def.actions.map((a) => localizeAction(a, locale)) };
}

// Aktualisiert eine ältere data/actions.json: Effekte und Texte kommen aus der Vorlage,
// deine Preise, Titel, Kategorien und An/Aus-Schalter bleiben erhalten (außer bei "customEffect": true).
function migrateActions(raw, locale) {
  const def = readJson(actionsDefaultFile('cs2'), null);
  if (!def || (raw.schema || 1) >= def.schema) return raw;
  const have = new Map(raw.actions.map((a) => [a.id, a]));
  const from = raw.schema || 1;
  for (const d of def.actions) {
    const a = have.get(d.id);
    if (!a) {
      // Neue Aktion: komplett aus der (lokalisierten) Vorlage. Aktionen mit "since" kamen mit diesem
      // Schema dazu; ältere fehlen in einer Datei ab Schema 3 absichtlich (z. B. ein Preset mit eigener
      // Auswahl) und werden dann nicht nachgetragen.
      if (d.since ? d.since > from : from < 3) {
        const { since, ...rest } = d;
        if (!raw.categories[rest.category] && def.categories?.[rest.category]) raw.categories[rest.category] = structuredClone(def.categories[rest.category]);
        if (raw.categories[rest.category]) raw.actions.push(localizeAction(rest, locale));
      }
      continue;
    }
    if (!a.customEffect) { a.effect = structuredClone(d.effect); a.requires = structuredClone(d.requires); }
    const ld = localizeAction(d, locale);
    if (!a.customText) { a.prompt = ld.prompt; a.flavor = ld.flavor; } // title bleibt bewusst unberührt - siehe Kommentar oben an loadActions()
    if (a.legacy && !d.legacy) { delete a.legacy; a.enabled = true; } // früher "alt", jetzt Standard
  }
  const pool = new Set([...(raw.curse?.pool || []), ...(def.curse?.pool || [])]);
  raw.curse = { ...(raw.curse || {}), pool: [...pool] };
  raw.schema = def.schema;
  fs.writeFileSync(actionsFile('cs2'), JSON.stringify(raw, null, 2));
  return raw;
}

// / Entscheidung eine lokale Aktion, die die zentrale Prüfung (validate.js)
// nicht besteht, wird NUR IM SPEICHER deaktiviert und bekommt den Grund als a.invalid - die Datei
// bleibt unangetastet, das Profil bleibt nutzbar, und sobald die Ursache behoben ist (z. B. eine
// kritische Taste freigegeben), ist die Aktion beim nächsten Laden wieder da. a.enabledInFile
// merkt sich, ob sie eigentlich eingeschaltet sein sollte (für Systemcheck und Dashboard).
function markInvalid(a, categories, cfg) {
  const reason = actionProblem(a, { categories, keys: cfg.keys, policy: keyPolicy(cfg), strict: false });
  if (!reason) return;
  a.invalid = reason;
  a.enabledInFile = !!a.enabled;
  a.enabled = false;
}

export function loadActions(profileId = 'cs2') {
  ensureData();
  const file = actionsFile(profileId);
  const cfg = loadConfig();
  const locale = cfg.server.locale; // nur für die Erstanlage/Migration unten (siehe Kommentar oben)
  if (!fs.existsSync(file)) {
    const def = readJson(actionsDefaultFile(profileId), null);
    fs.writeFileSync(file, JSON.stringify(localizeDefaultActions(def, locale), null, 2));
  }
  let raw = readJson(file, null);
  if (!raw || !Array.isArray(raw.actions) || !raw.categories) throw new Error(`${path.basename(file)} hat ein ungültiges Format.`);
  if (profileId === 'cs2') raw = migrateActions(raw, locale); // Migration bisher nur für CS2 gepflegt
  const byId = new Map();
  for (const a of raw.actions) {
    if (!a.id || !a.title || !a.category || !raw.categories[a.category]) {
      throw new Error(`Aktion "${a.id || a.title}" ist unvollständig (id, title, category).`);
    }
    if (a.title.length > 45) throw new Error(`Titel zu lang (max. 45 Zeichen): ${a.title}`);
    // "access" ist ein eigenes Feld, getrennt von "requires" (prüft
    // Spielzustand, nicht Zuschauer-Rolle). Fehlt es (ältere/mitgelieferte Dateien), gilt "jeder"
    // wie bisher - keine Datei-Migration nötig, nur eine Normalisierung beim Lesen.
    if (!ACCESS_LEVELS.includes(a.access)) a.access = 'everyone';
    markInvalid(a, raw.categories, cfg);
    byId.set(a.id, a);
  }
  return { categories: raw.categories, curse: raw.curse || { pool: [] }, list: raw.actions, byId };
}

// Zugriffsregel pro Aktion, unabhängig von Kosten/Kategorie.
export { ACCESS_LEVELS }; // definiert in validate.js (zentrale Prüfstelle), hier für bestehende Importe weitergereicht

function normalizeAccess(access) {
  const a = access === undefined || access === null || access === '' ? 'everyone' : access;
  if (!ACCESS_LEVELS.includes(a)) throw new Error(`Zugriffsregel unbekannt: "${a}". Erlaubt: ${ACCESS_LEVELS.join(', ')}.`);
  return a;
}

// Zugriffsregel einer bestehenden Aktion ändern (Dashboard) - auch bei mitgelieferten Effekten.
export function setActionAccess(id, access, profileId = 'cs2') {
  loadActions(profileId);
  const file = actionsFile(profileId);
  const raw = readJson(file, null);
  const a = raw.actions.find((x) => x.id === id);
  if (!a) throw new Error(`Unbekannte Aktion: ${id}`);
  a.access = normalizeAccess(access);
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
}

// Aktion in der Aktionen-Datei des aktiven Profils an- oder ausschalten (Dashboard)
export function setActionEnabled(id, enabled, profileId = 'cs2') {
  loadActions(profileId);
  const file = actionsFile(profileId);
  const raw = readJson(file, null);
  const a = raw.actions.find((x) => x.id === id);
  if (!a) throw new Error(`Unbekannte Aktion: ${id}`);
  a.enabled = !!enabled;
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
}

// Punktepreis einer bestehenden Aktion ändern (Dashboard) — auch bei mitgelieferten Effekten.
export function setActionCost(id, cost, profileId = 'cs2') {
  loadActions(profileId);
  const file = actionsFile(profileId);
  const raw = readJson(file, null);
  const a = raw.actions.find((x) => x.id === id);
  if (!a) throw new Error(`Unbekannte Aktion: ${id}`);
  cost = Math.round(Number(cost));
  if (!Number.isInteger(cost) || cost < 1 || cost > 1000000) throw new Error('Punkte müssen eine Zahl zwischen 1 und 1.000.000 sein.');
  a.cost = cost;
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
}

// Neue, eigene Belohnung anlegen (Dashboard). Drei Wege zum Effekt, geprüft in dieser Reihenfolge:
//   1. builtEffect: bereits fertig berechnete {effect, requires} (vom Effekt-Baukasten, server.js
//      hat sie aus einer festen Bausteinliste erzeugt — siehe effect-builder.js).
//   2. templateId: übernimmt den Effekt einer bestehenden Aktion unverändert (z. B. "Bewegungssperre"
//      als Vorlage für eine teurere Variante).
//   3. keines von beiden: löst nur eine Overlay-Meldung/Sound aus, kein Spiel-Effekt.
export function addAction({ title, cost, category, prompt, templateId, builtEffect }, profileId = 'cs2') {
  loadActions(profileId); // stellt sicher, dass die Aktionen-Datei existiert und aktuell ist
  const file = actionsFile(profileId);
  const raw = readJson(file, null);
  title = String(title || '').trim();
  prompt = String(prompt || '').trim();
  cost = Math.round(Number(cost));
  if (!title) throw new Error('Titel fehlt.');
  if (title.length > 45) throw new Error('Titel zu lang (max. 45 Zeichen).');
  if (!Number.isInteger(cost) || cost < 1 || cost > 1000000) throw new Error('Punkte müssen eine Zahl zwischen 1 und 1.000.000 sein.');
  if (!raw.categories[category]) throw new Error(`Unbekannte Stufe "${category}". Erlaubt: ${Object.keys(raw.categories).join(', ')}.`);
  if (raw.actions.some((a) => a.title.toLowerCase() === title.toLowerCase())) throw new Error('Es gibt schon eine Aktion mit diesem Titel.');
  let effect = {}; let requires = [];
  if (builtEffect) {
    effect = builtEffect.effect; requires = builtEffect.requires;
  } else if (templateId) {
    const tpl = raw.actions.find((x) => x.id === templateId);
    if (!tpl) throw new Error('Unbekannte Effekt-Vorlage.');
    effect = structuredClone(tpl.effect || {});
    requires = structuredClone(tpl.requires || []);
  }
  const id = 'custom_' + crypto.randomBytes(5).toString('hex');
  const action = { id, title, cost, category, enabled: true, custom: true, prompt, flavor: prompt, requires, effect, ...(templateId ? { templateId } : {}), ...(builtEffect?.builder ? { builder: builtEffect.builder } : {}) };
  raw.actions.push(action);
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
  return action;
}

// Eigene Belohnung löschen (Dashboard). Nur selbst angelegte ("custom") Aktionen, nicht die mitgelieferten.
export function removeAction(id, profileId = 'cs2') {
  const file = actionsFile(profileId);
  const raw = readJson(file, null);
  const idx = raw?.actions.findIndex((x) => x.id === id) ?? -1;
  if (idx < 0) throw new Error(`Unbekannte Aktion: ${id}`);
  if (!raw.actions[idx].custom) throw new Error('Mitgelieferte Aktionen können nur deaktiviert, nicht gelöscht werden.');
  raw.actions.splice(idx, 1);
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
}

// ---------- Bits-Belohnungen (eigene, von Kanalpunkten getrennte Liste) ----------
// Bits-Cheers haben keinen eigenen Twitch-"Reward" (anders als Kanalpunkte) - jeder beliebige
// Cheer-Betrag ist möglich. Eine Aktion hier definiert eine Schwelle ("cost" in Bits): wer
// mindestens so viel cheert, löst die höchste passende Stufe aus (siehe engine.js: onCheer).
export function loadBitsActions() {
  ensureData();
  if (!fs.existsSync(BITS_FILE)) {
    // siehe localizeDefaultActions()-Kommentar oben an loadActions().
    const def = readJson(BITS_DEFAULT, null);
    fs.writeFileSync(BITS_FILE, JSON.stringify(localizeDefaultActions(def, loadConfig().server.locale), null, 2));
  }
  let raw = readJson(BITS_FILE, null);
  if (!raw || !Array.isArray(raw.actions) || !raw.categories) throw new Error('data/actions-bits.json hat ein ungültiges Format.');
  const bitsCfg = loadConfig();
  raw = migrateBitsActions(raw, bitsCfg.server.locale);
  const byId = new Map();
  for (const a of raw.actions) {
    if (!a.id || !a.title || !a.category || !raw.categories[a.category]) {
      throw new Error(`Bits-Aktion "${a.id || a.title}" ist unvollständig (id, title, category).`);
    }
    if (a.title.length > 45) throw new Error(`Titel zu lang (max. 45 Zeichen): ${a.title}`);
    if (!ACCESS_LEVELS.includes(a.access)) a.access = 'everyone'; // siehe loadActions() oben
    markInvalid(a, raw.categories, bitsCfg);
    byId.set(a.id, a);
  }
  return { categories: raw.categories, list: raw.actions, byId };
}

// 2.0 (Schema 2): die neue Bits-Leiter (Goldener Kill, Rundentaufe, Goldener Rahmen, Fluch der Runde,
// Boss-Runde, Chaos-Parlament) kommt dazu. Die alten mitgelieferten Stufen bleiben erhalten, werden
// aber als "alt" ausgeschaltet - sonst lägen zwei Stufen auf demselben Preis. Eigene Stufen bleiben, wie sie sind.
function migrateBitsActions(raw, locale) {
  const def = readJson(BITS_DEFAULT, null);
  if (!def || (raw.schema || 1) >= def.schema) return raw;
  const have = new Map(raw.actions.map((a) => [a.id, a]));
  const added = [];
  for (const d of def.actions) {
    const a = have.get(d.id);
    if (!a) { if (!d.legacy) added.push(localizeAction(d, locale)); continue; }
    if (d.legacy && !a.custom) { a.legacy = true; a.enabled = false; if (!a.customEffect) a.effect = structuredClone(d.effect); }
  }
  raw.actions = [...added, ...raw.actions];
  raw.schema = def.schema;
  fs.writeFileSync(BITS_FILE, JSON.stringify(raw, null, 2));
  return raw;
}

// Zugriffsregel einer bestehenden Bits-Stufe ändern (Dashboard).
export function setBitsActionAccess(id, access) {
  loadBitsActions();
  const raw = readJson(BITS_FILE, null);
  const a = raw.actions.find((x) => x.id === id);
  if (!a) throw new Error(`Unbekannte Bits-Aktion: ${id}`);
  a.access = normalizeAccess(access);
  fs.writeFileSync(BITS_FILE, JSON.stringify(raw, null, 2));
}

export function setBitsActionEnabled(id, enabled) {
  loadBitsActions();
  const raw = readJson(BITS_FILE, null);
  const a = raw.actions.find((x) => x.id === id);
  if (!a) throw new Error(`Unbekannte Bits-Aktion: ${id}`);
  a.enabled = !!enabled;
  fs.writeFileSync(BITS_FILE, JSON.stringify(raw, null, 2));
}

// Bits-Schwelle einer bestehenden Aktion ändern (Dashboard) - auch bei mitgelieferten Effekten.
export function setBitsActionCost(id, cost) {
  loadBitsActions();
  const raw = readJson(BITS_FILE, null);
  const a = raw.actions.find((x) => x.id === id);
  if (!a) throw new Error(`Unbekannte Bits-Aktion: ${id}`);
  cost = Math.round(Number(cost));
  if (!Number.isInteger(cost) || cost < 1 || cost > 1000000) throw new Error('Bits müssen eine Zahl zwischen 1 und 1.000.000 sein.');
  a.cost = cost;
  fs.writeFileSync(BITS_FILE, JSON.stringify(raw, null, 2));
}

// Neue, eigene Bits-Stufe anlegen (Dashboard). Gleiche drei Wege zum Effekt wie bei addAction.
export function addBitsAction({ title, cost, prompt, templateId, builtEffect }) {
  loadBitsActions();
  const raw = readJson(BITS_FILE, null);
  title = String(title || '').trim();
  prompt = String(prompt || '').trim();
  cost = Math.round(Number(cost));
  if (!title) throw new Error('Titel fehlt.');
  if (title.length > 45) throw new Error('Titel zu lang (max. 45 Zeichen).');
  if (!Number.isInteger(cost) || cost < 1 || cost > 1000000) throw new Error('Bits müssen eine Zahl zwischen 1 und 1.000.000 sein.');
  if (raw.actions.some((a) => a.title.toLowerCase() === title.toLowerCase())) throw new Error('Es gibt schon eine Bits-Stufe mit diesem Titel.');
  let effect = {}; let requires = [];
  if (builtEffect) {
    effect = builtEffect.effect; requires = builtEffect.requires;
  } else if (templateId) {
    const tpl = raw.actions.find((x) => x.id === templateId);
    if (!tpl) throw new Error('Unbekannte Effekt-Vorlage.');
    effect = structuredClone(tpl.effect || {});
    requires = structuredClone(tpl.requires || []);
  }
  const id = 'bits_custom_' + crypto.randomBytes(5).toString('hex');
  const action = { id, title, cost, category: 'bits', enabled: true, custom: true, prompt, flavor: prompt, requires, effect, ...(templateId ? { templateId } : {}), ...(builtEffect?.builder ? { builder: builtEffect.builder } : {}) };
  raw.actions.push(action);
  fs.writeFileSync(BITS_FILE, JSON.stringify(raw, null, 2));
  return action;
}

// ---------- Effekte bearbeiten, kopieren, wiederherstellen (Baukasten) ----------
// Gemeinsam für Kanalpunkte-Aktionen und Bits-Stufen: kind 'points' (Datei des aktiven Spiel-
// Profils) oder 'bits'.
function editTarget(kind, profileId) {
  if (kind === 'bits') { loadBitsActions(); return { file: BITS_FILE, def: BITS_DEFAULT, idPrefix: 'bits_custom_', unit: 'Bits' }; }
  loadActions(profileId);
  return { file: actionsFile(profileId), def: actionsDefaultFile(profileId), idPrefix: 'custom_', unit: 'Punkte' };
}

function checkEdited(a, raw, cfg) {
  const err = actionProblem(a, { categories: raw.categories, keys: cfg.keys, policy: keyPolicy(cfg), strict: false });
  if (err) throw new Error(`So geht es nicht: Die Aktion ${err}.`);
}

// patch: title, prompt, flavor, cost, category, color ('' = Stufenfarbe), cooldownSec (null = Stufe),
// access, onDeath, phase ('live' | 'any'), built ({ effect, requires, builder } aus dem Baukasten).
export function updateAction(kind, id, patch, profileId = 'cs2') {
  const t = editTarget(kind, profileId);
  const cfg = loadConfig();
  const raw = readJson(t.file, null);
  const a = raw.actions.find((x) => x.id === id);
  if (!a) throw new Error(`Unbekannte Aktion: ${id}`);
  const p = patch || {};
  if (p.title !== undefined) {
    const title = String(p.title).trim();
    if (!title || title.length > 45) throw new Error('Der Name braucht 1 bis 45 Zeichen.');
    if (raw.actions.some((x) => x !== a && x.title.toLowerCase() === title.toLowerCase())) throw new Error('Es gibt schon eine Aktion mit diesem Namen.');
    a.title = title;
  }
  if (p.prompt !== undefined) { a.prompt = String(p.prompt).trim().slice(0, 200); a.customText = true; }
  if (p.flavor !== undefined) { a.flavor = String(p.flavor).trim().slice(0, 300); a.customText = true; }
  if (p.cost !== undefined) {
    const cost = Math.round(Number(p.cost));
    if (!Number.isInteger(cost) || cost < 1 || cost > 1000000) throw new Error(`${t.unit} müssen eine Zahl zwischen 1 und 1.000.000 sein.`);
    a.cost = cost;
  }
  if (p.category !== undefined) {
    if (!raw.categories[p.category]) throw new Error(`Unbekannte Stufe "${String(p.category).slice(0, 24)}".`);
    a.category = p.category;
  }
  if (p.color !== undefined) { if (p.color) a.color = String(p.color); else delete a.color; }
  if (p.cooldownSec !== undefined) { if (p.cooldownSec === null || p.cooldownSec === '') delete a.cooldownSec; else a.cooldownSec = Math.round(Number(p.cooldownSec)); }
  if (p.access !== undefined) a.access = normalizeAccess(p.access);
  if (p.onDeath !== undefined) { if (p.onDeath === 'continue') a.onDeath = 'continue'; else delete a.onDeath; }
  if (p.built) {
    a.effect = p.built.effect;
    a.requires = p.built.requires;
    a.builder = p.built.builder;
    a.customEffect = true;
  }
  if (p.phase !== undefined) {
    const req = new Set(a.requires || []);
    if (p.phase === 'any') req.delete('live'); else req.add('live');
    a.requires = [...req];
  }
  checkEdited(a, raw, cfg);
  fs.writeFileSync(t.file, JSON.stringify(raw, null, 2));
  return a;
}

// Kopie als neue, eigene Aktion - zunächst AUS, damit sie nicht sofort auf Twitch erscheint.
export function copyAction(kind, id, profileId = 'cs2') {
  const t = editTarget(kind, profileId);
  const raw = readJson(t.file, null);
  const a = raw.actions.find((x) => x.id === id);
  if (!a) throw new Error(`Unbekannte Aktion: ${id}`);
  const base = a.title.replace(/ \(Kopie(?: \d+)?\)$/, '');
  let title;
  for (let n = 1; n < 100; n++) {
    const suffix = n === 1 ? ' (Kopie)' : ` (Kopie ${n})`;
    title = base.slice(0, 45 - suffix.length) + suffix;
    if (!raw.actions.some((x) => x.title.toLowerCase() === title.toLowerCase())) break;
  }
  const copy = { ...structuredClone(a), id: t.idPrefix + crypto.randomBytes(5).toString('hex'), title, custom: true, enabled: false, customEffect: true, customText: true };
  delete copy.legacy; delete copy.invalid; delete copy.enabledInFile;
  raw.actions.push(copy);
  if (raw.actions.length > 200) throw new Error('Zu viele Aktionen (höchstens 200).');
  fs.writeFileSync(t.file, JSON.stringify(raw, null, 2));
  return copy;
}

// Mitgelieferte Aktion auf den Auslieferungszustand zurücksetzen (Name, Texte, Stufe, Ablauf, Regeln).
// Preis, An/Aus und Zugriff bleiben - das sind Einstellungen, keine Änderungen am Effekt.
export function restoreAction(kind, id, profileId = 'cs2') {
  const t = editTarget(kind, profileId);
  const raw = readJson(t.file, null);
  const a = raw.actions.find((x) => x.id === id);
  if (!a) throw new Error(`Unbekannte Aktion: ${id}`);
  if (a.custom) throw new Error('Eigene Aktionen haben kein Original.');
  const d = readJson(t.def, null)?.actions?.find((x) => x.id === id);
  if (!d) throw new Error('Für diese Aktion gibt es keine mitgelieferte Vorlage.');
  const ld = localizeAction(structuredClone(d), loadConfig().server.locale);
  for (const k of ['color', 'cooldownSec', 'onDeath', 'builder', 'customEffect', 'customText']) delete a[k];
  Object.assign(a, { title: ld.title, prompt: ld.prompt, flavor: ld.flavor, category: ld.category, requires: ld.requires, effect: ld.effect });
  fs.writeFileSync(t.file, JSON.stringify(raw, null, 2));
  return a;
}

// Auslieferungszustand einer mitgelieferten Aktion (oder null).
export function defaultAction(kind, id, profileId = 'cs2') {
  const file = kind === 'bits' ? BITS_DEFAULT : actionsDefaultFile(profileId);
  const d = readJson(file, null)?.actions?.find((x) => x.id === id);
  return d ? structuredClone(d) : null;
}

// ---------- Einzelne Effekte teilen ----------
export const EFFECT_FORMAT = 'chaoscore-effect';
export function exportEffect(kind, id, profileId = 'cs2') {
  const t = editTarget(kind, profileId);
  const a = readJson(t.file, null).actions.find((x) => x.id === id);
  if (!a) throw new Error(`Unbekannte Aktion: ${id}`);
  const pick = {};
  for (const k of ['title', 'prompt', 'flavor', 'cost', 'category', 'color', 'cooldownSec', 'onDeath', 'requires', 'effect', 'builder']) if (a[k] !== undefined) pick[k] = structuredClone(a[k]);
  return { format: EFFECT_FORMAT, version: 1, kind, game: kind === 'bits' ? null : profileId, exportedAt: new Date().toISOString(), action: pick };
}

// Prüft eine geteilte Effekt-Datei so streng wie ein Preset (rohe kritische Tasten nie erlaubt) und
// legt sie bei commit als eigene, zunächst AUSGESCHALTETE Aktion an.
export function importEffect(data, kind, profileId = 'cs2', { commit = false } = {}) {
  if (!data || typeof data !== 'object' || data.format !== EFFECT_FORMAT || data.version !== 1) throw new Error('Das ist keine ChaosCore-Effekt-Datei.');
  if ((data.kind || 'points') !== kind) throw new Error(kind === 'bits' ? 'Das ist ein Kanalpunkte-Effekt - bitte bei den Kanalpunkten importieren.' : 'Das ist eine Bits-Stufe - bitte bei Bits importieren.');
  if (kind !== 'bits' && data.game && data.game !== profileId) throw new Error(`Dieser Effekt ist für das Spiel-Profil "${String(data.game).slice(0, 20)}" gebaut.`);
  const t = editTarget(kind, profileId);
  const cfg = loadConfig();
  const raw = readJson(t.file, null);
  const src = data.action || {};
  const allowed = ['title', 'prompt', 'flavor', 'cost', 'category', 'color', 'cooldownSec', 'onDeath', 'requires', 'effect', 'builder'];
  const extra = Object.keys(src).find((k) => !allowed.includes(k));
  if (extra) throw new Error(`Die Datei enthält das unbekannte Feld "${extra.slice(0, 30)}".`);
  const a = { id: t.idPrefix + crypto.randomBytes(5).toString('hex'), ...structuredClone(src), custom: true, enabled: false, customEffect: true, customText: true };
  if (kind === 'bits') a.category = 'bits';
  else if (!raw.categories[a.category]) a.category = raw.categories.medium ? 'medium' : Object.keys(raw.categories)[0];
  if (typeof a.title === 'string') {
    a.title = a.title.trim().slice(0, 45);
    let n = 2;
    const base = a.title.slice(0, 40);
    while (raw.actions.some((x) => x.title.toLowerCase() === a.title.toLowerCase()) && n < 100) a.title = `${base} ${n++}`;
  }
  const err = actionProblem(a, { categories: raw.categories, keys: cfg.keys, policy: { critical: cfg.input?.criticalKeys || [], rawCritical: [] }, strict: true });
  if (err) throw new Error(`Der Effekt ${err} - nicht übernommen.`);
  if (commit) {
    if (raw.actions.length >= 200) throw new Error('Zu viele Aktionen (höchstens 200).');
    raw.actions.push(a);
    fs.writeFileSync(t.file, JSON.stringify(raw, null, 2));
  }
  return a;
}

export function removeBitsAction(id) {
  const raw = readJson(BITS_FILE, null);
  const idx = raw?.actions.findIndex((x) => x.id === id) ?? -1;
  if (idx < 0) throw new Error(`Unbekannte Bits-Aktion: ${id}`);
  if (!raw.actions[idx].custom) throw new Error('Mitgelieferte Bits-Stufen können nur deaktiviert, nicht gelöscht werden.');
  raw.actions.splice(idx, 1);
  fs.writeFileSync(BITS_FILE, JSON.stringify(raw, null, 2));
}

// ---------- Profil exportieren/importieren (Dashboard: Personalisierung übertragen/sichern) ----------
// Bewusst NICHT enthalten: Twitch-Zugangsdaten, Server-Host/Port/Tokens, CS2-Ordnerpfad —
// das ist kontospezifisch bzw. maschinenspezifisch und würde beim Import auf einem anderen
// Rechner/Kanal sowieso nicht (sicher) passen.
// preset: optionale { name, author } fürs Teilen - rein informativ,
// landet nur mit drin, wenn mindestens eines davon angegeben wurde.
export function exportProfile(cfg, preset) {
  loadActions(cfg.game.profile);
  const actionsRaw = readJson(actionsFile(cfg.game.profile), null);
  const { cs2CfgDir, ...game } = cfg.game;
  const overlay = structuredClone(cfg.overlay);
  delete overlay.customCss; // eigenes CSS bleibt bewusst auf diesem PC
  // Eigener Sound/Bild werden hier zusätzlich als Base64 eingebettet (die Datei selbst liegt sonst
  // nur lokal in data/uploads/) - das macht aus dem Preset EINE Datei, die komplett weitergegeben
  // werden kann, ohne dass der Empfänger separat eine Sound-/Bild-Datei mitschicken muss.
  for (const key of ['customSound', 'customImage']) {
    const meta = overlay[key];
    if (!meta?.filename) { overlay[key] = null; continue; }
    const buf = readOverlayAsset(meta);
    overlay[key] = buf ? { name: meta.name, mime: meta.mime, dataBase64: buf.toString('base64') } : null;
  }
  const out = {
    schema: 1,
    exportedAt: new Date().toISOString(),
    product: cfg.overlay.brand,
    game,
    keys: structuredClone(cfg.keys),
    bridge: { panicHotkey: cfg.bridge.panicHotkey },
    engine: structuredClone(cfg.engine),
    contract: structuredClone(cfg.contract),
    overlay,
    actions: actionsRaw, // Effekte/Preise/Kategorien — enthält keine Geheimnisse, nur Spiel-Logik
  };
  const name = String(preset?.name || '').trim().slice(0, 60);
  const author = String(preset?.author || '').trim().slice(0, 60);
  if (name || author) out.preset = { ...(name ? { name } : {}), ...(author ? { author } : {}) };
  return out;
}

// Für den Fehlerbericht: dieselbe geheimnisfreie Auswahl wie beim
// Preset-Export oben (keine Twitch-Zugangsdaten, keine Server-Tokens, kein CS2-Ordnerpfad - schon
// durch den bestehenden Diagnose-Test geprüft), aber OHNE die teils mehrere MB großen
// Base64-Sound-/Bild-Daten - ein Fehlerbericht soll klein und schnell anhängbar bleiben, nicht die
// eigentliche Asset-Datei transportieren. Ergänzt um ein paar unkritische, rein lokale
// Server-Einstellungen, die beim Preset-Export bewusst fehlen (weil maschinenspezifisch), für die
// Diagnose aber hilfreich sind.
export function safeConfigSnapshot(cfg) {
  const full = exportProfile(cfg, {});
  const overlay = { ...full.overlay };
  for (const key of ['customSound', 'customImage']) {
    if (overlay[key]) overlay[key] = { name: overlay[key].name, mime: overlay[key].mime };
  }
  return { ...full, overlay, server: { dashboardMode: cfg.server.dashboardMode, locale: cfg.server.locale } };
}

// ---------- Preset-Import ----------
// Was ein Preset mitbringen darf, steht hier als Erlaubnisliste - alles andere wird NICHT übernommen
// und in der Vorschau als "nicht übernommen" genannt:
//   immer:            Aktionen, Tastenbelegung (nur normale Tasten), Ziel-Spiel-Profil,
//                     Overlay-Aussehen (IMPORT_OVERLAY_FIELDS, Layout), eigener Sound/eigenes Bild
//   nur nach eigener  Contract-Ziel ("contract"), Warteschlangen-Länge/-Wartezeit ("queue"),
//   Zustimmung:       persönliche Spielwerte wie Empfindlichkeit/Fadenkreuz ("gameTuning")
//   nie:              Fokusprüfung, Fenstername, Spielzustand-Pflicht, Ordnerpfade, Not-Aus-Hotkey,
//                     Zeitlimits und Erstattungs-Einstellung der Engine, Produktname, Tasten-Freigabe,
//                     Server-/Twitch-Einstellungen
const IMPORT_OVERLAY_FIELDS = ['accent', 'sound', 'history', 'top', 'reduceFlash', 'historyCount', 'topCount', 'topMode', 'topRotateSec'];
const IMPORT_GAME_TUNING = ['sensitivity', 'crosshairAlpha', 'crosshairSize', 'crosshairBigSize', 'mPitch', 'crosshairColor'];
const IMPORT_QUEUE_FIELDS = ['maxQueue', 'queueWaitSec'];
const IMPORT_TOP_LEVEL = ['schema', 'exportedAt', 'product', 'preset', 'game', 'keys', 'bridge', 'engine', 'contract', 'overlay', 'actions'];
export const IMPORT_OPTIONAL_GROUPS = ['contract', 'queue', 'gameTuning'];

const plainObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const short = (v) => { const t = typeof v === 'string' ? v : JSON.stringify(v); return String(t).slice(0, 60); };

// Plant einen Import vollständig durch, OHNE irgendetwas zu schreiben oder cfg zu verändern.
// Wirft beim ersten Fehler (dann wird nichts übernommen - keine Teilübernahme).
// accept: { contract, queue, gameTuning } - nur was hier ausdrücklich true ist, wird aus den
// zustimmungspflichtigen Gruppen übernommen.
// Rückgabe: { candidate, validatedActions, overlayAssetWrites, report } - report ist die Grundlage
// der Vorschau im Dashboard.
function planImport(cfg, data, accept = {}) {
  if (!plainObj(data) || data.schema !== 1) throw new Error('Das ist keine gültige ChaosCore-Profildatei.');
  const candidate = structuredClone(cfg);
  const report = {
    preset: { name: typeof data.preset?.name === 'string' ? data.preset.name.slice(0, 60) : null, author: typeof data.preset?.author === 'string' ? data.preset.author.slice(0, 60) : null },
    targetGame: null, keys: { changed: [] }, overlay: { changed: [] }, media: { sound: null, image: null },
    actions: { added: [], changed: [], removed: [], unchanged: 0 },
    optional: {}, notImported: [], criticalUsed: [],
  };
  for (const k of Object.keys(data)) if (!IMPORT_TOP_LEVEL.includes(k)) report.notImported.push(k.slice(0, 40));

  // ----- Spiel -----
  if (data.game !== undefined) {
    if (!plainObj(data.game)) throw new Error('Der Abschnitt "game" im Preset ist ungültig.');
    if (data.game.profile !== undefined) {
      if (typeof data.game.profile !== 'string' || !isKnownProfile(data.game.profile)) throw new Error(`Das Preset ist für ein unbekanntes Spiel-Profil gedacht ("${short(data.game.profile)}").`);
      candidate.game.profile = data.game.profile;
    }
    const tuning = IMPORT_GAME_TUNING.filter((f) => data.game[f] !== undefined && data.game[f] !== cfg.game[f]).map((f) => ({ field: f, from: cfg.game[f], to: data.game[f] }));
    if (tuning.length) {
      report.optional.gameTuning = { changes: tuning, accepted: accept.gameTuning === true };
      if (accept.gameTuning === true) for (const t of tuning) candidate.game[t.field] = t.to; // Bereiche prüft validatePortable() unten
    }
    for (const f of Object.keys(data.game)) if (f !== 'profile' && !IMPORT_GAME_TUNING.includes(f)) report.notImported.push(`game.${f}`.slice(0, 40));
  }
  const profile = getProfile(candidate.game.profile);
  report.targetGame = { id: profile.id, name: profile.name, switches: profile.id !== cfg.game.profile };

  // ----- Tasten -----
  if (data.keys !== undefined) {
    if (!plainObj(data.keys) || Object.keys(data.keys).length > 200) throw new Error('Der Abschnitt "keys" im Preset ist ungültig.');
    // eine Taste, die das Preset MITBRINGT, darf nur eine normale Taste sein. Ausnahme: der
    // Wert ist identisch mit dem, was lokal schon eingestellt ist - dann ändert das Preset nichts,
    // und eine dort lokal freigegebene kritische Taste bleibt die Entscheidung des Nutzers.
    for (const [name, value] of Object.entries(data.keys)) {
      if (!/^[A-Za-z0-9_]{1,24}$/.test(name)) throw new Error(`Der Tastenname "${name.slice(0, 40)}" im Preset ist ungültig.`);
      if (typeof value !== 'string') throw new Error(`Taste "${name}" im Preset ist kein Text.`);
      if (Object.hasOwn(cfg.keys, name) && cfg.keys[name] === value) continue;
      const cls = classifyKey(value);
      if (cls !== 'normal') throw new Error(`Das Preset belegt "${name}" mit der Taste "${value.slice(0, 40)}" - ${cls === 'critical' ? 'kritische Tasten dürfen nicht importiert werden' : 'diese Taste ist gesperrt oder unbekannt'}.`);
      report.keys.changed.push({ name, from: Object.hasOwn(cfg.keys, name) ? cfg.keys[name] : null, to: value });
    }
    candidate.keys = { ...candidate.keys, ...data.keys };
  }

  // ----- Nie importierbar: nur für die Vorschau festhalten -----
  if (plainObj(data.bridge)) for (const f of Object.keys(data.bridge)) report.notImported.push(`bridge.${f}`.slice(0, 40));
  else if (data.bridge !== undefined) throw new Error('Der Abschnitt "bridge" im Preset ist ungültig.');

  // ----- Zustimmungspflichtig: Warteschlange, Contract -----
  if (data.engine !== undefined) {
    if (!plainObj(data.engine)) throw new Error('Der Abschnitt "engine" im Preset ist ungültig.');
    const q = IMPORT_QUEUE_FIELDS.filter((f) => data.engine[f] !== undefined && data.engine[f] !== cfg.engine[f]).map((f) => ({ field: f, from: cfg.engine[f], to: data.engine[f] }));
    if (q.length) {
      report.optional.queue = { changes: q, accepted: accept.queue === true };
      if (accept.queue === true) for (const c of q) candidate.engine[c.field] = c.to; // Bereiche prüft validatePortable()
    }
    for (const f of Object.keys(data.engine)) if (!IMPORT_QUEUE_FIELDS.includes(f)) report.notImported.push(`engine.${f}`.slice(0, 40));
  }
  if (data.contract !== undefined) {
    if (!plainObj(data.contract)) throw new Error('Der Abschnitt "contract" im Preset ist ungültig.');
    const to = data.contract.distinctViewers;
    if (to !== undefined && to !== cfg.contract.distinctViewers) {
      if (!Number.isInteger(to) || to < 1 || to > 100000) throw new Error('Das Contract-Ziel im Preset muss eine ganze Zahl von 1 bis 100000 sein.');
      report.optional.contract = { changes: [{ field: 'distinctViewers', from: cfg.contract.distinctViewers, to }], accepted: accept.contract === true };
      if (accept.contract === true) candidate.contract.distinctViewers = to;
    }
    for (const f of Object.keys(data.contract)) if (f !== 'distinctViewers') report.notImported.push(`contract.${f}`.slice(0, 40));
  }

  // ----- Overlay-Aussehen und Medien -----
  // Eingebettete Sound-/Bild-Datei: erst vollständig prüfen, NICHT sofort auf die
  // Platte schreiben - das passiert erst zusammen mit dem Rest ganz am Ende.
  const overlayAssetWrites = []; // [{ filename, buf }]
  if (data.overlay !== undefined) {
    if (!plainObj(data.overlay)) throw new Error('Der Abschnitt "overlay" im Preset ist ungültig.');
    const o = data.overlay;
    for (const f of ['sound', 'history', 'top', 'reduceFlash']) if (o[f] !== undefined && typeof o[f] !== 'boolean') throw new Error(`Overlay-Einstellung "${f}" im Preset muss wahr oder falsch sein.`);
    if (o.accent !== undefined && (typeof o.accent !== 'string' || !/^#[0-9a-f]{6}$/i.test(o.accent))) throw new Error('Die Overlay-Farbe im Preset muss ein Hex-Code sein, z. B. #B026FF.');
    for (const f of ['historyCount', 'topCount']) if (o[f] !== undefined && !(Number.isInteger(o[f]) && o[f] >= 1 && o[f] <= 15)) throw new Error(`Overlay-Einstellung "${f}" im Preset muss eine ganze Zahl von 1 bis 15 sein.`);
    if (o.topMode !== undefined && !['both', 'today', 'all'].includes(o.topMode)) throw new Error('Overlay-Einstellung "topMode" im Preset ist ungültig.');
    if (o.topRotateSec !== undefined && !(typeof o.topRotateSec === 'number' && o.topRotateSec >= 4 && o.topRotateSec <= 120)) throw new Error('Overlay-Einstellung "topRotateSec" im Preset muss zwischen 4 und 120 liegen.');
    for (const f of IMPORT_OVERLAY_FIELDS) {
      if (o[f] === undefined || o[f] === cfg.overlay[f]) continue;
      report.overlay.changed.push({ field: f, from: cfg.overlay[f], to: o[f] });
      candidate.overlay[f] = o[f];
    }
    if (o.layout !== undefined) {
      const layout = normalizeLayout(o.layout); // wirft bei unbekanntem Panel / Wert außerhalb des Bereichs
      if (JSON.stringify(layout) !== JSON.stringify(cfg.overlay.layout || {})) report.overlay.changed.push({ field: 'layout', from: Object.keys(cfg.overlay.layout || {}).length, to: Object.keys(layout).length });
      candidate.overlay.layout = layout;
    }
    if (o.styles !== undefined) {
      const styles = normalizeStyles(o.styles);
      if (JSON.stringify(styles) !== JSON.stringify(cfg.overlay.styles || {})) report.overlay.changed.push({ field: 'styles', from: Object.keys(cfg.overlay.styles || {}).length, to: Object.keys(styles).length });
      candidate.overlay.styles = styles;
    }
    if (o.hidden !== undefined || o.history === false) {
      // ältere Presets kennen nur history: false
      const hidden = normalizeHidden([...(o.hidden ?? cfg.overlay.hidden ?? []), ...(o.history === false ? ['history'] : [])]);
      if (JSON.stringify(hidden) !== JSON.stringify(cfg.overlay.hidden || [])) report.overlay.changed.push({ field: 'hidden', from: (cfg.overlay.hidden || []).join(', ') || '-', to: hidden.join(', ') || '-' });
      candidate.overlay.hidden = hidden;
    }
    for (const [kind, metaKey] of [['sound', 'customSound'], ['image', 'customImage']]) {
      const raw = o[metaKey];
      if (raw === undefined) continue; // Preset sagt nichts dazu -> lokale Datei bleibt
      if (raw === null) {
        if (cfg.overlay[metaKey]) report.media[kind] = { action: 'removed', name: cfg.overlay[metaKey].name };
        candidate.overlay[metaKey] = null;
        continue;
      }
      if (!plainObj(raw)) throw new Error(`Eingebetteter ${kind === 'sound' ? 'Sound' : 'Bild-Eintrag'} im Preset ist unvollständig.`);
      const { meta, buf } = checkOverlayAsset(kind, raw);
      candidate.overlay[metaKey] = meta;
      overlayAssetWrites.push({ filename: meta.filename, buf });
      report.media[kind] = { action: cfg.overlay[metaKey] ? 'replaced' : 'added', name: meta.name, mime: meta.mime, kb: Math.max(1, Math.round(buf.length / 1024)) };
    }
    for (const f of Object.keys(o)) if (!IMPORT_OVERLAY_FIELDS.includes(f) && !['layout', 'hidden', 'styles', 'customSound', 'customImage'].includes(f)) report.notImported.push(`overlay.${f}`.slice(0, 40));
  }

  validatePortable(candidate); // wirft bei ungültigem Wert — ab hier nichts mehr schreiben
  // Auch NICHT angenommene Zustimmungs-Gruppen müssen gültig sein: ein Preset mit einem unsinnigen
  // Wert dort ist fehlerhaft und wird ganz abgelehnt, statt dass der Fehler erst auffällt, wenn
  // jemand das Häkchen setzt.
  const probe = structuredClone(candidate);
  for (const c of report.optional.gameTuning?.changes || []) probe.game[c.field] = c.to;
  for (const c of report.optional.queue?.changes || []) probe.engine[c.field] = c.to;
  validatePortable(probe);

  // ----- Aktionen -----
  let validatedActions = null;
  if (data.actions !== undefined && data.actions !== null) {
    // vollständige, strenge Prüfung JEDER Aktion - auch deaktivierter (sie ließen sich später
    // mit einem Klick aktivieren), inklusive requires, effect.dynamic, unbekannter Felder, Stufen
    // und Fluchrad. Roh geschriebene kritische Tasten sind in einem Import nie erlaubt
    // (rawCritical: []); über "@name" darf eine Aktion nur auf eine lokal bereits freigegebene
    // Belegung zeigen. Der erste Fehler lehnt das ganze Preset ab.
    const policy = { critical: cfg.input?.criticalKeys || [], rawCritical: [] };
    const problem = actionsFileProblem(data.actions, { keys: candidate.keys, policy });
    if (problem) throw new Error(problem);
    validatedActions = data.actions;

    // Vergleich mit dem, was lokal für das Ziel-Profil gerade gilt (nur lesen, nichts anlegen).
    const localRaw = readJson(actionsFile(profile.id), null) || readJson(actionsDefaultFile(profile.id), null) || { actions: [] };
    const local = new Map((localRaw.actions || []).map((a) => [a.id, a]));
    const critical = new Set();
    for (const a of validatedActions.actions) {
      let info = { keys: [], seconds: 0, untilStop: false, maxHoldMs: 0 };
      if (a.effect?.steps) {
        const c = compile(a.effect.steps, candidate.keys, policy);
        const holds = c.lines.filter((l) => l.startsWith('hold ')).map((l) => Number(l.split(' ')[2]));
        info = { keys: c.keys, seconds: Math.round(c.est.ms / 100) / 10, untilStop: c.est.untilStop, maxHoldMs: holds.length ? Math.max(...holds) : 0 };
        for (const k of c.keys) { const g = criticalGroup(k); if (g) critical.add(g); }
      }
      const entry = { id: a.id, title: a.title, enabled: !!a.enabled, cost: a.cost, kind: a.effect?.steps ? 'steps' : a.effect?.dynamic ? `dynamic:${a.effect.dynamic}` : a.effect?.overlay ? 'overlay' : 'none', ...info };
      const old = local.get(a.id);
      if (!old) { report.actions.added.push(entry); continue; }
      const what = [];
      if (old.title !== a.title) what.push('title');
      if (old.cost !== a.cost) what.push('cost');
      if (!!old.enabled !== !!a.enabled) what.push('enabled');
      if (old.category !== a.category) what.push('category');
      if ((old.access || 'everyone') !== (a.access || 'everyone')) what.push('access');
      if (JSON.stringify(old.requires || []) !== JSON.stringify(a.requires || [])) what.push('requires');
      if (JSON.stringify(old.effect || {}) !== JSON.stringify(a.effect || {})) what.push('effect');
      if (what.length) report.actions.changed.push({ ...entry, what }); else report.actions.unchanged++;
    }
    const incoming = new Set(validatedActions.actions.map((a) => a.id));
    for (const a of local.values()) if (!incoming.has(a.id)) report.actions.removed.push({ id: a.id, title: a.title, custom: !!a.custom });
    report.criticalUsed = [...critical];
  }
  return { candidate, validatedActions, overlayAssetWrites, report };
}

// Vorschau: was WÜRDE dieser Import tun? Schreibt nichts.
// Rückgabe: { ok: true, report } oder { ok: false, error } - bei ok: false würde der Import
// vollständig abgelehnt.
export function previewImport(cfg, data, accept) {
  try { return { ok: true, report: planImport(cfg, data, accept).report }; }
  catch (e) { return { ok: false, error: e.message }; }
}

// Wendet ein Preset an. Alles wird geprüft, BEVOR etwas geschrieben wird — bei einem Fehler bleiben
// die laufende Konfiguration, die Aktionen-Datei und die Medien unangetastet (keine Teilübernahme).
// Gibt zurück, ob Aktionen mit übernommen wurden (dann sollte danach mit Twitch abgeglichen werden,
// siehe rewards.js).
export function importProfile(cfg, data, accept) {
  const { candidate, validatedActions, overlayAssetWrites, report } = planImport(cfg, data, accept);
  Object.assign(cfg, candidate);
  saveConfig(cfg);
  if (validatedActions) fs.writeFileSync(actionsFile(cfg.game.profile), JSON.stringify(validatedActions, null, 2));
  if (overlayAssetWrites.length) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    for (const w of overlayAssetWrites) fs.writeFileSync(overlayAssetFile(w.filename), w.buf);
  }
  return { actionsImported: !!validatedActions, report };
}
