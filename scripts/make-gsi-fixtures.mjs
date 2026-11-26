// Erzeugt die nachgebauten GSI-Fixtures unter test/fixtures/gsi.
// node scripts/make-gsi-fixtures.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'gsi');
const ME = '76561190000000001', OTHER = '76561190000000002';

// Ein Paket. s: Zustand { map, mode, mapPhase, round, roundPhase, win, team, ct, t, kills, deaths, health, roundKills, spec }
function pkt(s) {
  const body = {
    provider: { name: 'Counter-Strike: Global Offensive', appid: 730, steamid: ME },
    map: { mode: s.mode ?? 'competitive', name: s.map ?? 'de_dust2', phase: s.mapPhase ?? 'live', round: s.round ?? 0,
      team_ct: { score: s.ct ?? 0 }, team_t: { score: s.t ?? 0 } },
    round: { phase: s.roundPhase ?? 'live', ...(s.win ? { win_team: s.win } : {}) },
    player: s.spec
      ? { steamid: OTHER, name: 'Teammate', team: s.team ?? 'CT', activity: 'playing', state: { health: 100, round_kills: 0 }, match_stats: { kills: 9, assists: 0, deaths: 9, mvps: 0, score: 0 } }
      : { steamid: ME, name: 'Streamer', team: s.team ?? 'CT', activity: 'playing', state: { health: s.health ?? 100, round_kills: s.roundKills ?? 0 },
        match_stats: { kills: s.kills ?? 0, assists: 0, deaths: s.deaths ?? 0, mvps: 0, score: 0 } },
  };
  return body;
}

// Ein Match mit allen Fällen: Warmup (zählt nicht), Runden, Kills, Tod mit "Leben 0", Tod nur über
// den Zähler (late), Zuschauen, Teamkill, Rundensieg/-niederlage, Match-Ende, dann neues Match auf
// neuer Karte mit fallenden Werten.
function fullSession() {
  const L = [];
  let t = 0;
  const add = (s, dt = 1000) => { t += dt; L.push({ t, body: pkt(s) }); };
  const base = { map: 'de_dust2', team: 'CT' };
  // Warmup: Kills/Tode im Warmup zählen nicht
  add({ ...base, mapPhase: 'warmup', roundPhase: 'warmup', kills: 3, deaths: 2 });
  add({ ...base, mapPhase: 'warmup', roundPhase: 'warmup', kills: 4, deaths: 2, health: 0 });
  // Match beginnt: CS2 setzt die Werte zurück
  add({ ...base, round: 0, roundPhase: 'freezetime', kills: 0, deaths: 0 });
  add({ ...base, round: 0, roundPhase: 'live', kills: 0, deaths: 0 });            // round_start 0
  add({ ...base, round: 0, roundPhase: 'live', kills: 1, deaths: 0, roundKills: 1 }); // kill
  add({ ...base, round: 0, roundPhase: 'live', kills: 2, deaths: 0, roundKills: 2 }); // kill
  add({ ...base, round: 0, roundPhase: 'live', kills: 3, deaths: 0, roundKills: 3 }); // kill (Serie 3)
  add({ ...base, round: 0, roundPhase: 'over', win: 'CT', kills: 3, deaths: 0, ct: 1, roundKills: 3 }); // round_end win
  add({ ...base, round: 1, roundPhase: 'freezetime', kills: 3, deaths: 0, ct: 1 });
  add({ ...base, round: 1, roundPhase: 'live', kills: 3, deaths: 0, ct: 1 });      // round_start 1
  add({ ...base, round: 1, roundPhase: 'live', kills: 3, deaths: 0, ct: 1, health: 0 }); // death (Leben 0)
  add({ ...base, round: 1, roundPhase: 'live', kills: 3, deaths: 1, ct: 1, health: 0 }); // Zähler folgt: kein zweiter Tod
  add({ ...base, round: 1, roundPhase: 'live', spec: true, ct: 1 });               // Zuschauen: zählt nicht
  add({ ...base, round: 1, roundPhase: 'over', win: 'T', spec: true, ct: 1, t: 1 }); // round_end loss (Team gemerkt)
  add({ ...base, round: 2, roundPhase: 'freezetime', kills: 3, deaths: 1, ct: 1, t: 1 });
  add({ ...base, round: 2, roundPhase: 'live', kills: 3, deaths: 1, ct: 1, t: 1 }); // round_start 2
  add({ ...base, round: 2, roundPhase: 'live', spec: true, ct: 1, t: 1 });          // sofort Zuschauen (Tod ohne Leben-0-Paket)
  add({ ...base, round: 2, roundPhase: 'over', win: 'CT', spec: true, ct: 2, t: 1 }); // round_end win
  add({ ...base, round: 3, roundPhase: 'freezetime', kills: 3, deaths: 2, ct: 2, t: 1 }); // late death
  add({ ...base, round: 3, roundPhase: 'live', kills: 3, deaths: 2, ct: 2, t: 1 });  // round_start 3
  add({ ...base, round: 3, roundPhase: 'live', kills: 2, deaths: 2, ct: 2, t: 1 });  // Teamkill: -1
  add({ ...base, round: 3, roundPhase: 'over', win: 'CT', kills: 2, deaths: 2, ct: 3, t: 1 }); // round_end win
  add({ ...base, mapPhase: 'gameover', round: 3, roundPhase: 'over', kills: 2, deaths: 2, ct: 3, t: 1 }); // match_end win 3:1
  // Neues Match auf neuer Karte, Werte fallen
  add({ map: 'de_mirage', team: 'T', round: 0, roundPhase: 'freezetime', kills: 0, deaths: 0 });
  add({ map: 'de_mirage', team: 'T', round: 0, roundPhase: 'live', kills: 0, deaths: 0 });          // round_start 0
  add({ map: 'de_mirage', team: 'T', round: 0, roundPhase: 'live', kills: 0, deaths: 0, health: 0 }); // death
  return L;
}

// Eine Runde mit 4 Kills, die letzten drei innerhalb von 5 Sekunden ("schnelle Kills") - ergibt nach
// den Punkten aus 2.1 einen Marker, einen Twitch-Clip und einen lokalen Clip (Ende-zu-Ende-Test).
function fourKills() {
  const L = [];
  let t = 0;
  const add = (s, dt = 1000) => { t += dt; L.push({ t, body: pkt(s) }); };
  const base = { map: 'de_ancient', team: 'T' };
  add({ ...base, round: 0, roundPhase: 'freezetime', kills: 0, deaths: 0 });
  add({ ...base, round: 0, roundPhase: 'live', kills: 0, deaths: 0 });                      // round_start 0
  add({ ...base, round: 0, roundPhase: 'live', kills: 1, deaths: 0, roundKills: 1 }, 6000);  // kill
  add({ ...base, round: 0, roundPhase: 'live', kills: 2, deaths: 0, roundKills: 2 }, 8000);  // kill
  add({ ...base, round: 0, roundPhase: 'live', kills: 3, deaths: 0, roundKills: 3 }, 2000);  // kill (Serie 3)
  add({ ...base, round: 0, roundPhase: 'live', kills: 4, deaths: 0, roundKills: 4 }, 1500);  // kill (Serie 4, schnell)
  add({ ...base, round: 0, roundPhase: 'over', win: 'T', kills: 4, deaths: 0, t: 1, roundKills: 4 }); // round_end win
  return L;
}

const write = (name, lines, expect) => {
  fs.writeFileSync(path.join(DIR, `${name}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.writeFileSync(path.join(DIR, `${name}.expect.json`), JSON.stringify(expect, null, 2) + '\n');
};

fs.mkdirSync(DIR, { recursive: true });
write('synthetic-full-session', fullSession(), {
  note: 'Erwartete Ereignisse in Reihenfolge (nur type und die entscheidenden Felder).',
  events: [
    'match_start de_dust2', 'round_start 0', 'kill 1 rk1', 'kill 1 rk2', 'kill 1 rk3', 'round_end win',
    'round_start 1', 'death', 'round_end loss', 'round_start 2', 'round_end win', 'death late', 'round_start 3',
    'kill -1 rk0', 'round_end win', 'match_end win 3:1', 'match_start de_mirage', 'round_start 0', 'death',
  ],
  totals: { kills: 2, deaths: 3, deathsLate: 1, roundsWon: 3, roundsLost: 1, matchesWon: 1, matchesLost: 0 },
});
write('synthetic-four-kills', fourKills(), {
  note: '4 Kills in einer Runde, die letzten drei innerhalb von 5 Sekunden.',
  events: ['match_start de_ancient', 'round_start 0', 'kill 1 rk1', 'kill 1 rk2', 'kill 1 rk3', 'kill 1 rk4', 'round_end win'],
  totals: { kills: 4, deaths: 0, deathsLate: 0, roundsWon: 1, roundsLost: 0, matchesWon: 0, matchesLost: 0 },
});
console.log('Fixtures geschrieben nach', DIR);
