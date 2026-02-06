/**
 * UI rendering
 */

import { state } from './state.js';
import { AI_PROVIDERS, JOB_STATUS } from './config.js';
import { formatFileSize, MAX_BATCH_FILES } from './file-processing.js';
import { safeSetHTML } from './trusted-html.js';

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Escape HTML to prevent XSS
 */
export function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export function closeModal() {
  const modal = document.getElementById('modal');
  if (modal) {
    modal.remove();
  }
}

// ============================================================================
// RENDER
// ============================================================================

export function render() {
  const app = document.getElementById('app');

  safeSetHTML(app, `
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
  `);
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
        <span>${escapeHtml(job.current_phase)}</span>
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
  if (state.editingPlaybookId) {
    return renderPlaybookEditPage();
  }

  if (state.playbooks.length === 0) {
    return `
      <div class="page">
        <div class="page-header">
          <h1>Playbooks</h1>
          <p>No playbooks yet. Create one to get started.</p>
          <button class="btn btn-primary" data-action="new-playbook">+ New Playbook</button>
        </div>
      </div>
    `;
  }

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
               data-action="edit-playbook" data-id="${escapeHtml(p.id)}">
            <div class="playbook-header">
              <h3>${escapeHtml(p.name)}</h3>
              <div style="display:flex;align-items:center;gap:8px">
                ${p.isExample ? `<span class="badge">EXAMPLE</span>` : ''}
                <button class="btn-icon" data-action="delete-playbook" data-id="${escapeHtml(p.id)}" title="Delete">
                  &#128465;
                </button>
              </div>
            </div>
            <p class="playbook-desc">${escapeHtml(p.description || 'No description')}</p>
            ${p.id === state.selectedPlaybookId ? `<div class="playbook-selected">Selected</div>` : ''}
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function renderPlaybookEditPage() {
  const playbook = state.playbooks.find(p => p.id === state.editingPlaybookId);
  if (!playbook) {
    state.editingPlaybookId = null;
    return renderPlaybooksPage();
  }

  const isSelected = playbook.id === state.selectedPlaybookId;

  return `
    <div class="page">
      <div class="page-header">
        <button class="btn-text" data-action="back-to-playbooks">&larr; Back to Playbooks</button>
        <h1>${escapeHtml(playbook.name)}</h1>
        ${playbook.isExample ? `<span class="badge">EXAMPLE</span>` : ''}
      </div>

      <div class="card">
        <div class="form-group">
          <label class="form-label">Name</label>
          <input type="text" class="form-input" name="playbook-edit-name"
            value="${escapeHtml(playbook.name)}">
        </div>
        <div class="form-group">
          <label class="form-label">Description</label>
          <input type="text" class="form-input" name="playbook-edit-description"
            value="${escapeHtml(playbook.description || '')}"
            placeholder="Short summary of what this playbook reviews">
        </div>
        <div class="form-group">
          <label class="form-label">Playbook Rules</label>
          <textarea class="form-textarea" name="playbook-edit-text"
            rows="20" style="font-family:monospace;font-size:12px">${escapeHtml(playbook.playbookText || '')}</textarea>
        </div>
      </div>

      <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap">
        <button class="btn btn-primary" data-action="save-playbook">Save Changes</button>
        <button class="btn ${isSelected ? 'btn-success' : 'btn-secondary'}"
          data-action="select-playbook" data-id="${escapeHtml(playbook.id)}">
          ${isSelected ? 'Selected for Review &#10004;' : 'Use for Review'}
        </button>
        <button class="btn btn-secondary" data-action="delete-playbook"
          data-id="${escapeHtml(playbook.id)}">Delete</button>
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
            value="${escapeHtml(state.settings.apiKey)}"
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
          v${escapeHtml(chrome.runtime.getManifest().version)} &middot;
          <a href="https://github.com/sarturko-maker/vibe-legal-redliner" target="_blank">Source code</a> &middot;
          MIT License
        </p>
        <p class="about-text">
          <a href="help.html" target="_blank">Getting Started</a> &middot;
          <a href="privacy-policy.html" target="_blank">Privacy Policy</a>
        </p>
      </div>
    </div>
  `;
}
