import { STORAGE_KEYS, LABEL_META } from "../shared/contract.js";

const tbody = document.getElementById("posts-tbody");
const emptyState = document.getElementById("empty-state");
const tableSection = document.getElementById("table-section");
const summaryEl = document.getElementById("summary");
const filterBtns = Array.from(document.querySelectorAll(".filter-btn"));
const sortSelect = document.getElementById("sort-select");

let allRecords = [];
let currentFilter = "all";
let currentSort = "newest";

/**
 * Format a timestamp (ms since epoch) as a short relative time string.
 * Pure helper, no external dependencies.
 * @param {number} timestamp
 * @param {number} [now]
 * @returns {string}
 */
export function formatRelativeTime(timestamp, now = Date.now()) {
  const diffMs = Math.max(0, now - timestamp);
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const month = Math.floor(day / 30);
  if (month < 12) return `${month}mo ago`;
  const year = Math.floor(month / 12);
  return `${year}y ago`;
}

/**
 * @param {number} n
 * @returns {string}
 */
function formatCompactNumber(n) {
  const value = Number.isFinite(n) ? n : 0;
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value % 1000 >= 100 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

/**
 * @param {import("../shared/contract.js").Engagement} engagement
 * @returns {number}
 */
function totalEngagement(engagement) {
  if (!engagement) return 0;
  const { views = 0, likes = 0, replies = 0, reposts = 0 } = engagement;
  return views + likes + replies + reposts;
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Validates a scraped post URL before rendering it into an href attribute.
 * Only allows https links to x.com/twitter.com; anything else (including
 * javascript: URLs) falls back to "#".
 * @param {string} url
 * @returns {string}
 */
function safeUrl(url) {
  try {
    const parsed = new URL(url);
    const allowedHosts = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com"]);
    if (parsed.protocol === "https:" && allowedHosts.has(parsed.hostname)) {
      return parsed.href;
    }
  } catch {
    // fall through to "#"
  }
  return "#";
}

function renderSummary(records) {
  const counts = { breaking: 0, golden_nugget: 0, ai_slop: 0 };
  for (const record of records) {
    if (counts[record.label] !== undefined) counts[record.label] += 1;
  }
  summaryEl.textContent =
    `${records.length} post${records.length === 1 ? "" : "s"} classified — ` +
    `${LABEL_META.breaking.icon} ${counts.breaking} Breaking · ` +
    `${LABEL_META.golden_nugget.icon} ${counts.golden_nugget} Golden Nugget · ` +
    `${LABEL_META.ai_slop.icon} ${counts.ai_slop} Slop`;
}

function getVisibleRecords() {
  let records = allRecords;
  if (currentFilter !== "all") {
    records = records.filter((r) => r.label === currentFilter);
  }
  const sorted = [...records];
  if (currentSort === "engagement") {
    sorted.sort((a, b) => totalEngagement(b.engagement) - totalEngagement(a.engagement));
  } else {
    sorted.sort((a, b) => b.timestamp - a.timestamp);
  }
  return sorted;
}

function renderTable() {
  const records = getVisibleRecords();

  if (allRecords.length === 0) {
    tbody.innerHTML = "";
    emptyState.hidden = false;
    tableSection.querySelector("table").hidden = true;
    return;
  }

  emptyState.hidden = true;
  tableSection.querySelector("table").hidden = false;

  if (records.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state">No posts match this filter.</td></tr>`;
    return;
  }

  const now = Date.now();
  tbody.innerHTML = records
    .map((record) => {
      const meta = LABEL_META[record.label] ?? { icon: "", text: record.label, className: "" };
      const isGolden = record.label === "golden_nugget";
      const engagement = record.engagement ?? { views: 0, likes: 0, replies: 0, reposts: 0 };
      const snippet = escapeHtml(record.text || "");
      const rowClass = isGolden ? "row-golden" : "";

      return `
        <tr class="${rowClass}">
          <td>
            <span class="badge ${meta.className}" title="Jev Judged: ${escapeHtml(meta.text)}">
              ${meta.icon} ${escapeHtml(meta.text)}
            </span>
            ${isGolden ? `<span class="reply-tag">💬 Good to reply</span>` : ""}
          </td>
          <td><span class="post-text" title="${snippet}">${snippet}</span></td>
          <td><a class="post-link" href="${escapeHtml(safeUrl(record.url))}" target="_blank" rel="noopener noreferrer">Open ↗</a></td>
          <td class="engagement">
            👁 ${formatCompactNumber(engagement.views)} ·
            ❤ ${formatCompactNumber(engagement.likes)} ·
            💬 ${formatCompactNumber(engagement.replies)} ·
            🔁 ${formatCompactNumber(engagement.reposts)}
          </td>
          <td class="time-cell" title="${new Date(record.timestamp).toLocaleString()}">
            ${formatRelativeTime(record.timestamp, now)}
          </td>
        </tr>
      `;
    })
    .join("");
}

function renderAll() {
  renderSummary(allRecords);
  renderTable();
}

async function loadRecords() {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.POST_RECORDS]);
  allRecords = stored[STORAGE_KEYS.POST_RECORDS] ?? [];
  renderAll();
}

filterBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    currentFilter = btn.dataset.filter;
    filterBtns.forEach((b) => b.classList.toggle("active", b === btn));
    renderTable();
  });
});

sortSelect.addEventListener("change", () => {
  currentSort = sortSelect.value;
  renderTable();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (!(STORAGE_KEYS.POST_RECORDS in changes)) return;
  allRecords = changes[STORAGE_KEYS.POST_RECORDS].newValue ?? [];
  renderAll();
});

loadRecords();
