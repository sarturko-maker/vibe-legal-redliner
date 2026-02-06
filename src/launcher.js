/**
 * Launcher Popup Script
 * Handles mode selection and preference saving
 */

import { safeSetHTML } from './trusted-html.js';

// Check for saved preference and auto-open if set
async function checkSavedPreference() {
  const result = await chrome.storage.local.get(['preferredView']);
  if (result.preferredView) {
    if (result.preferredView === 'sidepanel') {
      openSidePanel();
    } else if (result.preferredView === 'fullscreen') {
      openFullScreen();
    }
  }
}

// Open Side Panel
async function openSidePanel() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    }
    window.close();
  } catch (error) {
    // Fallback to full screen if side panel fails
    openFullScreen();
  }
}

// Open Full Screen Tab
function openFullScreen() {
  chrome.tabs.create({ url: 'app.html' });
  window.close();
}

// Save preference
function savePreference(view) {
  const rememberCheckbox = document.getElementById('remember-choice');
  if (rememberCheckbox && rememberCheckbox.checked) {
    chrome.storage.local.set({ preferredView: view });
  }
}

// Update engine status display
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

// Check engine status
function checkEngineStatus() {
  chrome.runtime.sendMessage({ type: 'check-engine-status' }, (response) => {
    if (chrome.runtime.lastError) return;
    updateEngineStatus(response && response.ready);
  });
}

// Listen for engine ready
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'engine-ready') {
    updateEngineStatus(true);
  }
});

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  // Check for saved preference
  checkSavedPreference();

  // Check engine status once (no polling — engine loads on demand)
  checkEngineStatus();

  // Event listeners
  document.getElementById('open-sidepanel').addEventListener('click', () => {
    savePreference('sidepanel');
    openSidePanel();
  });

  document.getElementById('open-fullscreen').addEventListener('click', () => {
    savePreference('fullscreen');
    openFullScreen();
  });

  // Load saved remember preference
  chrome.storage.local.get(['preferredView'], (result) => {
    const checkbox = document.getElementById('remember-choice');
    if (result.preferredView && checkbox) {
      checkbox.checked = true;
    }
  });
});
