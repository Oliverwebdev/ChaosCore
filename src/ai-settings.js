// Einstellungen des KI-Assistenten (ohne Abhängigkeit zu config.js, damit config.js sie einbinden kann).
// Der Schlüssel steht NICHT hier, sondern verschlüsselt in data/ai-key.json (siehe ai.js).
export const AI_TONES = ['frech', 'episch', 'trocken', 'witzig'];
export const AI_PROVIDER_IDS = ['gemini', 'openai', 'anthropic', 'compatible'];
export const AI_SEES = ['video', 'images', 'text'];

export const AI_DEFAULT = {
  provider: '',          // leer = nicht eingerichtet
  model: '',             // leer = Empfehlung des Anbieters
  baseUrl: '',           // nur "Andere"
  sees: '',              // was die KI sieht (wird beim Verbinden ermittelt)
  analyze: 'auto',       // neue Clips mit Video automatisch analysieren | 'manual' = nur per Knopf
  apply: 'suggest',      // Ergebnis als Vorschlag zeigen | 'auto' = Titel direkt eintragen
  uploads: true,         // Titel/Hashtags/Beschreibung für Uploads von der KI
  maxPerStream: 10,      // automatische Analysen pro Stream (Kosten im Griff)
  tone: 'frech',
  lang: 'de',
};

export function normalizeAi(v) {
  const o = v && typeof v === 'object' ? v : {};
  const n = (x, d, lo, hi) => { const k = Math.round(Number(x ?? d)); return k >= lo && k <= hi ? k : d; };
  const model = String(o.model || '').trim();
  // Stand 2.1-Testbuild: nur Gemini, Modell stand schon in den Einstellungen
  const provider = AI_PROVIDER_IDS.includes(o.provider) ? o.provider : '';
  return {
    provider,
    model: /^[A-Za-z0-9][A-Za-z0-9._:/@-]{1,100}$/.test(model) ? model : '',
    baseUrl: provider === 'compatible' ? String(o.baseUrl || '').trim().slice(0, 300) : '',
    sees: AI_SEES.includes(o.sees) ? o.sees : '',
    analyze: o.analyze === 'manual' ? 'manual' : 'auto',
    apply: o.apply === 'auto' ? 'auto' : 'suggest',
    uploads: o.uploads !== false,
    maxPerStream: n(o.maxPerStream, AI_DEFAULT.maxPerStream, 0, 50),
    tone: AI_TONES.includes(o.tone) ? o.tone : AI_DEFAULT.tone,
    lang: o.lang === 'en' ? 'en' : 'de',
  };
}
