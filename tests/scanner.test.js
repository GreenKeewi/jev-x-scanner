'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadScanner } = require('./helpers');

const response = (data) => ({ ok: true, headers: { get() { return null; } }, json: async () => data });

test('Eastern pre-noon scan and sole noon delivery follow daylight saving time', (t) => {
  const h = loadScanner(); t.after(h.cleanup); const { api } = h;
  assert.equal(api.scanSlot(Date.parse('2026-09-27T11:00:00Z')), '2026-09-27-07');
  assert.equal(api.scanSlot(Date.parse('2026-09-27T15:59:00Z')), '2026-09-27-11');
  assert.equal(api.scanSlot(Date.parse('2026-09-27T16:00:00Z')), null);
  assert.equal(api.scanSlot(Date.parse('2026-01-15T12:00:00Z')), '2026-01-15-07');
  for (const timestamp of ['2026-09-27T12:00:00Z', '2026-09-27T20:00:00Z', '2026-09-27T16:05:00Z', '2026-01-15T16:00:00Z']) assert.equal(api.dueNotificationBatch(Date.parse(timestamp)), null);
  assert.equal(api.dueNotificationBatch(Date.parse('2026-09-27T16:00:00Z')).key, '2026-09-27-12');
  assert.equal(api.dueNotificationBatch(Date.parse('2026-01-15T17:00:00Z')).key, '2026-01-15-12');
});

test('score, measured velocity and legacy migration remain unchanged', (t) => {
  const h = loadScanner([{ id: 'old', engagementScore: 635 }]); t.after(h.cleanup); const { api } = h;
  assert.equal(api.posts[0].engagementScore, 6.4);
  assert.equal(api.engagementRating({ likes: 80 }), 6.3);
  assert.equal(api.perHour({ t: 0, likes: 5 }, { t: 30 * 60000, likes: 25, bookmarks: 2, reposts: 3, replies: 1 }), 52);
  assert.equal(api.firstWords('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen').split(' ').length, 15);
  assert.equal(api.scoreThreshold('200'), 2);
  assert.equal(api.scoreThreshold('2'), 2);
});

test('raw discovery cap includes rejected posts; independent watch cannot replace broad', async (t) => {
  const calls = [];
  let h;
  h = loadScanner([], (url) => {
    const u = new URL(url); calls.push(u);
    const count = Number(u.searchParams.get('max_results'));
    return response({ data: Array.from({ length: count }, (_, i) => ({ id: String(calls.length * 100 + i), text: 'Job applications and hiring', lang: i === 0 ? 'fr' : 'en', created_at: new Date(h.clock.now - 600000).toISOString(), author_id: '1', public_metrics: { like_count: 10 } })), includes: { users: [{ id: '1', username: 'example' }] } });
  }); t.after(h.cleanup);
  for (const hour of [11, 12, 13, 14, 15]) { h.clock.now = Date.parse(`2026-09-27T${hour}:00:00Z`); await h.api.scanAccounts(); await h.api.scanAccounts(); }
  assert.equal(calls.length, 4);
  assert.equal(h.api.posts.length, 36);
  assert.equal(h.api.budget.remaining('broad'), 0);
  assert.equal(h.api.budget.remaining('watch'), 0);
  assert.equal(h.api.budget.remaining('first_refresh'), 40);
  assert.ok(!calls[0].searchParams.get('query').includes('from:'));
  assert.ok(calls[1].searchParams.get('query').includes('from:'));
  assert.ok(calls[3].searchParams.get('query').includes('building in public'));
  assert.equal(h.api.posts.filter(p => p.sourceLane === 'inspiration').length, 9);
  assert.equal(h.api.state.diagnostics.discovery.rejected.non_english_or_missing_language, 4);
  const restarted = loadScanner([], null, null, { dataDir: h.dir, clock: h.clock });
  await restarted.api.scanAccounts();
  assert.equal(restarted.api.budget.remaining('broad'), 0);
});

test('duplicate, old, missing-language posts still debit raw allowance', async (t) => {
  let h;
  h = loadScanner([], () => response({ data: Array.from({ length: 10 }, () => ({ id: 'duplicate', text: 'hiring', lang: 'en', created_at: new Date(h.clock.now - 600000).toISOString(), public_metrics: {} })) })); t.after(h.cleanup);
  h.clock.now = Date.parse('2026-09-27T11:00:00Z'); await h.api.scanAccounts();
  assert.equal(h.api.posts.length, 1);
  assert.equal(h.api.budget.remaining('broad'), 20);
  assert.equal(h.api.state.diagnostics.discovery.rejected.duplicate, 9);
  assert.equal(h.api.ingest({ id: 'old', lang: 'en', created_at: 'invalid' }, 'example'), false);
  assert.equal(h.api.ingest({ id: 'missing', created_at: new Date(h.clock.now).toISOString() }, 'example'), false);
});

test('all post-returning endpoints require budgets and API minima are enforced before fetch', async (t) => {
  let count = 0; const h = loadScanner([], () => { count++; return response({ data: [] }); }); t.after(h.cleanup);
  await assert.rejects(h.api.xGet('tweets', '/2/tweets?ids=1'), /explicit budget lane/);
  const r = h.api.budget.reserve('broad', 21, 1); h.api.budget.settle(r, 21);
  await assert.rejects(h.api.xGet('tweets/search/recent', '/2/tweets/search/recent?query=hiring&max_results=10', 'broad'), /budget unavailable/);
  assert.equal(count, 0);
});

test('uncertain X parsing retains debit; verified error refunds before fallback', async (t) => {
  const h = loadScanner([], () => ({ ok: true, headers: { get() {} }, json: async () => { throw new Error('truncated'); } })); t.after(h.cleanup);
  await assert.rejects(h.api.xGet('tweets', '/2/tweets?ids=1,2', 'first_refresh'), /truncated/);
  assert.equal(h.api.budget.remaining('first_refresh'), 38);
  const safe = loadScanner([], () => ({ ok: false, status: 400, headers: { get() {} }, json: async () => ({ title: 'unsupported operator' }) })); t.after(safe.cleanup);
  await assert.rejects(safe.api.xGet('search', '/2/tweets/search/recent?query=hiring&max_results=10', 'broad'), /400/);
  assert.equal(safe.api.budget.remaining('broad'), 30);
});

test('refresh reserve cannot be consumed by discovery; successful first look supports measured gate', async (t) => {
  let h;
  h = loadScanner([], url => {
    const u = new URL(url);
    return response({ data: u.searchParams.get('ids').split(',').map(id => ({ id, public_metrics: { like_count: 35 } })) });
  }); t.after(h.cleanup);
  h.clock.now = Date.parse('2026-09-27T11:00:00Z');
  h.api.ingest({ id: '123', text: 'hiring', lang: 'en', created_at: new Date(h.clock.now - 600000).toISOString(), public_metrics: { like_count: 10 } }, 'example');
  for (const lane of ['broad', 'watch']) { const r = h.api.budget.reserve(lane, 100, 1); h.api.budget.settle(r, r.count); }
  h.clock.now += 30 * 60000; await h.api.recheckDue();
  assert.equal(h.api.posts[0].engagementPerHour, 50);
  assert.equal(h.api.posts[0].checks, 1);
  assert.equal(h.api.budget.remaining('first_refresh'), 39);
  assert.equal(h.api.budget.remaining('flex'), 10);
});

test('baseline reads are daily bounded, and evaluation mode cannot bypass scheduling', async (t) => {
  let baseline = 0;
  const h = loadScanner([], url => {
    const u = new URL(url);
    if (u.pathname.endsWith('/tweets') && u.pathname.startsWith('/2/users/')) { baseline++; return response({ data: Array.from({length:10}, (_,i) => ({id:String(i)})) }); }
    if (u.pathname.startsWith('/2/users/by/')) return response({ data: { id: '1', public_metrics: { followers_count: 1, following_count: 1, tweet_count: 1 } } });
    if (u.pathname === '/2/usage/tweets') return response({ data: {} });
    throw new Error('Unexpected endpoint');
  }, null, { env: { X_USERNAME: 'example', EVAL_ALL_POSTS: 'true' } }); t.after(h.cleanup);
  h.clock.now = Date.parse('2026-09-27T20:00:00Z');
  await h.api.poll(); await h.api.poll();
  assert.equal(baseline, 1);
  assert.equal(h.api.budget.remaining('baseline'), 0);
  assert.equal(h.api.budget.remaining('broad'), 30);
});

test('timeline topic filter excludes accidental OR matches and preserves lane-specific topics', (t) => {
  const h = loadScanner(); t.after(h.cleanup);
  assert.equal(h.api.matchesReplyTopic('More ordinary word processing stories'), false);
  assert.equal(h.api.matchesReplyTopic('Hiring process and interviews'), true);
  assert.equal(h.api.matchesInspirationTopic('We shipped onboarding based on customer feedback'), true);
  const sources = h.api.watchedSources();
  assert.ok(sources.some(s => s.name === 'tristan_cte' && s.sourceLane === 'inspiration'));
  assert.ok(sources.some(s => s.name === 'jantegze' && s.sourceLane === 'reply'));
});


test('malformed or partial X counts never refund the reservation', async (t) => {
  for (const body of [{ meta: { result_count: 10 } }, { data: [], meta: { result_count: 10 } }, { meta: {} }, { data: [], includes: { tweets: {} } }]) {
    const h = loadScanner([], () => response(body)); t.after(h.cleanup);
    await assert.rejects(h.api.xGet('search', '/2/tweets/search/recent?query=hiring&max_results=10', 'broad'), /Uncertain X response/);
    assert.equal(h.api.budget.remaining('broad'), 20);
    assert.equal(h.api.budget.snapshot().pending.length, 1);
  }
});

test('existing installation without a ledger exhausts migration day and resumes only after UTC midnight', async (t) => {
  let calls = 0;
  const h = loadScanner([], () => { calls++; return response({ data: [] }); }, null, { seedBudget: false }); t.after(h.cleanup);
  assert.equal(h.api.budget.snapshot().reason, 'migration_day_exhausted');
  await assert.rejects(h.api.xGet('search', '/2/tweets/search/recent?query=hiring&max_results=10', 'broad'), /budget unavailable/);
  assert.equal(calls, 0);
  h.clock.now = Date.parse('2026-09-28T00:00:01Z');
  assert.equal(h.api.budget.snapshot().blocked, false);
  assert.equal(h.api.budget.remaining(), 100);
});

test('search capability fallback remains capped and topic-filtered across both watched lanes', async (t) => {
  const calls = []; let h;
  h = loadScanner([], url => {
    const u = new URL(url); calls.push(u);
    if (u.pathname.includes('/search/')) return { ok: false, status: 403, headers: { get() {} }, json: async () => ({ title: 'tier unavailable' }) };
    if (u.pathname.includes('/users/by/')) return response({ data: { id: String(calls.length) } });
    return response({ data: Array.from({length:5}, (_,i) => ({ id: String(calls.length * 100 + i), text: i ? 'Hiring interviews: we shipped a better process' : 'More ordinary word processing stories', lang: 'en', created_at: new Date(h.clock.now - 600000).toISOString(), public_metrics: {like_count:10} })) });
  }); t.after(h.cleanup);
  h.clock.now = Date.parse('2026-09-27T12:00:00Z');
  await h.api.scanAccounts();
  assert.equal(h.api.budget.remaining('watch'), 0);
  assert.equal(h.api.budget.remaining('broad'), 30);
  assert.equal(h.api.posts.length, 8);
  assert.equal(h.api.posts.filter(p => p.sourceLane === 'inspiration').length, 4);
  assert.equal(h.api.state.diagnostics.discovery.rejected.topic, 2);
  assert.ok(calls.filter(u=>u.pathname.endsWith('/tweets')).every(u=>u.searchParams.get('max_results') === '5'));
});
