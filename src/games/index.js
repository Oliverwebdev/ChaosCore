// Registry der Spiel-Profile.
//
// Ein Spiel-Profil beschreibt, WAS ein Spiel ausmacht, nicht WIE Tasten gedrückt werden - die
// Tasten-/Maussimulation selbst (src/steps.js) ist bereits generisch und bleibt es. Ein Profil
// legt nur fest:
//   - id/name: Anzeige und gespeicherter Wert in cfg.game.profile
//   - supportsGsi: hat dieses Spiel eine eigene Spielzustand-Schnittstelle (wie CS2's GSI)?
//     Ohne GSI läuft die Engine automatisch im "blinden" Modus weiter (siehe engine.js: evaluate()) -
//     das ist kein Sonderfall, der hier zusätzlich programmiert werden müsste.
//   - keyDefaults: Vorlage für cfg.keys, wenn dieses Profil zum ersten Mal aktiv wird (siehe
//     applyGameProfile() in config.js) - ergänzt nur fehlende Tasten, überschreibt nie eine
//     schon vom Streamer angepasste.
//   - extraKeyCheck(keys): zusätzliche, profil-eigene Regeln (z. B. CS2s Nummernblock-Zwang für
//     die internen Binds) - optional, Standard: keine zusätzliche Regel.
//
// Ein neues Spiel hinzuzufügen heißt: eine weitere Datei in diesem Ordner nach demselben Muster,
// plus (falls das Spiel eigene Effekte braucht) eine eigene config/actions.<id>.default.json -
// keine neue Engine-Logik. Das ist das Ziel aus Schritt 1.
import { BIND_KEYS, cs2KeyName } from '../cs2.js';

export const CS2_PROFILE = {
  id: 'cs2',
  name: 'Counter-Strike 2',
  supportsGsi: true,
  // Entspricht den bisherigen DEFAULTS.keys aus config.js - unverändert, damit ein bestehender
  // Nutzer beim Update exakt dieselben Tasten behält.
  keyDefaults: {
    primary: '1', secondary: '2', knife: '3', grenades: '4', c4: '5',
    last: 'q', walk: 'Shift', use: 'e', drop: 'g', duck: 'LCtrl', inspect: 'f',
    flash: '7',
    forward: 'w', left: 'a', back: 's', right: 'd',
    jump: 'Space', scoreboard: 'Tab', buy: 'b',
    gHe: 'Numpad7', gFlash: 'Numpad8', gSmoke: 'Numpad9', gMolly: 'Numpad4', gDecoy: 'Numpad5',
    xhOff: 'Numpad1', xhOn: 'Numpad2', xhColor: 'Numpad3',
    fireOff: 'NumpadDiv', fireOn: 'NumpadMult', zoomOff: 'NumpadSub', zoomOn: 'NumpadAdd',
    xhBig: 'Numpad0', mouseInv: 'NumpadEnter', restoreExtra: 'NumpadDot',
    lastInv: 'Numpad6',
  },
  // CS2 braucht für die internen Binds (gHe, xhOff, fireOff, ...) echte CS2-Bind-Namen - die
  // Source-Engine kennt z. B. kein F13-F24, deshalb der Nummernblock-Zwang (siehe cs2.js).
  extraKeyCheck(keys) {
    for (const n of BIND_KEYS) {
      if (keys[n] && !cs2KeyName(keys[n])) {
        throw new Error(`Taste "${keys[n]}" (${n}) kann in CS2 nicht gebunden werden. Erlaubt: Nummernblock (Numpad0-9, NumpadDiv, NumpadMult, NumpadSub, NumpadAdd), Buchstaben, Ziffern, F1-F12. Die Source-Engine kennt F13-F24 nicht.`);
      }
    }
  },
};

// Seit 2.0 konzentriert sich ChaosCore auf CS2. Die Profil-Technik bleibt, damit später ein weiteres
// Spiel mit echter Spielanbindung dazukommen kann.
export const PROFILES = { cs2: CS2_PROFILE };

export function profileIds() {
  return Object.keys(PROFILES);
}

export function getProfile(id) {
  return PROFILES[id] || CS2_PROFILE;
}

export function isKnownProfile(id) {
  return Object.prototype.hasOwnProperty.call(PROFILES, id);
}
