// Dashboard - Overlay: Anordnung per Drag & Drop, Aussehen der Fenster.
// Wird beim Ausliefern in dashboard.html eingesetzt (siehe src/web-pages.js): alle Teile laufen
// zusammen in EINEM Skript, in dieser Reihenfolge.
// ---------- Overlay-Layout (Drag & Drop) ----------
// Nur Startpositionen für die Kästchen im Editor, solange noch keine eigene Position gespeichert
// ist — das echte Overlay bleibt bis zum ersten Ziehen bei seiner festen CSS-Position.
const LAYOUT_EDITOR_DEFAULTS = { chaos: { x: 1.9, y: 3.3 }, queue: { x: 70, y: 3.3 }, history: { x: 1.9, y: 14 }, hall: { x: 70, y: 60 }, effect: { x: 1.9, y: 70 }, season: { x: 70, y: 14 }, stats: { x: 1.2, y: 40 }, bits: { x: 36, y: 74 } };
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
// Nur optische Wiedererkennung im Editor (keine Funktionsänderung) - jedes Element bekommt ein
// eigenes Symbol und eine eigene Akzentfarbe, damit der Canvas auf einen Blick lesbar ist statt
// sechs gleich aussehender grauer Kästchen.
const LAYOUT_ICONS = { chaos: '🔥', queue: '📋', history: '🕒', hall: '🏆', effect: '⚡', season: '🎖️', stats: '💀', bits: '◆' };
const LAYOUT_COLORS = { chaos: 'var(--accent)', queue: 'var(--cyan)', history: 'var(--dim)', hall: 'var(--warn)', effect: 'var(--accent2)', season: 'var(--ok)', bits: '#F4B400' };
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
    return el('label', { class: on ? 'on' : '' }, cb, `${LAYOUT_ICONS[id] || '◆'} ${labels[id]}`);
  }));
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
    box.style.cursor = 'grabbing';
    const move = (e2) => {
      const rect = canvas.getBoundingClientRect();
      let x = ((e2.clientX - rect.left) / rect.width) * 100;
      let y = ((e2.clientY - rect.top) / rect.height) * 100;
      x = Math.max(0, Math.min(96, x)); y = Math.max(0, Math.min(96, y));
      box.style.left = x + '%'; box.style.top = y + '%';
      // Größe (scale) bleibt beim Ziehen erhalten - nur x/y ändern sich.
      layoutData[id] = { ...(layoutData[id] || {}), x, y };
    };
    const up = () => {
      box.style.cursor = 'grab';
      box.removeEventListener('pointermove', move);
      box.removeEventListener('pointerup', up);
      saveLayout();
    };
    box.addEventListener('pointermove', move);
    box.addEventListener('pointerup', up);
  });
}
function paintLayoutEditor() {
  const canvas = $('layoutCanvas');
  canvas.textContent = '';
  const labels = layoutLabels();
  for (const id of Object.keys(LAYOUT_EDITOR_DEFAULTS)) {
    const pos = layoutData[id] || LAYOUT_EDITOR_DEFAULTS[id];
    const color = LAYOUT_COLORS[id] || 'var(--accent)';
    const off = hiddenPanels.includes(id);
    const box = el('div', { title: off ? tr('dash.layoutHiddenBox', 'Ausgeblendet') : '', style:
      (off ? 'opacity:.35;border-style:dashed !important;' : '') +
      `position:absolute;left:${pos.x}%;top:${pos.y}%;padding:6px 10px;font-size:11px;font-weight:600;white-space:nowrap;` +
      `background:var(--panel2);border:1px solid ${color};border-left:3px solid ${color};border-radius:7px;cursor:grab;` +
      `user-select:none;touch-action:none;display:flex;flex-direction:column;align-items:center;gap:4px;box-shadow:var(--shadow)` },
      el('span', {}, `${LAYOUT_ICONS[id] || '◆'} ${labels[id]}`),
      // Größe, getrennt von der Position per Drag & Drop
      // oben - ein eigener kleiner Regler statt eines zweiten Drag-Modus, damit "verschieben" und
      // "skalieren" nicht versehentlich verwechselt werden. stopPropagation verhindert, dass ein
      // Klick auf den Regler stattdessen das ganze Kästchen zu ziehen anfängt.
      el('input', { type: 'range', min: '0.5', max: '2', step: '0.1', value: String(pos.scale || 1), style: 'width:72px;cursor:pointer',
        'aria-label': `${labels[id]} ${tr('dash.layoutScaleAria', 'Größe')}`,
        onpointerdown: (ev) => ev.stopPropagation(),
        oninput: (ev) => { layoutData[id] = { ...(layoutData[id] || pos), scale: Number(ev.target.value) }; box.style.transformOrigin = 'top left'; box.style.transform = `scale(${Number(ev.target.value)})`; },
        onchange: () => saveLayout() }));
    makeDraggable(box, id, canvas);
    canvas.appendChild(box);
  }
}
// ---------- Aussehen der Fenster ----------
const STYLE_PANELS = ['chaos', 'queue', 'history', 'hall', 'effect', 'season', 'bits'];
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
  $('stPanel').replaceChildren(...STYLE_PANELS.map((id) => el('option', { value: id }, `${LAYOUT_ICONS[id] || ''} ${labels[id]}`)));
  $('customCss').value = ov.customCss || '';
  paintStyleForm();
}
$('stPanel').onchange = paintStyleForm;
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
