# Devin Browser Extension

Chrome extension that lets you trigger Devin sessions straight from any webpage. Select some text, describe the bug, hit submit — the extension grabs the page URL and selection as context and kicks off a Devin session. You get a notification when the PR lands.

Vanilla JS, no frameworks, no build step. Just load it unpacked and go.

## Install

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this folder
3. Pin it to your toolbar

## Setup

First time you open it, there's a quick setup wizard:

1. Paste your Devin API key (it verifies against the API before letting you continue)
2. Add your repos — paste GitHub URLs or type `owner/repo`
3. Done

You can change any of this later from Settings. Sign out brings you back to the wizard.

## Usage

1. Go to a page with a bug or something you want Devin to work on
2. Select relevant text if there is any
3. Click the extension → write what you need → pick a repo → submit
4. Optionally paste console errors if something's broken on the page

The page URL and selected text get bundled into the prompt automatically. There's a "Preview what Devin will see" toggle so you can double-check before sending.

## What it does

**Context capture** — URL and selected text are grabbed automatically. There's also a console errors field with a plain-language guide for people who aren't sure how to open DevTools. If the URL has tokens or passwords in it, you'll see a warning before submitting.

**Session tracking** — Your last 20 sessions show up in the Sessions tab with live status: Running → PR Ready → Done (or Failed). Each one links out to the Devin session and the GitHub PR. Timestamps show relative time ("2m ago", "1h ago"). Older sessions get dropped automatically when you hit 20.

**Notifications** — You get a browser notification when a PR first appears, when the session finishes, when a PR gets merged, or if something fails. Click the notification to jump straight to the PR or the Devin session. There's also a red badge count on the extension icon that clears when you open the popup.

**Polling** — Background polling checks for status changes on a 15s → 30s → 1m → 2m backoff schedule using `chrome.alarms` (so it survives service worker restarts). If Chrome restarts or the extension reloads, polling picks back up for any active sessions. Sessions time out after 24 hours.

**PR merge detection** — Even if Devin still says "working", the extension checks GitHub's public API to see if the PR has been merged and marks it as Done. Works for public GitHub repos (60 req/hour unauthenticated).

**Idle lock** — If you haven't used it in 30 minutes, you have to click "Unlock" before submitting. Just a guard against accidental use on a shared machine.

**Session persistence** — Your session history sticks around even if you sign out and back in with a different API key.

## Security

- API key lives in `chrome.storage.local` (Chrome's sandbox). Shown as `••••••••last4` in settings
- URLs with tokens/passwords/secrets get flagged before sending
- Notification click URLs are checked against an allowlist (github.com, app.devin.ai, etc.) and must be HTTPS
- All user content is HTML-escaped before rendering — descriptions, URLs, repo names all go through `escapeHtml()` and `safeHref()`
- Background worker only accepts messages from the extension's own runtime ID
- Content script is injected on-demand, not persistent — it literally just reads `window.getSelection()` and returns

## Error Handling

API errors get a friendly message with an expandable "Show details" section:

| Error | What you see |
|---|---|
| Network error | "Couldn't reach Devin. Check your internet connection." |
| 401 | "Invalid API key. Check your settings." |
| 429 | "Too many requests. Try again in a moment." |
| 5xx | "Devin is having issues. Try again later." |
| Other | "Something went wrong." |

## Architecture

| Component | Files | What it does |
|---|---|---|
| Popup | `popup/` | Main UI — task form, session list, setup wizard |
| Background | `background/background.js` | Service worker — API calls, polling, notifications, badge |
| Content | `content/content.js` | On-demand script to grab selected text |
| Options | `options/` | Settings — API key, repos, data management |

```
User opens popup
  → content.js grabs selected text (injected on demand)
  → popup.js shows the form with URL + selection pre-filled
  → User writes description, picks repo, submits
  → message goes to background.js
  → background.js hits Devin API, starts polling via chrome.alarms
  → PR shows up → "PR Ready" notification + badge
  → Session finishes → "Done" notification + badge
  → Click notification → opens the PR on GitHub
```

## APIs

**Devin** — [v1 API](https://docs.devin.ai/api-reference/overview): `POST /sessions` to create, `GET /sessions/{id}` to poll. Auth via `Bearer` token. Also hits `GET /sessions?limit=1` to verify the API key during setup.

**GitHub** — Public REST API (unauthenticated, 60/hr): `GET /repos/{owner}/{repo}/pulls/{number}` to check if a PR has been merged. Only works for github.com URLs.
