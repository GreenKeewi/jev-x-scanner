# Jev X Scanner

A personal-use Chrome extension that classifies X/Twitter posts in real time
as you scroll: **Breaking**, **Golden Nugget**, or **Slop** — powered by
the [Jev API](https://docs.typesafe.ai).

See the full design at
[`docs/superpowers/specs/2026-09-21-jev-x-scanner-design.md`](docs/superpowers/specs/2026-09-21-jev-x-scanner-design.md).

## Setup

### 1. Get the code

Clone the repo (or download it as a ZIP and unzip it):

```sh
git clone https://github.com/GreenKeewi/jev-x-scanner.git
```

No build step, no `npm install` — it's a plain unbundled extension.

### 2. Get a Jev API key

Sign up and grab an API key at [docs.typesafe.ai](https://docs.typesafe.ai).

### 3. Load it as an unpacked extension in Chrome

1. Open `chrome://extensions` in Chrome (or any Chromium browser — Edge, Brave, etc.).
2. Turn on **Developer mode** (toggle, top right of the page).
3. Click **Load unpacked**.
4. Select the `jev-x-scanner` folder you just cloned/unzipped (the one containing `manifest.json`).
5. The extension should now appear in your extensions list and its icon in the toolbar. If the toolbar icon isn't visible, click the puzzle-piece "Extensions" icon in Chrome's toolbar and pin **Jev X Scanner**.

### 4. Add your API key

Open x.com or twitter.com — a small widget appears bottom-left of the page.
Click the **🔑** button on it and paste your API key into the modal that
opens, then Save. (You can also reach the same settings via the **⚙️**
button on the widget, or by right-clicking the extension's toolbar icon and
choosing **Options**.)

### 5. Scroll

Posts get a "Jev Judged" badge in their bottom-left corner as they scroll
into view and get classified. That's it — no further setup needed.

### Updating

Since this is loaded unpacked, picking up code changes (e.g. after a
`git pull`) just requires clicking the refresh icon on the extension's card
in `chrome://extensions`.

## Settings

Reachable via the widget's **⚙️** button, or right-click the toolbar icon → **Options**.

- **Jev API key** — same key as the widget's 🔑 modal; either place works.
- **Enable/disable** the scanner entirely.
- **What are you looking for?** — free text describing your interests; Jev
  uses it to bias the "Golden Nugget" judgment toward what you actually want.
- **Scan replies** — when off, reply posts ("Replying to @user") are skipped
  and never classified.
- **Max posts classified per page session** + **auto-reload when limit is
  reached** — caps API usage per tab; once hit, scanning pauses until you
  reload (automatically, if that toggle is on).
- **Classification criteria** — the exact definition text sent to Jev for
  each of Breaking / Golden Nugget / Slop. Edit these to change what counts
  as each category; "Reset to defaults" restores the originals.

Scanning is viewport-only (a post is classified once it actually scrolls
into view) and classification requests are queued and processed a few at a
time in the background, so a fast scroll doesn't burst dozens of API calls
at once. Promoted/ad posts are always skipped.

## Dashboard

A small floating counter (bottom-left of the X feed) shows live
Breaking/Golden Nugget/Slop counts. Click it, or click the extension's
toolbar icon, to open the dashboard — a full-page table of every classified
post with its link, engagement, and timestamp, filterable/sortable, with
Golden Nugget posts highlighted as good to reply to.

## Structure

- `manifest.json` — Manifest V3 config.
- `background/background.js` — service worker; owns the API key, calls Jev
  (including engagement, preference, and editable criteria), persists
  classified posts, opens the dashboard/options page.
- `content/content.js` + `content/badge.css` — observes the X timeline,
  scrapes text/engagement, skips ads/replies, queues and classifies visible
  posts, renders per-post badges, the floating counter widget, and the
  in-page API key modal.
- `options/` — full settings page (API key, preference, scan-replies toggle,
  session limit/auto-reload, classification criteria editor).
- `dashboard/` — the post-history dashboard, opened as a tab.
- `shared/contract.js` — shared constants (storage keys, message types,
  label metadata, PostRecord shape). Note: `content/content.js` inlines a
  copy of these constants since MV3 content scripts can't reliably
  static-import modules; keep them in sync by hand if you change
  `shared/contract.js`.
