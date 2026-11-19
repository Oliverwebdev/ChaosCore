// Dashboard - Effekt-Editor (Baukasten).
// Wird beim Ausliefern in dashboard.html eingesetzt (siehe src/web-pages.js): alle Teile laufen
// zusammen in EINEM Skript, in dieser Reihenfolge.
// ---------- Effekt-Editor (Baukasten) ----------
// Ein Fenster für alles: neuen Effekt bauen, vorhandenen bearbeiten, mitgelieferte ansehen.
// Der Satz unter dem Ablauf erklärt in Klartext, was passiert - so lernt man beim Bauen.
const fx = (() => {
  let S = null; // letzter Status
  let st = null; // { kind, a, blocks, dirty, special }
  let previewTimer = null;
  const isEn = () => document.documentElement.lang === 'en';
  const modeDef = (id) => (S?.builder?.modes || []).find((m) => m.id === id);
  const modeLabel = (m) => (isEn() ? (m.label_en || m.label) : m.label);
  const msg = (t, bad) => { $('fxMsg').textContent = t || ''; $('fxMsg').style.color = bad ? 'var(--bad)' : ''; };
  const keyOptions = (sel) => {
    const keySet = new Set(S.builder.keys);
    const groups = KEY_GROUPS.map((g) => el('optgroup', { label: tr(g.label, g.fallback) },
      ...g.keys.filter((k) => keySet.has(k)).map((k) => el('option', { value: k }, keyLabel(k)))));
    sel.replaceChildren(...groups);
  };
  const newBlock = (mode) => {
    const b = { mode };
    if (modeDef(mode)?.needsKey) b.key = mode === 'swap' ? 'forward' : 'jump';
    if (mode === 'swap') b.key2 = 'back';
    if (mode === 'spam') { b.key = 'jump'; b.intervalMs = 150; }
    if (mode === 'original') { b.from = S.builder.sources[0]?.id; b.scale = 1; }
    b.ms = mode === 'pause' ? 2000 : 5000;
    return b;
  };
  function changed() { st.dirty = true; paintBlocks(); schedulePreview(); }
  function paintBlocks() {
    const list = st.blocks;
    $('fxBlocks').replaceChildren(...list.map((b, i) => {
      const m = modeDef(b.mode) || { label: b.mode };
      const last = i === list.length - 1;
      const up = el('button', { type: 'button', title: tr('dash.fxUp', 'nach oben'), disabled: i === 0 ? '' : null }, '↑');
      up.onclick = () => { [list[i - 1], list[i]] = [list[i], list[i - 1]]; changed(); };
      const down = el('button', { type: 'button', title: tr('dash.fxDown', 'nach unten'), disabled: last ? '' : null }, '↓');
      down.onclick = () => { [list[i + 1], list[i]] = [list[i], list[i + 1]]; changed(); };
      const rm = el('button', { type: 'button', title: tr('dash.fxRemove', 'Baustein entfernen') }, '✕');
      rm.onclick = () => { list.splice(i, 1); changed(); };
      const fields = [];
      if (m.needsKey) {
        const k = el('select', { class: 'ss-input', 'aria-label': tr('dash.key', 'Taste') }); keyOptions(k); k.value = b.key;
        k.onchange = () => { b.key = k.value; changed(); };
        fields.push(el('div', {}, el('label', { class: 'muted' }, b.mode === 'swap' ? tr('dash.fxKeyA', 'Taste A') : tr('dash.key', 'Taste')), k));
      }
      if (b.mode === 'swap') {
        const k2 = el('select', { class: 'ss-input', 'aria-label': tr('dash.fxKeyB', 'Taste B') }); keyOptions(k2); k2.value = b.key2;
        k2.onchange = () => { b.key2 = k2.value; changed(); };
        fields.push(el('div', {}, el('label', { class: 'muted' }, tr('dash.fxKeyB', 'Taste B')), k2));
      }
      if (b.mode === 'original') {
        const src = el('select', { class: 'ss-input' }, ...S.builder.sources.map((x) => el('option', { value: x.id }, x.title)));
        src.value = b.from; src.onchange = () => { b.from = src.value; changed(); };
        const sc = el('input', { class: 'ss-input', type: 'number', min: '25', max: '300', step: '25', value: String(Math.round((b.scale || 1) * 100)) });
        sc.onchange = () => { b.scale = Math.min(3, Math.max(0.25, Number(sc.value) / 100 || 1)); changed(); };
        fields.push(el('div', {}, el('label', { class: 'muted' }, tr('dash.fxSource', 'Effekt')), src), el('div', {}, el('label', { class: 'muted' }, tr('dash.fxScale', 'Länge in %')), sc));
      } else {
        if (!b.round) {
          const ms = el('input', { class: 'ss-input', type: 'number', min: '0.5', max: '60', step: '0.5', value: String((b.ms ?? 5000) / 1000) });
          ms.onchange = () => { b.ms = Math.round(Math.min(60, Math.max(0.5, Number(ms.value) || 5)) * 1000); changed(); };
          fields.push(el('div', {}, el('label', { class: 'muted' }, tr('dash.duration', 'Dauer (Sek.)')), ms));
        }
        if (b.mode === 'spam') {
          const iv = el('input', { class: 'ss-input', type: 'number', min: '80', max: '2000', step: '10', value: String(b.intervalMs ?? 150) });
          iv.onchange = () => { b.intervalMs = Number(iv.value) || 150; changed(); };
          fields.push(el('div', {}, el('label', { class: 'muted' }, tr('dash.interval', 'Abstand (ms)')), iv));
        }
        if (m.canRound && last && $('fxOrder').value === 'all') {
          const rc = el('input', { type: 'checkbox' }); rc.checked = !!b.round;
          rc.onchange = () => { b.round = rc.checked; changed(); };
          fields.push(el('div', { style: 'display:flex;align-items:flex-end' }, el('label', { style: 'display:flex;gap:6px;align-items:center' }, rc, tr('dash.fxRound', 'bis Rundenende'))));
        } else if (b.round) b.round = false;
      }
      return el('div', { class: 'fx-block' },
        el('div', { class: 'fx-block-top' }, el('span', { class: 'muted' }, `${i + 1}.`), el('b', {}, modeLabel(m)), up, down, rm),
        fields.length ? el('div', { class: 'fx-row' }, ...fields) : el('div', { class: 'muted' }, m.desc || ''));
    }));
    const max = S.builder.maxSteps || 8;
    [...$('fxPalette').children].forEach((btn) => { btn.disabled = list.length >= max; });
    $('fxRepeatWrap').style.display = $('fxOrder').value === 'all' ? '' : 'none';
  }
  const specOf = () => ({ blocks: st.blocks, order: $('fxOrder').value, repeat: Number($('fxRepeat').value) || 1 });
  const selfRef = () => (st.a ? { id: st.a.id, kind: st.kind } : null);
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(async () => {
      if (st.special) return;
      if (!st.blocks.length) { $('fxSentence').textContent = tr('dash.fxEmpty', 'Noch kein Baustein - ohne Ablauf gibt es nur eine Einblendung im Overlay.'); $('fxSentence').classList.remove('bad'); return; }
      try {
        const r = await api('builder/preview', { builder: specOf(), self: selfRef() });
        $('fxSentence').classList.toggle('bad', !r.ok);
        if (!r.ok) { $('fxSentence').textContent = r.error; return; }
        const dur = r.untilStop ? tr('dash.fxUntilRound', 'bis Rundenende') : tr('dash.fxDur', 'Dauer etwa {s} s').replace('{s}', Math.round(r.ms / 100) / 10);
        $('fxSentence').textContent = `${r.text} (${dur})`;
      } catch (e) { $('fxSentence').textContent = e.message; }
    }, 250);
  }
  function open(kind, a) {
    if (!S) return;
    st = { kind, a: a || null, dirty: !a, special: !!a?.special, blocks: [] };
    const bits = kind === 'bits';
    $('fxHead').textContent = a ? tr('dash.fxEditTitle', 'Effekt bearbeiten') + ` – ${a.title}` : (bits ? tr('dash.fxNewBits', '+ Neue Bits-Stufe').replace('+ ', '') : tr('dash.fxNew', '+ Neuer Effekt').replace('+ ', ''));
    $('fxCostLabel').textContent = bits ? tr('dash.thBits', 'Bits') : tr('dash.thPoints', 'Punkte');
    $('fxCatWrap').style.display = bits ? 'none' : '';
    $('fxCat').replaceChildren(...(S.categories || []).map((c) => el('option', { value: c }, tierLabel(c))));
    $('fxAccess').replaceChildren(...Object.entries(ACCESS_LABELS).map(([v, k]) => el('option', { value: v }, tr(k, v))));
    $('fxName').value = a?.title || ''; $('fxCost').value = a?.cost || (bits ? 500 : 500);
    $('fxCat').value = a?.category || ((S.categories || []).includes('medium') ? 'medium' : (S.categories || [])[0]);
    $('fxPrompt').value = a?.prompt || ''; $('fxFlavor').value = a?.flavor || '';
    $('fxPhase').value = a?.phase || 'live'; $('fxDeath').value = a?.onDeath || 'stop';
    $('fxColorOn').checked = !!a?.color; $('fxColor').value = a?.color || '#B026FF';
    $('fxCooldown').value = a?.cooldownSec ?? ''; $('fxAccess').value = a?.access || 'everyone';
    $('fxSpecial').hidden = !st.special; $('fxFlowBox').hidden = st.special;
    if (st.special) $('fxSpecial').textContent = tr('dash.fxSpecial', 'Sondereffekt mit fester Logik: {text} Den Ablauf kannst du hier nicht ändern - Name, Texte, Preis und Regeln schon.').replace('{text}', a.describe + ' ');
    const spec = a?.builder;
    if (spec) { st.blocks = structuredClone(spec.blocks || []); $('fxOrder').value = spec.order || 'all'; $('fxRepeat').value = spec.repeat || 1; }
    else if (a && !st.special && S.builder.sources.some((x) => x.id === a.id)) { st.blocks = [{ mode: 'original', from: a.id, scale: 1 }]; $('fxOrder').value = 'all'; $('fxRepeat').value = 1; }
    else { st.blocks = a ? [] : [newBlock('block')]; $('fxOrder').value = 'all'; $('fxRepeat').value = 1; }
    $('fxRestore').style.display = a && !a.custom ? '' : 'none';
    $('fxShare').style.display = a ? '' : 'none';
    $('fxPalette').replaceChildren(...S.builder.modes.map((m) => {
      const btn = el('button', { type: 'button', title: m.desc }, '+ ' + modeLabel(m));
      btn.onclick = () => { if (st.blocks.length < (S.builder.maxSteps || 8)) { st.blocks.push(newBlock(m.id)); changed(); } };
      return btn;
    }));
    msg('');
    paintBlocks(); schedulePreview();
    $('fxDlg').showModal();
    $('fxName').focus();
  }
  async function save() {
    const bits = st.kind === 'bits';
    const base = bits ? 'bits/action' : 'action';
    const title = $('fxName').value.trim(), cost = Number($('fxCost').value);
    if (!title || !cost) { msg(tr('dash.fillTitleCost', 'Name und Preis ausfüllen.'), true); return; }
    const extra = { prompt: $('fxPrompt').value.trim(), flavor: $('fxFlavor').value.trim(), phase: $('fxPhase').value, onDeath: $('fxDeath').value,
      color: $('fxColorOn').checked ? $('fxColor').value : '', cooldownSec: $('fxCooldown').value === '' ? null : Number($('fxCooldown').value), access: $('fxAccess').value };
    const builder = !st.special && st.dirty && st.blocks.length ? specOf() : undefined;
    $('fxSave').disabled = true; msg(tr('dash.fxSaving', 'Speichere …'));
    try {
      let id = st.a?.id, warning = null;
      if (!id) {
        const r = await api(`${base}/add`, { title, cost, category: bits ? undefined : $('fxCat').value, prompt: extra.prompt, builder });
        id = r.id; warning = r.warning;
        await api(`${base}/update`, { id, ...extra });
      } else {
        const r = await api(`${base}/update`, { id, title, cost, ...(bits ? {} : { category: $('fxCat').value }), ...extra, ...(builder ? { builder } : {}) });
        warning = r.warning;
      }
      if (warning) banner(warning, true);
      $('fxDlg').close(); lastKey = ''; lastBitsKey = ''; refresh();
    } catch (e) { msg(e.message, true); }
    $('fxSave').disabled = false;
  }
  async function share() {
    try {
      const r = await api('action/export', { kind: st.kind, id: st.a.id });
      const blob = new Blob([JSON.stringify(r.data, null, 2)], { type: 'application/json' });
      const a = el('a', { href: URL.createObjectURL(blob), download: `${st.a.title.replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'effekt'}.chaoscore-effect.json` });
      document.body.append(a); a.click(); a.remove();
      msg(tr('dash.fxShared', 'Datei gespeichert - andere können sie bei sich mit „Effekt importieren“ laden.'));
    } catch (e) { msg(e.message, true); }
  }
  let importKind = 'points';
  async function importFile(file) {
    let data;
    try { data = JSON.parse(await file.text()); } catch { banner(tr('dash.fxImportBad', 'Die Datei ist keine gültige Effekt-Datei.'), true); return; }
    try {
      const pre = await api('action/import', { kind: importKind, data });
      if (!confirm(tr('dash.fxImportConfirm', '„{title}“ übernehmen?\n\n{describe}\n\nDer Effekt wird zuerst ausgeschaltet angelegt, damit du ihn in Ruhe prüfen kannst.').replace('{title}', pre.title).replace('{describe}', pre.describe))) return;
      await api('action/import', { kind: importKind, data, commit: true });
      lastKey = ''; lastBitsKey = ''; await refresh();
      const list = importKind === 'bits' ? S.bitsActions : S.actions;
      const a = list?.find((x) => x.title === pre.title);
      if (a) open(importKind, a);
    } catch (e) { banner(e.message, true); }
  }
  $('fxClose').onclick = () => $('fxDlg').close();
  $('fxCancel').onclick = () => $('fxDlg').close();
  $('fxSave').onclick = save;
  $('fxShare').onclick = share;
  $('fxOrder').onchange = () => changed();
  $('fxRepeat').onchange = () => changed();
  $('fxTest').onclick = async () => {
    if (st.special || (!st.dirty && st.a)) { if (st.a) { await test(st.a.id, true); msg(tr('dash.fxTested', 'Läuft trocken - schau ins Overlay.')); } return; }
    try { await api('builder/test', { builder: specOf(), self: selfRef(), title: $('fxName').value.trim() || 'Test', dry: true }); msg(tr('dash.fxTested', 'Läuft trocken - schau ins Overlay.')); }
    catch (e) { msg(e.message, true); }
  };
  $('fxRestore').onclick = async () => {
    if (!confirm(tr('dash.fxRestoreConfirm', '„{title}“ auf den Auslieferungszustand zurücksetzen? Name, Texte, Stufe und Ablauf kommen zurück, Preis und An/Aus bleiben.').replace('{title}', st.a.title))) return;
    try { await api(`${st.kind === 'bits' ? 'bits/action' : 'action'}/restore`, { id: st.a.id }); $('fxDlg').close(); lastKey = ''; lastBitsKey = ''; refresh(); }
    catch (e) { msg(e.message, true); }
  };
  $('fxNew').onclick = () => open('points', null);
  $('fxNewBits').onclick = () => open('bits', null);
  $('fxImport').onclick = () => { importKind = 'points'; $('fxImportFile').click(); };
  $('fxImportBits').onclick = () => { importKind = 'bits'; $('fxImportFile').click(); };
  $('fxImportFile').onchange = () => { const f = $('fxImportFile').files[0]; $('fxImportFile').value = ''; if (f) importFile(f); };
  return {
    setStatus(s) { S = s; },
    open,
    copy: async (kind, a) => {
      try { const r = await api(`${kind === 'bits' ? 'bits/action' : 'action'}/copy`, { id: a.id }); lastKey = ''; lastBitsKey = ''; await refresh(); const c = (kind === 'bits' ? S.bitsActions : S.actions).find((x) => x.id === r.id); if (c) open(kind, c); }
      catch (e) { banner(e.message, true); }
    },
    importAs: (kind) => { importKind = kind; $('fxImportFile').click(); },
  };
})();
