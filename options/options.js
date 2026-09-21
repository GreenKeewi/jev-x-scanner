import { STORAGE_KEYS, DEFAULT_SETTINGS } from "../shared/contract.js";

const apiKeyInput = document.getElementById("api-key");
const toggleVisibilityBtn = document.getElementById("toggle-visibility");
const saveKeyBtn = document.getElementById("save-key");
const keyStatus = document.getElementById("key-status");
const enabledToggle = document.getElementById("enabled-toggle");
const throttleViewport = document.getElementById("throttle-viewport");
const throttleOnAdd = document.getElementById("throttle-on-add");

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

async function loadSettings() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.API_KEY,
    STORAGE_KEYS.ENABLED,
    STORAGE_KEYS.THROTTLE_MODE,
  ]);

  apiKeyInput.value = stored[STORAGE_KEYS.API_KEY] ?? "";
  enabledToggle.checked =
    stored[STORAGE_KEYS.ENABLED] ?? DEFAULT_SETTINGS[STORAGE_KEYS.ENABLED];
  setThrottleRadio(
    stored[STORAGE_KEYS.THROTTLE_MODE] ?? DEFAULT_SETTINGS[STORAGE_KEYS.THROTTLE_MODE]
  );
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

loadSettings();
