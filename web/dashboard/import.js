// Dashboard - Preset-Import mit Vorschau.
// Wird beim Ausliefern in dashboard.html eingesetzt (siehe src/web-pages.js): alle Teile laufen
// zusammen in EINEM Skript, in dieser Reihenfolge.
// ----- Import-Vorschau -----
let pendingImport = null; // { data } (Datei) oder { presetId } (mitgeliefertes Preset), solange die Vorschau offen ist
const IP_FIELD = {
  accent: ['dash.ipFieldAccent', 'Akzentfarbe'], sound: ['dash.ipFieldSound', 'Signalton an/aus'], history: ['dash.ipFieldHistory', 'Verlauf anzeigen'],
  top: ['dash.ipFieldTop', 'Top-Einlöser anzeigen'], reduceFlash: ['dash.ipFieldReduceFlash', 'Flackern reduzieren'], historyCount: ['dash.ipFieldHistoryCount', 'Einträge im Verlauf'],
  topCount: ['dash.ipFieldTopCount', 'Einträge in der Bestenliste'], topMode: ['dash.ipFieldTopMode', 'Bestenlisten-Modus'], topRotateSec: ['dash.ipFieldTopRotate', 'Wechsel der Bestenliste (Sekunden)'],
  layout: ['dash.ipFieldLayout', 'Overlay-Layout (verschobene Elemente)'], distinctViewers: ['dash.ipFieldContract', 'Contract-Ziel (verschiedene Zuschauer)'],
  maxQueue: ['dash.ipFieldMaxQueue', 'Länge der Warteschlange'], queueWaitSec: ['dash.ipFieldQueueWait', 'Wartezeit bei voller Warteschlange'],
  sensitivity: ['dash.ipFieldSens', 'Maus-Empfindlichkeit'], crosshairAlpha: ['dash.ipFieldXhAlpha', 'Fadenkreuz-Deckkraft'], crosshairSize: ['dash.ipFieldXhSize', 'Fadenkreuz-Größe'],
  crosshairBigSize: ['dash.ipFieldXhBig', 'Größe „Fadenkreuz riesig“'], mPitch: ['dash.ipFieldPitch', 'vertikale Maus-Empfindlichkeit'],
};
const IP_WHAT = { title: ['dash.ipWhatTitle', 'Titel'], cost: ['dash.ipWhatCost', 'Preis'], enabled: ['dash.ipWhatEnabled', 'an/aus'], category: ['dash.ipWhatCategory', 'Stufe'], access: ['dash.ipWhatAccess', 'Zugriff'], requires: ['dash.ipWhatRequires', 'Bedingungen'], effect: ['dash.ipWhatEffect', 'Effekt'] };
const IP_GROUP = { contract: ['dash.ipGroupContract', 'Contract-Ziel übernehmen'], queue: ['dash.ipGroupQueue', 'Warteschlangen-Einstellungen übernehmen'], gameTuning: ['dash.ipGroupTuning', 'Persönliche Spielwerte übernehmen (Empfindlichkeit, Fadenkreuz)'] };
const IP_NOT = {
  'game.requireFocus': ['dash.ipNotFocus', 'Fokusprüfung'], 'game.windowExe': ['dash.ipNotWindow', 'Fenstername des Spiels'], 'game.requireGameState': ['dash.ipNotState', 'Spielzustand-Pflicht'],
  'game.restoreMouseBinds': ['dash.ipNotRestore', 'Maustasten-Wiederherstellung'], 'bridge.panicHotkey': ['dash.ipNotPanic', 'Not-Aus-Hotkey'], 'engine.holdTimeoutSec': ['dash.ipNotHold', 'Wartezeit auf den passenden Spielmoment'],
  'engine.roundMaxSec': ['dash.ipNotRound', 'maximale Effektdauer'], 'engine.autoRefund': ['dash.ipNotRefund', 'automatische Erstattung'], 'overlay.brand': ['dash.ipNotBrand', 'Produktname im Overlay'],
};
const ipLabel = (map, k) => (map[k] ? tr(map[k][0], map[k][1]) : k);
const ipShow = (v) => (v === true ? tr('dash.ipOn', 'an') : v === false ? tr('dash.ipOff', 'aus') : v === null || v === undefined ? '–' : String(v));
const ipSection = (title, ...kids) => el('div', {}, el('strong', {}, title), ...kids);
const ipList = (items) => el('ul', { style: 'margin:4px 0 0 18px;padding:0' }, ...items.map((t) => el('li', {}, t)));
const ipActionLine = (a) => {
  const bits = [];
  if (a.keys && a.keys.length) bits.push(tr('dash.ipKeys', 'Tasten: {keys}').replace('{keys}', a.keys.join(', ')));
  if (a.maxHoldMs) bits.push(tr('dash.ipHold', 'hält bis zu {s} s').replace('{s}', String(a.maxHoldMs / 1000)));
  if (a.untilStop) bits.push(tr('dash.ipUntilStop', 'läuft bis zum Rundenende'));
  else if (a.seconds) bits.push(tr('dash.ipDuration', 'Dauer {s} s').replace('{s}', String(a.seconds)));
  if (a.kind === 'overlay' || a.kind === 'none') bits.push(tr('dash.ipOverlayOnly', 'nur Overlay, keine Tasten'));
  if (a.kind && a.kind.startsWith('dynamic:')) bits.push(tr('dash.ipDynamic', 'Sonderaktion „{name}“').replace('{name}', a.kind.slice(8)));
  if (a.enabled === false) bits.push(tr('dash.ipDisabled', 'ausgeschaltet'));
  if (a.what) bits.push(tr('dash.ipChangedWhat', 'geändert: {what}').replace('{what}', a.what.map((w) => ipLabel(IP_WHAT, w)).join(', ')));
  return `${a.title}${bits.length ? ' – ' + bits.join('; ') : ''}`;
};
function closeImportPreview() { pendingImport = null; $('importPreview').style.display = 'none'; $('importPreviewBody').replaceChildren(); }
function showImportPreview(p) {
  const body = $('importPreviewBody');
  const out = [];
  if (!p.ok) {
    // Fehlerhaftes oder gefährliches Preset: klar benennen, Übernehmen gar nicht erst anbieten.
    out.push(el('div', { style: 'color:var(--bad);font-weight:700' }, tr('dash.ipRejected', 'Dieses Preset wird NICHT übernommen. Es wurde nichts geändert.')));
    out.push(el('div', {}, tr('dash.ipReason', 'Grund: {msg}').replace('{msg}', p.error || '?')));
    $('importConfirm').style.display = 'none';
  } else {
    const r = p.report;
    $('importConfirm').style.display = '';
    out.push(el('div', { style: 'color:var(--ok);font-weight:700' }, tr('dash.ipValid', 'Geprüft: keine ungültigen oder gesperrten Inhalte gefunden.')));
    if (r.preset.name || r.preset.author) out.push(el('div', { class: 'muted' }, `${r.preset.name || ''}${r.preset.author ? ' – ' + r.preset.author : ''}`));
    out.push(el('div', r.targetGame.switches ? { style: 'color:var(--warn)' } : {}, (r.targetGame.switches ? tr('dash.ipGameSwitch', 'Achtung: wechselt das aktive Spiel-Profil zu „{name}“.') : tr('dash.ipGame', 'Spiel-Profil: {name}')).replace('{name}', r.targetGame.name)));
    if (r.criticalUsed.length) out.push(el('div', { style: 'color:var(--warn)' }, tr('dash.ipCritical', 'Nutzt über deine eigene Tastenbelegung kritische Tasten, die du bereits freigegeben hast: {keys}').replace('{keys}', r.criticalUsed.join(', '))));
    const A = r.actions;
    out.push(ipSection(tr('dash.ipActions', 'Aktionen: {a} neu, {c} geändert, {r} entfernt, {u} unverändert').replace('{a}', A.added.length).replace('{c}', A.changed.length).replace('{r}', A.removed.length).replace('{u}', A.unchanged),
      A.added.length ? el('div', { class: 'muted', style: 'margin-top:4px' }, tr('dash.ipAdded', 'Neu:')) : '', A.added.length ? ipList(A.added.map(ipActionLine)) : '',
      A.changed.length ? el('div', { class: 'muted', style: 'margin-top:4px' }, tr('dash.ipChanged', 'Geändert:')) : '', A.changed.length ? ipList(A.changed.map(ipActionLine)) : '',
      A.removed.length ? el('div', { class: 'muted', style: 'margin-top:4px;color:var(--warn)' }, tr('dash.ipRemoved', 'Wird entfernt (steht nicht im Preset):')) : '', A.removed.length ? ipList(A.removed.map((a) => a.title + (a.custom ? ' ' + tr('dash.ipCustom', '(von dir selbst angelegt)') : ''))) : ''));
    if (r.keys.changed.length) out.push(ipSection(tr('dash.ipKeyChanges', 'Tastenbelegung ändert sich:'), ipList(r.keys.changed.map((k) => `${keyLabel(k.name)}: ${ipShow(k.from)} → ${k.to}`))));
    const media = ['sound', 'image'].filter((k) => r.media[k]).map((k) => {
      const m = r.media[k]; const what = k === 'sound' ? tr('dash.ipSound', 'Eigener Sound') : tr('dash.ipImage', 'Eigenes Bild');
      return m.action === 'removed' ? tr('dash.ipMediaRemoved', '{what} „{name}“ wird entfernt').replace('{what}', what).replace('{name}', m.name)
        : tr(m.action === 'replaced' ? 'dash.ipMediaReplaced' : 'dash.ipMediaAdded', m.action === 'replaced' ? '{what} wird ersetzt durch „{name}“ ({mime}, {kb} KB)' : '{what} kommt dazu: „{name}“ ({mime}, {kb} KB)').replace('{what}', what).replace('{name}', m.name).replace('{mime}', m.mime).replace('{kb}', m.kb);
    });
    if (media.length || r.overlay.changed.length) out.push(ipSection(tr('dash.ipOverlay', 'Overlay, Sounds und Bilder:'), ipList([...media, ...r.overlay.changed.map((c) => (c.field === 'layout' ? ipLabel(IP_FIELD, 'layout') : `${ipLabel(IP_FIELD, c.field)}: ${ipShow(c.from)} → ${ipShow(c.to)}`))])));
    const groups = Object.keys(r.optional);
    if (groups.length) {
      out.push(ipSection(tr('dash.ipOptional', 'Nur mit deiner Zustimmung (ohne Häkchen bleibt deine Einstellung):'),
        ...groups.map((g) => el('label', { style: 'display:block;margin-top:4px' }, el('input', { type: 'checkbox', 'data-accept': g }), ' ' + ipLabel(IP_GROUP, g) + ' – ' + r.optional[g].changes.map((c) => `${ipLabel(IP_FIELD, c.field)}: ${ipShow(c.from)} → ${ipShow(c.to)}`).join(', ')))));
    }
    if (r.notImported.length) out.push(ipSection(tr('dash.ipNotImported', 'Wird grundsätzlich NICHT übernommen (bleibt bei dir, wie es ist):'), el('div', { class: 'muted', style: 'margin-top:4px;font-size:12px;word-break:break-word' }, r.notImported.map((f) => (IP_NOT[f] ? `${ipLabel(IP_NOT, f)} (${f})` : f)).join(', '))));
  }
  body.replaceChildren(...out.filter(Boolean));
  $('importPreview').style.display = '';
}
$('importCancel').onclick = () => { closeImportPreview(); $('profileMsg').textContent = tr('dash.ipCancelled', 'Import abgebrochen. Es wurde nichts geändert.'); };
$('importConfirm').onclick = async () => {
  if (!pendingImport) return;
  const accept = {};
  for (const cb of $('importPreviewBody').querySelectorAll('input[data-accept]')) accept[cb.dataset.accept] = cb.checked;
  $('importConfirm').disabled = true;
  try {
    const r = pendingImport.presetId ? await api('preset/apply', { id: pendingImport.presetId, accept }) : await api('profile/import', { preset: pendingImport.data, accept });
    closeImportPreview();
    $('profileMsg').textContent = r.actionsImported ? tr('dash.profileImportedActions', 'Profil importiert, inklusive eigener Belohnungen. Klicke jetzt „Belohnungen mit Twitch abgleichen".') : tr('dash.profileImported', 'Profil importiert.');
    lastKey = ''; overlayLoaded = false; refresh();
  } catch (e) { $('profileMsg').textContent = tr('dash.profileImportFail', 'Fehler: {msg}').replace('{msg}', e.message); }
  $('importConfirm').disabled = false;
};
$('profileImportFile').onchange = async () => {
  const file = $('profileImportFile').files[0];
  $('profileImportFile').value = '';
  if (!file) return;
  closeImportPreview();
  $('profileMsg').textContent = tr('dash.ipChecking', 'Prüfe das Preset …');
  try {
    const data = JSON.parse(await file.text());
    const p = await api('profile/preview', { preset: data }); // ändert nichts
    pendingImport = { data };
    showImportPreview(p);
    $('profileMsg').textContent = '';
  } catch (e) { $('profileMsg').textContent = /JSON/.test(e.message) ? tr('dash.profileImportBadJson', 'Das ist keine gültige Profil-Datei (kein JSON).') : tr('dash.profileImportFail', 'Fehler: {msg}').replace('{msg}', e.message); }
};
$('sync').onclick = async () => {
  $('syncMsg').textContent = tr('dash.syncing', 'Gleiche ab…');
  try {
    const r = await api('sync', {});
    const bad = r.result.filter((x) => x.state === 'fehler');
    $('syncMsg').textContent = bad.length ? bad.map((b) => tr('dash.syncResultBad', '{title}: {message}').replace('{title}', b.title).replace('{message}', b.message)).join(' | ') : tr('dash.syncResultOk', 'Fertig: {n} Belohnungen aktuell.').replace('{n}', r.result.filter((x) => x.state !== 'übersprungen').length);
  } catch (e) { $('syncMsg').textContent = tr('dash.syncFail', 'Fehler: {msg}').replace('{msg}', e.message); }
  refresh();
};

