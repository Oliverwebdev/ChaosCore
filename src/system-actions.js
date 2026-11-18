// System-Aktionen (Experte): ein Effekt kann zusätzlich etwas AUSSERHALB des Spiels auslösen -
// Szene in OBS wechseln, eine Quelle ein-/ausblenden, den Stream nach einem Countdown beenden oder
// ein anderes Spiel starten (mit passendem Spielprofil).
//
// Schutz (F4):
//  - Standard aus; muss im Dashboard eigens freigeschaltet werden.
//  - Steht nur in der lokalen Konfiguration - nie in Presets, Exporten oder Effekt-Dateien.
//  - Optional (Standard: an) fragt ChaosCore dich vorher im Dashboard; ohne Ja passiert nichts.
//  - Jede Verknüpfung hat einen eigenen Cooldown; Stream beenden hat immer einen Countdown, den der
//    Not-Aus oder der Abbrechen-Knopf stoppt.
//  - Programme kommen nur aus deiner eigenen Liste; Zuschauer können keine Pfade angeben.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { TIME_SCALE } from './util.js';
import * as logger from './log.js';

const real = (ms) => ms * TIME_SCALE;

export { SYSTEM_KINDS, SYSTEM_DEFAULT, checkProgramTarget, normalizeSystem } from './system-config.js';
import { checkProgramTarget } from './system-config.js';

export class SystemActions extends EventEmitter {
  constructor({ cfg, obs, fx, switchProfile }) {
    super();
    Object.assign(this, { cfg, obs, fx, switchProfile });
    this.cool = {};
    this.pending = null; // wartet auf deine Bestätigung
    this.countdown = null; // Stream-Ende läuft
    this.pendSeq = 0;
  }

  // Aufruf, wenn ein Effekt startet. item: Warteschlangen-Eintrag (user, action)
  trigger(actionId, item) {
    const sys = this.cfg.system;
    const link = sys?.enabled ? sys.links[actionId] : null;
    if (!link) return 'none';
    const now = Date.now();
    if (now - (this.cool[actionId] || 0) < real(link.cooldownSec * 1000)) { logger.info(`System-Aktion für "${item.action.title}" im Cooldown.`); return 'cooldown'; }
    if (this.pending || this.countdown) return 'busy';
    this.cool[actionId] = now;
    const job = { id: ++this.pendSeq, actionId, link, user: item.user, title: item.action.title, at: now };
    if (sys.confirm) {
      this.pending = { ...job, expiresAt: now + real(60000) };
      this.pending.timer = setTimeout(() => { if (this.pending?.id === job.id) { logger.info('System-Aktion nicht bestätigt - verworfen.'); this.pending = null; this.emit('change'); } }, real(60000));
      this.pending.timer.unref?.();
      logger.info(`System-Aktion wartet auf deine Bestätigung: ${describe(link, this.cfg)} (von ${item.user}).`);
      this.emit('change');
      return 'pending';
    }
    this.run(job).catch((e) => logger.warn(`System-Aktion fehlgeschlagen: ${e.message}`));
    return 'started';
  }

  async answer(id, yes) {
    const p = this.pending;
    if (!p || p.id !== Number(id)) throw new Error('Diese Anfrage ist nicht mehr offen');
    clearTimeout(p.timer);
    this.pending = null;
    this.emit('change');
    if (!yes) { logger.info('System-Aktion abgelehnt.'); return 'declined'; }
    await this.run(p);
    return 'done';
  }

  async run(job) {
    const { link } = job;
    switch (link.kind) {
      case 'scene': {
        const before = link.backSec ? (await this.obs.scenes()).current : null;
        await this.obs.setScene(link.scene);
        logger.info(`OBS-Szene gewechselt: ${link.scene} (${job.user}).`);
        if (before && before !== link.scene) setTimeout(() => this.obs.setScene(before).catch(() => {}), real(link.backSec * 1000)).unref?.();
        break;
      }
      case 'source': {
        const on = await this.obs.setSource(link.scene, link.source, link.mode === 'toggle' ? 'toggle' : link.mode === 'on');
        logger.info(`OBS-Quelle "${link.source}" ${on ? 'eingeblendet' : 'ausgeblendet'} (${job.user}).`);
        if (link.backSec) setTimeout(() => this.obs.setSource(link.scene, link.source, !on).catch(() => {}), real(link.backSec * 1000)).unref?.();
        break;
      }
      case 'endStream': await this.endStream(link.seconds, job.user); break;
      case 'game': this.startProgram(link.programId, job.user); break;
      default: break;
    }
  }

  endStream(seconds, user) {
    if (this.obs.status !== 'connected') throw new Error('OBS ist nicht verbunden');
    return new Promise((resolve) => {
      const endsAt = Date.now() + real(seconds * 1000);
      this.countdown = { endsAt, seconds, user, timer: null };
      this.fx('sys_countdown', { seconds, user });
      logger.warn(`Stream endet in ${seconds} Sekunden (ausgelöst von ${user}). Abbrechen im Dashboard oder mit dem Not-Aus.`);
      this.countdown.timer = setTimeout(async () => {
        this.countdown = null;
        this.emit('change');
        try { await this.obs.stopStream(); logger.info('Stream über OBS beendet.'); } catch (e) { logger.warn(`Stream nicht beendet: ${e.message}`); }
        resolve();
      }, real(seconds * 1000));
      this.countdown.resolve = resolve;
      this.emit('change');
    });
  }

  abort(reason = 'abgebrochen') {
    let did = false;
    if (this.countdown) {
      clearTimeout(this.countdown.timer);
      this.countdown.resolve?.();
      this.countdown = null;
      this.fx('sys_abort', {});
      logger.info(`Stream-Ende ${reason}.`);
      did = true;
    }
    if (this.pending) { clearTimeout(this.pending.timer); this.pending = null; did = true; }
    if (did) this.emit('change');
    return did;
  }

  startProgram(programId, user = 'Dashboard') {
    const prog = this.cfg.system.programs.find((p) => p.id === programId);
    if (!prog) throw new Error('Programm nicht in deiner Liste');
    const { target, uri } = checkProgramTarget(prog.target);
    const args = prog.args ? prog.args.split(/\s+/).filter(Boolean) : [];
    let child;
    if (process.platform === 'win32') {
      // "start" öffnet .exe, Verknüpfungen und Launcher-Adressen gleichermaßen; keine Shell-Sonderzeichen (siehe oben).
      child = spawn('cmd.exe', ['/d', '/c', 'start', '""', target, ...(uri ? [] : args)], { detached: true, stdio: 'ignore', windowsHide: true });
    } else if (uri) {
      child = spawn('xdg-open', [target], { detached: true, stdio: 'ignore' });
    } else {
      child = spawn(target, args, { detached: true, stdio: 'ignore' });
    }
    child.on('error', (e) => logger.warn(`"${prog.name}" konnte nicht gestartet werden: ${e.message}`));
    child.unref();
    logger.info(`Programm gestartet: ${prog.name} (${user}).`);
    if (prog.profile && prog.profile !== this.cfg.game.profile) {
      try { this.switchProfile(prog.profile); logger.info(`Spielprofil gewechselt: ${prog.profile}.`); } catch (e) { logger.warn(`Spielprofil nicht gewechselt: ${e.message}`); }
    }
    return prog.name;
  }

  publicState() {
    return {
      pending: this.pending ? { id: this.pending.id, user: this.pending.user, title: this.pending.title, what: describe(this.pending.link, this.cfg), expiresAt: this.pending.expiresAt } : null,
      countdown: this.countdown ? { endsAt: this.countdown.endsAt, user: this.countdown.user } : null,
    };
  }

  close() { this.abort('beendet'); }
}

export function describe(link, cfg, en = false) {
  switch (link.kind) {
    case 'scene': return en ? `switch to scene "${link.scene}"` : `Szene "${link.scene}" zeigen`;
    case 'source': return en ? `${link.mode === 'on' ? 'show' : link.mode === 'off' ? 'hide' : 'toggle'} "${link.source}"` : `"${link.source}" ${link.mode === 'on' ? 'einblenden' : link.mode === 'off' ? 'ausblenden' : 'umschalten'}`;
    case 'endStream': return en ? `end the stream after ${link.seconds} s` : `Stream nach ${link.seconds} s beenden`;
    case 'game': { const p = cfg.system.programs.find((x) => x.id === link.programId); return en ? `start ${p?.name || '?'}` : `${p?.name || '?'} starten`; }
    default: return link.kind;
  }
}
