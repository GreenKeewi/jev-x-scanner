'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { Budget } = require('../server/budget');

// Complete isolated service harness. No real external request can escape fetch.
function loadScanner(fixturePosts = [], xFetch = null, savedState = null, options = {}) {
  const sent = [];
  const clock = options.clock || { now: Date.parse('2026-09-27T15:59:59Z') };
  const RealDate = Date;
  class TestDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const dir = options.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-test-'));
  if (options.seedBudget !== false && !options.dataDir) new Budget(dir, { now: () => clock.now }).snapshot();
  if (!options.dataDir || options.resetFiles) {
    fs.writeFileSync(path.join(dir, 'posts.json'), JSON.stringify(fixturePosts));
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(savedState || { history: [], notificationBatches: {} }));
  }
  const mockedFs = {
    ...fs,
    readFileSync(file, encoding) {
      if (String(file).endsWith('.env')) throw new Error('No local credentials in tests');
      return fs.readFileSync(file, encoding);
    },
    ...(options.fs || {}),
  };
  const noopTimer = () => ({ unref() {} });
  const context = {
    __dirname: path.join(__dirname, '..', 'server'), Date: TestDate, URL, AbortSignal,
    console: { log() {}, error() {} },
    process: { pid: process.pid, env: { DASHBOARD_PASSWORD: 'test-password', SLACK_BOT_TOKEN: 'test-slack-token', X_BEARER_TOKEN: 'test-x-token', DATA_DIR: dir, ...(options.env || {}) }, exit() { throw new Error('unexpected exit'); } },
    require(name) {
      if (name === 'node:fs') return mockedFs;
      if (name === './budget') return { Budget: class extends Budget { constructor(dataDir, budgetOptions) { super(dataDir, { ...budgetOptions, now: () => clock.now }); } } };
      if (name === 'node:http') return { createServer() { return { listen() {} }; } };
      return require(name);
    },
    fetch: async (url, fetchOptions) => {
      if (String(url).startsWith('https://api.x.com') && xFetch) return xFetch(url, fetchOptions);
      if (String(url).startsWith('https://api.typesafe.ai') && options.jevFetch) return options.jevFetch(url, fetchOptions);
      if (url === 'https://slack.com/api/chat.postMessage') {
        sent.push(JSON.parse(fetchOptions.body));
        if (options.slackFetch) return options.slackFetch(url, fetchOptions);
        return { ok: true, json: async () => ({ ok: true, ts: 'test-ts' }) };
      }
      throw new Error('Unexpected network call: ' + url);
    },
    setInterval: noopTimer, setTimeout: noopTimer,
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'server.js'), 'utf8');
  const names = 'scoreThreshold, scanSlot, dueNotificationBatch, firstWords, engagementRating, perHour, flushNotificationQueue, scanAccounts, ingest, state, posts, cfg, logs, callJev, labelPost, budget, xGet, recheckDue, poll, snapshot, matchesReplyTopic, matchesInspirationTopic, watchedSources, watchQuery';
  vm.runInNewContext(source + `\n;globalThis.scannerTest = { ${names} };`, context, { filename: 'server.js' });
  const saved = new Proxy({}, { get(_target, name) { try { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { return undefined; } } });
  return { api: context.scannerTest, clock, sent, saved, dir, context, cleanup: () => { if (!options.dataDir) fs.rmSync(dir, { recursive: true, force: true }); } };
}
module.exports = { loadScanner };
