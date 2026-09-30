# AGENTS.md

## Active system

This is a dependency-free Node.js VPS service. It reads X posts, measures engagement growth, and uses Jev for two distinct lanes: routed Dreamwork reply opportunities and actionable building-in-public inspiration. It never drafts or posts X replies. A read-only password-protected dashboard exposes operations; a single noon Eastern digest may go to the approved private Slack channel.

The former Chrome extension remains in `manifest.json`, `background/`, `content/`, `options/`, `dashboard/`, and `shared/`. Treat it as legacy and out of scope unless explicitly requested. The README preserves its historical instructions separately.

## Files and checks

- `server/server.js` — service configuration, X client, discovery/fallback, growth, Jev, Slack, auth, HTTP, and scheduling
- `server/budget.js` — durable cross-process raw-post cap and fail-closed recovery state
- `public/` — operational dashboard, focused reply list, and login
- `tests/` — isolated Node tests with mocked X, Jev, and Slack
- `docs/deployment.md` — first-ledger migration, exact-commit rollout, verification, and recovery
- `data/state.json`, `data/posts.json` — runtime history/post state
- `data/x-budget.json`, `data/x-budget.initialized`, `data/x-budget.lock` — ledger, initialization marker, and exclusive transaction lock
- `data/work-claims/`, `data/notification-claims/` — durable suppression of duplicate work/delivery

Node 18+ is required (Docker uses Node 20). No dependency install/build is needed for direct execution. Run these offline-safe checks against the final changes:

```sh
node --check server/server.js
node --check server/budget.js
node --test tests/*.test.js
```

`npm start` is a live operation: with real credentials it can poll X immediately, resume Jev work, or send a due Slack batch. Never use it as a paid smoke test. Tests must use temporary directories and mocked network calls, not production `.env` or data. Evaluation or `RUN_ONCE` flags are not dry-run safety controls.

## Fixed behavior and invariants

1. Discovery follows `America/New_York`: broad replies at 7 and 9 AM, watched sources at 8 AM, broad inspiration at 10 AM, and watch remainder at 11 AM. DST is handled by the timezone, not a fixed UTC offset. Work claims prevent repeated slot reads.
2. Broad search is independent of watched accounts. Preserve capability fallback for unsupported search operators and X 400/403 responses without bypassing reservations or endpoint minimums. Timeline fallback is supplemental watch traffic, never a replacement broad lane.
3. The **100 raw returned posts/day UTC** safety limit is fixed: `broad` 30, `watch` 10, `first_refresh` 40, `baseline` 10, `flex` 10. Count all returned posts and expansions before dedupe/filtering; repeat reads count again. This is not an X plan entitlement or monetary cap.
4. Every post-returning call must reserve durably before network access and respect the reserved result count. Refund only a verified response's unused portion. Unknown transport/parse/crash outcomes retain the debit. Previous-day unresolved calls block future days; clock rollback, corruption, missing initialized data, uncertain writes, or stale locks fail closed. Upstream over-return halts further reads.
5. All concurrent processes must share the same durable data directory with POSIX atomic and `fsync` semantics. Never reset/delete the ledger, marker, pending reservations, or claims to restore capacity. Never steal a lock on age/PID assumptions. Follow the runbook with every writer stopped.
6. Require fresh English content, two snapshots at least 30 minutes apart, the existing engagement score/velocity thresholds, and explicit Jev safety approval. Do not weaken gates to fill a batch. Inspiration additionally requires actionable usefulness and unsaturated/emerging evidence, and must never gain a reply route or copied content.
7. Exactly one daily noon batch is eligible, during 12:00–12:04 Eastern, capped at 10 total posts including at most 3 inspiration posts. Empty batches stay silent. Durable delivery intent/claims must precede external send; uncertain Slack outcomes are not automatically retried or replayed on later days.
8. Slack destination is fixed to approved private `#ark-dreamwork` / `C0C1BAFBEFK`, using the existing authorized bot. Legacy webhook delivery is disabled because its target cannot be verified. `SLACK_CHANNEL_ID` cannot redirect delivery. Token identity, privacy, membership, and access migration must be verified before rollout; do not create credentials or widen access without authorization.

## Security and persistence

- Root `.env` is optional; ordinary environment variables take precedence. `DASHBOARD_PASSWORD` is required. Never commit/print credentials, session secrets, webhook URLs, or complete resolved compose configuration. Never expose them through HTML or API responses
- Keep the service read-only toward X. Do not add X post/reply actions without explicit authorization
- Preserve bounded history/posts (2,000 each) and logs (500), safe HTML/URL escaping, rate-limit recording, and authenticated API/SSE routes
- Preserve the entire production data directory across releases, including work/delivery claims; a state-only backup is insufficient
- An old uncapped build is not a safe live rollback. Keep it stopped or disable X, Jev, and Slack until a compatible capped build is ready; never overwrite current ledger/claims with an older backup
- Existing legacy `state.json` or `posts.json` without an initialized budget triggers `migration_day_exhausted` for that UTC day. Preserve these files; never delete them to evade the guard. It cannot detect old in-flight requests or other readers
- On first migration, do not initialize a full allowance mid-day after old reads. Stop the old service before UTC cutoff, establish that no old request can return, and begin on the next UTC day, or reconcile exact known same-day usage first

## Verification and rollout truthfulness

Run syntax and full mocked tests after changes. Verify unauthenticated `/api/stats` returns `401`, then have an authorized operator use normal login to inspect budget and diagnostics. UI work also needs `/`, `/qualified`, login/logout, and SSE checks. Do not trigger a paid X smoke call or Slack test message for deployment validation.

Source changes and passing tests do not establish live health. In this cloud task, the droplet SSH host/configuration and usable DigitalOcean browser access were unavailable; no live deployment or live root-cause diagnosis has been performed. An authorized operator must verify the actual host, existing configuration, storage, bot access, and exact reviewed commit before deployment. Do not guess hosts/secrets, merge as a deployment step, or claim rollout completion without evidence.
