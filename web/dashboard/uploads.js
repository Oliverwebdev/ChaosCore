// Dashboard - Uploads zu YouTube (Shorts) und TikTok (Entwurf): Konten verbinden, Zeitpunkt und Grenzen,
// YouTube-Texte, eigene App-Daten und die Upload-Liste. Knöpfe pro Highlight: siehe upRowButtons().
let upData = null, upPainted = false, upPoll = null;
const UP_NAMES = { youtube: 'YouTube', tiktok: 'TikTok' };
const UP_STATUS = {
  queued: ['dash.upStQueued', 'wartet'], waiting: ['dash.upStWaiting', 'wartet aufs Stream-Ende'], uploading: ['dash.upStUploading', 'lädt hoch …'],
  done: ['dash.upStDone', 'fertig'], error: ['dash.upStError', 'Fehler'], canceled: ['dash.upStCanceled', 'abgebrochen'],
};

async function loadUploads() {
  try { upData = await api('uploads'); } catch { return; }
  paintUploads();
}

function paintUploads() {
  const d = upData;
  if (!d || !$('upCard')) return;
  const s = d.settings;
  if (!upPainted) {
    upPainted = true;
    $('upWhen').value = s.when; $('upMin').value = s.minScore; $('upMax').value = s.maxPerStream;
    $('upYtAuto').checked = s.youtube.auto; $('upTtAuto').checked = s.tiktok.auto;
    $('upPrivacy').value = s.youtube.privacy; $('upTags').value = s.youtube.hashtags; $('upDesc').value = s.youtube.description;
  }
  $('upAutoRow').hidden = $('upWhen').value === 'manual';
  for (const [pf, key] of [['youtube', 'Yt'], ['tiktok', 'Tt']]) {
    const a = d.accounts[pf];
    let text;
    if (a.connected) text = a.account && a.account !== UP_NAMES[pf] ? tr('dash.upConnectedAs', 'Verbunden als {acc}').replace('{acc}', a.account) : tr('dash.upConnected', 'Verbunden');
    else if (a.loggingIn) text = tr('dash.upWaitingLogin', 'Warte auf die Anmeldung im Browser …');
    else if (a.app === 'none') text = tr('dash.upNoApp', 'Noch keine App-Daten - siehe „Eigene App-Daten“ unten.');
    else text = tr('dash.upNotConnected', 'Nicht verbunden');
    if (pf === 'tiktok' && a.connected) text += ' · ' + tr('dash.upTtCount', '{n} von {max} Entwürfen in 24 h').replace('{n}', a.sent24h).replace('{max}', a.daily);
    if (a.ownApp) text += ' · ' + tr('dash.upOwnAppOn', 'eigene App');
    $(`up${key}State`).textContent = text;
    $(`up${key}`).classList.toggle('on', a.connected);
    $(`up${key}Login`).hidden = a.connected;
    $(`up${key}Login`).disabled = a.app === 'none';
    $(`up${key}Login`).textContent = a.loggingIn ? tr('dash.upRetryLogin', 'Erneut öffnen') : tr('dash.upConnect', 'Verbinden');
    $(`up${key}Logout`).hidden = !a.connected;
  }
  const notes = [tr('dash.upNoteYt', 'YouTube: Solange die ChaosCore-App von Google nicht geprüft ist, bleiben hochgeladene Videos privat - in YouTube Studio kannst du sie ansehen.'),
    tr('dash.upNoteTt', 'TikTok: Das Video landet als Entwurf in deiner TikTok-App (Benachrichtigungen) - veröffentlichen musst du es dort selbst. Höchstens 5 Entwürfe in 24 Stunden.')];
  $('upNotes').textContent = notes.join(' ');
  const q = d.queue || [];
  $('upQueue').replaceChildren(...(q.length ? q.slice(0, 12).map(upJobEl) : [el('div', { class: 'muted' }, tr('dash.upQueueEmpty', 'Noch nichts hochgeladen.'))]));
  const busy = q.some((j) => ['queued', 'uploading'].includes(j.status)) || d.accounts.youtube.loggingIn || d.accounts.tiktok.loggingIn;
  if (busy && !upPoll) upPoll = setInterval(() => { if (document.body.dataset.section === 'highlights') loadUploads(); }, 2500);
  if (!busy && upPoll) { clearInterval(upPoll); upPoll = null; }
  if (hlData) paintHlRows(); // Upload-Knöpfe pro Highlight aktualisieren
}

function upJobEl(j) {
  const st = tr(...(UP_STATUS[j.status] || ['', j.status]));
  const parts = [el('span', { class: 'tag' }, UP_NAMES[j.platform]), el('span', { class: 't' }, j.title),
    el('span', { class: 'st muted' }, st + (j.detail ? ` · ${j.detail}` : '') + (j.status === 'error' && j.error ? ` · ${j.error}` : ''))];
  if (j.url) parts.push(el('a', { href: j.url, target: '_blank', rel: 'noopener' }, tr('dash.upOpen', 'Ansehen')));
  if (j.status === 'done' && j.platform === 'tiktok') parts.push(el('span', { class: 'muted' }, tr('dash.upInInbox', 'in der TikTok-App')));
  if (['queued', 'waiting', 'error'].includes(j.status)) {
    const c = el('button', { type: 'button', class: 'ghostBtn' }, tr('dash.upCancel', 'Abbrechen'));
    c.onclick = () => api('uploads/cancel', { id: j.id }).then(loadUploads).catch((e) => banner(e.message, true));
    parts.push(c);
  }
  if (['error', 'canceled'].includes(j.status)) {
    const r = el('button', { type: 'button' }, tr('dash.upRetry', 'Nochmal'));
    r.onclick = () => api('uploads/retry', { id: j.id }).then(loadUploads).catch((e) => banner(e.message, true));
    parts.push(r);
  }
  return el('div', { class: 'up-job ' + (j.status === 'error' ? 'bad' : j.status === 'done' ? 'done' : '') }, ...parts);
}

// Knöpfe „↑ YouTube“ / „↑ TikTok“ in einer Highlight-Zeile (nur mit lokalem Clip und verbundenem Konto).
function upRowButtons(r) {
  if (!upData || (!r.videoFile && !r.shortFile)) return [];
  const out = [];
  for (const pf of ['youtube', 'tiktok']) {
    if (!upData.accounts[pf].connected) continue;
    const job = (upData.queue || []).find((j) => j.highlightId === r.id && j.platform === pf && j.status !== 'canceled');
    if (job) {
      const label = job.status === 'done' ? `✓ ${UP_NAMES[pf]}` : job.status === 'error' ? `✗ ${UP_NAMES[pf]}` : `… ${UP_NAMES[pf]}`;
      out.push(job.url ? el('a', { href: job.url, target: '_blank', rel: 'noopener', class: 'up-btn' }, label) : el('span', { class: 'muted up-btn', title: job.error || '' }, label));
      if (job.status !== 'error') continue;
    }
    const b = el('button', { type: 'button', class: 'up-btn', title: tr('dash.upBtnHint', 'Hochkant-Version hochladen') }, `↑ ${UP_NAMES[pf]}`);
    b.onclick = () => { b.disabled = true; api('uploads/enqueue', { id: r.id, platform: pf }).then(loadUploads).catch((e) => { b.disabled = false; banner(e.message, true); }); };
    out.push(b);
  }
  return out;
}

async function saveUploads() {
  $('upAutoRow').hidden = $('upWhen').value === 'manual';
  try {
    upData = await api('uploads', { when: $('upWhen').value, minScore: Number($('upMin').value), maxPerStream: Number($('upMax').value),
      youtube: { auto: $('upYtAuto').checked, privacy: $('upPrivacy').value, hashtags: $('upTags').value, description: $('upDesc').value },
      tiktok: { auto: $('upTtAuto').checked } });
    $('upMsg').textContent = tr('dash.queueSaved', 'Gespeichert.');
    paintUploads();
  } catch (e) { $('upMsg').textContent = e.message; }
}
for (const id of ['upWhen', 'upMin', 'upMax', 'upYtAuto', 'upTtAuto', 'upPrivacy', 'upTags', 'upDesc']) $(id).onchange = saveUploads;

async function upLogin(pf) {
  try {
    const r = await api('uploads/login', { platform: pf });
    const hint = $('upLoginHint');
    hint.hidden = false;
    const a = el('a', { href: r.url, target: '_blank', rel: 'noopener' }, tr('dash.upLoginLink', 'Anmeldeseite öffnen'));
    hint.replaceChildren(tr('dash.upLoginHint', 'Der Browser öffnet die Anmeldeseite von {p}. Nichts passiert? ').replace('{p}', UP_NAMES[pf]), a);
    loadUploads();
  } catch (e) { banner(e.message, true); }
}
$('upYtLogin').onclick = () => upLogin('youtube');
$('upTtLogin').onclick = () => upLogin('tiktok');
async function upLogout(pf) {
  if (!confirm(tr('dash.upLogoutConfirm', '{p} trennen? Der gespeicherte Zugang wird gelöscht.').replace('{p}', UP_NAMES[pf]))) return;
  try { await api('uploads/logout', { platform: pf }); $('upLoginHint').hidden = true; loadUploads(); } catch (e) { banner(e.message, true); }
}
$('upYtLogout').onclick = () => upLogout('youtube');
$('upTtLogout').onclick = () => upLogout('tiktok');
$('upAppSave').onclick = async () => {
  try { upData = await api('uploads/app', { platform: $('upAppPf').value, clientId: $('upAppId').value.trim(), clientSecret: $('upAppSecret').value.trim() }); $('upAppSecret').value = ''; $('upMsg').textContent = tr('dash.queueSaved', 'Gespeichert.'); paintUploads(); } catch (e) { $('upMsg').textContent = e.message; }
};
$('upAppClear').onclick = async () => {
  try { upData = await api('uploads/app', { platform: $('upAppPf').value, clientId: '' }); $('upAppId').value = ''; $('upAppSecret').value = ''; paintUploads(); } catch (e) { $('upMsg').textContent = e.message; }
};
document.querySelector('[data-nav="highlights"]').addEventListener('click', loadUploads);
loadUploads();
