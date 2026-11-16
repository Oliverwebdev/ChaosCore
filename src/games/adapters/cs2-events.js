// CS2-Ereignis-Adapter: macht aus rohen GSI-Paketen spielneutrale
// Ereignisse für die Session Stats. Das ist der Ereignis-Teil der geplanten Adapter-Schnittstelle
// für alle Spiele; alles CS2-Spezifische (Feldnamen, Phasen, Teams) bleibt in dieser Datei.
//
// Ereignisse (alle mit ts = Zeitpunkt in ms):
//   { type: 'match_start', map, mode }
//   { type: 'match_end',   map, mode, result: 'win'|'loss'|'tie'|null, own, opp }
//   { type: 'round_start', round }
//   { type: 'round_end',   round, result: 'win'|'loss'|null }
//   { type: 'kill',  count, roundKills }   count kann negativ sein (Teamkill zieht in CS2 einen Kill ab)
//   { type: 'death', late, at? }           late: Tod erst über den Zähler erkannt. at: vermuteter
//                                          Todeszeitpunkt (Wechsel auf einen anderen Spieler mitten
//                                          in der Runde), sonst fehlt at und der Zeitpunkt ist ungenau
//
// Regeln:
// - Gezählt wird nur, wenn das Paket den Streamer selbst zeigt (player.steamid == provider.steamid),
//   nicht beim Zuschauen und nicht im Warmup. Spielmodi lassen sich über opts.countMode filtern.
// - Kills/Tode kommen aus player.match_stats, und die sind über das Match KUMULATIV. Deshalb:
//   Ausgangswerte pro Match merken, nur Differenzen zählen. Ein neues Match (Kartenwechsel, Tode
//   fallen, Rundenzähler fällt) setzt neu an, ohne etwas zu zählen.
// - Tod: bevorzugt der Moment, in dem das Leben im eigenen Paket auf 0 fällt (genauer Zeitpunkt für
//   die Chaos-Zuordnung). Steigt der Tode-Zähler, ohne dass vorher ein solches Paket kam (z. B. weil
//   GSI sofort auf den beobachteten Spieler gewechselt hat), wird der Tod nachträglich mit late: true
//   gemeldet. Ob CS2 dieses "Leben 0"-Paket zuverlässig schickt, ist nur auf echtem Windows prüfbar
//  

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

export function createCs2EventAdapter(opts = {}) {
  const countMode = opts.countMode || (() => true);
  // Zustand - exportState()/importState() erlauben die Wiederherstellung nach einem Absturz.
  let st = blank();
  function blank() {
    return { matchKey: null, map: null, mode: null, kills: null, deaths: null, round: null, mapPhase: null,
      roundPhase: null, health: null, ownTeam: null, healthDeaths: 0, roundKills: 0, ended: false, announced: false,
      wasMine: false, lostAt: null };
  }

  function feed(body, ts = Date.now()) {
    const out = [];
    const prov = body?.provider || {};
    const p = body?.player || {};
    const m = body?.map || {};
    const r = body?.round || {};
    if (!m.name) return out; // Hauptmenü: nichts zu tun
    const mine = !!(p.steamid && prov.steamid && String(p.steamid) === String(prov.steamid));
    const mapPhase = m.phase ?? null;
    const round = num(m.round);
    const warmup = mapPhase === 'warmup';
    const counted = !warmup && countMode(m.mode ?? null);
    const ms = mine ? (p.match_stats || null) : null;
    const kills = ms ? num(ms.kills) : null;
    const deaths = ms ? num(ms.deaths) : null;
    if (mine && p.team) st.ownTeam = p.team;

    // ---- Neues Match erkennen ----
    const matchKey = `${prov.steamid || '?'}|${m.name}`;
    const newMatch = st.matchKey !== matchKey
      || (deaths !== null && st.deaths !== null && deaths < st.deaths)
      || (round !== null && st.round !== null && round < st.round)
      || (st.mapPhase === 'gameover' && mapPhase !== 'gameover' && mapPhase !== null);
    if (newMatch) {
      const ownTeam = st.matchKey === matchKey ? st.ownTeam : (mine ? p.team ?? null : null);
      // announced bleibt über einen reinen Neuansatz innerhalb derselben Karte erhalten: das Ende des
      // Warmups (CS2 setzt die Werte auf 0) ist kein neues Match.
      const announced = st.matchKey === matchKey && st.announced && !(st.mapPhase === 'gameover');
      st = { ...blank(), matchKey, map: m.name, mode: m.mode ?? null, ownTeam, announced };
    }
    // match_start erst, wenn wirklich gespielt wird (nicht schon im Warmup).
    if (!st.announced && !warmup && counted) {
      st.announced = true;
      out.push({ type: 'match_start', ts, map: m.name, mode: m.mode ?? null });
    }

    // Schaltet GSI mitten in einer laufenden Runde vom Streamer (lebend) auf einen anderen
    // Spieler um, ist er sehr wahrscheinlich gerade gestorben. Den Zeitpunkt merken - kommt der Tod
    // danach nur über den Zähler (late), bekommt er diesen Zeitpunkt für die Chaos-Zuordnung.
    if (!mine && st.wasMine && (st.health ?? 0) > 0 && r.phase === 'live' && st.lostAt === null) st.lostAt = ts;
    st.wasMine = mine;

    // ---- Runden ----
    const roundPhase = r.phase ?? null;
    if (roundPhase === 'live' && st.roundPhase !== 'live' && st.roundPhase !== null && counted) {
      st.roundKills = 0;
      out.push({ type: 'round_start', ts, round });
    }
    if (roundPhase === 'over' && st.roundPhase !== 'over' && st.roundPhase !== null && counted) {
      const win = r.win_team ?? null;
      out.push({ type: 'round_end', ts, round, result: win && st.ownTeam ? (win === st.ownTeam ? 'win' : 'loss') : null });
    }
    st.roundPhase = roundPhase;

    // ---- Kills / Tode ----
    if (mine && kills !== null && deaths !== null) {
      if (st.kills === null || !counted) {
        // Ausgangswerte (erstes eigenes Paket im Match, oder Warmup/gefilterter Modus): nichts zählen.
        st.kills = kills; st.deaths = deaths; st.healthDeaths = 0;
      } else {
        const health = num(p.state?.health);
        if (health === 0 && (st.health ?? 1) > 0) {
          st.healthDeaths++;
          out.push({ type: 'death', ts, late: false });
        }
        const dd = deaths - st.deaths;
        if (dd > 0) {
          const fromHealth = Math.min(dd, st.healthDeaths);
          st.healthDeaths -= fromHealth;
          for (let i = 0; i < dd - fromHealth; i++) {
            out.push(st.lostAt !== null ? { type: 'death', ts, late: true, at: st.lostAt } : { type: 'death', ts, late: true });
            st.lostAt = null;
          }
        } else if (num(p.state?.health) > 0) st.lostAt = null; // wieder selbst am Leben, kein Tod dazwischen
        const dk = kills - st.kills;
        // Kills dieser Runde: CS2 meldet sie selbst (round_kills); zur Sicherheit zusätzlich selbst
        // mitgezählt, falls das Feld fehlt oder hinterherhinkt.
        if (dk > 0) st.roundKills += dk;
        const roundKills = Math.max(num(p.state?.round_kills) ?? 0, st.roundKills);
        if (dk !== 0) out.push({ type: 'kill', ts, count: dk, roundKills });
        st.kills = kills; st.deaths = deaths;
      }
      st.health = num(p.state?.health);
    }
    if (round !== null) st.round = round;

    // ---- Match-Ende ----
    if (mapPhase === 'gameover' && st.mapPhase !== 'gameover' && st.mapPhase !== null && counted && !st.ended) {
      st.ended = true;
      const ct = num(m.team_ct?.score), t = num(m.team_t?.score);
      let own = null, opp = null, result = null;
      if (st.ownTeam === 'CT' || st.ownTeam === 'T') {
        own = st.ownTeam === 'CT' ? ct : t; opp = st.ownTeam === 'CT' ? t : ct;
        if (own !== null && opp !== null) result = own > opp ? 'win' : own < opp ? 'loss' : 'tie';
      }
      out.push({ type: 'match_end', ts, map: m.name, mode: m.mode ?? null, result, own, opp });
    }
    st.mapPhase = mapPhase;
    return out;
  }

  return {
    feed,
    exportState: () => structuredClone(st),
    importState: (s) => { if (s && typeof s === 'object') st = { ...blank(), ...s }; },
    reset: () => { st = blank(); },
  };
}
