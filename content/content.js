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
};

const DEFAULT_SETTINGS = {
  [STORAGE_KEYS.ENABLED]: true,
  [STORAGE_KEYS.THROTTLE_MODE]: "viewport",
};

const MESSAGE_TYPES = {
  CLASSIFY_POST: "CLASSIFY_POST",
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

  /** tweetIds we've already requested classification for (never re-request). */
  const requestedTweetIds = new Set();

  /** article element -> its IntersectionObserver, so we can disconnect on trigger. */
  const articleObservers = new WeakMap();

  /** Root MutationObserver watching the timeline for new posts. */
  let timelineObserver = null;

  // ---- Settings load + live updates --------------------------------------

  function loadSettingsAndStart() {
    chrome.storage.local.get(
      [STORAGE_KEYS.ENABLED, STORAGE_KEYS.THROTTLE_MODE],
      (result) => {
        enabled =
          result[STORAGE_KEYS.ENABLED] !== undefined
            ? result[STORAGE_KEYS.ENABLED]
            : DEFAULT_SETTINGS[STORAGE_KEYS.ENABLED];
        throttleMode =
          result[STORAGE_KEYS.THROTTLE_MODE] || DEFAULT_SETTINGS[STORAGE_KEYS.THROTTLE_MODE];

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
      if (enabled) {
        startObserving();
      } else {
        stopObserving();
      }
    }

    if (Object.prototype.hasOwnProperty.call(changes, STORAGE_KEYS.THROTTLE_MODE)) {
      throttleMode =
        changes[STORAGE_KEYS.THROTTLE_MODE].newValue || DEFAULT_SETTINGS[STORAGE_KEYS.THROTTLE_MODE];
    }
  });

  // ---- Timeline observation -----------------------------------------------

  function startObserving() {
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
    if (!enabled) return;
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
    requestedTweetIds.add(tweetId);

    chrome.runtime.sendMessage(
      { type: MESSAGE_TYPES.CLASSIFY_POST, tweetId, text },
      (response) => {
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

  // ---- Init -----------------------------------------------------------

  loadSettingsAndStart();
})();
