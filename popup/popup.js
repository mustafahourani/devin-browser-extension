document.addEventListener('DOMContentLoaded', init);

let capturedUrl = '';
let capturedSelection = '';
let capturedScreenshot = null; // data URL from captureVisibleTab
let wizardRepos = [];

// ── Init ──────────────────────────────────────────────────────────

async function init() {
  chrome.runtime.sendMessage({ action: 'clearBadge' });
  setupEventListeners();

  const { apiKey, repos } = await chrome.storage.local.get(['apiKey', 'repos']);
  const setupComplete = apiKey && repos && repos.length > 0;

  if (!setupComplete) {
    showScreen('wizard');
    if (apiKey && (!repos || repos.length === 0)) {
      // API key saved but no repos yet — skip to repo step
      showWizardStep(2);
    } else if (!apiKey) {
      // Fresh start — show welcome
      showWizardStep(0);
    }
    return;
  }

  const locked = await checkLock();
  if (locked) {
    showScreen('lockScreen');
    return;
  }

  await showMainUI();
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(el => el.classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
}

async function showMainUI() {
  showScreen('mainUI');
  await updateLastActive();
  await captureContext();
  await populateRepos();
  await loadSessions();
  updateSubmitState();
}

// ── Event Listeners ───────────────────────────────────────────────

function setupEventListeners() {
  // Lock
  document.getElementById('unlockBtn').addEventListener('click', async () => {
    await updateLastActive();
    await showMainUI();
  });

  // Wizard
  document.getElementById('wizardStartBtn').addEventListener('click', () => showWizardStep(1));
  document.getElementById('wizardCancelBtn').addEventListener('click', wizardCancel);
  document.getElementById('wizardVerifyBtn').addEventListener('click', verifyApiKey);
  document.getElementById('wizardApiKey').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') verifyApiKey();
  });
  document.getElementById('wizardAddRepoBtn').addEventListener('click', wizardAddRepo);
  document.getElementById('wizardRepoInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') wizardAddRepo();
  });
  document.getElementById('wizardNextBtn').addEventListener('click', () => showWizardStep(3));
  document.getElementById('wizardDoneBtn').addEventListener('click', async () => {
    await showMainUI();
  });

  // Tabs
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  // Settings
  document.getElementById('openSettings').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // Sign out
  document.getElementById('signOutBtn').addEventListener('click', signOut);

  // Form
  document.getElementById('description').addEventListener('input', () => {
    updateSubmitState();
    updatePreview();
  });
  // Repo checkbox changes are handled via event delegation in populateRepos
  document.getElementById('consoleErrors').addEventListener('input', updatePreview);

  // Screenshot
  document.getElementById('capturePageBtn').addEventListener('click', captureScreenshot);
  document.getElementById('removeScreenshot').addEventListener('click', removeScreenshot);

  // Console toggle
  document.getElementById('toggleConsole').addEventListener('click', () => {
    toggleSection('consoleInput', 'toggleConsole');
  });

  // Selection toggle
  document.getElementById('toggleSelection').addEventListener('click', () => {
    toggleSection('selectionContent', 'toggleSelection');
  });

  // Preview toggle
  document.getElementById('togglePreview').addEventListener('click', () => {
    const section = document.getElementById('previewSection');
    const btn = document.getElementById('togglePreview');
    const isHidden = section.classList.toggle('hidden');
    btn.textContent = isHidden ? 'Show' : 'Hide';
    if (!isHidden) updatePreview();
  });

  // Submit
  document.getElementById('submitBtn').addEventListener('click', submitTask);

  // Error details toggle
  document.getElementById('toggleErrorDetails').addEventListener('click', () => {
    document.getElementById('submitErrorDetails').classList.toggle('hidden');
  });

  // Listen for storage changes to update sessions live
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.sessions) {
      renderSessions(changes.sessions.newValue || []);
    }
  });
}

function toggleSection(contentId, toggleId) {
  const content = document.getElementById(contentId);
  const arrow = document.getElementById(toggleId).querySelector('.toggle-arrow');
  content.classList.toggle('hidden');
  arrow.classList.toggle('open');
}

// ── Lock ──────────────────────────────────────────────────────────

async function checkLock() {
  const { lastActive } = await chrome.storage.session.get('lastActive');
  if (!lastActive) return true;
  return Date.now() - lastActive > 30 * 60 * 1000;
}

async function updateLastActive() {
  await chrome.storage.session.set({ lastActive: Date.now() });
}

async function signOut() {
  await chrome.storage.local.remove(['apiKey', 'repos']);
  await chrome.storage.session.remove('lastActive');
  wizardRepos = [];
  showScreen('wizard');
  showWizardStep(0);
}

// ── Wizard ────────────────────────────────────────────────────────

function showWizardStep(step) {
  // Hide all steps including welcome
  document.querySelectorAll('.wizard-step').forEach(el => el.classList.add('hidden'));

  if (step === 0) {
    // Welcome screen — no header
    document.getElementById('wizardWelcome').classList.remove('hidden');
    document.getElementById('wizardHeader').classList.add('hidden');
    return;
  }

  document.getElementById(`wizardStep${step}`).classList.remove('hidden');
  document.getElementById('wizardHeader').classList.remove('hidden');

  document.querySelectorAll('.step-dot').forEach(dot => {
    const dotStep = parseInt(dot.dataset.step);
    dot.classList.remove('active', 'completed');
    if (dotStep === step) dot.classList.add('active');
    else if (dotStep < step) dot.classList.add('completed');
  });

  // Show cancel button on steps 2+
  document.getElementById('wizardCancelBtn').classList.toggle('hidden', step === 1);
}

async function wizardCancel() {
  await chrome.storage.local.remove(['apiKey', 'repos']);
  wizardRepos = [];
  document.getElementById('wizardApiKey').value = '';
  document.getElementById('wizardRepoInput').value = '';
  document.getElementById('wizardRepoList').innerHTML = '';
  document.getElementById('wizardNextBtn').disabled = true;
  document.getElementById('wizardStep1Error').classList.add('hidden');
  document.getElementById('wizardStep2Error').classList.add('hidden');
  showWizardStep(0);
}

async function verifyApiKey() {
  const key = document.getElementById('wizardApiKey').value.trim();
  if (!key) return;

  const btn = document.getElementById('wizardVerifyBtn');
  const errorEl = document.getElementById('wizardStep1Error');
  btn.disabled = true;
  btn.textContent = 'Verifying...';
  errorEl.classList.add('hidden');

  try {
    const response = await chrome.runtime.sendMessage({ action: 'verifyApiKey', apiKey: key });
    if (response.success) {
      await chrome.storage.local.set({ apiKey: key });
      showWizardStep(2);
    } else {
      errorEl.textContent = 'Invalid API key. Please check and try again.';
      errorEl.classList.remove('hidden');
    }
  } catch (err) {
    errorEl.textContent = 'Failed to verify. Check your connection.';
    errorEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Verify';
  }
}

async function wizardAddRepo() {
  const input = document.getElementById('wizardRepoInput');
  const raw = input.value.trim();
  const errorEl = document.getElementById('wizardStep2Error');
  errorEl.classList.add('hidden');

  if (!raw) return;
  const repo = parseRepo(raw);
  if (!repo) {
    errorEl.textContent = 'Paste a GitHub URL or use owner/repo format';
    errorEl.classList.remove('hidden');
    return;
  }
  if (wizardRepos.includes(repo)) {
    errorEl.textContent = 'Repo already added.';
    errorEl.classList.remove('hidden');
    return;
  }

  wizardRepos.push(repo);
  await chrome.storage.local.set({ repos: wizardRepos });
  input.value = '';
  renderWizardRepos();
  document.getElementById('wizardNextBtn').disabled = false;
}

async function wizardRemoveRepo(repo) {
  wizardRepos = wizardRepos.filter(r => r !== repo);
  await chrome.storage.local.set({ repos: wizardRepos });
  renderWizardRepos();
  document.getElementById('wizardNextBtn').disabled = wizardRepos.length === 0;
}

function renderWizardRepos() {
  const container = document.getElementById('wizardRepoList');
  container.innerHTML = wizardRepos.map(repo =>
    `<span class="repo-chip">
      <span>${escapeHtml(repo)}</span>
      <span class="repo-chip-remove" data-repo="${escapeHtml(repo)}">&times;</span>
    </span>`
  ).join('');

  container.querySelectorAll('.repo-chip-remove').forEach(btn => {
    btn.addEventListener('click', () => wizardRemoveRepo(btn.dataset.repo));
  });
}

// ── Tabs ──────────────────────────────────────────────────────────

function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.getElementById('newTaskTab').classList.toggle('hidden', tab !== 'newTask');
  document.getElementById('sessionsTab').classList.toggle('hidden', tab !== 'sessions');

  if (tab === 'sessions') loadSessions();
}

// ── Context Capture ───────────────────────────────────────────────

async function captureContext() {
  let tab = null;
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = activeTab;
    capturedUrl = (tab?.url && tab.url.startsWith('http')) ? tab.url : '';
  } catch (_) {
    capturedUrl = '';
  }

  document.getElementById('urlText').textContent = capturedUrl || 'N/A';

  // Suspicious URL check
  const suspicious = ['token=', 'session=', 'password=', 'secret=', 'key=', 'auth='];
  const isSuspicious = capturedUrl && suspicious.some(p => capturedUrl.toLowerCase().includes(p));
  document.getElementById('urlWarning').classList.toggle('hidden', !isSuspicious);

  // Selected text
  capturedSelection = '';
  if (capturedUrl && tab) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.getSelection().toString(),
      });
      capturedSelection = results?.[0]?.result || '';
    } catch (_) {}
  }

  const selBlock = document.getElementById('selectionBlock');
  if (capturedSelection) {
    document.getElementById('selectionText').textContent = capturedSelection;
    document.getElementById('selectionCharCount').textContent = `(${capturedSelection.length} chars)`;
    selBlock.classList.remove('hidden');
  } else {
    selBlock.classList.add('hidden');
  }

  updatePreview();
}

// ── Screenshot ────────────────────────────────────────────────────

async function captureScreenshot() {
  const btn = document.getElementById('capturePageBtn');
  btn.disabled = true;
  btn.textContent = 'Capturing...';

  try {
    const dataUrl = await chrome.runtime.sendMessage({ action: 'captureTab' });
    if (dataUrl && dataUrl.startsWith('data:')) {
      capturedScreenshot = dataUrl;
      document.getElementById('screenshotThumb').src = dataUrl;
      document.getElementById('screenshotPreview').classList.remove('hidden');
      updatePreview();
    } else {
      showToast('Could not capture page', 'error');
    }
  } catch (err) {
    showToast('Could not capture page', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg> Capture Page';
  }
}

function removeScreenshot() {
  capturedScreenshot = null;
  document.getElementById('screenshotPreview').classList.add('hidden');
  document.getElementById('screenshotThumb').src = '';
  updatePreview();
}

// ── Repos ─────────────────────────────────────────────────────────

async function populateRepos() {
  const { repos = [] } = await chrome.storage.local.get('repos');
  const container = document.getElementById('repoCheckboxes');
  container.innerHTML = '';

  repos.forEach(repo => {
    const id = `repo-cb-${repo.replace(/[^a-zA-Z0-9]/g, '-')}`;
    const item = document.createElement('div');
    item.className = 'repo-checkbox-item';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = id;
    cb.value = repo;
    // Auto-check if there's only one repo
    if (repos.length === 1) {
      cb.checked = true;
      item.classList.add('checked');
    }

    const lbl = document.createElement('label');
    lbl.htmlFor = id;
    lbl.textContent = repo;

    item.appendChild(cb);
    item.appendChild(lbl);
    container.appendChild(item);

    cb.addEventListener('change', () => {
      item.classList.toggle('checked', cb.checked);
      updateSubmitState();
      updatePreview();
    });

    item.addEventListener('click', (e) => {
      if (e.target !== cb) {
        cb.checked = !cb.checked;
        item.classList.toggle('checked', cb.checked);
        updateSubmitState();
        updatePreview();
      }
    });
  });
}

function getSelectedRepos() {
  return Array.from(document.querySelectorAll('#repoCheckboxes input:checked')).map(cb => cb.value);
}

// ── Form ──────────────────────────────────────────────────────────

function updateSubmitState() {
  const desc = document.getElementById('description').value.trim();
  const repos = getSelectedRepos();
  document.getElementById('submitBtn').disabled = !desc || repos.length === 0;
}

function buildPrompt() {
  const description = document.getElementById('description').value.trim();
  const consoleErrors = document.getElementById('consoleErrors').value.trim();
  const repos = getSelectedRepos();

  let prompt = '';
  if (repos.length === 1) {
    prompt += `Repository: ${repos[0]}\n\n`;
  } else if (repos.length > 1) {
    prompt += `Repositories: ${repos.join(', ')}\n\n`;
  }
  prompt += description;

  const parts = [];
  if (capturedUrl) parts.push(`- Page URL: ${capturedUrl}`);
  if (capturedSelection) parts.push(`- Selected text from page:\n${capturedSelection}`);
  if (consoleErrors) parts.push(`- Console errors:\n${consoleErrors}`);

  if (parts.length > 0) {
    prompt += '\n\n---\nContext:\n' + parts.join('\n');
  }

  if (capturedScreenshot) {
    prompt += '\n\nATTACHMENT:"(screenshot will be uploaded)"';
  }

  return prompt;
}

function updatePreview() {
  const section = document.getElementById('previewSection');
  if (!section.classList.contains('hidden')) {
    document.getElementById('promptPreview').textContent = buildPrompt() || '(empty — write a description above)';
  }
}

async function submitTask() {
  const description = document.getElementById('description').value.trim();
  const repos = getSelectedRepos();
  if (!description || repos.length === 0) return;
  const repo = repos.join(', ');

  const btn = document.getElementById('submitBtn');
  const errorBlock = document.getElementById('submitError');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Submitting...';
  errorBlock.classList.add('hidden');

  try {
    // Upload screenshot first if one was captured
    let attachmentUrl = null;
    if (capturedScreenshot) {
      btn.innerHTML = '<span class="spinner"></span> Uploading screenshot...';
      const uploadResult = await chrome.runtime.sendMessage({
        action: 'uploadScreenshot',
        dataUrl: capturedScreenshot,
      });
      if (uploadResult.success && uploadResult.url) {
        attachmentUrl = uploadResult.url;
      } else {
        showToast('Screenshot upload failed, submitting without it', 'error');
      }
    }

    // Build prompt, replacing placeholder with real attachment URL
    let prompt = buildPrompt();
    if (attachmentUrl) {
      prompt = prompt.replace('ATTACHMENT:"(screenshot will be uploaded)"', `ATTACHMENT:"${attachmentUrl}"`);
    } else {
      prompt = prompt.replace('\n\nATTACHMENT:"(screenshot will be uploaded)"', '');
    }

    btn.innerHTML = '<span class="spinner"></span> Submitting...';
    const response = await chrome.runtime.sendMessage({
      action: 'createSession',
      data: { prompt, repo, description },
    });

    if (response.success) {
      document.getElementById('description').value = '';
      document.getElementById('consoleErrors').value = '';
      document.getElementById('previewSection').classList.add('hidden');
      removeScreenshot();
      showToast('Session started!', 'success');
      switchTab('sessions');
    } else {
      showSubmitError(response.error, response.details);
    }
  } catch (err) {
    showSubmitError('Failed to create session.', err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Start Devin Session';
    updateSubmitState();
  }
}

function showSubmitError(message, details) {
  const block = document.getElementById('submitError');
  document.getElementById('submitErrorMsg').textContent = message;
  document.getElementById('submitErrorDetails').textContent = details || '';
  document.getElementById('submitErrorDetails').classList.add('hidden');
  block.classList.remove('hidden');
}

// ── Sessions ──────────────────────────────────────────────────────

async function loadSessions() {
  const { sessions = [] } = await chrome.storage.local.get('sessions');
  renderSessions(sessions);
}

function renderSessions(sessions) {
  const list = document.getElementById('sessionsList');
  const empty = document.getElementById('emptyState');

  if (sessions.length === 0) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  list.innerHTML = sessions.map(s => {
    const status = mapStatus(s.statusEnum, s.prUrl);
    const label = mapStatusLabel(s.statusEnum, s.prUrl);
    const safeDevinUrl = safeHref(s.devinUrl);
    const safePrUrl = safeHref(s.prUrl);
    const devinLink = safeDevinUrl
      ? `<a href="${escapeHtml(safeDevinUrl)}" target="_blank" class="session-link">Devin</a>`
      : '';
    const prLink = safePrUrl
      ? `<a href="${escapeHtml(safePrUrl)}" target="_blank" class="session-link pr-link">PR</a>`
      : '';

    return `<div class="session-item">
      <div class="session-header">
        <span class="session-repo">${escapeHtml(s.repo)}</span>
        <span class="session-status status-${status}">${label}</span>
      </div>
      <div class="session-desc">${escapeHtml(truncate(s.description, 60))}</div>
      <div class="session-footer">
        <span class="session-time">${timeAgo(s.createdAt)}</span>
        <div class="session-links">
          ${devinLink}
          ${prLink}
        </div>
      </div>
    </div>`;
  }).join('');
}

// ── Helpers ───────────────────────────────────────────────────────

function parseRepo(input) {
  // Try as GitHub URL first: https://github.com/owner/repo/...
  try {
    const url = new URL(input.includes('://') ? input : 'https://' + input);
    if (url.hostname === 'github.com' || url.hostname === 'www.github.com') {
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
    }
  } catch (_) {}
  // Fall back to owner/repo format
  if (/^[^/]+\/[^/]+$/.test(input)) return input;
  return null;
}

function mapStatus(statusEnum, prUrl) {
  if (!statusEnum) return 'running';
  const done = ['finished'];
  const failed = ['expired', 'suspend_requested', 'suspend_requested_frontend'];
  if (done.includes(statusEnum)) return 'done';
  if (failed.includes(statusEnum)) return 'failed';
  if (prUrl) return 'pr-ready';
  return 'running';
}

function mapStatusLabel(statusEnum, prUrl) {
  return { running: 'Running', done: 'Done', failed: 'Failed', 'pr-ready': 'PR Ready' }[mapStatus(statusEnum, prUrl)];
}

function timeAgo(ts) {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '...' : str;
}

function escapeHtml(str) {
  if (!str) return '';
  const el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
}

function safeHref(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return url;
  } catch (_) {}
  return '';
}

function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast toast-${type}`;
  setTimeout(() => toast.classList.add('hidden'), 3000);
}
