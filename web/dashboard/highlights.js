// Dashboard - Highlights und Stream-Infos.
// Wird beim Ausliefern in dashboard.html eingesetzt (siehe src/web-pages.js): alle Teile laufen
// zusammen in EINEM Skript, in dieser Reihenfolge.
// ---- Highlights ----
const HL_TYPES = { chaos_death: ['dash.hlTChaos', 'Chaos-Tod'], clutch: ['dash.hlTClutch', 'Kills trotz Effekt'], bits_big: ['dash.hlTBits', 'Große Bits (ab 500)'], challenge: ['dash.hlTChallenge', 'Herausforderung'],
  streak: ['dash.hlTStreak', 'Kill-Serie'], pot: ['dash.hlTPot', 'Gemeinschaftstopf voll'], goal: ['dash.hlTGoal', 'Community-Ziel'], raid: ['dash.hlTRaid', 'Raid'] };
let hlData = null, hlFormPainted = false, catMap = new Map(), hlOwn = [];
function paintHlOwn() {
  $('hlOwnList').replaceChildren(...hlOwn.map((c, i) => {
    const del = el('button', { type: 'button', title: tr('dash.hlOwnDel', 'Entfernen') }, '×');
    del.onclick = async () => { const before = hlOwn; hlOwn = hlOwn.filter((_, j) => j !== i); if (!(await saveHl())) hlOwn = before; paintHlOwn(); };
    const t = c.type === 'any' ? tr('dash.hlOwnAny', 'Alle Momente') : tr(...(HL_TYPES[c.type] || ['', c.type]));
    return el('div', {}, el('span', { class: 'muted' }, t), el('span', {}, c.text), del);
  }));
}
$('hlOwnAdd').onclick = async () => {
  const text = $('hlOwnText').value.trim();
  if (text.length < 3) return;
  const before = hlOwn;
  hlOwn = [...hlOwn, { type: $('hlOwnType').value, text }];
  if (await saveHl()) { $('hlOwnText').value = ''; showHlPreview(); } else hlOwn = before;
  paintHlOwn();
};
$('hlOwnText').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('hlOwnAdd').click(); } };
async function showHlPreview() {
  try {
    const r = await api('highlights/preview', { tone: $('hlTone').value, customTitles: hlOwn });
    $('hlPreview').replaceChildren(...r.titles.map((x) => el('div', {}, x.title)));
  } catch (e) { $('hlMsg').textContent = e.message; }
}
$('hlPreviewBtn').onclick = showHlPreview;
async function loadHighlights(check = false) {
  try { hlData = await api('highlights'); } catch { return; }
  const s = hlData.settings;
  if (!hlFormPainted) {
    hlFormPainted = true;
    $('hlEnabled').checked = s.enabled; $('hlMarkers').checked = s.markers; $('hlClips').checked = s.clips; $('hlTone').value = s.tone; $('hlMin').value = s.minScore; $('hlClipMin').value = s.clipScore;
    $('hlTypes').replaceChildren(...Object.entries(HL_TYPES).map(([id, [k, f]]) => { const cb = el('input', { type: 'checkbox', value: id }); cb.checked = s.types[id] !== false; cb.onchange = saveHl; return el('label', {}, cb, ' ', tr(k, f)); }));
    $('hlOwnType').replaceChildren(el('option', { value: 'any' }, tr('dash.hlOwnAny', 'Alle Momente')), ...Object.entries(HL_TYPES).map(([id, [k, f]]) => el('option', { value: id }, tr(k, f))));
    hlOwn = (s.customTitles || []).slice();
    paintHlOwn();
  }
  let chk = { markers: hlData.scopes.markers, clips: hlData.scopes.clips, live: hlData.live, vods: undefined };
  if (check) { try { chk = await api('highlights/check', {}); } catch { /* egal */ } }
  const line = (ok, text, extra) => el('div', { class: 'hl-check ' + (ok === true ? 'ok' : ok === false ? 'bad' : '') }, el('span', {}, ok === true ? '✓' : ok === false ? '✗' : '·'), ' ', text, ...(extra ? [' ', extra] : []));
  const vodBtn = el('button', { type: 'button' }, tr('dash.hlVodOpen', 'Twitch-Einstellung öffnen'));
  vodBtn.onclick = () => setupApi('open', { url: `https://dashboard.twitch.tv/u/${encodeURIComponent(hlData.login || 'me')}/settings/stream` }).catch(() => {});
  $('hlChecks').replaceChildren(
    line(chk.markers, tr('dash.hlCkMarkers', 'Recht für Marker und Stream-Infos')),
    line(chk.clips, tr('dash.hlCkClips', 'Recht für Clips')),
    line(chk.vods, chk.vods === false ? tr('dash.hlCkVodsOff', 'Vergangene Übertragungen werden nicht gespeichert - ohne VODs gibt es keine Marker.') : tr('dash.hlCkVods', 'Vergangene Übertragungen (VODs) werden gespeichert'), chk.vods === false ? vodBtn : null),
    line(chk.live ? true : null, chk.live ? tr('dash.hlCkLive', 'Stream läuft - Marker und Clips sind aktiv') : tr('dash.hlCkOffline', 'Stream ist offline - Momente landen nur in der Liste')));
  $('hlLogin').hidden = chk.markers && chk.clips;
  paintHlRows();
}
function paintHlRows() {
  paintLiveHl();
  const rows = hlData?.list || [];
  if (!rows.length) { $('hlRows').replaceChildren(el('div', { class: 'muted' }, tr('dash.hlNone', 'Noch keine Highlights - sie entstehen automatisch im Stream.'))); return; }
  $('hlRows').replaceChildren(...rows.map((r) => {
    const copy = el('button', { type: 'button', title: tr('dash.hlCopy', 'Titel kopieren') }, '⧉');
    copy.onclick = () => navigator.clipboard?.writeText(r.title).then(() => { copy.textContent = '✓'; setTimeout(() => { copy.textContent = '⧉'; }, 1200); }).catch(() => {});
    const tools = [copy];
    if (r.editUrl) {
      const take = el('button', { type: 'button' }, tr('dash.hlTakeTitle', 'Titel übernehmen'));
      take.title = tr('dash.hlTakeTitleHint', 'Kopiert den Titel und öffnet den Clip bei Twitch (24 Stunden möglich).');
      take.onclick = () => { navigator.clipboard?.writeText(r.title).catch(() => {}); setupApi('open', { url: r.editUrl }).catch((e) => banner(e.message, true)); };
      tools.push(take);
    }
    if (r.clipUrl) tools.push(el('a', { href: r.clipUrl, target: '_blank', rel: 'noopener' }, tr('dash.hlClip', 'Clip')));
    if (r.videoFile) {
      const f = el('button', { type: 'button', title: r.videoFile }, '💾');
      f.onclick = () => navigator.clipboard?.writeText(r.videoFile).then(() => { f.textContent = '✓'; setTimeout(() => { f.textContent = '💾'; }, 1200); }).catch(() => {});
      tools.push(f);
      if (!r.shortFile) {
        const sh = el('button', { type: 'button', title: tr('dash.hlShortHint', 'Hochkant-Version für Shorts erstellen (braucht ffmpeg)') }, tr('dash.hlShort', 'Hochkant'));
        sh.onclick = () => { sh.disabled = true; api('highlights/short', { id: r.id }).then(() => loadHighlights(false)).catch((e) => { sh.disabled = false; banner(e.message, true); }); };
        tools.push(sh);
      } else tools.push(el('span', { class: 'muted', title: r.shortFile }, '📱'));
    }
    const badge = r.status === 'clip' ? '🎬' : r.status === 'marker' ? '📍' : '·';
    return el('div', { class: 'hl-row' },
      el('div', { class: 'hl-meta mono' }, r.vod || fmtTime(r.ts), ` · ${r.score} P. ${badge}`),
      el('div', { class: 'hl-title' }, r.title),
      el('div', { class: 'hl-tools' }, ...tools));
  }));
}
async function saveHl() {
  const types = Object.fromEntries([...$('hlTypes').querySelectorAll('input')].map((x) => [x.value, x.checked]));
  try {
    await api('highlights/settings', { enabled: $('hlEnabled').checked, markers: $('hlMarkers').checked, clips: $('hlClips').checked, tone: $('hlTone').value,
      minScore: Number($('hlMin').value), clipScore: Number($('hlClipMin').value), types, customTitles: hlOwn });
    $('hlMsg').textContent = tr('dash.queueSaved', 'Gespeichert.');
    if ($('hlPreview').childElementCount) showHlPreview();
    return true;
  } catch (e) { $('hlMsg').textContent = e.message; return false; }
}
for (const id of ['hlEnabled', 'hlMarkers', 'hlClips', 'hlTone', 'hlMin', 'hlClipMin']) $(id).onchange = saveHl;
for (const [id, fmt] of [['hlTxt', 'txt'], ['hlCsv', 'csv']]) {
  $(id).href = '#';
  $(id).onclick = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/highlights/export?format=' + fmt, { headers: { 'x-admin-token': token } });
      if (!res.ok) throw new Error(String(res.status));
      const u = URL.createObjectURL(await res.blob());
      const a = el('a', { href: u, download: `chaoscore-highlights.${fmt}` }); document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(u), 1000);
    } catch (err) { $('hlMsg').textContent = err.message; }
  };
}
// Neu anmelden, um fehlende Rechte zu ergänzen (Highlights, Ereignisse).
async function addScopesLogin(codeEl, after) {
  try {
    const v = await setupApi('login/start', {});
    codeEl.textContent = tr('dash.reloginCode', 'Öffne twitch.tv/activate und gib diesen Code ein:') + ' ' + (v.userCode || '');
    setupApi('open', { url: v.uri || 'https://www.twitch.tv/activate' }).catch(() => {});
    const t = setInterval(async () => {
      const x = await setupApi('login/status').catch(() => null);
      if (!x || x.state === 'waiting') return;
      clearInterval(t);
      codeEl.textContent = x.state === 'ok' ? tr('dash.reloginOk', 'Angemeldet - verbinde mit Twitch…') : (x.error || '');
      if (x.state === 'ok') { await api('twitch/reload', {}).catch(() => {}); setTimeout(after, 2500); }
    }, 2000);
  } catch (e) { codeEl.textContent = e.message; }
}
$('hlLoginBtn').onclick = () => addScopesLogin($('hlLoginCode'), () => loadHighlights(true));
$('evLoginBtn').onclick = () => addScopesLogin($('evLoginCode'), loadEvents);
// Stream-Infos
async function loadStreamInfo() {
  try {
    const r = await api('stream/info');
    $('siTitle').value = r.channel?.title || ''; $('siCat').value = r.channel?.game_name || ''; $('siTags').value = (r.channel?.tags || []).join(', ');
    if (r.channel?.game_id) catMap.set(r.channel.game_name, r.channel.game_id);
  } catch (e) { $('siMsg').textContent = e.message; }
}
let catTimer = null;
$('siCat').oninput = () => {
  clearTimeout(catTimer);
  catTimer = setTimeout(async () => {
    const q = $('siCat').value.trim();
    if (q.length < 2) return;
    try { const r = await api('stream/categories?q=' + encodeURIComponent(q)); for (const c of r.categories) catMap.set(c.name, c.id); $('siCatList').replaceChildren(...r.categories.map((c) => el('option', { value: c.name }))); } catch { /* egal */ }
  }, 300);
};
$('siSave').onclick = async () => {
  const tags = $('siTags').value.split(',').map((x) => x.trim()).filter(Boolean);
  const gameId = catMap.get($('siCat').value.trim());
  try { await api('stream/info', { title: $('siTitle').value, ...(gameId ? { gameId } : {}), tags }); $('siMsg').textContent = tr('dash.siSaved', 'Bei Twitch gespeichert.'); }
  catch (e) { $('siMsg').textContent = e.message; }
};
document.querySelector('[data-nav="highlights"]').addEventListener('click', () => { loadHighlights(true); loadStreamInfo(); });
setInterval(() => { if (document.querySelector('[data-section="highlights"].active, [data-section="highlights"].show')) loadHighlights(false); }, 15000);
