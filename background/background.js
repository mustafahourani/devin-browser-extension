// ── Devin API ────────────────────────────────────────────────────

const DEVIN_API_BASE = 'https://api.devin.ai/v1';

async function getApiKey() {
  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (!apiKey) throw new Error('API key not configured');
  return apiKey;
}

async function devinFetch(endpoint, options = {}) {
  const apiKey = await getApiKey();
  const response = await fetch(`${DEVIN_API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    let body = '';
    try { body = await response.text(); } catch (_) {}
    const err = new Error(friendlyError(response.status));
    err.status = response.status;
    err.details = body || `HTTP ${response.status}`;
    throw err;
  }

  return response.json();
}

function friendlyError(status) {
  if (status === 401) return 'Invalid API key. Check your settings.';
  if (status === 429) return 'Too many requests. Try again in a moment.';
  if (status >= 500) return 'Devin is having issues. Try again later.';
  return 'Something went wrong.';
}

async function createDevinSession(prompt) {
  return devinFetch('/sessions', {
    method: 'POST',
    body: JSON.stringify({ prompt }),
  });
}

async function getDevinSession(sessionId) {
  return devinFetch(`/sessions/${sessionId}`);
}

async function verifyDevinApiKey(apiKey) {
  try {
    const response = await fetch(`${DEVIN_API_BASE}/sessions?limit=1`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    return response.ok;
  } catch (_) {
    return false;
  }
}

// ── Config ────────────────────────────────────────────────────────

const POLL_INTERVALS = [0.25, 0.5, 1, 2]; // minutes
const MAX_POLL_AGE = 24 * 60 * 60 * 1000; // 24 hours
const MAX_SESSIONS = 20;

// ── Resume polling after extension reload/update ─────────────────

chrome.runtime.onInstalled.addListener(() => resumeActiveSessions());
chrome.runtime.onStartup.addListener(() => resumeActiveSessions());

async function resumeActiveSessions() {
  const { sessions = [] } = await chrome.storage.local.get('sessions');
  for (const s of sessions) {
    if (!isTerminal(s.statusEnum)) {
      schedulePoll(s.id, POLL_INTERVALS.length - 1); // resume at max interval
    }
  }
}

// ── Message Handler ───────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only accept messages from our own extension
  if (sender.id !== chrome.runtime.id) return;
  handleMessage(msg).then(sendResponse);
  return true; // keep channel open for async
});

async function handleMessage(msg) {
  switch (msg.action) {
    case 'verifyApiKey':
      return handleVerifyApiKey(msg.apiKey);
    case 'createSession':
      return handleCreateSession(msg.data);
    case 'clearBadge':
      await chrome.storage.session.set({ badgeCount: 0 });
      chrome.action.setBadgeText({ text: '' });
      return { success: true };
    default:
      return { success: false, error: 'Unknown action' };
  }
}

async function handleVerifyApiKey(apiKey) {
  try {
    const valid = await verifyDevinApiKey(apiKey);
    return { success: valid };
  } catch (_) {
    return { success: false };
  }
}

async function handleCreateSession({ prompt, repo, description }) {
  try {
    const result = await createDevinSession(prompt);

    const session = {
      id: result.session_id,
      repo,
      description,
      statusEnum: 'working',
      devinUrl: result.url,
      prUrl: null,
      createdAt: Date.now(),
    };

    await storeSession(session);
    schedulePoll(session.id, 0);

    return { success: true, data: session };
  } catch (err) {
    return { success: false, error: err.message, details: err.details || '' };
  }
}

// ── Session Storage ───────────────────────────────────────────────

async function storeSession(session) {
  const { sessions = [] } = await chrome.storage.local.get('sessions');
  sessions.unshift(session);
  if (sessions.length > MAX_SESSIONS) sessions.length = MAX_SESSIONS;
  await chrome.storage.local.set({ sessions });
}

async function updateSession(sessionId, updates) {
  const { sessions = [] } = await chrome.storage.local.get('sessions');
  const idx = sessions.findIndex(s => s.id === sessionId);
  if (idx === -1) return null;
  Object.assign(sessions[idx], updates);
  await chrome.storage.local.set({ sessions });
  return sessions[idx];
}

async function getStoredSession(sessionId) {
  const { sessions = [] } = await chrome.storage.local.get('sessions');
  return sessions.find(s => s.id === sessionId) || null;
}

// ── Polling ───────────────────────────────────────────────────────

function schedulePoll(sessionId, intervalIndex) {
  const delay = POLL_INTERVALS[Math.min(intervalIndex, POLL_INTERVALS.length - 1)];
  // Use JSON to safely encode both values (session IDs can contain underscores)
  const alarmName = 'poll:' + JSON.stringify({ sid: sessionId, idx: intervalIndex });
  chrome.alarms.create(alarmName, { delayInMinutes: delay });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith('poll:')) return;

  try {
    const { sid, idx } = JSON.parse(alarm.name.slice(5));
    await pollSession(sid, idx);
  } catch (_) {}
});

async function pollSession(sessionId, intervalIndex) {
  const stored = await getStoredSession(sessionId);
  if (!stored) return;

  // Stop polling if session is too old
  if (Date.now() - stored.createdAt > MAX_POLL_AGE) {
    await updateSession(sessionId, { statusEnum: 'expired' });
    notify(
      'Devin Session Timed Out',
      `${stored.repo} — ${truncate(stored.description, 50)}`,
      stored.devinUrl
    );
    return;
  }

  try {
    const data = await getDevinSession(sessionId);
    const statusEnum = data.status_enum || data.status || 'working';
    const prUrl = data.pull_request?.url || null;

    await updateSession(sessionId, { statusEnum, prUrl });

    if (isTerminal(statusEnum)) {
      if (statusEnum === 'finished') {
        notify(
          'Devin PR Ready',
          `${stored.repo} — ${truncate(stored.description, 50)}`,
          prUrl || stored.devinUrl
        );
      } else {
        notify(
          'Devin Session Failed',
          `${stored.repo} — ${truncate(stored.description, 50)}`,
          stored.devinUrl
        );
      }
    } else if (prUrl && await isPrMerged(prUrl)) {
      // Devin still says working, but PR is merged on GitHub — mark as done
      await updateSession(sessionId, { statusEnum: 'finished' });
      notify(
        'PR Merged',
        `${stored.repo} — ${truncate(stored.description, 50)}`,
        prUrl
      );
    } else {
      // Notify when PR URL first appears
      if (prUrl && !stored.prUrl) {
        notify(
          'Devin PR Ready',
          `${stored.repo} — ${truncate(stored.description, 50)}`,
          prUrl
        );
      }
      // Keep polling with next interval
      schedulePoll(sessionId, intervalIndex + 1);
    }
  } catch (err) {
    // Network error — retry at same interval
    schedulePoll(sessionId, intervalIndex);
  }
}

function isTerminal(statusEnum) {
  return ['finished', 'expired', 'suspend_requested', 'suspend_requested_frontend'].includes(statusEnum);
}

// ── GitHub PR Merge Check ────────────────────────────────────────

function parsePrUrl(prUrl) {
  try {
    const url = new URL(prUrl);
    if (url.hostname !== 'github.com') return null;
    const parts = url.pathname.split('/').filter(Boolean);
    // expect: owner/repo/pull/123
    if (parts.length >= 4 && parts[2] === 'pull') {
      return { owner: parts[0], repo: parts[1], number: parts[3] };
    }
  } catch (_) {}
  return null;
}

async function isPrMerged(prUrl) {
  const pr = parsePrUrl(prUrl);
  if (!pr) return false;
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`,
      { headers: { 'Accept': 'application/vnd.github.v3+json' } }
    );
    if (!resp.ok) return false;
    const data = await resp.json();
    return data.merged === true;
  } catch (_) {
    return false;
  }
}

// ── Notifications ─────────────────────────────────────────────────

async function notify(title, message, url) {
  const notifId = `devin_${Date.now()}`;
  chrome.notifications.create(notifId, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title,
    message,
  });

  if (url) {
    await chrome.storage.session.set({ [`notif_${notifId}`]: url });
  }

  // Increment badge count
  const { badgeCount = 0 } = await chrome.storage.session.get('badgeCount');
  const newCount = badgeCount + 1;
  await chrome.storage.session.set({ badgeCount: newCount });
  chrome.action.setBadgeText({ text: String(newCount) });
  chrome.action.setBadgeBackgroundColor({ color: '#e53935' });
}

const ALLOWED_NOTIF_DOMAINS = ['github.com', 'app.devin.ai', 'gitlab.com', 'bitbucket.org'];

chrome.notifications.onClicked.addListener(async (notifId) => {
  const key = `notif_${notifId}`;
  const data = await chrome.storage.session.get(key);
  const url = data[key];
  if (url && isSafeUrl(url)) {
    chrome.tabs.create({ url });
    chrome.storage.session.remove(key);
  }
  chrome.notifications.clear(notifId);
});

function isSafeUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    return ALLOWED_NOTIF_DOMAINS.some(d =>
      parsed.hostname === d || parsed.hostname.endsWith('.' + d)
    );
  } catch (_) {
    return false;
  }
}

// ── Helpers ───────────────────────────────────────────────────────

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '...' : str;
}
