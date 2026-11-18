// Raid, Follow, Sub und Hype Train als Auslöser für Effekte.
//
// Bewusst einfach: pro Ereignis an/aus, welcher Effekt (oder "zufällig") und ein eigener Cooldown.
// Standard ist alles AUS - wer es will, schaltet es im Dashboard ein. Ein Effekt aus einem Ereignis
// läuft wie der Chaos-Overload als "System"-Effekt: keine Einlösung, nichts zu erstatten, keine
// Punkte für Bestenlisten.
export const STREAM_EVENTS = ['raid', 'follow', 'sub', 'hype'];

export const STREAM_EVENTS_DEFAULT = {
  raid: { enabled: false, actionId: null, cooldownSec: 60, min: 5 }, // min = Zuschauer im Raid
  follow: { enabled: false, actionId: null, cooldownSec: 300, min: 1 },
  sub: { enabled: false, actionId: null, cooldownSec: 60, min: 1 }, // min = Abos (bei Geschenk-Abos die Anzahl)
  hype: { enabled: false, actionId: null, cooldownSec: 600, min: 1 }, // min = Hype-Train-Level beim Start
};

// Zusätzliche Rechte: Follows lesen und Hype Train. Subs braucht channel:read:subscriptions (ist schon dabei).
export const EVENT_SCOPES = 'moderator:read:followers channel:read:hype_train';
export const EVENT_SCOPE_FOR = { follow: 'moderator:read:followers', sub: 'channel:read:subscriptions', hype: 'channel:read:hype_train', raid: null };

const LIMITS = { cooldownSec: [0, 86400], min: [1, 100000] };

export function normalizeStreamEvents(v, prev = STREAM_EVENTS_DEFAULT) {
  const src = v && typeof v === 'object' ? v : {};
  const out = {};
  for (const k of STREAM_EVENTS) {
    const d = { ...STREAM_EVENTS_DEFAULT[k], ...(prev?.[k] || {}) };
    const e = src[k] && typeof src[k] === 'object' ? src[k] : {};
    const num = (key) => {
      const n = Math.round(Number(e[key] ?? d[key]));
      const [lo, hi] = LIMITS[key];
      return Number.isFinite(n) && n >= lo && n <= hi ? n : d[key];
    };
    out[k] = {
      enabled: e.enabled === true,
      actionId: typeof e.actionId === 'string' && /^[\w.-]{1,64}$/.test(e.actionId) ? e.actionId : null,
      cooldownSec: num('cooldownSec'),
      min: num('min'),
    };
  }
  return out;
}
