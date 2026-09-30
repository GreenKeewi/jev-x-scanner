# AGENTS.md

## What this repo is

The active system is a dependency-free Node.js service for a VPS, not a browser extension. It polls the X Developer API for posts from watched accounts, tracks engagement momentum, uses Jev to decide whether @dreamworkhq should reply, optionally alerts Slack for the best opportunities, and provides a password-protected read-only dashboard.

The former Chrome extension remains in `manifest.json`, `background/`, `content/`, `options/`, `dashboard/`, and `shared/`. Treat it as legacy and out of scope unless the task explicitly names it.

## Files that matter

- `server/server.js` — all service logic: config, X API client, discovery fallback, growth tracking, Jev queue, Slack notifications, persistence, authentication, HTTP routes, and polling.
- `public/index.html` — live operational dashboard; polls JSON APIs and streams logs through SSE.
- `public/qualified.html` — focused list of `reply_now` posts.
- `public/login.html` — password login page.
- `data/state.json` — persisted follower-history data, generated at runtime.
- `data/posts.json` — persisted post queue/history, generated at runtime and capped at 2,000 entries.
- `package.json` — the only command is `npm start`.

## Running it

Node 18+ is required. There is no install/build/lint/test step.

```sh
npm start
node --check server/server.js
```

The process reads root `.env` if present, otherwise ordinary environment variables. Never commit or print `.env`, credentials, signed-session secrets, or Slack webhook URLs. `DASHBOARD_PASSWORD` is mandatory, and `X_BEARER_TOKEN` is needed for useful polling.

## Scanner flow

1. A poll runs immediately at startup, then at `POLL_INTERVAL_SECONDS` (at least once per minute).
2. The service optionally fetches a tracked account profile/recent posts (`X_USERNAME`), scans `X_WATCH_ACCOUNTS`, and reads X usage.
3. Watched-post discovery prefers recent search. X API 400/403 capability failures switch it permanently to per-account timelines for that process lifetime.
4. New posts younger than `MAX_POST_AGE_HOURS` are persisted with a first engagement snapshot. Rechecks occur at `RECHECK_MINUTES`.
5. Momentum is calculated from `likes + 2 * reposts + 3 * replies`; posts below the velocity bar are auto-skipped to conserve Jev calls.
6. Posts with sufficient momentum enter a concurrency-limited Jev queue. Jev returns one of `reply_now`, `maybe`, or `skip`, plus a structured reason; every `reply_now` must also name `dreamwork`, `ben`, or `colin` as the suitable voice. Failures get one retry.
7. Only a routed `reply_now` can send a one-time Slack notification. The service does not draft or post X replies. Evaluation mode can review all sampled posts and retain them for scheduled rechecks.

## Change safely

- Keep raw X/Jev/Slack secrets server-side. Do not add them to `public/` or API responses.
- Preserve X rate-limit recording and the search-to-timeline fallback; API tier capabilities vary.
- Keep writes bounded: follower history retains 2,000 entries; posts retain 2,000 entries; logs retain 500 entries.
- Preserve escaping of post text and URLs before inserting them into dashboard HTML.
- The server is intentionally read-only toward X: never add reply/post actions without explicit authorization.
- If adjusting scoring or criteria, update the code comments and any relevant dashboard copy so operator expectations match behavior.

## Verification checklist

- Run `node --check server/server.js`.
- Start with a safe `.env`, sign in, and confirm `/api/stats` is authenticated.
- Confirm a poll appears in live logs, watched posts appear in `/api/posts`, and persisted `data/` files survive a restart.
- If changing UI, verify `/`, `/qualified`, login/logout, and the live log stream in a browser.
