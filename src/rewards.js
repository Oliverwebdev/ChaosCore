// Belohnungen auf Twitch anlegen/aktualisieren (nur solche, die dieses Programm selbst erstellt hat).
import { loadRewardMap, saveRewardMap } from './config.js';

export function rewardBody(action, cat) {
  return {
    title: action.title,
    cost: action.cost,
    prompt: String(action.prompt || '').slice(0, 200),
    is_enabled: !!action.enabled,
    background_color: cat.color,
    is_user_input_required: false,
    // Muss false sein, sonst kann das Programm Einlösungen nicht erstatten/abschließen.
    should_redemptions_skip_request_queue: false,
    is_global_cooldown_enabled: true,
    global_cooldown_seconds: cat.cooldownSec,
    is_max_per_user_per_stream_enabled: true,
    max_per_user_per_stream: cat.perUser,
  };
}

// Mode-neutral formuliert (kein "npm run ..."): dieser Text erscheint sowohl im Terminal-Assistenten
// als auch im Einrichtungsfenster/Dashboard der fertigen exe - dort gibt es kein Terminal.
export function explain(e) {
  const m = String(e.message || e);
  // Seit Mai 2026 öffnet Twitch Kanalpunkte (und Bits) für ALLE Kanäle, nicht erst ab
  // Affiliate/Partner - diese Fehlermeldung sollte daher kaum noch vorkommen. Falls sie es doch
  // tut (z. B. Rollout noch nicht überall angekommen, Region, o.ä.), ehrlich als Twitch-seitige
  // Ausnahme benennen statt als erwarteten Normalfall.
  if (/affiliate|partner/i.test(m)) return 'Twitch meldet hierzu eine Einschränkung zu Affiliate/Partner - eigentlich unüblich, da Kanalpunkte seit Mai 2026 für jeden Kanal freigegeben sind. Versuch es in ein paar Minuten erneut.';
  // Sollte dank der automatischen Verknüpfung in syncRewards() (per Titel) kaum noch auftreten -
  // nur noch, wenn zwei Aktionen denselben Titel tragen oder die Belohnung schon einer anderen
  // Aktion zugeordnet ist.
  if (/duplicate/i.test(m)) return 'Es gibt schon eine Belohnung mit diesem Titel auf Twitch, die einer anderen Aktion zugeordnet ist. Benenne eine der beiden um und versuch es nochmal.';
  if (/too many|maximum/i.test(m)) return 'Twitch erlaubt maximal 50 Belohnungen pro Kanal. Lösche nicht benötigte.';
  if (e.status === 403 || e.status === 401) return `Keine Berechtigung (${m}). Bitte erneut bei Twitch anmelden.`;
  return m;
}

export async function syncRewards(twitch, actions) {
  const existing = await twitch.listRewards();
  const byId = new Map(existing.map((r) => [r.id, r]));
  const reverse = new Map(Object.entries(loadRewardMap()).map(([rid, aid]) => [aid, rid]));
  // Belohnungen auf dem Kanal, die noch KEINER Aktion zugeordnet sind - z. B. von einem früheren
  // Lauf mit inzwischen gelöschten lokalen Daten, oder von Hand mit demselben Namen angelegt.
  // Vorher per Titel (ohne Groß-/Kleinschreibung) abgleichen und VERKNÜPFEN statt blind neu
  // anzulegen, sonst lehnt Twitch das mit "Duplicate Reward" ab (siehe explain() unten) - genau
  // das passierte beim ersten echten Test.
  const linkedIds = new Set(reverse.values());
  const byTitle = new Map();
  for (const r of existing) { if (!linkedIds.has(r.id) && !byTitle.has(r.title.toLowerCase())) byTitle.set(r.title.toLowerCase(), r); }
  const map = {};
  const out = [];
  for (const a of actions.list) {
    const body = rewardBody(a, actions.categories[a.category]);
    const rid = reverse.get(a.id);
    const adopt = !rid && byTitle.get(a.title.toLowerCase());
    try {
      if (rid && byId.has(rid)) {
        await twitch.updateReward(rid, body);
        map[rid] = a.id;
        out.push({ id: a.id, title: a.title, cost: a.cost, state: a.enabled ? 'aktualisiert' : 'deaktiviert' });
      } else if (adopt && a.enabled) {
        await twitch.updateReward(adopt.id, body);
        map[adopt.id] = a.id;
        byTitle.delete(a.title.toLowerCase()); // nicht zweimal verknüpfen
        out.push({ id: a.id, title: a.title, cost: a.cost, state: 'übernommen' });
      } else if (a.enabled) {
        const r = await twitch.createReward(body);
        map[r.id] = a.id;
        out.push({ id: a.id, title: a.title, cost: a.cost, state: 'angelegt' });
      } else {
        out.push({ id: a.id, title: a.title, cost: a.cost, state: 'übersprungen' });
      }
    } catch (e) {
      out.push({ id: a.id, title: a.title, cost: a.cost, state: 'fehler', message: explain(e) });
      if (/affiliate|partner/i.test(String(e.message))) break; // sinnlos weiterzumachen
    }
  }
  saveRewardMap(map);
  return out;
}

// Belohnungen auf dem Kanal, die zu KEINER aktuellen Aktion gehören (weder verknüpft noch per
// Titel passend) - fürs Setup-Fenster/Dashboard, damit sichtbar ist, was sonst noch auf Twitch
// liegt. Rein informativ, wird von syncRewards() nicht angefasst.
export async function listUnmatchedRewards(twitch, actions) {
  const existing = await twitch.listRewards();
  const linkedIds = new Set(Object.keys(loadRewardMap()));
  const titles = new Set(actions.list.map((a) => a.title.toLowerCase()));
  return existing
    .filter((r) => !linkedIds.has(r.id) && !titles.has(r.title.toLowerCase()))
    .map((r) => ({ id: r.id, title: r.title, cost: r.cost, enabled: r.is_enabled !== false }));
}

// Einzelne Aktion (Dashboard-Schalter)
export async function syncOne(twitch, actions, actionId) {
  const a = actions.byId.get(actionId);
  if (!a) throw new Error('Unbekannte Aktion');
  const map = loadRewardMap();
  const rid = Object.keys(map).find((k) => map[k] === actionId);
  const body = rewardBody(a, actions.categories[a.category]);
  if (rid) await twitch.updateReward(rid, body);
  else if (a.enabled) { const r = await twitch.createReward(body); map[r.id] = actionId; saveRewardMap(map); }
}

// Belohnung von Twitch löschen (Dashboard: eigene Aktion entfernen). Still, falls nie verknüpft.
export async function deleteRewardFor(twitch, actionId) {
  const map = loadRewardMap();
  const rid = Object.keys(map).find((k) => map[k] === actionId);
  if (!rid) return;
  await twitch.deleteReward(rid);
  delete map[rid];
  saveRewardMap(map);
}
