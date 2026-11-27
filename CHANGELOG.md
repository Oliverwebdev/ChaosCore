# Changelog

All notable changes to ChaosCore. Versions follow [semantic versioning](https://semver.org);
beta builds carry a suffix such as `-beta.1`. German guides: [`docs/HANDBUCH.md`](docs/HANDBUCH.md).

## 2.1.0 (beta)

Clips that actually happen, and a way to get them onto YouTube and TikTok.

### New
- **Uploads to YouTube Shorts and TikTok:** connect each account once from the dashboard
  (Highlights → Uploads). The sign-in runs in your browser and returns to a short-lived address on
  your PC (OAuth loopback with PKCE); tokens are stored encrypted (Windows: DPAPI). Only the vertical
  version is uploaded. Default: **only on click** (↑ YouTube / ↑ TikTok in the highlight list);
  optionally automatic **after the stream** or **right away**, with a minimum score and a limit per
  stream. YouTube uploads default to **private** with `#Shorts #CS2` in the title and a link to your
  Twitch channel; TikTok uploads arrive as a **draft** in the TikTok app (max. 5 per 24 h, shown in
  the dashboard). Upload list with status, cancel and retry; network errors retry twice. Users only
  click *Connect YouTube* / *Connect TikTok*; app credentials ship with the build (developers can
  enter their own under Settings → System). Setup guide for the apps:
  [`docs/UPLOADS-EINRICHTEN.md`](docs/UPLOADS-EINRICHTEN.md) (German).
- **AI assistant (optional, any provider with a key):** Google Gemini (free tier, watches the clip
  video), OpenAI, Anthropic Claude (see stills) or any OpenAI-compatible service (OpenRouter, Groq,
  Mistral, LM Studio, Ollama; ChaosCore checks itself whether it can see images). Three clicks:
  choose AI, paste key, done; models are fetched from the provider. The AI analyzes new clips
  (automatically with a limit per stream, or per button) and writes title, hashtags, description and
  a short summary — shown as a suggestion (*Use it* / *Discard*, old title can be restored) or filled
  in directly. Uploads use the result; TikTok drafts get a caption to copy. *✨ AI suggestion* for the
  stream title and tags. Falls back from video to stills to game data, and to the built-in templates
  if the AI is unavailable. Key stored encrypted, plain http only for local AIs, viewer names are
  passed as data, answers are cleaned and shortened.
- **"Clip that!" channel point reward:** viewers trigger a clip for 2000 points (2 min cooldown,
  counts toward the clip limit per stream). Twitch clip, marker, highlight and local video; points
  are refunded when no clip is possible.
- **Clip readiness checklist** in the live cockpit (*Needs you*): Twitch permissions, OBS
  connection, replay buffer, ffmpeg, connected upload accounts — each with its button. Going live
  with a missing link highlights it and writes one warning to the log; losing OBS during a stream
  shows up there too.

### Changed
- **Highlight points:** 3 kills in a round = 3, 4 kills = 4, ace = 6, quick kills (last three within
  5 s) +1. Deaths from the auto curse no longer count unless switched on. The dashboard says in one
  sentence which moments create a marker, a Twitch clip or a video with your thresholds.
- **Vertical version:** at most 59 seconds (Shorts limit), ffmpeg runs at low priority, optionally
  rendered after the stream; waits up to 10 s for OBS to release the file.
- **Restore safety net:** the shared restore key now runs the complete `ucc_restore` alias (mouse
  buttons, crosshair, style, length, color, mouse direction); a restore that was cut off by a crash is
  sent again in the next freeze time; no second restore while another effect is running
  (binds version 11).
- Highlight titles never repeat the round or map.

### Fixed
- OBS and Twitch reconnect by themselves after a refused connection (Node fires only `error`, no
  `close`) and after a connection that never says hello. While OBS stays away the log notes it at
  most every 5 minutes.

## 2.0.0 (beta)

ChaosCore 2 focuses entirely on CS2 and gets a new look from the dashboard to the overlay.

### New
- **Dashboard rebuilt for every screen size:** eight areas (Live, Effects, Highlights, Stats,
  Community, Overlay, Bits, Settings), a live panel with queue, chaos level and emergency stop that
  stays visible everywhere, and layouts from a 420 px OBS dock up to 3440 px ultrawide. Designs:
  Dark (default), Unknown (neon) and Light. Local fonts only, still fully offline.
- **Live cockpit:** ring with the time left of the running effect, a *Needs you* inbox (expired
  login, CS2 not reporting, open Bits credit, …) with the matching button, session tiles and the
  latest highlights.
- **Effects gallery:** search and filters; every effect says in one sentence what it does; price
  and access on the card; the editor opens as a side panel with a *Trigger* section.
- **Overlay stage:** the overlay over a CS2 view with the HUD marked (radar, money, round timer,
  kill feed, health, ammo), overlap warnings, a profile card per window (visibility, size,
  position, style), drag or arrow keys. New default positions keep the CS2 HUD free.
- **Highlights:** timeline of the last stream, rules as sentences, clip limit per stream, replay
  buffer length set in OBS from ChaosCore, crop (center/left/right/full) and logo for the vertical
  Shorts version.
- **One-click ffmpeg:** pinned ffmpeg 9.0.2 (gyan.dev build via GitHub), downloaded only on click,
  verified against a SHA-256 checksum; only `ffmpeg.exe` and its license are unpacked into
  `data/tools/ffmpeg`. Removable from the dashboard.
- **Bits ladder (optional, no randomness):** Golden Kill (100), Round Naming (150), Golden Frame
  (200), Round Curse: Pistol Only (300), Boss Round (500), Chaos Parliament (800, chat votes).
  Golden moments run next to the queue and survive a restart.
- **First test in CS2:** checklist from offline bots to official Casual with *works/problem* and a
  note per step; results can be copied for bug reports.
- **Your own OBS overlays:** `/events` allows the OBS local-file origin `http://absolute`; regular
  websites and the `null` origin stay blocked.
- **Settings asked as questions**, Bits tiers shown as a ladder, hype train levels for stream
  events.

### Changed
- **Huge Crosshair works with every crosshair style.** ChaosCore reads your crosshair (style,
  length, color, alpha) from CS2's user convars, read only, and restores exactly that. Circle, dot
  and square styles briefly switch to a cross. The binds no longer force `cl_crosshairstyle 4`.
  They are rewritten when your crosshair changes (binds version 10).
- Bits never pick at random anymore: the Bits menu without a keyword runs nothing or a fixed item;
  the old Bits curse picks deterministically without the wheel; *Challenge* became *Dare*
  (no bet).
- Bits are off by default on new installs. Older Bits tiers stay available as "old" and are
  switched off on upgrade because the new ladder uses the same prices.
- Localized tiers, access levels and times; dashboard paint errors are logged instead of being
  shown as a connection problem.

### Removed
- The Fortnite profile. Configurations that used it move to CS2 automatically.

## 1.2.0 (not released separately, included in 2.0.0)
- Effect editor with building blocks, copy, restore, export/import of single effects.
- Bits expansion: menu per minute or round, community pot, dares, Bits credit that never gets lost.
- Highlights: stream markers, Twitch clips, varied titles, local clips through the OBS replay buffer,
  vertical version for Shorts.
- Raid, follow, sub and Hype Train can trigger effects.
- OBS connection and optional system actions (scene, source, end stream with countdown, start a
  program), asking first by default.
- Signed updates.

## 1.1.0 (beta)
- One-click updates from GitHub releases, verified with SHA-256 checksums; later releases are also signed.
- Bits menu: a keyword in the cheer picks the effect, 100 Bits = 1 minute.
- Mini view in the same window, overlay windows can be switched on/off and styled individually.
- Twitch login stays alive; an expired login opens the dashboard with a re-login button.

## 1.0.0-beta.1
- First public release: CS2 profile with 23 effects, channel points and Bits tiers, OBS overlay,
  dashboard, presets, seasons, community goal and Session Stats.
