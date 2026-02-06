/**
 * Vibe Legal Redliner - Main Application
 * Chrome Extension with full server functionality
 * Non-module version for Chrome extension
 */

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

const state = {
  // Navigation
  currentPage: 'review',

  // Settings
  settings: {
    provider: 'gemini',
    apiKey: '',
    model: 'gemini-2.0-flash-exp',
    engine: 'adeu'
  },

  // Playbooks
  playbooks: [...DEFAULT_PLAYBOOKS],
  customPlaybooks: [],
  selectedPlaybookId: 'nda-standard',

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

  // Audit log
  auditLog: [],
  auditRetentionDays: 30
};

// ============================================================================
// STORAGE HELPERS
// ============================================================================

async function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['settings', 'customPlaybooks', 'rememberApiKey', 'auditLog', 'auditRetentionDays'], (result) => {
      if (result.settings) {
        state.settings = { ...state.settings, ...result.settings };
      }
      if (result.customPlaybooks) {
        state.customPlaybooks = result.customPlaybooks;
        state.playbooks = [...DEFAULT_PLAYBOOKS, ...state.customPlaybooks];
      }
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

function saveSettings() {
  const { apiKey, ...settingsWithoutKey } = state.settings;

  chrome.storage.local.set({
    settings: settingsWithoutKey,
    customPlaybooks: state.customPlaybooks,
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

async function hashFilename(filename) {
  const data = new TextEncoder().encode(filename);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function purgeOldAuditEntries() {
  const cutoff = Date.now() - (state.auditRetentionDays * 24 * 60 * 60 * 1000);
  const before = state.auditLog.length;
  state.auditLog = state.auditLog.filter(
    entry => new Date(entry.timestamp).getTime() > cutoff
  );
  if (state.auditLog.length !== before) {
    chrome.storage.local.set({ auditLog: state.auditLog });
  }
}

async function writeAuditLogEntry({ filename, fileSizeBytes, provider, model, editsReturned, status }) {
  purgeOldAuditEntries();
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

function exportAuditLog() {
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

function clearAuditLog() {
  state.auditLog = [];
  chrome.storage.local.set({ auditLog: [] });
  render();
}

// ============================================================================
// ENGINE COMMUNICATION (via Background Service Worker)
// ============================================================================

const ENGINE_INIT_TIMEOUT_MS = 60000;
let engineInitPromise = null;

/**
 * Ensures the Pyodide engine is ready. Creates the offscreen document and
 * waits for Pyodide to initialize if needed. Returns immediately when already
 * ready. Uses a singleton promise so concurrent callers share one attempt.
 * On failure, clears the cached promise so the next call retries fresh.
 */
function ensureEngineReady() {
  if (state.pyodideReady) return Promise.resolve();
  if (engineInitPromise) return engineInitPromise;

  engineInitPromise = Promise.race([
    new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'ensure-engine' }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error('Engine failed to initialise. Please reload the extension.'));
          return;
        }
        if (response && response.ready) {
          state.pyodideReady = true;
          render();
          resolve();
        } else {
          reject(new Error(response?.error || 'Engine failed to initialise. Please reload the extension.'));
        }
      });
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Engine failed to initialise within 60 seconds. Please reload the extension.')), ENGINE_INIT_TIMEOUT_MS)
    )
  ]).catch((err) => {
    // Clear cached promise so next call retries fresh
    engineInitPromise = null;
    throw err;
  });

  return engineInitPromise;
}

// ============================================================================
// FILE HANDLING
// ============================================================================

async function extractTextFromDocx(arrayBuffer) {
  const zip = await JSZip.loadAsync(arrayBuffer);
  const documentXml = await zip.file('word/document.xml')?.async('string');

  if (!documentXml) {
    throw new Error('Invalid DOCX file: missing document.xml');
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(documentXml, 'application/xml');
  const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

  const paragraphs = [];
  const pElements = doc.getElementsByTagNameNS(ns, 'p');

  for (const p of pElements) {
    const texts = [];
    const tElements = p.getElementsByTagNameNS(ns, 't');
    for (const t of tElements) {
      texts.push(t.textContent || '');
    }
    if (texts.length > 0) {
      paragraphs.push(texts.join(''));
    }
  }

  return paragraphs.join('\n\n');
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// Maximum file size: 50MB
const MAX_FILE_SIZE = 50 * 1024 * 1024;

// Maximum text length to send to AI: 500KB
const MAX_TEXT_LENGTH = 500 * 1024;

/**
 * Verify binary data is a valid ZIP (DOCX) file
 */
function isValidZipFile(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < 4) return false;
  // ZIP files start with PK\x03\x04
  return bytes[0] === 80 && bytes[1] === 75 && bytes[2] === 3 && bytes[3] === 4;
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function downloadFile(data, filename) {
  const blob = new Blob([data], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ============================================================================
// DOCUMENT PROCESSING
// ============================================================================

async function processDocument() {
  const { file } = state.review;
  const playbook = state.playbooks.find(p => p.id === state.selectedPlaybookId);

  if (!file) {
    alert('Please upload a contract file');
    return;
  }

  if (file.size > MAX_FILE_SIZE) {
    alert('File is too large. Maximum size is 50MB.');
    return;
  }

  if (!state.settings.apiKey) {
    alert('Please configure your API key in Settings');
    state.currentPage = 'settings';
    render();
    return;
  }

  if (!playbook) {
    alert('Please select a playbook');
    return;
  }

  // Initialize job
  state.review.job = {
    id: Date.now().toString(),
    status: JOB_STATUS.PROCESSING,
    progress: 5,
    current_phase: 'Reading document...',
    operations_complete: 0,
    operations_total: 0,
    errors: []
  };
  state.review.result = null;
  render();

  // Start engine init in parallel with file reading + AI analysis
  const engineReady = ensureEngineReady();

  try {
    // Read file
    const arrayBuffer = await file.arrayBuffer();
    const contractBytes = new Uint8Array(arrayBuffer);

    // Validate DOCX file structure
    if (!isValidZipFile(contractBytes)) {
      throw new Error('Invalid file format. Please upload a valid .docx file.');
    }

    const contractText = await extractTextFromDocx(arrayBuffer);

    // Validate extracted text
    if (!contractText || contractText.trim().length === 0) {
      throw new Error('Document appears to be empty. Please upload a document with text content.');
    }

    if (contractText.length > MAX_TEXT_LENGTH) {
      throw new Error('Document text is too large for AI analysis. Please use a smaller document.');
    }

    state.review.job.progress = 20;
    state.review.job.current_phase = 'Analyzing with AI...';
    render();

    // Call AI
    const aiResponse = await analyzeContract({
      provider: state.settings.provider,
      apiKey: state.settings.apiKey,
      model: state.settings.model,
      contractText,
      playbookText: playbook.playbookText
    });

    state.review.job.progress = 60;
    state.review.job.operations_total = aiResponse.edits.length;
    state.review.job.current_phase = `Found ${aiResponse.edits.length} changes. Applying redlines...`;
    render();

    if (aiResponse.edits.length === 0) {
      state.review.job.status = JOB_STATUS.COMPLETE;
      state.review.job.progress = 100;
      state.review.job.current_phase = 'No changes needed';
      writeAuditLogEntry({ filename: file.name, fileSizeBytes: file.size, provider: state.settings.provider, model: state.settings.model, editsReturned: 0, status: 'success' });
      render();
      return;
    }

    // Wait for engine if AI finished first
    if (!state.pyodideReady) {
      state.review.job.current_phase = 'Initialising engine...';
      render();
      await engineReady;
    }

    // Send to background service worker -> offscreen document
    state.review.job.current_phase = 'Applying track changes...';
    render();

    state.review.job.progress = 80;
    render();

    chrome.runtime.sendMessage({
      type: 'process-redline',
      contractBytes: Array.from(contractBytes),
      edits: aiResponse.edits
    }, (response) => {
      // Check for Chrome runtime errors
      if (chrome.runtime.lastError) {
        state.review.job.status = JOB_STATUS.ERROR;
        state.review.job.errors = ['Communication error with background service. Please reload the extension.'];
        writeAuditLogEntry({ filename: file.name, fileSizeBytes: file.size, provider: state.settings.provider, model: state.settings.model, editsReturned: aiResponse.edits.length, status: 'error' });
        render();
        return;
      }

      if (response && response.success) {
        state.review.result = new Uint8Array(response.result);
        state.review.job.status = JOB_STATUS.COMPLETE;
        state.review.job.progress = 100;
        state.review.job.current_phase = 'Complete';
        writeAuditLogEntry({ filename: file.name, fileSizeBytes: file.size, provider: state.settings.provider, model: state.settings.model, editsReturned: aiResponse.edits.length, status: 'success' });
      } else {
        state.review.job.status = JOB_STATUS.ERROR;
        // Sanitize error message to avoid leaking internal details
        state.review.job.errors = ['Document processing failed. Please try again.'];
        writeAuditLogEntry({ filename: file.name, fileSizeBytes: file.size, provider: state.settings.provider, model: state.settings.model, editsReturned: aiResponse.edits.length, status: 'error' });
      }
      render();
    });

  } catch (error) {
    state.review.job.status = JOB_STATUS.ERROR;
    // Show user-friendly error messages
    let userMessage = error.message;
    if (error.message.includes('API') || error.message.includes('key')) {
      userMessage = error.message; // Keep API-related messages as they're user-relevant
    } else if (error.message.includes('Invalid') || error.message.includes('empty') || error.message.includes('large')) {
      userMessage = error.message; // Keep validation messages
    } else {
      userMessage = 'An error occurred while processing your document. Please try again.';
    }
    state.review.job.errors = [userMessage];
    writeAuditLogEntry({ filename: file.name, fileSizeBytes: file.size, provider: state.settings.provider, model: state.settings.model, editsReturned: 0, status: 'error' });
    render();
  }
}

// ============================================================================
// BATCH PROCESSING
// ============================================================================

const MAX_BATCH_FILES = 5;

async function processBatch() {
  const { files, jobs } = state.batch;
  const playbook = state.playbooks.find(p => p.id === state.selectedPlaybookId);

  if (!files.length) {
    alert('Please upload at least one contract file');
    return;
  }

  if (!state.settings.apiKey) {
    alert('Please configure your API key in Settings');
    state.currentPage = 'settings';
    render();
    return;
  }

  if (!playbook) {
    alert('Please select a playbook');
    return;
  }

  state.batch.isProcessing = true;

  // Start engine init in parallel with processing
  const engineReady = ensureEngineReady();

  // Initialize all jobs as queued
  state.batch.jobs = files.map((file, i) => ({
    id: Date.now().toString() + '-' + i,
    fileName: file.name,
    fileSize: file.size,
    status: JOB_STATUS.QUEUED,
    progress: 0,
    phase: 'Queued',
    editCount: 0,
    result: null,
    error: null
  }));
  render();

  // Process sequentially
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const job = state.batch.jobs[i];

    job.status = JOB_STATUS.PROCESSING;
    job.progress = 5;
    job.phase = 'Reading document...';
    render();

    try {
      const arrayBuffer = await file.arrayBuffer();
      const contractBytes = new Uint8Array(arrayBuffer);

      if (!isValidZipFile(contractBytes)) {
        throw new Error('Invalid file format. Please upload a valid .docx file.');
      }

      const contractText = await extractTextFromDocx(arrayBuffer);

      if (!contractText || contractText.trim().length === 0) {
        throw new Error('Document appears to be empty.');
      }

      if (contractText.length > MAX_TEXT_LENGTH) {
        throw new Error('Document text is too large for AI analysis.');
      }

      job.progress = 20;
      job.phase = 'Analyzing with AI...';
      render();

      const aiResponse = await analyzeContract({
        provider: state.settings.provider,
        apiKey: state.settings.apiKey,
        model: state.settings.model,
        contractText,
        playbookText: playbook.playbookText
      });

      job.progress = 60;
      job.editCount = aiResponse.edits.length;
      job.phase = `Found ${aiResponse.edits.length} changes. Applying redlines...`;
      render();

      if (aiResponse.edits.length === 0) {
        job.status = JOB_STATUS.COMPLETE;
        job.progress = 100;
        job.phase = 'No changes needed';
        writeAuditLogEntry({ filename: file.name, fileSizeBytes: file.size, provider: state.settings.provider, model: state.settings.model, editsReturned: 0, status: 'success' });
        render();
        continue;
      }

      // Wait for engine if AI finished first
      if (!state.pyodideReady) {
        job.phase = 'Initialising engine...';
        render();
        await engineReady;
      }

      job.progress = 80;
      job.phase = 'Applying track changes...';
      render();

      // Wrap the chrome.runtime.sendMessage callback in a Promise
      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          type: 'process-redline',
          contractBytes: Array.from(contractBytes),
          edits: aiResponse.edits
        }, (resp) => {
          if (chrome.runtime.lastError) {
            reject(new Error('Communication error with background service.'));
            return;
          }
          resolve(resp);
        });
      });

      if (response && response.success) {
        job.result = new Uint8Array(response.result);
        job.status = JOB_STATUS.COMPLETE;
        job.progress = 100;
        job.phase = 'Complete';
        writeAuditLogEntry({ filename: file.name, fileSizeBytes: file.size, provider: state.settings.provider, model: state.settings.model, editsReturned: job.editCount, status: 'success' });
      } else {
        throw new Error(response?.error || 'Document processing failed.');
      }

    } catch (error) {
      job.status = JOB_STATUS.ERROR;
      job.progress = 0;
      job.error = error.message || 'An error occurred while processing this document.';
      writeAuditLogEntry({ filename: file.name, fileSizeBytes: file.size, provider: state.settings.provider, model: state.settings.model, editsReturned: job.editCount, status: 'error' });
    }

    render();

    // Small delay between files to avoid API rate limiting
    if (i < files.length - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  state.batch.isProcessing = false;
  render();
}

function downloadBatchFile(index) {
  const job = state.batch.jobs[index];
  if (!job || !job.result) return;
  const baseName = job.fileName.replace(/\.docx$/i, '');
  downloadFile(job.result, `redlined_${baseName}.docx`);
}

async function downloadAllBatch() {
  const completedJobs = state.batch.jobs
    .filter(job => job.status === JOB_STATUS.COMPLETE && job.result);

  if (!completedJobs.length) return;

  const zip = new JSZip();
  for (const job of completedJobs) {
    const baseName = job.fileName.replace(/\.docx$/i, '');
    zip.file(`redlined_${baseName}.docx`, job.result);
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'redlined_batch.zip';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function addBatchFiles(newFiles) {
  const currentCount = state.batch.files.length;
  const available = MAX_BATCH_FILES - currentCount;

  if (available <= 0) {
    alert(`Maximum ${MAX_BATCH_FILES} files allowed.`);
    return;
  }

  const validFiles = [];
  for (const file of newFiles) {
    if (!file.name.toLowerCase().endsWith('.docx')) {
      alert(`"${file.name}" is not a .docx file. Skipped.`);
      continue;
    }
    if (file.size > MAX_FILE_SIZE) {
      alert(`"${file.name}" is too large (max 50MB). Skipped.`);
      continue;
    }
    if (validFiles.length >= available) {
      alert(`Only ${available} more file(s) can be added. Some files were skipped.`);
      break;
    }
    validFiles.push(file);
  }

  if (validFiles.length > 0) {
    state.batch.files = [...state.batch.files, ...validFiles];
    state.batch.jobs = []; // Reset jobs when files change
    render();
  }
}

// ============================================================================
// PLAYBOOK MANAGEMENT
// ============================================================================

async function createPlaybook(name, description, fileContent) {
  // Generate safe ID: lowercase, alphanumeric with dashes, must start with letter
  let id = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  // Ensure ID starts with a letter
  if (!/^[a-z]/.test(id)) {
    id = 'playbook-' + id;
  }
  // Add timestamp to ensure uniqueness
  id = id + '-' + Date.now().toString(36);

  let playbookText = description || `Custom playbook: ${name}`;

  if (fileContent) {
    try {
      playbookText = await extractTextFromDocx(fileContent);
    } catch (e) {
      // Fall back to description if extraction fails
      playbookText = description || `Custom playbook: ${name}`;
    }
  }

  const newPlaybook = {
    id,
    name,
    description: description || '',
    playbookText,
    isDefault: false
  };

  state.customPlaybooks.push(newPlaybook);
  state.playbooks = [...DEFAULT_PLAYBOOKS, ...state.customPlaybooks];
  saveSettings();
  render();
}

function deletePlaybook(id) {
  const playbook = state.playbooks.find(p => p.id === id);
  if (playbook?.isDefault) {
    alert('Cannot delete default playbooks');
    return;
  }

  state.customPlaybooks = state.customPlaybooks.filter(p => p.id !== id);
  state.playbooks = [...DEFAULT_PLAYBOOKS, ...state.customPlaybooks];

  if (state.selectedPlaybookId === id) {
    state.selectedPlaybookId = 'nda-standard';
  }

  saveSettings();
  render();
}

// ============================================================================
// CONNECTION TESTING
// ============================================================================

async function handleTestConnection() {
  state.isTestingConnection = true;
  render();

  const result = await testConnection({
    provider: state.settings.provider,
    apiKey: state.settings.apiKey
  });

  state.isTestingConnection = false;
  state.connectionTested = true;

  if (result.success) {
    state.availableModels = result.models;
    // Set default model if current not in list
    if (!result.models.find(m => m.id === state.settings.model) && result.models.length > 0) {
      state.settings.model = result.models[0].id;
    }
  } else {
    state.availableModels = [];
    alert('Connection failed: ' + result.error);
  }

  saveSettings();
  render();
}

// ============================================================================
// EVENT HANDLERS
// ============================================================================

function handleClick(e) {
  const target = e.target.closest('[data-action]');
  if (!target) return;

  const action = target.dataset.action;

  switch (action) {
    case 'nav':
      state.currentPage = target.dataset.page;
      render();
      break;

    case 'upload-contract':
      document.getElementById('contract-input').click();
      break;

    case 'clear-contract':
      state.review.file = null;
      state.review.job = null;
      state.review.result = null;
      render();
      break;

    case 'process':
      processDocument();
      break;

    case 'download':
      if (state.review.result && state.review.file) {
        const baseName = state.review.file.name.replace(/\.docx$/i, '');
        downloadFile(state.review.result, `redlined_${baseName}.docx`);
      }
      break;

    case 'select-playbook':
      state.selectedPlaybookId = target.dataset.id;
      render();
      break;

    case 'test-connection':
      handleTestConnection();
      break;

    case 'new-playbook':
      showNewPlaybookModal();
      break;

    case 'delete-playbook':
      if (confirm('Delete this playbook?')) {
        deletePlaybook(target.dataset.id);
      }
      break;

    case 'batch-upload':
      document.getElementById('batch-file-input').click();
      break;

    case 'batch-remove': {
      const idx = parseInt(target.dataset.index, 10);
      state.batch.files.splice(idx, 1);
      state.batch.jobs = [];
      render();
      break;
    }

    case 'batch-clear':
      state.batch.files = [];
      state.batch.jobs = [];
      state.batch.isProcessing = false;
      render();
      break;

    case 'batch-process':
      processBatch();
      break;

    case 'batch-download': {
      const dlIdx = parseInt(target.dataset.index, 10);
      downloadBatchFile(dlIdx);
      break;
    }

    case 'batch-download-all':
      downloadAllBatch();
      break;

    case 'export-audit-log':
      exportAuditLog();
      break;

    case 'clear-audit-log':
      if (confirm('Delete all audit log entries? This cannot be undone.')) {
        clearAuditLog();
      }
      break;
  }
}

function handleChange(e) {
  const { name, value, files } = e.target;

  if (name === 'contract' && files?.length) {
    const file = files[0];
    if (!file.name.toLowerCase().endsWith('.docx')) {
      alert('Please select a .docx file');
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      alert('File is too large. Maximum size is 50MB.');
      return;
    }
    state.review.file = file;
    state.review.job = null;
    state.review.result = null;
    render();
    return;
  }

  if (name === 'provider') {
    state.settings.provider = value;
    state.connectionTested = false;
    state.availableModels = [];
    // Set default model for provider
    const provider = AI_PROVIDERS[value];
    const defaultModel = provider?.models?.find(m => m.default);
    state.settings.model = defaultModel?.id || provider?.models?.[0]?.id || '';
    saveSettings();
    render();
    return;
  }

  if (name === 'apiKey') {
    state.settings.apiKey = value;
    state.connectionTested = false;
    saveSettings();
    return;
  }

  if (name === 'rememberApiKey') {
    state.rememberApiKey = e.target.checked;
    saveSettings();
    return;
  }

  if (name === 'model') {
    state.settings.model = value;
    saveSettings();
    return;
  }

  if (name === 'playbook-select') {
    state.selectedPlaybookId = value;
    render();
    return;
  }

  if (name === 'auditRetentionDays') {
    state.auditRetentionDays = parseInt(value, 10);
    chrome.storage.local.set({ auditRetentionDays: state.auditRetentionDays });
    purgeOldAuditEntries();
    render();
    return;
  }

  if (name === 'batch-files' && files?.length) {
    addBatchFiles(Array.from(files));
    e.target.value = ''; // Reset so same files can be re-selected
    return;
  }
}

function handleDrop(e) {
  e.preventDefault();
  const dropZone = e.target.closest('.file-upload');
  if (!dropZone) return;

  dropZone.classList.remove('dragover');

  const files = e.dataTransfer.files;
  if (!files.length) return;

  // Check if this is the batch upload zone
  if (dropZone.classList.contains('batch-upload-zone')) {
    addBatchFiles(Array.from(files));
    return;
  }

  const file = files[0];
  if (!file.name.toLowerCase().endsWith('.docx')) {
    alert('Please drop a .docx file');
    return;
  }
  if (file.size > MAX_FILE_SIZE) {
    alert('File is too large. Maximum size is 50MB.');
    return;
  }

  state.review.file = file;
  state.review.job = null;
  state.review.result = null;
  render();
}

// ============================================================================
// MODAL
// ============================================================================

function showNewPlaybookModal() {
  const modal = document.createElement('div');
  modal.id = 'modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-content">
      <div class="modal-header">
        <h2>New Playbook</h2>
        <button class="modal-close" id="modal-close-btn">&times;</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label class="form-label">Name *</label>
          <input type="text" id="playbook-name" class="form-input" placeholder="e.g., IT Services Agreement">
        </div>
        <div class="form-group">
          <label class="form-label">Playbook Rules</label>
          <textarea id="playbook-desc" class="form-textarea" rows="6"
            placeholder="Enter your playbook rules here, or upload a .docx file below..."></textarea>
        </div>
        <div class="form-group">
          <label class="form-label">Or Upload Document</label>
          <input type="file" id="playbook-file" accept=".docx" class="form-input">
          <p class="form-hint">Upload a .docx with your playbook rules</p>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="modal-cancel-btn">Cancel</button>
        <button class="btn btn-primary" id="modal-create-btn">Create Playbook</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  // Add click handlers
  modal.querySelector('#modal-close-btn').addEventListener('click', closeModal);
  modal.querySelector('#modal-cancel-btn').addEventListener('click', closeModal);
  modal.querySelector('#modal-create-btn').addEventListener('click', handleCreatePlaybook);

  // Close when clicking outside modal content
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeModal();
    }
  });
}

function handleCreatePlaybook() {
  const name = document.getElementById('playbook-name').value.trim();
  const desc = document.getElementById('playbook-desc').value.trim();
  const fileInput = document.getElementById('playbook-file');
  const file = fileInput?.files?.[0];

  if (!name) {
    alert('Please enter a playbook name');
    return;
  }

  if (file) {
    file.arrayBuffer().then(buffer => {
      createPlaybook(name, desc, buffer);
      closeModal();
    });
  } else if (desc) {
    createPlaybook(name, desc, null);
    closeModal();
  } else {
    alert('Please enter playbook rules or upload a document');
  }
}

function closeModal() {
  const modal = document.getElementById('modal');
  if (modal) {
    modal.remove();
  }
}

// ============================================================================
// RENDER
// ============================================================================

function render() {
  const app = document.getElementById('app');

  app.innerHTML = `
    <div class="app-container">
      <!-- Sidebar -->
      <nav class="sidebar">
        <div class="sidebar-header">
          <div class="logo">VL</div>
          <div class="logo-text">
            <strong>Vibe Legal</strong>
            <span>Redliner</span>
          </div>
        </div>
        <ul class="nav-list">
          <li class="nav-item ${state.currentPage === 'review' ? 'active' : ''}" data-action="nav" data-page="review">
            Review
          </li>
          <li class="nav-item ${state.currentPage === 'batch' ? 'active' : ''}" data-action="nav" data-page="batch">
            Batch
          </li>
          <li class="nav-item ${state.currentPage === 'playbooks' ? 'active' : ''}" data-action="nav" data-page="playbooks">
            Playbooks
          </li>
          <li class="nav-item ${state.currentPage === 'settings' ? 'active' : ''}" data-action="nav" data-page="settings">
            Settings
          </li>
        </ul>
        <div class="sidebar-footer">
          ${state.pyodideReady ? `
            <div class="pyodide-status ready">
              <span class="status-dot"></span>
              Ready
            </div>
          ` : ''}
        </div>
      </nav>

      <!-- Main Content -->
      <main class="main-content">
        ${renderPage()}
      </main>
    </div>
  `;
}

function renderPage() {
  switch (state.currentPage) {
    case 'review': return renderReviewPage();
    case 'batch': return renderBatchPage();
    case 'playbooks': return renderPlaybooksPage();
    case 'settings': return renderSettingsPage();
    default: return renderReviewPage();
  }
}

function renderReviewPage() {
  const { file, job, result } = state.review;
  const playbook = state.playbooks.find(p => p.id === state.selectedPlaybookId);

  return `
    <div class="page">
      <div class="page-header">
        <h1>Review Document</h1>
        <p>Upload a contract to analyze against your playbook</p>
      </div>

      <!-- File Upload -->
      <div class="card">
        <div class="card-header">
          <h3>Contract</h3>
          ${file ? `<button class="btn-text" data-action="clear-contract">Clear</button>` : ''}
        </div>
        <div class="file-upload ${file ? 'has-file' : ''}" data-action="upload-contract">
          <input type="file" id="contract-input" name="contract" accept=".docx" style="display: none">
          ${file ? `
            <div class="file-icon">&#128196;</div>
            <div class="file-info">
              <span class="file-name">${escapeHtml(file.name)}</span>
              <span class="file-size">${formatFileSize(file.size)}</span>
            </div>
          ` : `
            <div class="file-icon">&#128196;</div>
            <div class="file-text">Drop contract here or click to browse</div>
            <div class="file-hint">.docx files only</div>
          `}
        </div>
      </div>

      <!-- Playbook Selection -->
      <div class="card">
        <div class="card-header">
          <h3>Playbook</h3>
        </div>
        <select class="form-select" name="playbook-select">
          ${state.playbooks.map(p => `
            <option value="${escapeHtml(p.id)}" ${p.id === state.selectedPlaybookId ? 'selected' : ''}>
              ${escapeHtml(p.name)}
            </option>
          `).join('')}
        </select>
        ${playbook ? `<p class="form-hint">${escapeHtml(playbook.description)}</p>` : ''}
      </div>

      <!-- Progress / Result -->
      ${job ? renderJobStatus(job, result) : ''}

      <!-- Action Button -->
      ${!result ? `
        <button class="btn btn-primary btn-full" data-action="process"
          ${!file || job?.status === JOB_STATUS.PROCESSING ? 'disabled' : ''}>
          ${job?.status === JOB_STATUS.PROCESSING ? `
            <span class="spinner"></span> Processing...
          ` : 'Analyze & Redline'}
        </button>
      ` : `
        <button class="btn btn-success btn-full" data-action="download">
          Download Redlined Document
        </button>
      `}
    </div>
  `;
}

function renderJobStatus(job, result) {
  if (job.status === JOB_STATUS.ERROR) {
    return `
      <div class="status-card error">
        <div class="status-icon">&#10060;</div>
        <div class="status-text">
          <strong>Error</strong>
          <p>${escapeHtml(job.errors[0] || 'Unknown error')}</p>
        </div>
      </div>
    `;
  }

  if (job.status === JOB_STATUS.COMPLETE) {
    return `
      <div class="status-card success">
        <div class="status-icon">&#10004;</div>
        <div class="status-text">
          <strong>Complete</strong>
          <p>${job.operations_total} changes applied</p>
        </div>
      </div>
    `;
  }

  return `
    <div class="progress-card">
      <div class="progress-header">
        <span>${job.current_phase}</span>
        <span>${job.progress}%</span>
      </div>
      <div class="progress-bar">
        <div class="progress-fill" style="width: ${job.progress}%"></div>
      </div>
      ${job.operations_total > 0 ? `
        <div class="progress-detail">
          ${job.operations_complete} / ${job.operations_total} operations
        </div>
      ` : ''}
    </div>
  `;
}

function renderBatchPage() {
  const { files, jobs, isProcessing } = state.batch;
  const playbook = state.playbooks.find(p => p.id === state.selectedPlaybookId);
  const hasJobs = jobs.length > 0;
  const completedCount = jobs.filter(j => j.status === JOB_STATUS.COMPLETE && j.result).length;
  const allDone = hasJobs && !isProcessing;

  return `
    <div class="page">
      <div class="page-header">
        <h1>Batch Review</h1>
        <p>Process up to ${MAX_BATCH_FILES} contracts at once</p>
      </div>

      <!-- File Upload -->
      <div class="card">
        <div class="card-header">
          <h3>Contracts</h3>
          ${files.length > 0 ? `<span class="batch-counter">${files.length} / ${MAX_BATCH_FILES}</span>` : ''}
        </div>
        ${files.length > 0 ? `
          <div class="batch-file-list">
            ${files.map((f, i) => `
              <div class="batch-file-item">
                <span class="batch-file-icon">&#128196;</span>
                <span class="batch-file-name">${escapeHtml(f.name)}</span>
                <span class="batch-file-size">${formatFileSize(f.size)}</span>
                ${!isProcessing ? `
                  <button class="btn-icon batch-file-remove" data-action="batch-remove" data-index="${i}" title="Remove">&#10005;</button>
                ` : ''}
              </div>
            `).join('')}
          </div>
        ` : ''}
        ${files.length < MAX_BATCH_FILES && !isProcessing ? `
          <div class="file-upload batch-upload-zone" data-action="batch-upload">
            <input type="file" id="batch-file-input" name="batch-files" accept=".docx" multiple style="display: none">
            <div class="file-icon">&#128450;</div>
            <div class="file-text">${files.length > 0 ? 'Add more contracts' : 'Drop contracts here or click to browse'}</div>
            <div class="file-hint">.docx files only (max ${MAX_BATCH_FILES})</div>
          </div>
        ` : ''}
      </div>

      <!-- Playbook Selection -->
      <div class="card">
        <div class="card-header">
          <h3>Playbook</h3>
        </div>
        <select class="form-select" name="playbook-select" ${isProcessing ? 'disabled' : ''}>
          ${state.playbooks.map(p => `
            <option value="${escapeHtml(p.id)}" ${p.id === state.selectedPlaybookId ? 'selected' : ''}>
              ${escapeHtml(p.name)}
            </option>
          `).join('')}
        </select>
        ${playbook ? `<p class="form-hint">${escapeHtml(playbook.description)}</p>` : ''}
      </div>

      <!-- Job Queue -->
      ${hasJobs ? `
        <div class="card">
          <div class="card-header">
            <h3>Progress</h3>
          </div>
          <div class="batch-queue">
            ${jobs.map((job, i) => renderBatchJob(job, i)).join('')}
          </div>
        </div>
      ` : ''}

      <!-- Action Buttons -->
      <div class="batch-actions">
        ${!allDone || completedCount === 0 ? `
          <button class="btn btn-primary btn-full" data-action="batch-process"
            ${!files.length || !state.settings.apiKey || isProcessing ? 'disabled' : ''}>
            ${isProcessing ? '<span class="spinner"></span> Processing...' : 'Process All'}
          </button>
        ` : `
          <button class="btn btn-success" data-action="batch-download-all" style="flex: 1">
            Download All (${completedCount})
          </button>
          <button class="btn btn-secondary" data-action="batch-clear">
            Clear
          </button>
        `}
      </div>
    </div>
  `;
}

function renderBatchJob(job, index) {
  const isProcessing = job.status === JOB_STATUS.PROCESSING;
  const isComplete = job.status === JOB_STATUS.COMPLETE;
  const isError = job.status === JOB_STATUS.ERROR;
  const isQueued = job.status === JOB_STATUS.QUEUED;

  let statusIcon = '';
  let statusClass = '';
  if (isProcessing) { statusIcon = '<span class="spinner spinner-dark"></span>'; statusClass = 'processing'; }
  else if (isComplete) { statusIcon = '&#10004;'; statusClass = 'complete'; }
  else if (isError) { statusIcon = '&#10060;'; statusClass = 'error'; }
  else if (isQueued) { statusIcon = '&#9679;'; statusClass = 'queued'; }

  return `
    <div class="batch-job batch-job--${statusClass}">
      <div class="batch-job-header">
        <div class="batch-job-info">
          <span class="batch-job-status">${statusIcon}</span>
          <span class="batch-job-name">${escapeHtml(job.fileName)}</span>
        </div>
        ${isComplete && job.result ? `
          <button class="btn-text" data-action="batch-download" data-index="${index}">Download</button>
        ` : ''}
      </div>
      ${isProcessing ? `
        <div class="batch-job-progress">
          <div class="progress-bar">
            <div class="progress-fill" style="width: ${job.progress}%"></div>
          </div>
          <span class="batch-job-phase">${escapeHtml(job.phase)}</span>
        </div>
      ` : ''}
      ${isComplete ? `
        <span class="batch-job-detail">${job.editCount} change${job.editCount !== 1 ? 's' : ''} applied</span>
      ` : ''}
      ${isError ? `
        <span class="batch-job-error">${escapeHtml(job.error)}</span>
      ` : ''}
    </div>
  `;
}

function renderPlaybooksPage() {
  return `
    <div class="page">
      <div class="page-header">
        <h1>Playbooks</h1>
        <p>Manage your contract review playbooks</p>
        <button class="btn btn-primary" data-action="new-playbook">+ New Playbook</button>
      </div>

      <div class="playbook-grid">
        ${state.playbooks.map(p => `
          <div class="playbook-card ${p.id === state.selectedPlaybookId ? 'selected' : ''}"
               data-action="select-playbook" data-id="${escapeHtml(p.id)}">
            <div class="playbook-header">
              <h3>${escapeHtml(p.name)}</h3>
              ${p.isDefault ? `<span class="badge">Default</span>` : `
                <button class="btn-icon" data-action="delete-playbook" data-id="${escapeHtml(p.id)}" title="Delete">
                  &#128465;
                </button>
              `}
            </div>
            <p class="playbook-desc">${escapeHtml(p.description || 'No description')}</p>
            ${p.id === state.selectedPlaybookId ? `<div class="playbook-selected">Selected</div>` : ''}
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function renderSettingsPage() {
  const provider = AI_PROVIDERS[state.settings.provider];
  const models = state.connectionTested && state.availableModels.length > 0
    ? state.availableModels
    : provider?.models || [];

  return `
    <div class="page">
      <div class="page-header">
        <h1>Settings</h1>
        <p>Configure your AI provider and preferences</p>
      </div>

      <div class="card">
        <div class="card-header">
          <h3>AI Provider</h3>
        </div>

        <div class="form-group">
          <label class="form-label">Provider</label>
          <select class="form-select" name="provider">
            ${Object.values(AI_PROVIDERS).filter(p => p.enabled).map(p => `
              <option value="${escapeHtml(p.id)}" ${state.settings.provider === p.id ? 'selected' : ''}>
                ${escapeHtml(p.name)}
              </option>
            `).join('')}
          </select>
        </div>

        <div class="form-group">
          <label class="form-label">API Key</label>
          <input type="password" class="form-input" name="apiKey"
            value="${state.settings.apiKey}"
            placeholder="${state.settings.provider === 'gemini' ? 'AIza...' : 'sk-or-...'}">
          <p class="form-hint">
            ${state.settings.provider === 'gemini'
              ? 'Get your API key from <a href="https://aistudio.google.com/apikey" target="_blank">Google AI Studio</a>'
              : 'Get your API key from <a href="https://openrouter.ai/keys" target="_blank">OpenRouter</a>'}
          </p>
        </div>

        <div class="form-group">
          <label class="form-check">
            <input type="checkbox" name="rememberApiKey" ${state.rememberApiKey ? 'checked' : ''}>
            <span>Remember API key</span>
          </label>
          <p class="form-hint">When off, your API key is cleared when the browser closes</p>
        </div>

        <button class="btn btn-secondary" data-action="test-connection" ${state.isTestingConnection ? 'disabled' : ''}>
          ${state.isTestingConnection ? 'Testing...' : 'Test Connection'}
        </button>

        ${state.connectionTested ? `
          <div class="connection-status ${state.availableModels.length > 0 ? 'success' : 'error'}">
            ${state.availableModels.length > 0
              ? '&#10004; Connected successfully'
              : '&#10060; Connection failed'}
          </div>
        ` : ''}

        <div class="form-group" style="margin-top: 16px;">
          <label class="form-label">Model</label>
          <select class="form-select" name="model">
            ${models.map(m => `
              <option value="${escapeHtml(m.id)}" ${state.settings.model === m.id ? 'selected' : ''}>
                ${escapeHtml(m.name)}
              </option>
            `).join('')}
          </select>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <h3>Audit Log</h3>
        </div>

        <div class="form-group">
          <label class="form-label">Retention Period</label>
          <select class="form-select" name="auditRetentionDays">
            ${[7, 30, 60, 90].map(d => `
              <option value="${d}" ${state.auditRetentionDays === d ? 'selected' : ''}>${d} days</option>
            `).join('')}
          </select>
        </div>

        ${state.auditLog.length > 0 ? `
          <div class="audit-log-table-wrap">
            <table class="audit-log-table">
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Document</th>
                  <th>Provider</th>
                  <th>Edits</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                ${[...state.auditLog].reverse().map(entry => `
                  <tr>
                    <td>${escapeHtml(new Date(entry.timestamp).toLocaleString())}</td>
                    <td class="monospace">${escapeHtml(entry.documentHash.slice(0, 8))}</td>
                    <td>${escapeHtml(entry.provider)}</td>
                    <td>${entry.editsReturned}</td>
                    <td><span class="audit-status audit-status--${entry.status === 'success' ? 'success' : 'error'}">${escapeHtml(entry.status)}</span></td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        ` : `
          <p class="form-hint">No log entries yet.</p>
        `}

        <div class="audit-log-actions">
          <button class="btn btn-secondary" data-action="export-audit-log" ${state.auditLog.length === 0 ? 'disabled' : ''}>Export Log</button>
          <button class="btn btn-secondary" data-action="clear-audit-log" ${state.auditLog.length === 0 ? 'disabled' : ''}>Clear Log</button>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <h3>About</h3>
        </div>
        <p class="about-text">
          Vibe Legal Redliner processes documents locally in your browser using Pyodide (Python in WebAssembly).
          Only the extracted text is sent to your selected AI provider for analysis.
        </p>
        <p class="about-text">
          <a href="privacy-policy.html" target="_blank">Privacy Policy</a>
        </p>
      </div>
    </div>
  `;
}

// ============================================================================
// INITIALIZATION
// ============================================================================

async function init() {
  await loadSettings();
  purgeOldAuditEntries();

  // Listen for engine-ready broadcasts (e.g. from another tab triggering init)
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'engine-ready') {
      state.pyodideReady = true;
      render();
    }
  });

  // Check if engine is already ready (e.g. initialized by another tab)
  chrome.runtime.sendMessage({ type: 'check-engine-status' }, (response) => {
    if (chrome.runtime.lastError) return;
    if (response && response.ready) {
      state.pyodideReady = true;
      render();
    }
  });

  // Event listeners
  document.getElementById('app').addEventListener('click', handleClick);
  document.getElementById('app').addEventListener('change', handleChange);
  document.getElementById('app').addEventListener('dragover', (e) => {
    e.preventDefault();
    const dropZone = e.target.closest('.file-upload');
    if (dropZone) dropZone.classList.add('dragover');
  });
  document.getElementById('app').addEventListener('dragleave', (e) => {
    const dropZone = e.target.closest('.file-upload');
    if (dropZone) dropZone.classList.remove('dragover');
  });
  document.getElementById('app').addEventListener('drop', handleDrop);

  render();
}

document.addEventListener('DOMContentLoaded', init);
