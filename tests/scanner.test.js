'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadScanner(fixturePosts = [], xFetch = null, savedState = null) {
  const sent = [];
  const saved = {};
  const clock = { now: Date.parse('2026-09-27T11:59:59Z') };
  const RealDate = Date;
  class TestDate extends RealDate { static now() { return clock.now; } }
  const mockedFs = {
    ...fs,
    readFileSync(file, encoding) {
      if (String(file).endsWith('.env')) throw new Error('no local credentials in tests');
      if (String(file).endsWith('state.json')) return JSON.stringify(savedState || { history: [], notificationBatches: {} });
      if (String(file).endsWith('posts.json')) return JSON.stringify(fixturePosts);
      return fs.readFileSync(file, encoding);
    },
    writeFileSync(file, data) { saved[path.basename(file)] = JSON.parse(data); },
    mkdirSync() {},
  };
  const noopTimer = () => ({ unref() {} });
  const context = {
    __dirname: path.join(__dirname, '..', 'server'),
    Date: TestDate,
    URL,
    AbortSignal,
    console: { log() {}, error() {} },
    process: { env: { DASHBOARD_PASSWORD: 'test-password', SLACK_WEBHOOK_URL: 'https://example.test/webhook', X_BEARER_TOKEN: 'test-token' }, exit() { throw new Error('unexpected exit'); } },
    require(name) {
      if (name === 'node:fs') return mockedFs;
      if (name === 'node:http') return { createServer() { return { listen() {} }; } };
      return require(name);
    },
    fetch: async (url, options) => {
      if (String(url).startsWith('https://api.x.com') && xFetch) return xFetch(url);
      if (url !== 'https://example.test/webhook') throw new Error('unexpected network call');
      sent.push(JSON.parse(options.body));
      return { ok: true };
    },
    setInterval: noopTimer,
    setTimeout: noopTimer,
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'server.js'), 'utf8');
  vm.runInNewContext(source + '\n;globalThis.scannerTest = { scoreThreshold, scanSlot, dueNotificationBatch, firstWords, engagementRating, perHour, flushNotificationQueue, scanAccounts, ingest, state, posts };', context, { filename: 'server.js' });
  return { api: context.scannerTest, clock, sent, saved };
}

test('Eastern scan and delivery hours follow daylight saving time', () => {
  const { api } = loadScanner();
  assert.equal(api.scanSlot(Date.parse('2026-09-27T09:00:00Z')), '2026-09-27-05');
  assert.equal(api.scanSlot(Date.parse('2026-09-27T18:59:00Z')), '2026-09-27-14');
  assert.equal(api.scanSlot(Date.parse('2026-09-27T19:00:00Z')), null);
  assert.equal(api.scanSlot(Date.parse('2026-01-15T10:00:00Z')), '2026-01-15-05');
  assert.equal(api.dueNotificationBatch(Date.parse('2026-09-27T11:59:59Z')), null);
  assert.equal(api.dueNotificationBatch(Date.parse('2026-09-27T12:00:00Z')).key, '2026-09-27-08');
  assert.equal(api.dueNotificationBatch(Date.parse('2026-09-27T13:00:00Z')), null);
  assert.equal(api.dueNotificationBatch(Date.parse('2026-09-27T20:00:00Z')).key, '2026-09-27-16');
  assert.equal(api.dueNotificationBatch(Date.parse('2026-09-27T21:00:00Z')), null);
  assert.equal(api.dueNotificationBatch(Date.parse('2026-01-15T13:00:00Z')).key, '2026-01-15-08');
});

test('score uses ten points and 30-minute engagement is projected hourly', () => {
  const { api } = loadScanner();
  assert.equal(api.engagementRating({ likes: 80 }), 6.3);
  assert.equal(api.perHour(
    { t: 0, likes: 5, bookmarks: 0, reposts: 0, replies: 0 },
    { t: 30 * 60000, likes: 25, bookmarks: 2, reposts: 3, replies: 1 },
  ), 52);
  assert.equal(api.firstWords('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen').split(' ').length, 15);
  assert.equal(api.scoreThreshold('200'), 2);
  assert.equal(api.scoreThreshold('2'), 2);
});

test('persisted ratings from the old scale are converted on load', () => {
  const { api } = loadScanner([{ id: 'old', engagementScore: 635 }]);
  assert.equal(api.posts[0].engagementScore, 6.4);
});

test('discovery samples at most ten English posts per active hour', async () => {
  let searchCalls = 0;
  const { api, clock } = loadScanner([], () => {
    searchCalls++;
    const createdAt = new Date(clock.now - 10 * 60000).toISOString();
    return {
      ok: true,
      headers: { get() { return null; } },
      async json() {
        return { data: Array.from({ length: 12 }, (_, i) => ({
          id: String(searchCalls * 100 + i), text: 'Job applications and hiring', lang: i === 0 ? 'fr' : 'en',
          created_at: createdAt, author_id: '1', public_metrics: { like_count: 10 },
        })), includes: { users: [{ id: '1', username: 'example' }] } };
      },
    };
  });
  clock.now = Date.parse('2026-09-27T09:00:00Z'); // 5 AM Eastern
  await api.scanAccounts();
  assert.equal(api.posts.length, 10);
  assert.equal(searchCalls, 1);
  await api.scanAccounts();
  assert.equal(searchCalls, 1);
  clock.now = Date.parse('2026-09-27T10:00:00Z');
  await api.scanAccounts();
  assert.equal(api.posts.length, 20);
  clock.now = Date.parse('2026-09-27T19:00:00Z'); // 3 PM Eastern
  await api.scanAccounts();
  assert.equal(searchCalls, 2);
  assert.equal(api.ingest({ id: 'missing-language', text: 'Hiring news', created_at: new Date(clock.now).toISOString(), public_metrics: {} }, 'example'), false);
});

test('Slack sends two ranked batches of at most ten, with concise text and no repeat', async () => {
  const start = Date.parse('2026-09-27T11:15:00Z');
  const words = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen';
  const posts = Array.from({ length: 12 }, (_, i) => ({
    id: String(1000 + i), url: `https://x.com/example/status/${1000 + i}`, author: 'example', text: words,
    lang: 'en', createdAt: '2026-09-27T11:00:00Z', foundAt: start,
    label: 'reply_now', contentSafety: 'clear', responder: i % 2 ? 'colin' : 'ben',
    engagementScore: 9 - i / 10, engagementPerHour: 52, checks: 1,
    metrics: { likes: 30, bookmarks: 2, reposts: 3, replies: 1, views: 1000 },
    snapshots: [{ t: start, likes: 5 }, { t: start + 30 * 60000, likes: 31 }],
  }));
  posts.push({ ...posts[0], id: '9999', lang: 'fr', engagementScore: 10 });
  const { api, clock, sent, saved } = loadScanner(posts);
  await api.flushNotificationQueue();
  assert.equal(sent.length, 0);
  clock.now = Date.parse('2026-09-27T12:00:00Z');
  await api.flushNotificationQueue();
  assert.equal(sent.length, 1);
  assert.equal(api.posts.filter((post) => post.slacked).length, 10);
  assert.match(sent[0].text, /8:00 AM ET/);
  assert.match(sent[0].text, /Score 9\.0\/10 · Engagement 52\/hour 🔥 · Launched Sep 27, 7:00 AM EDT/);
  assert.match(sent[0].text, /<@U05TUED5BNX>/);
  assert.match(sent[0].text, /<@U05TVFP09TM>/);
  assert.match(sent[0].text, /<https:\/\/fixupx\.com\/example\/status\/1000\|https:\/\/x\.com\/example\/status\/1000>/);
  assert.doesNotMatch(sent[0].text, /sixteen|@example|likes|bookmarks|Why it fits/);
  assert.equal((sent[0].text.match(/· Score /g) || []).length, 10);
  await api.flushNotificationQueue();
  assert.equal(sent.length, 1);
  // Simulate a restart where batch state survived but the post file did not.
  const restarted = loadScanner(posts, null, saved['state.json']);
  restarted.clock.now = Date.parse('2026-09-27T20:00:00Z');
  await restarted.api.flushNotificationQueue();
  assert.equal(restarted.sent.length, 1);
  assert.equal((restarted.sent[0].text.match(/· Score /g) || []).length, 2);
  assert.equal(restarted.saved['state.json'].notificationBatches['2026-09-27-16'].postIds.length, 2);
});
