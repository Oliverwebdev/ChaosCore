// Einstellungen des KI-Assistenten (ohne Abhängigkeit zu config.js, damit config.js sie einbinden kann).
export const AI_TONES = ['frech', 'episch', 'trocken', 'witzig'];
// Gemini-Modell: klein und schnell reicht für Titel. Ändert Google die Modelle, hier anpassen
// (oder per Einstellung "model" überschreiben).
export const AI_MODEL_DEFAULT = 'gemini-3.5-flash-lite';
export const AI_DEFAULT = { uploads: true, tone: 'frech', lang: 'de', model: AI_MODEL_DEFAULT };

export function normalizeAi(v) {
  const o = v && typeof v === 'object' ? v : {};
  const model = String(o.model || '').trim();
  return {
    uploads: o.uploads !== false,
    tone: AI_TONES.includes(o.tone) ? o.tone : AI_DEFAULT.tone,
    lang: o.lang === 'en' ? 'en' : 'de',
    model: /^[a-z0-9][a-z0-9.-]{2,60}$/.test(model) ? model : AI_MODEL_DEFAULT,
  };
}
