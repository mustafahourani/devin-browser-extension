# Devin Chrome Extension — Specification

## Overview

A Chrome extension (Manifest V3) that lets you trigger Devin AI sessions from any webpage. You describe a bug or task in a popup, the extension automatically captures page context (URL, selected text), and fires off a Devin session via their API. When a PR is created, you get a browser notification. No frameworks — vanilla HTML/CSS/JS only.

---

## Architecture

### Extension Components

| Component | File(s) | Purpose |
|---|---|---|
| **Popup** | `popup.html`, `popup.css`, `popup.js` | Main UI — task creation form + session list |
| **Background Service Worker** | `background.js` | API calls to Devin, session polling, notifications |
| **Content Script** | `content.js` | Grabs selected text from the active page (injected on-demand only) |
| **Options Page** | `options.html`, `options.css`, `options.js` | Settings — API key, repo list management |
| **Manifest** | `manifest.json` | Extension config, permissions, Manifest V3 |

### Data Flow

```
User opens popup
  → content.js grabs selected text from active tab (on-demand injection)
  → popup.js displays form with auto-captured context (URL, selection)
  → User writes description, selects repo, submits
  → popup.js sends message to background.js
  → background.js calls Devin API to create session
  → background.js begins polling for session completion (exponential backoff)
  → On completion: background.js fires browser notification with PR link
  → User clicks notification → opens PR on GitHub
```

---

## Permissions & Scope

### Chrome Permissions
- `activeTab` — access current tab URL and inject content script on-demand
- `storage` — persist API key, repo list, session history
- `notifications` — browser notifications for completed sessions
- `scripting` — programmatic injection of content script
- `alarms` — schedule polling intervals in the service worker

### Host Permissions
- `https://api.devin.ai/*` — Devin API for session creation and polling
- `https://api.github.com/*` — GitHub public API for PR merge detection

### Page Scope
- **HTTP/HTTPS pages only.** Extension is disabled/non-functional on `chrome://`, `about:`, `edge://`, extension pages, and other internal URLs.
- No content script runs persistently. It is injected on-demand only when the popup opens, solely to grab the current text selection.

---

## Popup UI

### Layout: Tabbed Interface

Two tabs at the top of the popup:
1. **New Task** — form for creating a new Devin session
2. **Sessions** — scrollable list of recent/active sessions

Popup dimensions: ~400px wide, ~500px tall (Chrome default max ~600px).

### Tab 1: New Task

#### Context Section (auto-populated, read-only)
- **Page URL** — automatically captured from the active tab. Displayed in a muted/small text block above the form.
  - If the URL contains suspicious patterns (`token=`, `session=`, `password=`, `secret=`, `key=`, `auth=`), show a yellow warning banner: *"This URL may contain sensitive information. It will be included in the Devin request."*
- **Selected Text** — if text was selected on the page before opening the popup, shown in a collapsible "Page Context" block with a subtle border. Collapsed by default if longer than 3 lines. This is **separate** from the description textarea — it appears as attached context, not editable inline.

#### Task Form
- **Description** (`<textarea>`) — free-form text describing the bug/task. Placeholder: *"Describe the bug or task..."*. No templates, no pre-filling.
- **Browser Errors** (`<textarea>`, optional) — labeled *"Add browser errors (optional)"*. Collapsed by default. When expanded, includes a plain-language hint guiding non-technical users through right-click → Inspect → Console → copy red errors. Explains that this helps Devin understand what went wrong.
- **Repo Selector** (`<select>`) — dropdown of saved repos in `owner/repo` format (or paste a full GitHub URL). If no repos configured, shows a prompt to go to settings.
- **Preview Prompt** — collapsed by default with a "Show" link. When expanded, shows a read-only formatted view of the full prompt: description + URL + selected text + browser errors. Lets the user verify before sending.
- **Submit Button** — "Start Devin Session". Disabled until description is non-empty and a repo is selected.

#### Submit Behavior
- On click: button shows a loading spinner, disables form.
- On success: brief success toast, form resets, auto-switch to Sessions tab.
- On failure: error message with friendly text + expandable raw error details (status code, API response body).

### Tab 2: Sessions

- Scrollable list of up to **20 most recent sessions**, newest first.
- Older sessions are automatically purged when the 21st is added.
- Each session row shows:
  - **Repo** — `owner/repo`
  - **Description** — truncated to ~60 chars
  - **Status badge** — one of four states:
    - 🟡 **Running** — session in progress, no PR yet
    - 🔵 **PR Ready** — Devin is still working but a PR URL is available
    - 🟢 **Done** — session completed or PR merged on GitHub
    - 🔴 **Failed** — session errored out or timed out
  - **Deep link** — clickable link to open the session in Devin's web UI
  - **PR link** — (if status is Done) clickable link to the GitHub PR
  - **Timestamp** — relative time ("2m ago", "1h ago", etc.)
- No search or filter for v1.

---

## First-Run Experience (Inline Setup Wizard)

If the API key or repo list is not configured when the popup opens, instead of showing the task form, display a **welcome screen + step-by-step inline wizard** within the popup:

0. **Welcome Screen** — landing page introducing the extension. Shows the name, a tagline, three bullet points explaining what it does, a note about needing a Devin API key, and a "Set Up" button. The step indicator is hidden on this screen.
1. **Step 1: API Key** — text input for the Devin API key. "Paste your Devin API key" with a link to where they can find it. A "Verify" button that makes a lightweight API call to confirm the key works before proceeding.
2. **Step 2: Add Repos** — input field (paste a GitHub URL or type `owner/repo`) with an "Add" button. Show added repos as removable chips/tags. Minimum 1 repo required.
3. **Step 3: Done** — "You're all set!" confirmation. Button to dismiss and show the normal task form.

A "Start over" button appears on steps 2+ to reset and return to the welcome screen. After setup, the wizard never shows again (data is in `chrome.storage.local`). Settings are always editable from the options page, and a "Sign out" button in the main UI returns to the welcome screen.

---

## Settings / Options Page

Full-page options accessible via right-click extension icon → "Options" or from a gear icon in the popup.

### Sections

#### API Key
- Masked input showing `••••••••last4`. "Change" button to reveal/edit.
- "Verify" button to test the key against Devin's API.

#### Repositories
- List of saved repos in `owner/repo` format (or paste a full GitHub URL).
- Add: text input + "Add" button.
- Remove: "×" button on each repo.
- No GitHub integration — manual entry only.

#### Data
- "Clear Session History" button — wipes stored sessions.
- "Reset All Settings" button — clears everything (API key, repos, sessions). Requires confirmation dialog.

---

## API Key Storage & Security

- **Storage**: `chrome.storage.local` (persistent across browser restarts).
- **Lock mechanism**: when the popup opens, it shows a neutral state. The API key is available but the popup includes a small "lock" icon in the header. If the extension has been idle for >30 minutes (tracked via a timestamp in `chrome.storage.session`), the popup shows a simple "Unlock" confirmation button before allowing task submission. This is **not** a password — just a deliberate click to prevent accidental use if someone else is at your computer.
- No encryption beyond Chrome's sandboxing (standard for extensions).

---

## Background Service Worker (`background.js`)

### Session Creation
- Receives message from popup with: `{ description, url, selectedText, consoleErrors, repo }`
- Constructs the full prompt by combining all context pieces.
- Calls Devin API to create a new session.
- Stores session metadata in `chrome.storage.local`:
  ```json
  {
    "id": "session_abc123",
    "repo": "mustafa/my-app",
    "description": "Fix login redirect bug",
    "status": "running",
    "devinUrl": "https://app.devin.ai/sessions/abc123",
    "prUrl": null,
    "createdAt": 1707500000000
  }
  ```

### Session Polling (Exponential Backoff)
- After creating a session, begin polling Devin's API for status.
- **Schedule**: 15s → 30s → 1m → 2m (cap at 2m intervals).
- Uses `chrome.alarms` API for reliable scheduling (service workers can be killed by Chrome; alarms survive).
- On each poll:
  - If status changed to complete/PR created → update stored session, fire notification, stop polling.
  - If status is failed → update stored session, fire notification, stop polling.
  - If Devin still says "working" but the PR is merged on GitHub → mark as Done, fire "PR Merged" notification, stop polling.
  - If still running → schedule next poll at next backoff interval.
- Polling stops after 24 hours of no resolution (mark as expired).

### GitHub PR Merge Detection
- When a session has a PR URL and Devin still reports "working", the poller checks GitHub's public API to see if the PR has been merged.
- Uses unauthenticated GitHub REST API (`GET /repos/{owner}/{repo}/pulls/{number}`), which allows 60 requests/hour.
- Only supports `github.com` PR URLs. Non-GitHub or private repos that block unauthenticated access will simply not trigger auto-detection (polling continues normally).

### Notifications
- Uses `chrome.notifications.create()` with:
  - **On success**: Title: "Devin PR Ready", Message: "{repo} — {truncated description}", clicking opens the PR URL.
  - **On PR merged**: Title: "PR Merged", Message: "{repo} — {truncated description}", clicking opens the PR URL.
  - **On failure**: Title: "Devin Session Failed", Message: "{repo} — {truncated description}", clicking opens the Devin session URL.
  - **On timeout**: Title: "Devin Session Timed Out", Message: "{repo} — {truncated description}", clicking opens the Devin session URL.
- `chrome.notifications.onClicked` listener opens the appropriate URL in a new tab.
- Notification click URLs are validated against an allowlist of domains (`github.com`, `app.devin.ai`, `gitlab.com`, `bitbucket.org`) and must use HTTPS.
- **Icon badge**: Each notification increments a badge count on the extension icon (red, `#e53935`). The badge clears when the user opens the popup.

---

## Content Script (`content.js`)

- **Not persistently injected.** Only runs when the popup opens.
- Injected via `chrome.scripting.executeScript()` from the popup or background.
- Sole purpose: return `window.getSelection().toString()` (the currently selected text on the page).
- Minimal footprint — no DOM manipulation, no event listeners, no monkey-patching.

---

## Prompt Construction

The final prompt sent to Devin is assembled as follows:

```
{user's description}

---
Context:
- Page URL: {url}
- Selected text from page:
{selected text, if any}
- Console errors:
{pasted console errors, if any}
```

- Omit any section that's empty (e.g., if no text was selected, skip "Selected text from page").
- URL is always included (captured from the active tab).

---

## Visual Design

### Theme: Dark (Devin-inspired)

- **Background**: `#0c0f12` (near-black)
- **Surface/Cards**: `#181d22` (dark grey)
- **Inputs**: `#111518` (slightly darker than surface)
- **Primary accent**: `#1a3040` (muted blue-grey)
- **Action/CTA**: `#00c48c` (Devin teal-green, for submit button and active states)
- **Text**: `#e2e6ea` (primary), `#6e7681` (secondary/muted)
- **Borders**: `#262d34` (subtle)
- **Links**: `#5eead4` (light teal)
- **Monospace font** for code-like elements (repo names, URLs, console errors)
- **Sans-serif font** (system font stack) for everything else
- Status badges: muted colored pills — `#d4a72c` amber for running, `#5eead4` teal for PR ready, `#2dd4a8` green for done, `#cf6679` rose for failed
- Buttons: solid fill for primary actions, outlined/ghost for secondary

### Animations
- Subtle fade transitions between tabs
- Loading spinner on submit (CSS-only, no JS animation library)
- Toast notification for success/error (slides in, auto-dismisses after 3s)

---

## Error Handling

All API errors show a **user-friendly message** by default, with an expandable "Show details" section containing the raw error:

| Scenario | Friendly Message | Details |
|---|---|---|
| Network error | "Couldn't reach Devin. Check your internet connection." | Raw fetch error |
| 401 Unauthorized | "Invalid API key. Check your settings." | Response body |
| 429 Rate Limited | "Too many requests. Try again in a moment." | Response body + retry-after header |
| 500+ Server Error | "Devin is having issues. Try again later." | Response body + status code |
| Unknown error | "Something went wrong." | Full error object |

---

## File Structure

```
devin-chrome-extension/
├── manifest.json
├── popup/
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
├── options/
│   ├── options.html
│   ├── options.css
│   └── options.js
├── background/
│   └── background.js   # Service worker (Devin API helpers inlined)
├── content/
│   └── content.js
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── SPEC.md
└── README.md
```

---

## Devin API Integration

> **Note**: Exact API endpoints and request/response shapes will be determined during implementation. The following is the assumed interface based on Devin's documentation.

### Assumed Endpoints

- **Create Session**: `POST /v1/sessions` — body includes prompt text and repo reference.
- **Get Session Status**: `GET /v1/sessions/{id}` — returns status, PR URL if available.
- **List Sessions** (optional): `GET /v1/sessions` — for initial population of session list.

### API Key Header
- Sent as `Authorization: Bearer {api_key}` on all requests.

### Base URL
- `https://api.devin.ai`

---

## Out of Scope (v1)

- No GitHub PAT integration / auto-fetching repos
- No webhook-based session completion (polling only)
- No in-popup chat with Devin (fire-and-forget only)
- No keyboard shortcuts

- No prompt templates
- No branch selection (default branch only)
- No multi-account / multiple API keys
- No automatic console error capture
- No support for non-HTTP pages
