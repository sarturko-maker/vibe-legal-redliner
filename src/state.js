import { DEFAULT_PLAYBOOKS } from './config.js';

export const state = {
  currentPage: 'review',
  settings: {
    provider: 'gemini',
    apiKey: '',
    model: 'gemini-2.0-flash-exp',
    engine: 'adeu'
  },
  playbooks: [],
  selectedPlaybookId: 'nda-standard',
  editingPlaybookId: null,
  review: {
    file: null,
    job: null,
    result: null
  },
  batch: {
    files: [],
    jobs: [],
    isProcessing: false
  },
  pyodideReady: false,
  connectionTested: false,
  availableModels: [],
  isTestingConnection: false,
  rememberApiKey: true,
  disclaimerAcknowledged: false,
  auditLog: [],
  auditRetentionDays: 30
};

const API_KEY_STORAGE_KEYS = {
  gemini: 'geminiApiKey',
  openrouter: 'openrouterApiKey'
};

function storageKeyForProvider(provider) {
  return API_KEY_STORAGE_KEYS[provider] || `${provider}ApiKey`;
}

export async function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['settings', 'playbooks', 'customPlaybooks', 'rememberApiKey', 'auditLog', 'auditRetentionDays', 'disclaimerAcknowledged'], (result) => {
      if (result.settings) {
        state.settings = { ...state.settings, ...result.settings };
      }

      if (Array.isArray(result.playbooks) && result.playbooks.length > 0) {
        state.playbooks = result.playbooks;
      } else if (Array.isArray(result.customPlaybooks) && result.customPlaybooks.length > 0) {
        state.playbooks = [...DEFAULT_PLAYBOOKS, ...result.customPlaybooks];
        chrome.storage.local.set({ playbooks: state.playbooks });
        chrome.storage.local.remove('customPlaybooks');
      } else {
        state.playbooks = DEFAULT_PLAYBOOKS.map(p => ({ ...p }));
        chrome.storage.local.set({ playbooks: state.playbooks });
      }

      if (state.playbooks.length > 0 && !state.playbooks.some(p => p.id === state.selectedPlaybookId)) {
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

      const keyStorage = state.rememberApiKey ? chrome.storage.local : chrome.storage.session;
      const providerKey = storageKeyForProvider(state.settings.provider);
      keyStorage.get(['apiKey', 'geminiApiKey', 'openrouterApiKey'], (keyResult) => {
        if (keyResult[providerKey]) {
          state.settings.apiKey = keyResult[providerKey];
        } else if (keyResult.apiKey) {
          // Migrate legacy single-key storage to current provider
          state.settings.apiKey = keyResult.apiKey;
          keyStorage.set({ [providerKey]: keyResult.apiKey });
          keyStorage.remove('apiKey');
        }
        resolve();
      });
    });
  });
}

export function saveSettings() {
  const { apiKey, ...settingsWithoutKey } = state.settings;
  const providerKey = storageKeyForProvider(state.settings.provider);

  chrome.storage.local.set({
    settings: settingsWithoutKey,
    playbooks: state.playbooks,
    rememberApiKey: state.rememberApiKey
  });

  if (state.rememberApiKey) {
    chrome.storage.local.set({ [providerKey]: apiKey });
    chrome.storage.session.remove(providerKey);
  } else {
    chrome.storage.session.set({ [providerKey]: apiKey });
    chrome.storage.local.remove(providerKey);
  }
}

export function loadApiKeyForProvider(provider) {
  return new Promise((resolve) => {
    const keyStorage = state.rememberApiKey ? chrome.storage.local : chrome.storage.session;
    const providerKey = storageKeyForProvider(provider);
    keyStorage.get([providerKey], (result) => {
      resolve(result[providerKey] || '');
    });
  });
}

export async function hashFilename(filename) {
  const data = new TextEncoder().encode(filename);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export function purgeOldAuditEntries() {
  const cutoff = Date.now() - (state.auditRetentionDays * 24 * 60 * 60 * 1000);
  const prevLength = state.auditLog.length;
  state.auditLog = state.auditLog.filter(e => new Date(e.timestamp).getTime() > cutoff);
  if (state.auditLog.length !== prevLength) {
    chrome.storage.local.set({ auditLog: state.auditLog });
  }
}

export const MAX_AUDIT_ENTRIES = 500;

export async function writeAuditLogEntry({ filename, fileSizeBytes, provider, model, editsReturned, editsApplied, editsSkipped, status, errorMessage }) {
  purgeOldAuditEntries();

  while (state.auditLog.length >= MAX_AUDIT_ENTRIES) {
    state.auditLog.shift();
  }

  const documentHash = await hashFilename(filename);
  const entry = {
    timestamp: new Date().toISOString(),
    documentHash,
    fileSizeBytes,
    provider,
    model,
    editsReturned,
    status
  };
  if (editsApplied != null) entry.editsApplied = editsApplied;
  if (editsSkipped != null) entry.editsSkipped = editsSkipped;
  if (errorMessage) entry.errorMessage = errorMessage;

  state.auditLog.push(entry);
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
