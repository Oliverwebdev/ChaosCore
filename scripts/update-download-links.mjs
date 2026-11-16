// Updates the big download button in README.md and README.de.md to point at a release.
// Used by .github/workflows/release.yml after publishing:
//   node scripts/update-download-links.mjs v1.0.0-beta.2 ChaosCore-1.0.0-beta.2
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const [tag, base] = process.argv.slice(2);
if (!/^v[0-9][\w.-]*$/.test(tag || '') || !/^[\w.-]+$/.test(base || '')) {
  console.error('usage: node scripts/update-download-links.mjs <tag> <file-basename>');
  process.exit(1);
}
const url = `https://github.com/Oliverwebdev/ChaosCore/releases/download/${tag}/${base}`;
const START = /<!-- download:start[^>]*-->[\s\S]*?<!-- download:end -->/;

for (const [file, image, alt, zip, all] of [
  ['README.md', 'download-windows.png', 'Download ChaosCore for Windows', 'portable ZIP (no install)', 'all versions'],
  ['README.de.md', 'download-windows-de.png', 'ChaosCore für Windows herunterladen', 'portable ZIP (ohne Installation)', 'alle Versionen'],
]) {
  const p = path.join(ROOT, file);
  const text = fs.readFileSync(p, 'utf8');
  if (!START.test(text)) throw new Error(`${file}: download block not found`);
  const block = `<!-- download:start (updated automatically by the release workflow) -->
<p align="center">
  <a href="${url}-Setup.exe"><img src="docs/images/${image}" alt="${alt}" width="440"></a>
  <br>
  <sub><b>${tag}</b> · <a href="${url}-Setup.exe">Setup.exe</a> · <a href="${url}-portable.zip">${zip}</a> · <a href="https://github.com/Oliverwebdev/ChaosCore/releases">${all}</a></sub>
</p>
<!-- download:end -->`;
  fs.writeFileSync(p, text.replace(START, block));
  console.log(`${file}: ${tag}`);
}
