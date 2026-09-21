import { STORAGE_KEYS, DEFAULT_SETTINGS, DEFAULT_CRITERIA } from "../shared/contract.js";

const apiKeyInput = document.getElementById("api-key");
const toggleVisibilityBtn = document.getElementById("toggle-visibility");
const saveKeyBtn = document.getElementById("save-key");
const keyStatus = document.getElementById("key-status");
const enabledToggle = document.getElementById("enabled-toggle");
const throttleViewport = document.getElementById("throttle-viewport");
const throttleOnAdd = document.getElementById("throttle-on-add");
const preferenceInput = document.getElementById("preference");
const preferenceStatus = document.getElementById("preference-status");
const sessionLimitInput = document.getElementById("session-limit");
const autoReloadToggle = document.getElementById("auto-reload-toggle");
const criteriaBreakingInput = document.getElementById("criteria-breaking");
const criteriaGoldenInput = document.getElementById("criteria-golden");
const criteriaSlopInput = document.getElementById("criteria-slop");
const saveCriteriaBtn = document.getElementById("save-criteria");
const resetCriteriaBtn = document.getElementById("reset-criteria");
const criteriaStatus = document.getElementById("criteria-status");

let statusTimer = null;

function showStatus(message, isError = false) {
  keyStatus.textContent = message;
  keyStatus.classList.toggle("error", isError);
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    keyStatus.textContent = "";
  }, 2500);
}

function setThrottleRadio(mode) {
  throttleViewport.checked = mode === "viewport";
  throttleOnAdd.checked = mode === "on_add";
}

function setCriteriaInputs(criteria) {
  criteriaBreakingInput.value = criteria.breaking ?? DEFAULT_CRITERIA.breaking;
  criteriaGoldenInput.value = criteria.golden_nugget ?? DEFAULT_CRITERIA.golden_nugget;
  criteriaSlopInput.value = criteria.ai_slop ?? DEFAULT_CRITERIA.ai_slop;
}

async function loadSettings() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.API_KEY,
    STORAGE_KEYS.ENABLED,
    STORAGE_KEYS.THROTTLE_MODE,
    STORAGE_KEYS.PREFERENCE,
    STORAGE_KEYS.CRITERIA,
    STORAGE_KEYS.SESSION_LIMIT,
    STORAGE_KEYS.AUTO_RELOAD,
  ]);

  apiKeyInput.value = stored[STORAGE_KEYS.API_KEY] ?? "";
  enabledToggle.checked =
    stored[STORAGE_KEYS.ENABLED] ?? DEFAULT_SETTINGS[STORAGE_KEYS.ENABLED];
  setThrottleRadio(
    stored[STORAGE_KEYS.THROTTLE_MODE] ?? DEFAULT_SETTINGS[STORAGE_KEYS.THROTTLE_MODE]
  );
  preferenceInput.value =
    stored[STORAGE_KEYS.PREFERENCE] ?? DEFAULT_SETTINGS[STORAGE_KEYS.PREFERENCE];
  setCriteriaInputs(stored[STORAGE_KEYS.CRITERIA] ?? DEFAULT_CRITERIA);
  sessionLimitInput.value =
    stored[STORAGE_KEYS.SESSION_LIMIT] ?? DEFAULT_SETTINGS[STORAGE_KEYS.SESSION_LIMIT];
  autoReloadToggle.checked =
    stored[STORAGE_KEYS.AUTO_RELOAD] ?? DEFAULT_SETTINGS[STORAGE_KEYS.AUTO_RELOAD];
}

toggleVisibilityBtn.addEventListener("click", () => {
  const isPassword = apiKeyInput.type === "password";
  apiKeyInput.type = isPassword ? "text" : "password";
  toggleVisibilityBtn.textContent = isPassword ? "Hide" : "Show";
});

saveKeyBtn.addEventListener("click", async () => {
  const value = apiKeyInput.value.trim();
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.API_KEY]: value });
    showStatus("API key saved.");
  } catch (err) {
    showStatus("Failed to save API key.", true);
  }
});

enabledToggle.addEventListener("change", async () => {
  await chrome.storage.local.set({
    [STORAGE_KEYS.ENABLED]: enabledToggle.checked,
  });
});

[throttleViewport, throttleOnAdd].forEach((radio) => {
  radio.addEventListener("change", async () => {
    if (!radio.checked) return;
    await chrome.storage.local.set({
      [STORAGE_KEYS.THROTTLE_MODE]: radio.value,
    });
  });
});

let preferenceSaveTimer = null;
preferenceInput.addEventListener("input", () => {
  if (preferenceSaveTimer) clearTimeout(preferenceSaveTimer);
  preferenceSaveTimer = setTimeout(async () => {
    await chrome.storage.local.set({
      [STORAGE_KEYS.PREFERENCE]: preferenceInput.value.trim(),
    });
    preferenceStatus.textContent = "Saved.";
    preferenceStatus.classList.remove("error");
    setTimeout(() => {
      preferenceStatus.textContent = "";
    }, 1500);
  }, 500);
});

sessionLimitInput.addEventListener("change", async () => {
  const value = Math.max(1, parseInt(sessionLimitInput.value, 10) || DEFAULT_SETTINGS[STORAGE_KEYS.SESSION_LIMIT]);
  sessionLimitInput.value = value;
  await chrome.storage.local.set({ [STORAGE_KEYS.SESSION_LIMIT]: value });
});

autoReloadToggle.addEventListener("change", async () => {
  await chrome.storage.local.set({
    [STORAGE_KEYS.AUTO_RELOAD]: autoReloadToggle.checked,
  });
});

function showCriteriaStatus(message, isError = false) {
  criteriaStatus.textContent = message;
  criteriaStatus.classList.toggle("error", isError);
  setTimeout(() => {
    criteriaStatus.textContent = "";
  }, 2000);
}

saveCriteriaBtn.addEventListener("click", async () => {
  const criteria = {
    breaking: criteriaBreakingInput.value.trim(),
    golden_nugget: criteriaGoldenInput.value.trim(),
    ai_slop: criteriaSlopInput.value.trim(),
  };
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.CRITERIA]: criteria });
    showCriteriaStatus("Criteria saved.");
  } catch (err) {
    showCriteriaStatus("Failed to save criteria.", true);
  }
});

resetCriteriaBtn.addEventListener("click", async () => {
  setCriteriaInputs(DEFAULT_CRITERIA);
  await chrome.storage.local.set({ [STORAGE_KEYS.CRITERIA]: DEFAULT_CRITERIA });
  showCriteriaStatus("Reset to defaults.");
});

loadSettings();
