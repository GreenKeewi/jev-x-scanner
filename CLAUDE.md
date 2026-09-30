# CLAUDE.md

## Active project

This repository's live product is a small, password-protected Node.js dashboard and polling service intended to run continuously on a VPS. It uses the X Developer API to discover posts from configured accounts, measures their engagement growth, asks Jev whether @dreamworkhq should reply, optionally posts qualifying opportunities to Slack, and presents the results in a read-only web dashboard.

It is **not** an active Chrome extension. `manifest.json`, `background/`, `content/`, `options/`, `dashboard/`, and `shared/` are legacy extension code. Do not change or deploy that code unless explicitly restoring the former extension product.

## Run and deploy

- Runtime: Node.js 18+; no dependencies or build step.
- Start locally or on the VPS with `npm start` (runs `node server/server.js`).
- Configuration is read from environment variables, with a root `.env` file as an optional convenience. Never commit `.env`, API tokens, passwords, webhook URLs, or generated `data/` files.
- `DASHBOARD_PASSWORD` is required; the server exits when it is missing.
- Persistent runtime data is written to `data/state.json` (follower history) and `data/posts.json` (up to 2,000 discovered posts). Preserve this directory across VPS deploys/restarts when history is wanted.

## Runtime architecture

`server/server.js` is the entire backend and scheduler:

1. Loads configuration and persisted data, starts an HTTP server, then immediately polls on a recurring interval (minimum 60 seconds).
2. Uses X API endpoints to optionally collect one account's metrics (`X_USERNAME`), discover recent posts from watched accounts (`X_WATCH_ACCOUNTS`), and retrieve X API usage/rate-limit information.
3. Tries recent-search discovery first. If the API tier rejects it, it automatically falls back to each watched account's timeline.
4. Stores each discovered post and takes engagement snapshots. A weighted engagement score is `likes + 2×reposts + 3×replies`; velocity is the score gained per hour between snapshots (or the average since posting for the first snapshot).
5. Automatically skips old or insufficiently fast posts. Posts that clear the configured velocity threshold are sent to Jev using the `reply_now`, `maybe`, and `skip` choices. Each successful Jev review also records one structured inclusion/exclusion reason and, for `reply_now`, the appropriate speaker: `dreamwork`, `ben`, or `colin`.
6. Optionally sends each newly qualified, routed `reply_now` post to Slack once. The service never drafts or posts an X reply.
7. Serves a password-gated dashboard and JSON/SSE endpoints consumed by the plain HTML pages in `public/`.

The dashboard never posts or replies to X. It only discovers, evaluates, displays, and optionally notifies.

## Important configuration

- Required: `DASHBOARD_PASSWORD`, `X_BEARER_TOKEN` for API polling.
- Discovery: `X_WATCH_ACCOUNTS` (comma-separated), `X_SEARCH_QUERY`, `X_INCLUDE_REPLIES`, `MAX_POSTS_PER_POLL`, `DISCOVERY_MIN_LIKES`, `MAX_POST_AGE_HOURS`.
- Evaluation: `JEV_API_KEY`, `JEV_CONCURRENCY`, `JEV_PREFERENCE`, `DREAMWORK_DESCRIPTION`, `MIN_VELOCITY_PER_HOUR`, `RECHECK_MINUTES`; isolated evaluation runs can use `EVAL_ALL_POSTS`, `EVAL_POST_LIMIT`, `DATA_DIR`, and `X_SEARCH_QUERIES`.
- Optional integrations: `SLACK_WEBHOOK_URL`, `X_USERNAME`, `POLL_INTERVAL_SECONDS`, `PORT`, `SESSION_SECRET`.

`DREAMWORK_DESCRIPTION` is the brand/context given to Jev; take particular care when changing it because it materially changes which posts are recommended. `JEV_PREFERENCE` appends more specific evaluator guidance. Both are server-only configuration, not browser settings.

## HTTP surface

- Public only: `GET/POST /login`; `GET /logout`.
- Authenticated pages: `/` (dashboard) and `/qualified` (qualified opportunities).
- Authenticated JSON: `/api/stats`, `/api/posts?label=&limit=`, `/api/logs`.
- Authenticated live logs: `/api/logs/stream` (Server-Sent Events).
- All non-login routes are GET-only. Sessions are signed 12-hour `HttpOnly`, `SameSite=Strict` cookies. Failed password attempts are rate-limited in memory.

## Editing and verification

- Keep the service dependency-free unless there is a clear operational benefit; it intentionally uses Node's built-in `http`, `fs`, `path`, and `crypto` modules.
- Preserve the fallback from search to timeline scanning, rate-limit tracking, bounded Jev concurrency, one Jev retry, and periodic persistence behavior when changing the scanner.
- Before deployment, at minimum run `node --check server/server.js` and manually start the service with safe test credentials. Verify login, `/api/stats`, dashboard refresh, and an expected poll cycle.
- Treat X and Jev responses as untrusted. Preserve the existing escaping in the browser pages and avoid exposing `.env` values through APIs, logs, or HTML.
