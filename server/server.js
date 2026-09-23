// X API dashboard: read-only, password-protected. No dependencies (Node 18+).
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');

// ---------- env ----------
function loadEnv() {
  try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
      if (m && !line.trim().startsWith('#') && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* .env optional */ }
}
loadEnv();
const cfg = {
  port: Number(process.env.PORT) || 3000,
  password: process.env.DASHBOARD_PASSWORD || '',
  bearer: process.env.X_BEARER_TOKEN || '',
  username: (process.env.X_USERNAME || '').replace(/^@/, ''),
  pollSeconds: Math.max(60, Number(process.env.POLL_INTERVAL_SECONDS) || 300),
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  // scanning: watch these accounts (optionally filtered by a keyword query) and label each post with Jev
  watch: (process.env.X_WATCH_ACCOUNTS || '').split(',').map((s) => s.trim().replace(/^@/, '')).filter(Boolean),
  query: (process.env.X_SEARCH_QUERY || '').trim(),
  includeReplies: /^(1|true|yes)$/i.test(process.env.X_INCLUDE_REPLIES || ''),
  maxPerPoll: Math.min(100, Math.max(10, Number(process.env.MAX_POSTS_PER_POLL) || 50)),
  jevKey: process.env.JEV_API_KEY || '',
  jevConcurrency: Math.min(16, Math.max(1, Number(process.env.JEV_CONCURRENCY) || 4)),
  jevPreference: (process.env.JEV_PREFERENCE || '').trim(),
  // reply-opportunity tuning
  brand: (process.env.DREAMWORK_DESCRIPTION || '').trim() ||
    'Dreamwork (dreamworkhq.com, "Stop applying, start interviewing") is a job-search platform for tech professionals: upload a resume once and it ranks live roles by fit, ' +
    'tailors the resume and cover letter per role, and fills out applications on company sites, with an autopilot option. ' +
    'Good posts to reply to are about job hunting, applying, ATS/resume pain, rejections or ghosting, interviews, tech hiring and layoffs news, internships and new-grad searches, or careers at top tech companies. ' +
    'Be genuinely helpful first, in a confident and conversational tone. Never plug Dreamwork on someone\'s job loss or hardship, and never on unrelated topics.',
  slackUrl: (process.env.SLACK_WEBHOOK_URL || '').trim(),
  minVelocity: Number(process.env.MIN_VELOCITY_PER_HOUR) || 30, // weighted engagements/hour below which a post is auto-skipped (no Jev call)
  maxAgeHours: Number(process.env.MAX_POST_AGE_HOURS) || 6,     // older posts are auto-skipped
};
if (!cfg.password) { console.error('DASHBOARD_PASSWORD is not set in .env'); process.exit(1); }

// ---------- logging (ring buffer + SSE) ----------
const LOG_MAX = 500;
const logs = [];
const sseClients = new Set();
function log(level, msg, meta) {
  const entry = { t: new Date().toISOString(), level, msg, ...(meta ? { meta } : {}) };
  logs.push(entry);
  if (logs.length > LOG_MAX) logs.shift();
  console.log(`[${entry.t}] ${level.toUpperCase()} ${msg}`);
  for (const res of sseClients) res.write(`data: ${JSON.stringify(entry)}\n\n`);
}

// ---------- state ----------
const STATE_FILE = path.join(ROOT, 'data', 'state.json');
const startedAt = Date.now();
const state = {
  polls: { total: 0, ok: 0, failed: 0, last: null, lastError: null, next: null },
  requests: { total: 0, byEndpoint: {} },
  rateLimits: {},   // endpoint -> {limit, remaining, reset}
  user: null,       // profile + public_metrics
  tweets: [],       // recent tweets
  usage: null,      // /2/usage/tweets
  history: [],      // [{t, followers, following, tweets}]
};
try { state.history = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).history || []; } catch { /* first run */ }
function persist() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ history: state.history.slice(-2000) }));
  } catch (e) { log('warn', `persist failed: ${e.message}`); }
}

// ---------- X API ----------
async function xGet(endpoint, pathAndQuery) {
  const res = await fetch('https://api.x.com' + pathAndQuery, { headers: { Authorization: `Bearer ${cfg.bearer}` } });
  state.requests.total++;
  state.requests.byEndpoint[endpoint] = (state.requests.byEndpoint[endpoint] || 0) + 1;
  const h = (k) => res.headers.get(k);
  if (h('x-rate-limit-limit')) {
    state.rateLimits[endpoint] = {
      limit: Number(h('x-rate-limit-limit')), remaining: Number(h('x-rate-limit-remaining')),
      reset: Number(h('x-rate-limit-reset')) * 1000,
    };
  }
  const body = await res.json().catch(() => ({}));
  log(res.ok ? 'info' : 'error', `GET ${endpoint} -> ${res.status}`, res.ok ? undefined : body);
  if (!res.ok) {
    const err = new Error(`${endpoint} ${res.status}: ${body.detail || body.title || 'request failed'}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

// ---------- scanned posts + Jev labelling ----------
const POSTS_FILE = path.join(ROOT, 'data', 'posts.json');
const POSTS_MAX = 2000;
const LABELS = ['reply_now', 'maybe', 'skip'];
const INSTRUCTIONS =
  'You decide which X posts the brand account @dreamworkhq should reply to, so its replies get seen and lead people to Dreamwork.' +
  (cfg.brand ? ` About Dreamwork: ${cfg.brand}` : '') +
  ' You are given the post, its author, its engagement, its age in minutes, and its engagement velocity (engagements per hour).' +
  ' Be strict: most posts are not worth a reply. Only label reply_now when a reply from Dreamwork would clearly pay off.';
const CRITERIA = {
  reply_now:
    'A great, fast-growing post: engagement is high for its age (strong velocity, still early enough that a reply will be seen near the top), ' +
    'its topic or audience overlaps with what Dreamwork is for, and Dreamwork can add real value or a sharp, natural take that leads into Dreamwork without sounding like an ad. ' +
    'Not rage-bait, not a tragedy or sensitive topic, not a giveaway/engagement-farm post.',
  maybe:
    'Decent post with some growth or relevance, but the fit with Dreamwork is loose, the momentum is modest, or a reply would be a stretch.',
  skip:
    'Not worth replying to: slow or no growth, too old, off-topic for Dreamwork, spammy or low-quality, sensitive/controversial, or a reply would look like a forced plug.',
};
let posts = []; // newest first: {id,url,author,text,createdAt,metrics,label,error}
try { posts = JSON.parse(fs.readFileSync(POSTS_FILE, 'utf8')); } catch { /* first run */ }
const seen = new Set(posts.map((p) => p.id));
const sinceIds = new Map(); // scan-group key -> newest tweet id seen
let userIds = null;         // username(lowercase) -> id (timeline fallback)
let postsDirty = false;
setInterval(() => {
  if (!postsDirty) return;
  postsDirty = false;
  try { fs.mkdirSync(path.dirname(POSTS_FILE), { recursive: true }); fs.writeFileSync(POSTS_FILE, JSON.stringify(posts.slice(0, POSTS_MAX))); }
  catch (e) { log('warn', `saving posts failed: ${e.message}`); }
}, 5000).unref();

const jevQueue = [];
let jevActive = 0;
let jevKeyWarned = false;
const jev = { done: 0, failed: 0 };

async function callJev(p) {
  const criteria = { ...CRITERIA };
  if (cfg.jevPreference) criteria.reply_now += ` Extra guidance from the Dreamwork team: ${cfg.jevPreference}`;
  const res = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.jevKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'jev-latest',
      state: {
        post: p.text, author: `@${p.author}`, ageMinutes: p.ageMinutes, engagementPerHour: p.velocity,
        engagement: { views: p.metrics.views, likes: p.metrics.likes, replies: p.metrics.replies, reposts: p.metrics.reposts },
      },
      questions: { label: { type: 'choice', instructions: INSTRUCTIONS, criteria } },
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Jev API responded ${res.status}`);
  const choice = (await res.json())?.answers?.label?.choice;
  if (!LABELS.includes(choice)) throw new Error('unexpected Jev response');
  return choice;
}
const slackEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
async function notifySlack(p) {
  if (!cfg.slackUrl || p.slacked) return;
  const text = slackEsc(p.text.length > 280 ? p.text.slice(0, 277) + '...' : p.text).replace(/\n+/g, ' ');
  const msg = `:fire: *Reply now* - @${p.author} (${p.velocity}/h growth, ${p.ageMinutes}m old, ${p.metrics.likes} likes)\n> ${text}\n${p.url}`;
  try {
    const res = await fetch(cfg.slackUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: msg }), signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`Slack responded ${res.status}`);
    p.slacked = true;
    log('info', `sent to Slack: ${p.url}`);
  } catch (e) {
    log('error', `Slack send failed for ${p.id}: ${e.message}`);
  }
  postsDirty = true;
}
async function labelPost(p) {
  try {
    try { p.label = await callJev(p); } catch { p.label = await callJev(p); } // one retry
    p.error = undefined;
    jev.done++;
    log('info', `labeled @${p.author} ${p.id}: ${p.label}`);
    if (p.label === 'reply_now') await notifySlack(p);
  } catch (e) {
    p.error = e.message;
    jev.failed++;
    log('error', `Jev failed for ${p.id}: ${e.message}`);
  }
  postsDirty = true;
}
function pumpJev() {
  while (jevActive < cfg.jevConcurrency && jevQueue.length) {
    const p = jevQueue.shift();
    jevActive++;
    labelPost(p).finally(() => { jevActive--; pumpJev(); });
  }
}
function queueLabel(p) {
  if (!cfg.jevKey) {
    if (!jevKeyWarned) { jevKeyWarned = true; log('warn', 'JEV_API_KEY not set: posts are collected but not labeled'); }
    return;
  }
  jevQueue.push(p);
  pumpJev();
}
for (const p of [...posts].reverse()) if (!p.label) queueLabel(p); // resume unlabeled posts after a restart
if (cfg.slackUrl) for (const p of [...posts].reverse()) if (p.label === 'reply_now' && !p.slacked) notifySlack(p); // resend any that failed earlier

function ingest(t, author) {
  if (seen.has(t.id)) return false;
  seen.add(t.id);
  const m = t.public_metrics || {};
  const p = {
    id: t.id, url: `https://x.com/${author}/status/${t.id}`, author, text: t.text, createdAt: t.created_at,
    metrics: { views: m.impression_count || 0, likes: m.like_count || 0, replies: m.reply_count || 0, reposts: m.retweet_count || 0 },
    label: null,
  };
  // growth: weighted engagements per hour (floor the age at 15 min so brand-new posts aren't inflated)
  const ageHours = Math.max((Date.now() - new Date(t.created_at).getTime()) / 3600000, 0.25);
  p.ageMinutes = Math.round(ageHours * 60);
  p.velocity = Math.round((p.metrics.likes + 2 * p.metrics.reposts + 3 * p.metrics.replies) / ageHours);
  posts.unshift(p);
  if (posts.length > POSTS_MAX) posts.length = POSTS_MAX;
  postsDirty = true;
  if (ageHours > cfg.maxAgeHours) { p.label = 'skip'; p.auto = `older than ${cfg.maxAgeHours}h`; }
  else if (p.velocity < cfg.minVelocity) { p.label = 'skip'; p.auto = `growth ${p.velocity}/h is under ${cfg.minVelocity}/h`; }
  else queueLabel(p);
  return true;
}
const newer = (a, b) => (!b || BigInt(a) > BigInt(b) ? a : b);

async function scanViaSearch() {
  const groups = [];
  for (let i = 0; i < cfg.watch.length; i += 12) groups.push(cfg.watch.slice(i, i + 12)); // keep query under length limit
  let added = 0;
  for (const g of groups) {
    const key = g.join(',');
    const q = `(${g.map((a) => 'from:' + a).join(' OR ')}) -is:retweet${cfg.includeReplies ? '' : ' -is:reply'}${cfg.query ? ' ' + cfg.query : ''}`;
    const since = sinceIds.get(key) ? `&since_id=${sinceIds.get(key)}` : '';
    const b = await xGet('tweets/search/recent',
      `/2/tweets/search/recent?query=${encodeURIComponent(q)}&max_results=${cfg.maxPerPoll}&tweet.fields=created_at,public_metrics,author_id&expansions=author_id&user.fields=username${since}`);
    const names = new Map((b.includes?.users || []).map((u) => [u.id, u.username]));
    for (const t of b.data || []) {
      if (ingest(t, names.get(t.author_id) || 'i')) added++;
      sinceIds.set(key, newer(t.id, sinceIds.get(key)));
    }
  }
  return added;
}
async function scanViaTimelines() {
  if (!userIds) {
    userIds = new Map();
    for (let i = 0; i < cfg.watch.length; i += 100) {
      const b = await xGet('users/by', `/2/users/by?usernames=${encodeURIComponent(cfg.watch.slice(i, i + 100).join(','))}`);
      for (const u of b.data || []) userIds.set(u.username.toLowerCase(), { id: u.id, name: u.username });
      for (const e of b.errors || []) log('warn', `watch account not found: ${e.value || e.detail}`);
    }
  }
  let added = 0;
  for (const { id, name } of userIds.values()) {
    const excl = cfg.includeReplies ? 'retweets' : 'retweets,replies';
    const since = sinceIds.get(id) ? `&since_id=${sinceIds.get(id)}` : '';
    const b = await xGet('users/:id/tweets', `/2/users/${id}/tweets?max_results=${cfg.maxPerPoll}&exclude=${excl}&tweet.fields=created_at,public_metrics${since}`);
    for (const t of b.data || []) {
      if (cfg.query && !cfg.query.toLowerCase().split(/\s+/).some((w) => w && t.text.toLowerCase().includes(w.replace(/^["(]+|[")]+$/g, '')))) continue;
      if (ingest(t, name)) added++;
      sinceIds.set(id, newer(t.id, sinceIds.get(id)));
    }
  }
  return added;
}
let useTimelines = false;
async function scanAccounts() {
  if (!cfg.watch.length) return;
  let added;
  if (!useTimelines) {
    try { added = await scanViaSearch(); }
    catch (e) {
      if (e.status !== 403 && e.status !== 400) throw e;
      useTimelines = true;
      log('warn', 'search endpoint unavailable on this API tier; falling back to per-account timelines (keyword query is applied as a simple text filter)');
    }
  }
  if (useTimelines) added = await scanViaTimelines();
  log('info', `scan finished: ${added} new post(s) from ${cfg.watch.length} account(s)`);
}

async function poll() {
  state.polls.total++;
  state.polls.last = Date.now();
  state.polls.next = Date.now() + cfg.pollSeconds * 1000;
  if (!cfg.bearer) { state.polls.failed++; state.polls.lastError = 'X_BEARER_TOKEN not set'; log('warn', 'X_BEARER_TOKEN not set, skipping poll'); return; }
  let failures = 0;
  const attempt = async (fn) => { try { await fn(); } catch (e) { failures++; state.polls.lastError = e.message; } };

  if (cfg.username) {
    await attempt(async () => {
      const b = await xGet('users/by/username', `/2/users/by/username/${encodeURIComponent(cfg.username)}?user.fields=public_metrics,created_at,profile_image_url,description`);
      state.user = b.data;
      const pm = b.data.public_metrics;
      state.history.push({ t: Date.now(), followers: pm.followers_count, following: pm.following_count, tweets: pm.tweet_count });
    });
    if (state.user) {
      await attempt(async () => {
        const b = await xGet('users/:id/tweets', `/2/users/${state.user.id}/tweets?max_results=10&tweet.fields=public_metrics,created_at`);
        state.tweets = b.data || [];
      });
    }
  }
  await attempt(scanAccounts);
  await attempt(async () => { state.usage = (await xGet('usage/tweets', '/2/usage/tweets')).data; });

  if (failures === 0) { state.polls.ok++; state.polls.lastError = null; } else state.polls.failed++;
  persist();
}
function schedulePolling() {
  const run = () => poll().catch((e) => log('error', `poll crashed: ${e.message}`)).finally(() => setTimeout(run, cfg.pollSeconds * 1000));
  log('info', `dashboard started; polling every ${cfg.pollSeconds}s` + (cfg.username ? ` for @${cfg.username}` : ' (X_USERNAME not set: usage only)'));
  run();
}

// ---------- auth ----------
const SESSION_MS = 12 * 3600 * 1000;
const sign = (v) => crypto.createHmac('sha256', cfg.secret).update(v).digest('hex');
const safeEq = (a, b) => {
  const A = crypto.createHash('sha256').update(String(a)).digest();
  const B = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(A, B);
};
function makeSession() { const exp = String(Date.now() + SESSION_MS); return `${exp}.${sign(exp)}`; }
function validSession(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)session=([^;]+)/);
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  return !!sig && Number(exp) > Date.now() && safeEq(sig, sign(exp));
}
const fails = new Map(); // ip -> {n, until}
const lockedOut = (ip) => { const f = fails.get(ip); return !!f && f.until > Date.now(); };
function recordFail(ip) {
  const f = fails.get(ip) || { n: 0, until: 0 };
  f.n++;
  if (f.n >= 5) { f.until = Date.now() + 15 * 60 * 1000; f.n = 0; }
  fails.set(ip, f);
}

// ---------- http ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };
const send = (res, code, body, headers = {}) => {
  res.writeHead(code, { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
};
const json = (res, code, obj) => send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json' });
function serveFile(res, name) {
  try { send(res, 200, fs.readFileSync(path.join(ROOT, 'public', name)), { 'Content-Type': TYPES[path.extname(name)] || 'text/plain' }); }
  catch { send(res, 404, 'Not found'); }
}

function snapshot() {
  return {
    now: Date.now(), startedAt, uptimeMs: Date.now() - startedAt, pollIntervalSeconds: cfg.pollSeconds,
    hasToken: !!cfg.bearer, username: cfg.username || null,
    polls: state.polls, requests: state.requests, rateLimits: state.rateLimits,
    user: state.user, tweets: state.tweets, usage: state.usage, history: state.history.slice(-300),
    scan: {
      watch: cfg.watch, query: cfg.query, hasJevKey: !!cfg.jevKey, concurrency: cfg.jevConcurrency,
      total: posts.length, queued: jevQueue.length, active: jevActive, jevDone: jev.done, jevFailed: jev.failed,
      unlabeled: posts.filter((p) => !p.label).length,
      counts: Object.fromEntries(LABELS.map((l) => [l, posts.filter((p) => p.label === l).length])),
    },
  };
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = req.socket.remoteAddress;

  if (url.pathname === '/login' && req.method === 'POST') {
    if (lockedOut(ip)) return send(res, 429, 'Too many attempts. Try again in 15 minutes.');
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 2048) req.destroy(); });
    req.on('end', () => {
      const pw = new URLSearchParams(data).get('password') || '';
      if (safeEq(pw, cfg.password)) {
        log('info', `login ok from ${ip}`);
        return send(res, 302, '', { Location: '/', 'Set-Cookie': `session=${makeSession()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}` });
      }
      recordFail(ip);
      log('warn', `login failed from ${ip}`);
      send(res, 302, '', { Location: '/login?error=1' });
    });
    return;
  }
  if (url.pathname === '/login' && req.method === 'GET') return serveFile(res, 'login.html');
  if (url.pathname === '/logout') return send(res, 302, '', { Location: '/login', 'Set-Cookie': 'session=; HttpOnly; Path=/; Max-Age=0' });

  // everything below requires a session and is GET-only (read-only dashboard)
  if (!validSession(req)) return url.pathname.startsWith('/api/') ? json(res, 401, { error: 'unauthorized' }) : send(res, 302, '', { Location: '/login' });
  if (req.method !== 'GET') return send(res, 405, 'Read-only');

  if (url.pathname === '/' || url.pathname === '/index.html') return serveFile(res, 'index.html');
  if (url.pathname === '/api/stats') return json(res, 200, snapshot());
  if (url.pathname === '/api/posts') {
    const label = url.searchParams.get('label');
    const limit = Math.min(500, Number(url.searchParams.get('limit')) || 100);
    const list = label ? posts.filter((p) => (label === 'unlabeled' ? !p.label : p.label === label)) : posts;
    return json(res, 200, list.slice(0, limit));
  }
  if (url.pathname === '/api/logs') return json(res, 200, logs);
  if (url.pathname === '/api/logs/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }
  send(res, 404, 'Not found');
}).listen(cfg.port, () => { console.log(`Dashboard on http://localhost:${cfg.port}`); schedulePolling(); });
