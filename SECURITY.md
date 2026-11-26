# Security Policy

ChaosCore sends simulated input to games and handles Twitch tokens, so security reports matter.

## Reporting a vulnerability
Please **do not open a public issue** for security problems. Use GitHub's private reporting
instead: **Security → Report a vulnerability** on this repository. You'll get an answer as soon as
possible; please give us reasonable time to fix it before publishing details.

Especially interesting:
- presets/profiles that get past the import checks (forbidden keys, focus check, panic hotkey),
- ways to send input outside the game window,
- anything that exposes tokens or makes the local server reachable from outside `127.0.0.1`,
- system actions (OBS scene/stream end, starting programs) running without being unlocked, without
  the confirmation, or with a program that isn't on the streamer's own list.

## Secrets on your PC
- The Twitch login and the OBS-WebSocket password are stored in the data folder, encrypted with
  Windows DPAPI (only your Windows account on this PC can read them).
- Neither is ever part of presets, effect exports or the diagnostic report. System actions and the
  program list are local only as well.

## Signed releases
Every release contains `SHA256SUMS.txt` (checksums of all files) and `SHA256SUMS.txt.sig`, an
Ed25519 signature over that file. The signing key never leaves the maintainer's own machine – it is
not stored on GitHub. The matching public key is listed in [`product.json`](product.json)
(`releaseKeys`) and built into every installation.

Current release key ID: **`6810315a6fac31d9`**

- **In-app updates** are only installed if the signature matches that key, then every file is
  checked against its checksum. A compromised GitHub account alone can't push an update to
  existing installations.
- **Checking a download yourself:** `node scripts/release-sign.mjs verify SHA256SUMS.txt SHA256SUMS.txt.sig`,
  then compare the file's hash (`certutil -hashfile ChaosCore-…-Setup.exe SHA256` on Windows).
- Only download ChaosCore from this repository's Releases page.

The installer itself is not yet code-signed, so Windows SmartScreen may still warn on first install.

## Supported versions
Only the latest release receives fixes.

---

**Deutsch:** Sicherheitslücken bitte nicht als öffentliches Issue, sondern privat über
**Security → Report a vulnerability** melden.
