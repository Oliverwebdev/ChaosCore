// Titel für Highlight-Momente (Marker, lokale Clips, Highlight-Liste).
//
// Ziel: Auch nach 1.000 Momenten klingt jeder Titel, als wäre er für genau diesen Moment geschrieben.
// Darum keine feste Satzliste, sondern:
//   - Fakten des Moments (wer, welcher Effekt, Sekunden bis zum Tod, Kills, Bits, Runde, Map)
//   - Kontext, der ihn einzigartig macht ("zum 3. Mal heute", "schnellster Chaos-Tod des Abends")
//   - viele Satzbausteine je Moment-Art und Ton, frei kombiniert
//   - ein Gedächtnis: gleiche Satzbauten, gleiche Anfänge und gleiche Titel kurz hintereinander
//     werden vermieden
// Jeder Titel enthält mindestens zwei echte Fakten des Moments.

const MAX_LEN = 140; // Twitch-Marker erlauben 140 Zeichen

// {user} {effect} {secs} {kills} {bits} {round} {map} {have} {goal} {minutes}
const T = {
  de: {
    chaos_death: {
      frech: [
        '{user} schickt mich mit {effect} ins Grab', '{effect} von {user}: nach {secs} Sek. war Schluss', 'Tod durch {effect} - danke auch, {user}',
        '{user} gewinnt: {effect} kostet mich die Runde', '{secs} Sekunden {effect}, dann lag ich da', '{effect} wird tödlich - Auftrag von {user}',
        '{user} drückt auf {effect}, ich falle um', 'Opfer von {effect}, bezahlt von {user}', 'Keine {secs} Sekunden überlebt: {effect} von {user}',
        '{user} und {effect}: eine tödliche Kombi', 'Da war {effect} von {user} wohl zu viel', '{effect} schlägt zu - {user} lacht zuletzt',
      ],
      episch: [
        'Gefallen unter {effect} - {user} hat entschieden', '{user} besiegelt mein Schicksal mit {effect}', '{secs} Sekunden Kampf gegen {effect}, dann das Ende',
        'Das Chaos von {user} fordert sein Opfer: {effect}', '{effect} bricht mich - {user} triumphiert', 'Ein letzter Atemzug unter {effect} ({user})',
      ],
      trocken: [
        '{effect} von {user}, Tod nach {secs} Sek.', 'Chaos-Tod: {effect} ({user})', '{user}: {effect}, Ergebnis tot', 'Tod unter {effect}, ausgelöst von {user}',
        '{effect} ({user}) - {secs} Sek. bis zum Tod', 'Gestorben während {effect}, danke {user}',
      ],
    },
    clutch: {
      frech: [
        '{kills} Kills trotz {effect} - sorry, {user}', '{effect}? Egal: {kills} Kills', '{user} wollte Chaos, bekam {kills} Kills', 'Trotz {effect} {kills} Gegner weg',
        '{user} zahlt für {effect}, ich nehme {kills} Kills', 'Mit {effect} besser als ohne: {kills} Kills', '{effect} hat nicht gereicht, {user} - {kills} Kills',
        '{kills} Kills unter {effect} - Plan von {user} gescheitert',
      ],
      episch: [
        'Unaufhaltsam: {kills} Kills trotz {effect}', '{user} wollte mich brechen - {kills} Kills unter {effect}', 'Gegen {effect} und gegen alle: {kills} Kills',
        'Aus dem Chaos von {user} geboren: {kills} Kills',
      ],
      trocken: [
        '{kills} Kills während {effect} ({user})', '{effect} ({user}): {kills} Kills', 'Unter {effect}: {kills} Kills', '{kills} Kills, Effekt: {effect}, von {user}',
      ],
    },
    bits_big: {
      frech: [
        '{user} zahlt {bits} Bits für {effect}', '{bits} Bits Chaos: {effect} von {user}', '{user} wirft {bits} Bits rein - {effect} läuft',
        'Teuer bezahlt: {effect} für {bits} Bits ({user})', '{effect} zum Preis von {bits} Bits - danke {user}', '{user} meint es ernst: {bits} Bits für {effect}',
      ],
      episch: ['{user} opfert {bits} Bits: {effect} beginnt', 'Ein Sturm aus {bits} Bits - {effect} von {user}', '{bits} Bits, ein Name: {user}. {effect} beginnt'],
      trocken: ['{bits} Bits von {user}: {effect}', '{effect} gekauft ({bits} Bits, {user})', 'Bits: {bits} von {user} für {effect}'],
    },
    challenge_won: { frech: ['Challenge geschafft: {kills} Kills in {minutes} Min. gegen {user}', '{user} fordert {kills} Kills - geliefert', 'Auftrag von {user} erledigt: {kills}/{goal} Kills', '{goal} Kills verlangt, {kills} geliefert - sorry {user}'] },
    challenge_lost: { frech: ['Challenge verloren: {kills}/{goal} Kills - Punkt für {user}', '{user} gewinnt die Challenge, ich schaffe nur {kills}/{goal}', '{goal} Kills in {minutes} Min.? Nur {kills}. {user} lacht', 'Gescheitert an der Challenge von {user} ({kills}/{goal})'] },
    streak: { frech: ['{kills} Kills in einer Runde', 'Runde {round}: {kills} Kills am Stück', '{kills}er auf {map}', 'Eine Runde, {kills} Kills - Runde {round}', '{kills} Kills in Runde {round} auf {map}'] },
    pot: { frech: ['Gemeinschaftstopf voll: {effect} für alle', 'Der Chat hat gesammelt - {minutes} Min. {effect}', '{effect} aus dem Gemeinschaftstopf, danke {user}', 'Topf voll, {minutes} Min. {effect} - Danke {user}'] },
    goal: { frech: ['Community-Ziel geknackt: {effect}', '{effect} erreicht - der Chat übernimmt', 'Chaos-Ziel voll: {effect}'] },
    raid: { frech: ['Raid von {user} - Chaos zur Begrüßung', '{user} raidet, {effect} begrüßt', 'Willkommen, {user}: {effect} zum Raid'] },
  },
  en: {
    chaos_death: {
      frech: [
        '{user} sends me to the grave with {effect}', "{effect} from {user}: dead after {secs}s", 'Killed by {effect} - thanks a lot, {user}',
        '{user} wins: {effect} costs me the round', '{secs} seconds of {effect}, then I was down', '{effect} turns deadly - ordered by {user}',
        '{user} hits {effect}, I hit the floor', 'Victim of {effect}, paid for by {user}', "Didn't last {secs}s: {effect} from {user}",
        '{user} plus {effect}: a deadly combo', '{effect} from {user} was too much', '{effect} strikes - {user} laughs last',
      ],
      episch: ['Fallen under {effect} - {user} decided', '{user} seals my fate with {effect}', '{secs} seconds against {effect}, then the end', "{user}'s chaos claims its victim: {effect}"],
      trocken: ['{effect} from {user}, dead after {secs}s', 'Chaos death: {effect} ({user})', '{user}: {effect}, result dead', 'Died under {effect}, triggered by {user}'],
    },
    clutch: {
      frech: ['{kills} kills despite {effect} - sorry, {user}', '{effect}? Whatever: {kills} kills', '{user} wanted chaos, got {kills} kills', 'Despite {effect}: {kills} enemies down', '{user} pays for {effect}, I take {kills} kills', '{kills} kills under {effect} - {user}\'s plan failed'],
      episch: ['Unstoppable: {kills} kills despite {effect}', '{user} tried to break me - {kills} kills under {effect}'],
      trocken: ['{kills} kills during {effect} ({user})', '{effect} ({user}): {kills} kills'],
    },
    bits_big: {
      frech: ['{user} pays {bits} Bits for {effect}', '{bits} Bits of chaos: {effect} from {user}', '{user} drops {bits} Bits - {effect} is on', '{effect} for {bits} Bits - thanks {user}'],
      episch: ['{user} sacrifices {bits} Bits: {effect} begins'], trocken: ['{bits} Bits from {user}: {effect}'],
    },
    challenge_won: { frech: ['Challenge done: {kills} kills in {minutes} min vs {user}', '{user} asked for {kills} kills - delivered', "{user}'s order done: {kills}/{goal} kills"] },
    challenge_lost: { frech: ['Challenge lost: {kills}/{goal} kills - point to {user}', '{user} wins the challenge, I only got {kills}/{goal}', 'Failed {user}\'s challenge ({kills}/{goal})'] },
    streak: { frech: ['{kills} kills in one round', 'Round {round}: {kills} kills in a row', '{kills}k on {map}', '{kills} kills in round {round} on {map}'] },
    pot: { frech: ['Community pot full: {effect} for everyone', 'Chat chipped in - {minutes} min {effect}', 'Pot full, {minutes} min {effect} - thanks {user}'] },
    goal: { frech: ['Community goal reached: {effect}', '{effect} reached - chat takes over'] },
    raid: { frech: ['Raid from {user} - chaos as a welcome', '{user} raids, {effect} says hi'] },
  },
};

// Kontext-Zusätze (machen einen Moment einzigartig).
const CTX = {
  de: {
    nthByUser: (n, u) => `zum ${n}. Mal heute durch ${u}`, firstByUser: (u) => `das erste Mal durch ${u}`, fastest: () => 'schnellster Chaos-Tod des Abends',
    nthToday: (n) => `Chaos-Tod Nr. ${n} heute`, round: (r) => `Runde ${r}`, map: (m) => `auf ${m}`, plus: (t) => `+ ${t}`,
    record: (k) => `Rekord heute: ${k} Kills`, revenge: () => 'die Revanche', at: (t) => `bei ${t}`,
  },
  en: {
    nthByUser: (n, u) => `#${n} today by ${u}`, firstByUser: (u) => `first one by ${u}`, fastest: () => 'fastest chaos death tonight',
    nthToday: (n) => `chaos death #${n} today`, round: (r) => `round ${r}`, map: (m) => `on ${m}`, plus: (t) => `+ ${t}`,
    record: (k) => `today's record: ${k} kills`, revenge: () => 'the revenge', at: (t) => `at ${t}`,
  },
};

const fill = (tpl, f) => tpl.replace(/\{(\w+)\}/g, (_, k) => (f[k] === undefined || f[k] === null || f[k] === '' ? '?' : String(f[k])));
const firstWords = (s) => s.toLowerCase().split(/\s+/).slice(0, 2).join(' ');
const mapName = (m) => (m ? String(m).replace(/^(de|cs|ar|dz)_/, '').replace(/^./, (c) => c.toUpperCase()) : null);

export class TitleMaker {
  constructor({ locale = 'de', tone = 'frech', rand = Math.random } = {}) {
    this.locale = locale === 'en' ? 'en' : 'de';
    this.tone = ['frech', 'episch', 'trocken'].includes(tone) ? tone : 'frech';
    this.rand = rand;
    this.recentTpl = []; // zuletzt benutzte Vorlagen
    this.recentStart = []; // zuletzt benutzte Anfänge
    this.seen = new Set(); // alle Titel dieses Streams
    this.stats = { deathsByUser: {}, deaths: 0, fastest: null, bestKills: 0 };
  }

  setStyle({ locale, tone } = {}) {
    if (locale) this.locale = locale === 'en' ? 'en' : 'de';
    if (tone && ['frech', 'episch', 'trocken'].includes(tone)) this.tone = tone;
  }

  resetStream() { this.seen.clear(); this.stats = { deathsByUser: {}, deaths: 0, fastest: null, bestKills: 0 }; }

  pool(type) {
    const set = T[this.locale][type] || T[this.locale].chaos_death;
    const own = set[this.tone] || [];
    return own.length >= 3 ? [...own, ...(set.frech || []).slice(0, 3)] : [...own, ...(set.frech || [])];
  }

  // Kontext aus dem bisherigen Stream-Verlauf. Gibt eine Liste möglicher Zusätze (stärkste zuerst).
  context(m) {
    const C = CTX[this.locale];
    const out = [];
    if (m.type === 'chaos_death') {
      const n = (this.stats.deathsByUser[m.user] || 0) + 1;
      this.stats.deathsByUser[m.user] = n;
      this.stats.deaths++;
      if (Number.isFinite(m.secs) && (this.stats.fastest === null || m.secs < this.stats.fastest) && this.stats.deaths > 1) out.push(C.fastest());
      if (Number.isFinite(m.secs) && (this.stats.fastest === null || m.secs < this.stats.fastest)) this.stats.fastest = m.secs;
      if (n > 1) out.push(C.nthByUser(n, m.user)); else if (this.stats.deaths > 2) out.push(C.firstByUser(m.user));
      out.push(C.nthToday(this.stats.deaths));
    }
    if ((m.type === 'clutch' || m.type === 'streak') && m.kills > this.stats.bestKills) {
      if (this.stats.bestKills > 0) out.push(C.record(m.kills));
      this.stats.bestKills = m.kills;
    }
    if (m.round) out.push(C.round(m.round));
    if (m.map) out.push(C.map(mapName(m.map)));
    if (m.streamTime) out.push(C.at(m.streamTime));
    return out;
  }

  // m: { type, user, effect, secs, kills, bits, round, map, have, goal, minutes, streamTime, extra? }
  make(m) {
    const facts = { ...m, map: mapName(m.map), kills: m.kills ?? m.have, effect: m.effect || (this.locale === 'en' ? 'chaos' : 'Chaos') };
    const type = m.type === 'challenge' ? (m.result === 'won' ? 'challenge_won' : 'challenge_lost') : m.type;
    // Vorlagen, deren Platzhalter dieser Moment auch füllen kann
    const usable = this.pool(type).filter((tpl) => [...tpl.matchAll(/\{(\w+)\}/g)].every(([, k]) => facts[k] !== undefined && facts[k] !== null && facts[k] !== ''));
    const pool = usable.length ? usable : this.pool(type);
    // Gedächtnis: zuletzt benutzte Vorlagen und gleiche Anfänge meiden
    const fresh = pool.filter((tpl) => !this.recentTpl.includes(tpl) && !this.recentStart.includes(firstWords(fill(tpl, facts))));
    const cands = fresh.length ? fresh : pool.filter((tpl) => !this.recentTpl.includes(tpl));
    const choice = (cands.length ? cands : pool)[Math.floor(this.rand() * (cands.length ? cands : pool).length)];
    let title = fill(choice, facts);
    const ctx = this.context(m);
    // Zusätze: zuerst der stärkste Kontext; zweiter Moment im selben Clip ("+ Doppel-Kill")
    if (m.extra) title += ` ${CTX[this.locale].plus(m.extra)}`;
    // Mindestens zwei Fakten: hat die Vorlage nur einen Platzhalter, kommt der Kontext immer dazu.
    const placeholders = new Set([...choice.matchAll(/\{(\w+)\}/g)].map(([, k]) => k)).size;
    let force = placeholders < 2;
    for (const c of ctx) {
      if (force || this.seen.has(title.toLowerCase()) || this.rand() < 0.45) {
        force = false;
        const next = `${title} · ${c}`;
        if (next.length <= MAX_LEN) title = next;
        if (!this.seen.has(title.toLowerCase()) && !force) break;
      }
    }
    // Notfalls eindeutig machen (Runde/Zeit sind immer verschieden)
    let n = 2;
    while (this.seen.has(title.toLowerCase())) title = `${title.replace(/ \(\d+\)$/, '')} (${n++})`;
    if (title.length > MAX_LEN) title = `${title.slice(0, MAX_LEN - 1)}…`;
    this.seen.add(title.toLowerCase());
    this.recentTpl = [choice, ...this.recentTpl].slice(0, Math.max(3, Math.floor(pool.length / 2)));
    this.recentStart = [firstWords(title), ...this.recentStart].slice(0, 6);
    return title;
  }
}

export const HIGHLIGHT_TONES = ['frech', 'episch', 'trocken'];
