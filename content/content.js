// Jev X Scanner — content script
//
// NOTE on ES module import: MV3 `content_scripts` entries do not support a
// `"type": "module"` field (that only applies to the background service
// worker), and there is no officially reliable way to get a content script
// registered via the `content_scripts` manifest key to use a static
// `import` of another extension file across all supported Chrome versions.
// Rather than rely on undocumented/inconsistent behavior, we inline the
// small set of constants we need from ../shared/contract.js as a fallback.
// These values MUST be kept in sync with shared/contract.js by hand.
// (If shared/contract.js changes, update the block below to match.)

const STORAGE_KEYS = {
  API_KEY: "typesafeApiKey",
  ENABLED: "extensionEnabled",
  PREFERENCE: "userPreference",
  POST_RECORDS: "postRecords",
  CRITERIA: "labelCriteria",
  SESSION_LIMIT: "sessionLimit",
  AUTO_RELOAD: "autoReloadOnLimit",
  SCAN_REPLIES: "scanReplies",
};

const DEFAULT_SETTINGS = {
  [STORAGE_KEYS.ENABLED]: true,
  [STORAGE_KEYS.PREFERENCE]: "",
  [STORAGE_KEYS.SESSION_LIMIT]: 200,
  [STORAGE_KEYS.AUTO_RELOAD]: false,
  [STORAGE_KEYS.SCAN_REPLIES]: true,
};

const MESSAGE_TYPES = {
  CLASSIFY_POST: "CLASSIFY_POST",
  OPEN_DASHBOARD: "OPEN_DASHBOARD",
  OPEN_OPTIONS: "OPEN_OPTIONS",
};

const LABEL_META = {
  breaking: { icon: "⚡", text: "Breaking", className: "jev-badge-breaking" },
  golden_nugget: { icon: "🪙", text: "Golden Nugget", className: "jev-badge-golden" },
  ai_slop: { icon: "🤖", text: "Slop", className: "jev-badge-slop" },
};

(function () {
  "use strict";

  // ---- State -------------------------------------------------------------

  let enabled = DEFAULT_SETTINGS[STORAGE_KEYS.ENABLED];
  let sessionLimit = DEFAULT_SETTINGS[STORAGE_KEYS.SESSION_LIMIT];
  let autoReload = DEFAULT_SETTINGS[STORAGE_KEYS.AUTO_RELOAD];
  let scanReplies = DEFAULT_SETTINGS[STORAGE_KEYS.SCAN_REPLIES];

  /** tweetIds we've already requested classification for (never re-request). */
  const requestedTweetIds = new Set();

  /** article element -> its IntersectionObserver, so we can disconnect on trigger. */
  const articleObservers = new WeakMap();

  /** Root MutationObserver watching the timeline for new posts. */
  let timelineObserver = null;

  // ---- Session scan state (per tab, resets on reload) --------------------

  /** Number of classification requests sent this page session. */
  let sessionClassifiedCount = 0;
  /** Number of classification requests currently in flight. */
  let inFlightCount = 0;
  /** true once sessionClassifiedCount has reached sessionLimit. */
  let limitReached = false;

  // ---- Classification job queue -------------------------------------------
  //
  // Posts become eligible for classification when they scroll into view
  // (see observeForViewport). Rather than firing chrome.runtime.sendMessage
  // immediately at that moment — which can burst dozens of concurrent
  // requests on a fast scroll — we push a job onto this in-memory queue and
  // let a small runner drain it at a fixed concurrency.

  /** @type {Array<{article: HTMLElement, tweetId: string, text: string}>} */
  const classificationQueue = [];
  /** Number of classification requests currently sent and awaiting a response. */
  let activeJobCount = 0;
  const MAX_CONCURRENT_JOBS = 3;

  // ---- Settings load + live updates --------------------------------------

  function loadSettingsAndStart() {
    chrome.storage.local.get(
      [
        STORAGE_KEYS.ENABLED,
        STORAGE_KEYS.SESSION_LIMIT,
        STORAGE_KEYS.AUTO_RELOAD,
        STORAGE_KEYS.SCAN_REPLIES,
      ],
      (result) => {
        enabled =
          result[STORAGE_KEYS.ENABLED] !== undefined
            ? result[STORAGE_KEYS.ENABLED]
            : DEFAULT_SETTINGS[STORAGE_KEYS.ENABLED];
        sessionLimit =
          result[STORAGE_KEYS.SESSION_LIMIT] || DEFAULT_SETTINGS[STORAGE_KEYS.SESSION_LIMIT];
        autoReload =
          result[STORAGE_KEYS.AUTO_RELOAD] ?? DEFAULT_SETTINGS[STORAGE_KEYS.AUTO_RELOAD];
        scanReplies =
          result[STORAGE_KEYS.SCAN_REPLIES] !== undefined
            ? result[STORAGE_KEYS.SCAN_REPLIES]
            : DEFAULT_SETTINGS[STORAGE_KEYS.SCAN_REPLIES];

        updateSessionUi();

        if (enabled) {
          startObserving();
        }
      }
    );
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;

    if (Object.prototype.hasOwnProperty.call(changes, STORAGE_KEYS.ENABLED)) {
      enabled = changes[STORAGE_KEYS.ENABLED].newValue;
      if (enabled && !limitReached) {
        startObserving();
      } else {
        stopObserving();
      }
    }

    if (Object.prototype.hasOwnProperty.call(changes, STORAGE_KEYS.SCAN_REPLIES)) {
      scanReplies =
        changes[STORAGE_KEYS.SCAN_REPLIES].newValue !== undefined
          ? changes[STORAGE_KEYS.SCAN_REPLIES].newValue
          : DEFAULT_SETTINGS[STORAGE_KEYS.SCAN_REPLIES];
    }

    if (Object.prototype.hasOwnProperty.call(changes, STORAGE_KEYS.SESSION_LIMIT)) {
      sessionLimit =
        changes[STORAGE_KEYS.SESSION_LIMIT].newValue || DEFAULT_SETTINGS[STORAGE_KEYS.SESSION_LIMIT];
      updateSessionUi();
    }

    if (Object.prototype.hasOwnProperty.call(changes, STORAGE_KEYS.AUTO_RELOAD)) {
      autoReload = changes[STORAGE_KEYS.AUTO_RELOAD].newValue ?? DEFAULT_SETTINGS[STORAGE_KEYS.AUTO_RELOAD];
    }
  });

  // ---- Timeline observation -----------------------------------------------

  function startObserving() {
    if (limitReached) return;
    if (timelineObserver) return; // already running

    timelineObserver = new MutationObserver((mutations) => {
      if (!enabled) return;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          handleAddedNode(node);
        }
      }
    });

    timelineObserver.observe(document.body, { childList: true, subtree: true });

    // Handle posts already on the page at start-up.
    document.querySelectorAll('article[data-testid="tweet"]').forEach((article) => {
      handleArticle(article);
    });
  }

  function stopObserving() {
    if (timelineObserver) {
      timelineObserver.disconnect();
      timelineObserver = null;
    }
  }

  function handleAddedNode(node) {
    if (node.matches && node.matches('article[data-testid="tweet"]')) {
      handleArticle(node);
    }
    if (node.querySelectorAll) {
      node.querySelectorAll('article[data-testid="tweet"]').forEach((article) => {
        handleArticle(article);
      });
    }
  }

  // ---- Per-post handling ---------------------------------------------------

  // ---- Ad / reply detection -------------------------------------------------
  //
  // Both heuristics are best-effort: X's markup for these indicators shifts
  // periodically and isn't part of any stable public API. We scope our
  // search to a small "header-ish" region near the top of the article
  // (rather than the whole article) specifically to avoid false positives
  // from ordinary post text that happens to contain the words "Promoted" or
  // "Replying to" (e.g. someone tweeting about a promoted post).

  function getHeaderRegion(article) {
    // The indicator text (when present) always renders above the tweet's
    // own text/media, so the first ~2 direct-ish descendant blocks are
    // enough; querySelectorAll on the whole article would risk matching
    // quote-tweets or replies-to text nested further down.
    return article.querySelector('div[data-testid="tweetText"]')?.parentElement?.parentElement || article;
  }

  function isPromotedPost(article) {
    // (a) Explicit test id X sometimes attaches to the "Promoted" label.
    if (article.querySelector('[data-testid="promotedIndicator"]')) return true;

    // (b) Fall back to scanning a scoped header region for literal
    // "Promoted" text or an aria-label containing it. Limitation: if X
    // changes the exact copy (localization, "Ad" abbreviation, etc.) this
    // will miss it; conversely a differently-scoped false positive is
    // possible if X nests unrelated text in that region.
    const header = getHeaderRegion(article);
    const candidates = header.querySelectorAll("span, div, a");
    for (const el of candidates) {
      const text = (el.textContent || "").trim();
      if (text === "Promoted") return true;
      const ariaLabel = el.getAttribute && el.getAttribute("aria-label");
      if (ariaLabel && ariaLabel.includes("Promoted")) return true;
    }
    return false;
  }

  function isReplyPost(article) {
    // X renders "Replying to @username" as a text/link block near the top
    // of a reply. We look for an element whose own text starts with
    // "Replying to" within the same scoped header region used for ad
    // detection. Limitation: nested quote-tweets that are themselves
    // replies could be missed or, rarely, mis-scoped depending on DOM
    // structure changes.
    const header = getHeaderRegion(article);
    const candidates = header.querySelectorAll("div, span, a");
    for (const el of candidates) {
      const text = (el.textContent || "").trim();
      if (text.startsWith("Replying to")) return true;
    }
    return false;
  }

  function extractTweetId(article) {
    // Assumption: the status permalink anchor has an href like
    // "/username/status/1234567890123456789" (optionally with a trailing
    // path/query, e.g. "/photo/1"). We take the first such anchor found.
    const link = article.querySelector('a[href*="/status/"]');
    if (!link) return null;
    const href = link.getAttribute("href") || "";
    const match = href.match(/\/status\/(\d+)/);
    return match ? match[1] : null;
  }

  // ---- Engagement scraping -------------------------------------------------
  //
  // Strategy: X renders each action-bar item as a button/link with
  // data-testid in {"reply", "retweet", "like"}; the visible count text
  // lives somewhere inside that element (X restructures this markup
  // periodically, so we grab all text content of the element and pull the
  // first number-like token out of it rather than assuming a fixed child
  // structure). Views are the flakiest: modern X renders them as a link to
  // `/analytics` (or `/status/<id>` with an analytics-shaped aria-label)
  // containing an `app-text-transition-container` counter; we fall back to
  // scanning all links/spans for an aria-label matching "<number> views" if
  // that selector doesn't match. Any count we can't find or parse defaults
  // to 0 — engagement is a best-effort signal, never a blocker.

  function parseAbbreviatedNumber(raw) {
    if (!raw) return 0;
    const cleaned = raw.replace(/,/g, "").trim();
    const match = cleaned.match(/([\d.]+)\s*([KMB]?)/i);
    if (!match) return 0;
    const num = parseFloat(match[1]);
    if (Number.isNaN(num)) return 0;
    const suffix = match[2].toUpperCase();
    const multiplier = suffix === "K" ? 1e3 : suffix === "M" ? 1e6 : suffix === "B" ? 1e9 : 1;
    return Math.round(num * multiplier);
  }

  function extractCountByTestId(article, testId) {
    const el = article.querySelector(`[data-testid="${testId}"]`);
    if (!el) return 0;
    // Prefer an explicit aria-label like "12 Replies" / "1.2K reposts" since
    // it's less likely to pick up unrelated digits; fall back to raw text.
    const ariaLabel = el.getAttribute("aria-label") || el.closest("[aria-label]")?.getAttribute("aria-label") || "";
    const text = ariaLabel || el.textContent || "";
    const match = text.match(/[\d,.]+\s*[KMB]?/i);
    return match ? parseAbbreviatedNumber(match[0]) : 0;
  }

  function extractViewCount(article) {
    // Primary: link to /analytics, which X uses for the view counter.
    const analyticsLink = article.querySelector('a[href*="/analytics"]');
    if (analyticsLink) {
      const container = analyticsLink.querySelector('[data-testid="app-text-transition-container"]');
      const text = (container ? container.textContent : analyticsLink.textContent) || "";
      const match = text.match(/[\d,.]+\s*[KMB]?/i);
      if (match) return parseAbbreviatedNumber(match[0]);
    }
    // Fallback: scan for an aria-label like "12,345 views".
    const candidates = article.querySelectorAll("a[aria-label], span[aria-label]");
    for (const el of candidates) {
      const label = el.getAttribute("aria-label") || "";
      const match = label.match(/([\d,.]+\s*[KMB]?)\s*views?/i);
      if (match) return parseAbbreviatedNumber(match[1]);
    }
    return 0;
  }

  function extractEngagement(article) {
    return {
      views: extractViewCount(article),
      likes: extractCountByTestId(article, "like"),
      replies: extractCountByTestId(article, "reply"),
      reposts: extractCountByTestId(article, "retweet"),
    };
  }

  function extractPostUrl(article, tweetId) {
    // Prefer the actual permalink anchor (has the author handle in it), so
    // the dashboard link matches the real post URL exactly.
    const link = article.querySelector('a[href*="/status/"]');
    if (link) {
      const href = link.getAttribute("href") || "";
      if (href.startsWith("http")) return href;
      if (href.startsWith("/")) return `https://x.com${href.split("?")[0]}`;
    }
    return `https://x.com/i/status/${tweetId}`;
  }

  function extractText(article) {
    // Assumption: the post's own text lives in div[data-testid="tweetText"].
    // Quote-tweets can contain a nested tweetText for the quoted post; we
    // only care about the outermost/first one, which corresponds to this
    // article's own text content.
    const textEl = article.querySelector('div[data-testid="tweetText"]');
    if (!textEl) return "";
    return textEl.textContent.trim();
  }

  function handleArticle(article) {
    if (!enabled || limitReached) return;
    if (article.dataset.jevProcessed === "1") return;

    const tweetId = extractTweetId(article);
    if (!tweetId) return; // can't identify post, skip

    article.dataset.jevProcessed = "1";
    article.dataset.jevTweetId = tweetId;

    const text = extractText(article);
    if (!text) return; // image/video-only post, nothing to classify

    // Every post is now handled exclusively via the viewport path: it's
    // only queued for classification once it actually scrolls into view.
    observeForViewport(article, tweetId, text);
  }

  function observeForViewport(article, tweetId, text) {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            if (limitReached) {
              observer.disconnect();
              articleObservers.delete(article);
              return;
            }
            enqueueClassification(article, tweetId, text);
            observer.disconnect();
            articleObservers.delete(article);
          }
        }
      },
      { root: null, threshold: 0.1 }
    );
    articleObservers.set(article, observer);
    observer.observe(article);
  }

  // ---- Classification queue runner -----------------------------------------
  //
  // enqueueClassification is the single entry point for adding a post to the
  // queue (dedup by tweetId happens here, at enqueue time, not at send time).
  // runQueue() drains the queue at a fixed concurrency (MAX_CONCURRENT_JOBS)
  // so a fast scroll that reveals many posts at once doesn't burst dozens of
  // simultaneous chrome.runtime.sendMessage calls.

  function enqueueClassification(article, tweetId, text) {
    if (requestedTweetIds.has(tweetId)) return;
    if (limitReached) return;

    if (isPromotedPost(article)) return; // ads are skipped entirely
    if (!scanReplies && isReplyPost(article)) return; // reply filter toggle

    requestedTweetIds.add(tweetId);

    sessionClassifiedCount += 1;
    updateSessionUi();

    if (sessionClassifiedCount >= sessionLimit) {
      onLimitReached();
    }

    classificationQueue.push({ article, tweetId, text });
    runQueue();
  }

  function runQueue() {
    while (activeJobCount < MAX_CONCURRENT_JOBS && classificationQueue.length > 0) {
      const job = classificationQueue.shift();
      activeJobCount += 1;
      inFlightCount += 1;
      updateSessionUi();
      sendClassificationJob(job);
    }
  }

  function sendClassificationJob({ article, tweetId, text }) {
    const engagement = extractEngagement(article);
    const url = extractPostUrl(article, tweetId);

    chrome.runtime.sendMessage(
      { type: MESSAGE_TYPES.CLASSIFY_POST, tweetId, url, text, engagement },
      (response) => {
        activeJobCount = Math.max(0, activeJobCount - 1);
        inFlightCount = Math.max(0, inFlightCount - 1);
        updateSessionUi();

        if (!chrome.runtime.lastError) {
          renderBadgeResult(article, response);
        }
        // chrome.runtime.lastError (extension context gone / background
        // unreachable) — omit badge entirely.

        runQueue();
      }
    );
  }

  // ---- Badge rendering -------------------------------------------------

  function ensureRelativePositioning(article) {
    const computed = window.getComputedStyle(article);
    if (computed.position === "static") {
      article.style.position = "relative";
    }
  }

  function removeExistingBadge(article) {
    const existing = article.querySelector(":scope > .jev-badge");
    if (existing) existing.remove();
  }

  function renderBadgeResult(article, response) {
    if (!response) return; // no answer (e.g. background didn't respond) — omit

    if (response.ok) {
      renderLabelBadge(article, response.label);
    } else if (response.error === "NO_API_KEY") {
      renderSetApiKeyBadge(article);
    }
    // response.error === "API_ERROR" (or anything else): omit entirely, per spec.
  }

  function renderLabelBadge(article, label) {
    const meta = LABEL_META[label];
    if (!meta) return;

    ensureRelativePositioning(article);
    removeExistingBadge(article);

    const badge = document.createElement("span");
    badge.className = `jev-badge ${meta.className}`;
    badge.title = `Jev Judged: ${meta.text}`;
    badge.textContent = `${meta.icon} ${meta.text}`;

    article.appendChild(badge);
  }

  function renderSetApiKeyBadge(article) {
    ensureRelativePositioning(article);
    removeExistingBadge(article);

    const badge = document.createElement("button");
    badge.type = "button";
    badge.className = "jev-badge jev-badge-set-key";
    badge.title = "Jev Judged: API key required";
    badge.textContent = "🔑 Set API key";
    badge.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openApiKeyModal();
    });

    article.appendChild(badge);
  }

  // ---- Floating counter widget -------------------------------------------
  //
  // Injected once per page load, fixed bottom-left. Two parts: a counts
  // pill (click opens the dashboard) and a key button (click opens an
  // in-page modal to add/edit the Jev API key). Counts reflect ALL
  // persisted PostRecords in chrome.storage.local[STORAGE_KEYS.POST_RECORDS]
  // (not just this page's session), refreshed on load and kept live via
  // chrome.storage.onChanged.

  let countsButtonEl = null;
  let limitBannerEl = null;

  function onLimitReached() {
    if (limitReached) return;
    limitReached = true;
    stopObserving();

    if (autoReload) {
      renderLimitBanner("Limit reached — reloading…");
      setTimeout(() => window.location.reload(), 1200);
    } else {
      renderLimitBanner("Limit reached — reload to continue");
    }
  }

  function renderLimitBanner(message) {
    if (!limitBannerEl) return;
    limitBannerEl.hidden = false;
    limitBannerEl.querySelector(".jev-limit-text").textContent = message;
  }

  function updateSessionUi() {
    if (limitBannerEl) {
      limitBannerEl.title = `${sessionClassifiedCount} / ${sessionLimit} classified this session${
        inFlightCount > 0 ? ` · ${inFlightCount} in flight` : ""
      }`;
    }
  }

  function countLabels(records) {
    const counts = { breaking: 0, golden_nugget: 0, ai_slop: 0 };
    if (Array.isArray(records)) {
      for (const record of records) {
        if (record && Object.prototype.hasOwnProperty.call(counts, record.label)) {
          counts[record.label] += 1;
        }
      }
    }
    return counts;
  }

  function renderCounterWidget(counts) {
    if (!countsButtonEl) return;
    countsButtonEl.textContent =
      `⚡ ${counts.breaking} · 🪙 ${counts.golden_nugget} · 🤖 ${counts.ai_slop}`;
  }

  function refreshCounterWidget() {
    chrome.storage.local.get([STORAGE_KEYS.POST_RECORDS], (result) => {
      if (chrome.runtime.lastError) return;
      renderCounterWidget(countLabels(result[STORAGE_KEYS.POST_RECORDS]));
    });
  }

  function injectCounterWidget() {
    if (document.querySelector(".jev-counter-widget")) return;

    const widget = document.createElement("div");
    widget.className = "jev-counter-widget";

    const topRow = document.createElement("div");
    topRow.className = "jev-counter-top-row";

    countsButtonEl = document.createElement("button");
    countsButtonEl.type = "button";
    countsButtonEl.className = "jev-counter-counts";
    countsButtonEl.title = "Open Jev X Scanner dashboard";
    countsButtonEl.textContent = "⚡ 0 · 🪙 0 · 🤖 0";
    countsButtonEl.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: MESSAGE_TYPES.OPEN_DASHBOARD });
    });

    const settingsButtonEl = document.createElement("button");
    settingsButtonEl.type = "button";
    settingsButtonEl.className = "jev-counter-settings-btn";
    settingsButtonEl.title = "Open Jev X Scanner settings";
    settingsButtonEl.textContent = "⚙️";
    settingsButtonEl.addEventListener("click", (event) => {
      event.stopPropagation();
      chrome.runtime.sendMessage({ type: MESSAGE_TYPES.OPEN_OPTIONS });
    });

    const keyButtonEl = document.createElement("button");
    keyButtonEl.type = "button";
    keyButtonEl.className = "jev-counter-key-btn";
    keyButtonEl.title = "Add/edit Jev API key";
    keyButtonEl.textContent = "🔑";
    keyButtonEl.addEventListener("click", (event) => {
      event.stopPropagation();
      openApiKeyModal();
    });

    topRow.appendChild(countsButtonEl);
    topRow.appendChild(settingsButtonEl);
    topRow.appendChild(keyButtonEl);

    limitBannerEl = document.createElement("div");
    limitBannerEl.className = "jev-limit-banner";
    limitBannerEl.hidden = true;
    limitBannerEl.innerHTML = `
      <span class="jev-limit-text"></span>
      <button type="button" class="jev-limit-reload-btn">Reload now</button>
    `;
    limitBannerEl
      .querySelector(".jev-limit-reload-btn")
      .addEventListener("click", () => window.location.reload());

    widget.appendChild(topRow);
    widget.appendChild(limitBannerEl);
    document.body.appendChild(widget);
    refreshCounterWidget();
    updateSessionUi();
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (Object.prototype.hasOwnProperty.call(changes, STORAGE_KEYS.POST_RECORDS)) {
      renderCounterWidget(countLabels(changes[STORAGE_KEYS.POST_RECORDS].newValue));
    }
  });

  // ---- API key modal ------------------------------------------------------

  function closeApiKeyModal(overlay) {
    overlay.remove();
    document.removeEventListener("keydown", handleModalKeydown);
  }

  function handleModalKeydown(event) {
    if (event.key === "Escape") {
      const overlay = document.querySelector(".jev-modal-overlay");
      if (overlay) closeApiKeyModal(overlay);
    }
  }

  function openApiKeyModal() {
    if (document.querySelector(".jev-modal-overlay")) return;

    const overlay = document.createElement("div");
    overlay.className = "jev-modal-overlay";

    const modal = document.createElement("div");
    modal.className = "jev-modal";

    modal.innerHTML = `
      <h2>Jev API key</h2>
      <p>Stored locally in this browser and used to classify posts.</p>
      <input type="password" id="jev-modal-key-input" autocomplete="off" spellcheck="false" placeholder="Paste your TypeSafe API key" />
      <p class="jev-modal-status" id="jev-modal-status"></p>
      <div class="jev-modal-actions">
        <button type="button" class="jev-modal-cancel">Cancel</button>
        <button type="button" class="jev-modal-save">Save</button>
      </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const input = modal.querySelector("#jev-modal-key-input");
    const status = modal.querySelector("#jev-modal-status");
    const cancelBtn = modal.querySelector(".jev-modal-cancel");
    const saveBtn = modal.querySelector(".jev-modal-save");

    chrome.storage.local.get([STORAGE_KEYS.API_KEY], (result) => {
      if (chrome.runtime.lastError) return;
      input.value = result[STORAGE_KEYS.API_KEY] || "";
      input.focus();
    });

    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeApiKeyModal(overlay);
    });
    cancelBtn.addEventListener("click", () => closeApiKeyModal(overlay));

    saveBtn.addEventListener("click", () => {
      const value = input.value.trim();
      chrome.storage.local.set({ [STORAGE_KEYS.API_KEY]: value }, () => {
        if (chrome.runtime.lastError) {
          status.textContent = "Failed to save.";
          return;
        }
        status.textContent = "Saved.";
        setTimeout(() => closeApiKeyModal(overlay), 600);
      });
    });

    document.addEventListener("keydown", handleModalKeydown);
  }

  // ---- Init -----------------------------------------------------------

  injectCounterWidget();
  loadSettingsAndStart();
})();
