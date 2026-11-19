// Dashboard - Session Stats.
// Wird beim Ausliefern in dashboard.html eingesetzt (siehe src/web-pages.js): alle Teile laufen
// zusammen in EINEM Skript, in dieser Reihenfolge.
// ---------- Session Stats ----------
const ST_LABELS = {
  kills: ['dash.stKills', 'Kills'], deaths: ['dash.stDeaths', 'Tode'], kd: ['dash.stKd', 'K/D'], fails: ['dash.stFails', 'Fails'],
  deathsChaos: ['dash.stDeathsChaos', 'Tode durch Chaos'], deathsNatural: ['dash.stDeathsNatural', 'Natürliche Tode'],
  killsUnderChaos: ['dash.stKillsUnderChaos', 'Kills trotz Chaos'], roundsWon: ['dash.stRoundsWon', 'Runden gewonnen'],
  roundsLost: ['dash.stRoundsLost', 'Runden verloren'], matchesWon: ['dash.stMatchesWon', 'Matches gewonnen'],
  matchesLost: ['dash.stMatchesLost', 'Matches verloren'], bestStreak: ['dash.stBestStreak', 'Meiste Kills in einer Runde'],
};
const ST_ALL = Object.keys(ST_LABELS);
const ST_ADJ = ['kills', 'deaths', 'fails', 'roundsWon', 'roundsLost', 'matchesWon', 'matchesLost'];
const stLabel = (k) => tr(ST_LABELS[k][0], ST_LABELS[k][1]);
const hhmm = (ts) => new Date(ts).toLocaleTimeString(uiLocale(), { hour: '2-digit', minute: '2-digit' });
const dur = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };
let ssViewId = null; let ssActive = false; let ssCfgLoaded = false; let ssLastKey = ''; let ssShow = [];
async function refreshStats() {
  if (document.body.dataset.section !== 'stats') return;
  try { paintStats(await api('stats' + (ssViewId ? '?id=' + ssViewId : ''))); }
  catch (e) { $('ssMsg').textContent = e.message; }
}
window.__uccStatsRefresh = refreshStats;
async function ssAct(fn, msgEl = 'ssMsg') {
  try { await fn(); $(msgEl).textContent = ''; } catch (e) { $(msgEl).textContent = e.message; }
  ssLastKey = ''; refreshStats();
}
function paintStats(d) {
  const st = d.state; ssActive = !!st.active; const live = st.active && (!ssViewId || ssViewId === st.session?.id);
  if (!ssCfgLoaded) {
    ssCfgLoaded = true;
    $('ssEnabled').checked = !!d.config.enabled; $('ssAutoStream').checked = !!d.config.autoStream;
    $('ssFailCommand').checked = !!d.config.failCommand; $('ssAnnounce').checked = !!d.config.announceChaosDeath;
    $('ssWindow').value = d.config.chaosWindowSec; $('ssStreak').value = d.config.streakMin;
    $('ssModes').value = (d.config.excludeModes || []).join(', ');
    $('ssTheme').value = d.config.overlayTheme || 'unknown';
    const ovc = d.config.overlay || {};
    $('ssOvBar').checked = ovc.bar !== false; $('ssOvSplit').checked = ovc.split !== false; $('ssOvTorture').checked = ovc.torture !== false; $('ssOvPopups').checked = ovc.popups !== false;
    api('status').then((s) => { $('ssHotkey').value = s.bridge?.failHotkey ?? ''; }).catch(() => {});
  }
  ssShow = d.config.show || [];
  const key = JSON.stringify([d.totals, d.timeline, d.torture, d.history.map((h) => [h.id, h.endedAt, h.totals]), st.active, st.streamLive, st.gsiLive, ssShow, ssViewId]);
  if (key === ssLastKey) return;
  ssLastKey = key;
  $('ssChips').replaceChildren(
    chip(st.active ? 'ok' : '', st.active ? tr('dash.stChipActive', 'Sitzung läuft') : tr('dash.stChipNone', 'Keine Sitzung')),
    chip(st.streamLive ? 'ok' : '', st.streamLive ? tr('dash.stChipLive', 'Twitch live') : tr('dash.stChipOffline', 'Twitch offline')),
    chip(st.gsiLive ? 'ok' : 'warn', st.gsiLive ? tr('dash.stChipGsi', 'Spiel verbunden') : tr('dash.stChipNoGsi', 'Keine Spieldaten')));
  const viewing = ssViewId && d.history.find((h) => h.id === ssViewId);
  let info;
  if (viewing) info = tr('dash.stViewing', 'Du siehst Sitzung vom {date}.').replace('{date}', new Date(viewing.startedAt).toLocaleString(uiLocale()));
  else if (st.active) info = tr('dash.stRunningSince', 'Läuft seit {time} ({source}). Gezählt wird nur während einer Sitzung.')
    .replace('{time}', hhmm(st.session.startedAt)).replace('{source}', st.session.source === 'stream' ? tr('dash.stSrcStream', 'mit dem Stream gestartet') : tr('dash.stSrcManual', 'von Hand gestartet'));
  else info = d.config.autoStream ? tr('dash.stIdleAuto', 'Startet automatisch, sobald du live gehst - oder jetzt von Hand.') : tr('dash.stIdleManual', 'Automatischer Start ist aus - starte die Sitzung von Hand.');
  if (!st.adapter) info += ' ' + tr('dash.stNoAdapter', 'Für dieses Spiel gibt es noch keine automatische Zählung - Fails und Handzählung funktionieren.');
  $('ssInfo').replaceChildren(info, ...(viewing ? [' ', el('button', { type: 'button', style: 'padding:2px 10px', onclick: () => { ssViewId = null; ssLastKey = ''; refreshStats(); } }, tr('dash.stBackToLive', 'Zur aktuellen Sitzung'))] : []));
  $('ssStartStop').textContent = st.active ? tr('dash.stStop', 'Sitzung beenden') : tr('dash.stStart', 'Sitzung starten');
  $('ssStartStop').classList.toggle('primary', !st.active);
  $('ssFail').disabled = !st.active;
  const t = d.totals || {};
  $('ssTiles').replaceChildren(...ssShow.map((k) => {
    const v = k === 'kd' ? Number(t.kd || 0).toFixed(2) : (t[k] ?? 0);
    const kids = [el('div', { class: 'ss-lbl' }, stLabel(k)), el('div', { class: 'ss-val' }, String(v))];
    if (live && ST_ADJ.includes(k)) {
      kids.push(el('div', { class: 'ss-adj' },
        el('button', { type: 'button', 'aria-label': stLabel(k) + ' -1', onclick: () => ssAct(() => api('stats/adjust', { stat: k, delta: -1 })) }, '−'),
        el('button', { type: 'button', 'aria-label': stLabel(k) + ' +1', onclick: () => ssAct(() => api('stats/adjust', { stat: k, delta: 1 })) }, '+')));
    }
    return el('div', { class: 'ss-tile' + (k === 'deathsChaos' || k === 'killsUnderChaos' ? ' chaos' : '') }, ...kids);
  }));
  const nat = t.deathsNatural || 0, cha = t.deathsChaos || 0, sum = nat + cha;
  const [ni, ci] = $('ssSplit').children;
  ni.style.width = sum ? (nat / sum * 100) + '%' : '50%'; ci.style.width = sum ? (cha / sum * 100) + '%' : '50%';
  $('ssSplit').style.opacity = sum ? '1' : '.35';
  $('ssNatTxt').textContent = `${stLabel('deathsNatural')}: ${nat}`; $('ssChaTxt').textContent = `${stLabel('deathsChaos')}: ${cha}`;
  $('ssPick').replaceChildren(...ST_ALL.map((k) => {
    const on = ssShow.includes(k);
    const cb = el('input', { type: 'checkbox' }); cb.checked = on;
    cb.onchange = () => ssAct(() => api('stats/config', { show: cb.checked ? [...ssShow, k] : ssShow.filter((x) => x !== k) }));
    return el('label', { class: on ? 'on' : '' }, cb, stLabel(k));
  }));
  $('ssTimeline').replaceChildren(...(d.timeline.length ? d.timeline.map((x) => {
    const who = x.cause === 'chaos' ? [x.viewer || tr('dash.stUnknownViewer', 'unbekannt'), x.effect ? ` · ${x.effect}` : ''].join('') : '';
    const extra = [x.corrected ? tr('dash.stCorrected', 'korrigiert') : '', x.source === 'manual' ? tr('dash.stManual', 'von Hand') : '', x.detail || ''].filter(Boolean).join(' · ');
    const btn = live && !x.removed ? el('button', { type: 'button', style: 'padding:3px 10px;font-size:12px', onclick: () => ssAct(() => api('stats/correct', { id: x.id, cause: x.cause === 'chaos' ? 'natural' : 'chaos' })) },
      x.cause === 'chaos' ? tr('dash.stToNatural', '→ natürlich') : tr('dash.stToChaos', '→ Chaos')) : el('span');
    return el('div', { class: 'row' + (x.removed ? ' removed' : '') }, el('span', { class: 'muted' }, hhmm(x.ts)),
      el('div', {}, el('span', { class: 'ss-badge ' + x.cause }, x.cause === 'chaos' ? 'Chaos' : tr('dash.stNaturalShort', 'Natürlich')), ' ', who,
        ...(extra ? [el('div', { class: 'muted', style: 'font-size:11px' }, extra)] : [])), btn);
  }) : [el('div', { class: 'muted' }, tr('dash.stNoDeaths', 'Noch keine Tode - weiter so.'))]));
  $('ssTorture').replaceChildren(...(d.torture.length ? d.torture.map((r, i) => el('tr', {}, el('td', { style: 'width:28px' }, `${i + 1}.`), el('td', {}, r.name), el('td', { style: 'text-align:right' }, `${r.n}× 💀`)))
    : [el('tr', {}, el('td', { class: 'muted' }, tr('dash.stNoTorture', 'Noch niemand.')))]));
  $('ssHistory').replaceChildren(...d.history.map((h) => {
    const csv = el('button', { type: 'button', style: 'padding:3px 10px;font-size:12px', onclick: () => ssCsv(h.id) }, 'CSV');
    const view = el('button', { type: 'button', style: 'padding:3px 10px;font-size:12px;margin-right:6px', onclick: () => { ssViewId = h.id; ssLastKey = ''; refreshStats(); window.scrollTo({ top: 0, behavior: 'smooth' }); } }, tr('dash.stView', 'Ansehen'));
    return el('tr', {}, el('td', {}, new Date(h.startedAt).toLocaleString(uiLocale(), { dateStyle: 'short', timeStyle: 'short' })),
      el('td', {}, h.endedAt ? dur(h.endedAt - h.startedAt) : tr('dash.stRunning', 'läuft')),
      el('td', {}, `${h.totals.kills} / ${h.totals.deaths}`), el('td', {}, String(h.totals.deathsChaos)), el('td', {}, String(h.totals.fails)),
      el('td', {}, h.torture ? `${h.torture.name} (${h.torture.n})` : '–'), el('td', { style: 'white-space:nowrap' }, view, csv));
  }));
}
async function ssCsv(id) {
  try {
    const res = await fetch('/api/stats/csv?id=' + id, { headers: { 'x-admin-token': token } });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.status);
    const url = URL.createObjectURL(await res.blob());
    const a = el('a', { href: url, download: `chaoscore-session-${id}.csv` }); document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch (e) { $('ssMsg').textContent = e.message; }
}
$('ssStartStop').onclick = () => {
  if (ssActive && !confirmStop()) return;
  ssAct(() => api('stats/session', { action: ssActive ? 'stop' : 'start' }));
};
// Bewusst kein confirm()-Dialog (blockiert Fenster/Automatisierung): zweiter Klick innerhalb von 4 s bestätigt.
let ssStopArmed = 0;
function confirmStop() {
  if (Date.now() - ssStopArmed < 4000) { ssStopArmed = 0; return true; }
  ssStopArmed = Date.now(); $('ssMsg').textContent = tr('dash.stStopConfirm', 'Zum Beenden nochmal klicken.'); return false;
}
$('ssFail').onclick = () => ssAct(() => api('stats/fail', {}));
$('ssSave').onclick = () => ssAct(async () => {
  await api('stats/config', {
    enabled: $('ssEnabled').checked, autoStream: $('ssAutoStream').checked, failCommand: $('ssFailCommand').checked,
    announceChaosDeath: $('ssAnnounce').checked, chaosWindowSec: Number($('ssWindow').value), streakMin: Number($('ssStreak').value),
    overlayTheme: $('ssTheme').value,
    overlay: { bar: $('ssOvBar').checked, split: $('ssOvSplit').checked, torture: $('ssOvTorture').checked, popups: $('ssOvPopups').checked },
    failHotkey: $('ssHotkey').value.trim(), excludeModes: $('ssModes').value.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean),
  });
  $('ssSaveMsg').textContent = tr('dash.queueSaved', 'Gespeichert.');
}, 'ssSaveMsg');

async function refresh() {
  refreshStats();
  let s;
  try { s = await api('status'); }
  catch (e) {
    if (String(e.message).includes('Nicht erlaubt')) banner(tr('dash.noToken', 'Kein gültiger Zugangs-Token. Öffne das Dashboard über den Link im Terminal.'), true);
    else banner(tr('dash.noConnection', 'Keine Verbindung zu ChaosCore (läuft das Programm noch?).'), true);
    return;
  }
  // Fehler beim Zeichnen sind Programmfehler, keine Verbindungsprobleme: in der Konsole sichtbar lassen
  // (der Browser-Test schlägt dann an), statt sie als "Keine Verbindung" zu tarnen.
  try { paint(s); } catch (e) { console.error('Dashboard-Anzeige:', e); }
}
// Spart Ressourcen: Abfragen nur, solange das Fenster sichtbar ist (nicht minimiert oder verdeckt)
let timer = null;
function loop() {
  clearTimeout(timer);
  if (document.hidden) return;
  timer = setTimeout(async () => { await refresh(); loop(); }, 2000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) { refresh(); loop(); } else clearTimeout(timer); });
refresh(); loop();

