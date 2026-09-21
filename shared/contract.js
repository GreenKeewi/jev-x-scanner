// Shared contract between content script, background worker, options page,
// and dashboard. Plain JS (JSDoc types) so it can be imported by all of them
// without a build step.
//
// NOTE: content/content.js cannot reliably static-import this module (MV3
// content_scripts don't support "type": "module"), so it keeps its own
// hand-synced inline copy of the constants it needs. If you change anything
// here, update that inline copy too.

/** @typedef {"breaking" | "golden_nugget" | "ai_slop"} Label */

/** @typedef {"viewport" | "on_add"} ThrottleMode */

/**
 * @typedef {{ views: number, likes: number, replies: number, reposts: number }} Engagement
 */

/**
 * @typedef {{
 *   tweetId: string,
 *   url: string,
 *   text: string,
 *   label: Label,
 *   timestamp: number,
 *   engagement: Engagement
 * }} PostRecord
 */

export const LABELS = /** @type {const} */ (["breaking", "golden_nugget", "ai_slop"]);

export const STORAGE_KEYS = {
  API_KEY: "typesafeApiKey",
  ENABLED: "extensionEnabled",
  THROTTLE_MODE: "throttleMode",
  PREFERENCE: "userPreference",
  POST_RECORDS: "postRecords",
};

export const DEFAULT_SETTINGS = {
  [STORAGE_KEYS.ENABLED]: true,
  [STORAGE_KEYS.THROTTLE_MODE]: "viewport",
  [STORAGE_KEYS.PREFERENCE]: "",
};

/** Max number of PostRecord entries kept in STORAGE_KEYS.POST_RECORDS. */
export const MAX_POST_RECORDS = 500;

// Message types exchanged via chrome.runtime.sendMessage / onMessage.
export const MESSAGE_TYPES = {
  CLASSIFY_POST: "CLASSIFY_POST", // content -> background: { tweetId, url, text, engagement }
  OPEN_DASHBOARD: "OPEN_DASHBOARD", // content -> background: { type: "OPEN_DASHBOARD" }
};

/**
 * Request shape for MESSAGE_TYPES.CLASSIFY_POST
 * @typedef {{
 *   type: "CLASSIFY_POST",
 *   tweetId: string,
 *   url: string,
 *   text: string,
 *   engagement: Engagement
 * }} ClassifyPostRequest
 */

/**
 * Response shape for MESSAGE_TYPES.CLASSIFY_POST
 * @typedef {{ ok: true, label: Label } | { ok: false, error: "NO_API_KEY" | "API_ERROR" }} ClassifyPostResponse
 */

/** Badge display metadata per label. Shared so content script and any future UI agree. */
export const LABEL_META = {
  breaking: { icon: "⚡", text: "Breaking", className: "jev-badge-breaking" },
  golden_nugget: { icon: "🪙", text: "Golden Nugget", className: "jev-badge-golden" },
  ai_slop: { icon: "🤖", text: "AI Slop", className: "jev-badge-slop" },
};

/** Path to the dashboard page, relative to the extension root. */
export const DASHBOARD_PATH = "dashboard/dashboard.html";
