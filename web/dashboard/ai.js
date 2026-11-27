// Dashboard - KI-Assistent (Gemini): in zwei Schritten verbinden, Ton und Sprache, Beispiel,
// KI-Vorschlag für Stream-Titel und Tags (Karte "Stream-Infos").
let aiData = null;
const AI_TONES = { frech: 'dash.aiToneCheeky', episch: 'dash.aiToneEpic', trocken: 'dash.aiToneDry', witzig: 'dash.aiToneFunny' };

async function loadAi() {
  try { aiData = await api('ai'); } catch { return; }
  paintAi();
}

function paintAi() {
  const d = aiData;
  if (!d || !$('aiCard')) return;
  $('aiSetup').hidden = d.connected;
  $('aiOn').hidden = !d.connected;
  $('siAi').hidden = !d.connected;
  $('aiUploads').checked = d.settings.uploads;
  $('aiTone').value = d.settings.tone;
  $('aiLang').value = d.settings.lang;
  $('aiState').textContent = tr('dash.aiConnected', 'Gemini ist verbunden');
  if (upData) paintUploads();
}

function aiShowSample(r) {
  const box = $('aiSample');
  box.hidden = false;
  box.replaceChildren(
    el('div', { class: 'muted' }, tr('dash.aiSampleFor', 'Beispiel für „4 Kills in einer Runde auf Mirage“:')),
    el('b', {}, r.title),
    el('div', { class: 'ai-tags' }, r.hashtags.join(' ')),
    el('small', { class: 'muted' }, r.description));
}

async function aiBusy(btn, fn) {
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = tr('dash.aiWorking', 'KI denkt nach …');
  try { await fn(); } catch (e) { $('aiMsg').textContent = e.message; } finally { btn.disabled = false; btn.textContent = label; }
}

$('aiSaveKey').onclick = () => aiBusy($('aiSaveKey'), async () => {
  $('aiMsg').textContent = '';
  const key = $('aiKey').value.trim();
  if (!key) { $('aiMsg').textContent = tr('dash.aiNeedKey', 'Bitte zuerst den Schlüssel einfügen.'); return; }
  aiData = await api('ai/key', { key });
  $('aiKey').value = '';
  showToast(tr('dash.aiNowConnected', 'KI-Assistent ist verbunden ✔'));
  paintAi();
});
$('aiKey').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('aiSaveKey').click(); });
$('aiRemove').onclick = async () => {
  if (!confirm(tr('dash.aiRemoveConfirm', 'KI-Assistent entfernen? Der Schlüssel wird gelöscht.'))) return;
  try { aiData = await api('ai/remove', {}); $('aiSample').hidden = true; paintAi(); } catch (e) { $('aiMsg').textContent = e.message; }
};
async function saveAi() {
  try { aiData = await api('ai', { uploads: $('aiUploads').checked, tone: $('aiTone').value, lang: $('aiLang').value }); $('aiMsg').textContent = tr('dash.queueSaved', 'Gespeichert.'); paintAi(); } catch (e) { $('aiMsg').textContent = e.message; }
}
for (const id of ['aiUploads', 'aiTone', 'aiLang']) $(id).onchange = saveAi;
$('aiTry').onclick = () => aiBusy($('aiTry'), async () => { $('aiMsg').textContent = ''; aiShowSample(await api('ai/sample', {})); });

// Stream-Infos: Vorschlag in die Felder übernehmen - gespeichert wird erst mit "Bei Twitch speichern".
$('siAi').onclick = () => aiBusy($('siAi'), async () => {
  const tags = $('siTags').value.split(',').map((x) => x.trim()).filter(Boolean);
  try {
    const r = await api('ai/stream', { title: $('siTitle').value, category: $('siCat').value, tags });
    $('siTitle').value = r.title;
    if (r.tags.length) $('siTags').value = r.tags.join(', ');
    $('siMsg').textContent = tr('dash.siAiDone', 'Vorschlag eingesetzt - prüfen und dann „Bei Twitch speichern“.');
  } catch (e) { $('siMsg').textContent = e.message; }
});
document.querySelector('[data-nav="highlights"]').addEventListener('click', loadAi);
loadAi();
