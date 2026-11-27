// KI-Assistent (2.1): schreibt Titel, Hashtags und Beschreibung für Clips und schlägt Stream-Titel vor.
//
// Anbieter: Google Gemini mit dem eigenen, kostenlosen Schlüssel des Streamers (aistudio.google.com).
// Der Schlüssel liegt verschlüsselt im Datenordner (Windows: DPAPI) und steht nie im Log oder im Dashboard.
// An die KI geht nur, was für den Text nötig ist (Spiel, Map, Moment, Zuschauername, Kanalname).
// Klappt die KI nicht (kein Netz, Kontingent leer), nimmt ChaosCore still seine Vorlagen.
import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './config.js';
import { protect, unprotect, cryptoAvailable } from './secret-store.js';

export const AI_KEY_URL = 'https://aistudio.google.com/apikey';
const keyFile = () => path.join(DATA, 'ai-key.json');

function apiBase() { return (process.env.UCC_AI_API || 'https://generativelanguage.googleapis.com').replace(/\/$/, ''); }

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

const TONE_TEXT = {
  de: { frech: 'frech und mit Augenzwinkern', episch: 'episch und dramatisch', trocken: 'trocken und kurz', witzig: 'witzig, mit einem Wortspiel wenn es passt' },
  en: { frech: 'cheeky, with a wink', episch: 'epic and dramatic', trocken: 'dry and short', witzig: 'funny, with a pun if it fits' },
};
const MOMENT_TEXT = {
  streak: 'mehrere Kills in einer Runde', chaos_death: 'Tod durch einen Zuschauer-Effekt', clutch: 'Clutch-Situation',
  bits: 'Bits-Moment', raid: 'Raid', hype: 'Hype Train', viewer_clip: 'ein Zuschauer hat per Kanalpunkte „Clip das!“ ausgelöst',
};

export class Ai {
  constructor({ cfg, logger, channel = () => '' }) {
    Object.assign(this, { cfg, logger, channel });
    this.key = this.loadKey();
  }

  loadKey() {
    try {
      const rec = JSON.parse(fs.readFileSync(keyFile(), 'utf8'));
      return rec.protected ? unprotect(rec.value) : rec.value;
    } catch { return ''; }
  }
  saveKey(key) {
    fs.mkdirSync(DATA, { recursive: true });
    if (!key) { fs.rmSync(keyFile(), { force: true }); this.key = ''; return; }
    let rec = { protected: false, value: key };
    if (cryptoAvailable()) { try { rec = { protected: true, value: protect(key) }; } catch { /* unverschlüsselt, nur lokal */ } }
    fs.writeFileSync(keyFile(), JSON.stringify(rec), { mode: 0o600 });
    this.key = key;
  }

  get connected() { return !!this.key; }
  publicState() { return { connected: this.connected, provider: 'gemini', keyUrl: AI_KEY_URL, settings: this.cfg.ai }; }

  // Ein Aufruf bei Gemini; Antwort als JSON (responseMimeType). Fehler mit verständlichem Text.
  async ask(prompt, { key = this.key, timeoutMs = 15000 } = {}) {
    if (!key) throw new Error('Kein KI-Schlüssel hinterlegt');
    const model = this.cfg.ai.model;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    t.unref?.();
    let res;
    try {
      res = await fetch(`${apiBase()}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.9, maxOutputTokens: 400, responseMimeType: 'application/json' } }),
      });
    } catch (e) {
      throw new Error(e.name === 'AbortError' ? 'Die KI hat nicht rechtzeitig geantwortet' : 'Die KI ist gerade nicht erreichbar (Internet?)');
    } finally { clearTimeout(t); }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = JSON.stringify(body.error?.details || '') + (body.error?.status || '');
      if (res.status === 400 && /API_KEY_INVALID|API key not valid/i.test(reason + (body.error?.message || ''))) throw Object.assign(new Error('Der Schlüssel ist ungültig - bitte neu kopieren'), { status: 400 });
      if (res.status === 403) throw Object.assign(new Error('Der Schlüssel darf Gemini nicht nutzen - im Google AI Studio einen neuen erstellen'), { status: 403 });
      if (res.status === 429) throw Object.assign(new Error('Das kostenlose KI-Kontingent ist gerade aufgebraucht - später nochmal'), { status: 429 });
      if (res.status === 404) throw Object.assign(new Error(`KI-Modell „${model}“ gibt es nicht (mehr) - ChaosCore-Update nötig`), { status: 404 });
      throw Object.assign(new Error(`KI-Fehler (HTTP ${res.status})`), { status: res.status });
    }
    const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    try { return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { throw new Error('Die KI-Antwort war unbrauchbar'); }
  }

  // Schlüssel prüfen und speichern.
  async connect(key) {
    const k = clean(key, 200);
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(k)) throw new Error('Das sieht nicht wie ein Gemini-Schlüssel aus (beginnt meist mit „AIza“)');
    const r = await this.ask('Antworte nur mit dem JSON {"ok": true}.', { key: k });
    if (!r || r.ok !== true) throw new Error('Die KI hat unerwartet geantwortet');
    this.saveKey(k);
    this.logger.info('KI-Assistent verbunden (Gemini).');
  }
  disconnect() { this.saveKey(''); this.logger.info('KI-Assistent entfernt.'); }

  styleLine() {
    const a = this.cfg.ai;
    return a.lang === 'en'
      ? `Write in English. Tone: ${TONE_TEXT.en[a.tone]}.`
      : `Schreibe auf Deutsch. Ton: ${TONE_TEXT.de[a.tone]}.`;
  }

  // Titel, Hashtags und Beschreibung für einen Clip. row: Highlight-Zeile (type, title, users, score).
  async clipText(row) {
    const channel = clean(this.channel(), 40);
    const prompt = [
      'Du schreibst Texte für einen kurzen Hochkant-Clip (YouTube Shorts / TikTok) aus einem Counter-Strike-2-Twitch-Stream.',
      this.styleLine(),
      `Streamer: ${channel || 'unbekannt'}. Spiel: Counter-Strike 2.`,
      `Moment: ${MOMENT_TEXT[row.type] || 'Highlight'}. Bisheriger Titel: "${clean(row.title, 140)}".`,
      row.users ? `Beteiligte Zuschauer: ${clean(row.users, 80)}.` : '',
      'Regeln: Titel höchstens 70 Zeichen, ohne Hashtags, ohne Anführungszeichen, kein Clickbait-Lügen, keine Beleidigungen.',
      'Hashtags: 3 bis 5 passende, jeweils mit #, ohne Leerzeichen, inklusive #CS2.',
      'Beschreibung: 1 bis 2 kurze Sätze.',
      'Antworte nur als JSON: {"title": "...", "hashtags": ["#..."], "description": "..."}',
    ].filter(Boolean).join('\n');
    const r = await this.ask(prompt);
    const title = clean(r.title, 90).replace(/#[\p{L}\p{N}_]+/gu, '').replace(/^["„“]|["“”]$/g, '').trim();
    if (!title) throw new Error('Die KI hat keinen Titel geliefert');
    const hashtags = [...new Set((Array.isArray(r.hashtags) ? r.hashtags : []).map((h) => '#' + String(h).replace(/[^\p{L}\p{N}_]/gu, '')).filter((h) => h.length > 2))].slice(0, 6);
    return { title, hashtags, description: clean(r.description, 400) };
  }

  // Stream-Titel und Tags für Twitch vorschlagen.
  async streamText({ title = '', category = '', tags = [] } = {}) {
    const channel = clean(this.channel(), 40);
    const prompt = [
      'Du schlägst einen Twitch-Stream-Titel und Tags vor, die neugierig machen und gefunden werden.',
      this.styleLine(),
      `Kanal: ${channel || 'unbekannt'}. Kategorie: ${clean(category, 60) || 'Counter-Strike'}.`,
      'Besonderheit des Kanals: Zuschauer steuern mit Kanalpunkten und Bits Chaos-Effekte im Spiel (ChaosCore).',
      title ? `Bisheriger Titel: "${clean(title, 140)}".` : '',
      tags.length ? `Bisherige Tags: ${tags.map((t) => clean(t, 25)).join(', ')}.` : '',
      'Regeln: Titel höchstens 100 Zeichen. Tags: 5 bis 8 Stück, je höchstens 25 Zeichen, nur Buchstaben und Zahlen, ohne #.',
      'Antworte nur als JSON: {"title": "...", "tags": ["..."]}',
    ].filter(Boolean).join('\n');
    const r = await this.ask(prompt);
    const t = clean(r.title, 140);
    if (!t) throw new Error('Die KI hat keinen Titel geliefert');
    const outTags = [...new Set((Array.isArray(r.tags) ? r.tags : []).map((x) => String(x).replace(/[^\p{L}\p{N}]/gu, '').slice(0, 25)).filter(Boolean))].slice(0, 10);
    return { title: t, tags: outTags };
  }
}
