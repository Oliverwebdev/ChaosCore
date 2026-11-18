// Herzstück: Einlösungen prüfen, in die Queue legen, ausführen, abschließen oder erstatten.
import { EventEmitter } from 'node:events';
import { sleep, pick, clean, TIME_SCALE } from './util.js';
import { compile, LIMITS } from './steps.js';
import { grenadeKey, grenadeBindKey } from './cs2.js';
import * as logger from './log.js';
import { getLicenseState } from './license.js';
import { CHAT_STATS_TRIGGER } from './config.js';
import { hasGameEffect } from './validate.js';
import { planCheer, menuAction, menuChatText, rouletteText, templateTitle, BITS_MENU_TEMPLATES, CHUNK_MS } from './bits-menu.js';

const real = (ms) => ms * TIME_SCALE;

// Chat-Ankündigungen/Befehls-Antworten - bewusst zweisprachig von Hand
// statt über locale/*.json (das sind UI-Strings für die eigenen Fenster; Chat-Text ist wie die
// Aktionstexte eher Zuschauer-sichtbarer Inhalt, aber hier so kurz und spezifisch,
// dass eine eigene kleine Tabelle klarer ist als der _en-Mechanismus der Aktionsdateien).
const CHAT_TEXT = {
  effect: { de: (u, t) => `🎲 ${u} hat „${t}“ ausgelöst!`, en: (u, t) => `🎲 ${u} triggered "${t}"!` },
  seasonEndingSoon: {
    de: () => '⏳ Die aktuelle Season endet bald - letzte Chance, Chaos-Punkte zu sammeln!',
    en: () => '⏳ The current season is ending soon - last chance to rack up Chaos points!',
  },
  seasonWinner: {
    de: (name, chaos) => `🏆 Season beendet! Sieger: ${name} mit ${chaos} Chaos-Punkten.`,
    en: (name, chaos) => `🏆 Season over! Winner: ${name} with ${chaos} Chaos points.`,
  },
  statsNone: { de: (u) => `@${u}: Noch keine Aktion ausgelöst.`, en: (u) => `@${u}: No actions triggered yet.` },
  stats: {
    de: (u, total, chaos, fav) => `@${u}: ${total} Aktionen ausgelöst, ${chaos} Chaos-Punkte gesammelt${fav ? `, Lieblings-Effekt: ${fav}` : ''}.`,
    en: (u, total, chaos, fav) => `@${u}: ${total} actions triggered, ${chaos} Chaos points collected${fav ? `, favorite effect: ${fav}` : ''}.`,
  },
  // Tod durch einen Zuschauer-Effekt (soll Lust auf mehr Chaos machen).
  chaosDeath: { de: (u, t) => `💀 ${u} hat den Streamer mit „${t}“ erledigt!`, en: (u, t) => `💀 ${u} took the streamer out with "${t}"!` },
  credit: {
    de: (u, what) => `💜 @${u}: ${what} bleiben dir gutgeschrieben und laufen später weiter.`,
    en: (u, what) => `💜 @${u}: ${what} stay credited to you and will run later.`,
  },
  failCounted: { de: (n) => `🤦 Fail gezählt (${n} in diesem Stream).`, en: (n) => `🤦 Fail counted (${n} this stream).` },
};
const FAIL_TRIGGER = '!fail';
const chatLocale = (cfg) => (cfg.server?.locale === 'en' ? 'en' : 'de');

// Rollendaten zwischenspeichern statt pro Einlösung live bei Twitch
// abzufragen (API-Limits!). 5 Minuten ist eine sinnvolle Aktualisierungsfrequenz - frisch genug,
// dass z. B. ein neues Abo zeitnah wirkt, aber kein API-Aufruf pro einzelner Einlösung.
const ACCESS_CACHE_MS = 300000;

function accessDeniedReason(access) {
  return { subscriber: 'Nur für Abonnenten', vip: 'Nur für VIPs', moderator: 'Nur für Moderatoren' }[access] || 'Zugriffsregel nicht erfüllt';
}

// Effekte, die echte Tasten drücken (effect.steps/effect.dynamic),
// MÜSSEN seriell über this.queue/this.current laufen - sonst drücken sich zwei Effekte gegenseitig
// ihre Tasten weg. Eine reine Overlay-Meldung ohne Tastendruck blockiert dagegen nichts im Spiel
// und braucht nicht auf dieselbe Warteschlange zu warten - die läuft über die "schnelle Spur"
// (runFast()), parallel zu einem gerade laufenden echten Spiel-Effekt.
const isBitsItem = (i) => !!(i.bits || i.bitsMenu || i.creditId);
// "2:30 Min.", "3 Runden", "2×"
function amountText(unit, remaining, loc) {
  const en = loc === 'en';
  if (unit === 'round') return en ? `${remaining} round(s)` : `${remaining} Runde(n)`;
  if (unit === 'once') return `${remaining}×`;
  const secs = Math.ceil(remaining / 1000);
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} ${en ? 'min' : 'Min.'}`;
}

function isOverlayOnly(action) {
  const eff = action.effect || {};
  return !(eff.steps?.length || eff.variants?.length) && !eff.dynamic;
}

// Eigene Farbe/Cooldown einer Aktion gehen vor die Werte ihrer Stufe.
const withOverrides = (action, cat) => (cat && (action.color || action.cooldownSec != null)
  ? { ...cat, ...(action.color ? { color: action.color } : {}), ...(action.cooldownSec != null ? { cooldownSec: action.cooldownSec } : {}) } : cat);
const coolKey = (action) => (action.cooldownSec != null ? `a:${action.id}` : action.category);

export class Engine extends EventEmitter {
  constructor({ cfg, twitch, bridge, gsi, db, actions, rewardMap, bitsActions }) {
    super();
    Object.assign(this, { cfg, twitch, bridge, gsi, db, actions, rewardMap, bitsActions });
    this.queue = [];
    this.qidSeq = 0;
    this.bitsStreak = 0; // Bits-Effekte direkt hintereinander (für den Kanalpunkte-Schutz)
    this.current = null;
    this.paused = false;
    this.closed = false;
    this.looping = false;
    this.cool = new Map();
    this.chaos = 0;
    this.goalIdx = 0; // welche Community-Ziel-Schwelle als nächstes dran ist
    this.lastActivityAt = Date.now(); // letzte ECHTE Einlösung/Cheer, für "Auto-Lebendig"
    this.accessCache = new Map(); // userId -> { moderator, vip, subscriber, fetchedAt }
    this.chatCooldowns = new Map(); // Trigger-Wort -> Zeitpunkt der letzten Antwort
    this._seasonEndingSoonAnnouncedFor = null; // season.startedAt, für den schon gewarnt wurde
    this.hall = db.hall(5);
    this.hallToday = db.hallToday(5);
    this.history = this.loadHistory();
    this.contractHave = db.distinctViewers();
    this.season = this.computeSeason();
    this._pending = false;
    // Bits-Guthaben: was beim letzten Beenden/Absturz noch in der Warteliste stand, wird gutgeschrieben.
    const recovered = db.creditRecoverPending?.('Neustart von ChaosCore') || 0;
    if (recovered) logger.info(`Bits-Guthaben: ${recovered} offene Bits-Effekt(e) aus der letzten Sitzung gutgeschrieben.`);
    this.credits = db.creditList?.() || [];

    gsi.on('change', (now, prev) => {
      if (!(this.current?.handle && now.connected && prev.live && !now.live)) return;
      // Fix 2026-11-15: vorher hieß jeder dieser Fälle "Runde vorbei". Ist der Spieler nur im Menü,
      // Chat oder in der Konsole, würden Wiederherstellungs-Tasten dort als Text verpuffen (Fadenkreuz
      // bliebe z. B. unsichtbar) - deshalb aufschieben, bis wieder gespielt wird.
      const inMenu = now.roundLive && now.alive && now.activity && now.activity !== 'playing';
      if (inMenu) this.stopCurrent('Spieler im Menü, Chat oder in der Konsole', { defer: true });
      else if (now.roundLive && !now.alive) {
        // Regel im Baukasten: "bei Tod weiterlaufen" (z. B. Fadenkreuz bleibt beim Zuschauen riesig).
        if (this.current.item?.action?.onDeath !== 'continue') this.stopCurrent('Spieler gestorben');
      } else this.stopCurrent('Runde vorbei');
    });
    // Aufgeschobene Wiederherstellungen erst senden, wenn der Spieler wirklich spielt.
    this.bridge.setRestoreGate?.(() => { const g = this.gsi.get(); return !g.connected || !g.activity || g.activity === 'playing'; });
    this.decay = setInterval(() => {
      if (this.chaos > 0) { this.chaos = Math.max(0, this.chaos - 1); this.emitState(); }
    }, real(6000));
    this.decay.unref();
    this.seasonTick = setInterval(() => this.checkSeasonExpiry(), real(60000));
    this.seasonTick.unref();
    this.idleTick = setInterval(() => this.checkAutoIdle(), real(5000));
    this.idleTick.unref();
    this.creditTick = setInterval(() => this.checkCreditResume(), real(15000));
    this.creditTick.unref();
  }

  setActions(actions) { this.actions = actions; this.emitState(); }
  setRewardMap(map) { this.rewardMap = map; }
  setBitsActions(bitsActions) { this.bitsActions = bitsActions; this.emitState(); }

  // ---------- Zustand für Overlay und Dashboard ----------
  publicState() {
    const g = this.gsi.get();
    const c = this.current;
    const t = this.cfg.contract.distinctViewers;
    return {
      brand: this.cfg.overlay.brand, accent: this.cfg.overlay.accent, sound: this.cfg.overlay.sound,
      // das Overlay lädt /overlay-asset/sound bzw. /overlay-asset/image nur, wenn
      // hier true steht - sonst bliebe bei jedem Statuswechsel ein unnötiger 404-Request übrig.
      hasCustomSound: !!this.cfg.overlay.customSound, hasCustomImage: !!this.cfg.overlay.customImage,
      paused: this.paused, chaos: this.goalPercent(),
      // Name/Grundlage des Community-Ziels fürs Overlay/Dashboard -
      // ohne eigenen Namen zeigt das Overlay weiter seinen bisherigen Standardtext.
      communityGoal: { name: this.cfg.communityGoal?.name || null, basis: this.cfg.communityGoal?.basis || 'both' },
      // fürs Dashboard - an/aus, Ruhezeit, Whitelist (Overlay braucht das nicht).
      autoIdle: { enabled: !!this.cfg.autoIdle?.enabled, idleSec: this.cfg.autoIdle?.idleSec ?? 300, whitelist: this.cfg.autoIdle?.whitelist || [] },
      current: c && {
        title: c.title, user: c.user, color: c.color, flavor: c.flavor,
        startedAt: c.startedAt, endsAt: c.endsAt, untilStop: !!c.untilStop, test: !!c.item.test,
      },
      queue: this.queue.map((i) => ({ qid: (i.qid ??= ++this.qidSeq), title: i.action.title, user: i.user, color: i.cat.color, system: !!i.system, test: !!i.test, bits: isBitsItem(i) })),
      contract: { target: t, have: this.contractHave, done: this.contractHave >= t },
      hall: this.hall,
      hallToday: this.hallToday,
      history: this.history,
      overlay: { history: !!this.cfg.overlay.history, top: !!this.cfg.overlay.top, historyCount: this.cfg.overlay.historyCount, topCount: this.cfg.overlay.topCount, topMode: this.cfg.overlay.topMode, topRotateSec: this.cfg.overlay.topRotateSec, reduceFlash: !!this.cfg.overlay.reduceFlash, layout: this.cfg.overlay.layout || {}, hidden: this.cfg.overlay.hidden || [], styles: this.cfg.overlay.styles || {}, customCss: this.cfg.overlay.customCss || '', customSound: this.cfg.overlay.customSound ? { name: this.cfg.overlay.customSound.name } : null, customImage: this.cfg.overlay.customImage ? { name: this.cfg.overlay.customImage.name } : null },
      game: { connected: g.connected, live: g.live, mode: g.mode, map: g.map, blockedMode: this.blockedMode() },
      bitsCredit: this.credits.map((c) => ({ ...c, title: this.creditTitle(c) })),
      milestones: this.milestones || [],
      bitsPot: this.cfg.bitsMenu?.enabled && this.cfg.bitsMenu.pot?.enabled ? { have: this.pot.bits, goal: this.cfg.bitsMenu.pot.goal, top: Object.entries(this.pot.top).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, bits]) => ({ name, bits })) } : null,
      challenge: this.challenge || null,
      bitsStage: this.bitsStage(),
      ...(this.extraState?.() || {}), // OBS/System-Aktionen (server.js)
      season: this.season,
      stats: this.stats ? this.stats.publicState() : null,
      // Wasserzeichen in Dashboard UND Overlay, solange eine (noch nicht
      // abgelaufene - eine abgelaufene verweigert bereits den Start, siehe server.js) Testversion
      // läuft - "nicht für den Live-Einsatz bestimmt" muss sichtbar sein, nicht nur dem Streamer
      // selbst im Dashboard bekannt.
      license: getLicenseState(),
    };
  }

  // Season: längerer Zeitraum (Standard 7 Tage, cfg.season.lengthDays) für ein sichtbares,
  // regelmäßig zurückgesetztes Chaos-Score-Ranking - unabhängig von "Heute" (einzelner Stream)
  // und "Gesamt" (ewige Bestenliste). Gibt allen Zuschauern immer wieder einen fairen Neustart.
  // Wird wie this.hall/this.hallToday zwischengespeichert (nicht live in publicState() aus der DB
  // gelesen) - emitState()s Timeout kann sonst noch nach engine.close()/db.close() feuern und an
  // einem bereits finalisierten Prepared Statement abstürzen.
  computeSeason() {
    const info = this.db.seasonInfo();
    const lengthMs = Math.max(1, this.cfg.season.lengthDays) * 86400000;
    return {
      chaosHall: this.db.seasonHall(5),
      startedAt: info.startedAt,
      endsAt: info.startedAt + lengthMs,
      lengthDays: this.cfg.season.lengthDays,
      lastWinner: this.db.lastSeasonWinner(),
    };
  }

  // Beendet die laufende Season von Hand (Dashboard-Button) oder automatisch, wenn die Laufzeit
  // abgelaufen ist (siehe checkSeasonExpiry). Meldet den Sieger per fx, ähnlich dem Daily Contract.
  finishSeason() {
    const winner = this.db.endSeason();
    this.season = this.computeSeason();
    logger.info(winner ? `Season beendet. Sieger: ${winner.name} (${winner.chaos} Chaos).` : 'Season beendet (niemand hat teilgenommen).');
    this.fx('season_end', winner ? { winner: winner.name, chaos: winner.chaos } : {});
    // "neuer Season-Sieger" im Chat - nur wenn es wirklich einen Sieger
    // gab (niemand teilgenommen -> keine Nachricht, die nur verwirren würde).
    if (winner && this.cfg.chat?.announceSeasonWinner) this.sendChat(CHAT_TEXT.seasonWinner[chatLocale(this.cfg)](winner.name, winner.chaos));
    this.emitState();
    return winner;
  }

  // Für eine Dashboard-Änderung der Season-Dauer: this.season ist
  // zwischengespeichert (siehe computeSeason()-Kommentar oben) - ohne diesen Aufruf würde das
  // Dashboard nach einer Längenänderung weiter das alte, jetzt falsche endsAt zeigen, bis die
  // Season irgendwann regulär endet.
  refreshSeasonLength() { this.season = this.computeSeason(); }

  // "Season endet in Kürze" - einmal pro Season, sobald weniger als
  // SEASON_ENDING_SOON_MS übrig sind. UCC_SEASON_ENDING_SOON_MS überschreibt die Schwelle nur für
  // Tests (season.lengthDays erlaubt produktiv keinen Wert unter einem Tag, siehe
  // config.js: applySeasonConfig - ohne diesen Haken müsste ein Test tagelang warten).
  checkSeasonExpiry() {
    const lengthMs = Math.max(1, this.cfg.season.lengthDays) * 86400000;
    const remainMs = this.season.startedAt + lengthMs - Date.now();
    if (remainMs <= 0) { this.finishSeason(); return; }
    const endingSoonMs = Number(process.env.UCC_SEASON_ENDING_SOON_MS) || 3600000;
    if (this.cfg.chat?.announceSeasonEndingSoon && remainMs <= endingSoonMs && this._seasonEndingSoonAnnouncedFor !== this.season.startedAt) {
      this._seasonEndingSoonAnnouncedFor = this.season.startedAt;
      this.sendChat(CHAT_TEXT.seasonEndingSoon[chatLocale(this.cfg)]());
    }
  }

  // "Auto-Lebendig" - wenn eine Zeit lang niemand etwas ausgelöst hat
  // (siehe lastActivityAt, zurückgesetzt in onRedemption/onCheer bei einer echten, angenommenen
  // Einlösung), löst ChaosCore optional selbst genau eine Aktion aus der vom Streamer gewählten
  // Whitelist aus - NIE aus dem vollen Aktions-Pool. Klar als "ChaosCore" gekennzeichnet (item.user),
  // nie als Name eines echten Zuschauers, und system:true wie beim Community-Ziel-Overload-Effekt
  // (kein Twitch-Status, kein DB-Einlösungs-Eintrag, keine Season-/Bestenlisten-Gutschrift).
  checkAutoIdle() {
    const idle = this.cfg.autoIdle;
    if (!idle?.enabled || !idle.whitelist?.length) return;
    if (Date.now() - this.lastActivityAt < real(idle.idleSec * 1000)) return;
    // Fix 2026-11-15: nur auslösen, wenn das Spiel läuft und gespielt wird - sonst feuerte das alle
    // 5 Minuten ins Leere (z. B. über Nacht ohne CS2) und füllte das Log.
    if (!this.gsi.get().live) return;
    if (this.queue.length >= this.cfg.engine.maxQueue) return; // Warteschlange voll: nächster Tick versucht es erneut
    const pool = [...this.actions.list, ...(this.bitsActions?.list || [])]
      .filter((a) => idle.whitelist.includes(a.id) && a.enabled && hasGameEffect(a));
    if (!pool.length) return; // Whitelist zeigt auf nichts (mehr) Gültiges/Aktiviertes
    const action = pick(pool);
    const cat = withOverrides(action, this.actions.categories[action.category] || this.bitsActions?.categories?.[action.category]);
    if (!cat) return;
    this.lastActivityAt = Date.now(); // Ruhe-Timer läuft ab jetzt neu, wie gefordert ("danach läuft der Ruhe-Timer neu")
    this.queue.push({ user: 'ChaosCore', action, cat, queuedAt: Date.now(), test: null, system: true });
    logger.info(`ChaosCore löst wegen Inaktivität selbst "${action.title}" aus (Queue: ${this.queue.length}).`);
    this.emitState();
    this.kick();
  }

  // Zugriffsregel pro Aktion prüfen (getrennt von "requires", das den
  // Spielzustand prüft). "everyone" (Standard) braucht keine Twitch-Abfrage. Ein anonymer Cheer
  // (userId null) kann keine Rolle nachweisen und erfüllt darum nie eine engere Regel. Rollendaten
  // werden pro Zuschauer zwischengespeichert (ACCESS_CACHE_MS), nicht live pro Einlösung abgefragt.
  async checkAccess(action, userId) {
    if (!action.access || action.access === 'everyone') return true;
    if (!userId) return false;
    let entry = this.accessCache.get(userId);
    if (!entry || Date.now() - entry.fetchedAt > real(ACCESS_CACHE_MS)) {
      entry = { fetchedAt: Date.now(), moderator: false, vip: false, subscriber: false };
      try {
        const [moderator, vip, subscriber] = await Promise.all([
          this.twitch.isModerator(userId), this.twitch.isVip(userId), this.twitch.isSubscriber(userId),
        ]);
        Object.assign(entry, { moderator, vip, subscriber });
      } catch (e) {
        logger.warn(`Rollenabfrage für Zugriffsregel fehlgeschlagen (${userId}): ${e.message}`);
      }
      this.accessCache.set(userId, entry);
    }
    return !!entry[action.access];
  }

  emitState() {
    if (this._pending) return;
    this._pending = true;
    setTimeout(() => { this._pending = false; this.emit('state'); }, 30).unref();
  }

  fx(type, data = {}) { this.emit('fx', { type, ...data }); }

  announceChaosDeath(user, title) {
    if (this.cfg.stats?.announceChaosDeath && user && title) this.sendChat(CHAT_TEXT.chaosDeath[chatLocale(this.cfg)](user, title));
  }

  // ---------- Chat ----------
  // Ein Fehlschlag beim Senden (z. B. Scope fehlt, Twitch kurz nicht erreichbar) darf nie den
  // laufenden Betrieb stören - deshalb hier bewusst gefangen statt durchgereicht, wie schon beim
  // Status-Update einer Einlösung an Twitch.
  sendChat(text) {
    if (!this.cfg.chat?.enabled) return;
    this.twitch.sendChatMessage(text).catch((e) => logger.warn(`Chat-Nachricht konnte nicht gesendet werden: ${e.message}`));
  }

  // Eingebaute Bremse: Mindest-Abklingzeit zwischen zwei Antworten auf
  // DENSELBEN Befehl (statisch oder der eingebaute Statistik-Befehl), damit viele gleichzeitige
  // Auslösungen den Chat nicht mit identischen Antworten zuspammen.
  chatCooldownOk(trigger) {
    const now = Date.now();
    const last = this.chatCooldowns.get(trigger) || 0;
    if (now - last < real((this.cfg.chat?.cooldownSec || 0) * 1000)) return false;
    this.chatCooldowns.set(trigger, now);
    return true;
  }

  // Zuschauer-Statistik aus ChaosCore-eigenen Daten - Daten, die kein
  // anderer Chatbot kennen kann, das ist der eigentliche Alleinstellungs-Teil dieser Funktion.
  statsReply(userId, userName) {
    const loc = chatLocale(this.cfg);
    const { total, chaos } = this.db.viewerStats(userId);
    if (!total) return CHAT_TEXT.statsNone[loc](userName);
    const favId = this.db.favoriteAction(userId);
    const fav = favId && (this.actions.byId.get(favId)?.title || this.bitsActions?.byId?.get(favId)?.title);
    return CHAT_TEXT.stats[loc](userName, total, chaos, fav || null);
  }

  // Eigene, statische Befehle: Text-Trigger -> fester Text, ohne Logik/Variablen/Moderationsrechte
  // (bewusste Abgrenzung zu Nightbot & Co.). Nur das erste Wort
  // der Nachricht zählt als Trigger (ein Befehl mitten im Satz soll nicht versehentlich feuern).
  onChatMessage(ev) {
    const text = String(ev.message?.text || '').trim();
    if (!text) return;
    // "!fail" zählt einen Fail - nur Moderatoren und der Streamer selbst.
    // Funktioniert auch, wenn die Chat-Antworten aus sind (Lesen braucht nur das Chat-Abo).
    if (this.stats && this.cfg.stats?.failCommand && text.toLowerCase().split(/\s+/, 1)[0] === FAIL_TRIGGER) {
      const badges = (ev.badges || []).map((b) => b.set_id);
      const allowed = badges.includes('moderator') || badges.includes('broadcaster') || String(ev.chatter_user_id) === String(this.cfg.twitch?.userId);
      if (!allowed) return;
      const r = this.stats.addFail('chat', ev.chatter_user_name || ev.chatter_user_login || null);
      if (r.ok && this.cfg.chat?.enabled) this.sendChat(CHAT_TEXT.failCounted[chatLocale(this.cfg)](this.stats.totals().fails));
      return;
    }
    if (!this.cfg.chat?.enabled) return;
    const userName = ev.chatter_user_name || ev.chatter_user_login || 'jemand';
    const userId = ev.chatter_user_id;
    const trigger = text.toLowerCase().split(/\s+/, 1)[0];
    if (trigger === CHAT_STATS_TRIGGER) {
      if (this.chatCooldownOk(trigger)) this.sendChat(this.statsReply(userId, userName));
      return;
    }
    if (trigger === '!bits' && this.cfg.bitsMenu?.enabled) {
      if (this.chatCooldownOk(trigger)) this.sendChat(menuChatText(this.cfg.bitsMenu, chatLocale(this.cfg), this.allActionsById()));
      return;
    }
    const cmd = this.cfg.chat.commands.find((c) => c.enabled && c.trigger === trigger);
    if (cmd && this.chatCooldownOk(trigger)) this.sendChat(cmd.response);
  }

  // ---------- Einlösungen ----------
  async onRedemption(ev) {
    if (ev.status && ev.status !== 'unfulfilled') return;
    const actionId = this.rewardMap[ev.reward?.id];
    const action = actionId && this.actions.byId.get(actionId);
    if (!action) {
      logger.info(`Einlösung "${ev.reward?.title}" gehört nicht zu diesem Programm und wird ignoriert.`);
      return;
    }
    const cat = withOverrides(action, this.actions.categories[action.category]);
    const item = {
      redemptionId: ev.id, rewardId: ev.reward.id, userId: ev.user_id,
      user: clean(ev.user_name || ev.user_login, 40) || 'Unbekannt',
      action, cat, queuedAt: Date.now(), test: null,
    };
    const dbId = this.db.record({
      redemptionId: ev.id, userId: item.userId, userName: item.user, rewardId: item.rewardId,
      actionId: action.id, category: action.category, cost: Number(ev.reward.cost) || action.cost,
    });
    if (dbId === null) return; // doppelt zugestellt
    item.dbId = dbId;

    if (this.isBlocked(item.userId)) return this.reject(item, 'Zuschauer ist gesperrt');
    if (!action.enabled) return this.reject(item, 'Aktion ist deaktiviert');
    if (this.paused) return this.reject(item, 'ChaosCore ist gerade pausiert');
    if (!(await this.checkAccess(action, item.userId))) return this.reject(item, accessDeniedReason(action.access));
    if (this.db.userCount(item.userId, action.category) >= cat.perUser) return this.reject(item, 'Limit pro Zuschauer erreicht');
    if (Date.now() < (this.cool.get(coolKey(action)) || 0)) return this.reject(item, 'Cooldown läuft noch');

    // schnelle Spur für reine Overlay-Meldungen - braucht keine
    // Warteschlangen-Länge, blockiert nichts und wartet auf nichts.
    if (isOverlayOnly(action)) {
      this.db.set(dbId, 'queued');
      this.lastActivityAt = Date.now();
      logger.info(`${item.user} löst "${action.title}" aus (schnelle Spur).`);
      this.emitState();
      this.runFast(item).catch((e) => logger.error(`Schnelle Spur fehlgeschlagen: ${e.stack || e.message}`));
      return;
    }

    if (this.queue.length >= this.cfg.engine.maxQueue) {
      const waitSec = this.cfg.engine.queueWaitSec || 0;
      if (!waitSec || !(await this.waitForQueueSlot(real(waitSec * 1000)))) {
        return this.reject(item, waitSec ? 'Warteschlange war zu lange voll' : 'Warteschlange ist voll');
      }
    }

    this.db.set(dbId, 'queued');
    this.queue.push(item);
    this.lastActivityAt = Date.now(); // echte Einlösung setzt den Auto-Lebendig-Ruhe-Timer zurück
    logger.info(`${item.user} löst "${action.title}" aus (Queue: ${this.queue.length}).`);
    this.emitState();
    this.kick();
  }

  // ---------- Bits-Cheers ----------
  // Bits haben keinen eigenen Twitch-"Reward": jeder beliebige Cheer-Betrag ist möglich.
  // Wir lösen die höchste Bits-Stufe aus, die der Betrag erreicht (z. B. 750 Bits bei Stufen
  // 100/300/500/1000 -> Stufe 500). Bits sind nicht erstattbar (keine Twitch-API dafür), darum
  // gibt es anders als bei Kanalpunkten keinen setStatus/CANCELED-Aufruf.
  async onCheer(ev) {
    const bits = Number(ev.bits) || 0;
    if (bits <= 0) return;
    if (this.cfg.bitsMenu?.enabled) return this.onCheerMenu(ev, bits);
    this.tallyBits(ev.is_anonymous ? 'Anonym' : clean(ev.user_name || ev.user_login, 40), bits);
    if (!this.bitsActions) return; // Bits-Belohnungen noch nicht geladen/aktiviert
    const candidates = this.bitsActions.list.filter((a) => a.enabled && a.cost <= bits);
    if (!candidates.length) return; // keine Stufe erreicht, z. B. 50 Bits bei Mindeststufe 100
    const action = candidates.reduce((best, a) => (a.cost > best.cost ? a : best));
    const cat = withOverrides(action, this.bitsActions.categories[action.category]);
    const userId = ev.is_anonymous ? null : (ev.user_id || null);
    const item = {
      userId, user: clean(ev.is_anonymous ? 'Anonym' : (ev.user_name || ev.user_login), 40) || 'Unbekannt',
      action, cat, queuedAt: Date.now(), test: null, bits,
    };
    const dbId = this.db.record({
      redemptionId: `bits_${userId || 'anon'}_${Date.now()}_${bits}`,
      userId: userId || 'anon', userName: item.user, rewardId: null,
      actionId: action.id, category: action.category, cost: bits,
    });
    if (dbId === null) return; // doppelt zugestellt
    item.dbId = dbId;
    item.creditId = this.db.creditAdd({ userId, userName: item.user, kind: 'tier', effectId: action.id, bits });
    if (this.isBlocked(userId)) return this.reject(item, 'Zuschauer ist gesperrt', 'refunded', { manual: true, silent: true });

    if (this.paused) return this.reject(item, 'ChaosCore ist gerade pausiert');
    if (!(await this.checkAccess(action, userId))) return this.reject(item, accessDeniedReason(action.access), 'refunded', { manual: true });
    if (userId && this.db.userCount(userId, action.category) >= cat.perUser) return this.reject(item, 'Limit pro Zuschauer erreicht', 'refunded', { manual: true });
    if (Date.now() < (this.cool.get(coolKey(action)) || 0)) return this.reject(item, 'Cooldown läuft noch');

    // schnelle Spur für reine Overlay-Meldungen, siehe onRedemption().
    if (isOverlayOnly(action)) {
      this.db.set(dbId, 'queued');
      this.lastActivityAt = Date.now();
      logger.info(`${item.user} cheert ${bits} Bits -> "${action.title}" (schnelle Spur).`);
      this.emitState();
      this.runFast(item).catch((e) => logger.error(`Schnelle Spur fehlgeschlagen: ${e.stack || e.message}`));
      return;
    }

    if (this.queue.length >= this.cfg.engine.maxQueue) {
      const waitSec = this.cfg.engine.queueWaitSec || 0;
      if (!waitSec || !(await this.waitForQueueSlot(real(waitSec * 1000)))) {
        return this.reject(item, waitSec ? 'Warteschlange war zu lange voll' : 'Warteschlange ist voll');
      }
    }

    this.db.set(dbId, 'queued');
    this.queue.push(item);
    this.lastActivityAt = Date.now(); // echte Einlösung setzt den Auto-Lebendig-Ruhe-Timer zurück
    logger.info(`${item.user} cheert ${bits} Bits -> "${action.title}" (Queue: ${this.queue.length}).`);
    this.emitState();
    this.kick();
  }

  // Bits-Menü: Stichwort wählt den Effekt, die Menge die Dauer (bits-menu.js). Bits lassen sich
  // nicht erstatten - darum keine Cooldown- und Limit-Sperren: wer bezahlt, bekommt seine Zeit,
  // notfalls etwas später. Mehr als maxMinutes am Stück wird zu weiteren Blöcken in der Warteliste.
  allActionsById() {
    return new Map([...(this.actions?.list || []), ...(this.bitsActions?.list || [])].map((a) => [a.id, a]));
  }

  // Bits-Einheiten in diesem Stream (für die Obergrenze pro Stream).
  streamUnits() {
    const s = this.db.session();
    if (this.bmStream?.session !== s) this.bmStream = { session: s, units: 0 };
    return this.bmStream;
  }

  // Ein Bits-Menü-Eintrag als Warteschlangen-Element (auch für Guthaben und den Gemeinschaftstopf).
  makeMenuItem({ userId, user, key, units, unit, seq = null, bits = 0 }) {
    const kind = key.startsWith('act:') ? 'action' : 'template';
    const id = kind === 'action' ? key.slice(4) : key;
    const cat = this.bitsActions?.categories?.bits || { cooldownSec: 0, perUser: 1000, chaos: 10, color: '#F4B400' };
    const bm = { key, id, kind, unit, minutes: units, part: 0, seq };
    if (unit === 'minute') bm.remainingMs = units * 60000; else bm.remaining = units;
    const title = kind === 'action' ? (this.allActionsById().get(id)?.title || id) : templateTitle(id, chatLocale(this.cfg));
    return { userId, user, action: { id: `bitsmenu_${id}`, title, flavor: '', category: 'bits', requires: ['live'], effect: {} }, cat, queuedAt: Date.now(), test: null, bits, bitsMenu: bm };
  }

  async onCheerMenu(ev, bits) {
    const menu = this.cfg.bitsMenu;
    const userId = ev.is_anonymous ? null : (ev.user_id || null);
    const user = clean(ev.is_anonymous ? 'Anonym' : (ev.user_name || ev.user_login), 40) || 'Unbekannt';
    const actionsById = this.allActionsById();
    const plan = planCheer(menu, bits, typeof ev.message === 'string' ? ev.message : ev.message?.text, Math.random, actionsById);
    this.tallyBits(user, bits);
    if (plan.pot) { this.addToPot(plan.pot, user); return; }
    if (!plan.blocks.length) { logger.info(`${user} cheert ${bits} Bits - kein Bits-Menü-Effekt (zu wenig Bits oder kein Stichwort).`); return; }
    const locale = chatLocale(this.cfg);
    // Prüfen, ob der Effekt mit der aktuellen Tastenbelegung überhaupt geht (anderes Spiel-Profil).
    const first = plan.blocks[0];
    try {
      if (first.kind === 'template' && !BITS_MENU_TEMPLATES[first.id].challenge) compile(menuAction(first.id, 1000, 1, locale, { unit: first.unit, seq: first.seq }).effect.steps, this.cfg.keys, { critical: this.cfg.input?.criticalKeys || [] });
      if (first.kind === 'action' && !actionsById.get(first.id)) throw new Error('Effekt existiert nicht mehr');
    } catch (e) { logger.error(`Bits-Menü-Effekt "${first.key}" geht nicht: ${e.message}`); return; }
    const cap = menu.maxPerStream > 0 ? this.streamUnits() : null;
    for (const [i, block] of plan.blocks.entries()) {
      let units = block.units;
      if (cap) {
        const free = Math.max(0, menu.maxPerStream - cap.units);
        if (free < units) {
          // Obergrenze pro Stream erreicht: der Rest geht in den Gemeinschaftstopf statt verloren.
          const price = Math.max(1, Math.floor(bits / plan.blocks.reduce((n, b) => n + b.units, 0)));
          if (menu.pot.enabled) this.addToPot((units - free) * price, user);
          logger.info(`Bits-Menü: Obergrenze pro Stream erreicht (${menu.maxPerStream}) - ${units - free} Einheit(en) von ${user} ${menu.pot.enabled ? 'gehen in den Gemeinschaftstopf' : 'verfallen'}.`);
          units = free;
        }
        cap.units += units;
      }
      if (units < 1) continue;
      const item = this.makeMenuItem({ userId, user, key: block.key, units, unit: block.unit, seq: block.seq, bits: i === 0 ? bits : 0 });
      const dbId = this.db.record({
        redemptionId: `bits_${userId || 'anon'}_${Date.now()}_${bits}_${i}`, userId: userId || 'anon', userName: user, rewardId: null,
        actionId: item.action.id, category: 'bits', cost: i === 0 ? bits : 0,
      });
      if (dbId === null) return;
      item.dbId = dbId;
      item.creditId = this.db.creditAdd({ userId, userName: user, kind: 'menu', effectId: block.key, minutes: units, unit: block.unit,
        remainingMs: block.unit === 'minute' ? units * 60000 : units, bits: i === 0 ? bits : 0 });
      if (this.isBlocked(userId)) { await this.reject(item, 'Zuschauer ist gesperrt', 'refunded', { manual: true, silent: true }); continue; }
      if (this.paused) { await this.reject(item, 'ChaosCore ist gerade pausiert'); continue; }
      this.db.set(dbId, 'queued');
      this.queue.push(item);
      if (block.seq) this.sendChat(locale === 'en' ? `🎰 ${user}'s chaos roulette: ${rouletteText(block.seq, locale)}` : `🎰 Chaos-Roulette von ${user}: ${rouletteText(block.seq, locale)}`);
      logger.info(`${user} cheert ${bits} Bits -> Bits-Menü "${item.action.title}" (${units} ${block.unit})${block.chosenBy === 'random' ? ' (zufällig, kein Stichwort)' : ''}.`);
    }
    this.lastActivityAt = Date.now();
    this.emitState();
    this.kick();
  }

  // Bits pro Zuschauer in diesem Stream (für "Top-Cheerer" im Overlay).
  tallyBits(user, bits) {
    const s = this.db.session();
    if (this.bitsTally?.session !== s) this.bitsTally = { session: s, by: {} };
    if (user && user !== 'Anonym') this.bitsTally.by[user] = (this.bitsTally.by[user] || 0) + bits;
  }

  // Was die Bits-Bühne im Overlay zeigt: der laufende bezahlte Effekt mit Restzeit über ALLE
  // Abschnitte hinweg, und der Top-Cheerer des Streams.
  bitsStage() {
    const c = this.current;
    let current = null;
    const bm = c?.item?.bitsMenu;
    if (bm && c.item.user && !c.item.test) {
      const title = bm.kind === 'action' ? (this.allActionsById().get(bm.id)?.title || bm.id) : templateTitle(bm.id, chatLocale(this.cfg));
      current = { user: c.item.user, title, unit: bm.unit || 'minute', community: c.item.user === 'Community' && !c.item.userId };
      if ((bm.unit || 'minute') === 'minute') {
        const chunkLeft = c.endsAt ? Math.max(0, c.endsAt - Date.now()) : (bm.chunkMs || 0);
        current.leftMs = Math.max(0, bm.remainingMs - (bm.chunkMs || 0)) + chunkLeft / TIME_SCALE;
        current.totalMs = (bm.minutes || 1) * 60000;
        current.endsAt = Date.now() + current.leftMs * TIME_SCALE;
      } else { current.left = bm.remaining; current.total = bm.minutes; }
    }
    const by = this.bitsTally?.session === this.db.session() ? this.bitsTally.by : {};
    const topEntry = Object.entries(by).sort((a, b) => b[1] - a[1])[0];
    return { current, top: topEntry ? { name: topEntry[0], bits: topEntry[1] } : null };
  }

  // ---------- Gemeinschaftstopf ----------
  get pot() {
    if (!this._pot) this._pot = this.db.kvGet('bits_pot') || { bits: 0, top: {} };
    return this._pot;
  }

  addToPot(bits, user) {
    const cfg = this.cfg.bitsMenu.pot;
    if (!cfg?.enabled || !(bits > 0)) return;
    const pot = this.pot;
    pot.bits += bits;
    pot.top[user] = (pot.top[user] || 0) + bits;
    logger.info(`Gemeinschaftstopf: ${user} gibt ${bits} Bits dazu (${pot.bits}/${cfg.goal}).`);
    this.fx('pot', { user, bits, have: pot.bits, goal: cfg.goal });
    while (pot.bits >= cfg.goal) {
      pot.bits -= cfg.goal;
      const names = Object.entries(pot.top).sort((a, b) => b[1] - a[1]).map(([n]) => n);
      pot.top = {};
      const loc = chatLocale(this.cfg);
      const item = this.makeMenuItem({ userId: null, user: 'Community', key: cfg.effect, units: cfg.minutes, unit: 'minute' });
      item.dbId = this.db.record({ redemptionId: `pot_${Date.now()}_${Math.random()}`, userId: 'anon', userName: 'Community', rewardId: null, actionId: item.action.id, category: 'bits', cost: 0 });
      this.db.set(item.dbId, 'queued');
      item.creditId = this.db.creditAdd({ userId: null, userName: 'Community', kind: 'menu', effectId: cfg.effect, minutes: cfg.minutes, unit: 'minute', remainingMs: cfg.minutes * 60000 });
      this.queue.push(item);
      const who = names.slice(0, 5).join(', ');
      this.sendChat(loc === 'en' ? `🎉 Community pot is full! Thanks ${who} - ${cfg.minutes} min ${templateTitle(cfg.effect, loc)}!` : `🎉 Der Gemeinschaftstopf ist voll! Danke ${who} - ${cfg.minutes} Min. ${templateTitle(cfg.effect, loc)}!`);
      this.fx('pot_full', { names: names.slice(0, 5), effect: templateTitle(cfg.effect, loc), minutes: cfg.minutes });
      logger.info(`Gemeinschaftstopf voll: ${cfg.minutes} Min. "${templateTitle(cfg.effect, loc)}" (Danke ${who}).`);
      this.kick();
    }
    this.db.kvSet('bits_pot', pot);
    this.emitState();
  }

  // ---------- Herausforderung (Bits-Menü) ----------
  // Der Streamer bekommt eine Aufgabe mit Zeitlimit, z. B. "3 Kills in 5 Minuten" - gezählt über den
  // Spielzustand (CS2). Kein Tasten-Effekt; läuft über Runden hinweg weiter.
  async runChallenge(item) {
    const c = this.cfg.bitsMenu.challenge;
    const loc = chatLocale(this.cfg);
    const g0 = this.gsi.get();
    if (!g0.connected) return { ok: false, reason: 'Braucht die CS2-Verbindung (GSI)' };
    const endsAt = Date.now() + real(c.minutes * 60000);
    const ch = { user: item.user, goal: c.kills, have: 0, weapon: c.weapon, endsAt, startedAt: Date.now(), result: null };
    this.challenge = ch;
    this.current.endsAt = endsAt;
    // Überspringen beendet die Herausforderung; Tod und Rundenende nicht.
    this.current.handle = { stop: () => { if (this.current?.stopReason !== 'Übersprungen') { this.current.aborted = false; this.current.stopReason = null; } }, hardStop: () => {} };
    const want = { pistol: 'Pistol', knife: 'Knife' }[c.weapon] || null;
    let lastKills = g0.kills ?? 0;
    const onChange = (now, prev) => {
      if (now.kills === null || now.kills === undefined) return;
      if (now.kills > lastKills) {
        const n = now.kills - lastKills;
        if (!want || (prev.activeType || now.activeType) === want) { ch.have = Math.min(ch.goal, ch.have + n); this.fx('challenge', { ...ch }); this.emitState(); }
      }
      lastKills = now.kills;
    };
    this.gsi.on('change', onChange);
    this.fx('challenge', { ...ch });
    this.sendChat(loc === 'en' ? `🎯 Challenge from ${item.user}: ${c.kills} kills in ${c.minutes} min${want ? ` (${c.weapon} only)` : ''} - go!` : `🎯 Herausforderung von ${item.user}: ${c.kills} Kills in ${c.minutes} Min.${want ? ` (nur ${c.weapon === 'pistol' ? 'Pistole' : 'Messer'})` : ''} - los!`);
    try {
      while (Date.now() < endsAt && ch.have < ch.goal) {
        if (this.current?.aborted || this.closed) break;
        await sleep(250);
      }
    } finally { this.gsi.off('change', onChange); }
    const aborted = this.current?.aborted;
    ch.result = ch.have >= ch.goal ? 'won' : 'lost';
    if (!aborted) {
      this.fx('challenge', { ...ch });
      this.sendChat(ch.result === 'won'
        ? (loc === 'en' ? `💪 Challenge done: ${ch.have}/${ch.goal} kills!` : `💪 Herausforderung geschafft: ${ch.have}/${ch.goal} Kills!`)
        : (loc === 'en' ? `😈 Challenge failed (${ch.have}/${ch.goal}) - point to ${item.user}!` : `😈 Herausforderung verloren (${ch.have}/${ch.goal}) - Punkt für ${item.user}!`));
      this.emit('moment', { type: 'challenge', user: item.user, result: ch.result, have: ch.have, goal: ch.goal, minutes: c.minutes, weapon: c.weapon, ms: Date.now() - ch.startedAt });
      logger.info(`Herausforderung von ${item.user}: ${ch.result === 'won' ? 'geschafft' : 'verloren'} (${ch.have}/${ch.goal}).`);
    }
    setTimeout(() => { if (this.challenge === ch) { this.challenge = null; this.emitState(); } }, real(8000)).unref?.();
    return { ok: true };
  }

  // Testlauf eines noch nicht gespeicherten Effekts aus dem Editor (schon geprüft, siehe server.js).
  enqueueTestAction(action, { dry = true } = {}) {
    if (this.queue.length >= this.cfg.engine.maxQueue) throw new Error('Warteschlange ist voll');
    const cat = this.actions.categories[action.category] || Object.values(this.actions.categories)[0];
    this.queue.push({ user: 'TEST', action: { ...action, enabled: true }, cat, queuedAt: Date.now(), test: { dry } });
    this.emitState();
    this.kick();
  }

  // Testlauf aus dem Dashboard. dry = nur Overlay, keine Tasten. Sucht in Kanalpunkte- UND Bits-Aktionen.
  enqueueTest(actionId, { dry = true } = {}) {
    let action = this.actions.byId.get(actionId);
    let cat = action && this.actions.categories[action.category];
    if (!action && this.bitsActions) {
      action = this.bitsActions.byId.get(actionId);
      cat = action && this.bitsActions.categories[action.category];
    }
    if (!action) throw new Error('Unbekannte Aktion');
    if (this.queue.length >= this.cfg.engine.maxQueue) throw new Error('Warteschlange ist voll');
    this.queue.push({ user: 'TEST', action, cat, queuedAt: Date.now(), test: { dry } });
    this.emitState();
    this.kick();
  }

  async reject(item, reason, status = 'refunded', { manual = false, silent = false } = {}) {
    logger.warn(`${item.user}: "${item.action.title}" nicht ausgeführt (${reason}).`);
    if (item.dbId) this.db.set(item.dbId, status, { reason, finished: Date.now() });
    if (item.creditId) this.keepCredit(item, reason, manual, silent);
    if (!item.test && !item.system) { // system: von UNKNOWN selbst ausgelöst (Chaos-Overload), keine Twitch-Einlösung dahinter
      if (this.cfg.engine.autoRefund && !item.bits && !item.bitsMenu) await this.setStatus(item, 'CANCELED');
      this.fx('rejected', { user: item.user, title: item.action.title, reason, bits: isBitsItem(item) });
    }
  }

  async setStatus(item, status) {
    try { await this.twitch.setRedemption(item.redemptionId, item.rewardId, status); }
    catch (e) { logger.error(`Twitch-Status ${status} für ${item.user} fehlgeschlagen: ${e.message}`); }
  }

  // Nach einem Absturz liegen gebliebene Einlösungen erstatten (nur eigene Rewards).
  async recover() {
    let n = 0;
    // Praxistest 15.11.: eine fehlende Belohnung ("reward not found") ergab vorher je Belohnung
    // eine eigene Warnung bei jedem Start. Jetzt eine einzige Zeile mit allen betroffenen.
    const unreadable = [];
    for (const rid of Object.keys(this.rewardMap)) {
      let list = [];
      try { list = await this.twitch.listRedemptions(rid); } catch (e) { unreadable.push({ rid, msg: e.message }); continue; }
      for (const r of list) {
        try { await this.twitch.setRedemption(r.id, rid, 'CANCELED'); n++; } catch { /* egal */ }
      }
    }
    if (unreadable.length) {
      const names = unreadable.map((u) => this.actions.byId.get(this.rewardMap[u.rid])?.title || this.rewardMap[u.rid]).join(', ');
      logger.warn(`Offene Einlösungen nicht lesbar für ${unreadable.length} Belohnung(en): ${names} (${unreadable[0].msg}). Meist fehlen sie auf Twitch - im Dashboard „Belohnungen mit Twitch abgleichen" klicken.`);
    }
    if (n) logger.info(`${n} offene Einlösung(en) aus der Zwischenzeit erstattet.`);
    return n;
  }

  // Letzte erledigte Einlösungen (auch nach einem Neustart), neueste zuerst
  loadHistory() {
    return this.db.recentDone(10).map((r) => {
      const a = this.actions.byId.get(r.actionId);
      return a ? { user: r.user, title: a.title, color: this.actions.categories[a.category]?.color, ts: r.ts } : null;
    }).filter(Boolean);
  }

  // ---------- Prüfung des Spielzustands ----------
  // Spielmodus gesperrt (z. B. Competitive mit fremden Mitspielern)? Gibt den Modus zurück oder null.
  blockedMode() {
    const lock = this.cfg.modeLock;
    const mode = this.gsi.get().mode;
    return lock?.enabled && mode && lock.blocked.includes(mode) ? mode : null;
  }

  evaluate(action) {
    const req = action.requires || ['live'];
    const g = this.gsi.get();
    if (this.blockedMode()) return 'blocked';
    if (!g.connected) {
      if (this.cfg.game.requireGameState) return 'wait';
      if (req.some((r) => ['grenade', 'primary', 'flash'].includes(r))) return 'needs_gsi';
      return 'ok';
    }
    if (req.includes('live') && !g.live) return 'wait';
    if (req.includes('primary') && !g.primary) return 'wait';
    if (req.includes('grenade') && !g.grenades.length) return 'wait';
    if (req.includes('flash') && !g.grenades.includes('weapon_flashbang')) return 'wait';
    return 'ok';
  }

  // ---------- Warteschlange ----------
  kick() {
    this.loop().catch((e) => {
      logger.error(`Queue-Fehler: ${e.stack || e.message}`);
      // Nicht stehen bleiben: nach einem unerwarteten Fehler läuft die Warteliste weiter.
      if (!this.closed) setTimeout(() => this.kick(), 1000).unref?.();
    });
  }

  async loop() {
    if (this.looping) return;
    this.looping = true;
    try {
      while (this.queue.length && !this.closed) {
        if (this.paused) { await sleep(300); continue; }
        this.arrange();
        const item = this.queue[0];
        const ready = await this.waitReady(item);
        if (ready === 'removed') continue;
        this.queue.shift();
        if (ready !== 'ok') {
          await this.reject(item, ready === 'needs_gsi' ? 'Braucht die CS2-Verbindung (GSI)' : ready === 'blocked' ? `Effekte sind im Spielmodus „${this.blockedMode() || ''}“ aus` : 'Kein passender Spielmoment', 'refunded');
          this.emitState();
          continue;
        }
        await this.execute(item);
      }
    } finally { this.looping = false; }
  }

  async waitReady(item) {
    // Bits-Menü: bezahlte Zeit wartet bis zu 10 Minuten auf die nächste laufende Runde.
    const deadline = Date.now() + real(item.bitsMenu ? 600000 : this.cfg.engine.holdTimeoutSec * 1000);
    for (;;) {
      this.arrange();
      if (this.queue[0] !== item || this.closed) return 'removed';
      let r = item.test ? 'ok' : this.evaluate(item.action);
      if (item.bitsMenu?.id === 'challenge' && r === 'needs_gsi') r = 'needs_gsi';
      if (r === 'ok' && item.bitsMenu && Date.now() < (this.cool.get(`bm:${item.bitsMenu.key}`) || 0)) r = 'wait'; // Cooldown des Menüpunkts
      if (r === 'ok' || r === 'needs_gsi' || r === 'blocked') return r;
      if (Date.now() > deadline) return 'timeout';
      await sleep(500);
    }
  }

  // statt bei voller Warteschlange sofort zu erstatten, optional bis zu
  // "ms" auf einen freien Platz warten (Streamer-Einstellung, Standard 0 = altes Verhalten).
  async waitForQueueSlot(ms) {
    const deadline = Date.now() + ms;
    while (this.queue.length >= this.cfg.engine.maxQueue) {
      if (this.closed) return false;
      if (Date.now() > deadline) return false;
      await sleep(500);
    }
    return true;
  }

  // die "schnelle Spur" für reine Overlay-Meldungen ohne Tastendruck -
  // läuft unabhängig von this.queue/this.current, wartet also nie auf einen laufenden echten
  // Spiel-Effekt und blockiert ihn auch nicht. Darf deshalb NICHT this.current verwenden (das
  // würde einen parallel laufenden echten Effekt mitten in seiner Tasten-Ausführung überschreiben).
  async runFast(item) {
    const { action, cat } = item;
    const eff = action.effect || {};
    if (item.dbId) this.db.set(item.dbId, 'running', { started: Date.now() });
    try {
      if (eff.overlay) {
        const choice = pick(eff.options);
        this.fx('route', { options: eff.options, pick: choice, ms: eff.displayMs });
        this.emitState();
        await sleep(eff.displayMs);
      } else {
        this.fx('alert', { user: item.user, title: action.title, flavor: action.flavor, color: cat.color, test: !!item.test, fast: true });
        this.emitState();
      }
    } catch (e) {
      logger.error(`Schnelle Spur "${action.id}" fehlgeschlagen: ${e.message}`);
      await this.reject(item, e.message || 'Effekt fehlgeschlagen', 'failed');
      return;
    }
    await this.finish(item);
    this.fx('effect_end', {});
    this.emitState();
  }

  // ---------- Ausführung ----------
  async execute(item) {
    const bm = item.bitsMenu;
    if (bm) {
      const locale = chatLocale(this.cfg);
      bm.unit ??= 'minute'; bm.key ??= bm.id; bm.kind ??= 'template';
      if (bm.kind === 'action') {
        const src = this.allActionsById().get(bm.id);
        if (!src) { await this.reject(item, 'Der Effekt aus dem Bits-Menü gibt es nicht mehr', 'failed', { manual: true }); this.emitState(); return; }
        item.action = { ...src, title: bm.minutes > 1 ? `${src.title} · ${bm.part + 1}/${bm.minutes}` : src.title, flavor: src.flavor || (locale === 'en' ? 'bought with Bits' : 'mit Bits gekauft') };
      } else if (bm.unit === 'minute') {
        // Abschnitt von höchstens einer Minute; der Rest kommt danach wieder vorne in die Warteliste.
        bm.chunkMs = Math.min(bm.remainingMs, CHUNK_MS);
        const a = menuAction(bm.id, bm.chunkMs, bm.minutes, locale, { part: bm.part, seq: bm.seq });
        if (bm.seq) a.title = `${a.title}: ${templateTitle(bm.seq[bm.part] || bm.seq.at(-1), locale)}`;
        const left = Math.ceil(bm.remainingMs / 1000);
        a.title = bm.part === 0 ? `${a.title} · ${bm.minutes} ${locale === 'en' ? 'min' : 'Min.'}`
          : `${a.title} · ${locale === 'en' ? 'still' : 'noch'} ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
        item.action = a;
      } else {
        const a = menuAction(bm.id, CHUNK_MS, bm.minutes, locale, { unit: bm.unit, part: bm.part, seq: bm.seq });
        if (bm.minutes > 1) a.title = `${a.title} · ${bm.unit === 'round' ? (locale === 'en' ? 'round' : 'Runde') : ''} ${bm.part + 1}/${bm.minutes}`.replace('  ', ' ');
        item.action = a;
      }
    }
    const { action, cat } = item;
    const now = Date.now();
    this.current = { item, title: action.title, user: item.user, color: cat.color, flavor: action.flavor, startedAt: now, endsAt: null, untilStop: false, handle: null };
    if (item.dbId) this.db.set(item.dbId, 'running', { started: now });
    // Bits bekommen einen größeren Auftritt - der Betrag nur beim ersten Abschnitt eines Kaufs.
    this.fx('alert', { user: item.user, title: action.title, flavor: action.flavor, color: cat.color, test: !!item.test,
      bits: isBitsItem(item) ? (bm?.part > 0 ? -1 : (item.bits || 0)) : 0, community: item.user === 'Community' && !item.userId });
    // System-Aktionen (Experte) hängen an echten Auslösungen durch Zuschauer - nicht an Tests oder
    // ChaosCore-eigenen Effekten, und bei mehrteiligen Bits-Käufen nur am ersten Abschnitt.
    if (!item.test && !item.system && !(bm?.part > 0)) this.emit('started', { actionId: bm ? bm.id : action.id, user: item.user, title: action.title });
    this.emitState();
    if (item.test && !item.test.dry) { // echter Test: Zeit zum Wechseln ins Spiel
      this.fx('countdown', { seconds: 5 });
      await sleep(5000);
    }

    // Session Stats: Effekte mit echten Spiel-Eingaben merken, damit ein Tod währenddessen (oder kurz
    // danach) dem Zuschauer zugeordnet werden kann. Dashboard-Tests (trocken oder echt) zählen nicht - nur echte Auslösungen.
    const statFx = this.stats && !item.test
      ? this.stats.effectStart({ userId: item.userId, user: item.user, actionId: action.id, title: action.title, system: !!item.system }) : null;
    let res;
    const runStart = Date.now();
    try { res = bm?.id === 'challenge' && bm.kind === 'template' ? await this.runChallenge(item) : await this.runAction(item, action); }
    catch (e) { logger.error(`Effekt "${action.id}" fehlgeschlagen: ${e.message}`); res = { ok: false, reason: e.message }; }
    if (statFx) this.stats.effectEnd(statFx);
    const wasPanic = this.current?.panicked;
    const stopReason = this.current?.stopReason || null;
    this.current = null;

    if (bm && bm.unit !== 'minute') {
      // Runden / einmalig: eine Einheit ist verbraucht, wenn der Effekt regulär zu Ende lief
      // (Runde vorbei oder Tod zählt als gespielte Runde). Unterbrochen (Menü, Fokus) = nochmal.
      const counted = res.ok && !wasPanic && (stopReason === null || stopReason === 'Runde vorbei' || stopReason === 'Spieler gestorben');
      if (counted) bm.remaining--;
      if (wasPanic || !res.ok || stopReason === 'Übersprungen') {
        if (stopReason === 'Übersprungen' && !wasPanic && res.ok && bm.remaining > 0) { await this.reject(item, 'Vom Streamer übersprungen', 'refunded', { manual: true }); this.fx('effect_end', {}); this.emitState(); await sleep(1200); return; }
      } else if (bm.remaining > 0) {
        bm.part++;
        if (item.creditId) this.db.creditRemaining(item.creditId, bm.remaining);
        this.queue.unshift(item);
        this.fx('effect_end', {});
        this.emitState();
        await sleep(1200);
        return;
      }
    } else if (bm && (wasPanic || !res.ok || stopReason === 'Übersprungen')) {
      // Abgebrochen: gelaufene Zeit abziehen, der Rest wird unten als Guthaben gespeichert.
      bm.remainingMs = Math.max(0, bm.remainingMs - Math.min(bm.chunkMs, (Date.now() - runStart) / TIME_SCALE));
      if (stopReason === 'Übersprungen' && !wasPanic && res.ok) {
        if (bm.remainingMs >= 2000) { await this.reject(item, 'Vom Streamer übersprungen', 'refunded', { manual: true }); this.fx('effect_end', {}); this.emitState(); await sleep(1200); return; }
      }
    } else if (bm) {
      // Unterbrochen (Tod, Rundenende, Menü): nur die tatsächlich gelaufene Zeit abziehen.
      const used = stopReason ? Math.min(bm.chunkMs, (Date.now() - runStart) / TIME_SCALE) : bm.chunkMs;
      bm.remainingMs = Math.max(0, bm.remainingMs - used);
      bm.part++;
      if (bm.remainingMs >= 2000) {
        if (item.creditId) this.db.creditRemaining(item.creditId, bm.remainingMs);
        this.queue.unshift(item);
        logger.info(`Bits-Menü: ${item.user} hat noch ${Math.round(bm.remainingMs / 1000)} s "${action.title}" gut.`);
        this.fx('effect_end', {});
        this.emitState();
        await sleep(1200);
        return;
      }
    }

    if (wasPanic) await this.reject(item, 'Not-Aus ausgelöst', 'failed', { manual: true });
    else if (!res.ok) await this.reject(item, res.reason || 'Effekt fehlgeschlagen', 'failed');
    else await this.finish(item);
    if (isBitsItem(item)) this.bitsStreak++;
    else if (!item.system && !item.test) this.bitsStreak = 0;
    this.fx('effect_end', {});
    this.emitState();
    await sleep(1200); // kurze Atempause zwischen Effekten
  }

  async finish(item) {
    const { action, cat } = item;
    this.cool.set(coolKey(action), Date.now() + real(cat.cooldownSec * 1000));
    const bmItem = item.bitsMenu && [...this.cfg.bitsMenu.items, ...this.cfg.bitsMenu.custom.map((c) => ({ ...c, id: `act:${c.actionId}` }))].find((x) => x.id === item.bitsMenu.key);
    if (bmItem?.cooldownSec) this.cool.set(`bm:${item.bitsMenu.key}`, Date.now() + real(bmItem.cooldownSec * 1000));
    // system-Effekte (UNKNOWN-Overload, Auto-Lebendig) zählen
    // bewusst NICHT fürs Community-Ziel: sonst könnte eine fest konfigurierte Schwellen-Aktion, deren
    // eigene Kategorie-Chaos-Menge die Schwelle selbst schon erreicht/überschreitet, sich durch ihre
    // eigene Auslösung immer wieder selbst neu auslösen (Endlosschleife). Trockentests (item.test)
    // zählen weiterhin bewusst mit (siehe Chaos-Overload-Test) - nur system ist hier ausgenommen.
    const weight = item.bitsMenu ? item.bitsMenu.minutes : 1; // Bits-Menü: jede gekaufte Minute zählt
    if (!item.system) this.addChaos(cat.chaos * weight, !!item.bits || !!item.bitsMenu);
    if (item.test || item.system) return; // system: UNKNOWN-/ChaosCore-Effekt, keine Einlösung/Zuschauer zum Verbuchen
    if (item.creditId) { this.db.creditDelete(item.creditId); item.creditId = null; this.refreshCredits(); }
    this.db.set(item.dbId, 'done', { finished: Date.now() });
    this.checkMilestone(action);
    if (item.userId) { // anonyme Cheers und der Gemeinschaftstopf haben keinen Zuschauer
      this.db.addViewer(item.userId, item.user, cat.chaos * weight);
      this.db.addSeasonViewer(item.userId, item.user, cat.chaos * weight);
    }
    this.season = this.computeSeason();
    const before = { today: this.hallToday[0]?.name, all: this.hall[0]?.name };
    this.hall = this.db.hall(5);
    this.hallToday = this.db.hallToday(5);
    this.announceLeader(before);
    // "ChaosCore meldet sich selbst im Chat" bei eigenen Ereignissen -
    // nur für echte, von einem Zuschauer ausgelöste Effekte (die obige Prüfung auf item.test/
    // item.system hat test/system-Fälle schon vorher verlassen), nicht für Dashboard-Testläufe.
    if (this.cfg.chat?.announceEffect) this.sendChat(CHAT_TEXT.effect[chatLocale(this.cfg)](item.user, action.title));
    this.history.unshift({ user: item.user, title: action.title, color: cat.color, ts: Date.now() });
    this.history.length = Math.min(this.history.length, 10);
    if (!item.bits && !item.bitsMenu) await this.setStatus(item, 'FULFILLED');
    this.contractHave = this.db.distinctViewers();
    const key = `contract_${this.db.session()}`;
    if (this.contractHave >= this.cfg.contract.distinctViewers && !this.db.kvGet(key)) {
      this.db.kvSet(key, true);
      this.fx('contract', { have: this.contractHave });
      logger.info('Daily Contract abgeschlossen.');
    }
  }

  // Neuer Platz 1? Nur wenn es vorher schon einen Spitzenreiter gab und jemand anderes ihn überholt hat.
  announceLeader(before) {
    const now = { today: this.hallToday[0], all: this.hall[0] };
    const changed = (k) => before[k] && now[k] && now[k].name !== before[k];
    const scope = changed('today') ? 'today' : changed('all') ? 'all' : null;
    if (!scope) return;
    logger.info(`Neuer Platz 1 (${scope === 'today' ? 'heute' : 'gesamt'}): ${now[scope].name} überholt ${before[scope]}.`);
    this.fx('newleader', { scope, user: now[scope].name, prev: before[scope], count: now[scope].total });
  }

  // die Schwellen des Community-Ziels, mit Rückfalllösung, falls die
  // Konfiguration (z. B. durch ein altes Preset) einmal leer sein sollte - EXAKT das bisherige
  // Alleinverhalten ("Chaos Overload" bei 100, zufälliger Effekt).
  goalThresholds() {
    const t = this.cfg.communityGoal?.thresholds;
    return t?.length ? t : [{ id: 'overload', name: 'Chaos Overload', value: 100, actionId: null }];
  }

  currentGoalThreshold() {
    const thresholds = this.goalThresholds();
    return thresholds[this.goalIdx % thresholds.length];
  }

  // Fortschritt als Prozent der aktuell dran befindlichen Schwelle (nicht des rohen chaos-Werts) -
  // bei der mitgelieferten Standard-Schwelle (value: 100) ist das exakt derselbe Wert wie bisher.
  goalPercent() {
    const target = this.currentGoalThreshold().value || 100;
    return Math.round(Math.min(100, (this.chaos / target) * 100));
  }

  // isBits: kommt der Beitrag aus einem Bits-Cheer (item.bits) oder aus einer Kanalpunkte-
  // Einlösung/einem Trockentest? Die "basis"-Einstellung des Community-Ziels entscheidet, ob er
  // überhaupt zählt - 'both' (Standard, bisheriges Verhalten) zählt immer beides zusammen.
  addChaos(n, isBits = false) {
    const basis = this.cfg.communityGoal?.basis || 'both';
    if (basis === 'points' && isBits) return;
    if (basis === 'bits' && !isBits) return;
    this.chaos += n;
    const thresholds = this.goalThresholds();
    const idx = this.goalIdx % thresholds.length;
    const th = thresholds[idx];
    if (this.chaos >= th.value) {
      this.chaos = 0;
      this.fx('overload', { name: th.name });
      logger.info(`Community-Ziel "${th.name}" erreicht.`);
      this.triggerGoalEffect(th.actionId);
      this.goalIdx = (idx + 1) % thresholds.length;
    }
  }

  // Das Overlay sagt beim Erreichen der Schwelle "UNKNOWN übernimmt kurz die Kontrolle" — das soll
  // auch wirklich etwas im Spiel auslösen, nicht nur eine Bildschirmmeldung sein. actionId: eine
  // vom Streamer fest gewählte Aktion (Kanalpunkte- oder Bits-Pool) - ohne das (null, der Standard)
  // ein zufälliger, aktuell aktivierter Effekt wie bisher.
  triggerGoalEffect(actionId) {
    if (this.queue.length >= this.cfg.engine.maxQueue) return; // Warteschlange voll: nur die Bildschirmmeldung
    // Nur Effekte mit echter Spiel-Wirkung (Tasten/Steps/dynamisch) — reine Overlay-Meldungen ohne
    // Spiel-Effekt würden das Versprechen "UNKNOWN übernimmt die Kontrolle" nicht einlösen.
    const pool = [...this.actions.list, ...(this.bitsActions?.list || [])]
      .filter((a) => a.enabled && hasGameEffect(a));
    if (!pool.length) return; // nichts aktiviert, womit UNKNOWN etwas anstellen könnte
    const chosen = actionId && pool.find((a) => a.id === actionId);
    const action = chosen || pick(pool); // feste Aktion unbekannt/deaktiviert geworden -> wie bisher zufällig
    const cat = withOverrides(action, this.actions.categories[action.category] || this.bitsActions?.categories?.[action.category]);
    if (!cat) return;
    this.queue.push({ user: 'UNKNOWN', action, cat, queuedAt: Date.now(), test: null, system: true });
    this.emitState();
    this.kick();
  }

  // Raid/Follow/Sub/Hype Train (stream-events.js). ev: { kind, user, userId, amount, gift? }
  // Gibt zurück, was passiert ist ('queued' | Grund), damit Tests und Log es nachvollziehen können.
  onStreamEvent(ev) {
    const conf = this.cfg.events?.[ev.kind];
    if (!conf?.enabled) return 'off';
    if ((ev.amount || 1) < conf.min) return 'below_min';
    // Follow: jeder nur einmal pro Programmstart (Folgen-Entfolgen-Folgen soll nichts auslösen)
    this.followSeen ||= new Set();
    if (ev.kind === 'follow' && ev.userId) {
      if (this.followSeen.has(ev.userId)) return 'repeat';
      this.followSeen.add(ev.userId);
      if (this.followSeen.size > 5000) this.followSeen.delete(this.followSeen.values().next().value);
    }
    if (ev.userId && this.isBlocked(ev.userId)) return 'blocked';
    this.eventCool ||= {};
    const now = Date.now();
    if (now - (this.eventCool[ev.kind] || 0) < real(conf.cooldownSec * 1000)) return 'cooldown';
    if (this.blockedMode()) return 'mode';
    if (this.queue.length >= this.cfg.engine.maxQueue) return 'full';
    const pool = [...this.actions.list, ...(this.bitsActions?.list || [])].filter((a) => a.enabled && hasGameEffect(a));
    const action = (conf.actionId && pool.find((a) => a.id === conf.actionId)) || (pool.length ? pick(pool) : null);
    if (!action) return 'no_action';
    const cat = withOverrides(action, this.actions.categories[action.category] || this.bitsActions?.categories?.[action.category]);
    if (!cat) return 'no_action';
    this.eventCool[ev.kind] = now;
    const who = ev.user || (ev.kind === 'hype' ? 'Hype Train' : 'Community');
    this.queue.push({ user: who, action, cat, queuedAt: now, test: null, system: true, event: ev.kind });
    this.fx('event', { kind: ev.kind, user: who, amount: ev.amount || 1, gift: !!ev.gift, title: action.title });
    logger.info(`${who}: ${ev.kind} löst "${action.title}" aus.`);
    if (ev.kind === 'raid') this.emit('moment', { type: 'raid', user: who, effect: action.title, viewers: ev.amount });
    this.emitState();
    this.kick();
    return 'queued';
  }

  async runAction(item, action) {
    const eff = action.effect || {};
    if (eff.dynamic === 'curse') return this.runCurse(item);
    return this.runBody(item, action);
  }

  async runBody(item, action) {
    const eff = action.effect || {};
    if (eff.overlay) {
      const choice = pick(eff.options);
      this.current.endsAt = Date.now() + real(eff.displayMs);
      this.fx('route', { options: eff.options, pick: choice, ms: eff.displayMs });
      this.emitState();
      await sleep(eff.displayMs);
      return { ok: true };
    }
    let steps = eff.variants ? pick(eff.variants) : eff.steps; // "zufällig einer": bei jeder Einlösung neu gewählt
    if (eff.dynamic === 'utility' || eff.dynamic === 'flash') return this.runThrow(eff.dynamic, item);
    if (!steps || !steps.length) { this.emitState(); return { ok: true }; } // reine Overlay-Meldung ohne Spiel-Effekt (z. B. eigene Belohnung)
    return this.runSteps(item, steps);
  }

  // Wartet, bis die gewünschte Granate wirklich in der Hand ist (laut GSI). name=null: irgendeine Granate.
  async waitHolding(name, ms) {
    const until = Date.now() + Math.max(real(ms), 400);
    while (Date.now() < until) {
      if (this.current?.aborted) return false;
      const g = this.gsi.get();
      if (g.activeType === 'Grenade' && (!name || g.activeName === name)) return true;
      await new Promise((r) => setTimeout(r, 40));
    }
    return false;
  }

  // Granate sicher auswählen und erst dann werfen. Es wird nie mit einer falschen Waffe geklickt.
  //  utility: die nächste Granate im Inventar (Slot-Taste, danach die einzelnen Granaten-Tasten)
  //  flash:   die Blendgranate (deine Taste, Standard 7, danach unser eigener Bind)
  async runThrow(kind, item) {
    const g = this.gsi.get();
    const keys = this.cfg.keys;
    const verify = g.connected && !item.test?.dry;
    if (g.connected && !g.grenades.length) return { ok: false, reason: 'Keine Granate im Inventar' };
    if (g.connected && kind === 'flash' && !g.grenades.includes('weapon_flashbang')) return { ok: false, reason: 'Keine Blendgranate im Inventar' };
    const want = kind === 'flash' ? 'weapon_flashbang' : null;
    const tries = kind === 'flash'
      ? [keys.flash, grenadeBindKey('weapon_flashbang', keys)]
      : [keys.grenades, ...(g.connected ? g.grenades.flatMap((n) => [grenadeKey(n, keys), grenadeBindKey(n, keys)]) : [grenadeBindKey('weapon_flashbang', keys)])];
    let holding = !verify;
    for (const key of [...new Set(tries.filter(Boolean))]) {
      const sel = await this.runSteps(item, [`press ${key}`, 'wait 450']);
      if (!sel.ok || this.current?.aborted) return sel.ok ? { ok: true } : sel;
      if (!verify) { holding = true; break; }
      if (await this.waitHolding(want, 900)) { holding = true; break; }
    }
    if (!holding) return { ok: false, reason: 'Granate konnte nicht gewählt werden' };
    if (this.current?.aborted) return { ok: true };
    // GSI meldet die Granate schon als "aktiv", während CS2 sie noch aus dem Inventar zieht
    // (Equip-Animation). Ein Klick in dieser Phase wird vom Spiel verschluckt - kurz warten,
    // bis die Granate wirklich wurfbereit ist, bevor geklickt wird.
    const settle = await this.runSteps(item, ['wait 300']);
    if (!settle.ok || this.current?.aborted) return settle.ok ? { ok: true } : settle;
    return this.runSteps(item, ['click 80', 'wait 700', 'press @lastInv']);
  }

  async runCurse(item) {
    const pool = (this.actions.curse.pool || []).map((id) => this.actions.byId.get(id)).filter((a) => a && a.enabled);
    const eligible = pool.filter((a) => item.test || this.evaluate(a) === 'ok');
    if (!eligible.length) return { ok: false, reason: 'Keine passende Challenge verfügbar' };
    const win = pick(eligible);
    this.fx('wheel', { options: pool.map((a) => a.title), winner: win.title, ms: 5200 });
    await sleep(5600);
    Object.assign(this.current, { title: `Fluch: ${win.title}`, flavor: win.flavor });
    this.fx('alert', { user: item.user, title: win.title, flavor: win.flavor, color: item.cat.color, sub: true });
    this.emitState();
    return this.runBody(item, win);
  }

  async runSteps(item, steps) {
    // compile() ist derselbe Weg wie bei der Validierung (steps.js) - inklusive aller Grenzen.
    const { lines, est } = compile(steps, this.cfg.keys, { critical: this.cfg.input?.criticalKeys || [] });
    logger.info(`Sende: ${lines.join(' ; ')}`);
    const cur = this.current;
    const roundMs = this.cfg.engine.roundMaxSec * 1000;
    cur.untilStop = est.untilStop;
    cur.endsAt = est.untilStop ? null : Date.now() + real(est.ms);
    this.emitState();

    let handle;
    if (item.test?.dry) {
      let stop;
      const stopped = new Promise((r) => { stop = r; });
      const ms = est.untilStop ? 6000 : est.ms;
      handle = { stop, hardStop: stop, done: Promise.race([sleep(ms), stopped]).then(() => ({ ok: true })) };
    } else {
      // Harte, zentrale Obergrenze für einen Lauf (steps.js: LIMITS.maxRunMs) - greift auch dann,
      // wenn engine.roundMaxSec lokal sehr hoch eingestellt wurde. Mit den Standardwerten (125 s
      // Rundenlänge) ändert sich nichts.
      handle = this.bridge.run(lines, Math.min(est.untilStop ? roundMs + 2000 : est.ms + 4000, LIMITS.maxRunMs));
    }
    cur.handle = handle;
    const guard = est.untilStop ? setTimeout(() => handle.stop(), real(Math.min(roundMs, LIMITS.maxRunMs - 2000))) : null;
    try { return await handle.done; } finally { clearTimeout(guard); }
  }

  stopCurrent(reason, opts = {}) {
    if (!this.current?.handle) return;
    this.current.aborted = true;
    this.current.stopReason = reason;
    logger.info(`Effekt beendet (${reason}).`);
    this.current.handle.stop(opts);
  }

  // Not-Aus: alles stoppen, Queue erstatten, pausieren
  async panic(reason = 'Not-Aus') {
    logger.warn(`${reason}!`);
    this.paused = true;
    const waiting = this.queue.splice(0, this.queue.length);
    if (this.current) {
      this.current.panicked = true;
      this.current.aborted = true;
      this.current.handle?.hardStop?.();
    }
    this.bridge.panicAll();
    this.bridge.restore?.();
    for (const it of waiting) await this.reject(it, reason, 'refunded', { manual: true });
    this.fx('panic', {});
    this.emitState();
  }

  async clearQueue() {
    const waiting = this.queue.splice(this.current ? 0 : 1, this.queue.length);
    for (const it of waiting) await this.reject(it, 'Queue geleert', 'refunded', { manual: true });
    this.emitState();
  }

  setPaused(p) {
    this.paused = !!p;
    logger.info(p ? 'ChaosCore pausiert.' : 'ChaosCore läuft wieder.');
    this.emitState();
    if (!p) this.kick();
  }

  skipCurrent() { this.stopCurrent('Übersprungen'); }

  // Einen wartenden Effekt aus der Warteliste nehmen (Mini-Ansicht/Dashboard). Der Zuschauer
  // bekommt seine Punkte zurück wie beim Leeren der Warteliste.
  async removeQueued(qid) {
    const i = this.queue.findIndex((it) => it.qid === Number(qid));
    if (i < 0) return false;
    const [it] = this.queue.splice(i, 1);
    await this.reject(it, 'Vom Streamer aus der Warteliste genommen', 'refunded', { manual: true });
    this.emitState();
    return true;
  }

  // ---------- Erfolge eigener Effekte ----------
  // Kleine Freude für den Streamer: ein selbst gebauter oder bearbeiteter Effekt wurde zum ersten,
  // 10., 50., ... Mal eingelöst. Das Dashboard zeigt das einmal als Hinweis.
  checkMilestone(action) {
    if (!action || !(action.custom || action.customEffect)) return;
    const n = this.db.doneCount(action.id);
    if (![1, 10, 50, 100, 500, 1000].includes(n)) return;
    this.milestones = [{ id: action.id, title: action.title, n, at: Date.now() }, ...(this.milestones || [])].slice(0, 5);
    logger.info(`Erfolg: "${action.title}" wurde ${n === 1 ? 'zum ersten Mal' : `${n}-mal`} eingelöst.`);
    this.emitState();
  }

  // ---------- Zuschauer ----------
  isBlocked(userId) { return !!userId && (this.cfg.viewers?.blocked || []).some((v) => v.id === String(userId)); }

  // Nach dem Löschen eines Zuschauers: alle zwischengespeicherten Listen neu lesen.
  refreshViewerCaches() {
    this.hall = this.db.hall(5);
    this.hallToday = this.db.hallToday(5);
    this.history = this.loadHistory();
    this.season = this.computeSeason();
    this.contractHave = this.db.distinctViewers();
    this.credits = this.db.creditList();
    this.stats?.changed();
    this.emitState();
  }

  // ---------- Bits-Vorrang ----------
  // Bringt die Warteliste in die Reihenfolge, in der sie laufen wird - so zeigen Overlay und
  // Mini-Ansicht ehrlich, wer als Nächstes dran ist. Fortsetzungen eines laufenden Bits-Effekts
  // bleiben vorne. Danach: Bits vor Kanalpunkten, außer der Kanalpunkte-Schutz greift.
  arrange() {
    const p = this.cfg.bitsPriority;
    if (!p?.enabled || this.queue.length < 2) return;
    const rest = [...this.queue];
    const out = [];
    while (rest.length && rest[0].bitsMenu?.part > 0) out.push(rest.shift()); // Fortsetzung läuft weiter
    let streak = this.bitsStreak;
    const now = Date.now();
    while (rest.length) {
      const pts = rest.findIndex((i) => !isBitsItem(i));
      const bit = rest.findIndex((i) => isBitsItem(i));
      const overdue = rest.findIndex((i) => !isBitsItem(i) && now - i.queuedAt >= real(p.maxWaitSec * 1000));
      let idx;
      if (bit < 0) idx = 0;
      else if (pts < 0) idx = bit;
      else if (overdue >= 0) idx = overdue;
      else if (streak >= p.maxInRow) idx = pts;
      else idx = bit;
      const [it] = rest.splice(idx, 1);
      streak = isBitsItem(it) ? streak + 1 : (it.system || it.test ? streak : 0);
      out.push(it);
    }
    if (out.some((it, i) => it !== this.queue[i])) { this.queue.splice(0, this.queue.length, ...out); this.emitState(); }
  }

  // ---------- Bits-Guthaben ----------
  refreshCredits() { if (!this.closed) { this.credits = this.db.creditList(); this.emitState(); } }

  creditTitle(c) {
    if (c.kind === 'menu') return c.effectId.startsWith('act:') ? (this.allActionsById().get(c.effectId.slice(4))?.title || c.effectId.slice(4)) : templateTitle(c.effectId, chatLocale(this.cfg));
    return this.bitsActions?.byId?.get(c.effectId)?.title || c.effectId;
  }

  // Ein Bits-Effekt lief nicht (ganz): Restzeit als Guthaben behalten statt verlieren.
  // manual: vom Streamer ausgelöst (Not-Aus, Leeren, Entfernen, Überspringen) oder ein Grund, der sich
  // nicht von selbst erledigt (Zugriff, Limit) - dann entscheidet der Streamer im Dashboard.
  keepCredit(item, reason, manual, silent = false) {
    const id = item.creditId;
    item.creditId = null;
    const bm = item.bitsMenu;
    const unit = bm?.unit || 'minute';
    const remaining = bm ? (unit === 'minute' ? bm.remainingMs : bm.remaining) : 0;
    if (bm && (unit === 'minute' ? remaining < 2000 : remaining < 1)) { this.db.creditDelete(id); this.refreshCredits(); return; }
    this.db.creditToCredit(id, { remainingMs: remaining, auto: !manual, reason });
    this.refreshCredits();
    const loc = chatLocale(this.cfg);
    const title = bm ? this.creditTitle({ kind: 'menu', effectId: bm.key || bm.id }) : item.action.title;
    const what = bm ? `${amountText(unit, remaining, loc)} „${title}“` : `„${title}“`;
    logger.info(`Bits-Guthaben: ${item.user} behält ${what} (${reason}${manual ? ', wartet auf Freigabe im Dashboard' : ', läuft automatisch weiter'}).`);
    if (!silent && this.cfg.bitsCredit?.announce !== false && item.user && item.user !== 'Anonym') this.sendChat(CHAT_TEXT.credit[loc](item.user, what));
  }

  // Guthaben wieder in die Warteliste stellen. Gibt eine Fehlermeldung zurück oder null.
  resumeCredit(id) {
    const c = this.db.creditGet(Number(id));
    if (!c || c.state !== 'credit') return 'Dieses Guthaben gibt es nicht (mehr).';
    if (this.queue.length >= this.cfg.engine.maxQueue) return 'Die Warteliste ist voll.';
    const loc = chatLocale(this.cfg);
    let action, cat, bitsMenu = null;
    if (c.kind === 'menu') {
      const made = this.makeMenuItem({ userId: c.userId, user: c.user, key: c.effectId, units: c.minutes || 1, unit: c.unit || 'minute' });
      try {
        if (made.bitsMenu.kind === 'action' && !this.allActionsById().get(made.bitsMenu.id)) throw new Error('Effekt existiert nicht mehr');
        if (made.bitsMenu.kind === 'template' && !BITS_MENU_TEMPLATES[made.bitsMenu.id]) throw new Error('Unbekannter Bits-Menü-Effekt');
        if (made.bitsMenu.kind === 'template' && !BITS_MENU_TEMPLATES[made.bitsMenu.id].challenge) compile(menuAction(made.bitsMenu.id, 1000, 1, loc, { unit: c.unit || 'minute' }).effect.steps, this.cfg.keys, { critical: this.cfg.input?.criticalKeys || [] });
      } catch (e) { return `Der Effekt geht mit der aktuellen Tastenbelegung nicht: ${e.message}`; }
      ({ action, cat } = made);
      bitsMenu = made.bitsMenu;
      if ((c.unit || 'minute') === 'minute') bitsMenu.remainingMs = c.remainingMs; else bitsMenu.remaining = c.remainingMs;
      bitsMenu.part = 1;
    } else {
      action = this.bitsActions?.byId?.get(c.effectId);
      if (!action || !action.enabled) return 'Diese Bits-Stufe gibt es nicht mehr oder sie ist ausgeschaltet.';
      cat = withOverrides(action, this.bitsActions.categories[action.category]);
    }
    const item = { userId: c.userId, user: c.user || 'Unbekannt', action, cat, queuedAt: Date.now(), test: null, bits: 0, bitsMenu, creditId: c.id };
    item.dbId = this.db.record({ redemptionId: `credit_${c.id}_${Date.now()}`, userId: c.userId || 'anon', userName: item.user, rewardId: null,
      actionId: action.id, category: c.kind === 'menu' ? 'bits' : action.category, cost: 0 });
    this.db.set(item.dbId, 'queued');
    this.db.creditToPending(c.id);
    this.queue.push(item);
    logger.info(`Bits-Guthaben: ${item.user} - "${this.creditTitle(c)}" wieder in der Warteliste.`);
    this.refreshCredits();
    this.kick();
    return null;
  }

  dropCredit(id) {
    const c = this.db.creditGet(Number(id));
    if (!c || c.state !== 'credit') return false;
    this.db.creditDelete(c.id);
    logger.info(`Bits-Guthaben von ${c.user} ("${this.creditTitle(c)}") vom Streamer verworfen.`);
    this.refreshCredits();
    return true;
  }

  // Automatisch weiter: nur, wenn nichts dagegen spricht - nicht pausiert, Stream läuft (soweit
  // bekannt), kein anderer Bits-Effekt wartet schon, Guthaben ist mindestens eine Minute alt.
  checkCreditResume() {
    if (this.closed || this.paused || this.cfg.bitsCredit?.autoResume === false) return;
    if (this.stats && this.stats.streamLive === false && !process.env.UCC_CREDIT_IGNORE_LIVE) return;
    if (this.queue.some((i) => i.creditId) || this.current?.item?.creditId) return;
    if (this.blockedMode()) return;
    const due = this.credits.find((c) => c.auto && Date.now() - c.updatedAt >= real(60000));
    if (due) this.resumeCredit(due.id);
  }

  close() {
    this.closed = true;
    clearInterval(this.creditTick);
    clearInterval(this.decay);
    clearInterval(this.seasonTick);
    clearInterval(this.idleTick);
  }
}
