// Produkt-Branding (für Weitergabe/Verkauf). Alles steht in product.json im Programmordner:
//   name            Anzeigename (Fenster, Verknüpfungen, Installer, Ordner in %APPDATA%)
//   brand           Kurzname im Overlay (z. B. "UNKNOWN")
//   accent          Overlay-Farbe als #RRGGBB
//   publisher       Herausgeber (Installer)
//   twitchClientId  Optional: eine fest eingebaute Twitch-Client-ID. Dann entfällt für Kunden der Schritt
//                   "Twitch-Anwendung anlegen" und sie klicken nur noch auf "Mit Twitch anmelden".
//   website/support Links im Installer und in den Fenstern
//   githubRepo      Optional: "besitzer/name" eines öffentlichen GitHub-Repos mit Releases.
//                   Dann prüft das Dashboard über die GitHub-API, ob eine neuere Version vorliegt.
//   uploads         Optional: App-Daten für "Mit YouTube/TikTok verbinden" (siehe uploads.js):
//                   { "youtube": { "clientId", "clientSecret" }, "tiktok": { "clientKey", "clientSecret" } }.
//                   Beim Bauen auch aus UCC_YT_CLIENT_ID/UCC_YT_CLIENT_SECRET/UCC_TT_CLIENT_KEY/UCC_TT_CLIENT_SECRET.
//   releaseKeys     Öffentliche Schlüssel (Ed25519, Base64), mit denen Releases signiert sind. Ist
//                   mindestens einer eingetragen, installiert der Updater nur signierte Releases
//                   (siehe release-signature.js).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parsePublicKey } from './release-signature.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FALLBACK = { name: 'UNKNOWN Chat Control', brand: 'UNKNOWN', accent: '#B026FF', publisher: '', twitchClientId: '', website: '', support: '', githubRepo: '' };

function str(v, max) { return typeof v === 'string' ? v.trim().slice(0, max) : ''; }

export function readProduct(file = path.join(ROOT, 'product.json')) {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* fehlt oder kaputt: Standardwerte */ }
  const name = str(raw.name, 40).replace(/[^\p{L}\p{N} ._-]/gu, '').trim() || FALLBACK.name; // taugt als Datei-/Ordnername
  const accent = /^#[0-9a-f]{6}$/i.test(str(raw.accent, 7)) ? str(raw.accent, 7) : FALLBACK.accent;
  const cid = str(raw.twitchClientId, 30);
  return {
    name,
    brand: str(raw.brand, 24) || FALLBACK.brand,
    accent,
    publisher: str(raw.publisher, 60),
    twitchClientId: /^[a-z0-9]{30}$/i.test(cid) ? cid : '',
    website: /^https:\/\//i.test(str(raw.website, 200)) ? str(raw.website, 200) : '',
    support: str(raw.support, 200),
    githubRepo: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(str(raw.githubRepo, 100)) ? str(raw.githubRepo, 100) : '',
    uploads: readUploadApps(raw.uploads),
    releaseKeys: (Array.isArray(raw.releaseKeys) ? raw.releaseKeys : []).slice(0, 5).map(parsePublicKey).filter(Boolean),
  };
}

function readUploadApps(u) {
  const o = u && typeof u === 'object' ? u : {};
  const id = (v) => (/^[A-Za-z0-9._-]{8,200}$/.test(str(v, 200)) ? str(v, 200) : '');
  return {
    youtube: { clientId: id(o.youtube?.clientId), clientSecret: str(o.youtube?.clientSecret, 200) },
    tiktok: { clientKey: id(o.tiktok?.clientKey), clientSecret: str(o.tiktok?.clientSecret, 200) },
  };
}

export const product = readProduct();
