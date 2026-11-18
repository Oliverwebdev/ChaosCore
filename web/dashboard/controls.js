// Dashboard - Mini-Ansicht, Knöpfe und Einstellungen.
// Wird beim Ausliefern in dashboard.html eingesetzt (siehe src/web-pages.js): alle Teile laufen
// zusammen in EINEM Skript, in dieser Reihenfolge.
// ---- Mini-Ansicht zeichnen ----
let mvCurrent = null;
const mvAct = (p, body) => api(p, body).then(() => { $('mvMsg').textContent = ''; refresh(); }).catch((e) => { $('mvMsg').textContent = e.message; });
function mvTick() {
  const c = mvCurrent;
  if (!c) return;
  if (c.endsAt && c.startedAt) {
    const left = Math.max(0, c.endsAt - Date.now()), total = Math.max(1, c.endsAt - c.startedAt);
    $('mvNowBar').style.width = (100 - (left / total) * 100) + '%';
    $('mvNowLeft').textContent = tr('dash.miniLeft', 'noch {s} s').replace('{s}', Math.ceil(left / 1000));
  } else { $('mvNowBar').style.width = '100%'; $('mvNowLeft').textContent = c.untilStop ? tr('dash.miniUntilStop', 'bis zum Ende der Runde') : ''; }
}
setInterval(() => { if (document.body.classList.contains('mini')) mvTick(); }, 500);
let mvQueueKey = '';
function paintMini(s) {
  const st = s.state;
  $('mvBrand').textContent = st.brand;
  $('mvChips').replaceChildren(chip(st.paused ? 'bad' : 'ok', st.paused ? tr('dash.paused', 'Pausiert') : tr('dash.running', 'Läuft')));
  $('mvPause').textContent = st.paused ? tr('dash.resume', 'Fortsetzen') : tr('dash.pause', 'Pausieren');
  $('mvPause').dataset.paused = st.paused ? '1' : '';
  mvCurrent = st.current;
  const now = $('mvNow');
  if (st.current) {
    now.style.setProperty('--c', st.current.color || 'var(--accent)');
    $('mvNowTitle').replaceChildren(st.current.title, el('small', {}, st.current.user || ''));
    $('mvSkip').disabled = false;
  } else {
    now.style.removeProperty('--c');
    $('mvNowTitle').replaceChildren(el('small', {}, tr('dash.miniNothing', 'Gerade kein Effekt')));
    $('mvNowBar').style.width = '0'; $('mvNowLeft').textContent = ''; $('mvSkip').disabled = true;
  }
  mvTick();
  const q = st.queue || [];
  $('mvCount').textContent = q.length ? `(${q.length})` : '';
  $('mvClear').disabled = !q.length;
  const key = JSON.stringify(q);
  if (key === mvQueueKey) return;
  mvQueueKey = key;
  $('mvQueue').replaceChildren(...(q.length ? q.map((it, i) => {
    const li = el('li', {}, el('span', { class: 'n' }, String(i + 1)),
      el('div', {}, el('b', {}, ...(it.bits ? [el('span', { class: 'mv-bits', title: tr('dash.bitsFirst', 'Bits-Vorrang') }, '◆'), ' '] : []), it.title), el('small', {}, it.user)),
      el('button', { type: 'button', title: tr('dash.miniRemove', 'Aus der Warteliste nehmen (Punkte zurück)'), 'aria-label': tr('dash.miniRemove', 'Aus der Warteliste nehmen (Punkte zurück)'),
        onclick: () => mvAct('queue/remove', { qid: it.qid }) }, '✕'));
    li.style.setProperty('--c', it.color || 'var(--accent)');
    return li;
  }) : [el('li', { class: 'mv-empty', style: 'display:block;background:none' }, tr('dash.miniEmpty', 'Warteliste ist leer - warte auf die nächste Einlösung.'))]));
}
$('mvPanic').onclick = () => mvAct('panic', {});
$('mvPause').onclick = () => mvAct('pause', { paused: !$('mvPause').dataset.paused });
$('mvSkip').onclick = () => mvAct('skip', {});
$('mvClear').onclick = () => {
  if (Date.now() - (window.__mvClearArmed || 0) < 4000) { window.__mvClearArmed = 0; mvAct('clear', {}); return; }
  window.__mvClearArmed = Date.now(); $('mvMsg').textContent = tr('dash.miniClearConfirm', 'Zum Leeren nochmal klicken - alle bekommen ihre Punkte zurück.');
};
$('pause').onclick = () => api('pause', { paused: !$('pause').dataset.paused }).then(refresh);
$('gameProfile').addEventListener('change', async (e) => {
  const id = e.target.value;
  try { await api('game/profile', { id }); }
  catch (err) { banner(tr('dash.profileSwitchFail', 'Profil nicht gewechselt: {msg}').replace('{msg}', err.message), true); }
  refresh();
});
const goodbye = (text) => {
  document.body.textContent = '';
  const p = document.createElement('p');
  p.style.cssText = 'font:16px system-ui,sans-serif;color:#cbb8ff;text-align:center;margin-top:30vh';
  p.textContent = text; document.body.appendChild(p);
};
$('quit').onclick = async () => {
  if (!window.confirm(tr('dash.quitConfirm', 'Programm wirklich beenden?\nAlle Effekte stoppen und das Overlay geht aus.'))) return;
  try { await api('quit', {}); } catch (e) { banner(e.message, true); return; }
  goodbye(tr('dash.quitDone', 'Beendet. Du kannst dieses Fenster schließen.')); setTimeout(() => { try { window.close(); } catch { /* egal */ } }, 800);
};
$('restart').onclick = async () => {
  try { await api('restart', {}); } catch (e) { banner(e.message, true); return; }
  goodbye(tr('dash.restartDone', 'Startet neu … das Fenster lädt gleich neu.')); setTimeout(() => location.reload(), 4000);
};
$('ovSave').onclick = async () => {
  $('ovMsg').textContent = tr('dash.ovSaving', 'Speichere …');
  $('ovSave').disabled = true;
  try {
    await api('overlay', {
      accent: $('ovAccent').value,
      sound: $('ovSound').checked,
      top: $('ovTop').checked,
      reduceFlash: $('ovReduceFlash').checked,
      historyCount: Number($('ovHistoryCount').value),
      topCount: Number($('ovTopCount').value),
      topMode: $('ovTopMode').value,
      topRotateSec: Number($('ovTopRotateSec').value),
    });
    $('ovMsg').textContent = tr('dash.ovSaved', 'Gespeichert. Das Overlay in OBS übernimmt es sofort.');
  } catch (e) { $('ovMsg').textContent = tr('dash.syncFail', 'Fehler: {msg}').replace('{msg}', e.message); }
  $('ovSave').disabled = false;
};
$('skip').onclick = () => api('skip', {});
$('clear').onclick = () => api('clear', {});
$('seasonLengthBtn').onclick = async () => {
  $('seasonLengthBtn').disabled = true;
  $('seasonMsg').textContent = tr('dash.layoutSaving', 'Speichere …');
  try {
    await api('season/config', { lengthDays: Number($('seasonLengthDays').value) });
    $('seasonMsg').textContent = tr('dash.layoutSaved', 'Gespeichert.');
    seasonLengthLoaded = false; refresh();
  } catch (e) { $('seasonMsg').textContent = tr('dash.syncFail', 'Fehler: {msg}').replace('{msg}', e.message); }
  $('seasonLengthBtn').disabled = false;
};
$('seasonEndBtn').onclick = async () => {
  if (!confirm(tr('dash.seasonEndConfirm', 'Laufende Season wirklich jetzt beenden? Die Bestenliste wird als "letzte Season" festgehalten und auf 0 zurückgesetzt.'))) return;
  $('seasonEndBtn').disabled = true;
  $('seasonMsg').textContent = tr('dash.layoutSaving', 'Speichere …');
  try { await api('season/end', {}); $('seasonMsg').textContent = tr('dash.layoutSaved', 'Gespeichert.'); refresh(); }
  catch (e) { $('seasonMsg').textContent = tr('dash.syncFail', 'Fehler: {msg}').replace('{msg}', e.message); }
  $('seasonEndBtn').disabled = false;
};

const downloadJson = (obj, filename) => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }));
  const a = el('a', { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
const levelLabel = { ok: '✔', warn: '⚠', fail: '✖' };
$('checksBtn').onclick = async () => {
  $('checksBtn').disabled = true;
  $('checksList').textContent = tr('dash.checking', 'Prüfe …');
  try {
    const r = await api('checks');
    $('checksList').replaceChildren(...r.checks.map((c) =>
      el('div', {}, `${levelLabel[c.level] || '·'} ${c.label}`, c.hint ? el('div', { class: 'muted' }, c.hint) : '')));
  } catch (e) { $('checksList').textContent = tr('dash.syncFail', 'Fehler: {msg}').replace('{msg}', e.message); }
  $('checksBtn').disabled = false;
};
$('diagBtn').onclick = async () => {
  $('diagBtn').disabled = true;
  try {
    // /api/report statt des alten /api/diagnostics - bündelt
    // zusätzlich das Freitextfeld ("was ist passiert?") und die aktive Konfiguration.
    const r = await api('report', { note: $('reportNote').value });
    downloadJson(r, `chaoscore-fehlerbericht-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  } catch (e) { banner(tr('dash.diagFail', 'Fehlerbericht fehlgeschlagen: {msg}').replace('{msg}', e.message), true); }
  $('diagBtn').disabled = false;
};
$('selftestBtn').onclick = async () => {
  $('selftestBtn').disabled = true;
  $('selftestList').textContent = tr('dash.checking', 'Prüfe …');
  try {
    const r = await api('game/selftest');
    if (!r.results.length) {
      $('selftestList').textContent = tr('dash.selftestNone', 'Keine Aktionen für dieses Profil konfiguriert.');
    } else {
      $('selftestList').replaceChildren(...r.results.map((x) =>
        el('div', {}, `${x.ok ? '✔' : '✖'} ${x.title}${x.enabled ? '' : ' ' + tr('dash.selftestDisabled', '(aus)')}`,
          x.error ? el('div', { class: 'muted' }, x.error) : '')));
    }
  } catch (e) { $('selftestList').textContent = tr('dash.syncFail', 'Fehler: {msg}').replace('{msg}', e.message); }
  $('selftestBtn').disabled = false;
};
$('profileExportBtn').onclick = async () => {
  $('profileExportBtn').disabled = true;
  try {
    const r = await api('profile/export', { name: $('presetName').value.trim(), author: $('presetAuthor').value.trim() });
    downloadJson(r, 'chaoscore-preset.json');
    $('profileMsg').textContent = tr('dash.profileExported', 'Preset-Datei erzeugt.');
  } catch (e) { $('profileMsg').textContent = tr('dash.profileExportFail', 'Fehler: {msg}').replace('{msg}', e.message); }
  $('profileExportBtn').disabled = false;
};
// "One-Click"-Setups - dieselbe Import-Logik wie eine Datei, nur ohne
// dass der Streamer erst eine Datei suchen/laden muss.
let oneClickPainted = false;
async function paintOneClick() {
  if (oneClickPainted) return;
  try {
    const r = await api('presets');
    if (!r.presets?.length) { oneClickPainted = true; return; }
    oneClickPainted = true;
    $('oneClickList').replaceChildren(...r.presets.map((p) => {
      // erster Klick öffnet dieselbe Vorschau wie beim
      // Datei-Import, erst "Übernehmen" in der Vorschau ändert etwas.
      const btn = el('button', { type: 'button' }, tr('dash.oneClickPreview', 'Vorschau …'));
      btn.onclick = async () => {
        btn.disabled = true;
        closeImportPreview();
        $('profileMsg').textContent = tr('dash.ipChecking', 'Prüfe das Preset …');
        try {
          const pv = await api('preset/preview', { id: p.id }); // ändert nichts
          pendingImport = { presetId: p.id };
          showImportPreview(pv);
          $('profileMsg').textContent = '';
          $('importPreview').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } catch (e) { $('profileMsg').textContent = tr('dash.profileExportFail', 'Fehler: {msg}').replace('{msg}', e.message); }
        btn.disabled = false;
      };
      return el('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px;border:1px solid var(--line);border-radius:8px' },
        el('div', {}, el('b', {}, p.name), p.author ? el('span', { class: 'muted' }, ` von ${p.author}`) : '', p.description ? el('div', { class: 'muted' }, p.description) : ''),
        btn);
    }));
  } catch { /* keine Presets verfügbar - kein Fehler */ }
}
function paintGoalThresholds() {
  $('goalThresholds').replaceChildren(...goalThresholdsData.map((t, i) => {
    const nameInput = el('input', { placeholder: tr('dash.goalThresholdNamePh', 'Name der Schwelle'), maxlength: '40', value: t.name || '', style: 'background:var(--input-bg);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:8px' });
    nameInput.oninput = () => { t.name = nameInput.value; };
    const valueInput = el('input', { type: 'number', min: '1', max: '100000', value: String(t.value ?? 100), style: 'width:100px;background:var(--input-bg);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:8px' });
    valueInput.oninput = () => { t.value = Number(valueInput.value); };
    const select = el('select', { style: 'background:var(--input-bg);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:8px' },
      el('option', { value: '' }, tr('dash.goalRandomAction', '— zufällig aus dem Pool —')),
      ...goalActionPool.map((a) => el('option', { value: a.id }, a.label)));
    select.value = t.actionId || '';
    select.onchange = () => { t.actionId = select.value || null; };
    const rm = el('button', { type: 'button' }, '×');
    rm.onclick = () => { goalThresholdsData.splice(i, 1); paintGoalThresholds(); };
    return el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' }, nameInput, valueInput, select, rm);
  }));
}
// // solange noch kein eigener Befehl existiert, Erklärung + Beispiel-Vorbelegung + Vorschau
// zeigen; sobald mindestens ein Befehl angelegt wurde, nur noch die kurze Verwaltungsliste -
// kein erneuter Einsteiger-Umweg für erfahrene Nutzer.
function paintChatBeginnerHelp(commands) {
  const isBeginner = commands.length === 0;
  $('chatBeginnerHelp').style.display = isBeginner ? '' : 'none';
  if (isBeginner && !$('chatNewTrigger').value && !$('chatNewResponse').value) {
    $('chatNewTrigger').value = '!discord';
    $('chatNewResponse').value = tr('dash.chatExampleResponse', 'Mein Discord: https://discord.gg/dein-server');
  }
}
$('chatPreviewBtn').onclick = () => {
  const trigger = ($('chatNewTrigger').value || '!discord').trim();
  const response = $('chatNewResponse').value || tr('dash.chatExampleResponse', 'Mein Discord: https://discord.gg/dein-server');
  const out = $('chatPreviewOutput');
  out.style.display = '';
  out.replaceChildren(
    el('div', {}, el('b', {}, tr('dash.chatPreviewViewer', 'Zuschauer:in')), ' ', trigger),
    el('div', { style: 'margin-top:4px' }, el('b', {}, 'ChaosCore:'), ' ', response),
    el('div', { class: 'muted', style: 'margin-top:6px;font-size:12px' }, tr('dash.chatPreviewHint', 'Nur eine Vorschau - noch nicht im echten Chat gesendet. Mit „+ Befehl hinzufügen" unten wird er live geschaltet.')),
  );
};
// eigene Chat-Befehle - jede Zeile speichert für sich (toggle/remove
// wirkt sofort), anders als die Schalter/Checkboxen oben in dieser Karte.
function paintChatCommands(commands) {
  paintChatBeginnerHelp(commands);
  $('chatCommands').replaceChildren(...(commands.length ? commands.map((c) => {
    const toggle = el('input', { type: 'checkbox' });
    toggle.checked = !!c.enabled;
    toggle.onchange = async () => {
      toggle.disabled = true;
      try { await api('chat/command/toggle', { id: c.id, enabled: toggle.checked }); }
      catch (e) { toggle.checked = !toggle.checked; $('chatCommandMsg').textContent = tr('dash.syncFail', 'Fehler: {msg}').replace('{msg}', e.message); }
      toggle.disabled = false;
    };
    const rm = el('button', { type: 'button' }, '×');
    rm.onclick = async () => {
      rm.disabled = true;
      try { await api('chat/command/remove', { id: c.id }); refresh(); }
      catch (e) { $('chatCommandMsg').textContent = tr('dash.syncFail', 'Fehler: {msg}').replace('{msg}', e.message); rm.disabled = false; }
    };
    return el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' }, toggle, el('b', {}, c.trigger), el('span', { class: 'muted' }, c.response), rm);
  }) : [el('span', { class: 'muted' }, tr('dash.chatNoCommands', 'Noch keine eigenen Befehle.'))]));
}
$('chatCommandAdd').onclick = async () => {
  $('chatCommandAdd').disabled = true;
  try {
    await api('chat/command/add', { trigger: $('chatNewTrigger').value, response: $('chatNewResponse').value });
    $('chatNewTrigger').value = ''; $('chatNewResponse').value = '';
    $('chatCommandMsg').textContent = tr('dash.chatCommandAdded', 'Befehl hinzugefügt.');
    refresh();
  } catch (e) { $('chatCommandMsg').textContent = tr('dash.syncFail', 'Fehler: {msg}').replace('{msg}', e.message); }
  $('chatCommandAdd').disabled = false;
};
$('chatSave').onclick = async () => {
  $('chatSave').disabled = true;
  try {
    await api('chat/config', {
      enabled: $('chatEnabled').checked, cooldownSec: Number($('chatCooldownSec').value),
      announceEffect: $('chatAnnounceEffect').checked, announceSeasonEndingSoon: $('chatAnnounceSeasonEndingSoon').checked, announceSeasonWinner: $('chatAnnounceSeasonWinner').checked,
    });
    $('chatMsg').textContent = tr('dash.chatSaved', 'Gespeichert.');
    chatLoaded = false; refresh();
  } catch (e) { $('chatMsg').textContent = tr('dash.syncFail', 'Fehler: {msg}').replace('{msg}', e.message); }
  $('chatSave').disabled = false;
};
$('goalAddThreshold').onclick = () => {
  if (goalThresholdsData.length >= 5) { $('goalMsg').textContent = tr('dash.goalMaxThresholds', 'Maximal 5 Schwellen.'); return; }
  goalThresholdsData.push({ id: '', name: '', value: 100, actionId: null });
  paintGoalThresholds();
};
$('goalSave').onclick = async () => {
  $('goalSave').disabled = true;
  try {
    await api('goal', { name: $('goalName').value, basis: $('goalBasis').value, thresholds: goalThresholdsData });
    $('goalMsg').textContent = tr('dash.goalSaved', 'Gespeichert.');
    goalLoaded = false; refresh();
  } catch (e) { $('goalMsg').textContent = tr('dash.syncFail', 'Fehler: {msg}').replace('{msg}', e.message); }
  $('goalSave').disabled = false;
};
// eine Checkbox-Liste statt eines Mehrfach-Select - bei vielen Aktionen
// deutlich einfacher an-/abzuwählen als ein Mehrfach-Select mit Strg/Shift-Klick.
// Rückmeldung aus dem Praxistest: bei vielen Aktionen wird diese Liste "eine riesen Liste" - jetzt per
// Umschalter standardmäßig übersprungen ("zufällig aus allen aktivierten Aktionen"), die
// Checkbox-Liste ist nur noch für die bewusste Einzelauswahl nötig (siehe idleMode-Radios oben).
function paintIdleWhitelist() {
  $('idleWhitelist').replaceChildren(...idleActionPool.map((a) => {
    const box = el('input', { type: 'checkbox' });
    box.checked = idleWhitelistData.includes(a.id);
    box.onchange = () => {
      idleWhitelistData = box.checked
        ? [...new Set([...idleWhitelistData, a.id])]
        : idleWhitelistData.filter((id) => id !== a.id);
    };
    return el('label', { style: 'display:flex;align-items:center;gap:8px' }, box, a.label);
  }));
}
function syncIdleManualVisibility() { $('idleManualBox').style.display = $('idleModeManual').checked ? '' : 'none'; }
$('idleModeAuto').onchange = syncIdleManualVisibility;
$('idleModeManual').onchange = syncIdleManualVisibility;
$('idleAll').onclick = () => { idleWhitelistData = idleActionPool.map((a) => a.id); paintIdleWhitelist(); };
$('idleNone').onclick = () => { idleWhitelistData = []; paintIdleWhitelist(); };
$('idleSave').onclick = async () => {
  $('idleSave').disabled = true;
  try {
    // "auto"-Modus: Whitelist wird aus allen gerade aktivierten Aktionen berechnet (kein
    // manuelles Abhaken nötig) - server-seitig unverändert weiterhin einfach eine Whitelist.
    const whitelist = $('idleModeAuto').checked
      ? idleActionPool.filter((a) => a.enabled !== false).map((a) => a.id)
      : idleWhitelistData;
    await api('autoidle', { enabled: $('idleEnabled').checked, idleSec: Number($('idleSec').value), whitelist });
    $('idleMsg').textContent = tr('dash.idleSaved', 'Gespeichert.');
    idleLoaded = false; refresh();
  } catch (e) { $('idleMsg').textContent = tr('dash.syncFail', 'Fehler: {msg}').replace('{msg}', e.message); }
  $('idleSave').disabled = false;
};
const answerCritPrompt = async (allow) => {
  const groups = JSON.parse($('critPrompt').dataset.groups || '[]');
  const released = critReleased; // gespeicherter Stand vom Server, nicht ungespeicherte Häkchen
  for (const b of [$('critPromptAllow'), $('critPromptDecline')]) b.disabled = true;
  try {
    await api('input/critical', allow ? { keys: [...new Set([...released, ...groups])] } : { keys: released.filter((k) => !groups.includes(k)), declined: groups });
    critLoaded = false; refresh();
  } catch (e) { $('critPromptMsg').textContent = tr('dash.syncFail', 'Fehler: {msg}').replace('{msg}', e.message); }
  for (const b of [$('critPromptAllow'), $('critPromptDecline')]) b.disabled = false;
};
$('critPromptAllow').onclick = () => answerCritPrompt(true);
$('critPromptDecline').onclick = () => answerCritPrompt(false);
$('gsiRecBtn').onclick = async () => {
  try { const r = await api('gsi/record', { on: !gsiRecOn }); gsiRecOn = !!r.recording.on; if (!gsiRecOn) $('gsiRecMsg').textContent = tr('dash.gsiRecSaved', 'Gespeichert im Ordner {dir}').replace('{dir}', r.recording.dir); refresh(); }
  catch (e) { $('gsiRecMsg').textContent = tr('dash.syncFail', 'Fehler: {msg}').replace('{msg}', e.message); }
};
$('critSave').onclick = async () => {
  $('critSave').disabled = true;
  try {
    const keys = Array.from($('critList').querySelectorAll('input:checked')).map((i) => i.value);
    await api('input/critical', { keys });
    $('critMsg').textContent = tr('dash.critSaved', 'Gespeichert.');
    critLoaded = false; refresh();
  } catch (e) { $('critMsg').textContent = tr('dash.syncFail', 'Fehler: {msg}').replace('{msg}', e.message); }
  $('critSave').disabled = false;
};
$('queueSave').onclick = async () => {
  $('queueSave').disabled = true;
  try {
    await api('queuepolicy', { maxQueue: Number($('queueMax').value), queueWaitSec: Number($('queueWaitSec').value),
      bitsPriority: { enabled: $('bpEnabled').checked, maxInRow: Number($('bpRow').value), maxWaitSec: Number($('bpWait').value) } });
    $('queueMsg').textContent = tr('dash.queueSaved', 'Gespeichert.');
    queueLoaded = false; refresh();
  } catch (e) { $('queueMsg').textContent = tr('dash.syncFail', 'Fehler: {msg}').replace('{msg}', e.message); }
  $('queueSave').disabled = false;
};
function paintOverlayAssets(ov) {
  for (const kind of ['sound', 'image']) {
    const meta = kind === 'sound' ? ov.customSound : ov.customImage;
    $(`asset${kind === 'sound' ? 'Sound' : 'Image'}Info`).textContent = meta ? tr('dash.assetCurrent', 'Aktuell: {name}').replace('{name}', meta.name) : '';
    $(`asset${kind === 'sound' ? 'Sound' : 'Image'}Remove`).style.display = meta ? '' : 'none';
  }
}
function fileToDataBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error('Datei konnte nicht gelesen werden.'));
    r.readAsDataURL(file);
  });
}
async function uploadOverlayAsset(kind, inputEl, infoId) {
  const file = inputEl.files[0];
  inputEl.value = '';
  if (!file) return;
  $(infoId).textContent = tr('dash.creating', 'Lege an …');
  try {
    const dataBase64 = await fileToDataBase64(file);
    await api('overlay/asset', { kind, name: file.name, mime: file.type, dataBase64 });
    lastKey = ''; overlayLoaded = false; refresh();
  } catch (e) { $(infoId).textContent = tr('dash.syncFail', 'Fehler: {msg}').replace('{msg}', e.message); }
}
async function removeOverlayAssetUi(kind, infoId) {
  try { await api('overlay/asset/remove', { kind }); lastKey = ''; overlayLoaded = false; refresh(); }
  catch (e) { $(infoId).textContent = tr('dash.syncFail', 'Fehler: {msg}').replace('{msg}', e.message); }
}
$('assetSoundFile').onchange = () => uploadOverlayAsset('sound', $('assetSoundFile'), 'assetSoundInfo');
$('assetSoundRemove').onclick = () => removeOverlayAssetUi('sound', 'assetSoundInfo');
$('assetImageFile').onchange = () => uploadOverlayAsset('image', $('assetImageFile'), 'assetImageInfo');
$('assetImageRemove').onclick = () => removeOverlayAssetUi('image', 'assetImageInfo');
$('profileImportBtn').onclick = () => $('profileImportFile').click();
