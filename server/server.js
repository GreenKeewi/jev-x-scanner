// X API dashboard: read-only, password-protected. No dependencies (Node 18+).
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const DEFAULT_FALLBACK_SEARCH_QUERY = '("job search" OR hiring OR recruiter OR layoffs OR "open to work")';
function scoreThreshold(value) {
  const parsed = Number(value);
  const score = value === undefined || value === '' || !Number.isFinite(parsed) ? 2 : parsed;
  return Math.min(10, Math.max(0, score > 10 ? score / 100 : score));
}

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
  dataDir: path.resolve(ROOT, process.env.DATA_DIR || 'data'),
  password: process.env.DASHBOARD_PASSWORD || '',
  bearer: process.env.X_BEARER_TOKEN || '',
  username: (process.env.X_USERNAME || '').replace(/^@/, ''),
  pollSeconds: Math.max(60, Number(process.env.POLL_INTERVAL_SECONDS) || 300),
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  // scanning: watch these accounts (optionally filtered by a keyword query) and label each post with Jev
  watch: (process.env.X_WATCH_ACCOUNTS || '').split(',').map((s) => s.trim().replace(/^@/, '')).filter(Boolean),
  // With no watch list, search broadly for Dreamwork-relevant conversations instead.
  query: (process.env.X_SEARCH_QUERY || '').trim(),
  searchQueries: (process.env.X_SEARCH_QUERIES || '').split('||').map((query) => query.trim()).filter(Boolean),
  includeReplies: /^(1|true|yes)$/i.test(process.env.X_INCLUDE_REPLIES || ''),
  maxPerPoll: Math.min(100, Math.max(10, Number(process.env.MAX_POSTS_PER_POLL) || 10)),
  maxSearchPages: Math.min(5, Math.max(1, Number(process.env.MAX_SEARCH_PAGES_PER_POLL) || 1)),
  evalAllPosts: /^(1|true|yes)$/i.test(process.env.EVAL_ALL_POSTS || ''),
  evalPostLimit: Math.max(0, Number(process.env.EVAL_POST_LIMIT) || 0),
  runOnce: /^(1|true|yes)$/i.test(process.env.RUN_ONCE || ''),
  jevKey: process.env.JEV_API_KEY || '',
  jevConcurrency: Math.min(16, Math.max(1, Number(process.env.JEV_CONCURRENCY) || 4)),
  jevPreference: (process.env.JEV_PREFERENCE || '').trim(),
  // reply-opportunity tuning
  brand: (process.env.DREAMWORK_DESCRIPTION || '').trim() ||
    'Dreamwork (dreamworkhq.com, "Stop applying, start interviewing") is a job-search platform for tech professionals: upload a resume once and it ranks live roles by fit, ' +
    'tailors the resume and cover letter per role, and fills out applications on company sites, with an autopilot option. ' +
    'The @dreamworkhq account is small (about 1,000 followers) and known for: news-hook posts (AI hiring lawsuits such as Workday, job boards like Indeed selling visibility to employers, recruiter and deepfake-interview scams, whether hiring is actually opening back up), ' +
    'an anti-job-board, anti-opaque-AI-screening stance ("you\'re not the customer, you\'re the traffic"), a punchy conversational voice, and replies that add a sharp point or a pointed question rather than a pitch. ' +
    'Good posts to reply to: job hunting and applying, ATS/resume pain, AI screening or automated rejections, ghosting, interviews, recruiter scams, tech hiring and layoffs news, hiring-market data, internships and new-grad searches, job-board complaints, careers at top tech companies. ' +
    'Bad posts: anything unrelated to jobs or hiring (crypto, prediction markets, general AI hype), and posts where a plug would feel opportunistic. ' +
    'Be genuinely useful first. Never plug Dreamwork on someone\'s job loss or hardship, and never on unrelated topics.',
  slackUrl: (process.env.SLACK_WEBHOOK_URL || '').trim(),
  slackBotToken: (process.env.SLACK_BOT_TOKEN || '').trim(),
  slackChannelId: (process.env.SLACK_CHANNEL_ID || '').trim(),
  // X often withholds preview metadata from Slack. FixupX supplies the public
  // post metadata and redirects people back to X when they open the link.
  slackXPreviewDomain: (process.env.SLACK_X_PREVIEW_DOMAIN ?? 'fixupx.com').trim().toLowerCase(),
  // Sample ten posts in each hour from 5 AM through 2:59 PM Eastern.
  scanStartHour: 5,
  scanHours: 10,
  scanPerHour: 10,
  // One Slack message at 8 AM and another at 4 PM Eastern, with up to ten posts each.
  notificationBatchSize: 10,
  notificationTimezone: 'America/New_York',
  // discovery asks X only for posts that already have at least this many likes (0 = no floor)
  discoveryMinLikes: Number.isFinite(Number(process.env.DISCOVERY_MIN_LIKES)) && process.env.DISCOVERY_MIN_LIKES !== undefined && process.env.DISCOVERY_MIN_LIKES !== '' ? Number(process.env.DISCOVERY_MIN_LIKES) : 5,
  // The first comparison is always at 30 minutes. Optional later checks only update tracked posts.
  recheckMinutes: [...new Set([30, ...(process.env.RECHECK_MINUTES || '').split(',').map((s) => Number(s.trim())).filter((n) => n > 30)])].sort((a, b) => a - b),
  minVelocity: Number(process.env.MIN_VELOCITY_PER_HOUR) || 20, // actual likes + bookmarks + reposts + replies per hour
  // Accept a legacy 0-1000 threshold from an existing VPS .env while displaying 0-10 everywhere.
  minEngagementScore: scoreThreshold(process.env.MIN_ENGAGEMENT_SCORE),
  maxAgeHours: Math.min(24, Math.max(1, Number(process.env.MAX_POST_AGE_HOURS) || 24)), // warm posts only: never older than 24h
};
if (!cfg.watch.length && !cfg.query) cfg.query = DEFAULT_FALLBACK_SEARCH_QUERY;
if (!cfg.searchQueries.length) cfg.searchQueries = [cfg.query];
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
const STATE_FILE = path.join(cfg.dataDir, 'state.json');
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
state.notificationBatches = {};
try {
  const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  state.history = saved.history || [];
  state.notificationBatches = saved.notificationBatches || {};
} catch { /* first run */ }
function persist() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ history: state.history.slice(-2000), notificationBatches: state.notificationBatches }));
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
const POSTS_FILE = path.join(cfg.dataDir, 'posts.json');
const POSTS_MAX = 2000;
const LABELS = ['reply_now', 'maybe', 'skip'];
const RESPONDERS = ['dreamwork', 'ben', 'colin', 'none'];
const REASONS = [
  'jobseeker_pain',
  'application_or_interview_process',
  'hiring_market_or_layoff_news',
  'recruiting_or_ai_screening',
  'job_board_or_market_analysis',
  'low_relevance',
  'low_signal_or_momentum',
  'sensitive_or_forced_plug',
  'explicit_or_unsafe_content',
];
const CONTENT_SAFETY = ['clear', 'explicit_or_uncertain'];
const INSTRUCTIONS =
  'You are a reply-opportunity scout for Dreamwork. Identify X posts where Dreamwork, Ben, or Colin could add a specific, useful contribution to an active jobs or hiring conversation.' +
  (cfg.brand ? ` About Dreamwork: ${cfg.brand}` : '') +
  ' You are given the post, its author, its engagement, its age in minutes, its engagement per hour (measured over the first 30 minutes after discovery), and a growth log of timestamped engagement snapshots.' +
  ' Accelerating growth in the log is a strong positive signal; flat or slowing growth is a negative one.' +
  ' Be strict: most posts are not worth a reply. Only label reply_now when one of the three voices has a natural, non-promotional contribution. Do not draft a reply.';
const CRITERIA = {
  reply_now:
    'A fresh, relevant jobs or hiring conversation with enough signal that a reply could be seen. The post exposes a jobseeker pain point, application/interview friction, opaque hiring or AI screening, recruiter or job-board issue, hiring-market shift, or layoff context that can be discussed thoughtfully. One of Dreamwork, Ben, or Colin must have a natural, useful angle. Exclude tragedy, personal hardship, rage bait, giveaways, engagement farming, and situations where a plug would feel opportunistic.',
  maybe:
    'Related to work, jobs, hiring, or careers but lacks clear momentum, relevance, or a natural contribution from Dreamwork, Ben, or Colin. Keep it for human review but do not recommend an immediate reply.',
  skip:
    'Not worth replying to: unrelated, generic career content, spammy or low quality, slow/old, sensitive, controversial without a constructive angle, or likely to make a reply look like a forced plug.',
};
const RESPONDER_CRITERIA = {
  dreamwork: 'Use only for reply_now. The official Dreamwork account can offer a practical job-search, application, resume, interview, or hiring-system perspective. This is the best fit when a product-adjacent but genuinely helpful contribution is natural.',
  ben: 'Use only for reply_now. Route technical replies to Ben: software, AI, screening systems, job-board mechanics, or implementation details. His voice is concise and candid, but must not be cruel or opportunistic.',
  colin: 'Use only for reply_now. Route non-technical replies to Colin: candidate experience, market data, research, hiring trends, or product strategy. Choose when the contribution is thoughtful and accessible.',
  none: 'Choose for every maybe or skip verdict, and whenever no identity has a clearly natural reason to reply.',
};
const REASON_CRITERIA = {
  jobseeker_pain: 'The central issue is a concrete jobseeker problem: job search fatigue, ghosting, access, location constraints, or an unfair candidate experience.',
  application_or_interview_process: 'The central issue is applying, resumes, cover letters, interviewing, or getting from application to interview.',
  hiring_market_or_layoff_news: 'The central issue is a hiring-market, company-hiring, layoffs, or employment-news development with a constructive discussion angle.',
  recruiting_or_ai_screening: 'The central issue is recruiting practices, recruiter scams, ATS problems, AI screening, or automated rejections.',
  job_board_or_market_analysis: 'The central issue is job boards, labor-market incentives, hiring data, or how the market functions.',
  low_relevance: 'Exclude because the post is not meaningfully about jobs, job hunting, hiring, recruiting, or a related Dreamwork problem.',
  low_signal_or_momentum: 'Exclude because it is stale, has weak momentum, is generic, or has insufficient discussion value.',
  sensitive_or_forced_plug: 'Exclude because it concerns personal hardship, tragedy, sensitive controversy, rage bait, or would make a reply feel forced or promotional.',
  explicit_or_unsafe_content: 'Exclude because the post contains, discusses, alludes to, or links to explicit sexual, pornographic, graphic, or otherwise unsafe content. When the text or a linked destination is ambiguous, exclude it rather than risk a brand reply.',
};
const CONTENT_SAFETY_CRITERIA = {
  clear: 'The complete post text is safe for a professional recruiting brand: it contains no explicit sexual, pornographic, graphic, or otherwise unsafe content, and does not mention, discuss, or point readers to such material.',
  explicit_or_uncertain: 'The post contains, mentions, discusses, alludes to, or points readers to explicit sexual, pornographic, graphic, or otherwise unsafe material. Choose this if a shortened or opaque link makes the destination impossible to verify safely.',
};
let posts = []; // newest first: {id,url,author,text,createdAt,metrics,label,error}
try { posts = JSON.parse(fs.readFileSync(POSTS_FILE, 'utf8')); } catch { /* first run */ }
// Convert already-persisted ratings from the former 0-1000 scale.
for (const post of posts) if (post.engagementScore > 10) post.engagementScore = Math.round(post.engagementScore / 10) / 10;
const seen = new Set(posts.map((p) => p.id));
const sinceIds = new Map(); // scan-group key -> newest tweet id seen
let userIds = null;         // username(lowercase) -> id (timeline fallback)
let postsDirty = false;
function persistPosts() {
  try { fs.mkdirSync(path.dirname(POSTS_FILE), { recursive: true }); fs.writeFileSync(POSTS_FILE, JSON.stringify(posts.slice(0, POSTS_MAX))); postsDirty = false; }
  catch (e) { log('warn', `saving posts failed: ${e.message}`); }
}
setInterval(() => {
  if (!postsDirty) return;
  persistPosts();
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
        post: p.text, author: `@${p.author}`, ageMinutes: p.ageMinutes, engagementPerHour: p.velocity, engagementPerHourSincePosted: p.avgVelocity,
        engagement: { views: p.metrics.views, likes: p.metrics.likes, bookmarks: p.metrics.bookmarks, replies: p.metrics.replies, reposts: p.metrics.reposts, ratingOutOf10: p.engagementScore },
        growthLog: (p.snapshots || []).slice(-5).map((s) => ({ minutesSinceFirstSeen: Math.round((s.t - p.foundAt) / 60000), likes: s.likes, bookmarks: s.bookmarks, reposts: s.reposts, replies: s.replies, views: s.views })),
      },
      questions: {
        label: { type: 'choice', instructions: INSTRUCTIONS, criteria },
        responder: { type: 'choice', instructions: `${INSTRUCTIONS} Choose the best replying identity, or none.`, criteria: RESPONDER_CRITERIA },
        reason: { type: 'choice', instructions: `${INSTRUCTIONS} Select the single strongest inclusion or exclusion reason.`, criteria: REASON_CRITERIA },
        contentSafety: { type: 'choice', instructions: `${INSTRUCTIONS} Read the entire post text before answering. This is a hard brand-safety gate; do not assume a topic is safe because it is recruiting-related.`, criteria: CONTENT_SAFETY_CRITERIA },
      },
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Jev API responded ${res.status}`);
  const answers = (await res.json())?.answers;
  const label = answers?.label?.choice;
  const responder = answers?.responder?.choice;
  const reason = answers?.reason?.choice;
  const contentSafety = answers?.contentSafety?.choice;
  if (!LABELS.includes(label) || !RESPONDERS.includes(responder) || !REASONS.includes(reason) || !CONTENT_SAFETY.includes(contentSafety)) {
    throw new Error('unexpected Jev response');
  }
  // An unrouted reply_now cannot be actioned safely. Retain it for human
  // review as maybe instead of retrying forever or allowing it into Slack.
  const actionableLabel = label === 'reply_now' && responder === 'none' ? 'maybe' : label;
  // Jev can identify a hypothetical best voice even while deciding that the
  // post is not actionable. Non-reply verdicts never route anywhere, so make
  // that invariant explicit instead of discarding an otherwise valid review.
  const routedResponder = actionableLabel === 'reply_now' ? responder : 'none';
  if (contentSafety !== 'clear') return { label: 'skip', responder: 'none', reason: 'explicit_or_unsafe_content', contentSafety };
  return { label: actionableLabel, responder: routedResponder, reason, contentSafety };
}
const slackEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function slackPostUrl(postUrl) {
  if (!cfg.slackXPreviewDomain || !/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(cfg.slackXPreviewDomain)) return postUrl;
  try {
    const url = new URL(postUrl);
    if (!['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname.toLowerCase())) return postUrl;
    if (!/^\/[^/]+\/status\/\d+\/?$/i.test(url.pathname)) return postUrl;
    url.protocol = 'https:';
    url.hostname = cfg.slackXPreviewDomain;
    url.port = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return postUrl;
  }
}
const RESPONDER_TARGETS = {
  dreamwork: '<@U05TVFP09TM>', // Colin handles non-technical opportunities for the official account.
  ben: '<@U05TUED5BNX>',
  colin: '<@U05TVFP09TM>',
};
const easternParts = new Intl.DateTimeFormat('en-US', { timeZone: cfg.notificationTimezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const launchTime = new Intl.DateTimeFormat('en-US', { timeZone: cfg.notificationTimezone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
function localParts(timestamp) {
  return Object.fromEntries(easternParts.formatToParts(new Date(timestamp)).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}
function localDay(parts) { return `${parts.year}-${parts.month}-${parts.day}`; }
function scanSlot(timestamp) {
  const parts = localParts(timestamp);
  const hour = Number(parts.hour);
  return hour >= cfg.scanStartHour && hour < cfg.scanStartHour + cfg.scanHours ? `${localDay(parts)}-${parts.hour}` : null;
}
function dueNotificationBatch(timestamp) {
  const parts = localParts(timestamp);
  const hour = Number(parts.hour);
  if (hour !== 8 && hour !== 16) return null;
  return { key: `${localDay(parts)}-${parts.hour}`, label: hour === 8 ? '8:00 AM' : '4:00 PM' };
}
function firstWords(text, count = 15) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  return words.slice(0, count).join(' ') + (words.length > count ? '…' : '');
}
function hasMeasuredEngagement(post) {
  const snapshots = post.snapshots || [];
  return snapshots.length >= 2 && snapshots[snapshots.length - 1].t - snapshots[0].t >= 30 * 60000;
}
function slackBatchLine(post, rank) {
  const sourceUrl = slackEsc(post.url);
  const previewUrl = slackEsc(slackPostUrl(post.url));
  const flame = post.engagementPerHour > 50 ? ' 🔥' : '';
  return `${rank}. ${RESPONDER_TARGETS[post.responder]} ${slackEsc(firstWords(post.text))}\n` +
    `<${previewUrl}|${sourceUrl}> · Score ${Number(post.engagementScore).toFixed(1)}/10 · Engagement ${post.engagementPerHour}/hour${flame} · Launched ${launchTime.format(new Date(post.createdAt))}`;
}
let notificationFlushRunning = false;
async function sendSlackMessage(text) {
  const body = { text, unfurl_links: true, unfurl_media: true };
  if (cfg.slackBotToken) {
    if (!cfg.slackChannelId) throw new Error('SLACK_CHANNEL_ID is required with SLACK_BOT_TOKEN');
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.slackBotToken },
      body: JSON.stringify({ ...body, channel: cfg.slackChannelId }),
      signal: AbortSignal.timeout(10000),
    });
    const result = await res.json();
    if (!res.ok || !result.ok) throw new Error('Slack API responded ' + (result.error || res.status));
    return;
  }
  const res = await fetch(cfg.slackUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error('Slack responded ' + res.status);
}
async function flushNotificationQueue() {
  if (notificationFlushRunning || (!cfg.slackBotToken && !cfg.slackUrl)) return;
  const batch = dueNotificationBatch(Date.now());
  if (!batch || state.notificationBatches[batch.key]) return;
  notificationFlushRunning = true;
  try {
    const sentIds = new Set(Object.entries(state.notificationBatches)
      .filter(([key]) => key.startsWith(batch.key.slice(0, 10)))
      .flatMap(([, value]) => value.postIds || []));
    const candidates = posts
      .filter((post) => !post.slacked && !sentIds.has(post.id) && post.lang === 'en' && post.label === 'reply_now' && post.contentSafety === 'clear' && RESPONDER_TARGETS[post.responder] && hasMeasuredEngagement(post) && post.engagementScore >= cfg.minEngagementScore && ageHoursOf(post) <= cfg.maxAgeHours)
      .sort((a, b) => (b.engagementScore || 0) - (a.engagementScore || 0) || (b.engagementPerHour || 0) - (a.engagementPerHour || 0) || weighted(b.metrics) - weighted(a.metrics))
      .slice(0, cfg.notificationBatchSize);
    if (candidates.length) {
      const msg = `*Reply opportunities · ${batch.label} ET*\n` + candidates.map((post, index) => slackBatchLine(post, index + 1)).join('\n\n');
      await sendSlackMessage(msg);
      const sentAt = Date.now();
      for (const [index, post] of candidates.entries()) {
        post.slacked = true;
        post.slackedAt = sentAt;
        post.approvedAt = sentAt;
        post.approvalRank = index + 1;
      }
      persistPosts();
      log('info', `sent ${candidates.length} posts to Slack in ${batch.label} ET batch`);
    } else log('info', `no qualified posts for ${batch.label} ET Slack batch`);
    state.notificationBatches[batch.key] = { at: Date.now(), postIds: candidates.map((post) => post.id) };
    const cutoff = localDay(localParts(Date.now() - 14 * 86400000));
    for (const key of Object.keys(state.notificationBatches)) if (key.slice(0, 10) < cutoff) delete state.notificationBatches[key];
    persist();
  } catch (e) {
    log('error', `Slack batch ${batch.label} ET failed: ${e.message}`);
  } finally {
    notificationFlushRunning = false;
  }
}
async function labelPost(p) {
  try {
    let verdict;
    try { verdict = await callJev(p); } catch { verdict = await callJev(p); } // one retry
    p.label = verdict.label;
    p.responder = verdict.responder;
    p.reason = verdict.reason;
    p.contentSafety = verdict.contentSafety;
    p.error = undefined;
    p.labeledAt = Date.now();
    if (!cfg.evalAllPosts && p.label !== 'reply_now') p.status = 'done'; // normal scans stop re-reading posts we won't act on
    jev.done++;
    log('info', `labeled @${p.author} ${p.id}: ${p.label} (${p.responder}; ${p.reason}; ${p.contentSafety})`);
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
for (const p of [...posts].reverse()) { if (!p.label && p.queued) queueLabel(p); } // resume posts that were sent to Jev before a restart (tracking posts resume via rechecks)
setInterval(() => void flushNotificationQueue(), 15000).unref();
setTimeout(() => void flushNotificationQueue(), 1000).unref();

// ---- growth tracking: every post keeps timestamped snapshots of its engagement, and is re-read on a schedule ----
const postsById = new Map(posts.map((p) => [p.id, p]));
// The 0-10 score weights active signals above passive views. Engagement/hour
// is a separate, unweighted count of new interactions over the 30-minute re-read.
const engagementUnits = (s) => (s.likes || 0) + 2.5 * (s.bookmarks || 0) + 4 * (s.reposts || 0) + 5 * (s.replies || 0) + (s.views || 0) / 150;
const engagementRating = (s) => Math.min(10, Math.round(100 * (1 - Math.exp(-engagementUnits(s) / 80))) / 10);
const weighted = engagementUnits;
const engagements = (s) => (s.likes || 0) + (s.bookmarks || 0) + (s.reposts || 0) + (s.replies || 0);
const perHour = (a, b) => Math.max(0, Math.round((engagements(b) - engagements(a)) / Math.max((b.t - a.t) / 3600000, 1 / 60)));
const ageHoursOf = (p) => (Date.now() - new Date(p.createdAt).getTime()) / 3600000;

function nextCheck(p) {
  const mins = cfg.recheckMinutes[p.checks];
  p.nextCheckAt = mins == null ? null : p.foundAt + mins * 60000;
}
function addSnapshot(p, m) {
  const s = { t: Date.now(), likes: m.like_count || 0, bookmarks: m.bookmark_count || 0, reposts: m.retweet_count || 0, replies: m.reply_count || 0, views: m.impression_count || 0 };
  p.snapshots.push(s);
  if (p.snapshots.length > 12) p.snapshots.splice(1, 1); // keep the first, drop the oldest middle one
  p.metrics = { views: s.views, likes: s.likes, bookmarks: s.bookmarks, replies: s.replies, reposts: s.reposts };
  p.engagementScore = engagementRating(s);
  p.ageMinutes = Math.round(ageHoursOf(p) * 60);
  p.avgVelocity = Math.round(engagements(s) / Math.max(ageHoursOf(p), 0.25)); // since posted; not used for Slack
  const n = p.snapshots.length;
  p.recentVelocity = n >= 2 ? perHour(p.snapshots[n - 2], s) : null;       // between our last two looks
  if (p.engagementPerHour == null && n >= 2 && s.t - p.snapshots[0].t >= 30 * 60000) {
    p.engagementPerHour = perHour(p.snapshots[0], s); // the first 30-minute gain, projected to an hour
  }
  p.velocity = p.engagementPerHour ?? p.avgVelocity;
  postsDirty = true;
}
if (cfg.evalAllPosts) {
  // Preserve/recover all prior evaluation candidates when the local runner
  // restarts, including posts Jev had already marked maybe or skip.
  for (const p of posts) {
    p.status = 'tracking';
    if (!p.nextCheckAt) nextCheck(p);
  }
  postsDirty = posts.length > 0;
}
// Decide what to do after a new snapshot: skip, ask Jev, or keep watching.
function decide(p) {
  if (cfg.evalAllPosts) {
    // Explicit evaluation runs review every discovered post, without the
    // normal momentum gate used by the always-on scanner, and retains all
    // verdicts for the requested recheck schedule.
    if (!p.queued && !p.label) {
      p.queued = true;
      queueLabel(p);
    }
    p.status = 'tracking';
    nextCheck(p);
    if (p.nextCheckAt == null || ageHoursOf(p) > cfg.maxAgeHours) p.status = 'done';
    return;
  }
  if (p.label === 'skip' || p.label === 'maybe') { p.status = 'done'; return; }
  if (p.label || p.queued) { // already sent to Jev / qualified: keep logging growth until the schedule ends
    nextCheck(p);
    if (p.nextCheckAt == null || ageHoursOf(p) > cfg.maxAgeHours) p.status = 'done';
    return;
  }
  const skip = (why) => { p.label = 'skip'; p.auto = why; p.status = 'done'; p.labeledAt = Date.now(); log('info', `auto-skip @${p.author} ${p.id}: ${why}`); };
  if (ageHoursOf(p) > cfg.maxAgeHours) return skip(`older than ${cfg.maxAgeHours}h`);
  // Every normal candidate waits for a second look at least 30 minutes later.
  // At that point we project the observed interaction gain to an hourly figure.
  if (hasMeasuredEngagement(p)) {
    if (p.engagementScore < cfg.minEngagementScore) return skip(`score ${p.engagementScore}/10 is below ${cfg.minEngagementScore}/10`);
    if (p.engagementPerHour >= cfg.minVelocity) { p.queued = true; queueLabel(p); }
    else return skip(`engagement ${p.engagementPerHour}/hour is below ${cfg.minVelocity}/hour`);
  }
  p.status = 'tracking';
  nextCheck(p);
  if (p.nextCheckAt == null) { if (p.queued) p.status = 'done'; else skip('did not show enough growth'); }
}

let rechecking = false;
async function recheckDue() {
  if (rechecking || !cfg.bearer) return;
  const now = Date.now();
  const due = posts.filter((p) => p.status === 'tracking' && p.nextCheckAt && p.nextCheckAt <= now);
  if (!due.length) return;
  rechecking = true;
  try {
    for (let i = 0; i < due.length; i += 100) { // one batched read per 100 posts
      const batch = due.slice(i, i + 100);
      try {
        const b = await xGet('tweets', `/2/tweets?ids=${batch.map((p) => p.id).join(',')}&tweet.fields=public_metrics,created_at`);
        const got = new Map((b.data || []).map((t) => [t.id, t]));
        for (const p of batch) {
          const t = got.get(p.id);
          if (!t) { p.status = 'done'; if (!p.label) { p.label = 'skip'; p.auto = 'post no longer available'; } continue; }
          p.checks++;
          addSnapshot(p, t.public_metrics || {});
          log('info', `recheck @${p.author} ${p.id}: ${p.velocity} engagements/hour, ${p.metrics.likes} likes (check ${p.checks}/${cfg.recheckMinutes.length})`);
          decide(p);
        }
      } catch (e) { for (const p of batch) p.nextCheckAt = Date.now() + 5 * 60000; } // xGet already logged it; retry in 5 min
    }
  } finally { rechecking = false; postsDirty = true; persistPosts(); }
}
setInterval(() => recheckDue().catch((e) => log('error', `recheck crashed: ${e.message}`)), 60000).unref();

function ingest(t, author) {
  const m = t.public_metrics || {};
  // Search can filter by language, but timeline fallback cannot. Keep this
  // second gate so Jev, ranking, and Slack only ever see English posts.
  if (!t.lang || t.lang.toLowerCase() !== 'en') return false;
  const existing = postsById.get(t.id);
  if (existing) return false; // the second measurement happens at the scheduled 30-minute recheck
  if (cfg.evalPostLimit && posts.length >= cfg.evalPostLimit) return false;
  if (Date.now() - new Date(t.created_at).getTime() > cfg.maxAgeHours * 3600000) return false; // too old to be worth storing
  const p = {
    id: t.id, url: `https://x.com/${author}/status/${t.id}`, author, text: t.text, lang: t.lang.toLowerCase(), createdAt: t.created_at,
    metrics: { views: 0, likes: 0, bookmarks: 0, replies: 0, reposts: 0 }, snapshots: [], label: null, foundAt: Date.now(), checks: 0, status: 'tracking',
  };
  addSnapshot(p, m);
  posts.unshift(p);
  postsById.set(p.id, p);
  for (const d of posts.splice(POSTS_MAX)) postsById.delete(d.id);
  decide(p);
  return true;
}
const newer = (a, b) => (!b || BigInt(a) > BigInt(b) ? a : b);

// Discovery: ask X for the most relevant (engaged) recent posts from the watched accounts, only within the age window.
const feat = { minLikes: cfg.discoveryMinLikes > 0, relevancy: true };
async function scanViaSearch(limit) {
  const groups = [];
  for (let i = 0; i < cfg.watch.length; i += 12) groups.push(cfg.watch.slice(i, i + 12)); // keep query under length limit
  if (!groups.length) groups.push([]); // global search fallback when no accounts are configured
  const windowHours = Math.min(cfg.maxAgeHours, 167);
  let added = 0;
  for (const g of groups) {
    for (const query of cfg.searchQueries) {
      if (added >= limit || (cfg.evalPostLimit && posts.length >= cfg.evalPostLimit)) break;
      const accounts = g.length ? `(${g.map((a) => 'from:' + a).join(' OR ')}) ` : '';
      const q = `${accounts}-is:retweet lang:en${cfg.includeReplies ? '' : ' -is:reply'}` +
        `${feat.minLikes ? ` min_likes:${cfg.discoveryMinLikes}` : ''}${query ? ' ' + query : ''}`;
      const start = new Date(Date.now() - windowHours * 3600000 + 60000).toISOString();
      let nextToken = '';
      for (let page = 0; page < cfg.maxSearchPages; page++) {
        if (added >= limit) break;
        const b = await xGet('tweets/search/recent',
          `/2/tweets/search/recent?query=${encodeURIComponent(q)}&max_results=${cfg.maxPerPoll}&start_time=${start}` +
          `${feat.relevancy ? '&sort_order=relevancy' : ''}&tweet.fields=created_at,lang,public_metrics,author_id&expansions=author_id&user.fields=username` +
          (nextToken ? `&next_token=${encodeURIComponent(nextToken)}` : ''));
        const names = new Map((b.includes?.users || []).map((u) => [u.id, u.username]));
        for (const t of b.data || []) {
          if (added >= limit) break;
          if (ingest(t, names.get(t.author_id) || 'i')) added++;
        }
        nextToken = b.meta?.next_token || '';
        if (!nextToken || (cfg.evalPostLimit && posts.length >= cfg.evalPostLimit)) break;
      }
    }
  }
  return added;
}
async function scanViaTimelines(limit) {
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
    if (added >= limit) break;
    const excl = cfg.includeReplies ? 'retweets' : 'retweets,replies';
    const since = sinceIds.get(id) ? `&since_id=${sinceIds.get(id)}` : '';
    const b = await xGet('users/:id/tweets', `/2/users/${id}/tweets?max_results=${cfg.maxPerPoll}&exclude=${excl}&tweet.fields=created_at,lang,public_metrics${since}`);
    for (const t of b.data || []) {
      if (added >= limit) break;
      sinceIds.set(id, newer(t.id, sinceIds.get(id)));
      if (cfg.query && !cfg.query.toLowerCase().split(/\s+/).some((w) => w && t.text.toLowerCase().includes(w.replace(/^["(]+|[")]+$/g, '')))) continue;
      if (ingest(t, name)) added++;
    }
  }
  return added;
}
let useTimelines = false;
let lastScanSlot = null;
async function scanAccounts() {
  if (!cfg.watch.length && !cfg.query) return;
  const slot = cfg.evalAllPosts ? null : scanSlot(Date.now());
  if (!cfg.evalAllPosts && (!slot || lastScanSlot === slot)) return;
  const scannedThisHour = slot ? posts.filter((post) => post.foundAt && scanSlot(post.foundAt) === slot).length : 0;
  const limit = cfg.evalAllPosts ? Infinity : Math.max(0, cfg.scanPerHour - scannedThisHour);
  if (!limit) { lastScanSlot = slot; return; }
  let added = 0;
  for (let attempt = 0; attempt < 3 && !useTimelines; attempt++) {
    try { added = await scanViaSearch(limit); break; }
    catch (e) {
      if (e.status === 400 && feat.minLikes) { feat.minLikes = false; log('warn', 'search rejected the min_likes operator; retrying without it'); continue; }
      if (e.status === 400 && feat.relevancy) { feat.relevancy = false; log('warn', 'search rejected sort_order=relevancy; retrying without it'); continue; }
      if (e.status !== 403 && e.status !== 400) throw e;
      useTimelines = true;
      log('warn', 'search endpoint unavailable on this API tier; falling back to per-account timelines (keyword query is applied as a simple text filter)');
    }
  }
  if (useTimelines) added = await scanViaTimelines(limit);
  lastScanSlot = slot;
  if (added) persistPosts();
  log('info', `scan finished: ${added} new post(s) from ${cfg.watch.length || 'global search'} source(s)`);
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
      unlabeled: posts.filter((p) => !p.label).length, tracking: posts.filter((p) => p.status === 'tracking').length,
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
  if (url.pathname === '/qualified') return serveFile(res, 'qualified.html');
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
