// Dashboard - Overlay: Anordnung per Drag & Drop, Aussehen der Fenster.
// Wird beim Ausliefern in dashboard.html eingesetzt (siehe src/web-pages.js): alle Teile laufen
// zusammen in EINEM Skript, in dieser Reihenfolge.
// ---------- Overlay-Layout (Drag & Drop) ----------
// Standard-Anordnung (2.0): lässt die CS2-Anzeigen frei. Gleiche Werte wie DEFAULT_LAYOUT in web/overlay.html.
const LAYOUT_EDITOR_DEFAULTS = { chaos: { x: 1.2, y: 39 }, history: { x: 1.2, y: 48 }, stats: { x: 1.2, y: 70 }, queue: { x: 82.3, y: 21 }, season: { x: 82.3, y: 44 }, hall: { x: 82.3, y: 66 }, effect: { x: 23, y: 86 }, bits: { x: 56, y: 86 } };
const layoutLabels = () => ({
  chaos: tr('dash.layoutChaos', 'Chaos-Meter'),
  queue: tr('dash.layoutQueue', 'Warteschlange'),
  history: tr('dash.layoutHistory', 'Verlauf'),
  hall: tr('dash.layoutHall', 'Top & Contract'),
  effect: tr('dash.layoutEffect', 'Aktiver Effekt'),
  season: tr('dash.layoutSeason', 'Season-Ranking'),
  stats: tr('dash.layoutStats', 'Session Stats'),
  bits: tr('dash.layoutBits', 'Bits-Bühne'),
});
// Fenster mit eigenem Aussehen (Session Stats wird unter Statistik gestaltet)
const STYLE_PANELS = ['chaos', 'queue', 'history', 'hall', 'effect', 'season', 'bits'];
let layoutData = null;
let hiddenPanels = [];
async function saveHidden() {
  try { await api('overlay/hidden', { hidden: hiddenPanels }); $('layoutMsg').textContent = tr('dash.layoutSaved', 'Gespeichert.'); }
  catch (e) { $('layoutMsg').textContent = tr('dash.syncFail', 'Fehler: {msg}').replace('{msg}', e.message); }
}
function paintVisibility() {
  const labels = layoutLabels();
  $('layoutVisible').replaceChildren(...Object.keys(LAYOUT_EDITOR_DEFAULTS).map((id) => {
    const on = !hiddenPanels.includes(id);
    const cb = el('input', { type: 'checkbox' }); cb.checked = on;
    cb.onchange = () => {
      hiddenPanels = cb.checked ? hiddenPanels.filter((x) => x !== id) : [...hiddenPanels, id];
      paintVisibility(); paintLayoutEditor(); saveHidden();
    };
    return el('label', { class: on ? 'on' : '' }, cb, labels[id]);
  }));
}
// Ungefähre Größe jedes Fensters im echten Overlay (Pixel bei 1920 x 1080) - damit die Bühne zeigt, wie viel
// Platz ein Fenster einnimmt, und ob es eine CS2-Anzeige verdeckt.
const PANEL_SIZE = { chaos: [300, 72], queue: [300, 220], history: [300, 190], hall: [300, 170], effect: [420, 110], season: [300, 200], stats: [380, 150], bits: [420, 120] };
const PANEL_SAMPLE = {
  chaos: () => tr('dash.smpChaos', '72 % bis Overload'), queue: () => tr('dash.smpQueue', '1. Kauf-Sperre · Tom'), history: () => tr('dash.smpHistory', 'WASD invertiert · Mia'),
  hall: () => tr('dash.smpHall', '1. Lena · 2. Tom'), effect: () => tr('dash.smpEffect', 'MAUS-DRIFT · Lena · 0:38'), season: () => tr('dash.smpSeason', '1. Lena 1240'),
  stats: () => tr('dash.smpStats', 'K 18 · T 11 · Chaos-Tode 3'), bits: () => tr('dash.smpBits', 'Topf 320 / 500'),
};
const PANEL_DESC = {
  chaos: ['dash.descChaos', 'Füllt sich mit jedem Effekt. Bei 100 % gibt es den Chaos-Overload für alle.'],
  queue: ['dash.descQueue', 'Die nächsten Effekte in der Reihenfolge, in der sie laufen. Bits sind golden markiert.'],
  history: ['dash.descHistory', 'Die letzten Effekte mit Namen - so sieht jeder, dass sein Beitrag angekommen ist.'],
  hall: ['dash.descHall', 'Wer am meisten Chaos gestiftet hat, dazu der Daily Contract. Wechselt zwischen heute und gesamt.'],
  effect: ['dash.descEffect', 'Zeigt groß, welcher Effekt gerade läuft, wer ihn ausgelöst hat und wie lange er noch dauert.'],
  season: ['dash.descSeason', 'Die Bestenliste der laufenden Season über mehrere Streams.'],
  stats: ['dash.descStats', 'Kills, Tode und wer dich mit einem Effekt erledigt hat - live aus CS2.'],
  bits: ['dash.descBits', 'Erscheint nur, wenn jemand Bits gibt: Premium-Moment, Topf, Mutprobe - in Gold.'],
};
// CS2-Anzeigen (Prozent der Bildfläche) bei Standard-HUD in 16:9
const CS2_ZONES = [
  ['radar', 'dash.zRadar', 'Radar', 0.8, 1.5, 15, 27], ['money', 'dash.zMoney', 'Geld', 0.8, 31, 10, 6], ['round', 'dash.zRound', 'Rundenzeit & Punkte', 41, 0.8, 18, 6.5],
  ['kill', 'dash.zKill', 'Killfeed', 76, 2, 23, 16], ['hp', 'dash.zHp', 'Leben & Rüstung', 0.8, 88, 20, 10.5], ['ammo', 'dash.zAmmo', 'Munition', 80, 88, 19, 10.5],
];
let layoutSel = 'effect';
const panelRect = (id) => {
  const pos = layoutData[id] || LAYOUT_EDITOR_DEFAULTS[id];
  const k = pos.scale || 1;
  const [w, h] = PANEL_SIZE[id];
  return { x: pos.x, y: pos.y, w: (w * k) / 19.2, h: (h * k) / 10.8, k };
};
const overlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
function layoutWarnings() {
  const labels = layoutLabels();
  const out = [];
  for (const id of Object.keys(LAYOUT_EDITOR_DEFAULTS)) {
    if (hiddenPanels.includes(id)) continue;
    const r = panelRect(id);
    for (const [zid, key, fb, x, y, w, h] of CS2_ZONES) {
      if (overlap(r, { x, y, w, h }) > Math.min(r.w * r.h, w * h) * 0.15) out.push([id, zid, tr('dash.warnCovers', '„{panel}“ liegt über der CS2-Anzeige „{zone}“').replace('{panel}', labels[id]).replace('{zone}', tr(key, fb))]);
    }
    if (r.x + r.w > 100.5 || r.y + r.h > 100.5) out.push([id, 'edge', tr('dash.warnEdge', '„{panel}“ ragt über den Bildrand').replace('{panel}', labels[id])]);
  }
  return out;
}
function paintLayoutWarn(warns) {
  $('layoutWarn').replaceChildren(...warns.map(([id, , text]) => {
    const b = el('button', { type: 'button', class: 'ghostBtn' }, tr('dash.warnShow', 'Zeigen'));
    b.onclick = () => selectPanel(id);
    return el('div', { class: 'explain', style: 'border-color:var(--warn-line);background:var(--warn-soft)' },
      el('span', { class: 'ei', style: 'background:var(--gold-soft);color:var(--warn)' }, '!'),
      el('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' }, el('div', { style: 'flex:1;min-width:180px' }, el('b', {}, text),
        el('small', {}, tr('dash.warnHint', 'Ein Stück verschieben - die gestrichelten Flächen sind Anzeigen von CS2.'))), b));
  }));
}
function paintSelected() {
  const id = layoutSel;
  const labels = layoutLabels();
  const r = panelRect(id);
  $('selName').textContent = labels[id];
  $('selDesc').textContent = tr(...PANEL_DESC[id]);
  $('selVisible').checked = !hiddenPanels.includes(id);
  $('selScale').value = String(r.k); $('selScaleV').textContent = `${Math.round(r.k * 100)} %`;
  $('selPos').textContent = tr('dash.selPos', 'Position {x}, {y} · Größe {w} × {h} px').replace('{x}', Math.round(r.x * 19.2)).replace('{y}', Math.round(r.y * 10.8)).replace('{w}', Math.round(r.w * 19.2)).replace('{h}', Math.round(r.h * 10.8));
  const styled = STYLE_PANELS.includes(id);
  $('selStyleBox').hidden = !styled;
  $('selStatsNote').hidden = styled;
  if (styled && $('stPanel').value !== id) { $('stPanel').value = id; paintStyleForm(); }
}
function selectPanel(id) {
  layoutSel = id;
  paintLayoutEditor();
  if (window.matchMedia('(max-width: 1180px)').matches) $('selCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
async function saveLayout() {
  $('layoutMsg').textContent = tr('dash.layoutSaving', 'Speichere …');
  try { await api('overlay/layout', { layout: layoutData }); $('layoutMsg').textContent = tr('dash.layoutSaved', 'Gespeichert.'); }
  catch (e) { $('layoutMsg').textContent = tr('dash.syncFail', 'Fehler: {msg}').replace('{msg}', e.message); }
}
function makeDraggable(box, id, canvas) {
  box.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    box.setPointerCapture(ev.pointerId);
    const rect0 = canvas.getBoundingClientRect();
    const start = panelRect(id);
    const gx = ev.clientX, gy = ev.clientY;
    let moved = false;
    const move = (e2) => {
      const dx = ((e2.clientX - gx) / rect0.width) * 100, dy = ((e2.clientY - gy) / rect0.height) * 100;
      if (!moved && Math.abs(e2.clientX - gx) + Math.abs(e2.clientY - gy) < 4) return;
      moved = true;
      box.classList.add('drag');
      const x = Math.max(0, Math.min(100 - start.w, start.x + dx)), y = Math.max(0, Math.min(100 - start.h, start.y + dy));
      box.style.left = x + '%'; box.style.top = y + '%';
      layoutData[id] = { ...(layoutData[id] || {}), x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
      paintLayoutWarn(layoutWarnings());
    };
    const up = () => {
      box.removeEventListener('pointermove', move);
      box.removeEventListener('pointerup', up);
      box.classList.remove('drag');
      layoutSel = id;
      if (moved) saveLayout();
      paintLayoutEditor();
    };
    box.addEventListener('pointermove', move);
    box.addEventListener('pointerup', up);
  });
  // Tastatur: Pfeiltasten verschieben in kleinen Schritten (mit Umschalt größer)
  box.addEventListener('keydown', (ev) => {
    const step = ev.shiftKey ? 5 : 1;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[ev.key];
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); layoutSel = id; paintLayoutEditor(); return; }
    if (!d) return;
    ev.preventDefault();
    const r = panelRect(id);
    layoutData[id] = { ...(layoutData[id] || {}), x: Math.max(0, Math.min(100 - r.w, r.x + d[0])), y: Math.max(0, Math.min(100 - r.h, r.y + d[1])) };
    layoutSel = id; paintLayoutEditor(); $('layoutCanvas').querySelector(`[data-panel="${id}"]`)?.focus();
    clearTimeout(makeDraggable.t); makeDraggable.t = setTimeout(saveLayout, 400);
  });
}
function paintLayoutEditor() {
  const canvas = $('layoutCanvas');
  const labels = layoutLabels();
  const warns = layoutWarnings();
  const warnIds = new Set(warns.map((w) => w[0]));
  const nodes = CS2_ZONES.map(([, key, fb, x, y, w, h]) => el('div', { class: 'zone', style: `left:${x}%;top:${y}%;width:${w}%;height:${h}%` }, tr(key, fb)));
  nodes.unshift(el('div', { class: 'stage-hint' }, tr('dash.stageBg', 'Dein CS2-Bild')));
  for (const id of Object.keys(LAYOUT_EDITOR_DEFAULTS)) {
    const r = panelRect(id);
    const off = hiddenPanels.includes(id);
    const box = el('div', { class: 'win' + (id === layoutSel ? ' sel' : '') + (off ? ' off' : '') + (warnIds.has(id) ? ' warn' : '') + (id === 'bits' ? ' gold' : ''),
      tabindex: '0', role: 'button', 'data-panel': id, 'aria-pressed': String(id === layoutSel),
      'aria-label': `${labels[id]}${off ? ' - ' + tr('dash.layoutHiddenBox', 'Ausgeblendet') : ''}`,
      style: `left:${r.x}%;top:${r.y}%;width:${r.w}%;height:${r.h}%` },
    el('div', { class: 't' }, labels[id]), el('div', { class: 's' }, PANEL_SAMPLE[id]()));
    makeDraggable(box, id, canvas);
    nodes.push(box);
  }
  canvas.replaceChildren(...nodes);
  paintLayoutWarn(warns);
  paintSelected();
}
$('selVisible').onchange = () => {
  const id = layoutSel;
  hiddenPanels = $('selVisible').checked ? hiddenPanels.filter((x) => x !== id) : [...hiddenPanels, id];
  paintVisibility(); paintLayoutEditor(); saveHidden();
};
$('selScale').oninput = () => {
  const id = layoutSel;
  layoutData[id] = { ...(layoutData[id] || LAYOUT_EDITOR_DEFAULTS[id]), scale: Number($('selScale').value) };
  paintLayoutEditor();
  clearTimeout(paintSelected.t); paintSelected.t = setTimeout(saveLayout, 400);
};
$('overlayCopy').onclick = () => navigator.clipboard?.writeText($('overlayUrl').value).then(() => { $('overlayCopy').textContent = '✓'; setTimeout(() => { $('overlayCopy').textContent = tr('dash.copyUrl', 'Kopieren'); }, 1400); }).catch(() => $('overlayUrl').select());
// ---------- Aussehen der Fenster ----------
const STYLE_DEFAULT = { theme: 'unknown', accent: '', opacity: 82, shape: 'cut', radius: 12, border: true, glow: true };
let styleData = {}; let stylePainted = false; let styleTimer = null;
const curStyle = () => ({ ...STYLE_DEFAULT, ...(styleData[$('stPanel').value] || {}) });
function paintStyleForm() {
  const st = curStyle();
  $('stTheme').value = st.theme; $('stAccentDefault').checked = !st.accent; $('stAccent').value = st.accent || '#B026FF'; $('stAccent').disabled = !st.accent;
  $('stOpacity').value = st.opacity; $('stOpacityV').textContent = st.opacity + ' %';
  $('stShape').value = st.shape; $('stRadius').value = st.radius; $('stRadiusV').textContent = st.radius + ' px'; $('stRadius').disabled = st.shape !== 'round';
  $('stBorder').checked = st.border; $('stGlow').checked = st.glow;
  paintStylePreview(st);
}
function paintStylePreview(st) {
  const p = $('stPreview');
  p.className = 'sp-panel' + (st.theme !== 'unknown' ? ' st-' + st.theme : '') + (st.shape === 'round' ? ' st-round' : '') + (st.border ? '' : ' st-noborder') + (st.glow ? '' : ' st-noglow');
  p.style.setProperty('--p-a', String(st.opacity / 100)); p.style.setProperty('--p-r', st.radius + 'px');
  if (st.accent) p.style.setProperty('--accent', st.accent); else p.style.removeProperty('--accent');
  $('stPreviewLbl').textContent = (layoutLabels()[$('stPanel').value] || '').toUpperCase();
}
function readStyleForm() {
  return { theme: $('stTheme').value, accent: $('stAccentDefault').checked ? '' : $('stAccent').value, opacity: Number($('stOpacity').value),
    shape: $('stShape').value, radius: Number($('stRadius').value), border: $('stBorder').checked, glow: $('stGlow').checked };
}
async function saveStyles() {
  try { const r = await api('overlay/styles', { styles: styleData }); styleData = r.styles; $('stMsg').textContent = tr('dash.layoutSaved', 'Gespeichert.'); }
  catch (e) { $('stMsg').textContent = e.message; }
}
function onStyleInput() {
  styleData[$('stPanel').value] = readStyleForm();
  paintStyleForm();
  clearTimeout(styleTimer); styleTimer = setTimeout(saveStyles, 400);
}
function paintStyles(ov) {
  if (stylePainted) return;
  stylePainted = true;
  styleData = JSON.parse(JSON.stringify(ov.styles || {}));
  const labels = layoutLabels();
  $('stPanel').replaceChildren(...STYLE_PANELS.map((id) => el('option', { value: id }, labels[id])));
  $('customCss').value = ov.customCss || '';
  paintStyleForm();
}
$('stPanel').onchange = () => { layoutSel = $('stPanel').value; paintLayoutEditor(); };
for (const id of ['stTheme', 'stAccent', 'stOpacity', 'stShape', 'stRadius', 'stBorder', 'stGlow', 'stAccentDefault']) $(id).addEventListener(id === 'stOpacity' || id === 'stRadius' || id === 'stAccent' ? 'input' : 'change', onStyleInput);
$('stAll').onclick = () => { const st = readStyleForm(); for (const id of STYLE_PANELS) styleData[id] = { ...st }; saveStyles(); };
$('stReset').onclick = () => { delete styleData[$('stPanel').value]; paintStyleForm(); saveStyles(); };
$('customCssSave').onclick = async () => {
  try { await api('overlay/styles', { customCss: $('customCss').value }); $('customCssMsg').textContent = tr('dash.layoutSaved', 'Gespeichert.'); }
  catch (e) { $('customCssMsg').textContent = e.message; }
};
$('layoutReset').onclick = async () => {
  layoutData = {};
  paintLayoutEditor();
  await saveLayout();
};
let profilesPainted = false;
