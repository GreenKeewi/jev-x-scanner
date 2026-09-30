'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadScanner } = require('./helpers');

// Use the whole-service harness, with every network call mocked.
function loadReview(t, fixturePosts = [], options = {}) {
  const hooks = {};
  const jevRequests = [];
  const fsOverrides = Object.fromEntries(['openSync', 'writeFileSync', 'fsyncSync', 'renameSync'].map((name) => [name,
    (...args) => (hooks[name] || fs[name])(...args),
  ]));
  let h;
  h = loadScanner(fixturePosts, null, null, {
    dataDir: options.dataDir,
    clock: options.clock || { now: Date.parse('2026-09-27T16:00:00Z') },
    env: { JEV_API_KEY: 'mock-jev' },
    fs: fsOverrides,
    jevFetch(_url, fetchOptions) {
      jevRequests.push(JSON.parse(fetchOptions.body));
      return { ok: true, json: async () => ({ answers: options.answers }) };
    },
    slackFetch(_url, fetchOptions) {
      if (options.slackFetch) return options.slackFetch(JSON.parse(fetchOptions.body), h.dir);
      return { ok: true, json: async () => ({ ok: true, channel: 'C0C1BAFBEFK' }) };
    },
  });
  t.after(h.cleanup);
  Object.assign(h.api.cfg, options.cfg || {});
  const actualPersist = h.context.persist;
  h.context.persist = () => hooks.persist ? hooks.persist(h.api.state) : actualPersist();
  return {
    ...h, cfg: h.api.cfg, logs: h.api.logs, state: h.api.state, hooks, jevRequests,
    dataDir: h.dir, stateFile: path.join(h.dir, 'state.json'),
  };
}
const choice = (value) => ({ choice: value });
const inspirationAnswers = (overrides = {}) => ({ label: choice('inspiration'), usefulness: choice('actionable'), saturation: choice('unsaturated'), contentSafety: choice('clear'), ...overrides });
function post(id = '100', overrides = {}) {
  const first = Date.parse('2026-09-27T15:00:00Z');
  return {
    id, url: `https://x.com/builder/status/${id}`, author: 'builder', text: 'We tested onboarding and learned a useful lesson for building our product.',
    sourceLane: 'inspiration', lang: 'en', createdAt: '2026-09-27T14:50:00Z', foundAt: first,
    metrics: { likes: 30, bookmarks: 2, reposts: 3, replies: 1, views: 1000 },
    snapshots: [{ t: first, likes: 5 }, { t: first + 30 * 60000, likes: 31 }],
    label: 'inspiration', responder: 'none', contentSafety: 'clear', usefulness: 'actionable', saturation: 'unsaturated',
    engagementScore: 8, engagementPerHour: 52, velocity: 52, ageMinutes: 70, status: 'tracking', ...overrides,
  };
}

test('daily noon window follows Eastern DST and never sends at 8 AM, 4 PM, or late', (t) => {
  const { api } = loadReview(t);
  for (const time of ['2026-09-27T15:59:59Z', '2026-09-27T16:05:00Z', '2026-09-27T16:59:00Z', '2026-09-27T12:00:00Z', '2026-09-27T20:00:00Z', '2026-01-15T16:59:59Z']) {
    assert.equal(api.dueNotificationBatch(Date.parse(time)), null, time);
  }
  for (const time of ['2026-09-27T16:00:00Z', '2026-09-27T16:04:59Z']) {
    assert.equal(api.dueNotificationBatch(Date.parse(time)).key, '2026-09-27-12');
  }
  assert.equal(api.dueNotificationBatch(Date.parse('2026-01-15T17:00:00Z')).key, '2026-01-15-12');
});

test('Jev inspiration uses separate useful-learning and saturation choices, never reply routing', async (t) => {
  const { api, jevRequests } = loadReview(t, [], { answers: inspirationAnswers() });
  const verdict = await api.callJev(post());
  assert.equal(verdict.label, 'inspiration');
  assert.equal(verdict.responder, 'none');
  assert.equal(verdict.reason, 'building_in_public_learning');
  assert.equal(verdict.usefulness, 'actionable');
  assert.equal(verdict.saturation, 'unsaturated');
  const request = jevRequests[0];
  assert.equal(request.state.sourceLane, 'inspiration');
  assert.equal(request.questions.responder, undefined);
  assert.equal(request.questions.label.criteria.reply_now, undefined);
  assert.equal(request.questions.usefulness.type, 'choice');
  assert.equal(request.questions.saturation.type, 'choice');
  assert.match(request.questions.label.instructions, /first-hand, concrete lesson/);
});

test('inspiration excludes saturated, uncertain, non-actionable, skipped, or unsafe posts', async (t) => {
  for (const overrides of [
    { saturation: choice('viral_or_saturated') }, { saturation: choice('uncertain') },
    { usefulness: choice('interesting_only') }, { usefulness: choice('not_useful_or_uncertain') },
    { label: choice('skip') }, { contentSafety: choice('explicit_or_uncertain') },
  ]) {
    const { api } = loadReview(t, [], { answers: inspirationAnswers(overrides) });
    const verdict = await api.callJev(post());
    assert.equal(verdict.label, 'skip');
    assert.equal(verdict.responder, 'none');
  }
});

test('malformed Jev choices fail closed after one retry and cannot enter Slack', async (t) => {
  for (const overrides of [
    { saturation: choice('fresh-ish') }, { usefulness: null }, { label: choice('reply_now') },
    { contentSafety: choice('probably_safe') }, { saturation: 'unsaturated' },
  ]) {
    const { api, jevRequests } = loadReview(t, [], { answers: inspirationAnswers(overrides) });
    const candidate = post('101', { label: null });
    await api.labelPost(candidate);
    assert.equal(jevRequests.length, 2);
    assert.match(candidate.error, /unexpected Jev/);
    assert.equal(candidate.label, null);
  }
});

test('reply classification retains strict routing and safety invariants', async (t) => {
  const answers = { label: choice('reply_now'), responder: choice('none'), reason: choice('jobseeker_pain'), contentSafety: choice('clear') };
  const { api, jevRequests } = loadReview(t, [], { answers });
  const verdict = await api.callJev(post('102', { sourceLane: 'broad' }));
  assert.equal(verdict.label, 'maybe');
  assert.equal(verdict.responder, 'none');
  assert.ok(jevRequests[0].questions.responder);
  assert.equal(jevRequests[0].questions.usefulness, undefined);
  answers.contentSafety = choice('explicit_or_uncertain');
  assert.equal((await api.callJev(post('103', { sourceLane: 'watched' }))).label, 'skip');
});

test('labelPost saves inspiration judgments without creating a replying identity', async (t) => {
  const { api } = loadReview(t, [], { answers: inspirationAnswers({ saturation: choice('emerging') }) });
  const candidate = post('104', { label: null, usefulness: undefined, saturation: undefined });
  await api.labelPost(candidate);
  assert.equal(candidate.label, 'inspiration');
  assert.equal(candidate.usefulness, 'actionable');
  assert.equal(candidate.saturation, 'emerging');
  assert.equal(candidate.responder, 'none');
  assert.equal(candidate.status, 'tracking');
  assert.equal(candidate.error, undefined);
});

test('one private daily batch combines seven replies with at most three prioritized inspiration posts', async (t) => {
  const fixtures = Array.from({ length: 10 }, (_, i) => post(String(200 + i), { sourceLane: 'broad', label: 'reply_now', responder: 'ben', engagementScore: 10 - i / 10 }));
  fixtures.push(post('310', { saturation: 'emerging', engagementScore: 10 }));
  fixtures.push(...[301, 302, 303].map((id, i) => post(String(id), { engagementScore: 6 - i / 10 })));
  const { api, sent, state, dataDir } = loadReview(t, fixtures, { slackFetch(request, dir) {
    assert.equal(request.channel, 'C0C1BAFBEFK');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'))).notificationBatches['2026-09-27-12'].status, 'pending');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'notification-claims/2026-09-27-12.json'))).status, 'pending');
    return { ok: true, json: async () => ({ ok: true }) };
  } });
  await api.flushNotificationQueue();
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Daily picks · 12:00 PM ET/);
  assert.match(sent[0].text, /Reply opportunities/);
  assert.match(sent[0].text, /Building-in-public inspiration/);
  assert.equal((sent[0].text.match(/· Score /g) || []).length, 10);
  assert.equal((sent[0].text.match(/Inspiration · Low saturation/g) || []).length, 3);
  assert.doesNotMatch(sent[0].text, /status\/310/);
  assert.equal((sent[0].text.match(/<@U05TUED5BNX>/g) || []).length, 7);
  assert.equal(state.notificationBatches['2026-09-27-12'].status, 'sent');
  assert.equal(api.posts.filter((p) => p.slacked).length, 10);
  await api.flushNotificationQueue();
  assert.equal(sent.length, 1);
  const restarted = loadReview(t, fixtures, { dataDir });
  await restarted.api.flushNotificationQueue();
  assert.equal(restarted.sent.length, 0);
});

test('Slack eligibility fails closed for language, momentum, measurement, freshness, safety and source-lane mismatches', async (t) => {
  const bad = [
    { lang: 'fr' }, { engagementPerHour: 19 }, { engagementPerHour: null }, { engagementScore: 1.9 },
    { snapshots: [{ t: Date.parse('2026-09-27T15:00:00Z') }] },
    { createdAt: '2026-09-25T14:50:00Z' }, { createdAt: '2026-09-28T14:50:00Z' },
    { contentSafety: 'explicit_or_uncertain' }, { usefulness: 'interesting_only' }, { saturation: 'viral_or_saturated' },
    { label: 'reply_now', responder: 'ben' }, { sourceLane: 'broad' }, { responder: 'colin' },
    { sourceLane: 'broad', label: 'reply_now', responder: 'none' },
  ].map((overrides, i) => post(String(400 + i), overrides));
  const { api, sent, state } = loadReview(t, bad);
  await api.flushNotificationQueue();
  assert.equal(sent.length, 0);
  assert.equal(state.notificationBatches['2026-09-27-12'].status, 'empty');
  assert.equal(state.notificationBatches['2026-09-27-12'].postIds.length, 0);
  await api.flushNotificationQueue();
  assert.equal(sent.length, 0);
});

test('ambiguous Slack failure remains reserved across retry, restart, and state overwrite', async (t) => {
  const { api, sent, state, dataDir, stateFile } = loadReview(t, [post('500')], { slackFetch() { throw new Error('timeout after request'); } });
  await api.flushNotificationQueue();
  assert.equal(sent.length, 1);
  assert.equal(state.notificationBatches['2026-09-27-12'].status, 'uncertain');
  await api.flushNotificationQueue();
  assert.equal(sent.length, 1);
  // Simulate another server overwriting state with a stale snapshot. Claims are immutable.
  fs.writeFileSync(stateFile, JSON.stringify({ notificationBatches: {} }));
  const restarted = loadReview(t, [post('500')], { dataDir });
  await restarted.api.flushNotificationQueue();
  assert.equal(restarted.sent.length, 0);
});

test('two service processes share an exclusive daily delivery claim', async (t) => {
  const first = loadReview(t, [post('501')]);
  const second = loadReview(t, [post('501')], { dataDir: first.dataDir });
  await Promise.all([first.api.flushNotificationQueue(), second.api.flushNotificationQueue()]);
  assert.equal(first.sent.length + second.sent.length, 1);
});

test('failure to persist intent or claim prevents all Slack network calls', async (t) => {
  for (const mode of ['state', 'claim']) {
    const { api, sent, hooks, logs } = loadReview(t, [post('502')]);
    if (mode === 'state') hooks.persist = () => { throw new Error('disk full'); };
    else {
      const files = new Map();
      hooks.openSync = (...args) => { const fd = fs.openSync(...args); files.set(fd, String(args[0])); return fd; };
      hooks.fsyncSync = (fd) => {
        if (files.get(fd)?.includes('notification-claims/')) throw new Error('claim fsync failed');
        fs.fsyncSync(fd);
      };
    }
    await api.flushNotificationQueue();
    assert.equal(sent.length, 0);
    assert.ok(logs.some((entry) => entry.level === 'error'));
  }
});

test('post-send persistence failure does not allow an automatic resend', async (t) => {
  const { api, sent, hooks, dataDir, stateFile } = loadReview(t, [post('503')]);
  let writes = 0;
  hooks.persist = (value) => {
    writes++;
    if (writes > 1) throw new Error('disk became full');
    fs.writeFileSync(stateFile, JSON.stringify(value));
  };
  await api.flushNotificationQueue();
  assert.equal(sent.length, 1);
  const restarted = loadReview(t, [], { dataDir });
  await restarted.api.flushNotificationQueue();
  assert.equal(restarted.sent.length, 0);
});

test('legacy webhook-only config cannot transmit to an unverified destination', async (t) => {
  const { api, sent, logs } = loadReview(t, [post('504')], { cfg: { slackBotToken: '', slackUrl: 'https://example.test/unverified' } });
  await api.flushNotificationQueue();
  await api.flushNotificationQueue();
  assert.equal(sent.length, 0);
  assert.equal(logs.filter((entry) => entry.level === 'warn').length, 1);
});

test('empty batch records local operational diagnostics and identifies fail-closed budget', async (t) => {
  const { api, clock, state, sent, logs } = loadReview(t, [post('600', { label: null, error: 'Jev unavailable' })], { clock: { now: Date.parse('2026-09-26T16:00:00Z') } });
  const pending = api.budget.reserve('broad', 10, 10);
  assert.equal(pending.count, 10);
  clock.now += 86400000;
  await api.flushNotificationQueue();
  const record = state.notificationBatches['2026-09-27-12'];
  assert.equal(sent.length, 0);
  assert.equal(record.status, 'empty');
  assert.equal(record.reason, 'budget_blocked');
  assert.equal(record.diagnostics.tracking, 1);
  assert.equal(record.diagnostics.unlabeled, 1);
  assert.equal(record.diagnostics.jevFailures, 1);
  assert.equal(record.diagnostics.budget.blocked, true);
  assert.equal(record.diagnostics.budget.reason, 'unresolved_previous_day');
  assert.ok(logs.some((entry) => /budget=unresolved_previous_day/.test(entry.msg)));
});

test('claim protects against next-day duplicates when spring DST keeps yesterday’s post fresh', async (t) => {
  const candidate = post('601', {
    createdAt: '2026-03-07T16:20:00Z', foundAt: Date.parse('2026-03-07T16:20:00Z'),
    snapshots: [{ t: Date.parse('2026-03-07T16:20:00Z') }, { t: Date.parse('2026-03-07T16:50:00Z') }],
  });
  const first = loadReview(t, [candidate], { clock: { now: Date.parse('2026-03-07T17:00:00Z') }, slackFetch() { throw new Error('ambiguous network timeout'); } });
  await first.api.flushNotificationQueue();
  assert.equal(first.sent.length, 1);
  fs.writeFileSync(first.stateFile, JSON.stringify({ history: [], notificationBatches: {} }));
  const nextDay = loadReview(t, [], { dataDir: first.dataDir, clock: { now: Date.parse('2026-03-08T16:00:00Z') } });
  await nextDay.api.flushNotificationQueue();
  assert.equal(nextDay.sent.length, 0);
  assert.equal(nextDay.state.notificationBatches['2026-03-08-12'].reason, 'no_qualified_posts');
});

test('partial immutable claim fails closed without a Slack retry', async (t) => {
  const { api, sent, dataDir, logs } = loadReview(t, [post('602')]);
  fs.mkdirSync(path.join(dataDir, 'notification-claims'));
  fs.writeFileSync(path.join(dataDir, 'notification-claims/2026-09-27-12.json'), '{"postIds":');
  await api.flushNotificationQueue();
  assert.equal(sent.length, 0);
  assert.ok(logs.some((entry) => entry.level === 'error'));
});
