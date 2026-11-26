// Dashboard - Zuschauer, Spielmodi, Raid/Follow/Abo/Hype Train, System-Aktionen, OBS, lokale Clips, Bits-Guthaben.
// Wird beim Ausliefern in dashboard.html eingesetzt (siehe src/web-pages.js): alle Teile laufen
// zusammen in EINEM Skript, in dieser Reihenfolge.
// ---- Zuschauer ----
async function loadViewers() {
  let r;
  try { r = await api('viewers?q=' + encodeURIComponent($('viewerSearch').value.trim())); } catch (e) { $('viewerMsg').textContent = e.message; return; }
  const act = (path, body, msg) => api(path, body).then(() => { $('viewerMsg').textContent = msg; loadViewers(); refresh(); }).catch((e) => { $('viewerMsg').textContent = e.message; });
  $('viewerResults').replaceChildren(...r.viewers.map((v) => {
    const blk = el('button', {}, v.blocked ? tr('dash.viewerUnblock', 'Entsperren') : tr('dash.viewerBlock', 'Sperren'));
    blk.onclick = () => act('viewers/block', { id: v.id, name: v.name, blocked: !v.blocked }, tr('dash.queueSaved', 'Gespeichert.'));
    const del = el('button', {}, tr('dash.viewerDelete', 'Daten löschen'));
    del.onclick = () => { if (confirm(tr('dash.viewerDeleteConfirm', 'Alle gespeicherten Daten von {user} löschen (Einlösungen, Punkte, Bestenlisten, Guthaben)? Das lässt sich nicht rückgängig machen.').replace('{user}', v.name))) act('viewers/delete', { id: v.id }, tr('dash.viewerDeleted', 'Gelöscht.')); };
    blk.className = del.className = 'ghostBtn';
    return el('div', { class: 'viewer-row' }, el('div', {}, el('b', {}, v.name), el('span', { class: 'muted' }, ` · ${v.count}× · ${new Date(v.last).toLocaleDateString(uiLocale())}`)), blk, del);
  }));
  $('viewerBlocked').replaceChildren(...(r.blocked.length ? r.blocked.map((v) => {
    const un = el('button', { style: 'margin:4px 6px 0 0' }, `${v.name || v.id} ✕`);
    un.title = tr('dash.viewerUnblock', 'Entsperren');
    un.onclick = () => act('viewers/block', { id: v.id, name: v.name, blocked: false }, tr('dash.queueSaved', 'Gespeichert.'));
    return un;
  }) : [tr('dash.viewersNoneBlocked', 'niemand')]));
}
let viewerTimer = null;
$('viewerSearch').oninput = () => { clearTimeout(viewerTimer); viewerTimer = setTimeout(loadViewers, 300); };
setTimeout(loadViewers, 1500);
// ---- Spielmodi ----
const MODE_NAMES = { casual: ['Casual', 'Casual'], competitive: ['Competitive', 'Competitive'], premier: ['Premier', 'Premier'], scrimcomp2v2: ['Wingman', 'Wingman'], deathmatch: ['Deathmatch', 'Deathmatch'], gungameprogressive: ['Arms Race', 'Arms Race'], gungametrbomb: ['Demolition', 'Demolition'], custom: ['Eigene Server', 'Custom servers'] };
const modeName = (m) => (MODE_NAMES[m] ? MODE_NAMES[m][document.documentElement.lang === 'en' ? 1 : 0] : m);
let mlKey = '';
function paintModeLock(s) {
  const ml = s.modeLock;
  $('modeLockCard').style.display = ml && s.game?.supportsGsi ? '' : 'none';
  if (!ml) return;
  const key = JSON.stringify([ml.enabled, ml.blocked, document.documentElement.lang]);
  if (key === mlKey) return;
  mlKey = key;
  $('mlEnabled').checked = ml.enabled;
  $('mlModes').replaceChildren(...ml.modes.map((m) => {
    const cb = el('input', { type: 'checkbox', value: m }); cb.checked = ml.blocked.includes(m);
    cb.onchange = saveModeLock;
    return el('label', {}, cb, ' ', tr('dash.mlBlock', 'sperren:'), ' ', el('b', {}, modeName(m)));
  }));
}
async function saveModeLock() {
  const blocked = [...$('mlModes').querySelectorAll('input:checked')].map((x) => x.value);
  try { await api('modelock', { enabled: $('mlEnabled').checked, blocked }); $('mlMsg').textContent = tr('dash.queueSaved', 'Gespeichert.'); mlKey = ''; refresh(); }
  catch (e) { $('mlMsg').textContent = e.message; }
}
$('mlEnabled').onchange = saveModeLock;
// ---- Raid/Follow/Abo/Hype Train ----
const EV_NAMES = { raid: ['dash.evRaid', 'Raid'], follow: ['dash.evFollow', 'Follow'], sub: ['dash.evSub', 'Abo (auch verschenkt)'], hype: ['dash.evHype', 'Hype Train'] };
const EV_MIN = { raid: ['dash.evMinRaid', 'ab Zuschauern im Raid'], follow: null, sub: ['dash.evMinSub', 'ab Anzahl Abos (bei Geschenken)'], hype: ['dash.evMinHype', 'ab Level'] };
let evData = null;
async function loadEvents() {
  try { evData = await api('events'); } catch { return; }
  paintEvents();
}
function paintEvents() {
  const d = evData;
  if (!d) return;
  $('evRows').replaceChildren(...Object.entries(EV_NAMES).map(([k, [key, fb]]) => {
    const c = d.settings[k];
    const on = el('input', { type: 'checkbox' }); on.checked = c.enabled;
    const sel = el('select', { class: 'ss-input' }, el('option', { value: '' }, tr('dash.evRandom', 'Zufälliger Effekt')), ...d.actionChoices.map((a) => el('option', { value: a.id }, a.title)));
    sel.value = c.actionId || '';
    const test = el('button', { type: 'button' }, tr('dash.evTest', 'Testen'));
    test.onclick = () => api('events/test', { kind: k }).then(() => { $('evMsg').textContent = tr('dash.evTested', 'Test im Overlay gezeigt.'); }).catch((e) => { $('evMsg').textContent = e.message; });
    const cd = el('input', { type: 'number', class: 'ss-input', min: '0', max: '86400', value: String(c.cooldownSec) });
    const min = el('input', { type: 'number', class: 'ss-input', min: '1', max: '100000', value: String(c.min) });
    const save = () => saveEvent(k, { enabled: on.checked, actionId: sel.value || null, cooldownSec: Number(cd.value), min: Number(min.value) });
    on.onchange = save; sel.onchange = save; cd.onchange = save; min.onchange = save;
    const more = el('details', {}, el('summary', { class: 'muted' }, tr('dash.moreSettings', 'Mehr Einstellungen')),
      el('div', { class: 'row2', style: 'margin-top:6px' },
        el('div', {}, el('label', { class: 'muted' }, tr('dash.evCooldown', 'Cooldown in Sekunden')), cd),
        EV_MIN[k] ? el('div', {}, el('label', { class: 'muted' }, tr(...EV_MIN[k])), min) : null));
    const sub = d.subs?.[k];
    const warn = c.enabled && !d.scopes[k] ? tr('dash.evNoScope', 'Fehlendes Recht - bitte unten neu anmelden.')
      : c.enabled && typeof sub === 'string' ? tr('dash.evSubFail', 'Twitch hat das Abo abgelehnt:') + ' ' + sub : null;
    return el('div', { class: 'ev-row' },
      el('label', { style: 'display:flex;align-items:center;gap:8px' }, el('span', { class: 'switch' }, on, el('span')), el('b', {}, tr(key, fb))),
      sel, test, more, warn ? el('div', { class: 'ev-warn' }, warn) : null);
  }));
  $('evLogin').hidden = Object.entries(d.settings).every(([k, c]) => !c.enabled || d.scopes[k]);
}
async function saveEvent(kind, patch) {
  try {
    const r = await api('events', { [kind]: patch });
    evData.settings = r.settings; evData.subs = r.subs || evData.subs;
    $('evMsg').textContent = tr('dash.queueSaved', 'Gespeichert.');
    paintEvents();
  } catch (e) { $('evMsg').textContent = e.message; }
}
document.querySelector('[data-nav="settings"]').addEventListener('click', loadEvents);
setTimeout(loadEvents, 1200);

// ---- System-Aktionen: Bestätigung / Countdown (oben, überall sichtbar) ----
let sysPendingId = null, lastObs = null;
function paintSysBox(st) {
  const sys = st?.system || {};
  lastObs = st?.obs || lastObs;
  const p = sys.pending, c = sys.countdown;
  $('sysBox').hidden = !p && !c;
  $('sysYes').hidden = !p; $('sysNo').hidden = !p; $('sysAbort').hidden = !c;
  sysPendingId = p ? p.id : null;
  if (p) $('sysBoxText').textContent = tr('dash.sysAsk', '{user} löst „{title}“ aus - soll ChaosCore jetzt {what}?').replace('{user}', p.user).replace('{title}', p.title).replace('{what}', p.what);
  else if (c) $('sysBoxText').textContent = tr('dash.sysCountdown', 'Stream endet in {s} Sekunden (ausgelöst von {user}).').replace('{s}', Math.max(0, Math.ceil((c.endsAt - Date.now()) / 1000))).replace('{user}', c.user);
  if (c) { clearTimeout(paintSysBox.t); paintSysBox.t = setTimeout(() => paintSysBox(st), 1000); }
}
$('sysYes').onclick = () => api('system/answer', { id: sysPendingId, yes: true }).catch((e) => banner(e.message, true));
$('sysNo').onclick = () => api('system/answer', { id: sysPendingId, yes: false }).catch((e) => banner(e.message, true));
$('sysAbort').onclick = () => api('system/abort', {}).catch((e) => banner(e.message, true));

// ---- OBS-Verbindung + lokale Clips ----
let obsData = null, lcPainted = false;
const OBS_STATUS = { off: ['dash.obsOff', 'aus'], connecting: ['dash.obsConnecting', 'verbinde…'], connected: ['dash.obsConnected', 'verbunden'], auth_failed: ['dash.obsAuthFailed', 'Passwort falsch'], error: ['dash.obsError', 'nicht erreichbar - läuft OBS?'] };
async function loadObs() {
  try { obsData = await api('obs'); } catch { return; }
  const o = obsData;
  if (!loadObs.painted) {
    loadObs.painted = true;
    $('obsEnabled').checked = o.settings.enabled; $('obsHost').value = o.settings.host; $('obsPort').value = o.settings.port;
    $('obsPw').placeholder = o.hasPassword ? '••••••' : '';
  }
  $('obsState').textContent = tr(...(OBS_STATUS[o.status] || ['', o.status])) + (o.version ? ` · OBS ${o.version}` : '');
  loadLocalClips();
}
$('obsSave').onclick = async () => {
  const body = { enabled: $('obsEnabled').checked, host: $('obsHost').value.trim(), port: Number($('obsPort').value) };
  if ($('obsPw').value) body.password = $('obsPw').value;
  try { await api('obs', body); $('obsPw').value = ''; setTimeout(loadObs, 1200); } catch (e) { $('obsState').textContent = e.message; }
};
$('obsEnabled').onchange = () => $('obsSave').click();
async function loadLocalClips() {
  let d;
  try { d = await api('localclips'); } catch { return; }
  const c = d.settings;
  if (!lcPainted) {
    lcPainted = true;
    $('lcEnabled').checked = c.enabled; $('lcMin').value = c.minScore; $('lcAfter').value = c.afterSec; $('lcFolder').value = c.folder; $('lcPerStream').checked = c.perStream; $('lcShorts').checked = c.shorts; $('lcFfmpeg').value = c.ffmpeg; $('lcCrop').value = c.shortsCrop; $('lcLogo').value = c.logoPath; $('lcShortsWhen').value = c.shortsWhen || 'now';
  }
  // Puffer-Länge (= Sekunden VOR dem Moment) steht in OBS; ohne Verbindung nicht einstellbar
  if (document.activeElement !== $('lcReplay')) $('lcReplay').value = d.replaySeconds ?? '';
  $('lcReplay').disabled = d.replaySeconds === null || d.replaySeconds === undefined;
  $('lcReplay').title = $('lcReplay').disabled ? tr('dash.lcReplayNoObs', 'Erst mit OBS verbinden') : '';
  // Shorts: höchstens 59 s - Puffer + Nachlauf länger? Dann wird gekürzt (Hinweis statt Überraschung).
  const total = (Number(d.replaySeconds) || 0) + (Number(c.afterSec) || 0);
  $('lcTooLong').hidden = !(d.replaySeconds && total > 59);
  $('lcTooLong').textContent = tr('dash.lcTooLong', 'Puffer ({b} s) + danach ({a} s) ist länger als 59 Sekunden - die Hochkant-Version wird auf 59 s gekürzt.').replace('{b}', d.replaySeconds).replace('{a}', c.afterSec);
  const line = (ok, text, extra) => el('div', { class: 'hl-check ' + (ok === true ? 'ok' : ok === false ? 'bad' : '') }, el('span', {}, ok === true ? '✓' : ok === false ? '✗' : '·'), ' ', text, ...(extra ? [' ', extra] : []));
  const startBtn = el('button', { type: 'button' }, tr('dash.lcStartBuffer', 'Puffer starten'));
  startBtn.onclick = () => api('obs/replay/start', {}).then(loadObs).catch((e) => { $('lcMsg').textContent = e.message; });
  const conn = d.obs.status === 'connected';
  $('lcState').replaceChildren(
    line(c.enabled ? true : null, c.enabled ? tr('dash.lcOnOk', 'Lokale Clips sind an') : tr('dash.lcOnNo', 'Lokale Clips sind aus - es entstehen nur Twitch-Clips (Schalter oben)')),
    line(conn, conn ? tr('dash.lcObsOk', 'OBS verbunden') : tr('dash.lcObsNo', 'OBS nicht verbunden (unten einrichten)')),
    line(conn ? d.obs.replayActive === true : null, !conn ? tr('dash.lcBufferUnknown', 'Wiederholungspuffer: prüfbar, sobald OBS verbunden ist') : d.obs.replayActive === false ? tr('dash.lcBufferOff', 'Wiederholungspuffer ist aus - in OBS unter Einstellungen → Ausgabe aktivieren und starten') : tr('dash.lcBufferOn', 'Wiederholungspuffer läuft'), conn && d.obs.replayActive === false ? startBtn : null),
    ...(c.shorts ? [line(d.ffmpeg, d.ffmpeg ? tr('dash.lcFfmpegOk', 'ffmpeg gefunden') : tr('dash.lcFfmpegNo', 'ffmpeg nicht gefunden - Hochkant-Versionen bleiben aus'), d.ffmpeg ? null : ffInstallBtn(d.ffmpegInstall))] : []));
  paintFfmpeg(d);
}
// ---- ffmpeg auf Knopfdruck: lädt die geprüfte Version in den ChaosCore-Datenordner ----
let ffPoll = null;
const FF_BUSY = ['downloading', 'verifying', 'extracting'];
function ffInstallBtn(fi) {
  const b = el('button', { type: 'button' }, tr('dash.ffInstall', 'ffmpeg installieren ({mb} MB)').replace('{mb}', fi?.sizeMb ?? '?'));
  b.onclick = startFfmpegInstall;
  b.disabled = FF_BUSY.includes(fi?.state);
  return b;
}
async function startFfmpegInstall() {
  try { const r = await api('ffmpeg/install', {}); paintFfmpeg({ ffmpegInstall: r.ffmpegInstall }); } catch (e) { $('ffState').textContent = e.message; return; }
  if (!ffPoll) startFfmpegPoll();
}
function paintFfmpeg(d) {
  const fi = d.ffmpegInstall;
  if (!fi) return;
  const mb = (n) => (n / 1e6).toFixed(0);
  const text = {
    downloading: () => tr('dash.ffDownloading', 'Lädt … {got} von {all} MB').replace('{got}', mb(fi.received)).replace('{all}', mb(fi.total || fi.sizeMb * 1e6)),
    verifying: () => tr('dash.ffVerifying', 'Prüfsumme wird geprüft …'),
    extracting: () => tr('dash.ffExtracting', 'Wird entpackt …'),
    done: () => tr('dash.ffDone', 'ffmpeg {v} ist installiert.').replace('{v}', fi.version),
    error: () => tr('dash.ffError', 'Nicht installiert: {msg}').replace('{msg}', fi.error),
    idle: () => (fi.installed ? tr('dash.ffDone', 'ffmpeg {v} ist installiert.').replace('{v}', fi.version) : (d.ffmpeg ? tr('dash.lcFfmpegOk', 'ffmpeg gefunden') : tr('dash.ffIdle', 'Noch kein ffmpeg. Ein Klick lädt es von GitHub (Version {v}, {lic}) und prüft die Datei, bevor sie benutzt wird.').replace('{v}', fi.version).replace('{lic}', fi.license))),
  }[fi.state]?.() || '';
  $('ffState').textContent = text;
  $('ffInstall').hidden = !!d.ffmpeg && fi.state !== 'error' || fi.installed;
  $('ffInstall').disabled = FF_BUSY.includes(fi.state);
  $('ffInstall').textContent = tr('dash.ffInstall', 'ffmpeg installieren ({mb} MB)').replace('{mb}', fi.sizeMb);
  $('ffRemove').hidden = !fi.installed || FF_BUSY.includes(fi.state);
  if (FF_BUSY.includes(fi.state) && !ffPoll) startFfmpegPoll();
}
function startFfmpegPoll() {
  ffPoll = setInterval(async () => {
    let d; try { d = await api('localclips'); } catch { return; }
    if (!FF_BUSY.includes(d.ffmpegInstall.state)) { clearInterval(ffPoll); ffPoll = null; loadLocalClips(); } else paintFfmpeg(d);
  }, 1000);
}
$('ffInstall').onclick = startFfmpegInstall;
$('ffRemove').onclick = async () => {
  if (!confirm(tr('dash.ffRemoveConfirm', 'Das von ChaosCore geladene ffmpeg wieder löschen?'))) return;
  try { await api('ffmpeg/install', { remove: true }); } catch (e) { $('ffState').textContent = e.message; }
  loadLocalClips();
};
async function saveLc() {
  try {
    await api('localclips', { enabled: $('lcEnabled').checked, minScore: Number($('lcMin').value), afterSec: Number($('lcAfter').value), folder: $('lcFolder').value.trim(), perStream: $('lcPerStream').checked, shorts: $('lcShorts').checked, ffmpeg: $('lcFfmpeg').value.trim(), shortsCrop: $('lcCrop').value, logoPath: $('lcLogo').value.trim(), shortsWhen: $('lcShortsWhen').value });
    $('lcMsg').textContent = tr('dash.queueSaved', 'Gespeichert.');
    loadLocalClips();
  } catch (e) { $('lcMsg').textContent = e.message; }
}
for (const id of ['lcEnabled', 'lcMin', 'lcAfter', 'lcFolder', 'lcPerStream', 'lcShorts', 'lcFfmpeg', 'lcCrop', 'lcLogo', 'lcShortsWhen']) $(id).onchange = saveLc;
$('lcReplay').onchange = () => api('obs/replay/length', { seconds: Number($('lcReplay').value) })
  .then((r) => { $('lcMsg').textContent = tr('dash.lcReplaySaved', 'In OBS gespeichert: {s} Sekunden vor dem Moment.').replace('{s}', r.seconds); })
  .catch((e) => { $('lcMsg').textContent = e.message; });

// ---- System-Aktionen: Einstellungen ----
let sysData = null, sysObs = null;
async function loadSystem() {
  try { sysData = await api('system'); } catch { return; }
  const d = sysData;
  $('sysEnabled').checked = d.settings.enabled;
  $('sysBody').hidden = !d.settings.enabled;
  $('sysConfirm').checked = d.settings.confirm;
  if (d.settings.enabled) { try { sysObs = await api('obs'); } catch { sysObs = null; } }
  const title = (id) => d.actionChoices.find((a) => a.id === id)?.title || id;
  $('sysLinks').replaceChildren(...Object.entries(d.linked).map(([id, what]) => {
    const del = el('button', { type: 'button', title: tr('dash.hlOwnDel', 'Entfernen') }, '×');
    del.onclick = () => saveSystem({ link: { actionId: id, kind: 'none' } });
    return el('div', {}, el('span', {}, el('b', {}, title(id))), el('span', {}, '→ ', what, ` · ${d.settings.links[id].cooldownSec}s`), del);
  }));
  if (!Object.keys(d.linked).length) $('sysLinks').replaceChildren(el('div', { class: 'muted' }, tr('dash.sysNoLinks', 'Noch keine Verknüpfung.')));
  $('sysAction').replaceChildren(...d.actionChoices.map((a) => el('option', { value: a.id }, a.title)));
  const scenes = sysObs?.scenes || [];
  $('sysScene').replaceChildren(...(scenes.length ? scenes.map((x) => el('option', { value: x.name }, x.name)) : [el('option', { value: '' }, tr('dash.sysNoObs', 'OBS nicht verbunden'))]));
  paintSysSources();
  $('sysProgram').replaceChildren(...(d.settings.programs.length ? d.settings.programs.map((p) => el('option', { value: p.id }, p.name)) : [el('option', { value: '' }, tr('dash.sysNoPrograms', 'erst unten ein Programm anlegen'))]));
  $('sysProgProfile').replaceChildren(el('option', { value: '' }, tr('dash.sysProfileKeep', 'Spielprofil nicht ändern')), ...d.profiles.map((p) => el('option', { value: p }, tr('dash.sysProfileTo', 'Profil: {p}').replace('{p}', p))));
  $('sysPrograms').replaceChildren(...d.settings.programs.map((p) => {
    const start = el('button', { type: 'button' }, tr('dash.sysStart', 'Starten'));
    start.onclick = () => api('system/start', { id: p.id }).then(() => { $('sysMsg').textContent = tr('dash.sysStarted', 'Gestartet.'); }).catch((e) => { $('sysMsg').textContent = e.message; });
    const del = el('button', { type: 'button', title: tr('dash.hlOwnDel', 'Entfernen') }, '×');
    del.onclick = () => saveSystem({ removeProgram: p.id });
    return el('div', {}, el('span', {}, el('b', {}, p.name)), el('span', { class: 'mono muted' }, p.target, p.profile ? ` · ${p.profile}` : ''), start, del);
  }));
  paintSysForm();
}
function paintSysSources() {
  const sc = (sysObs?.scenes || []).find((x) => x.name === $('sysScene').value);
  $('sysSource').replaceChildren(...(sc?.sources || []).map((n) => el('option', { value: n }, n)));
}
function paintSysForm() {
  const k = $('sysKind').value;
  $('sysScene').hidden = !(k === 'scene' || k === 'source');
  $('sysSource').hidden = k !== 'source'; $('sysMode').hidden = k !== 'source';
  $('sysSeconds').hidden = k !== 'endStream';
  $('sysProgram').hidden = k !== 'game';
}
async function saveSystem(patch) {
  try { await api('system', patch); $('sysMsg').textContent = tr('dash.queueSaved', 'Gespeichert.'); await loadSystem(); return true; }
  catch (e) { $('sysMsg').textContent = e.message; return false; }
}
$('sysKind').onchange = paintSysForm;
$('sysScene').onchange = paintSysSources;
$('sysEnabled').onchange = () => saveSystem({ enabled: $('sysEnabled').checked });
$('sysConfirm').onchange = () => saveSystem({ confirm: $('sysConfirm').checked });
$('sysLinkAdd').onclick = () => {
  const k = $('sysKind').value;
  const link = { actionId: $('sysAction').value, kind: k, cooldownSec: Number($('sysCooldown').value) };
  if (k === 'scene' || k === 'source') link.scene = $('sysScene').value;
  if (k === 'source') { link.source = $('sysSource').value; link.mode = $('sysMode').value; }
  if (k === 'endStream') link.seconds = Number($('sysSeconds').value);
  if (k === 'game') link.programId = $('sysProgram').value;
  saveSystem({ link });
};
$('sysProgAdd').onclick = async () => {
  const ok = await saveSystem({ program: { name: $('sysProgName').value.trim(), target: $('sysProgTarget').value.trim(), profile: $('sysProgProfile').value || null } });
  if (ok) { $('sysProgName').value = ''; $('sysProgTarget').value = ''; }
};
document.querySelector('[data-nav="settings"]').addEventListener('click', loadSystem);
// ---- Bits-Guthaben ----
let creditKey = '';
function paintCredit(s) {
  const list = s.state.bitsCredit || [];
  if (s.bitsCredit) { $('creditAuto').checked = s.bitsCredit.autoResume; $('creditAnnounce').checked = s.bitsCredit.announce; }
  const key = JSON.stringify(list.map((c) => [c.id, c.remainingMs, c.auto, c.reason]));
  if (key === creditKey) return;
  creditKey = key;
  if (!list.length) { $('creditList').replaceChildren(el('div', { class: 'muted' }, tr('dash.creditNone', 'Kein offenes Guthaben - alles bezahlte Chaos ist gelaufen.'))); return; }
  $('creditList').replaceChildren(...list.map((c) => {
    const secs = Math.ceil(c.remainingMs / 1000);
    const amount = c.kind === 'menu' ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} ${tr('dash.bmMinShort', 'Min.')}` : tr('dash.creditOnce', 'einmal');
    const go = el('button', {}, tr('dash.creditResume', 'Jetzt einreihen'));
    go.onclick = () => api('bits/credit/resume', { id: c.id }).then(refresh).catch((e) => banner(e.message, true));
    const drop = el('button', {}, tr('dash.creditDrop', 'Verwerfen'));
    drop.onclick = () => { if (confirm(tr('dash.creditDropConfirm', 'Guthaben von {user} wirklich verwerfen? Die Bits sind bezahlt und lassen sich nicht erstatten.').replace('{user}', c.user))) api('bits/credit/drop', { id: c.id }).then(refresh).catch((e) => banner(e.message, true)); };
    return el('div', { class: 'credit-row' },
      el('div', {}, el('b', {}, c.user), ' · ', c.title, ' · ', el('b', {}, amount)),
      el('div', { class: 'muted', style: 'font-size:12px' }, `${c.reason || ''} · ${c.auto ? tr('dash.creditAutoBadge', 'läuft von selbst weiter') : tr('dash.creditManualBadge', 'wartet auf dich')}`),
      el('div', { style: 'display:flex;gap:8px;margin-top:6px' }, go, drop));
  }));
}
for (const id of ['creditAuto', 'creditAnnounce']) {
  $(id).onchange = () => api('bits/credit/settings', { autoResume: $('creditAuto').checked, announce: $('creditAnnounce').checked }).catch((e) => banner(e.message, true));
}

// ---- Erst-Test in echtem CS2 (Valve) ----
// Jeder Schritt: was zu tun ist, optional ein Knopf, der den passenden Effekt echt auslöst (5 s Vorlauf),
// und zwei Antworten. Gespeichert wird nur auf diesem PC (Server: /api/valvetest).
const VT_STEPS = {
  gsi: { t: ['dash.vtGsiT', 'CS2 meldet sich bei ChaosCore'], d: ['dash.vtGsiD', 'Starte CS2. Oben muss „CS2 verbunden“ stehen. Klappt das nicht: Einrichtung → Spielzustand.'], auto: true },
  offline_basic: { t: ['dash.vtBasicT', 'Offline mit Bots: ein harmloser Effekt'], d: ['dash.vtBasicD', 'In CS2: Spielen → Training → Mit Bots spielen. Dann hier „Echt testen“ und innerhalb von 5 Sekunden ins Spiel wechseln. Springt deine Figur?'], fx: 'jump_spam' },
  offline_restore: { t: ['dash.vtRestoreT', 'Offline: Effekt mit Rückstellung'], d: ['dash.vtRestoreD', 'Das Fadenkreuz wird 15 Sekunden riesig. Kommt danach dein normales Fadenkreuz zurück?'], fx: 'crosshair_big' },
  offline_block: { t: ['dash.vtBlockT', 'Offline: Tasten-Sperre'], d: ['dash.vtBlockD', 'Für 5 Sekunden kannst du nicht laufen. Kannst du danach wieder ganz normal laufen?'], fx: 'movement_lock' },
  panic: { t: ['dash.vtPanicT', 'Not-Aus mitten im Effekt'], d: ['dash.vtPanicD', 'Starte „WASD invertiert“ und drücke während des Effekts den Not-Aus (Knopf oder Tastenkürzel). Ist sofort alles wieder normal?'], fx: 'wasd_invert' },
  community: { t: ['dash.vtCommunityT', 'Community-Server'], d: ['dash.vtCommunityD', 'Auf einem Community-Server (z. B. Deathmatch) zwei, drei Effekte laufen lassen. Kein Kick, keine Warnung?'] },
  casual: { t: ['dash.vtCasualT', 'Offizielles Casual'], d: ['dash.vtCasualD', 'Erst wenn alles davor klappt: eine Runde Casual mit einem harmlosen Effekt. Kein Kick, keine Meldung? Dann bist du bereit.'] },
};
let vtData = null;
async function loadValveTest() {
  try { vtData = await api('valvetest'); } catch { return; }
  paintValveTest();
}
function paintValveTest(s = lastStatus) {
  if (!vtData) return;
  const res = vtData.results || {};
  $('vtList').replaceChildren(...vtData.steps.map((id, i) => {
    const st = VT_STEPS[id];
    const r = st.auto ? (s?.gsi?.connected ? { result: 'ok' } : res[id]) : res[id];
    const mark = el('span', { class: 'vt-mark ' + (r?.result || '') }, r?.result === 'ok' ? '✓' : r?.result === 'bad' ? '✗' : String(i + 1));
    const acts = [];
    if (st.fx) {
      const b = el('button', { type: 'button' }, tr('dash.vtRun', 'Echt testen'));
      b.onclick = () => { if (confirm(tr('dash.realConfirm', 'Echt senden? Wechsle in den nächsten 5 Sekunden ins Spiel.'))) test(st.fx, false); };
      acts.push(b);
    }
    if (!st.auto) {
      const ok = el('button', { type: 'button', class: 'ghostBtn', 'aria-pressed': String(r?.result === 'ok') }, tr('dash.vtOk', 'Klappt'));
      ok.onclick = () => saveValveTest(id, r?.result === 'ok' ? null : 'ok');
      const bad = el('button', { type: 'button', class: 'ghostBtn', 'aria-pressed': String(r?.result === 'bad') }, tr('dash.vtBad', 'Problem'));
      bad.onclick = () => { const note = prompt(tr('dash.vtNote', 'Was ist passiert? (kurz, hilft bei der Fehlersuche)'), r?.note || '') ; if (note !== null) saveValveTest(id, 'bad', note); };
      acts.push(ok, bad);
    }
    return el('div', { class: 'vt-step' }, mark, el('div', {}, el('b', {}, tr(...st.t)), el('small', {}, tr(...st.d)), r?.note ? el('small', { class: 'vt-note' }, r.note) : null), el('div', { class: 'vt-acts' }, ...acts));
  }));
}
async function saveValveTest(id, result, note = '') {
  try { const r = await api('valvetest', { id, result, note }); vtData.results = r.results; paintValveTest(); }
  catch (e) { $('vtMsg').textContent = e.message; }
}
$('vtReset').onclick = async () => { if (!confirm(tr('dash.vtResetConfirm', 'Alle Häkchen zurücksetzen?'))) return; try { const r = await api('valvetest', { reset: true }); vtData.results = r.results; paintValveTest(); } catch (e) { $('vtMsg').textContent = e.message; } };
$('vtCopy').onclick = () => {
  const res = vtData?.results || {};
  const lines = (vtData?.steps || []).map((id) => {
    const r = VT_STEPS[id].auto && lastStatus?.gsi?.connected ? { result: 'ok' } : res[id];
    return `${r?.result === 'ok' ? '✓' : r?.result === 'bad' ? '✗' : '·'} ${tr(...VT_STEPS[id].t)}${r?.note ? ` - ${r.note}` : ''}`;
  });
  const text = `ChaosCore ${lastStatus?.version || ''} · CS2-Test\n${lines.join('\n')}`;
  navigator.clipboard?.writeText(text).then(() => { $('vtMsg').textContent = tr('dash.vtCopied', 'Kopiert.'); }).catch(() => { $('vtMsg').textContent = text; });
};
document.querySelector('[data-nav="settings"]').addEventListener('click', loadValveTest);
if (document.body.dataset.section === 'settings') { loadValveTest(); loadSystem(); loadEvents(); }
