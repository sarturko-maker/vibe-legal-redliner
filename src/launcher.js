import { safeSetHTML } from './trusted-html.js';

async function checkSavedPreference() {
  const { preferredView } = await chrome.storage.local.get(['preferredView']);
  if (preferredView === 'sidepanel') openSidePanel();
  else if (preferredView === 'fullscreen') openFullScreen();
}

async function openSidePanel() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    }
    window.close();
  } catch {
    openFullScreen();
  }
}

function openFullScreen() {
  chrome.tabs.create({ url: 'app.html' });
  window.close();
}

function savePreference(view) {
  const rememberCheckbox = document.getElementById('remember-choice');
  if (rememberCheckbox?.checked) {
    chrome.storage.local.set({ preferredView: view });
  }
}

function updateEngineStatus(ready) {
  const statusEl = document.getElementById('engine-status');
  if (ready) {
    safeSetHTML(statusEl, `
      <span class="status-dot"></span>
      <span>Engine ready</span>
    `);
    statusEl.classList.add('ready');
  } else {
    safeSetHTML(statusEl, `
      <span class="status-dot"></span>
      <span>Engine loads on first use</span>
    `);
    statusEl.classList.remove('ready');
  }
}

function checkEngineStatus() {
  chrome.runtime.sendMessage({ type: 'check-engine-status' }, (response) => {
    if (chrome.runtime.lastError) return;
    updateEngineStatus(response?.ready);
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'engine-ready') {
    updateEngineStatus(true);
  }
});

document.addEventListener('DOMContentLoaded', () => {
  checkSavedPreference();
  checkEngineStatus();

  document.getElementById('open-sidepanel').addEventListener('click', () => {
    savePreference('sidepanel');
    openSidePanel();
  });

  document.getElementById('open-fullscreen').addEventListener('click', () => {
    savePreference('fullscreen');
    openFullScreen();
  });

  chrome.storage.local.get(['preferredView'], (result) => {
    if (result.preferredView) {
      const checkbox = document.getElementById('remember-choice');
      if (checkbox) checkbox.checked = true;
    }
  });
});
