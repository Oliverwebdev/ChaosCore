// CS2-Anbindung: Steam-Pfad finden, GSI- und Bind-Konfiguration installieren.
import fs from 'node:fs';
import path from 'node:path';

// Interne Binds laufen über Nummernblock-Tasten (Source/CS2 kennt F13-F24 nicht zuverlässig).
// AutoHotkey-Name -> CS2-Bind-Name. Wirkt auch ohne echten Nummernblock, weil die Tasten nur simuliert werden.
// CS2 (Source 2) kennt NUR diese Namen. Die alten Source-1-Namen (kp_home, kp_end, kp_ins,
// kp_uparrow, kp_slash ...) lehnt CS2 mit "isn't a valid key" ab - der Bind fehlt dann still.
// Live geprüft 2026-11-14 in CS2 (Konsole: bind kp_7 / bind kp_home).
const KP = {
  Numpad0: 'kp_0', Numpad1: 'kp_1', Numpad2: 'kp_2', Numpad3: 'kp_3', Numpad4: 'kp_4',
  Numpad5: 'kp_5', Numpad6: 'kp_6', Numpad7: 'kp_7', Numpad8: 'kp_8', Numpad9: 'kp_9',
  NumpadDiv: 'kp_divide', NumpadMult: 'kp_multiply', NumpadSub: 'kp_minus', NumpadAdd: 'kp_plus',
  NumpadEnter: 'kp_enter', NumpadDot: 'kp_del',
};
export function cs2KeyName(ahk) {
  if (KP[ahk]) return KP[ahk];
  if (/^[A-Za-z0-9]$/.test(ahk)) return ahk.toLowerCase();
  if (/^F([1-9]|1[0-2])$/.test(ahk)) return ahk.toLowerCase();
  return null;
}
// Diese Tasten-Namen (config.keys) bekommen einen Bind in der cfg und müssen CS2 kennen.
export const BIND_KEYS = ['gHe', 'gFlash', 'gSmoke', 'gMolly', 'gDecoy', 'xhOff', 'xhOn', 'xhColor', 'fireOff', 'fireOn', 'zoomOff', 'zoomOn', 'xhBig', 'mouseInv', 'restoreExtra', 'lastInv'];

// Granate -> Name der Config-Taste mit dem passenden Bind
export const GRENADE_BIND = {
  weapon_hegrenade: 'gHe', weapon_flashbang: 'gFlash', weapon_smokegrenade: 'gSmoke',
  weapon_molotov: 'gMolly', weapon_incgrenade: 'gMolly', weapon_decoy: 'gDecoy',
};

const REL_CFG = path.join('steamapps', 'common', 'Counter-Strike Global Offensive', 'game', 'csgo', 'cfg');

function steamRoots() {
  const roots = [];
  const env = process.env;
  if (process.platform === 'win32') {
    for (const base of [env['ProgramFiles(x86)'], env.ProgramFiles, 'C:\\Program Files (x86)', 'D:', 'C:']) {
      if (base) roots.push(path.join(base, 'Steam'), path.join(base, 'SteamLibrary'));
    }
  } else {
    const home = env.HOME || '';
    roots.push(path.join(home, '.steam', 'steam'), path.join(home, '.local', 'share', 'Steam'),
      path.join(home, 'Library', 'Application Support', 'Steam'));
  }
  const all = new Set();
  for (const r of roots) {
    if (!fs.existsSync(r)) continue;
    all.add(r);
    try {
      const vdf = fs.readFileSync(path.join(r, 'steamapps', 'libraryfolders.vdf'), 'utf8');
      for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) all.add(m[1].replace(/\\\\/g, '\\'));
    } catch { /* keine Library-Datei */ }
  }
  return [...all];
}

// ---------- Dein eigenes Fadenkreuz ----------
// CS2 speichert deine Einstellungen pro Steam-Konto in
//   <Steam>/userdata/<Konto>/730/local/cfg/cs2_user_convars_0_slot0.vcfg
// ChaosCore liest daraus NUR das Fadenkreuz (Stil, Länge, Farbe, Deckkraft), damit "Fadenkreuz riesig"
// mit jedem Stil funktioniert und danach genau DEIN Fadenkreuz zurückkommt. Geschrieben wird dort nie.
export const CONVARS_FILE = 'cs2_user_convars_0_slot0.vcfg';
// Stile mit Linien (bei Kreis, Punkt und Quadrat hat die Linienlänge keine Wirkung):
// 0 Dynamic Cross, 2 Dynamic Cross (Legacy), 4 Static Cross, 5 Static Cross (Shot Feedback), 7 Dynamic Quad
export const LINE_STYLES = [0, 2, 4, 5, 7];

export function findCs2Convars() {
  let best = null;
  for (const root of steamRoots()) {
    let ids = [];
    try { ids = fs.readdirSync(path.join(root, 'userdata')); } catch { continue; }
    for (const id of ids) {
      const f = path.join(root, 'userdata', id, '730', 'local', 'cfg', CONVARS_FILE);
      try { const m = fs.statSync(f).mtimeMs; if (!best || m > best.m) best = { f, m }; } catch { /* kein CS2 auf diesem Konto */ }
    }
  }
  return best?.f || null;
}

// Liest die Fadenkreuz-Werte aus der vcfg (KeyValues: "name" "wert"). Fehlt etwas, bleibt es weg.
export function readUserCrosshair(file = findCs2Convars()) {
  if (!file) return null;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const get = (name) => { const m = text.match(new RegExp(`"${name}"\\s+"(-?[0-9.]+)"`)); return m ? Number(m[1]) : undefined; };
  const xh = {
    style: get('cl_crosshairstyle'), length: get('cl_crosshair_length'),
    r: get('cl_crosshaircolor_r'), g: get('cl_crosshaircolor_g'), b: get('cl_crosshaircolor_b'), alpha: get('cl_crosshaircolor_a'),
  };
  const ok = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;
  const out = {};
  if (ok(xh.style, 0, 8) && Number.isInteger(xh.style)) out.style = xh.style;
  if (ok(xh.length, 0, 200)) out.length = xh.length;
  if ([xh.r, xh.g, xh.b].every((v) => ok(v, 0, 255))) out.color = [xh.r, xh.g, xh.b].map(Math.round);
  if (ok(xh.alpha, 1, 255)) out.alpha = Math.round(xh.alpha);
  return Object.keys(out).length ? out : null;
}

// Kurzer Fingerabdruck des Fadenkreuzes in der Bind-Datei: ändert sich dein Fadenkreuz in CS2,
// schreibt ChaosCore die Datei beim nächsten Start neu (siehe cs2FilesInstalled).
const crosshairMark = (xh) => (xh ? `style=${xh.style ?? '-'} length=${xh.length ?? '-'} color=${xh.color?.join(',') ?? '-'} alpha=${xh.alpha ?? '-'}` : 'unbekannt');

export function findCs2CfgDir() {
  for (const root of steamRoots()) {
    const dir = path.join(root, REL_CFG);
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

// Dateiname der GSI-Konfiguration im CS2-cfg-Ordner. Bis 2026-11-16 hieß sie
// "gamestate_integration_unknown.cfg"; installCs2Files() entfernt die alte Datei, denn lägen beide
// im Ordner, schickte CS2 jedes Paket doppelt.
export const GSI_FILE = 'gamestate_integration_chaoscore.cfg';
export const GSI_FILE_OLD = 'gamestate_integration_unknown.cfg';
// Erkennungszeichen, dass die installierte Datei den Stand für Session Stats hat.
// Steht als eigener Datenblock in der Datei; ältere Dateien haben ihn nicht.
const GSI_MARK = '"player_match_stats"';

// Valve-KeyValues-Format, ohne BOM (fs.writeFileSync mit String schreibt UTF-8 ohne BOM).
// buffer/throttle 0.1 s: Ereignisse kommen schnell genug für Effekt-Bedingungen und die
// Todeszuordnung; heartbeat 10 s: ein Lebenszeichen auch ohne Änderung (Verbindungsanzeige).
// player_match_stats: Kills/Tode/Assists/MVPs des Matches (Session Stats, Schritt 12).
export function gsiCfg(port, token) {
  return `"ChaosCore"
{
  "uri"        "http://127.0.0.1:${port}/gsi"
  "timeout"    "5.0"
  "buffer"     "0.1"
  "throttle"   "0.1"
  "heartbeat"  "10.0"
  "auth"       { "token" "${token}" }
  "data"
  {
    "provider"            "1"
    "map"                 "1"
    "round"               "1"
    "player_id"           "1"
    "player_state"        "1"
    "player_weapons"      "1"
    ${GSI_MARK}  "1"
  }
}
`;
}

export const BINDS_VERSION = 11;
const RESTORE_ON = '// Sicherheitsnetz: falls ein Effekt abgebrochen wurde, stehen die Maustasten nach dem Laden wieder auf Standard\nucc_restore';
const RESTORE_OFF = '// (Sicherheitsnetz deaktiviert: game.restoreMouseBinds)';

// Taste zum Auswählen einer Granate: Blendgranate = deine eigene Taste (Standard 7), sonst der Bind aus der cfg.
export function grenadeKey(name, keys) {
  return name === 'weapon_flashbang' ? keys.flash : keys[GRENADE_BIND[name]];
}
// Zusätzlicher Weg über unseren eigenen Bind (in der cfg: slot6-10)
export function grenadeBindKey(name, keys) {
  return keys[GRENADE_BIND[name]];
}

// xh: dein Fadenkreuz aus CS2 (readUserCrosshair) - hat Vorrang vor den Werten in data/config.json.
export function bindsCfg(game = {}, keys, xh = null) {
  const k = (n) => cs2KeyName(keys[n]);
  const alpha = xh?.alpha ?? (Number(game.crosshairAlpha) || 255);
  const xhSize = xh?.length ?? (Number(game.crosshairSize) || 5); // deine normale Linienlänge (Wiederherstellung)
  const xhBigSize = Number(game.crosshairBigSize) || 80; // Größe für "Fadenkreuz riesig"
  const mPitch = Number(game.mPitch) || 0.022;          // deine normale vertikale Mausempfindlichkeit (cvar m_pitch)
  // deine normale Fadenkreuz-Farbe (Wiederherstellung nach "Zufällige Crosshair-Farbe")
  const xc = xh?.color || (Array.isArray(game.crosshairColor) && game.crosshairColor.length === 3 ? game.crosshairColor.map((v) => Math.max(0, Math.min(255, Math.round(Number(v) || 0)))) : [50, 250, 50]);
  // Kreis, Punkt oder Quadrat haben keine Linien: für "Fadenkreuz riesig" kurz auf das statische Kreuz (4)
  // umschalten und danach wieder auf deinen Stil. Linien-Stile bleiben, wie sie sind.
  const style = xh?.style;
  const switchStyle = style !== undefined && !LINE_STYLES.includes(style);
  const bigStyle = switchStyle ? 'cl_crosshairstyle 4; ' : '';
  const ownStyle = switchStyle ? `cl_crosshairstyle ${style}; ` : '';
  const xhColor = `cl_crosshaircolor_r ${xc[0]}; cl_crosshaircolor_g ${xc[1]}; cl_crosshaircolor_b ${xc[2]}`;
  const restore = game.restoreMouseBinds !== false;
  return `// Unknown Chat Control - Binds (automatisch erzeugt, Version ${BINDS_VERSION})
// ucc-binds-version: ${BINDS_VERSION}
// ucc-crosshair: ${crosshairMark(xh)}
// Nutzt Nummernblock-Tasten (siehe data/config.json, keys). Belege diese im Spiel nicht anderweitig.

// Dein Fadenkreuz bleibt, wie du es eingestellt hast: ChaosCore setzt beim Laden keinen Stil mehr
// (bis Version 9 stand hier "cl_crosshairstyle 4", das hat jedes eigene Fadenkreuz überschrieben).

// CS2 wählt Granaten nur über slot6-10 ("use weapon_..." wird in Binds abgelehnt, live geprüft 2026-11-14)
bind ${k('gHe')} "slot6"
bind ${k('gFlash')} "slot7"
bind ${k('gSmoke')} "slot8"
bind ${k('gMolly')} "slot10"
bind ${k('gDecoy')} "slot9"

// Crosshair unsichtbar / zurück. CS2 kennt cl_crosshairusealpha nicht mehr und ignoriert
// cl_crosshairalpha 0 - nur der cvar "crosshair" blendet zuverlässig aus (live geprüft 2026-11-15).
bind ${k('xhOff')} "crosshair 0"
bind ${k('xhOn')} "crosshair 1"

// Zufällige Crosshair-Farbe
// CS2 wertet cl_crosshaircolor (0-4) nicht mehr aus - Farbe nur noch über cl_crosshaircolor_r/g/b (live geprüft 2026-11-15).
alias ucc_cc0 "cl_crosshaircolor_r 255; cl_crosshaircolor_g 0; cl_crosshaircolor_b 0; alias ucc_ccn ucc_cc1"
alias ucc_cc1 "cl_crosshaircolor_r 0; cl_crosshaircolor_g 255; cl_crosshaircolor_b 0; alias ucc_ccn ucc_cc2"
alias ucc_cc2 "cl_crosshaircolor_r 255; cl_crosshaircolor_g 255; cl_crosshaircolor_b 0; alias ucc_ccn ucc_cc3"
alias ucc_cc3 "cl_crosshaircolor_r 0; cl_crosshaircolor_g 0; cl_crosshaircolor_b 255; alias ucc_ccn ucc_cc4"
alias ucc_cc4 "cl_crosshaircolor_r 255; cl_crosshaircolor_g 0; cl_crosshaircolor_b 255; alias ucc_ccn ucc_cc0"
alias ucc_ccn "ucc_cc0"
bind ${k('xhColor')} "ucc_ccn"

// Feuerpause (linke Maustaste) und Kein Zoom (rechte Maustaste): Sperre direkt im Spiel.
// "-attack" zuerst, damit kein Dauerfeuer hängen bleibt.
bind ${k('fireOff')} "-attack; unbind mouse1"
bind ${k('fireOn')} "bind mouse1 +attack"
bind ${k('zoomOff')} "-attack2; unbind mouse2"
bind ${k('zoomOn')} "bind mouse2 +attack2"

// Fadenkreuz riesig und Maus invertieren (vertikal) teilen sich eine Wiederherstellungs-Taste,
// weil immer nur ein Effekt gleichzeitig läuft (Queue erlaubt nur eine aktive Aktion).
// CS2 wertet cl_crosshairsize nicht mehr aus - die Länge heißt jetzt cl_crosshair_length (live geprüft 2026-11-15).
bind ${k('xhBig')} "${bigStyle}cl_crosshair_length ${xhBigSize}"
bind ${k('mouseInv')} "m_pitch -${mPitch}"
// Die gemeinsame Wiederherstellungs-Taste ruft das komplette Sicherheitsnetz (ucc_restore, unten):
// Maustasten, Fadenkreuz an, Stil, Länge, Farbe, Maus-Richtung. Not-Aus drückt sie ebenfalls.
bind ${k('restoreExtra')} "ucc_restore"

// Letzte Waffe über einen eigenen Bind: liegt bei manchen Streamern auf Q etwas anderes (z. B.
// Push-to-Talk), wäre "press q" sonst falsch (Fix 2026-11-15).
bind ${k('lastInv')} "lastinv"

alias ucc_restore "bind mouse1 +attack; bind mouse2 +attack2; ${ownStyle}crosshair 1; cl_crosshaircolor_a ${alpha}; cl_crosshair_length ${xhSize}; m_pitch ${mPitch}; ${xhColor}"
${restore ? RESTORE_ON : RESTORE_OFF}
`;
}

export function installCs2Files(dir, port, token, game = {}, keys) {
  fs.writeFileSync(path.join(dir, GSI_FILE), gsiCfg(port, token));
  try { fs.rmSync(path.join(dir, GSI_FILE_OLD), { force: true }); } catch { /* egal */ }
  fs.writeFileSync(path.join(dir, 'unknown_chat_control.cfg'), bindsCfg(game, keys, readUserCrosshair()));
  const auto = path.join(dir, 'autoexec.cfg');
  let text = '';
  try { text = fs.readFileSync(auto, 'utf8'); } catch { /* neu */ }
  if (!/^\s*exec\s+unknown_chat_control\b/m.test(text)) {
    fs.writeFileSync(auto, text + (text && !text.endsWith('\n') ? '\n' : '') + 'exec unknown_chat_control\n');
  }
}

export function cs2FilesInstalled(dir) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  let autoexec = false;
  try { autoexec = /^\s*exec\s+unknown_chat_control\b/m.test(fs.readFileSync(path.join(dir, 'autoexec.cfg'), 'utf8')); } catch { /* fehlt */ }
  let current = false;
  // aktuell = neueste Version UND dein Fadenkreuz in CS2 ist noch dasselbe wie beim Schreiben
  try { const t = fs.readFileSync(path.join(dir, 'unknown_chat_control.cfg'), 'utf8'); current = t.includes(`ucc-binds-version: ${BINDS_VERSION}`) && t.includes(`ucc-crosshair: ${crosshairMark(readUserCrosshair())}`); } catch { /* fehlt */ }
  // gsiCurrent: neue Datei mit Match-Stats vorhanden UND keine alte Datei mehr daneben.
  let gsiCurrent = false;
  try { gsiCurrent = fs.readFileSync(path.join(dir, GSI_FILE), 'utf8').includes(GSI_MARK) && !has(GSI_FILE_OLD); } catch { /* fehlt */ }
  return { gsi: has(GSI_FILE) || has(GSI_FILE_OLD), gsiCurrent, binds: has('unknown_chat_control.cfg'), autoexec, current: current && gsiCurrent };
}
