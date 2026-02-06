/**
 * Vibe Legal Redliner - Main Application Entry Point
 * Chrome Extension with full server functionality
 */

import { state, loadSettings, saveSettings, purgeOldAuditEntries, writeAuditLogEntry, clearAuditLog, exportAuditLog } from './state.js';
import { AI_PROVIDERS, JOB_STATUS } from './config.js';
import { render, closeModal } from './ui.js';
import { safeSetHTML } from './trusted-html.js';
import { handleTestConnection } from './api-handler.js';
import { extractTextFromDocx, isValidZipFile, MAX_FILE_SIZE, MAX_TEXT_LENGTH, MAX_BATCH_FILES, downloadFile } from './file-processing.js';
import { analyzeContract } from './utils/ai-bundle.js';

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
    } else if (error.message.includes('Engine') || error.message.includes('initialise') || error.message.includes('Pyodide')) {
      userMessage = error.message; // Keep engine-related messages
    } else {
      console.error('[VibeLegal] processDocument error:', error);
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
    isExample: false
  };

  state.playbooks.push(newPlaybook);
  saveSettings();
  render();
}

function deletePlaybook(id) {
  state.playbooks = state.playbooks.filter(p => p.id !== id);

  if (state.selectedPlaybookId === id) {
    state.selectedPlaybookId = state.playbooks.length > 0 ? state.playbooks[0].id : null;
  }
  if (state.editingPlaybookId === id) {
    state.editingPlaybookId = null;
  }

  saveSettings();
  render();
}

function savePlaybookEdits() {
  const playbook = state.playbooks.find(p => p.id === state.editingPlaybookId);
  if (!playbook) return;

  const name = document.querySelector('[name="playbook-edit-name"]')?.value.trim();
  const description = document.querySelector('[name="playbook-edit-description"]')?.value.trim();
  const playbookText = document.querySelector('[name="playbook-edit-text"]')?.value;

  if (!name) {
    alert('Playbook name cannot be empty');
    return;
  }

  playbook.name = name;
  playbook.description = description || '';
  playbook.playbookText = playbookText || '';

  saveSettings();
  state.editingPlaybookId = null;
  render();
}

// ============================================================================
// MODAL
// ============================================================================

function showNewPlaybookModal() {
  const modal = document.createElement('div');
  modal.id = 'modal';
  modal.className = 'modal-overlay';
  safeSetHTML(modal, `
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
  `);
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

    case 'edit-playbook':
      state.editingPlaybookId = target.dataset.id;
      render();
      break;

    case 'back-to-playbooks':
      state.editingPlaybookId = null;
      render();
      break;

    case 'save-playbook':
      savePlaybookEdits();
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
      if (confirm('Delete this playbook? This cannot be undone.')) {
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
        render();
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
