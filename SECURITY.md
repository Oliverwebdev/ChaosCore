# Security Policy

ChaosCore sends simulated input to games and handles Twitch tokens, so security reports matter.

## Reporting a vulnerability
Please **do not open a public issue** for security problems. Use GitHub's private reporting
instead: **Security → Report a vulnerability** on this repository. You'll get an answer as soon as
possible; please give us reasonable time to fix it before publishing details.

Especially interesting:
- presets/profiles that get past the import checks (forbidden keys, focus check, panic hotkey),
- ways to send input outside the game window,
- anything that exposes tokens or makes the local server reachable from outside `127.0.0.1`.

## Supported versions
Only the latest release receives fixes.

---

**Deutsch:** Sicherheitslücken bitte nicht als öffentliches Issue, sondern privat über
**Security → Report a vulnerability** melden.
