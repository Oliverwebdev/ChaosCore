// Dashboard - Grundlagen: Navigation, Design, Mini-Ansicht, Fenster, Anmeldung, api(), el(), gemeinsame Zustände.
// Wird beim Ausliefern in dashboard.html eingesetzt (siehe src/web-pages.js): alle Teile laufen
// zusammen in EINEM Skript, in dieser Reihenfolge.
const $ = (id) => document.getElementById(id);
const tr = (key, fallback) => (window.__I18N__ || {})[key] ?? fallback;

// ---- Navigation (ChaosCore 2): acht Bereiche. Jede Karten-Gruppe (.section) gehört über data-area zu einem
// Bereich; ein Bereich zeigt alle seine Gruppen zusammen in einem Raster. Alte Bereichsnamen (z. B.
// 'system' oder 'session' aus älteren Links/Knöpfen) werden auf den neuen Bereich umgelenkt. Der zuletzt
// offene Bereich steht in sessionStorage (pro Fenster, übersteht einen Neuladen). ----
const sections = Array.from(document.querySelectorAll('.section[data-area]'));
const navButtons = Array.from(document.querySelectorAll('.navbtn[data-nav]'));
const AREAS = {
  live: ['Live', 'Was gerade passiert - und was du als Nächstes tun kannst.'],
  effects: ['Effekte', 'Was deine Zuschauer mit Kanalpunkten auslösen können. Ein Klick öffnet den Effekt zum Bearbeiten.'],
  highlights: ['Highlights', 'Die starken Momente deines Streams - mit Titel, Marker und Clip.'],
  stats: ['Statistik', 'Kills, Tode und Chaos dieser Session und der ganzen Season.'],
  community: ['Community', 'Gemeinsames Ziel, Chat-Befehle und alles, was bisher passiert ist.'],
  overlay: ['Overlay', 'So sehen deine Zuschauer ChaosCore im Stream.'],
  bits: ['Bits', 'Optional: kleine goldene Momente für Bits - ohne Zufall, ohne Wetten.'],
  settings: ['Einstellungen', 'Automatik, Programm, Sicherheit und Presets.'],
};
const sectionArea = (name) => (AREAS[name] ? name : sections.find((s) => s.dataset.section === name)?.dataset.area) || 'live';
function showSection(name) {
  const area = sectionArea(name);
  for (const s of sections) s.classList.toggle('active', s.dataset.area === area);
  for (const b of navButtons) { b.classList.toggle('active', b.dataset.nav === area); if (b.dataset.nav === area) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); }
  document.body.dataset.section = area;
  $('areaTitle').textContent = tr(`dash.area.${area}.t`, AREAS[area][0]);
  $('areaDesc').textContent = tr(`dash.area.${area}.d`, AREAS[area][1]);
  if (area === 'stats') window.__uccStatsRefresh?.();
  try { sessionStorage.setItem('ucc_section', area); } catch { /* Speicher gesperrt */ }
}
for (const b of navButtons) b.onclick = () => { showSection(b.dataset.nav); window.scrollTo({ top: 0, behavior: 'smooth' }); };
document.addEventListener('i18n-ready', () => showSection(document.body.dataset.section || 'live'));
let startSection = 'live';
try { startSection = sessionStorage.getItem('ucc_section') || 'live'; } catch { /* Speicher gesperrt */ }
showSection(startSection);

// ---- Design-Umschalter - drei feste Varianten, rein optisch (CSS-Variablen), gemerkt in
// localStorage (geräte-/browserbezogen, kein Server-Zustand nötig). Vorbelegung passiert schon
// ganz früh im <head> (siehe dortiges kleines Skript), hier nur noch Knöpfe verdrahten/markieren. ----
const THEMES = ['light', 'dark', 'unknown'];
function applyTheme(name) {
  const t = THEMES.includes(name) ? name : 'dark';
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('ucc_theme', t); } catch { /* Speicher gesperrt */ }
  for (const btn of document.querySelectorAll('[data-theme-btn]')) btn.setAttribute('aria-pressed', String(btn.dataset.themeBtn === t));
}
for (const btn of document.querySelectorAll('[data-theme-btn]')) btn.onclick = () => applyTheme(btn.dataset.themeBtn);
applyTheme(document.documentElement.getAttribute('data-theme') || 'dark');

// ---- Mini-Ansicht: dasselbe Fenster wechselt in eine kleine Ansicht (Warteliste im Fokus).
// Wird gemerkt. Fenster, die per Skript geöffnet wurden (auch ältere ?compact=1-Links), passen
// ihre Größe gleich mit an; normale Browserfenster lassen das nicht zu, dann bleibt die Größe. ----
let miniPrevSize = null;
function setMini(on, { remember = true } = {}) {
  document.body.classList.toggle('mini', on);
  $('miniToggle')?.setAttribute('aria-pressed', String(on));
  if (remember) { try { localStorage.setItem('ucc_mini', on ? '1' : ''); } catch { /* egal */ } }
  try {
    if (on && window.outerWidth > 520) { miniPrevSize = [window.outerWidth, window.outerHeight]; window.resizeTo(440, Math.min(720, screen.availHeight)); }
    else if (!on && miniPrevSize) { window.resizeTo(...miniPrevSize); miniPrevSize = null; }
  } catch { /* Fenster lässt sich nicht verkleinern */ }
}
{
  let startMini = new URLSearchParams(location.search).get('compact') === '1';
  try { startMini = startMini || localStorage.getItem('ucc_mini') === '1'; } catch { /* egal */ }
  if (startMini) setMini(true, { remember: false });
}
$('miniToggle').onclick = () => setMini(!document.body.classList.contains('mini'));
$('mvFull').onclick = () => setMini(false);

let token = '';
let lastKey = '';
let lastBitsKey = '';
try {
  const h = new URLSearchParams(location.hash.slice(1)).get('token');
  if (h) { sessionStorage.setItem('ucc_token', h); history.replaceState(null, '', location.pathname); }
  token = sessionStorage.getItem('ucc_token') || '';
} catch { /* Speicher gesperrt */ }
$('overlayUrl').value = location.origin + '/overlay';
$('openSetup').onclick = () => { location.replace('/setup#token=' + encodeURIComponent(token)); };
$('confidentialFix').onclick = () => { location.replace('/setup#token=' + encodeURIComponent(token) + '&step=2'); };

// ----- Nur ein Fenster: das neueste gewinnt, ältere schließen sich (oder zeigen einen Hinweis,
// wenn der Browser das Schließen nicht erlaubt). Gilt für Dashboard und Einrichtung gemeinsam.
(function singleWindow() {
  if (typeof BroadcastChannel !== 'function') return;
  const me = Date.now() + Math.random();
  const ch = new BroadcastChannel('chaoscore-window');
  ch.onmessage = (ev) => {
    if (ev.data?.type !== 'hello' || ev.data.id === me) return;
    ch.close();
    try { window.close(); } catch { /* nicht von Skript geöffnet */ }
    $('dupeBox').hidden = false;
    document.body.classList.add('dupe');
  };
  ch.postMessage({ type: 'hello', id: me });
})();

// ----- Notfall-Anmeldung -----
let reloginPoll = null;
async function setupApi(path, body) {
  const res = await fetch('/setup/api/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-admin-token': token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || String(res.status));
  return data;
}
function reloginView(v) {
  $('reloginCode').hidden = v.state !== 'waiting';
  if (v.state === 'waiting') { $('reloginUserCode').textContent = v.userCode || ''; $('reloginOpen').dataset.uri = v.uri || 'https://www.twitch.tv/activate'; }
  $('reloginMsg').textContent = v.state === 'error' ? (v.error || '') : v.state === 'expired' ? tr('dash.reloginExpired', 'Der Code ist abgelaufen - bitte nochmal.') : v.state === 'ok' ? tr('dash.reloginOk', 'Angemeldet - verbinde mit Twitch…') : '';
  $('reloginBtn').disabled = v.state === 'waiting';
}
$('reloginBtn').onclick = async () => {
  clearInterval(reloginPoll);
  try { reloginView(await setupApi('login/start', {})); }
  catch (e) { $('reloginMsg').textContent = e.message; return; }
  reloginPoll = setInterval(async () => {
    let v;
    try { v = await setupApi('login/status'); } catch { return; }
    reloginView(v);
    if (v.state === 'waiting') return;
    clearInterval(reloginPoll);
    if (v.state === 'ok') { try { await api('twitch/reload', {}); } catch (e) { $('reloginMsg').textContent = e.message; } }
  }, 2000);
};
$('reloginOpen').onclick = () => setupApi('open', { url: $('reloginOpen').dataset.uri || 'https://www.twitch.tv/activate' }).catch((e) => { $('reloginMsg').textContent = e.message; });

async function api(path, body) {
  let res;
  try {
    res = await fetch('/api/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-admin-token': token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    // Verständliche Meldung statt Rohtext: ein roher Browser-/
    // Netzwerkfehler (z. B. "Failed to fetch", wenn das Programm nicht mehr läuft) wäre für
    // Streamer nicht verständlich - stattdessen eine klare deutsche Meldung mit Verweis auf den
    // Fehlerbericht-Knopf.
    throw new Error(tr('dash.connLost', 'Verbindung zum Programm verloren. Läuft es noch? Falls das Problem bleibt: unten „Fehlerbericht erstellen" nutzen.'));
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || tr('dash.apiFailGeneric', 'Unbekannter Fehler ({code}). Falls das öfter passiert: „Fehlerbericht erstellen" nutzen.').replace('{code}', res.status));
  return data;
}
const el = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) { if (v === null || v === undefined || v === false) continue; if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); }
  e.append(...kids.filter((k) => k !== null && k !== undefined && k !== false)); return e; // null/false = "nichts anzeigen" (sonst stünde "null" im Text)
};
// eine ungültige lokale Aktion ist deaktiviert - hier steht verständlich,
// warum (der Grund kommt vom Server, siehe validate.js), statt dass sie einfach "aus" wirkt.
const invalidNote = (a) => (a.invalid ? [' ', el('span', { class: 'tag warn', title: a.invalid }, tr('dash.invalidTag', 'ungültig')),
  el('div', { class: 'muted', style: 'font-size:12px;margin-top:2px' }, tr('dash.invalidWhy', 'Deaktiviert: {reason}').replace('{reason}', a.invalid))] : []);
const chip = (cls, text) => el('span', { class: 'chip ' + cls }, el('i'), text);
// Zugriffsregel-Dropdown, identisch für Kanalpunkte- und Bits-Aktionen
// (route ist der einzige Unterschied).
const ACCESS_LABELS = { everyone: 'dash.accessEveryone', subscriber: 'dash.accessSubscriber', vip: 'dash.accessVip', moderator: 'dash.accessModerator' };
const ACCESS_FALLBACK = { everyone: 'Jeder', subscriber: 'Abonnenten', vip: 'VIPs', moderator: 'Moderatoren' };
// Stufen und Zeiten in der eingestellten Sprache (nicht 'small'/'medium' oder US-Uhrzeit)
const TIER_LABELS = { small: ['setup.s5.tierSmall', 'klein'], medium: ['setup.s5.tierMedium', 'mittel'], strong: ['setup.s5.tierStrong', 'stark'] };
const tierLabel = (c) => (TIER_LABELS[c] ? tr(...TIER_LABELS[c]) : c);
const uiLocale = () => (document.documentElement.lang === 'en' ? 'en-GB' : 'de-DE');
// Rückmeldung aus dem Praxistest: die Tasten-Auswahl im Effekt-Baukasten zeigte bisher nur die internen
// Schlüssel roh an ("forward", "c4", ...) - unübersichtlich und wirkte "mehr schlecht als recht".
// Jetzt gruppiert (optgroup) mit verständlichen Bezeichnungen; der Wert im <select> bleibt der
// interne Schlüssel, nur die Anzeige ändert sich.
const KEY_GROUPS = [
  { label: 'dash.builderGroupMove', fallback: 'Bewegung', keys: ['forward', 'left', 'back', 'right', 'jump', 'duck', 'walk'] },
  { label: 'dash.builderGroupAction', fallback: 'Aktionen', keys: ['use', 'drop', 'inspect', 'scoreboard', 'buy'] },
  { label: 'dash.builderGroupWeapon', fallback: 'Waffen & Ausrüstung', keys: ['primary', 'secondary', 'knife', 'grenades', 'flash', 'c4', 'last'] },
];
const KEY_LABELS = {
  forward: ['dash.builderKeyForward', 'Vorwärts'], left: ['dash.builderKeyLeft', 'Links'], back: ['dash.builderKeyBack', 'Rückwärts'],
  right: ['dash.builderKeyRight', 'Rechts'], jump: ['dash.builderKeyJump', 'Springen'], duck: ['dash.builderKeyDuck', 'Ducken'],
  walk: ['dash.builderKeyWalk', 'Schleichen (langsam gehen)'], use: ['dash.builderKeyUse', 'Benutzen / Aufnehmen'],
  drop: ['dash.builderKeyDrop', 'Waffe fallen lassen'], inspect: ['dash.builderKeyInspect', 'Waffe inspizieren'],
  scoreboard: ['dash.builderKeyScoreboard', 'Scoreboard anzeigen'], buy: ['dash.builderKeyBuy', 'Kaufmenü'],
  primary: ['dash.builderKeyPrimary', 'Primärwaffe'], secondary: ['dash.builderKeySecondary', 'Pistole'],
  knife: ['dash.builderKeyKnife', 'Messer'], grenades: ['dash.builderKeyGrenades', 'Granaten-Menü'],
  c4: ['dash.builderKeyC4', 'C4 / Bombe'], last: ['dash.builderKeyLast', 'Letzte Waffe'], flash: ['dash.builderKeyFlash', 'Blendgranate'],
};
const keyLabel = (k) => { const l = KEY_LABELS[k]; return l ? tr(l[0], l[1]) : k; };
function accessSelect(a, route, tbody, refreshAfter) {
  const select = el('select', { 'aria-label': a.title + ' ' + tr('dash.thAccess', 'Zugriff'), style: 'background:var(--input-bg);color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:4px' },
    ...Object.entries(ACCESS_LABELS).map(([val, key]) => el('option', { value: val }, tr(key, ACCESS_FALLBACK[val] || val))));
  select.value = a.access || 'everyone';
  select.onchange = async () => {
    tbody.dataset.busy = '1';
    try { await api(route, { id: a.id, access: select.value }); }
    catch (e) { banner(tr('dash.toggleFail', 'Konnte nicht umschalten: {msg}').replace('{msg}', e.message), true); select.value = a.access || 'everyone'; }
    delete tbody.dataset.busy; refreshAfter();
  };
  return el('td', {}, select);
}
const banner = (text, bad) => { const b = $('banner'); b.textContent = text || ''; b.classList.toggle('show', !!text); b.classList.toggle('bad', !!bad); };
const fmtTime = (ts) => new Date(ts).toLocaleTimeString(uiLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });

let categoriesPainted = false;
let overlayLoaded = false;
// Community-Ziel - Bearbeitungsstand lokal im Dashboard, erst beim
// Speichern an /api/goal gesendet (wie beim Overlay-Layout-Editor).
let goalLoaded = false;
let goalThresholdsData = [];
let goalActionPool = [];
// Auto-Lebendig - gleiches Muster wie beim Community-Ziel oben:
// Bearbeitungsstand lokal, erst beim Speichern an /api/autoidle gesendet.
let idleLoaded = false;
let idleWhitelistData = [];
let idleActionPool = [];
// Warteschlangen-Politik - gleiches Muster, erst beim Speichern an
// /api/queuepolicy gesendet.
let queueLoaded = false;
let critLoaded = false;
let gsiRecOn = false;
let lastCritPending = null;
let critReleased = [];
let seasonLengthLoaded = false;
let versionPainted = false;
// Chat - die vier Schalter/die Abklingzeit laufen über das gleiche
// Lade-einmal-dann-lokal-bearbeiten-Muster wie oben; die Befehlsliste selbst wird dagegen SOFORT
// bei jeder Änderung gespeichert (add/remove/toggle), nicht erst über einen Sammel-Knopf - ein
// einzelner Befehl ändern soll sich wie eine kleine, eigenständige Aktion anfühlen.
let chatLoaded = false;
let chatCommandsPainted = [];

