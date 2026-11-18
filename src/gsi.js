// CS2 Game State Integration: offizielle, rein lesende Schnittstelle.
import { EventEmitter } from 'node:events';

const PRIMARY = new Set(['Rifle', 'SniperRifle', 'Machine Gun', 'Shotgun', 'SubmachineGun']);
const STALE_MS = 25_000;

const blank = () => ({
  known: false, mine: false, roundLive: false, live: false, alive: false, phase: null,
  activity: null, map: null, mode: null, primary: null, grenades: [], activeName: null, activeType: null, lastUpdate: 0,
});

export class GameState extends EventEmitter {
  constructor() {
    super();
    this.s = blank();
    this._wasConnected = false;
  }

  get() {
    const connected = Date.now() - this.s.lastUpdate < STALE_MS;
    return { ...this.s, connected, live: connected && this.s.live };
  }

  update(body) {
    const prev = this.get();
    const prov = body.provider || {};
    const p = body.player || {};
    const r = body.round || {};
    const m = body.map || {};
    const weapons = Object.values(p.weapons || {});
    const health = p.state?.health ?? 0;
    const mine = !!(p.steamid && prov.steamid && String(p.steamid) === String(prov.steamid));
    const alive = health > 0;
    const known = !!m.name;
    const dm = m.mode === 'deathmatch';
    const phase = r.phase ?? (m.phase === 'warmup' ? 'warmup' : null);
    const roundLive = known && mine && (phase === 'live' || (dm && alive));
    const playing = (p.activity ?? 'playing') === 'playing';
    this.s = {
      known, mine, roundLive, alive, phase, activity: p.activity ?? null,
      map: m.name ?? null, mode: m.mode ?? null,
      live: roundLive && alive && playing,
      primary: weapons.find((w) => PRIMARY.has(w.type))?.name ?? null,
      grenades: weapons.filter((w) => w.type === 'Grenade').map((w) => w.name),
      activeName: weapons.find((w) => w.state === 'active')?.name ?? null,
      activeType: weapons.find((w) => w.state === 'active')?.type ?? null,
      kills: p.match_stats?.kills ?? null, // für die Herausforderung (Bits-Menü)
      lastUpdate: Date.now(),
    };
    this.emit('change', this.get(), prev);
  }

  // Verbindungsstatus regelmäßig prüfen (GSI schweigt, wenn CS2 aus ist)
  tick() {
    const c = this.get().connected;
    if (c !== this._wasConnected) {
      this._wasConnected = c;
      this.emit('change', this.get(), { ...this.get(), connected: !c });
    }
  }
}
