// Dashboard - KI-Assistent: Anbieter wählen -> Schlüssel einfügen -> fertig. Danach Modell, automatische
// Analyse, Vorschlag oder direkt eintragen, Uploads, Ton/Sprache. Vorschläge pro Highlight: aiRowParts().
let aiData = null, aiPick = '', aiPoll = null, aiChanging = false;
const AI_INFO = {
  gemini: { badge: ['dash.aiBadgeGemini', 'kostenloses Kontingent · schaut Videos'], rec: true, ph: 'AIza…' },
  openai: { badge: ['dash.aiBadgeOpenai', 'Guthaben nötig · sieht Standbilder'], ph: 'sk-…' },
  anthropic: { badge: ['dash.aiBadgeAnthropic', 'Guthaben nötig · sieht Standbilder'], ph: 'sk-ant-…' },
  compatible: { badge: ['dash.aiBadgeOther', 'OpenRouter, Groq, Mistral, LM Studio, Ollama …'], ph: ['dash.aiKeyOptional', 'Schlüssel (bei lokalen KIs leer lassen)'] },
};
const AI_SEES = { video: ['dash.aiSeesVideo', 'schaut sich das Video an'], images: ['dash.aiSeesImages', 'sieht Standbilder aus dem Clip'], text: ['dash.aiSeesText', 'kennt nur die Spieldaten (kein Bild)'] };

async function loadAi() {
  try { aiData = await api('ai'); } catch { return; }
  paintAi();
}

function aiProviderName(id) { return id === 'compatible' ? tr('dash.aiOther', 'Andere (OpenAI-kompatibel)') : (aiData?.providers.find((p) => p.id === id)?.name || id); }

function paintAi() {
  const d = aiData;
  if (!d || !$('aiCard')) return;
  const showSetup = !d.connected || aiChanging;
  $('aiSetup').hidden = !showSetup;
  $('aiOn').hidden = showSetup;
  $('siAi').hidden = !d.connected;
  // Schritt 1: Kacheln
  $('aiProviders').replaceChildren(...d.providers.map((p) => {
    const i = AI_INFO[p.id];
    const b = el('button', { type: 'button', class: 'ai-prov' + (aiPick === p.id ? ' on' : ''), role: 'radio', 'aria-checked': String(aiPick === p.id) },
      el('b', {}, aiProviderName(p.id)), el('small', { class: 'muted' }, tr(...i.badge)), i.rec ? el('span', { class: 'tag' }, tr('dash.aiRec', 'empfohlen')) : '');
    b.onclick = () => { aiPick = p.id; $('aiMsg').textContent = ''; paintAi(); $('aiKey').focus(); };
    return b;
  }));
  // Schritt 2: Schlüssel (+ Adresse/Modell bei "Andere")
  $('aiStep2').hidden = !aiPick;
  if (aiPick) {
    const prov = d.providers.find((p) => p.id === aiPick);
    $('aiGetKey').hidden = !prov.keyUrl;
    if (prov.keyUrl) $('aiGetKey').href = prov.keyUrl;
    $('aiCompat').hidden = aiPick !== 'compatible';
    const ph = AI_INFO[aiPick].ph;
    $('aiKey').placeholder = Array.isArray(ph) ? tr(...ph) : ph;
    $('aiKeyHint').textContent = aiPick === 'gemini' ? tr('dash.aiHintGemini', 'Bei Google AI Studio mit deinem Google-Konto anmelden → „API-Schlüssel erstellen“ → kopieren und hier einfügen.')
      : aiPick === 'compatible' ? tr('dash.aiHintOther', 'Adresse und Modellname stehen in der Anleitung deines Anbieters. ChaosCore prüft beim Verbinden selbst, ob die KI Bilder sehen kann.')
        : tr('dash.aiHintPaid', 'Schlüssel im Konto des Anbieters erstellen. Abgerechnet wird dort nach Nutzung - ein Clip kostet meist nur Bruchteile eines Cents.');
  }
  if (!d.connected) return;
  // Verbunden
  const s = d.settings;
  $('aiState').textContent = tr('dash.aiConnectedTo', 'Verbunden: {p}').replace('{p}', aiProviderName(s.provider));
  $('aiSees').textContent = ' · ' + tr(...(AI_SEES[d.sees] || AI_SEES.text));
  const models = d.models.length ? d.models : [d.model];
  if (!models.includes(d.model)) models.unshift(d.model);
  $('aiModel').replaceChildren(...models.map((m) => el('option', { value: m }, m)));
  $('aiModel').value = d.model;
  $('aiAnalyze').checked = s.analyze === 'auto';
  $('aiMax').value = s.maxPerStream;
  $('aiApply').value = s.apply;
  $('aiUploads').checked = s.uploads;
  $('aiTone').value = s.tone;
  $('aiLang').value = s.lang;
  const work = d.running !== null ? tr('dash.aiWorkingN', 'KI analysiert gerade … ({n} warten)').replace('{n}', d.queue.length) : '';
  $('aiWork').textContent = work;
  // Während die KI arbeitet: öfter nachsehen (Vorschläge erscheinen in der Highlight-Liste)
  const busy = d.running !== null || d.queue.length;
  if (busy && !aiPoll) aiPoll = setInterval(() => { loadAi(); loadHighlights(false); }, 2500);
  if (!busy && aiPoll) { clearInterval(aiPoll); aiPoll = null; loadHighlights(false); }
  if (upData) paintUploads();
}

function aiShowSample(r) {
  const box = $('aiSample');
  box.hidden = false;
  box.replaceChildren(
    el('div', { class: 'muted' }, tr('dash.aiSampleFor', 'Beispiel für „4 Kills in einer Runde auf Mirage“:')),
    el('b', {}, r.title), el('div', { class: 'ai-tags' }, r.hashtags.join(' ')), el('small', { class: 'muted' }, r.description));
}

async function aiBusy(btn, fn) {
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = tr('dash.aiWorking', 'KI denkt nach …');
  try { await fn(); } catch (e) { $('aiMsg').textContent = e.message; } finally { btn.disabled = false; btn.textContent = label; }
}

$('aiConnect').onclick = () => aiBusy($('aiConnect'), async () => {
  $('aiMsg').textContent = '';
  const key = $('aiKey').value.trim();
  if (!key && aiPick !== 'compatible') { $('aiMsg').textContent = tr('dash.aiNeedKey', 'Bitte zuerst den Schlüssel einfügen.'); return; }
  aiData = await api('ai/connect', { provider: aiPick, key, baseUrl: $('aiBase').value.trim(), model: $('aiModelIn').value.trim() });
  $('aiKey').value = ''; aiChanging = false;
  showToast(tr('dash.aiNowConnected', 'KI-Assistent ist verbunden ✔'));
  paintAi();
});
$('aiKey').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('aiConnect').click(); });
$('aiChange').onclick = () => { aiChanging = true; aiPick = aiData?.settings.provider || ''; paintAi(); };
$('aiRemove').onclick = async () => {
  if (!confirm(tr('dash.aiRemoveConfirm', 'KI-Assistent entfernen? Der Schlüssel wird gelöscht.'))) return;
  try { aiData = await api('ai/remove', {}); aiPick = ''; aiChanging = false; $('aiSample').hidden = true; paintAi(); } catch (e) { $('aiMsg').textContent = e.message; }
};
async function saveAi() {
  try {
    aiData = await api('ai', { model: $('aiModel').value, analyze: $('aiAnalyze').checked ? 'auto' : 'manual', maxPerStream: Number($('aiMax').value), apply: $('aiApply').value, uploads: $('aiUploads').checked, tone: $('aiTone').value, lang: $('aiLang').value });
    $('aiMsg').textContent = tr('dash.queueSaved', 'Gespeichert.'); paintAi();
  } catch (e) { $('aiMsg').textContent = e.message; }
}
for (const id of ['aiModel', 'aiAnalyze', 'aiMax', 'aiApply', 'aiUploads', 'aiTone', 'aiLang']) $(id).onchange = saveAi;
$('aiTry').onclick = () => aiBusy($('aiTry'), async () => { $('aiMsg').textContent = ''; aiShowSample(await api('ai/sample', {})); });

// ---- Highlight-Liste: KI-Knopf und Vorschlag ----
function aiRowParts(r) {
  if (!aiData?.connected) return { tools: [], box: null };
  const tools = [];
  const waiting = aiData.running === r.id || aiData.queue.includes(r.id);
  if (waiting) tools.push(el('span', { class: 'muted' }, tr('dash.aiRowWorking', '✨ KI schaut …')));
  else {
    const b = el('button', { type: 'button', title: tr('dash.aiRowHint', 'Mit KI analysieren: Titel, Hashtags, Beschreibung') }, r.ai ? '✨ ↻' : '✨');
    b.onclick = () => { b.disabled = true; api('ai/analyze', { id: r.id }).then(() => { loadAi(); loadHighlights(false); }).catch((e) => { b.disabled = false; banner(e.message, true); }); setTimeout(loadAi, 300); };
    tools.push(b);
  }
  if (!r.ai) return { tools, box: null };
  const tags = el('span', { class: 'ai-tags' }, (r.ai.hashtags || []).join(' '));
  const copy = el('button', { type: 'button', class: 'ghostBtn' }, tr('dash.aiCopyAll', 'Titel + Hashtags kopieren'));
  copy.onclick = () => navigator.clipboard?.writeText(`${r.ai.title} ${(r.ai.hashtags || []).join(' ')}`).then(() => showToast(tr('dash.aiCopied', 'Kopiert ✔'))).catch(() => {});
  const seen = el('small', { class: 'muted' }, tr(...(AI_SEES[r.ai.used] || AI_SEES.text)));
  if (r.ai.applied) {
    const undo = el('button', { type: 'button', class: 'ghostBtn' }, tr('dash.aiUndo', 'Alten Titel zurück'));
    undo.onclick = () => api('ai/dismiss', { id: r.id }).then(() => loadHighlights(false)).catch((e) => banner(e.message, true));
    return { tools, box: el('div', { class: 'ai-box applied' }, el('div', {}, el('span', { class: 'tag' }, tr('dash.aiByAi', '✨ KI-Titel')), ' ', tags, ' ', seen), el('div', { class: 'acts' }, copy, undo)) };
  }
  const take = el('button', { type: 'button', class: 'primary' }, tr('dash.aiTake', 'Übernehmen'));
  take.onclick = () => api('ai/apply', { id: r.id }).then(() => { showToast(tr('dash.aiTaken', 'KI-Titel übernommen ✔')); loadHighlights(false); }).catch((e) => banner(e.message, true));
  const drop = el('button', { type: 'button', class: 'ghostBtn' }, tr('dash.aiDrop', 'Verwerfen'));
  drop.onclick = () => api('ai/dismiss', { id: r.id }).then(() => loadHighlights(false)).catch((e) => banner(e.message, true));
  return { tools, box: el('div', { class: 'ai-box' }, el('div', {}, el('span', { class: 'tag' }, tr('dash.aiSuggestion', '✨ Vorschlag')), ' ', el('b', {}, r.ai.title)), el('div', {}, tags, ' ', seen),
    r.ai.summary ? el('small', { class: 'muted' }, r.ai.summary) : '', el('div', { class: 'acts' }, take, copy, drop)) };
}

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
