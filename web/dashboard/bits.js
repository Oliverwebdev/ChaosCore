// Dashboard - Bits-Menü und Erfolge eigener Effekte.
// Wird beim Ausliefern in dashboard.html eingesetzt (siehe src/web-pages.js): alle Teile laufen
// zusammen in EINEM Skript, in dieser Reihenfolge.
// ---- Bits-Menü ----
let bmData = null; let bmPainted = false;
function paintBitsMenu(bm) {
  if (!bm) return;
  $('bitsTiersOff').style.display = bm.enabled ? '' : 'none';
  $('bitsTiersCard').style.opacity = bm.enabled ? '.6' : '';
  if (bmPainted) return;
  bmPainted = true;
  bmData = JSON.parse(JSON.stringify(bm));
  $('bmEnabled').checked = !!bm.enabled; $('bmBpm').value = bm.bitsPerMinute; $('bmMax').value = bm.maxMinutes; $('bmPerStream').value = bm.maxPerStream ?? 0;
  const p = bm.pot || {};
  $('potEnabled').checked = p.enabled !== false; $('potGoal').value = p.goal ?? 500; $('potKeyword').value = p.keyword || 'topf'; $('potMinutes').value = p.minutes ?? 3;
  paintBmItems();
  $('bmNoKw').value = bm.noKeyword;
  $('potEffect').value = p.effect || 'escalate';
}
const bmTitle = (id) => { const t = bmData.templates[id] || {}; return document.documentElement.lang === 'en' ? (t.title_en || t.title || id) : (t.title || id); };
const actTitle = (id) => (bmData.actionChoices || []).find((a) => a.id === id)?.title || id;
const unitName = (u) => ({ minute: tr('dash.bmUnitMinute', 'pro Minute'), round: tr('dash.bmUnitRound', 'pro Runde'), once: tr('dash.bmUnitOnce', 'einmalig') }[u] || u);
function paintBmItems() {
  const en = document.documentElement.lang === 'en';
  const bpm = Number($('bmBpm').value) || bmData.bitsPerMinute;
  $('bmHeroBits').textContent = `${bpm} Bits`;
  const example = (it, price, unit) => {
    const p = price || bpm;
    const what = unit === 'once' ? tr('dash.bmUnitOnce', 'einmalig') : unit === 'round' ? `2 ${tr('dash.bmRounds', 'Runden')}` : `2 ${tr('dash.bmMinShort', 'Min.')}`;
    return `Cheer${unit === 'once' ? p : p * 2} ${it.keyword} → ${what}`;
  };
  $('bmItems').replaceChildren(...bmData.items.map((it) => {
    const t = bmData.templates[it.id] || {};
    const cb = el('input', { type: 'checkbox' }); cb.checked = it.enabled;
    cb.onchange = () => { it.enabled = cb.checked; paintBmItems(); };
    const kw = el('input', { class: 'ss-input', value: it.keyword, maxlength: '20', 'aria-label': tr('dash.bmKeyword', 'Stichwort') });
    const ex = el('code', {}, example(it, it.price, it.unit));
    kw.oninput = () => { it.keyword = kw.value.trim().toLowerCase(); ex.textContent = example(it, it.price, it.unit); };
    const price = el('input', { class: 'ss-input', type: 'number', min: '1', max: '100000', placeholder: String(bpm), value: it.price ?? '' });
    price.oninput = () => { it.price = price.value === '' ? null : Number(price.value); ex.textContent = example(it, it.price, it.unit); };
    const unit = el('select', { class: 'ss-input' }, ...(t.units || ['minute']).map((u) => el('option', { value: u }, unitName(u))));
    unit.value = it.unit; unit.disabled = (t.units || []).length < 2;
    unit.onchange = () => { it.unit = unit.value; ex.textContent = example(it, it.price, it.unit); };
    const cd = el('input', { class: 'ss-input', type: 'number', min: '0', max: '3600', value: String(it.cooldownSec ?? 0) });
    cd.oninput = () => { it.cooldownSec = Number(cd.value) || 0; };
    const more = el('details', {}, el('summary', { class: 'muted', style: 'font-size:12px' }, tr('dash.moreSettings', 'Mehr Einstellungen')),
      el('label', { class: 'muted', style: 'font-size:12px' }, tr('dash.bmPrice', 'Preis in Bits (leer = Standard)')), price,
      el('label', { class: 'muted', style: 'font-size:12px' }, tr('dash.bmUnit', 'Abrechnung')), unit,
      el('label', { class: 'muted', style: 'font-size:12px' }, tr('dash.bmCooldown', 'Cooldown (Sek.)')), cd);
    const extra = [];
    if (t.challenge) {
      const c = bmData.challenge;
      const kills = el('input', { class: 'ss-input', type: 'number', min: '1', max: '20', value: String(c.kills) }); kills.oninput = () => { c.kills = Number(kills.value); };
      const mins = el('input', { class: 'ss-input', type: 'number', min: '1', max: '15', value: String(c.minutes) }); mins.oninput = () => { c.minutes = Number(mins.value); };
      const wp = el('select', { class: 'ss-input' }, el('option', { value: 'any' }, tr('dash.chAny', 'jede Waffe')), el('option', { value: 'pistol' }, tr('dash.chPistol', 'nur Pistole')), el('option', { value: 'knife' }, tr('dash.chKnife', 'nur Messer')));
      wp.value = c.weapon; wp.onchange = () => { c.weapon = wp.value; };
      extra.push(el('div', { class: 'muted', style: 'font-size:12px' }, tr('dash.chExplain', 'Kills in Minuten - geschafft oder nicht, der Chat sieht es live im Overlay.')),
        el('div', { class: 'fx-row' }, el('div', {}, el('label', { class: 'muted', style: 'font-size:12px' }, 'Kills'), kills), el('div', {}, el('label', { class: 'muted', style: 'font-size:12px' }, tr('dash.chMinutes', 'Minuten')), mins)), wp);
    }
    return el('div', { class: 'bm-item' + (it.enabled ? '' : ' off') },
      el('div', { class: 'bm-top' }, el('span', {}, bmTitle(it.id)), el('span', { class: 'switch' }, cb, el('span'))),
      el('label', { class: 'muted', style: 'font-size:12px' }, tr('dash.bmKeyword', 'Stichwort')), kw, ex, ...extra, more);
  }));
  // eigene Effekte
  $('bmCustom').replaceChildren(...(bmData.custom || []).map((c, i) => {
    const kw = el('input', { class: 'ss-input', value: c.keyword, maxlength: '20' }); kw.oninput = () => { c.keyword = kw.value.trim().toLowerCase(); };
    const price = el('input', { class: 'ss-input', type: 'number', min: '1', max: '100000', value: String(c.price) }); price.oninput = () => { c.price = Number(price.value); };
    const rm = el('button', { type: 'button' }, tr('dash.bmCustomRemove', 'Entfernen')); rm.onclick = () => { bmData.custom.splice(i, 1); paintBmItems(); };
    return el('div', { class: 'bm-item' }, el('div', { class: 'bm-top' }, el('span', {}, actTitle(c.actionId)), rm),
      el('label', { class: 'muted', style: 'font-size:12px' }, tr('dash.bmKeyword', 'Stichwort')), kw,
      el('label', { class: 'muted', style: 'font-size:12px' }, tr('dash.bmPriceOnce', 'Preis in Bits (einmalig)')), price);
  }));
  const used = new Set((bmData.custom || []).map((c) => c.actionId));
  $('bmCustomPick').replaceChildren(...(bmData.actionChoices || []).filter((a) => !used.has(a.id)).map((a) => el('option', { value: a.id }, a.title)));
  // Auswahl "ohne Stichwort" und Topf-Effekt
  const cur = $('bmNoKw').value || bmData.noKeyword;
  $('bmNoKw').replaceChildren(el('option', { value: 'none' }, tr('dash.bmNoKwNone', 'Kein Effekt (in den Topf)')),
    ...bmData.items.filter((x) => x.enabled).map((x) => el('option', { value: x.id }, `→ ${bmTitle(x.id)}`)),
    ...(bmData.custom || []).map((c) => el('option', { value: `act:${c.actionId}` }, `→ ${actTitle(c.actionId)}`)));
  $('bmNoKw').value = [...$('bmNoKw').options].some((o) => o.value === cur) ? cur : 'none';
  const pe = $('potEffect').value || bmData.pot?.effect;
  $('potEffect').replaceChildren(...Object.entries(bmData.templates).filter(([, t]) => (t.units || []).includes('minute')).map(([id]) => el('option', { value: id }, bmTitle(id))));
  $('potEffect').value = pe || 'escalate';
}
$('bmCustomAdd').onclick = () => {
  const id = $('bmCustomPick').value;
  if (!id) return;
  bmData.custom = bmData.custom || [];
  if (bmData.custom.length >= 10) { $('bmMsg').textContent = tr('dash.bmCustomMax', 'Höchstens 10 eigene Effekte.'); return; }
  const base = actTitle(id).toLowerCase().replace(/[^a-z0-9äöüß]/g, '').slice(0, 14) || 'effekt';
  let kw = base; let n = 2;
  const taken = new Set([...bmData.items.map((x) => x.keyword), ...bmData.custom.map((x) => x.keyword), bmData.pot?.keyword]);
  while (taken.has(kw) || kw.length < 2) kw = `${base}${n++}`;
  bmData.custom.push({ actionId: id, keyword: kw, enabled: true, price: Number($('bmBpm').value) || bmData.bitsPerMinute });
  paintBmItems();
};
$('bmBpm').oninput = () => paintBmItems();
$('bmSave').onclick = async () => {
  try {
    const r = await api('bitsmenu', { enabled: $('bmEnabled').checked, bitsPerMinute: Number($('bmBpm').value), maxMinutes: Number($('bmMax').value), noKeyword: $('bmNoKw').value,
      maxPerStream: Number($('bmPerStream').value) || 0, items: bmData.items.map(({ id, keyword, enabled, price, unit, cooldownSec }) => ({ id, keyword, enabled, price, unit, cooldownSec })),
      custom: bmData.custom || [], challenge: bmData.challenge,
      pot: { enabled: $('potEnabled').checked, goal: Number($('potGoal').value), keyword: $('potKeyword').value.trim().toLowerCase(), effect: $('potEffect').value, minutes: Number($('potMinutes').value) } });
    bmData = { ...bmData, ...r.bitsMenu };
    $('bmMsg').textContent = tr('dash.queueSaved', 'Gespeichert.');
    paintBitsMenu({ ...bmData });
  } catch (e) { $('bmMsg').textContent = e.message; }
};
// ---- Erfolge eigener Effekte (einmal anzeigen) ----
function paintMilestones(list) {
  let seen;
  try { seen = new Set(JSON.parse(localStorage.getItem('ucc_milestones') || '[]')); } catch { seen = new Set(); }
  const fresh = list.find((m) => !seen.has(`${m.id}:${m.n}`) && Date.now() - m.at < 6 * 3600 * 1000);
  if (!fresh) return;
  seen.add(`${fresh.id}:${fresh.n}`);
  try { localStorage.setItem('ucc_milestones', JSON.stringify([...seen].slice(-200))); } catch { /* egal */ }
  const text = fresh.n === 1
    ? tr('dash.milestoneFirst', '🎉 Dein Effekt „{title}“ wurde gerade zum ersten Mal eingelöst!')
    : tr('dash.milestoneN', '🎉 Dein Effekt „{title}“ wurde schon {n}-mal eingelöst!');
  const t = $('toast'); t.textContent = text.replace('{title}', fresh.title).replace('{n}', fresh.n); t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 9000);
}
