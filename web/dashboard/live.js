// Dashboard - Bereich "Live" (ChaosCore 2): großer Effekt-Ring mit Restzeit, "Braucht dich" (was gerade
// eine Handlung von dir braucht), Zahlen dieser Session und die letzten Highlights.
// Wird bei jedem Statusabruf aus paint() (status.js) aufgerufen.
const LV_RING = 2 * Math.PI * 74;
let lvCurrent = null;
let lvHlAsked = false;

function lvTick() {
  const c = lvCurrent;
  const ring = $('lvRing');
  if (!ring) return;
  ring.style.opacity = c ? '1' : '0';
  if (!c) { ring.style.strokeDashoffset = String(LV_RING); $('lvLeft').textContent = '–'; $('lvLeftLbl').textContent = ''; return; }
  if (c.untilStop || !c.endsAt) {
    ring.style.strokeDashoffset = '0';
    $('lvLeft').textContent = '∞';
    $('lvLeftLbl').textContent = tr('dash.lvUntilRound', 'bis Rundenende');
    return;
  }
  const total = Math.max(1, c.endsAt - c.startedAt);
  const left = Math.max(0, c.endsAt - Date.now());
  ring.style.strokeDashoffset = String(LV_RING * (1 - left / total));
  $('lvLeft').textContent = String(Math.ceil(left / 1000));
  $('lvLeftLbl').textContent = tr('dash.lvSeconds', 'Sekunden');
}
setInterval(lvTick, 500);

function lvGo(area) { showSection(area); window.scrollTo({ top: 0, behavior: 'smooth' }); }

function paintLive(s) {
  if (!$('lvHero')) return;
  const st = s.state;
  const c = st.current;
  lvCurrent = c || null;
  $('lvHero').style.setProperty('--fx', c?.color || 'var(--accent)');
  if (c) {
    $('lvState').textContent = c.test ? tr('dash.testRun', 'Testlauf') : tr('dash.lvRunning', 'Läuft gerade');
    $('lvTitle').textContent = c.title;
    $('lvWho').textContent = c.test ? '' : tr('dash.lvBy', 'eingelöst von {user}').replace('{user}', c.user);
    $('lvFlavor').textContent = c.flavor || '';
  } else {
    $('lvState').textContent = st.paused ? tr('dash.paused', 'Pausiert') : tr('dash.lvReady', 'Bereit');
    $('lvTitle').textContent = st.paused ? tr('dash.lvPausedTitle', 'ChaosCore ist pausiert') : tr('dash.lvIdleTitle', 'Gerade läuft nichts');
    $('lvWho').textContent = st.paused ? tr('dash.lvPausedText', 'Neue Einlösungen warten, bis du fortsetzt.')
      : st.queue.length ? tr('dash.lvQueued', '{n} warten - der nächste Effekt startet gleich.').replace('{n}', st.queue.length)
        : tr('dash.lvIdleText', 'Deine Zuschauer können jederzeit einlösen.');
    $('lvFlavor').textContent = '';
  }
  $('lvSkip').disabled = !c;
  $('lvPause').textContent = st.paused ? tr('dash.resume', 'Fortsetzen') : tr('dash.pause', 'Pausieren');
  lvTick();

  // ---- Braucht dich: nur, was eine Handlung braucht - jeweils mit dem Knopf dafür ----
  const items = [];
  const item = (title, text, label, fn) => {
    const b = el('button', { type: 'button' }, label);
    b.onclick = fn;
    items.push(el('div', { class: 'ib' }, el('div', {}, el('b', {}, title), el('small', {}, text)), el('div', { class: 'acts' }, b)));
  };
  if (s.twitch.status === 'auth_failed') item(tr('dash.reloginTitle', 'Twitch-Login abgelaufen'), tr('dash.lvReloginText', 'Ohne Anmeldung kommen keine Einlösungen an.'), tr('dash.reloginBtn', 'Jetzt neu anmelden'), () => $('reloginBtn').click());
  const credits = st.bitsCredit || [];
  if (credits.length) item(tr('dash.lvCreditTitle', 'Bezahltes Chaos wartet'), tr('dash.lvCreditText', '{n}× Bits-Guthaben ist noch offen - einreihen oder verwerfen.').replace('{n}', credits.length), tr('dash.lvOpenBits', 'Ansehen'), () => { lvGo('bits'); $('creditList').scrollIntoView({ behavior: 'smooth', block: 'center' }); });
  if (s.game?.supportsGsi && !s.gsi.connected) item(tr('dash.lvGsiTitle', 'CS2 meldet sich nicht'), tr('dash.lvGsiText', 'Ohne Spielzustand zählen keine Kills und Tode, und Effekte warten nicht auf die Runde. Starte CS2 - oder richte die Verbindung in der Einrichtung ein.'), tr('dash.openSetup', '⚙ Einrichtung'), () => $('openSetup').click());
  if (!s.actions.some((a) => a.enabled && a.linked)) item(tr('dash.lvNoRewardTitle', 'Keine Belohnung auf Twitch'), tr('dash.lvNoRewardText', 'Zuschauer sehen noch nichts zum Einlösen.'), tr('dash.lvSync', 'Abgleichen'), () => lvGo('effects'));
  if (st.game?.blockedMode) item(tr('dash.lvBlockedTitle', 'Effekte pausieren im Spielmodus'), tr('dash.lvBlockedText', '„{mode}“ ist gesperrt - Kanalpunkte gehen zurück.').replace('{mode}', modeName(st.game.blockedMode)), tr('dash.lvSettings', 'Einstellungen'), () => { lvGo('settings'); $('mlModes').scrollIntoView({ behavior: 'smooth', block: 'center' }); });
  $('lvInbox').dataset.empty = tr('dash.lvInboxEmpty', 'Alles erledigt - gerade wartet nichts auf dich.');
  $('lvInbox').replaceChildren(...items);
  $('lvInboxCount').textContent = String(items.length);
  $('lvInboxCount').classList.toggle('zero', !items.length);

  // ---- Zahlen dieser Session ----
  const t = s.state.stats?.totals;
  const live = s.state.stats?.active;
  const tile = (lbl, n, d, cls = '') => el('div', { class: 'tile ' + cls }, el('div', { class: 'lbl' }, lbl), el('div', { class: 'n' }, n), el('div', { class: 'd' }, d));
  const v = (x) => (live && t ? String(x) : '–');
  const ct = st.contract;
  $('lvTiles').replaceChildren(
    tile(tr('dash.lvKills', 'Kills'), v(t?.kills), live ? tr('dash.lvKd', 'K/D {kd}').replace('{kd}', t.kd) : tr('dash.lvNoSession', 'keine Session aktiv')),
    tile(tr('dash.lvDeaths', 'Tode'), v(t?.deaths), live ? tr('dash.lvNatural', '{n} ganz ohne Chaos').replace('{n}', t.deathsNatural) : ''),
    tile(tr('dash.lvChaosDeaths', 'Chaos-Tode'), v(t?.deathsChaos), tr('dash.lvChaosDeathsD', 'durch einen Effekt'), 'chaos'),
    tile(tr('dash.lvMeter', 'Chaos-Meter'), `${Math.round(Math.min(100, st.chaos))} %`, tr('dash.lvMeterD', 'Community-Ziel')),
    tile(tr('dash.lvContract', 'Daily Contract'), `${Math.min(ct.have, ct.target)}/${ct.target}`, ct.done ? tr('dash.lvContractDone', 'geschafft ✔') : tr('dash.lvContractD', 'verschiedene Zuschauer heute')));

  if (!lvHlAsked && document.body.dataset.section === 'live') { lvHlAsked = true; loadHighlights(false); }
}

function paintLiveHl() {
  if (!$('lvHl')) return;
  const rows = (hlData?.list || []).slice(0, 3);
  if (!rows.length) { $('lvHl').replaceChildren(el('div', { class: 'muted' }, tr('dash.hlNone', 'Noch keine Highlights - sie entstehen automatisch im Stream.'))); return; }
  $('lvHl').replaceChildren(...rows.map((r) => {
    const flames = el('span', { class: 'flame', 'aria-label': `${r.score} P.` }, ...Array.from({ length: 5 }, (_, i) => el('i', { class: i < Math.ceil(r.score / 2) ? '' : 'off' })));
    return el('div', {}, el('div', { class: 'hl-meta mono' }, r.vod || fmtTime(r.ts), ' ', flames), el('b', {}, r.title));
  }));
}

$('lvSkip').onclick = () => $('skip').click();
$('lvPause').onclick = () => $('pause').click();
$('lvAllHl').onclick = () => lvGo('highlights');
