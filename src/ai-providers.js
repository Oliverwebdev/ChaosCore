// KI-Anbieter für den KI-Assistenten: jeweils nur mit Schlüssel des Streamers.
//
//   gemini     Google Gemini - kostenloses Kontingent, sieht Videos (kurze Vorschau-Version des Clips)
//   openai     OpenAI (ChatGPT) - sieht Standbilder
//   anthropic  Anthropic (Claude) - sieht Standbilder
//   compatible "Andere": alles mit OpenAI-kompatibler Schnittstelle (OpenRouter, Groq, Mistral,
//              LM Studio, Ollama …) - Adresse + Schlüssel; ob Bilder gehen, wird beim Verbinden geprüft
//
// Jeder Anbieter liefert: listModels(), ask({ prompt, video?, images? }) -> geparstes JSON.
// Modelle werden beim Verbinden beim Anbieter abgefragt (damit neue Modelle ohne Update gehen);
// die Vorschläge hier sind nur der Rückfall.

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

export const PROVIDERS = {
  gemini: { name: 'Google Gemini', keyUrl: 'https://aistudio.google.com/apikey', sees: 'video', free: true, model: 'gemini-3.5-flash-lite',
    prefer: [/flash-lite/, /flash/], base: 'https://generativelanguage.googleapis.com' },
  openai: { name: 'OpenAI (ChatGPT)', keyUrl: 'https://platform.openai.com/api-keys', sees: 'images', free: false, model: 'gpt-5-mini',
    prefer: [/^gpt-5(\.\d+)?-mini$/, /^gpt-5(\.\d+)?-nano$/, /mini/], base: 'https://api.openai.com/v1' },
  anthropic: { name: 'Anthropic (Claude)', keyUrl: 'https://console.anthropic.com/settings/keys', sees: 'images', free: false, model: 'claude-haiku-5-5',
    prefer: [/haiku/, /sonnet/], base: 'https://api.anthropic.com/v1' },
  compatible: { name: 'Andere (OpenAI-kompatibel)', keyUrl: '', sees: 'auto', free: false, model: '', prefer: [], base: '' },
};

// Für Tests: alle Anbieter auf einen eigenen Server umlenken (UCC_AI_API/<anbieter>).
function baseFor(provider, custom) {
  if (provider === 'compatible') return custom.replace(/\/$/, '');
  const t = process.env.UCC_AI_API;
  if (t) return `${t.replace(/\/$/, '')}/${provider}${provider === 'gemini' ? '' : '/v1'}`;
  return PROVIDERS[provider].base;
}

// Adresse für "Andere": https überall, http nur im eigenen Netz (sonst ginge der Schlüssel im Klartext übers Internet).
export function checkBaseUrl(u) {
  let url;
  try { url = new URL(String(u || '').trim()); } catch { throw new Error('Die Adresse sieht nicht richtig aus (Beispiel: https://openrouter.ai/api/v1)'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Die Adresse muss mit https:// beginnen');
  const h = url.hostname;
  const local = h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || /^(10|192\.168)\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.endsWith('.local');
  if (url.protocol === 'http:' && !local) throw new Error('Unverschlüsselt (http://) nur für KI auf diesem PC oder im Heimnetz - sonst bitte https://');
  if (url.username || url.password) throw new Error('Zugangsdaten gehören in das Schlüssel-Feld, nicht in die Adresse');
  return url.toString().replace(/\/$/, '');
}

class AiError extends Error { constructor(msg, status) { super(msg); this.status = status; } }

async function call(url, init, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  t.unref?.();
  let res;
  try { res = await fetch(url, { ...init, signal: ctl.signal }); } catch (e) {
    throw new AiError(e.name === 'AbortError' ? 'Die KI hat nicht rechtzeitig geantwortet' : 'Die KI ist gerade nicht erreichbar (Internet oder Adresse prüfen)', 0);
  } finally { clearTimeout(t); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const raw = JSON.stringify(body).slice(0, 2000);
    if (res.status === 401 || /API_KEY_INVALID|invalid[_ ]api[_ ]key|Incorrect API key|authentication_error/i.test(raw)) throw new AiError('Der Schlüssel ist ungültig - bitte neu kopieren', 401);
    if (res.status === 403) throw new AiError('Der Schlüssel darf dieses Modell nicht nutzen', 403);
    if (res.status === 429 || /insufficient_quota|RESOURCE_EXHAUSTED|rate_limit/i.test(raw)) throw new AiError('Kontingent oder Guthaben beim KI-Anbieter aufgebraucht - später nochmal oder Guthaben prüfen', 429);
    if (res.status === 404) throw new AiError('Dieses Modell gibt es beim Anbieter nicht (mehr) - bitte ein anderes wählen', 404);
    if (res.status === 413) throw new AiError('Der Clip ist für die KI zu groß', 413);
    const msg = clean(body.error?.message || body.message || '', 160);
    throw new AiError(`KI-Fehler (HTTP ${res.status})${msg ? `: ${msg}` : ''}`, res.status);
  }
  return body;
}

// Antworttext -> JSON (auch wenn die KI Codeblöcke oder Text drumherum schreibt).
export function parseJson(text) {
  const t = String(text || '').trim();
  try { return JSON.parse(t); } catch { /* weiter */ }
  const m = t.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* weiter */ } }
  throw new AiError('Die KI-Antwort war unbrauchbar', 422);
}

export function makeProvider({ provider, key, baseUrl = '', model = '' }) {
  const p = PROVIDERS[provider];
  if (!p) throw new AiError('Unbekannter KI-Anbieter', 400);
  const base = baseFor(provider, baseUrl);
  const mdl = () => model || p.model;

  if (provider === 'gemini') {
    return {
      async listModels() {
        const b = await call(`${base}/v1beta/models?pageSize=200`, { headers: { 'x-goog-api-key': key } }, 15000);
        return (b.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent')).map((m) => String(m.name).replace(/^models\//, '')).filter((n) => /^gemini/.test(n));
      },
      async ask({ prompt, video, images = [], timeoutMs = 20000 }) {
        const parts = [];
        if (video) parts.push({ inline_data: { mime_type: 'video/mp4', data: video.toString('base64') } });
        for (const im of images) parts.push({ inline_data: { mime_type: 'image/jpeg', data: im.toString('base64') } });
        parts.push({ text: prompt });
        const b = await call(`${base}/v1beta/models/${encodeURIComponent(mdl())}:generateContent`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: 0.9, maxOutputTokens: 800, responseMimeType: 'application/json' } }),
        }, timeoutMs);
        return parseJson(b.candidates?.[0]?.content?.parts?.map((x) => x.text || '').join(''));
      },
    };
  }

  if (provider === 'anthropic') {
    const headers = { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' };
    return {
      async listModels() {
        const b = await call(`${base}/models?limit=100`, { headers }, 15000);
        return (b.data || []).map((m) => m.id).filter(Boolean);
      },
      async ask({ prompt, images = [], timeoutMs = 20000 }) {
        const content = [...images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: im.toString('base64') } })), { type: 'text', text: prompt }];
        const b = await call(`${base}/messages`, { method: 'POST', headers, body: JSON.stringify({ model: mdl(), max_tokens: 800, messages: [{ role: 'user', content }] }) }, timeoutMs);
        return parseJson((b.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(''));
      },
    };
  }

  // openai + compatible: Chat-Completions-Schnittstelle
  const headers = { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) };
  return {
    async listModels() {
      const b = await call(`${base}/models`, { headers }, 15000);
      const ids = (b.data || b.models || []).map((m) => m.id || m.name).filter(Boolean);
      return provider === 'openai' ? ids.filter((id) => /^(gpt|o\d|chatgpt)/.test(id) && !/(audio|realtime|tts|transcribe|image|search|embedding|moderation|dall-e|whisper)/.test(id)) : ids;
    },
    async ask({ prompt, images = [], timeoutMs = 20000 }) {
      const content = images.length ? [{ type: 'text', text: prompt }, ...images.map((im) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${im.toString('base64')}` } }))] : prompt;
      const body = { model: mdl(), messages: [{ role: 'user', content }], response_format: { type: 'json_object' } };
      // OpenAI-Modelle mit "Nachdenken" kennen nur max_completion_tokens; andere Server meist nur max_tokens.
      if (provider === 'openai') body.max_completion_tokens = 2000; else body.max_tokens = 800;
      const b = await call(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) }, timeoutMs);
      return parseJson(b.choices?.[0]?.message?.content);
    },
  };
}

// Aus der Modell-Liste das passende wählen: das bisherige, sonst das empfohlene, sonst das erste.
export function pickModel(provider, models, current = '') {
  if (current && (!models.length || models.includes(current))) return current;
  const p = PROVIDERS[provider];
  if (models.includes(p.model)) return p.model;
  for (const re of p.prefer) {
    const hit = models.filter((m) => re.test(m) && !/(preview|exp|tts|image|embedding|vision-preview)/.test(m)).sort().reverse()[0];
    if (hit) return hit;
  }
  return models[0] || p.model;
}

// Winziges JPEG (16x16, grau) - zum Prüfen, ob eine "andere" KI Bilder annimmt.
export const PROBE_JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAAQABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwAooooA/9k=', 'base64');
