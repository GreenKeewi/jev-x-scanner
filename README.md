# Jev X Scanner

A personal-use Chrome extension that classifies X/Twitter posts in real time
as you scroll: **Breaking**, **Golden Nugget**, or **AI Slop** — powered by
the [Jev API](https://docs.typesafe.ai).

See the full design at
[`docs/superpowers/specs/2026-09-21-jev-x-scanner-design.md`](docs/superpowers/specs/2026-09-21-jev-x-scanner-design.md).

## Load the extension

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Click the extension's **Details** → **Extension options** and paste in
   your TypeSafe API key (get one at https://docs.typesafe.ai).
5. Open x.com or twitter.com and scroll — posts get a "Jev Judged" badge in
   the bottom-left corner once classified.

## Settings

- **Enable/disable** the scanner entirely.
- **Throttle mode**:
  - *Classify only visible posts* (default) — only classifies posts as they
    scroll into view.
  - *Classify posts as soon as they load* — classifies every post the
    moment X renders it, even off-screen.

## Structure

- `manifest.json` — Manifest V3 config.
- `background/background.js` — service worker; owns the API key, calls Jev,
  caches results in memory.
- `content/content.js` + `content/badge.css` — observes the X timeline,
  requests classification, renders badges.
- `options/` — settings page.
- `shared/contract.js` — shared constants (storage keys, message types,
  label metadata). Note: `content/content.js` inlines a copy of these
  constants since MV3 content scripts can't reliably static-import modules;
  keep them in sync by hand if you change `shared/contract.js`.
