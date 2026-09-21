# Jev X Scanner — Design Spec

## Purpose

A Chrome extension (Manifest V3) for personal use that classifies X/Twitter
posts in real time as the user scrolls, labeling each with one of three
categories so the user can quickly triage their feed:

- **Breaking** — breaking news / urgent or important content
- **Golden Nugget** — valuable, insightful, high-quality content
- **AI Slop** — low-quality, likely AI-generated content

Classification is powered by the Jev API (TypeSafe AI's "System One" model),
called via its `choice()` primitive. A "Jev Judged" badge appears in the
bottom-left corner of each classified post.

## Architecture

No backend server. Three components, all inside the extension:

1. **Content script** (`content/`) — injected on `x.com` / `twitter.com`.
   Observes the timeline DOM, extracts post text + tweet ID, decides when to
   request classification, and renders the badge.
2. **Background service worker** (`background/`) — owns the Jev API key,
   makes the `choice()` call, maintains the in-memory classification cache,
   and responds to content-script requests via `chrome.runtime.onMessage`.
3. **Options page** (`options/`) — lets the user set `TYPESAFE_API_KEY`
   (stored via `chrome.storage.local`), toggle extension on/off, and choose
   the throttle mode (see below).

## Data Flow

1. Content script watches the timeline container with a `MutationObserver`
   for new post nodes (`<article>` elements).
2. Each new post is resolved to a stable tweet ID (parsed from the
   permalink `<a>` / timestamp anchor inside the article — X embeds the
   status ID in that href).
3. Throttle mode (user-toggleable, default **viewport**):
   - **Viewport mode**: an `IntersectionObserver` fires classification only
     when the post scrolls into view.
   - **On-add mode**: classification fires as soon as the post node appears
     in the DOM, regardless of visibility.
4. Content script sends `{tweetId, text}` to the background worker via
   `chrome.runtime.sendMessage`.
5. Background worker:
   - Checks an in-memory `Map<tweetId, Label>` cache (cleared on service
     worker restart / browser session — no persistence needed).
   - On cache miss, calls Jev:
     ```ts
     const response = await client.systemOne({
       state: { post: text },
       questions: {
         label: choice("Classify this X post.", {
           breaking: null,
           golden_nugget: null,
           ai_slop: null,
         }),
       },
     });
     ```
   - Caches `response.answers.label.choice`, replies to the content script.
6. Content script renders the badge in the post's bottom-left corner based
   on the returned label.

## Label Styling

Minimal colored badge, bottom-left corner of each post, small icon + text:

- ⚡ **Breaking** — red accent
- 🪙 **Golden Nugget** — gold/amber accent
- 🤖 **AI Slop** — gray, muted

Badge text reads "Jev Judged: <label>" on hover (title attribute); compact
icon+label shown inline by default.

## Error Handling

- Missing/invalid API key → badge reads "Set API key", links to the
  options page.
- Jev API failure or timeout → one retry, then badge is omitted entirely
  (never blocks scrolling or shows a stuck loading state).
- Extension never modifies or hides post content — labels are purely
  additive.

## Storage

- `chrome.storage.local`: API key, on/off toggle, throttle mode.
- In-memory only: classification cache (per background worker lifetime).

## Testing

This is DOM/extension-heavy with little pure-logic surface. Approach:

- Unit-testable pure functions: tweet-ID extraction from a post node, and
  label → badge-style mapping. Cover these with simple tests.
- Everything else (DOM observation, message passing, live Jev calls)
  verified manually by loading the unpacked extension against real x.com
  and observing behavior in both throttle modes.

## Out of Scope

- No backend/server component.
- No persistent cross-session cache (in-memory only, per spec decision).
- No support for browsers other than Chrome (Manifest V3).
- No analytics/telemetry.
