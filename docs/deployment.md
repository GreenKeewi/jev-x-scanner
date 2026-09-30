# Existing-droplet rollout and recovery

## Status and scope

**No live deployment has been completed from this cloud task.** The cloud workspace does not have a verified droplet SSH host/configuration, and a usable DigitalOcean browser route was unavailable. Do not invent a hostname, credentials, cloud resource, or deployment result. The changes fix code-level discovery, raw-post accounting, scheduling, and delivery behavior; they do not prove why the existing live droplet did or did not produce results.

This procedure is for the **already authorized existing droplet**, its existing Docker Compose scanner service, existing credentials, and existing data volume. It is not permission to create a droplet, credential, bot, OAuth grant, or wider access, merge a branch, change DNS/firewall settings, or send test messages. Deploy the exact reviewed commit only after the operator has verified the missing access and configuration.

The intended result is one noon `America/New_York` digest in approved private `#ark-dreamwork` (`C0C1BAFBEFK`), containing at most 10 total qualified posts, including at most 3 building-in-public inspiration posts. Both lanes use that same approved destination. Empty batches stay silent. The raw X-post cap is 100 per UTC day, independent of X billing entitlements.

X documents same-resource billing deduplication within a UTC day as a soft guarantee; the local safety budget intentionally counts repeated raw returns anyway. See [X pricing and deduplication](https://docs.x.com/x-api/getting-started/pricing) (checked 2026-09-30). Do not infer current account pricing or remaining entitlement from the local ledger.

## Preflight: establish the actual deployment

1. Identify the existing droplet, authorized access route, repository directory, Compose project/service, image, persistent data mount, port, and HTTPS/reverse-proxy routing from verified operator records. Do not infer them from this document. If a required fact or access is missing, stop the dependent step
2. Check for all scanner copies: Docker containers, systemd/PM2/cron jobs, manual Node processes, and other hosts using this scanner or the same credentials. They must not continue uncapped reads or use a separate ledger. The budget coordinates only processes that share its data directory
3. Confirm a persistent, writable local POSIX filesystem with working atomic `mkdir`/`rename` and `fsync`; do not silently replace it with an ephemeral or incompatible volume. Confirm time synchronization and UTC date. Preserve the existing proxy and access restrictions; do not expose a new public port as part of this change
4. Inspect configuration privately without printing `.env`, container environment, signed cookies, tokens, webhook URLs, or unredacted `docker compose config`. Verify the existing password and X/Jev credentials are present where intended, `DATA_DIR` maps to the same persistent directory, and the process uses the intended `.env`. The example file is a template, not a replacement production configuration
5. Verify the existing Slack bot identity, private channel identity `C0C1BAFBEFK`, membership, and existing permission to post there using read-only Slack administration/API information available to the operator. Do not send a probe message. The destination is fixed in code, not selected by `SLACK_CHANNEL_ID`
6. **Webhook-only deployments require a verified bot migration before rollout.** Incoming webhook delivery is deliberately disabled because the URL does not verify its destination. Do not assume an existing webhook means the bot is configured or allowed in the private channel. If token creation, installation, new scopes, or membership changes require additional authorization, stop and obtain that authorization separately. Do not claim delivery is working until this is resolved
7. Record the exact reviewed commit SHA and prior source/image identifiers. A branch name or “latest” is insufficient. Review changed configuration and storage semantics. Do not merge or run `git pull` as a deployment step

Safe initial inspection on the verified host, after setting `DEPLOY_DIR` to its actual existing checkout:

```sh
: "${DEPLOY_DIR:?Set the verified existing checkout path}"
cd "$DEPLOY_DIR"
date -u
git status --short
git rev-parse HEAD
docker compose version
docker compose ps
```

Use the actual container ID from that output to inspect only mounts and image identifiers. Avoid inspecting its complete environment. Stop if the deployment differs from `compose.yaml`; adapt the procedure to verified facts before proceeding.

## First budgeted deployment: UTC cutover

An old build has no durable post budget. A brand-new ledger cannot infer posts it already read earlier today. **Never initialize a fresh 100-post allowance mid-day after old uncapped reads.** X account usage numbers are not necessarily an exact per-call/raw-post ledger and should not be treated as one without verification.

The safest first rollout is:

1. Choose a UTC midnight cutover, and stop **all** old scanner processes well before it. Ensure automatic restarters, scheduled jobs, and duplicate hosts cannot revive the old service
2. Establish from process/network state and available X-side request evidence that no old request remains active or could return after the cutoff. A local timeout or killing a process alone does not prove the remote request never returned posts. If the outcome remains uncertain, keep external reads disabled; do not treat midnight as evidence that it is resolved
3. Take the consistent backup below after writers have stopped
4. Start the new capped service on or after the next UTC day only once the old-request condition is established, preserving old state and all available evidence. There must be no other uncapped reader sharing the intended allowance

Alternatively, an operator may reconcile **exact known same-day raw usage and completed request outcomes** into a compatible validated ledger before start, with a reviewed migration and no calls in flight. There is no automatic reconciliation tool in this runbook. Unknown counts, approximate billing dashboards, and guessed lane assignments are insufficient; use the safe cutoff or remain stopped.

The service also has a conservative first-migration guard: when `state.json` or `posts.json` already exists but no initialized budget does, it exhausts the migration day's allowance and reports `migration_day_exhausted` until the next UTC day. A genuinely fresh install without legacy state begins with zero usage. If its first initialization is after the chosen midnight, expect it to remain paused for that entire new UTC day and resume no earlier than the following midnight. Do not bypass that conservative pause. This guard does not discover other processes or late old requests, and does not replace the shutdown/cutover checks. **Never delete old state to evade the guard.** A missing ledger after initialization is a fault, not a fresh install.

## Backup, tests, and exact-commit deployment

These commands are an operator checklist, not evidence that they have run. Use the confirmed existing service name (`scanner` only if verified) and mount (`./data` only if verified). Set `REVIEWED_COMMIT` to the exact approved SHA and `BACKUP_ROOT` to an existing secure directory outside the checkout. Keep the backup local and access-restricted; `.env` contains secrets and must not be attached to tickets or copied to unapproved destinations.

Create a protected release record and preserve the prior image identifier before building:

```sh
: "${REVIEWED_COMMIT:?Set the exact reviewed commit SHA}"
: "${BACKUP_ROOT:?Set an approved secure backup directory outside the checkout}"
umask 077
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="$BACKUP_ROOT/jev-x-scanner-$STAMP"
mkdir -m 700 "$BACKUP_DIR"
git rev-parse HEAD > "$BACKUP_DIR/previous-commit.txt"
docker compose images -q scanner > "$BACKUP_DIR/previous-image.txt"
install -m 600 .env "$BACKUP_DIR/env.backup"
```

Retain the recorded prior image locally through the deployment using the existing release process; do not prune it. It is for diagnosis or a disabled rollback, not permission to run the old uncapped scanner. Stop if the working tree has local changes; preserve and review them rather than overwriting them:

```sh
git diff --exit-code
git diff --cached --exit-code
test -z "$(git ls-files --others --exclude-standard)"
git fetch origin "$REVIEWED_COMMIT"
git cat-file -e "$REVIEWED_COMMIT^{commit}"
git checkout --detach "$REVIEWED_COMMIT"
test "$(git rev-parse HEAD)" = "$REVIEWED_COMMIT"
node --check server/server.js
node --check server/budget.js
node --test tests/*.test.js
docker compose build scanner
```

Run the tests with Node 18+ on the host or in an isolated approved Node container with network disabled, a read-only checkout, and temporary writable test storage. The service image does not include `tests/`, so do not assume tests ran inside it. These tests mock external requests; no paid X/Jev smoke test or Slack message is needed. If any check fails, stop before deploying. Record the results and reviewed image/source association.

Before the cutover, stop the existing scanner and every other writer identified in preflight. For the verified Compose service:

```sh
docker compose stop scanner
docker compose ps
```

Stopping Compose is not sufficient if another process/host is active. After confirming all writers have stopped, make a consistent backup of the **entire** verified data directory, including hidden files, work claims, notification claims, budget marker/ledger, any leftover lock, and uncertain temporary files:

```sh
test -d data
tar -czf "$BACKUP_DIR/data.tar.gz" data
chmod 600 "$BACKUP_DIR/data.tar.gz"
```

Preserve logs privately if needed for reconciliation, avoiding secret disclosure. Do not use `docker compose down -v`, remove `data/`, or copy a stale backup over current state.

Only after passing the migration/UTC-cutover and Slack-access gates, start the reviewed build:

```sh
test "$(git rev-parse HEAD)" = "$REVIEWED_COMMIT"
docker compose up -d --no-deps scanner
docker compose ps
```

The Compose restart policy is `unless-stopped`. Verify the old process remains stopped and no duplicate service is started. Starting with production credentials is live operation: the service immediately polls, can resume queued Jev work, and can send at noon if eligible. Do not launch an extra production instance just for testing.

## Verify without extra paid calls or test messages

1. Confirm the running container uses the image built from the reviewed SHA and the original persistent data mount. Record the actual deployment time and source/image IDs privately
2. From the verified existing service route, confirm an unauthenticated API call returns `401`. This check does not trigger an X request or Slack send by itself:

   ```sh
   : "${BASE_URL:?Set the verified existing service URL}"
   STATUS="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL/api/stats")"
   test "$STATUS" = 401
   ```

3. Have the authorized operator use the ordinary dashboard login over the existing secure route. Do not put the password, session cookie, or bearer token in shell history or chat. Confirm authenticated `/api/stats` reports the expected UTC budget day, limit 100, per-lane limits `30/10/40/10/10`, remaining/used counts, pending reservations, and any blocked reason. Viewing the budget may initialize/roll its local ledger; it does not perform a paid X read
4. Check discovery returned/accepted/rejected diagnostics and recent operational logs. These diagnostics reset with the process; the budget and work/delivery claims persist. Inspect `/api/posts` for source lane and Jev judgments. `/qualified` is the reply list, not proof of an inspiration send
5. Observe only the next naturally scheduled cycle and noon window, subject to the fixed budget. Confirm no 8 AM/4 PM sends, no late catch-up, no empty Slack messages, no more than 10 total picks or 3 inspiration items, and the correct private destination. Do not force a poll, clear a claim, alter the clock, or send a Slack test to speed verification
6. Review ledger/claims around the next ordinary restart or release to confirm persistence. An additional production restart solely for a test is unnecessary; isolated tests cover restart/duplicate cases

Delivery remains unverified until a natural eligible send has a confirmed outcome in the approved channel. A zero-item noon result is valid and does not justify lowering thresholds or sending an empty “healthy” digest.

## Interpreting empty results

Separate evidence before changing behavior:

- No raw results: inspect allowed discovery slots, durable work claims, X capability errors, and budget block reasons. Successful watched fallback does not prove broad search works
- Raw results but few accepted: inspect rejection counts for language, duplicates, invalid/old timestamps, topic mismatch, or evaluation storage limits. All of these raw posts still count against the allowance
- Accepted but unqualified: check whether the mandatory 30-minute comparison occurred, thresholds were met, Jev was configured and returned valid choices, and safety/usefulness/saturation gates passed
- Qualified but no Slack message: verify freshness at noon, measured engagement, routing/lane, fixed private bot access, the noon window, and prior/uncertain delivery claims. A webhook-only setup intentionally cannot send

These checks establish causes in the actual deployment. Source inspection alone is not a live diagnosis. Do not spend extra posts or weaken filters just to produce a nonempty screenshot.

## Safe rollback

**Rolling back to the older build reintroduces uncapped X reads and possibly the old Slack schedule/destination. Do not restart it live.**

- Stop the new service and all writers first if correctness or safety is in doubt
- Preserve the current complete data directory, current ledger/marker, claims, unknown reservations, and diagnostic evidence. Make another protected backup before any change
- Prefer keeping the service stopped until a compatible capped build is ready. If an operator must run an old dashboard for inspection, disable all X, Jev, and Slack external credentials/routes and prove no queued work can make external calls before starting it. Do not disclose secrets or create replacement credentials to do so
- Roll source/image back only to the exact recorded or reviewed identifier. A compatible capped build must understand the current ledger and claims; do not downgrade their format or overwrite them with a pre-deployment backup
- Never reset/delete the budget or claims to “make rollback work.” Recheck the same access, storage, UTC-migration, authentication, and budget gates before re-enabling live operation

Downtime is safer than an uncapped rollback. The existing image record is not a guarantee that the image preserves this release's safety behavior.

## Manual reconciliation of blocked or damaged state

Possible reasons include `unresolved_previous_day`, `migration_day_exhausted`, `locked`, invalid/missing initialized ledger data, clock rollback, storage failure, or upstream `api_over_return`. The exact diagnostic code should be read from the current build. Do not infer that a lock is abandoned from its age, PID, or container restart.

1. Stop **every** process/host that can use the ledger or credentials, prevent automatic restart, and preserve the complete data directory, lock, marker, temporary files, claims, logs, and release IDs in a protected backup
2. Establish the correct UTC clock and underlying storage health. Find verified X-side evidence and available request/response records for each unresolved request. Establish both its exact raw-return count/date and that it cannot still return. Do not equate “not stored,” “filtered out,” a client timeout, or an aggregate billing estimate with zero returned posts
3. Reconcile under technical review against the schema and invariants in `server/budget.js`: version, UTC day, lane counts, pending reservation identities, any late-response debits, and halted state. Never refund an uncertain call. Preserve delivery claims and sent/uncertain intent independently of X budget work
4. For corruption/missing files/leftover temporary writes, reconstruct a compatible state only from verified evidence. A backup can be an input, but restoring its older counts without adding subsequent activity would undercount. Validate the proposed repair on a copied data directory with network disabled before replacing any live data
5. Only after the reconciliation and a reviewed durable repair, with all processes still stopped, may an operator resolve an abandoned transaction lock. There is deliberately no blind lock/ledger deletion command here. If the request history or storage state cannot be established, keep post reads disabled and escalate for a reviewed recovery; a fresh UTC day alone does not clear unknown in-flight requests
6. Restart only one compatible service first, preserving the repaired ledger, marker, claims, and backups. Use the authenticated budget view to verify the expected conservative accounting before relying on future scheduled activity

An upstream response that exceeds its reservation is recorded and halts the ledger. The service cannot undo that response; investigate the endpoint/response shape and fix the cause before any reviewed recovery. Do not clear `halted` merely to resume spending.

## Verification recorded for this source change

The cloud implementation task reported 65 mocked tests passing, successful syntax checks, and an HTTP check covering unauthenticated `401`, login, authenticated stats/posts/qualified views, and logout with X, Jev, and Slack credentials absent. This is local source verification only. Docker was unavailable, so no Docker image build was verified. Cloud Chromium could not launch because of a socket `EPERM` error; visual browser verification was not completed. The budget banner and inspiration filter were syntax-inspected, not visually validated. None of these results establish droplet deployment or actual Slack delivery.
