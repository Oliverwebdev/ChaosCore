// Einstellungen für OBS und System-Aktionen (ohne Laufzeit-Abhängigkeiten, damit config.js sie
// ohne Kreis-Import nutzen kann). Die Logik steht in obs.js und system-actions.js.
import fs from 'node:fs';

export const OBS_DEFAULT = { enabled: false, host: '127.0.0.1', port: 4455 };

export function normalizeObs(v) {
  const o = v && typeof v === 'object' ? v : {};
  const port = Math.round(Number(o.port));
  const host = typeof o.host === 'string' && /^[A-Za-z0-9.:-]{1,64}$/.test(o.host.trim()) ? o.host.trim() : OBS_DEFAULT.host;
  return { enabled: o.enabled === true, host, port: port >= 1 && port <= 65535 ? port : OBS_DEFAULT.port };
}

export const SYSTEM_KINDS = ['scene', 'source', 'endStream', 'game'];
export const SYSTEM_DEFAULT = { enabled: false, confirm: true, links: {}, programs: [] };
const MAX_PROGRAMS = 20;
const MAX_LINKS = 50;

// Start-Adressen von Spiele-Launchern (z. B. steam://rungameid/730) - ohne Shell-Sonderzeichen.
const URI_RE = /^(steam|com\.epicgames\.launcher|uplay|origin2?|battlenet):\/\/[\w/.:?=&%-]{1,200}$/i;
const BAD_PATH = /["<>|^%&\r\n]/;

const cleanText = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);

export function checkProgramTarget(target) {
  const t = cleanText(target, 400);
  if (!t) throw new Error('Programm fehlt');
  if (URI_RE.test(t)) return { target: t, uri: true };
  if (BAD_PATH.test(t)) throw new Error('Der Pfad enthält unerlaubte Zeichen');
  if (process.platform === 'win32' && !/\.(exe|lnk|url)$/i.test(t)) throw new Error('Bitte eine .exe-, .lnk- oder .url-Datei oder eine steam://-Adresse angeben');
  if (!fs.existsSync(t)) throw new Error('Datei nicht gefunden');
  return { target: t, uri: false };
}

export function normalizeSystem(v, { profiles = [] } = {}) {
  const s = v && typeof v === 'object' ? v : {};
  const programs = [];
  for (const p of Array.isArray(s.programs) ? s.programs.slice(0, MAX_PROGRAMS) : []) {
    const id = typeof p?.id === 'string' && /^[\w-]{1,40}$/.test(p.id) ? p.id : null;
    const target = cleanText(p?.target, 400);
    if (!id || !target || (BAD_PATH.test(target) && !URI_RE.test(target))) continue;
    programs.push({ id, name: cleanText(p.name, 40) || id, target, args: cleanText(p.args, 200).replace(/["<>|^%&]/g, ''),
      profile: profiles.includes(p.profile) ? p.profile : null });
  }
  const links = {};
  for (const [actionId, l] of Object.entries(s.links && typeof s.links === 'object' ? s.links : {}).slice(0, MAX_LINKS)) {
    if (!/^[\w.-]{1,64}$/.test(actionId) || !SYSTEM_KINDS.includes(l?.kind)) continue;
    const num = (x, d, lo, hi) => { const n = Math.round(Number(x ?? d)); return n >= lo && n <= hi ? n : d; };
    const link = { kind: l.kind, cooldownSec: num(l.cooldownSec, 600, 0, 86400) };
    if (l.kind === 'scene') { link.scene = cleanText(l.scene, 100); link.backSec = num(l.backSec, 0, 0, 3600); if (!link.scene) continue; }
    if (l.kind === 'source') {
      link.scene = cleanText(l.scene, 100); link.source = cleanText(l.source, 100);
      link.mode = ['on', 'off', 'toggle'].includes(l.mode) ? l.mode : 'toggle';
      link.backSec = num(l.backSec, 0, 0, 3600);
      if (!link.scene || !link.source) continue;
    }
    if (l.kind === 'endStream') link.seconds = num(l.seconds, 30, 10, 600);
    if (l.kind === 'game') { link.programId = programs.some((p) => p.id === l.programId) ? l.programId : null; if (!link.programId) continue; }
    links[actionId] = link;
  }
  return { enabled: s.enabled === true, confirm: s.confirm !== false, links, programs };
}

