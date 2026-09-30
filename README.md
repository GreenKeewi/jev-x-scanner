# Jev X Scanner

The active application is a dependency-free Node.js service for an existing VPS. It finds relevant X conversations for Dreamwork, measures engagement growth, asks Jev to qualify them, and provides a password-protected read-only dashboard. A separate building-in-public lane finds actionable inspiration for original content. It never drafts or posts X replies.

**Deployment is not completed by these source changes.** The existing droplet has not been inspected or updated from this cloud workspace: a verified SSH host/configuration is unavailable here and the DigitalOcean browser route is unavailable. The fixes address observed code paths, not a verified diagnosis of the live droplet. Follow the [deployment and recovery runbook](docs/deployment.md) before rollout.

## Daily behavior

- Discovery uses `America/New_York`, including daylight saving time: broad reply-topic discovery at 7 AM and 9 AM, watched sources at 8 AM, broad building-in-public inspiration at 10 AM, and an 11 AM watched-source opportunity only if its allowance remains
- Watched sources supplement broad discovery; they do not replace it. Defaults include `jantegze`, `Adam_Karpiak`, `HungLee`, and `GergelyOrosz` for replies, and `tristan_cte`, `codyschneider`, and `benln` for inspiration. Additional names may be configured
- A mandatory first refresh is due 30 minutes after discovery. Delivery requires two observations at least 30 minutes apart, fresh English content, the engagement thresholds, and explicit Jev content-safety approval
- One Slack batch is eligible at **noon Eastern**, with a 12:00–12:04 grace window. It contains **at most 10 posts total, including at most 3 inspiration posts**, and is sent only to approved private **#ark-dreamwork (`C0C1BAFBEFK`)** using the existing authorized bot
- Reply picks must be `reply_now` with a valid Dreamwork, Ben, or Colin route. Inspiration must be actionable and judged unsaturated or emerging from the available evidence; it has no reply recipient. Inspiration is for original learning, not copying or reply recommendations
- Fewer than 10 picks, or none, is valid. Empty batches do not send Slack messages. Do not lower quality/safety gates to fill a batch. A missed noon window is not sent later
- Durable claims prevent replay after restarts, concurrent processes, or ambiguous Slack outcomes. An uncertain send is not automatically retried

## The 100-post X budget

The service caps **raw returned posts at 100 per UTC day** across its post-returning X endpoints. This is a local safety limit, **not an X billing entitlement, credit, price guarantee, or a cap on all API calls**. X profile/usage requests do not return posts and are outside this count. Other applications using the same X credentials are not coordinated by this ledger.

X documents billing deduplication within each UTC day as a soft guarantee. This scanner deliberately still counts every repeated raw return toward its operational cap. [X pricing and deduplication documentation](https://docs.x.com/x-api/getting-started/pricing) (checked 2026-09-30).

The fixed reservations are:

| Lane | Raw posts/day | Purpose |
| --- | ---: | --- |
| `broad` | 30 | Reply discovery and building-in-public discovery |
| `watch` | 10 | Supplemental watched-account search or timeline fallback |
| `first_refresh` | 40 | First measured engagement comparisons |
| `baseline` | 10 | Optional tracked account's recent-post baseline |
| `flex` | 10 | Optional later engagement refreshes |

Each response counts before deduplication, language/topic/age filtering, and storage limits. Re-reading the same post counts again. The service reserves capacity durably before fetching, honors endpoint minimums, and refunds unused capacity only after a verified response. Timeout, transport, malformed-response, crash, and uncertain-storage outcomes fail conservatively. Unresolved requests from a previous UTC day block future post reads until reconciled; midnight does not erase them. An upstream over-return is recorded and halts further reads, but software cannot undo posts already returned.

All scanner processes must use the **same persistent `DATA_DIR` on a filesystem supporting POSIX atomic operations and `fsync`**. Preserve its ledger, initialization marker, work claims, and notification claims across releases. Never clear them to recover allowance or retry a batch. When legacy state exists without a budget, the migration day is conservatively exhausted (`migration_day_exhausted`) until the next UTC day. Never remove old state to evade this guard; it does not detect other processes or late old requests. A first deployment over an uncapped old service still needs the [UTC cutover procedure](docs/deployment.md#first-budgeted-deployment-utc-cutover).

## Configure and verify locally

Requires Node.js 18+; the Docker image uses Node.js 20. There are no npm dependencies or compilation step.

```sh
node --check server/server.js
node --check server/budget.js
node --test tests/*.test.js
```

The automated tests use temporary data and mocked external requests. They do not perform paid X reads, call Jev, or send real Slack messages.

Copy `.env.example` to `.env` for a new local setup only; **never overwrite an existing deployment's `.env`**. Keep credentials server-side and out of logs, source control, screenshots, and API responses. `DASHBOARD_PASSWORD` is required. A dashboard-only local start can leave X, Jev, and Slack credentials blank; do not use production data for that test.

```sh
npm start
```

With credentials present, startup can immediately poll X, resume Jev work, and send a due Slack batch. `npm start` is not a dry run. `RUN_ONCE` or evaluation settings are not safe substitutes for disabling external access.

Before production, verify that the existing Slack bot token has access to private `C0C1BAFBEFK` and is authorized to post there. `SLACK_WEBHOOK_URL` delivery is intentionally disabled because a webhook URL does not establish the approved destination. `SLACK_CHANNEL_ID` cannot change the fixed destination. If bot migration needs new credentials or wider access, stop and obtain authorization rather than creating them as part of deployment.

## Dashboard and operations

- `/` — operational dashboard
- `/qualified` — focused reply-opportunity list
- `/api/stats` — authenticated status, request/rate-limit state, durable budget and per-lane balance, and discovery/rejection diagnostics
- `/api/posts` — authenticated post history (including `sourceLane` and inspiration judgments)
- `/api/logs` and `/api/logs/stream` — authenticated recent logs and live events

Unauthenticated API requests must return `401`. Use the normal password login for operator checks. The dashboard and API do not provide a manual spend or send button. Diagnostics describe the current process; the budget and claims are durable. Use [the runbook](docs/deployment.md) for safe verification, empty-result investigation, rollback, and ledger recovery.

## Service structure

- `server/server.js` — scheduling, discovery, growth tracking, Jev, Slack, authentication, and HTTP routes
- `server/budget.js` — cross-process durable raw-post reservations, settlement, and UTC rollover
- `public/` — service dashboard, qualified-post list, and login page
- `tests/` — isolated scanner, inspiration, scheduling, and budget tests
- `data/` — runtime post/state files, budget ledger/marker, work claims, and notification claims; mount persistently and back up together
- `Dockerfile` and `compose.yaml` — existing-droplet Docker service

## Legacy Chrome extension

The following describes the historical extension, not the active VPS service. Its files remain useful for explicitly requested extension work; loading the extension does not configure or start the service, and extension settings do not control the server's X budget or Slack schedule.

A personal-use Chrome extension that classifies X/Twitter posts in real time
as you scroll: **Breaking**, **Golden Nugget**, or **Slop** — powered by
the [Jev API](https://docs.typesafe.ai).

See the full design at
[`docs/superpowers/specs/2026-09-21-jev-x-scanner-design.md`](docs/superpowers/specs/2026-09-21-jev-x-scanner-design.md).

### Setup

#### 1. Get the code

Clone the repo (or download it as a ZIP and unzip it):

```sh
git clone https://github.com/GreenKeewi/jev-x-scanner.git
```

No build step, no `npm install` — it's a plain unbundled extension.

#### 2. Get a Jev API key

Sign up and grab an API key at [docs.typesafe.ai](https://docs.typesafe.ai).

#### 3. Load it as an unpacked extension in Chrome

1. Open `chrome://extensions` in Chrome (or any Chromium browser — Edge, Brave, etc.).
2. Turn on **Developer mode** (toggle, top right of the page).
3. Click **Load unpacked**.
4. Select the `jev-x-scanner` folder you just cloned/unzipped (the one containing `manifest.json`).
5. The extension should now appear in your extensions list and its icon in the toolbar. If the toolbar icon isn't visible, click the puzzle-piece "Extensions" icon in Chrome's toolbar and pin **Jev X Scanner**.

#### 4. Add your API key

Open x.com or twitter.com — a small widget appears bottom-left of the page.
Click the **🔑** button on it and paste your API key into the modal that
opens, then Save. (You can also reach the same settings via the **⚙️**
button on the widget, or by right-clicking the extension's toolbar icon and
choosing **Options**.)

#### 5. Scroll

Posts get a "Jev Judged" badge in their bottom-left corner as they scroll
into view and get classified. That's it — no further setup needed.

#### Updating

Since this is loaded unpacked, picking up code changes (e.g. after a
`git pull`) just requires clicking the refresh icon on the extension's card
in `chrome://extensions`.

### Settings

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

### Dashboard

A small floating counter (bottom-left of the X feed) shows live
Breaking/Golden Nugget/Slop counts. Click it, or click the extension's
toolbar icon, to open the dashboard — a full-page table of every classified
post with its link, engagement, and timestamp, filterable/sortable, with
Golden Nugget posts highlighted as good to reply to.

### Structure

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
