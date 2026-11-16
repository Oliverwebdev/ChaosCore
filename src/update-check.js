// Update-Prüfung über die öffentliche GitHub-Releases-API. Kein eigener Server nötig.
// Ohne eingetragenes Repo (product.json: githubRepo) bleibt das komplett inaktiv.

// "1.2.3" oder "v1.2.3" -> [1,2,3]. Nicht-numerische/fehlende Teile zählen als 0.
function parseVersion(v) {
  return String(v || '').trim().replace(/^v/i, '').split('.').map((n) => Number(n) || 0);
}

// > 0 wenn a neuer als b, < 0 wenn älter, 0 wenn gleich.
export function compareVersions(a, b) {
  const pa = parseVersion(a); const pb = parseVersion(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// repo: "owner/name" aus product.json (leer = Funktion ausgeschaltet). currentVersion: package.json version.
export async function checkForUpdate(repo, currentVersion) {
  repo = String(repo || '').trim();
  if (!repo) return { configured: false };
  if (!REPO_RE.test(repo)) return { configured: true, error: `Ungültiges Repo-Format in product.json: "${repo}" (erwartet "besitzer/name").` };
  let res;
  try {
    res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'chaoscore-update-check' },
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    return { configured: true, error: `Keine Verbindung zu GitHub (${e.cause?.code || e.message}).` };
  }
  if (res.status === 404) return { configured: true, error: 'Noch kein Release auf GitHub veröffentlicht.' };
  if (!res.ok) return { configured: true, error: `GitHub-API ${res.status}.` };
  let data;
  try { data = await res.json(); } catch { return { configured: true, error: 'Antwort von GitHub war kein gültiges JSON.' }; }
  const latest = data.tag_name || '';
  const newer = compareVersions(latest, currentVersion) > 0;
  return { configured: true, current: currentVersion, latest, newer, url: data.html_url || `https://github.com/${repo}/releases/latest` };
}
