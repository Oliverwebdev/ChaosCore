// Dashboard - Updates, Onboarding.
// Wird beim Ausliefern in dashboard.html eingesetzt (siehe src/web-pages.js): alle Teile laufen
// zusammen in EINEM Skript, in dieser Reihenfolge.
// ---------- Updates ----------
let updateInfo = null;
function paintUpdate(u) {
  updateInfo = u;
  const info = $('updateInfo'), box = $('updateBox');
  if (u.channelSetting) $('updateChannel').value = u.channelSetting;
  box.style.display = 'none'; $('updateBadge').style.display = 'none';
  if (!u.configured) { info.textContent = tr('dash.updateNone', 'Keine automatische Update-Prüfung eingerichtet.'); return; }
  if (u.error) { info.textContent = tr('dash.updateCheckFail', 'Update-Prüfung nicht möglich: {err}').replace('{err}', u.error); return; }
  if (!u.newer) { info.textContent = tr('dash.updateCurrent', 'Du hast die aktuelle Version ({current}).').replace('{current}', u.current); return; }
  info.textContent = tr('dash.updateNewer2', 'Neue Version verfügbar: {latest} (du hast {current}).').replace('{latest}', u.latest).replace('{current}', u.current);
  $('updateBadge').textContent = '⬆ ' + tr('dash.updateBadge', 'Update {v}').replace('{v}', u.latest);
  $('updateBadge').style.display = '';
  box.style.display = '';
  $('updateNotes').textContent = u.notes || '';
  $('updateNotesBox').style.display = u.notes ? '' : 'none';
  const btn = $('updateInstall');
  if (u.canInstall && u.installable) {
    btn.style.display = '';
    $('updateMsg').textContent = tr('dash.updateHow', 'Lädt den Installer von GitHub, prüft ihn und installiert ihn. ChaosCore startet danach neu - deine Einstellungen bleiben erhalten.')
      + (u.signatureCheck ? ' ' + tr('dash.updateSigned', 'Installiert wird nur, was der Entwickler signiert hat.') : '');
  } else if (u.canInstall && u.awaitingSignature) {
    btn.style.display = 'none';
    $('updateMsg').textContent = tr('dash.updateAwaitSig', 'Die neue Version wird gerade noch signiert. Schau in ein paar Minuten nochmal vorbei.');
  } else {
    btn.style.display = 'none';
    const why = u.installBlocked === 'portable' ? tr('dash.updatePortable', 'In der portablen Version bitte die neue ZIP selbst herunterladen:')
      : tr('dash.updateManual', 'Hier geht das Aktualisieren nur von Hand:');
    $('updateMsg').replaceChildren(why + ' ', el('a', { href: u.url, target: '_blank', rel: 'noopener', style: 'color:var(--cyan)' }, tr('dash.updateLoadNow', 'jetzt laden')));
  }
}
async function loadUpdate(force) {
  try { paintUpdate(await api('update-check' + (force ? '?force=1' : ''))); }
  catch (e) { $('updateInfo').textContent = tr('dash.updateFailed', 'Update-Prüfung fehlgeschlagen: {msg}').replace('{msg}', e.message); }
}
loadUpdate(false);
$('updateBadge').onclick = () => { showSection('system'); $('updateInfo').scrollIntoView({ behavior: 'smooth', block: 'center' }); };
$('updateChannel').onchange = async () => {
  try { paintUpdate(await api('update/channel', { channel: $('updateChannel').value })); }
  catch (e) { $('updateMsg').textContent = e.message; }
};
$('updateInstall').onclick = async () => {
  const btn = $('updateInstall');
  btn.disabled = true;
  try { await api('update/install', {}); }
  catch (e) { btn.disabled = false; $('updateMsg').textContent = e.message; return; }
  $('updateMeter').style.display = '';
  const verOf = (st) => `${st.version}|${st.build?.build || ''}`;
  let from = null;
  try { from = verOf(await api('status')); } catch { /* egal */ }
  const poll = async () => {
    let j = null;
    try { j = await api('update/status'); } catch { /* ChaosCore startet gerade neu */ }
    if (j?.phase === 'error') { btn.disabled = false; $('updateMsg').textContent = tr('dash.updateError', 'Update fehlgeschlagen: {msg}').replace('{msg}', j.error); return; }
    if (j?.phase === 'downloading') {
      const pct = j.total ? Math.round((j.bytes / j.total) * 100) : 0;
      $('updateMeterBar').style.width = pct + '%';
      $('updateMsg').textContent = tr('dash.updateDownloading', 'Lade herunter … {pct} %').replace('{pct}', pct);
    } else {
      $('updateMeterBar').style.width = '100%';
      $('updateMsg').textContent = tr('dash.updateInstalling', 'Installiere … ChaosCore startet gleich neu, dieses Fenster lädt sich danach selbst neu.');
      // Neue Version läuft, sobald die Prüfung eine andere Version meldet
      try { const st = await api('status'); if (from && verOf(st) !== from) { location.reload(); return; } } catch { /* noch nicht wieder da */ }
    }
    setTimeout(poll, 1500);
  };
  poll();
};

// die statische Feature-Übersicht steht fest, die
// Einrichtungs-Checkliste darunter wird einmal beim Öffnen live geprüft (dieselbe Prüfung wie
// "Systemcheck", aber hier nur die offenen Punkte, einladend statt technisch formuliert).
const ONBOARDING_FEATURES = [
  ['onboardingFeatAction', 'Eigener Aktions-Builder: neue Effekte ganz ohne Code zusammenklicken.'],
  ['onboardingFeatPreset', 'Presets teilen oder sichern: Tasten, Aktionen, Overlay-Look als eine Datei.'],
  ['onboardingFeatAccess', 'Zugriffsregeln pro Aktion: z. B. „nur Abonnenten/VIPs/Moderatoren“.'],
  ['onboardingFeatGoal', 'Community-Ziel: ein gemeinsamer Fortschrittsbalken für deinen Chat.'],
  ['onboardingFeatSeason', 'Season & Chaos-Score: eine laufende Bestenliste über mehrere Streams.'],
  ['onboardingFeatQueue', 'Warteschlangen-Politik: wie viele Effekte gleichzeitig warten dürfen.'],
  ['onboardingFeatStats', 'Session Stats: Kills, Tode und wer dich mit einem Effekt erledigt hat.'],
];
const paintFeatures = () => $('onboardingFeatures').replaceChildren(...ONBOARDING_FEATURES.map(([k, fallback]) => el('li', {}, tr('dash.' + k, fallback))));
paintFeatures();
document.addEventListener('i18n-ready', () => { paintFeatures(); ssLastKey = ''; refreshStats(); if (bmData) paintBmItems(); });
(async () => {
  try {
    const r = await api('checks');
    const open = r.checks.filter((c) => c.level !== 'ok').map((c) => c.label);
    $('onboardingChecklist').textContent = open.length ? tr('dash.onboardingMissing', 'Noch offen: {items}').replace('{items}', open.join(' · ')) : tr('dash.onboardingOk', 'Alles bereit.');
  } catch (e) { $('onboardingChecklist').textContent = tr('dash.syncFail', 'Fehler: {msg}').replace('{msg}', e.message); }
})();
