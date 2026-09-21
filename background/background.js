// Background service worker (Manifest V3, type: "module").
// Owns the Jev (TypeSafe AI "System One") API key, maintains the in-memory
// classification cache, and answers CLASSIFY_POST requests from the content
// script.
//
// TypeSafe's official SDK (`@typesafe-ai/sdk`, `TypeSafeClient` + `choice`)
// is an npm package and cannot be `import`ed directly into an unbundled MV3
// service worker. Instead we call TypeSafe's REST API directly with `fetch`,
// replicating what `client.systemOne({ state, questions: { label: choice(...) } })`
// does under the hood. See REST shape notes at the bottom of this file.

import {
  STORAGE_KEYS,
  MESSAGE_TYPES,
  LABELS,
  MAX_POST_RECORDS,
  DASHBOARD_PATH,
  DEFAULT_CRITERIA,
} from "../shared/contract.js";

/** @typedef {import("../shared/contract.js").Label} Label */
/** @typedef {import("../shared/contract.js").Engagement} Engagement */
/** @typedef {import("../shared/contract.js").PostRecord} PostRecord */

const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const TYPESAFE_MODEL = "jev-latest";
const REQUEST_TIMEOUT_MS = 8000;

const CLASSIFY_INSTRUCTIONS =
  "Classify this X/Twitter post as Breaking, Golden Nugget, or AI Slop.";

/** In-memory cache: tweetId -> Label. Hydrated from storage on worker startup. */
const classificationCache = new Map();

/**
 * Hydrates the in-memory classification cache from the persisted
 * PostRecord array in chrome.storage.local. Runs once at module load
 * (service worker startup).
 * @returns {Promise<void>}
 */
async function hydrateCacheFromStorage() {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEYS.POST_RECORDS);
    /** @type {PostRecord[]} */
    const records = Array.isArray(result[STORAGE_KEYS.POST_RECORDS])
      ? result[STORAGE_KEYS.POST_RECORDS]
      : [];
    for (const record of records) {
      if (record && typeof record.tweetId === "string" && LABELS.includes(record.label)) {
        classificationCache.set(record.tweetId, record.label);
      }
    }
  } catch (error) {
    // Non-fatal: worst case, cache starts empty and re-hydrates via
    // classifications as the user scrolls.
  }
}

const hydrationPromise = hydrateCacheFromStorage();

/**
 * Reads the TypeSafe/Jev API key from chrome.storage.local.
 * @returns {Promise<string | undefined>}
 */
async function getApiKey() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.API_KEY);
  const key = result[STORAGE_KEYS.API_KEY];
  return typeof key === "string" && key.length > 0 ? key : undefined;
}

/**
 * Reads the user's stated preference text from chrome.storage.local.
 * Empty/missing is treated as "no preference set".
 * @returns {Promise<string>}
 */
async function getPreference() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.PREFERENCE);
  const preference = result[STORAGE_KEYS.PREFERENCE];
  return typeof preference === "string" ? preference.trim() : "";
}

/**
 * Reads the user-editable criteria overrides from chrome.storage.local.
 * Any label missing/blank in the override falls back to DEFAULT_CRITERIA.
 * @returns {Promise<Record<Label, string>>}
 */
async function getCriteria() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.CRITERIA);
  const stored = result[STORAGE_KEYS.CRITERIA];
  /** @type {Record<Label, string>} */
  const criteria = { ...DEFAULT_CRITERIA };
  if (stored && typeof stored === "object") {
    for (const label of LABELS) {
      if (typeof stored[label] === "string" && stored[label].trim()) {
        criteria[label] = stored[label].trim();
      }
    }
  }
  return criteria;
}

/**
 * Builds the golden_nugget criteria description, appending the user's
 * stated preference when one is set.
 * @param {Record<Label, string>} baseCriteria
 * @param {string} preference
 * @returns {Record<Label, string>}
 */
function buildChoiceCriteria(baseCriteria, preference) {
  if (!preference) {
    return baseCriteria;
  }
  return {
    ...baseCriteria,
    golden_nugget: `${baseCriteria.golden_nugget} The user is specifically interested in: "${preference}".`,
  };
}

/**
 * Reads the persisted PostRecord array, removes any existing record with
 * the same tweetId, appends the new record, and caps the array to the
 * most recent MAX_POST_RECORDS entries (dropping oldest).
 * @param {PostRecord} record
 * @returns {Promise<void>}
 */
async function persistPostRecord(record) {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEYS.POST_RECORDS);
    /** @type {PostRecord[]} */
    const existing = Array.isArray(result[STORAGE_KEYS.POST_RECORDS])
      ? result[STORAGE_KEYS.POST_RECORDS]
      : [];

    const deduped = existing.filter((r) => r && r.tweetId !== record.tweetId);
    deduped.push(record);

    const capped =
      deduped.length > MAX_POST_RECORDS ? deduped.slice(deduped.length - MAX_POST_RECORDS) : deduped;

    await chrome.storage.local.set({ [STORAGE_KEYS.POST_RECORDS]: capped });
  } catch (error) {
    // Non-fatal: classification already succeeded and was returned to the
    // content script; losing the persisted record just means it won't show
    // up in the dashboard/counter.
  }
}

/**
 * Performs a single fetch to the TypeSafe systemOne REST endpoint with a
 * timeout, and extracts the resulting Label.
 * @param {string} apiKey
 * @param {string} text
 * @param {Engagement} engagement
 * @param {Record<Label, string>} baseCriteria
 * @param {string} preference
 * @returns {Promise<Label>}
 */
async function callJevOnce(apiKey, text, engagement, baseCriteria, preference) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(TYPESAFE_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: TYPESAFE_MODEL,
        state: { post: text, engagement },
        questions: {
          label: {
            type: "choice",
            instructions: CLASSIFY_INSTRUCTIONS,
            criteria: buildChoiceCriteria(baseCriteria, preference),
          },
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`TypeSafe API responded with status ${response.status}`);
    }

    /** @type {{ answers?: { label?: { choice?: string } } }} */
    const data = await response.json();
    const choice = data?.answers?.label?.choice;

    if (!choice || !LABELS.includes(/** @type {Label} */ (choice))) {
      throw new Error(`Unexpected/missing choice in TypeSafe response: ${JSON.stringify(data)}`);
    }

    return /** @type {Label} */ (choice);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Calls the Jev API with one retry on failure.
 * @param {string} apiKey
 * @param {string} text
 * @param {Engagement} engagement
 * @param {Record<Label, string>} baseCriteria
 * @param {string} preference
 * @returns {Promise<Label>}
 */
async function classifyWithRetry(apiKey, text, engagement, baseCriteria, preference) {
  try {
    return await callJevOnce(apiKey, text, engagement, baseCriteria, preference);
  } catch (firstError) {
    return await callJevOnce(apiKey, text, engagement, baseCriteria, preference);
  }
}

/** @type {Engagement} */
const DEFAULT_ENGAGEMENT = { views: 0, likes: 0, replies: 0, reposts: 0 };

/**
 * Handles a single CLASSIFY_POST request end-to-end.
 * @param {import("../shared/contract.js").ClassifyPostRequest} request
 * @returns {Promise<import("../shared/contract.js").ClassifyPostResponse>}
 */
async function handleClassifyPost(request) {
  const { tweetId, url, text, engagement } = request;
  const safeEngagement = engagement && typeof engagement === "object" ? engagement : DEFAULT_ENGAGEMENT;

  await hydrationPromise;

  const cached = classificationCache.get(tweetId);
  if (cached) {
    return { ok: true, label: cached };
  }

  const apiKey = await getApiKey();
  if (!apiKey) {
    return { ok: false, error: "NO_API_KEY" };
  }

  try {
    const [preference, baseCriteria] = await Promise.all([getPreference(), getCriteria()]);
    const label = await classifyWithRetry(apiKey, text, safeEngagement, baseCriteria, preference);
    classificationCache.set(tweetId, label);

    /** @type {PostRecord} */
    const record = {
      tweetId,
      url,
      text,
      label,
      timestamp: Date.now(),
      engagement: safeEngagement,
    };
    await persistPostRecord(record);

    return { ok: true, label };
  } catch (error) {
    return { ok: false, error: "API_ERROR" };
  }
}

/**
 * Opens the dashboard page as a new tab, or focuses/reloads-into-view an
 * already-open dashboard tab rather than spawning duplicates.
 * @returns {Promise<void>}
 */
async function openOrFocusDashboard() {
  const dashboardUrl = chrome.runtime.getURL(DASHBOARD_PATH);
  const matches = await chrome.tabs.query({ url: dashboardUrl });

  if (matches.length > 0) {
    const [existing] = matches;
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId !== undefined) {
      await chrome.windows.update(existing.windowId, { focused: true });
    }
    return;
  }

  await chrome.tabs.create({ url: dashboardUrl });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) {
    return false;
  }

  if (message.type === MESSAGE_TYPES.CLASSIFY_POST) {
    handleClassifyPost(message)
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, error: "API_ERROR" }));

    // Keep the message channel open for the async sendResponse above.
    return true;
  }

  if (message.type === MESSAGE_TYPES.OPEN_DASHBOARD) {
    openOrFocusDashboard();
    return false;
  }

  return false;
});

chrome.action.onClicked.addListener(() => {
  openOrFocusDashboard();
});
