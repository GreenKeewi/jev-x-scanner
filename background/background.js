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

import { STORAGE_KEYS, MESSAGE_TYPES, LABELS } from "../shared/contract.js";

/** @typedef {import("../shared/contract.js").Label} Label */

const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const TYPESAFE_MODEL = "jev-latest";
const REQUEST_TIMEOUT_MS = 8000;

const CLASSIFY_INSTRUCTIONS =
  "Classify this X/Twitter post as Breaking, Golden Nugget, or AI Slop.";

/** @type {Record<Label, string>} */
const CHOICE_CRITERIA = {
  breaking: "Breaking news, urgent or time-sensitive, important developing information.",
  golden_nugget: "Valuable, insightful, high-quality content worth reading closely.",
  ai_slop: "Low-quality, generic, or likely AI-generated filler content.",
};

/** In-memory cache: tweetId -> Label. Cleared on service worker restart. */
const classificationCache = new Map();

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
 * Performs a single fetch to the TypeSafe systemOne REST endpoint with a
 * timeout, and extracts the resulting Label.
 * @param {string} apiKey
 * @param {string} text
 * @returns {Promise<Label>}
 */
async function callJevOnce(apiKey, text) {
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
        state: { post: text },
        questions: {
          label: {
            type: "choice",
            instructions: CLASSIFY_INSTRUCTIONS,
            criteria: CHOICE_CRITERIA,
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
 * @returns {Promise<Label>}
 */
async function classifyWithRetry(apiKey, text) {
  try {
    return await callJevOnce(apiKey, text);
  } catch (firstError) {
    return await callJevOnce(apiKey, text);
  }
}

/**
 * Handles a single CLASSIFY_POST request end-to-end.
 * @param {{ tweetId: string, text: string }} request
 * @returns {Promise<import("../shared/contract.js").ClassifyPostResponse>}
 */
async function handleClassifyPost(request) {
  const { tweetId, text } = request;

  const cached = classificationCache.get(tweetId);
  if (cached) {
    return { ok: true, label: cached };
  }

  const apiKey = await getApiKey();
  if (!apiKey) {
    return { ok: false, error: "NO_API_KEY" };
  }

  try {
    const label = await classifyWithRetry(apiKey, text);
    classificationCache.set(tweetId, label);
    return { ok: true, label };
  } catch (error) {
    return { ok: false, error: "API_ERROR" };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== MESSAGE_TYPES.CLASSIFY_POST) {
    return false;
  }

  handleClassifyPost(message)
    .then(sendResponse)
    .catch(() => sendResponse({ ok: false, error: "API_ERROR" }));

  // Keep the message channel open for the async sendResponse above.
  return true;
});
