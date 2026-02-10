document.addEventListener('DOMContentLoaded', init);

let confirmCallback = null;

async function init() {
  await loadApiKey();
  await loadRepos();
  setupListeners();
}

// ── API Key ───────────────────────────────────────────────────────

async function loadApiKey() {
  const { apiKey } = await chrome.storage.local.get('apiKey');
  const mask = document.getElementById('keyMask');
  const verifyBtn = document.getElementById('verifyKeyBtn');

  if (apiKey) {
    mask.textContent = '••••••••' + apiKey.slice(-4);
    verifyBtn.disabled = false;
  } else {
    mask.textContent = 'Not configured';
    verifyBtn.disabled = true;
  }
}

function showKeyEdit() {
  document.getElementById('keyEditSection').classList.remove('hidden');
  document.getElementById('apiKeyInput').focus();
}

function hideKeyEdit() {
  document.getElementById('keyEditSection').classList.add('hidden');
  document.getElementById('apiKeyInput').value = '';
  document.getElementById('keyStatus').classList.add('hidden');
}

async function saveKey() {
  const key = document.getElementById('apiKeyInput').value.trim();
  if (!key) return;

  showStatus('keyStatus', 'Verifying...', '');

  try {
    const response = await chrome.runtime.sendMessage({ action: 'verifyApiKey', apiKey: key });
    if (response.success) {
      await chrome.storage.local.set({ apiKey: key });
      showStatus('keyStatus', 'API key saved and verified.', 'success');
      hideKeyEdit();
      await loadApiKey();
    } else {
      showStatus('keyStatus', 'Invalid API key.', 'error');
    }
  } catch (_) {
    showStatus('keyStatus', 'Verification failed. Check your connection.', 'error');
  }
}

async function verifyKey() {
  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (!apiKey) return;

  showStatus('keyStatus', 'Verifying...', '');

  try {
    const response = await chrome.runtime.sendMessage({ action: 'verifyApiKey', apiKey });
    if (response.success) {
      showStatus('keyStatus', 'API key is valid.', 'success');
    } else {
      showStatus('keyStatus', 'API key is invalid or expired.', 'error');
    }
  } catch (_) {
    showStatus('keyStatus', 'Verification failed.', 'error');
  }
}

// ── Repos ─────────────────────────────────────────────────────────

async function loadRepos() {
  const { repos = [] } = await chrome.storage.local.get('repos');
  renderRepos(repos);
}

function renderRepos(repos) {
  const list = document.getElementById('repoList');
  const empty = document.getElementById('repoEmpty');

  if (repos.length === 0) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  list.innerHTML = repos.map(repo =>
    `<li>
      <span>${escapeHtml(repo)}</span>
      <button class="repo-remove" data-repo="${escapeHtml(repo)}" title="Remove">&times;</button>
    </li>`
  ).join('');

  list.querySelectorAll('.repo-remove').forEach(btn => {
    btn.addEventListener('click', () => removeRepo(btn.dataset.repo));
  });
}

async function addRepo() {
  const input = document.getElementById('repoInput');
  const raw = input.value.trim();
  const errorEl = document.getElementById('repoError');
  errorEl.classList.add('hidden');

  if (!raw) return;
  const repo = parseRepo(raw);
  if (!repo) {
    errorEl.textContent = 'Paste a GitHub URL or use owner/repo format';
    errorEl.classList.remove('hidden');
    return;
  }

  const { repos = [] } = await chrome.storage.local.get('repos');
  if (repos.includes(repo)) {
    errorEl.textContent = 'Repo already exists.';
    errorEl.classList.remove('hidden');
    return;
  }

  repos.push(repo);
  await chrome.storage.local.set({ repos });
  input.value = '';
  renderRepos(repos);
}

async function removeRepo(repo) {
  const { repos = [] } = await chrome.storage.local.get('repos');
  const updated = repos.filter(r => r !== repo);
  await chrome.storage.local.set({ repos: updated });
  renderRepos(updated);
}

// ── Data ──────────────────────────────────────────────────────────

async function clearSessions() {
  await chrome.storage.local.set({ sessions: [] });
  showStatus('dataStatus', 'Session history cleared.', 'success');
}

async function resetAll() {
  await chrome.storage.local.clear();
  await chrome.storage.session.clear();
  showStatus('dataStatus', 'All settings reset.', 'success');
  await loadApiKey();
  await loadRepos();
}

// ── Confirm Dialog ────────────────────────────────────────────────

function showConfirm(message, callback) {
  confirmCallback = callback;
  document.getElementById('confirmMsg').textContent = message;
  document.getElementById('confirmOverlay').classList.remove('hidden');
}

function hideConfirm() {
  document.getElementById('confirmOverlay').classList.add('hidden');
  confirmCallback = null;
}

// ── Listeners ─────────────────────────────────────────────────────

function setupListeners() {
  document.getElementById('changeKeyBtn').addEventListener('click', showKeyEdit);
  document.getElementById('cancelKeyBtn').addEventListener('click', hideKeyEdit);
  document.getElementById('saveKeyBtn').addEventListener('click', saveKey);
  document.getElementById('verifyKeyBtn').addEventListener('click', verifyKey);

  document.getElementById('addRepoBtn').addEventListener('click', addRepo);
  document.getElementById('repoInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addRepo();
  });

  document.getElementById('clearSessionsBtn').addEventListener('click', () => {
    showConfirm('Clear all session history?', clearSessions);
  });
  document.getElementById('resetAllBtn').addEventListener('click', () => {
    showConfirm('Reset ALL settings? This will remove your API key, repos, and session history.', resetAll);
  });

  document.getElementById('confirmYes').addEventListener('click', () => {
    if (confirmCallback) confirmCallback();
    hideConfirm();
  });
  document.getElementById('confirmNo').addEventListener('click', hideConfirm);
}

// ── Helpers ───────────────────────────────────────────────────────

function parseRepo(input) {
  try {
    const url = new URL(input.includes('://') ? input : 'https://' + input);
    if (url.hostname === 'github.com' || url.hostname === 'www.github.com') {
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
    }
  } catch (_) {}
  if (/^[^/]+\/[^/]+$/.test(input)) return input;
  return null;
}

function showStatus(id, message, type) {
  const el = document.getElementById(id);
  el.textContent = message;
  el.className = `status-msg${type ? ' ' + type : ''}`;
  el.classList.remove('hidden');
  if (type) setTimeout(() => el.classList.add('hidden'), 5000);
}

function escapeHtml(str) {
  const el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
}
