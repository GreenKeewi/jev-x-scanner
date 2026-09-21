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
  THROTTLE_MODE: "throttleMode",
  PREFERENCE: "userPreference",
  POST_RECORDS: "postRecords",
  CRITERIA: "labelCriteria",
  SESSION_LIMIT: "sessionLimit",
  AUTO_RELOAD: "autoReloadOnLimit",
};

const DEFAULT_SETTINGS = {
  [STORAGE_KEYS.ENABLED]: true,
  [STORAGE_KEYS.THROTTLE_MODE]: "viewport",
  [STORAGE_KEYS.PREFERENCE]: "",
  [STORAGE_KEYS.SESSION_LIMIT]: 200,
  [STORAGE_KEYS.AUTO_RELOAD]: false,
};

const MESSAGE_TYPES = {
  CLASSIFY_POST: "CLASSIFY_POST",
  OPEN_DASHBOARD: "OPEN_DASHBOARD",
};

const LABEL_META = {
  breaking: { icon: "⚡", text: "Breaking", className: "jev-badge-breaking" },
  golden_nugget: { icon: "🪙", text: "Golden Nugget", className: "jev-badge-golden" },
  ai_slop: { icon: "🤖", text: "AI Slop", className: "jev-badge-slop" },
};

(function () {
  "use strict";

  // ---- State -------------------------------------------------------------

  let enabled = DEFAULT_SETTINGS[STORAGE_KEYS.ENABLED];
  let throttleMode = DEFAULT_SETTINGS[STORAGE_KEYS.THROTTLE_MODE];
  let sessionLimit = DEFAULT_SETTINGS[STORAGE_KEYS.SESSION_LIMIT];
  let autoReload = DEFAULT_SETTINGS[STORAGE_KEYS.AUTO_RELOAD];

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
  /** true once the user clicks the Stop button; independent of `enabled`. */
  let manuallyStopped = false;

  // ---- Settings load + live updates --------------------------------------

  function loadSettingsAndStart() {
    chrome.storage.local.get(
      [STORAGE_KEYS.ENABLED, STORAGE_KEYS.THROTTLE_MODE, STORAGE_KEYS.SESSION_LIMIT, STORAGE_KEYS.AUTO_RELOAD],
      (result) => {
        enabled =
          result[STORAGE_KEYS.ENABLED] !== undefined
            ? result[STORAGE_KEYS.ENABLED]
            : DEFAULT_SETTINGS[STORAGE_KEYS.ENABLED];
        throttleMode =
          result[STORAGE_KEYS.THROTTLE_MODE] || DEFAULT_SETTINGS[STORAGE_KEYS.THROTTLE_MODE];
        sessionLimit =
          result[STORAGE_KEYS.SESSION_LIMIT] || DEFAULT_SETTINGS[STORAGE_KEYS.SESSION_LIMIT];
        autoReload =
          result[STORAGE_KEYS.AUTO_RELOAD] ?? DEFAULT_SETTINGS[STORAGE_KEYS.AUTO_RELOAD];

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
      if (enabled && !manuallyStopped && !limitReached) {
        startObserving();
      } else {
        stopObserving();
      }
    }

    if (Object.prototype.hasOwnProperty.call(changes, STORAGE_KEYS.THROTTLE_MODE)) {
      throttleMode =
        changes[STORAGE_KEYS.THROTTLE_MODE].newValue || DEFAULT_SETTINGS[STORAGE_KEYS.THROTTLE_MODE];
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
    if (limitReached || manuallyStopped) return;
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
    if (!enabled || limitReached || manuallyStopped) return;
    if (article.dataset.jevProcessed === "1") return;

    const tweetId = extractTweetId(article);
    if (!tweetId) return; // can't identify post, skip

    article.dataset.jevProcessed = "1";
    article.dataset.jevTweetId = tweetId;

    const text = extractText(article);
    if (!text) return; // image/video-only post, nothing to classify

    if (throttleMode === "on_add") {
      requestClassification(article, tweetId, text);
    } else {
      observeForViewport(article, tweetId, text);
    }
  }

  function observeForViewport(article, tweetId, text) {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            if (limitReached || manuallyStopped) {
              observer.disconnect();
              articleObservers.delete(article);
              return;
            }
            requestClassification(article, tweetId, text);
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

  function requestClassification(article, tweetId, text) {
    if (requestedTweetIds.has(tweetId)) return;
    if (limitReached || manuallyStopped) return;
    requestedTweetIds.add(tweetId);

    sessionClassifiedCount += 1;
    inFlightCount += 1;
    updateSessionUi();

    if (sessionClassifiedCount >= sessionLimit) {
      onLimitReached();
    }

    const engagement = extractEngagement(article);
    const url = extractPostUrl(article, tweetId);

    chrome.runtime.sendMessage(
      { type: MESSAGE_TYPES.CLASSIFY_POST, tweetId, url, text, engagement },
      (response) => {
        inFlightCount = Math.max(0, inFlightCount - 1);
        updateSessionUi();

        if (chrome.runtime.lastError) {
          // Extension context gone / background unreachable — omit badge.
          return;
        }
        renderBadgeResult(article, response);
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
      chrome.runtime.openOptionsPage();
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
  let progressBarFillEl = null;
  let progressWrapEl = null;
  let stopButtonEl = null;
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
    if (progressBarFillEl) {
      const pct = sessionLimit > 0 ? Math.min(100, (sessionClassifiedCount / sessionLimit) * 100) : 0;
      progressBarFillEl.style.width = `${pct}%`;
    }
    if (progressWrapEl) {
      progressWrapEl.classList.toggle("jev-progress-active", inFlightCount > 0);
      progressWrapEl.title = `${sessionClassifiedCount} / ${sessionLimit} classified this session${
        inFlightCount > 0 ? ` · ${inFlightCount} in flight` : ""
      }`;
    }
    if (stopButtonEl) {
      stopButtonEl.textContent = manuallyStopped ? "▶" : "⏸";
      stopButtonEl.title = manuallyStopped ? "Resume scanning" : "Stop scanning";
    }
  }

  function toggleManualStop() {
    manuallyStopped = !manuallyStopped;
    if (manuallyStopped) {
      stopObserving();
    } else if (enabled && !limitReached) {
      startObserving();
    }
    updateSessionUi();
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

    stopButtonEl = document.createElement("button");
    stopButtonEl.type = "button";
    stopButtonEl.className = "jev-counter-stop-btn";
    stopButtonEl.title = "Stop scanning";
    stopButtonEl.textContent = "⏸";
    stopButtonEl.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleManualStop();
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
    topRow.appendChild(stopButtonEl);
    topRow.appendChild(keyButtonEl);

    progressWrapEl = document.createElement("div");
    progressWrapEl.className = "jev-progress-wrap";
    progressBarFillEl = document.createElement("div");
    progressBarFillEl.className = "jev-progress-fill";
    progressWrapEl.appendChild(progressBarFillEl);

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
    widget.appendChild(progressWrapEl);
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
