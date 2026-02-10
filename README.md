# Devin Browser Extension

A Chrome extension that lets you trigger Devin AI sessions from any webpage. Describe a bug or task, and the extension automatically captures page context (URL, selected text) and fires off a Devin session via their API. Get a browser notification when the PR is ready.

Built with **Manifest V3, vanilla HTML/CSS/JS**. No frameworks, no build tools, no dependencies.

## Install

1. Open `chrome://extensions` in Chrome
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select this folder
4. Pin the extension to your toolbar

## Setup

On first click, an inline setup wizard walks you through three steps:

1. **Welcome**: overview of what the extension does and a link to get a Devin API key
2. **API Key**: paste your key and verify it works with a live API check before proceeding
3. **Repos**: add one or more repos by pasting GitHub URLs or typing `owner/repo` (shown as removable chips)

The wizard validates your API key against Devin's API in real time. After setup, you can always change your key or repos from the Settings page. A "Start over" button lets you re-run the wizard at any time.

## Usage

1. Navigate to any webpage related to a bug or task
2. Optionally select relevant text on the page
3. Click the extension icon
4. Write a task description
5. (Optional) Paste browser errors if something is broken on the page
6. Select a repo and hit **Start Devin Session**

The extension automatically includes the page URL and any selected text as context. When Devin finishes and creates a PR, you'll get a browser notification. Click it to go straight to the PR on GitHub.

## Features

### Context Capture
- **Auto URL + text capture**: the current page URL and any selected text are automatically included as context in the Devin prompt. No copy/paste needed
- **Browser error input**: optional collapsible field to paste console errors, with a built-in plain-language guide for non-technical users on how to find them (right-click > Inspect > Console)
- **Prompt preview**: expand "Preview what Devin will see" to review the full assembled prompt (description + URL + selected text + errors) before sending
- **Sensitive URL warnings**: if the page URL contains tokens, passwords, session IDs, or other secrets (`token=`, `password=`, `secret=`, `key=`, `auth=`, `session=`), a yellow warning banner appears before you submit

### Session Tracking
- **Live status updates**: view your last 20 sessions with four status states:
  - **Running** - session in progress, no PR yet
  - **PR Ready** - Devin created a PR but is still working
  - **Done** - session completed or PR merged on GitHub
  - **Failed** - session errored out or timed out
- **Deep links**: each session has clickable links to both the Devin session page and the GitHub PR
- **Relative timestamps**: shows "just now", "2m ago", "1h ago", etc.
- **Session persistence**: session history is preserved even if you sign out and sign back in with a different API key. Only the 20 most recent sessions are kept; older ones are automatically purged

### Notifications
- **Browser notifications** at key moments:
  - PR first created (PR Ready)
  - Session finished
  - PR merged on GitHub
  - Session failed or timed out
- **Click to open**: clicking any notification jumps directly to the PR or Devin session
- **Icon badge**: a red notification count appears on the extension icon whenever something needs attention. Badge clears when you open the popup

### Polling & Merge Detection
- **Exponential backoff polling**: 15s > 30s > 1m > 2m (capped). Sessions time out after 24 hours
- **Polling resumes automatically**: if Chrome restarts or the extension reloads, polling picks back up for all active sessions via `chrome.alarms`
- **GitHub PR merge detection**: polls GitHub's public API to detect when a PR is merged, even if Devin still reports "working", and automatically marks the session as Done

### Account & Settings
- **Idle lock**: after 30 minutes of inactivity, the popup requires a click to unlock before you can submit tasks (prevents accidental use on a shared machine)
- **Sign out**: sign out from the main UI to switch API keys or re-run the setup wizard
- **Settings page**: full options page to manage your API key (masked display with verify button), repo list (add/remove), and data (clear sessions, reset everything with confirmation dialog)

## Security

- **API key storage**: stored in `chrome.storage.local`, sandboxed by Chrome's extension security model. Displayed as `••••••••last4` in the settings page
- **Sensitive URL detection**: warns before sending URLs that contain tokens, passwords, or session IDs to the Devin API
- **Notification URL allowlist**: notification click URLs are validated against a strict allowlist (`github.com`, `app.devin.ai`, `gitlab.com`, `bitbucket.org`) and must use HTTPS
- **XSS prevention**: all user-generated content (descriptions, URLs, repo names) is HTML-escaped before rendering. Links use `safeHref()` validation
- **Message origin validation**: the background service worker only accepts messages from the extension's own runtime ID
- **No persistent content script**: content script is injected on-demand only when the popup opens, solely to read `window.getSelection()`. No DOM manipulation, no event listeners

## Error Handling

All API errors show a user-friendly message by default, with an expandable "Show details" section for debugging:

| Scenario | Message |
|---|---|
| Network error | "Couldn't reach Devin. Check your internet connection." |
| 401 Unauthorized | "Invalid API key. Check your settings." |
| 429 Rate Limited | "Too many requests. Try again in a moment." |
| 500+ Server Error | "Devin is having issues. Try again later." |
| Unknown | "Something went wrong." |

## Architecture

| Component | Files | Role |
|---|---|---|
| Popup | `popup/` | Main UI: task form, session list, setup wizard |
| Background | `background/background.js` | Service worker: API calls, polling, notifications, badge |
| Content | `content/content.js` | Injected on-demand to grab selected text |
| Options | `options/` | Settings page: API key, repos, data management |

### Data Flow

```
User opens popup
  → content.js grabs selected text from active tab (on-demand injection)
  → popup.js displays form with auto-captured context (URL, selection)
  → User writes description, selects repo, submits
  → popup.js sends message to background.js
  → background.js calls Devin API to create session
  → background.js begins polling via chrome.alarms (exponential backoff)
  → On PR created: fires "PR Ready" notification + badge
  → On completion: fires "Done" notification + badge
  → User clicks notification → opens PR on GitHub
```

## APIs

### Devin API

Uses the [Devin v1 API](https://docs.devin.ai/api-reference/overview):

- `POST /v1/sessions` - create a session with a prompt
- `GET /v1/sessions/{id}` - poll for status and PR URL
- `GET /v1/sessions?limit=1` - used to verify API key during setup
- Session statuses: `working` > `finished` (success) or `expired` (failure)
- PR URL available via `pull_request.url` in the session response
- Auth: `Authorization: Bearer {api_key}`

### GitHub API

Uses the public GitHub REST API (unauthenticated, 60 requests/hour) to detect PR merges:

- `GET /repos/{owner}/{repo}/pulls/{number}` - checks `merged` field
- If Devin still reports "working" but the PR is merged, the session is automatically marked as Done
- Only supports `github.com` PR URLs. Non-GitHub or private repos fall back to Devin-only status tracking
