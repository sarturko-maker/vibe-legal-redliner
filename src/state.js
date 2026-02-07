/**
 * State management and storage helpers
 */

import { DEFAULT_PLAYBOOKS } from './config.js';

// ============================================================================
// STATE
// ============================================================================

export const state = {
  // Navigation
  currentPage: 'review',

  // Settings
  settings: {
    provider: 'gemini',
    apiKey: '',
    model: 'gemini-2.0-flash-exp',
    engine: 'adeu'
  },

  // Playbooks (seeded from DEFAULT_PLAYBOOKS on first install, then stored)
  playbooks: [],
  selectedPlaybookId: 'nda-standard',
  editingPlaybookId: null,

  // Review page
  review: {
    file: null,
    job: null,
    result: null
  },

  // Batch page
  batch: {
    files: [],          // Array of File objects (max 5)
    jobs: [],           // Array of { id, fileName, fileSize, status, progress, phase, editCount, result, error }
    isProcessing: false  // True while the sequential queue is running
  },

  // UI state
  pyodideReady: false,
  connectionTested: false,
  availableModels: [],
  isTestingConnection: false,
  rememberApiKey: true,

  // Disclaimer
  disclaimerAcknowledged: false,

  // Audit log
  auditLog: [],
  auditRetentionDays: 30
};

// ============================================================================
// STORAGE HELPERS
// ============================================================================

export async function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['settings', 'playbooks', 'customPlaybooks', 'rememberApiKey', 'auditLog', 'auditRetentionDays', 'disclaimerAcknowledged'], (result) => {
      if (result.settings) {
        state.settings = { ...state.settings, ...result.settings };
      }

      // Load playbooks from storage, seeding examples on first install
      if (Array.isArray(result.playbooks) && result.playbooks.length > 0) {
        state.playbooks = result.playbooks;
      } else if (Array.isArray(result.customPlaybooks) && result.customPlaybooks.length > 0) {
        // Migrate pre-refactor format: merge examples + user playbooks
        state.playbooks = [...DEFAULT_PLAYBOOKS, ...result.customPlaybooks];
        chrome.storage.local.set({ playbooks: state.playbooks });
        chrome.storage.local.remove('customPlaybooks');
      } else {
        // First install — seed example playbooks
        state.playbooks = DEFAULT_PLAYBOOKS.map(p => ({ ...p }));
        chrome.storage.local.set({ playbooks: state.playbooks });
      }

      // Validate selected playbook still exists
      if (state.playbooks.length > 0 && !state.playbooks.find(p => p.id === state.selectedPlaybookId)) {
        state.selectedPlaybookId = state.playbooks[0].id;
      }

      state.disclaimerAcknowledged = result.disclaimerAcknowledged === true;
      state.rememberApiKey = result.rememberApiKey !== false;
      if (Array.isArray(result.auditLog)) {
        state.auditLog = result.auditLog;
      }
      if (result.auditRetentionDays) {
        state.auditRetentionDays = result.auditRetentionDays;
      }

      // Load API key from the appropriate storage area
      const keyStorage = state.rememberApiKey ? chrome.storage.local : chrome.storage.session;
      keyStorage.get(['apiKey'], (keyResult) => {
        if (keyResult.apiKey) {
          state.settings.apiKey = keyResult.apiKey;
        }
        resolve();
      });
    });
  });
}

export function saveSettings() {
  const { apiKey, ...settingsWithoutKey } = state.settings;

  chrome.storage.local.set({
    settings: settingsWithoutKey,
    playbooks: state.playbooks,
    rememberApiKey: state.rememberApiKey
  });

  // Store API key in the correct area and clear the other
  if (state.rememberApiKey) {
    chrome.storage.local.set({ apiKey });
    chrome.storage.session.remove('apiKey');
  } else {
    chrome.storage.session.set({ apiKey });
    chrome.storage.local.remove('apiKey');
  }
}

// ============================================================================
// AUDIT LOG
// ============================================================================

export async function hashFilename(filename) {
  const data = new TextEncoder().encode(filename);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export function purgeOldAuditEntries() {
  const cutoff = Date.now() - (state.auditRetentionDays * 24 * 60 * 60 * 1000);
  const before = state.auditLog.length;
  state.auditLog = state.auditLog.filter(
    entry => new Date(entry.timestamp).getTime() > cutoff
  );
  if (state.auditLog.length !== before) {
    chrome.storage.local.set({ auditLog: state.auditLog });
  }
}

export const MAX_AUDIT_ENTRIES = 500;

export async function writeAuditLogEntry({ filename, fileSizeBytes, provider, model, editsReturned, status }) {
  purgeOldAuditEntries();

  // Enforce max entries — drop oldest when full
  while (state.auditLog.length >= MAX_AUDIT_ENTRIES) {
    state.auditLog.shift();
  }

  const documentHash = await hashFilename(filename);
  state.auditLog.push({
    timestamp: new Date().toISOString(),
    documentHash,
    fileSizeBytes,
    provider,
    model,
    editsReturned,
    status
  });
  chrome.storage.local.set({ auditLog: state.auditLog });
}

export function exportAuditLog() {
  const json = JSON.stringify(state.auditLog, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `vibe-legal-audit-log-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function clearAuditLog() {
  state.auditLog = [];
  chrome.storage.local.set({ auditLog: [] });
}
