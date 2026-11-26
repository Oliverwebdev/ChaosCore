// Dashboard - Status zeichnen (paint) und Effekt-Listen.
// Wird beim Ausliefern in dashboard.html eingesetzt (siehe src/web-pages.js): alle Teile laufen
// zusammen in EINEM Skript, in dieser Reihenfolge.
function paint(s) {
  lastStatus = s;
  $('brand').textContent = s.state.brand;
  if (!versionPainted && s.version) { versionPainted = true; $('versionInfo').textContent = `${s.state.brand} ${s.version}` + (s.build ? ` · Build ${s.build.build} (${s.build.commit.slice(0, 7)})` : ''); }
  fx.setStatus(s);
  if (!overlayLoaded && s.state.overlay) {
    overlayLoaded = true;
    const ov = s.state.overlay;
    $('ovAccent').value = s.state.accent || '#B026FF';
    $('ovSound').checked = !!s.state.sound;
    $('ovTop').checked = !!ov.top;
    $('ovReduceFlash').checked = !!ov.reduceFlash;
    $('ovHistoryCount').value = ov.historyCount;
    $('ovTopCount').value = ov.topCount;
    $('ovTopMode').value = ov.topMode;
    $('ovTopRotateSec').value = ov.topRotateSec;
    layoutData = { ...(ov.layout || {}) };
    hiddenPanels = [...(ov.hidden || [])];
    paintStyles(ov);
    paintLayoutEditor();
    paintVisibility();
    paintOverlayAssets(ov);
    paintOneClick();
  }
  if (!goalLoaded && s.communityGoal) {
    goalLoaded = true;
    goalActionPool = [
      ...(s.actions || []).map((a) => ({ id: a.id, label: a.title })),
      ...(s.bitsActions || []).map((a) => ({ id: a.id, label: a.title + ' (Bits)' })),
    ];
    $('goalName').value = s.communityGoal.name || '';
    $('goalBasis').value = s.communityGoal.basis || 'both';
    goalThresholdsData = (s.communityGoal.thresholds || []).map((t) => ({ ...t }));
    paintGoalThresholds();
  }
  if (!idleLoaded && s.autoIdle) {
    idleLoaded = true;
    idleActionPool = [
      ...(s.actions || []).map((a) => ({ id: a.id, label: a.title, enabled: a.enabled })),
      ...(s.bitsActions || []).map((a) => ({ id: a.id, label: a.title + ' (Bits)', enabled: a.enabled })),
    ];
    $('idleEnabled').checked = !!s.autoIdle.enabled;
    $('idleSec').value = s.autoIdle.idleSec ?? 300;
    idleWhitelistData = [...(s.autoIdle.whitelist || [])];
    // Rückmeldung aus dem Praxistest: Standard ist "zufällig aus allen aktivierten Aktionen", damit niemand
    // erst eine lange Liste abhaken muss. Wurde schon einmal bewusst eine eigene (kleinere)
    // Auswahl gespeichert, bleibt die als "Eigene Auswahl" erhalten statt sie zu überschreiben.
    const enabledIds = idleActionPool.filter((a) => a.enabled !== false).map((a) => a.id).sort();
    const isDefaultSet = !idleWhitelistData.length || (JSON.stringify([...idleWhitelistData].sort()) === JSON.stringify(enabledIds));
    $('idleModeAuto').checked = isDefaultSet;
    $('idleModeManual').checked = !isDefaultSet;
    paintIdleWhitelist();
    syncIdleManualVisibility();
  }
  if (s.gsiRecording) {
    gsiRecOn = !!s.gsiRecording.on;
    $('gsiRecBtn').textContent = gsiRecOn ? tr('dash.gsiRecStop', 'Aufzeichnung beenden') : tr('dash.gsiRecStart', 'Aufzeichnung starten');
    $('gsiRecMsg').textContent = gsiRecOn ? tr('dash.gsiRecRunning', 'Läuft: {n} Pakete in {file}').replace('{n}', s.gsiRecording.count).replace('{file}', s.gsiRecording.file) : '';
  }
  if (s.input) {
    critReleased = s.input.criticalKeys || [];
    const pending = s.input.pending || [];
    const key = JSON.stringify(pending);
    if (key !== lastCritPending) {
      lastCritPending = key;
      $('critPrompt').style.display = pending.length ? '' : 'none';
      $('critPromptList').replaceChildren(...pending.map((p) => el('li', {}, el('strong', {}, p.group), ' – ' + p.bindings.map((b) => `${keyLabel(b.name)} (${b.key})`).join(', '))));
      $('critPrompt').dataset.groups = JSON.stringify(pending.map((p) => p.group));
    }
  }
  if (!critLoaded && s.input) {
    critLoaded = true;
    const on = new Set(s.input.criticalKeys || []);
    $('critList').replaceChildren(...(s.input.criticalChoices || []).map((k) =>
      el('label', {}, el('input', { type: 'checkbox', value: k, ...(on.has(k) ? { checked: '' } : {}) }), ' ' + k)));
  }
  if (!queueLoaded && s.queuePolicy) {
    queueLoaded = true;
    $('queueMax').value = s.queuePolicy.maxQueue ?? 3;
    $('queueWaitSec').value = s.queuePolicy.queueWaitSec ?? 0;
    const bp = s.queuePolicy.bitsPriority || {};
    $('bpEnabled').checked = bp.enabled !== false; $('bpRow').value = bp.maxInRow ?? 2; $('bpWait').value = bp.maxWaitSec ?? 180;
  }
  if (!chatLoaded && s.chat) {
    chatLoaded = true;
    $('chatEnabled').checked = !!s.chat.enabled;
    $('chatCooldownSec').value = s.chat.cooldownSec ?? 10;
    $('chatAnnounceEffect').checked = !!s.chat.announceEffect;
    $('chatAnnounceSeasonEndingSoon').checked = !!s.chat.announceSeasonEndingSoon;
    $('chatAnnounceSeasonWinner').checked = !!s.chat.announceSeasonWinner;
  }
  // Die Befehlsliste selbst wird (anders als die Schalter oben) bei JEDER Statusaktualisierung
  // neu gemalt, nicht nur einmal - sie wird ja außerhalb dieser Karte sofort bei jeder
  // Änderung gespeichert, das Dashboard soll also auch eine Änderung aus einer anderen
  // geöffneten Dashboard-Instanz zeitnah übernehmen.
  if (s.chat && JSON.stringify(s.chat.commands) !== JSON.stringify(chatCommandsPainted)) {
    chatCommandsPainted = s.chat.commands;
    paintChatCommands(s.chat.commands);
  }
  const tw = { connected: ['ok', tr('dash.twConnected', 'Twitch verbunden')], connecting: ['warn', tr('dash.twConnecting', 'Twitch verbindet…')], reconnecting: ['warn', tr('dash.twReconnecting', 'Twitch verbindet neu…')], auth_failed: ['bad', tr('dash.twAuthFailed', 'Twitch-Login ungültig')], offline: ['bad', tr('dash.twOffline', 'Twitch offline')] }[s.twitch.status] || ['warn', s.twitch.status];
  const g = s.gsi;
  const chips = [chip(tw[0], tw[1] + (s.twitch.login ? ' · ' + s.twitch.login : ''))];
  // GSI/Spielzustand gibt es nur bei Profilen mit eigener Schnittstelle (aktuell nur CS2) — kein generischer Chip für jedes Spiel.
  if (s.game && s.game.supportsGsi) {
    chips.push(g.connected ? chip(g.live ? 'ok' : 'warn', g.live ? tr('dash.cs2RoundLive', 'CS2: Runde läuft') : tr('dash.cs2ConnectedPhase', 'CS2 verbunden ({phase})').replace('{phase}', g.phase || tr('dash.cs2Pause', 'Pause'))) : chip('warn', tr('dash.cs2NotConnected', 'CS2 nicht verbunden (GSI)')));
  }
  chips.push(chip(s.bridge.kind === 'ahk' ? 'ok' : 'warn', s.bridge.kind === 'ahk' ? tr('dash.effectsAhk', 'Effekte: AutoHotkey') : tr('dash.effectsSim', 'Effekte: Simulation')));
  chips.push(chip(s.state.paused ? 'bad' : 'ok', s.state.paused ? tr('dash.paused', 'Pausiert') : tr('dash.running', 'Läuft')));
  $('chips').replaceChildren(...chips);

  if (s.game) {
    if (!profilesPainted && Array.isArray(s.game.profiles)) {
      profilesPainted = true;
      $('gameProfile').replaceChildren(...s.game.profiles.map((p) => el('option', { value: p.id }, p.name)));
      $('gameProfile').hidden = s.game.profiles.length < 2; // 2.0: nur CS2 - kein Umschalter nötig
    }
    if ($('gameProfile').value !== s.game.profile) $('gameProfile').value = s.game.profile;
  }

  const notes = [];
  if (s.state.game?.blockedMode) notes.push(tr('dash.mlBlockedNote', 'Effekte pausieren: Spielmodus „{mode}“ ist gesperrt (Einstellungen → Spielmodi).').replace('{mode}', modeName(s.state.game.blockedMode)));
  paintModeLock(s);
  paintSysBox(s.state);
  $('reloginBox').hidden = s.twitch.status !== 'auth_failed';
  $('confidentialBox').hidden = s.twitch.clientType !== 'confidential';
  if (s.bridge.note) notes.push(s.bridge.note);
  if (!s.actions.some((a) => a.enabled && a.linked)) notes.push(tr('dash.noRewardLinkedNote', 'Keine Belohnung ist mit Twitch verbunden. Klicke „Belohnungen mit Twitch abgleichen“ oder oben auf „⚙ Einrichtung“.'));
  // Testversion-Wasserzeichen auch im Dashboard, nicht nur im Overlay -
  // Man soll jederzeit sehen, dass das hier eine befristete Testversion ist.
  if (s.state.license?.testVersion) notes.push(tr('dash.testVersionNote', 'Testversion — nicht für den Live-Einsatz bestimmt (läuft bis {date}).').replace('{date}', new Date(s.state.license.expiresAt).toLocaleDateString(uiLocale())));
  banner(notes.join(' '), false);

  paintMini(s);
  paintLive(s);
  if (vtData && !!s.gsi?.connected !== paintValveTest.gsi) { paintValveTest.gsi = !!s.gsi?.connected; paintValveTest(s); }
  paintBitsMenu(s.bitsMenu);
  paintCredit(s);
  $('potState').textContent = s.state.bitsPot ? tr('dash.potState', 'Im Topf: {have} von {goal} Bits').replace('{have}', s.state.bitsPot.have).replace('{goal}', s.state.bitsPot.goal) : '';
  paintMilestones(s.state.milestones || []);
  $('pause').textContent = s.state.paused ? tr('dash.resume', 'Fortsetzen') : tr('dash.pause', 'Pausieren');
  $('pause').dataset.paused = s.state.paused ? '1' : '';
  $('hotkeyInfo').textContent = s.bridge.kind === 'ahk' ? tr('dash.hotkeyAhk', 'Not-Aus-Hotkey im Spiel: {key}').replace('{key}', s.bridge.panicHotkey.replace('^', 'Strg+').replace('!', 'Alt+').replace('+', '+')) : tr('dash.hotkeyNone', 'Der Hotkey ist nur mit AutoHotkey aktiv.');

  const c = s.state.current;
  $('now').replaceChildren(c ? el('div', {}, el('b', {}, c.title), el('span', { class: 'muted' }, (c.test ? tr('dash.testRun', 'Testlauf') : tr('dash.byUser', 'von {user}').replace('{user}', c.user)) + (c.untilStop ? tr('dash.untilRoundEnd', ' · bis Rundenende') : ''))) : el('span', { class: 'muted' }, tr('dash.nothingActive', 'Nichts aktiv.')));
  $('queue').replaceChildren(...(s.state.queue.length ? s.state.queue.map((q, i) => el('div', {}, `${i + 1}. ${q.title} `, el('span', { class: 'muted' }, q.user))) : [tr('dash.queueEmpty', 'leer')]));
  $('chaos').style.width = Math.min(100, s.state.chaos) + '%';
  const ct = s.state.contract;
  $('contract').textContent = tr('dash.contract', 'Daily Contract: {have}/{target} Zuschauer').replace('{have}', Math.min(ct.have, ct.target)).replace('{target}', ct.target) + (ct.done ? ' ✔' : '');

  const season = s.state.season;
  if (season) {
    const daysLeft = Math.max(0, Math.ceil((season.endsAt - Date.now()) / 86400000));
    $('seasonInfo').textContent = tr('dash.seasonLengthDays', 'Läuft {days} Tage · noch {left} Tag(e)').replace('{days}', season.lengthDays).replace('{left}', daysLeft);
    if (!seasonLengthLoaded) { seasonLengthLoaded = true; $('seasonLengthDays').value = season.lengthDays; }
    $('seasonHall').replaceChildren(...(season.chaosHall.length
      ? season.chaosHall.map((r, i) => el('tr', {}, el('td', {}, `${i + 1}. ${r.name}`), el('td', { class: 'num' }, `${r.chaos}`)))
      : [el('tr', {}, el('td', { class: 'muted' }, tr('dash.seasonEmpty', 'Noch keine Teilnahme in dieser Season.')))]));
    $('seasonWinner').textContent = season.lastWinner
      ? tr('dash.seasonLastWinner', 'Letzte Season: {name} ({chaos} Chaos-Score)').replace('{name}', season.lastWinner.name).replace('{chaos}', season.lastWinner.chaos)
      : '';
  }

  const stat = new Map(s.stats.map((x) => [x.id, x]));
  const tbody = $('actions');
  const key = JSON.stringify([s.actions, s.stats]);
  if (!tbody.dataset.busy && key !== lastKey) {
    lastKey = key;
    tbody.replaceChildren(...s.actions.map((a) => {
      const st = stat.get(a.id) || { n: 0, done: 0, refunded: 0 };
      const sw = el('label', { class: 'switch' }, el('input', { type: 'checkbox', 'aria-label': a.title + ' ' + tr('dash.active', 'aktiv') }), el('span'));
      const cb = sw.querySelector('input'); cb.checked = a.enabled;
      cb.addEventListener('change', async () => {
        tbody.dataset.busy = '1';
        try { const r = await api('action', { id: a.id, enabled: cb.checked }); if (r.warning) banner(r.warning, true); }
        catch (e) { banner(tr('dash.toggleFail', 'Konnte nicht umschalten: {msg}').replace('{msg}', e.message), true); cb.checked = !cb.checked; }
        delete tbody.dataset.busy; refresh();
      });
      const tags = [el('span', { class: 'tag ' + a.category }, tierLabel(a.category))];
      if (a.legacy) tags.push(el('span', { class: 'tag' }, tr('dash.legacyTag', 'alt')));
      if (a.custom) tags.push(el('span', { class: 'tag' }, tr('dash.customTag', 'eigener')));
      if (a.enabled && !a.linked) tags.push(el('span', { class: 'tag warn' }, tr('dash.notLinkedTag', 'nicht verbunden')));
      const costInput = el('input', { type: 'number', class: 'ss-input', min: '1', max: '1000000', value: String(a.cost), 'aria-label': a.title + ' ' + tr('dash.thPoints', 'Punkte') });
      costInput.addEventListener('focus', () => { tbody.dataset.busy = '1'; });
      costInput.addEventListener('blur', () => { if (Number(costInput.value) === a.cost) delete tbody.dataset.busy; });
      costInput.addEventListener('change', async () => {
        const v = Number(costInput.value);
        if (!v || v === a.cost) { costInput.value = String(a.cost); return; }
        tbody.dataset.busy = '1'; costInput.disabled = true;
        try { const r = await api('action/update', { id: a.id, cost: v }); if (r.warning) banner(r.warning, true); }
        catch (e) { banner(tr('dash.priceFail', 'Preis nicht geändert: {msg}').replace('{msg}', e.message), true); costInput.value = String(a.cost); }
        costInput.disabled = false; delete tbody.dataset.busy; refresh();
      });
      const tools = [
        el('button', { type: 'button', onclick: () => test(a.id, true) }, tr('dash.dry', 'Trocken')),
        el('button', { type: 'button', onclick: () => { if (confirm(tr('dash.realConfirm', 'Echt senden? Wechsle in den nächsten 5 Sekunden ins Spiel.'))) test(a.id, false); } }, tr('dash.real', 'Echt')),
        el('span', { class: 'grow' }),
        el('button', { type: 'button', class: 'primary', onclick: () => fx.open('points', a) }, tr('dash.fxEdit', 'Bearbeiten')),
        el('button', { type: 'button', title: tr('dash.fxCopyHint', 'Als neuen eigenen Effekt kopieren'), onclick: () => fx.copy('points', a) }, tr('dash.fxCopy', 'Kopie')),
      ];
      if (a.custom) tools.push(el('button', { type: 'button', class: 'danger', 'aria-label': a.title + ' ' + tr('dash.deleteAria', 'löschen'), onclick: async () => {
        if (!confirm(tr('dash.deleteConfirm', '"{title}" wirklich löschen? Wird auch bei Twitch entfernt.').replace('{title}', a.title))) return;
        tbody.dataset.busy = '1';
        try { const r = await api('action/delete', { id: a.id }); if (r.warning) banner(r.warning, true); }
        catch (e) { banner(tr('dash.deleteFail', 'Konnte nicht löschen: {msg}').replace('{msg}', e.message), true); }
        delete tbody.dataset.busy; refresh();
      } }, '✕'));
      // Galerie-Karte: oben an/aus und Stufe, dann Name und was der Effekt tut (als Satz), unten Auslöser und Werkzeuge
      const card = el('article', { class: 'fx-card' + (a.enabled ? '' : ' off'), 'data-title': a.title.toLowerCase(), 'data-on': a.enabled ? '1' : '0', 'data-custom': a.custom ? '1' : '0' },
        el('div', { class: 'fx-c-top' }, sw, ...tags),
        el('h3', { class: 'fx-c-title' }, a.title),
        el('p', { class: 'fx-c-desc' }, a.describe || ''), ...invalidNote(a),
        el('div', { class: 'fx-c-trig' }, el('label', { class: 'fx-c-cost' }, costInput, el('span', {}, tr('dash.thPoints', 'Punkte'))), accessSelect(a, 'action/access', tbody, refresh).firstChild || el('span')),
        el('div', { class: 'fx-c-stats' }, tr('dash.fxStats', '{n}× eingelöst · {done} erledigt · {ref} erstattet').replace('{n}', st.n).replace('{done}', st.done).replace('{ref}', st.refunded)),
        el('div', { class: 'fx-c-tools' }, ...tools));
      return card;
    }));
    applyFxFilter();
  }

  const bitsTbody = $('bitsActions');
  const bitsKey = JSON.stringify(s.bitsActions || []);
  if (s.bitsActions && !bitsTbody.dataset.busy && bitsKey !== lastBitsKey) {
    lastBitsKey = bitsKey;
    bitsTbody.replaceChildren(...[...s.bitsActions].sort((x, y) => x.cost - y.cost).map((a) => {
      const sw = el('label', { class: 'switch' }, el('input', { type: 'checkbox', 'aria-label': a.title + ' ' + tr('dash.active', 'aktiv') }), el('span'));
      const cb = sw.querySelector('input'); cb.checked = a.enabled;
      cb.addEventListener('change', async () => {
        bitsTbody.dataset.busy = '1';
        try { await api('bits/action', { id: a.id, enabled: cb.checked }); }
        catch (e) { banner(tr('dash.toggleFail', 'Konnte nicht umschalten: {msg}').replace('{msg}', e.message), true); cb.checked = !cb.checked; }
        delete bitsTbody.dataset.busy; refresh();
      });
      const costInput = el('input', { type: 'number', class: 'ss-input', min: '1', max: '1000000', value: String(a.cost), 'aria-label': a.title + ' ' + tr('dash.thBits', 'Bits') });
      costInput.addEventListener('focus', () => { bitsTbody.dataset.busy = '1'; });
      costInput.addEventListener('blur', () => { if (Number(costInput.value) === a.cost) delete bitsTbody.dataset.busy; });
      costInput.addEventListener('change', async () => {
        const v = Number(costInput.value);
        if (!v || v === a.cost) { costInput.value = String(a.cost); return; }
        bitsTbody.dataset.busy = '1'; costInput.disabled = true;
        try { await api('bits/action/update', { id: a.id, cost: v }); }
        catch (e) { banner(tr('dash.thresholdFail', 'Schwelle nicht geändert: {msg}').replace('{msg}', e.message), true); costInput.value = String(a.cost); }
        costInput.disabled = false; delete bitsTbody.dataset.busy; refresh();
      });
      const tests = el('td', {},
        el('button', { onclick: () => test(a.id, true) }, tr('dash.dry', 'Trocken')), ' ',
        el('button', { onclick: () => { if (confirm(tr('dash.realConfirm', 'Echt senden? Wechsle in den nächsten 5 Sekunden ins Spiel.'))) test(a.id, false); } }, tr('dash.real', 'Echt')));
      const del = el('td', {}, a.custom ? el('button', { class: 'danger', 'aria-label': a.title + ' ' + tr('dash.deleteAria', 'löschen'), onclick: async () => {
        if (!confirm(tr('dash.deleteConfirmBits', '"{title}" wirklich löschen?').replace('{title}', a.title))) return;
        bitsTbody.dataset.busy = '1';
        try { await api('bits/action/delete', { id: a.id }); }
        catch (e) { banner(tr('dash.deleteFail', 'Konnte nicht löschen: {msg}').replace('{msg}', e.message), true); }
        delete bitsTbody.dataset.busy; refresh();
      } }, tr('dash.deleteBtn', 'Löschen')) : '');
      const tools = el('td', {}, el('div', { class: 'row-tools' },
        el('button', { type: 'button', onclick: () => fx.open('bits', a) }, tr('dash.fxEdit', 'Bearbeiten')),
        el('button', { type: 'button', onclick: () => fx.copy('bits', a) }, tr('dash.fxCopy', 'Kopie')), ...del.childNodes));
      // Sprosse der Bits-Leiter: links der Preis, in der Mitte was passiert, rechts Schalter und Werkzeuge
      return el('div', { class: 'rung' + (a.enabled ? '' : ' off') },
        el('label', { class: 'rung-cost' }, el('span', { class: 'gem', 'aria-hidden': 'true' }, '◆'), costInput, el('small', {}, tr('dash.thBits', 'Bits'))),
        el('div', { class: 'rung-main' }, el('b', {}, a.title), el('small', {}, a.describe || ''), ...invalidNote(a)),
        el('div', { class: 'rung-tools' }, sw, accessSelect(a, 'bits/action/access', bitsTbody, refresh).firstChild || el('span'), ...tests.childNodes, ...tools.firstChild.childNodes));
    }));
  }

  $('recent').replaceChildren(...s.recent.map((r) => el('tr', {}, el('td', {}, fmtTime(r.ts)), el('td', {}, r.user_name || ''), el('td', {}, r.action_id), el('td', { class: 'st-' + r.status }, r.status), el('td', { class: 'muted' }, r.reason || ''))));
  $('wait').textContent = s.avgWaitMs ? tr('dash.avgWait', 'Ø Wartezeit in der Queue (14 Tage): {s} s').replace('{s}', (s.avgWaitMs / 1000).toFixed(1)) : '';
  const log = $('log'); const atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
  log.textContent = s.log.join('\n'); if (atEnd) log.scrollTop = log.scrollHeight;
}

async function test(id, dry) { try { await api('test', { id, dry }); } catch (e) { banner(tr('dash.testFail', 'Test nicht möglich: {msg}').replace('{msg}', e.message), true); } }
$('panic').onclick = () => api('panic', {}).catch((e) => banner(e.message, true));

// ---- Effekt-Galerie: Suche und Filter (rein in der Anzeige, nichts wird gespeichert) ----
let fxFilter = 'all';
function applyFxFilter() {
  const q = $('fxSearch').value.trim().toLowerCase();
  let shown = 0;
  for (const c of $('actions').children) {
    const ok = (!q || c.dataset.title.includes(q)) && (fxFilter === 'all' || (fxFilter === 'on' && c.dataset.on === '1') || (fxFilter === 'off' && c.dataset.on === '0') || (fxFilter === 'custom' && c.dataset.custom === '1'));
    c.hidden = !ok; if (ok) shown++;
  }
  $('actions').dataset.empty = shown ? '' : tr('dash.fxNoMatch', 'Kein Effekt passt zur Suche.');
}
$('fxSearch').oninput = applyFxFilter;
for (const b of $('fxFilter').querySelectorAll('[data-f]')) b.onclick = () => {
  fxFilter = b.dataset.f;
  for (const x of $('fxFilter').querySelectorAll('[data-f]')) { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); }
  applyFxFilter();
};
