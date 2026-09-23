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
  if (!res.ok) throw new Error(`${endpoint} ${res.status}: ${body.detail || body.title || 'request failed'}`);
  return body;
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
