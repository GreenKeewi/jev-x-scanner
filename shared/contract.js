// Shared contract between content script, background worker, and options page.
// Plain JS (JSDoc types) so it can be imported by all three without a build step.

/** @typedef {"breaking" | "golden_nugget" | "ai_slop"} Label */

/** @typedef {"viewport" | "on_add"} ThrottleMode */

export const LABELS = /** @type {const} */ (["breaking", "golden_nugget", "ai_slop"]);

export const STORAGE_KEYS = {
  API_KEY: "typesafeApiKey",
  ENABLED: "extensionEnabled",
  THROTTLE_MODE: "throttleMode",
};

export const DEFAULT_SETTINGS = {
  [STORAGE_KEYS.ENABLED]: true,
  [STORAGE_KEYS.THROTTLE_MODE]: "viewport",
};

// Message types exchanged via chrome.runtime.sendMessage / onMessage.
export const MESSAGE_TYPES = {
  CLASSIFY_POST: "CLASSIFY_POST", // content -> background: { tweetId, text }
};

/**
 * Request shape for MESSAGE_TYPES.CLASSIFY_POST
 * @typedef {{ type: "CLASSIFY_POST", tweetId: string, text: string }} ClassifyPostRequest
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
