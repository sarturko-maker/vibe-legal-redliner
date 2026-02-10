import { state, loadSettings, saveSettings, loadApiKeyForProvider, purgeOldAuditEntries, writeAuditLogEntry, clearAuditLog, exportAuditLog } from './state.js';
import { AI_PROVIDERS, JOB_STATUS } from './config.js';
import { render, closeModal } from './ui.js';
import { safeSetHTML } from './trusted-html.js';
import { handleTestConnection } from './api-handler.js';
import { isValidZipFile, MAX_FILE_SIZE, MAX_TEXT_LENGTH, MAX_BATCH_FILES, downloadFile } from './file-processing.js';
import { analyzeContract } from './utils/ai-bundle.js';

const ENGINE_INIT_TIMEOUT_MS = 60000;
let engineInitPromise = null;

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
        if (response?.ready) {
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
    engineInitPromise = null;
    throw err;
  });

  return engineInitPromise;
}

function sendMsg(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error('Communication error with background service. Please reload the extension.'));
        return;
      }
      resolve(response);
    });
  });
}

function auditBase(file) {
  return {
    filename: file.name,
    fileSizeBytes: file.size,
    provider: state.settings.provider,
    model: state.settings.model
  };
}

function updateJob(job, fields) {
  Object.assign(job, fields);
  render();
}

async function processDocument() {
  const { file } = state.review;
  const playbook = state.playbooks.find(p => p.id === state.selectedPlaybookId);

  if (!file) { alert('Please upload a contract file'); return; }
  if (file.size > MAX_FILE_SIZE) { alert('File is too large. Maximum size is 50MB.'); return; }
  if (!state.settings.apiKey) {
    alert('Please configure your API key in Settings');
    state.currentPage = 'settings';
    render();
    return;
  }
  if (!playbook) { alert('Please select a playbook'); return; }

  state.review.job = {
    id: Date.now().toString(),
    status: JOB_STATUS.PROCESSING,
    progress: 5,
    current_phase: 'Initialising engine...',
    operations_complete: 0,
    operations_total: 0,
    errors: []
  };
  state.review.result = null;
  render();

  const t0 = Date.now();
  console.log('[VL-DEBUG] Processing started', { fileName: file.name, fileSize: file.size, provider: state.settings.provider, model: state.settings.model });

  try {
    const arrayBuffer = await file.arrayBuffer();
    const contractBytes = new Uint8Array(arrayBuffer);

    if (!isValidZipFile(contractBytes)) {
      throw new Error('Invalid file format. Please upload a valid .docx file.');
    }

    await ensureEngineReady();
    console.log('[VL-DEBUG] Engine ready', { elapsedMs: Date.now() - t0 });
    updateJob(state.review.job, { progress: 10, current_phase: 'Reading document...' });

    const extractResp = await sendMsg({
      type: 'extract-text',
      contractBytes: Array.from(contractBytes)
    });

    if (!extractResp?.success) {
      throw new Error(extractResp?.error || 'Failed to extract text from document.');
    }

    const contractText = extractResp.text;
    console.log('[VL-DEBUG] Text extracted', { textLength: contractText?.length, elapsedMs: Date.now() - t0 });

    if (!contractText?.trim()) {
      throw new Error('Document appears to be empty. Please upload a document with text content.');
    }
    if (contractText.length > MAX_TEXT_LENGTH) {
      throw new Error('Document text is too large for AI analysis. Please use a smaller document.');
    }

    updateJob(state.review.job, { progress: 20, current_phase: 'Analyzing with AI...' });

    const aiResponse = await analyzeContract({
      provider: state.settings.provider,
      apiKey: state.settings.apiKey,
      model: state.settings.model,
      contractText,
      playbookText: playbook.playbookText
    });

    console.log('[VL-DEBUG] AI analysis complete', { editCount: aiResponse.edits.length, elapsedMs: Date.now() - t0 });
    console.log('[VibeLegal] Raw AI response:', aiResponse.rawContent);
    console.log('[VibeLegal] Parsed edits:', aiResponse.edits);
    state.review.edits = aiResponse.edits;

    updateJob(state.review.job, {
      progress: 60,
      operations_total: aiResponse.edits.length,
      current_phase: `Found ${aiResponse.edits.length} changes. Applying redlines...`
    });

    if (aiResponse.edits.length === 0) {
      updateJob(state.review.job, { status: JOB_STATUS.COMPLETE, progress: 100, current_phase: 'No changes needed' });
      writeAuditLogEntry({ ...auditBase(file), editsReturned: 0, status: 'success' });
      return;
    }

    updateJob(state.review.job, { progress: 80, current_phase: 'Applying track changes...' });

    const applyResp = await sendMsg({
      type: 'apply-edits',
      edits: aiResponse.edits
    });

    if (!applyResp?.success) {
      state.review.job.status = JOB_STATUS.ERROR;
      state.review.job.errors = ['Document processing failed. Please try again.'];
      writeAuditLogEntry({ ...auditBase(file), editsReturned: aiResponse.edits.length, status: 'error', errorMessage: 'Document processing failed' });
      render();
      return;
    }

    const applied = applyResp.applied ?? aiResponse.edits.length;
    const skipped = applyResp.skipped ?? 0;
    state.review.result = new Uint8Array(applyResp.result);
    console.log('[VL-DEBUG] Edits applied', { applied, skipped, elapsedMs: Date.now() - t0 });

    if (applyResp.statuses && state.review.edits) {
      state.review.edits = state.review.edits.map((edit, i) => ({
        ...edit,
        applied: applyResp.statuses[i] ?? false
      }));
    }

    const phaseText = skipped > 0
      ? `Complete — ${applied} of ${applied + skipped} edits applied (${skipped} could not be matched in the document)`
      : `Complete — ${applied} edits applied`;

    updateJob(state.review.job, {
      status: JOB_STATUS.COMPLETE,
      progress: 100,
      operations_complete: applied,
      current_phase: phaseText
    });
    writeAuditLogEntry({ ...auditBase(file), editsReturned: aiResponse.edits.length, editsApplied: applied, editsSkipped: skipped, status: 'success' });

  } catch (error) {
    console.error('[VL-DEBUG] processDocument failed', { error: error.message, elapsedMs: Date.now() - t0 });
    const isKnownError = error.message && !(error instanceof TypeError) && !(error instanceof ReferenceError);
    if (!isKnownError) console.error('[VibeLegal] processDocument error:', error);
    state.review.job.status = JOB_STATUS.ERROR;
    state.review.job.errors = [isKnownError ? error.message : 'An error occurred while processing your document. Please try again.'];
    writeAuditLogEntry({ ...auditBase(file), editsReturned: 0, status: 'error', errorMessage: error.message });
    render();
  }
}

async function processBatch() {
  const { files } = state.batch;
  const playbook = state.playbooks.find(p => p.id === state.selectedPlaybookId);

  if (!files.length) { alert('Please upload at least one contract file'); return; }
  if (!state.settings.apiKey) {
    alert('Please configure your API key in Settings');
    state.currentPage = 'settings';
    render();
    return;
  }
  if (!playbook) { alert('Please select a playbook'); return; }

  state.batch.isProcessing = true;
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

  try {
    await ensureEngineReady();
  } catch (err) {
    for (const job of state.batch.jobs) {
      job.status = JOB_STATUS.ERROR;
      job.error = err.message || 'Engine failed to initialise.';
    }
    state.batch.isProcessing = false;
    render();
    return;
  }

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const job = state.batch.jobs[i];

    updateJob(job, { status: JOB_STATUS.PROCESSING, progress: 5, phase: 'Reading document...' });

    try {
      const arrayBuffer = await file.arrayBuffer();
      const contractBytes = new Uint8Array(arrayBuffer);

      if (!isValidZipFile(contractBytes)) {
        throw new Error('Invalid file format. Please upload a valid .docx file.');
      }

      const extractResp = await sendMsg({
        type: 'extract-text',
        contractBytes: Array.from(contractBytes)
      });

      if (!extractResp?.success) {
        throw new Error(extractResp?.error || 'Failed to extract text from document.');
      }

      const contractText = extractResp.text;
      if (!contractText?.trim()) throw new Error('Document appears to be empty.');
      if (contractText.length > MAX_TEXT_LENGTH) throw new Error('Document text is too large for AI analysis.');

      updateJob(job, { progress: 20, phase: 'Analyzing with AI...' });

      const aiResponse = await analyzeContract({
        provider: state.settings.provider,
        apiKey: state.settings.apiKey,
        model: state.settings.model,
        contractText,
        playbookText: playbook.playbookText
      });

      job.editCount = aiResponse.edits.length;
      updateJob(job, { progress: 60, phase: `Found ${aiResponse.edits.length} changes. Applying redlines...` });

      if (aiResponse.edits.length === 0) {
        updateJob(job, { status: JOB_STATUS.COMPLETE, progress: 100, phase: 'No changes needed' });
        writeAuditLogEntry({ ...auditBase(file), editsReturned: 0, status: 'success' });
        continue;
      }

      updateJob(job, { progress: 80, phase: 'Applying track changes...' });

      const applyResp = await sendMsg({
        type: 'apply-edits',
        edits: aiResponse.edits
      });

      if (!applyResp?.success) {
        throw new Error(applyResp?.error || 'Document processing failed.');
      }

      const applied = applyResp.applied ?? job.editCount;
      const skipped = applyResp.skipped ?? 0;
      const phaseText = skipped > 0
        ? `Complete — ${applied}/${applied + skipped} applied`
        : `Complete — ${applied} edits applied`;

      job.result = new Uint8Array(applyResp.result);
      updateJob(job, { status: JOB_STATUS.COMPLETE, progress: 100, phase: phaseText });
      writeAuditLogEntry({ ...auditBase(file), editsReturned: job.editCount, editsApplied: applied, editsSkipped: skipped, status: 'success' });

    } catch (error) {
      job.status = JOB_STATUS.ERROR;
      job.progress = 0;
      job.error = error.message || 'An error occurred while processing this document.';
      writeAuditLogEntry({ ...auditBase(file), editsReturned: job.editCount, status: 'error' });
    }

    render();

    if (i < files.length - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  state.batch.isProcessing = false;
  render();
}

function downloadBatchFile(index) {
  const job = state.batch.jobs[index];
  if (!job?.result) return;
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
  const available = MAX_BATCH_FILES - state.batch.files.length;
  if (available <= 0) { alert(`Maximum ${MAX_BATCH_FILES} files allowed.`); return; }

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
    state.batch.jobs = [];
    render();
  }
}

async function createPlaybook(name, description, fileContent) {
  let id = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  if (!/^[a-z]/.test(id)) id = 'playbook-' + id;
  id = id + '-' + Date.now().toString(36);

  let playbookText = description || `Custom playbook: ${name}`;

  if (fileContent) {
    try {
      await ensureEngineReady();
      const resp = await sendMsg({
        type: 'extract-text',
        contractBytes: Array.from(new Uint8Array(fileContent)),
        cleanView: true
      });
      if (resp?.success && resp.text) playbookText = resp.text;
    } catch {
      playbookText = description || `Custom playbook: ${name}`;
    }
  }

  state.playbooks.push({ id, name, description: description || '', playbookText, isExample: false });
  saveSettings();
  render();
}

function deletePlaybook(id) {
  state.playbooks = state.playbooks.filter(p => p.id !== id);
  if (state.selectedPlaybookId === id) {
    state.selectedPlaybookId = state.playbooks.length > 0 ? state.playbooks[0].id : null;
  }
  if (state.editingPlaybookId === id) state.editingPlaybookId = null;
  saveSettings();
  render();
}

function savePlaybookEdits() {
  const playbook = state.playbooks.find(p => p.id === state.editingPlaybookId);
  if (!playbook) return;

  const name = document.querySelector('[name="playbook-edit-name"]')?.value.trim();
  const description = document.querySelector('[name="playbook-edit-description"]')?.value.trim();
  const playbookText = document.querySelector('[name="playbook-edit-text"]')?.value;

  if (!name) { alert('Playbook name cannot be empty'); return; }

  playbook.name = name;
  playbook.description = description || '';
  playbook.playbookText = playbookText || '';
  saveSettings();
  state.editingPlaybookId = null;
  render();
}

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

  modal.querySelector('#modal-close-btn').addEventListener('click', closeModal);
  modal.querySelector('#modal-cancel-btn').addEventListener('click', closeModal);
  modal.querySelector('#modal-create-btn').addEventListener('click', handleCreatePlaybook);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
}

async function handleCreatePlaybook() {
  const name = document.getElementById('playbook-name').value.trim();
  const desc = document.getElementById('playbook-desc').value.trim();
  const file = document.getElementById('playbook-file')?.files?.[0];

  if (!name) { alert('Please enter a playbook name'); return; }

  if (file) {
    const buffer = await file.arrayBuffer();
    createPlaybook(name, desc, buffer);
    closeModal();
  } else if (desc) {
    createPlaybook(name, desc, null);
    closeModal();
  } else {
    alert('Please enter playbook rules or upload a document');
  }
}

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
      state.review.edits = null;
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
      if (confirm('Delete this playbook? This cannot be undone.')) deletePlaybook(target.dataset.id);
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
    case 'dismiss-disclaimer':
      state.disclaimerAcknowledged = true;
      chrome.storage.local.set({ disclaimerAcknowledged: true });
      render();
      break;
  }
}

function handleChange(e) {
  const { name, value, files } = e.target;

  if (name === 'contract' && files?.length) {
    const file = files[0];
    if (!file.name.toLowerCase().endsWith('.docx')) { alert('Please select a .docx file'); return; }
    if (file.size > MAX_FILE_SIZE) { alert('File is too large. Maximum size is 50MB.'); return; }
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
    const provider = AI_PROVIDERS[value];
    const defaultModel = provider?.models?.find(m => m.default);
    state.settings.model = defaultModel?.id || provider?.models?.[0]?.id || '';
    loadApiKeyForProvider(value).then((key) => {
      state.settings.apiKey = key;
      saveSettings();
      render();
    });
    return;
  }

  if (name === 'apiKey') { state.settings.apiKey = value; state.connectionTested = false; saveSettings(); return; }
  if (name === 'rememberApiKey') { state.rememberApiKey = e.target.checked; saveSettings(); return; }
  if (name === 'model') { state.settings.model = value; saveSettings(); return; }
  if (name === 'playbook-select') { state.selectedPlaybookId = value; render(); return; }

  if (name === 'auditRetentionDays') {
    state.auditRetentionDays = parseInt(value, 10);
    chrome.storage.local.set({ auditRetentionDays: state.auditRetentionDays });
    purgeOldAuditEntries();
    render();
    return;
  }

  if (name === 'batch-files' && files?.length) {
    addBatchFiles(Array.from(files));
    e.target.value = '';
    return;
  }
}

function handleDrop(e) {
  e.preventDefault();
  const dropZone = e.target.closest('.file-upload');
  if (!dropZone) return;

  dropZone.classList.remove('dragover');
  const droppedFiles = e.dataTransfer.files;
  if (!droppedFiles.length) return;

  if (dropZone.classList.contains('batch-upload-zone')) {
    addBatchFiles(Array.from(droppedFiles));
    return;
  }

  const file = droppedFiles[0];
  if (!file.name.toLowerCase().endsWith('.docx')) { alert('Please drop a .docx file'); return; }
  if (file.size > MAX_FILE_SIZE) { alert('File is too large. Maximum size is 50MB.'); return; }

  state.review.file = file;
  state.review.job = null;
  state.review.result = null;
  render();
}

async function init() {
  await loadSettings();
  purgeOldAuditEntries();

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'engine-ready') {
      state.pyodideReady = true;
      render();
    }
  });

  ensureEngineReady().catch(() => {});

  const app = document.getElementById('app');
  app.addEventListener('click', handleClick);
  app.addEventListener('change', handleChange);
  app.addEventListener('dragover', (e) => {
    e.preventDefault();
    const dropZone = e.target.closest('.file-upload');
    if (dropZone) dropZone.classList.add('dragover');
  });
  app.addEventListener('dragleave', (e) => {
    const dropZone = e.target.closest('.file-upload');
    if (dropZone) dropZone.classList.remove('dragover');
  });
  app.addEventListener('drop', handleDrop);

  render();
}

document.addEventListener('DOMContentLoaded', init);
