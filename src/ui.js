import { state } from './state.js';
import { AI_PROVIDERS, JOB_STATUS } from './config.js';
import { formatFileSize, MAX_BATCH_FILES } from './file-processing.js';
import { safeSetHTML } from './trusted-html.js';

export function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export function closeModal() {
  document.getElementById('modal')?.remove();
}

function playbookSelect({ disabled = false } = {}) {
  const playbook = state.playbooks.find(p => p.id === state.selectedPlaybookId);
  return `
    <div class="card">
      <div class="card-header">
        <h3>Playbook</h3>
      </div>
      <select class="form-select" name="playbook-select" ${disabled ? 'disabled' : ''}>
        ${state.playbooks.map(p => `
          <option value="${escapeHtml(p.id)}" ${p.id === state.selectedPlaybookId ? 'selected' : ''}>
            ${escapeHtml(p.name)}
          </option>
        `).join('')}
      </select>
      ${playbook ? `<p class="form-hint">${escapeHtml(playbook.description)}</p>` : ''}
    </div>
  `;
}

export function render() {
  const app = document.getElementById('app');

  safeSetHTML(app, `
    <div class="app-container">
      <nav class="sidebar">
        <div class="sidebar-header">
          <div class="logo">VL</div>
          <div class="logo-text">
            <strong>Vibe Legal</strong>
            <span>Redliner</span>
          </div>
        </div>
        <ul class="nav-list">
          ${['review', 'batch', 'playbooks', 'settings'].map(page =>
            `<li class="nav-item ${state.currentPage === page ? 'active' : ''}" data-action="nav" data-page="${page}">
              ${page.charAt(0).toUpperCase() + page.slice(1)}
            </li>`
          ).join('')}
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

      <main class="main-content">
        ${!state.disclaimerAcknowledged ? renderDisclaimerBanner() : ''}
        ${renderPage()}
      </main>
    </div>
  `);
}

function renderDisclaimerBanner() {
  return `
    <div class="disclaimer-banner">
      <div class="disclaimer-banner-text">
        <strong>Important:</strong> This tool is a work in progress, built using AI-assisted development.
        It does not provide legal advice. All output is AI-generated and must be reviewed by a qualified
        professional before use. AI models can produce inaccurate results. Your document text is sent to
        your chosen AI provider.
        <a href="disclaimer.html" target="_blank">Learn more</a>
      </div>
      <button class="disclaimer-banner-close" data-action="dismiss-disclaimer" title="Dismiss">&times;</button>
    </div>
  `;
}

function renderPage() {
  switch (state.currentPage) {
    case 'batch':     return renderBatchPage();
    case 'playbooks': return renderPlaybooksPage();
    case 'settings':  return renderSettingsPage();
    default:          return renderReviewPage();
  }
}

function renderReviewPage() {
  const { file, job, result } = state.review;
  const processing = job?.status === JOB_STATUS.PROCESSING;

  return `
    <div class="page">
      <div class="page-header">
        <h1>Review Document</h1>
        <p>Upload a contract to analyze against your playbook</p>
      </div>

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

      ${playbookSelect()}
      ${job ? renderJobStatus(job) : ''}

      ${!result ? `
        <button class="btn btn-primary btn-full" data-action="process"
          ${!file || processing ? 'disabled' : ''}>
          ${processing ? '<span class="spinner"></span> Processing...' : 'Analyze & Redline'}
        </button>
      ` : `
        <button class="btn btn-success btn-full" data-action="download">
          Download Redlined Document
        </button>
      `}
    </div>
  `;
}

function renderJobStatus(job) {
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
          <strong>${escapeHtml(job.current_phase)}</strong>
        </div>
      </div>
      ${renderEditsPanel()}
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

function renderEditsPanel() {
  const edits = state.review?.edits;
  if (!edits || edits.length === 0) return '';

  return `
    <details class="edits-panel">
      <summary class="edits-summary">View AI edits (${edits.length})</summary>
      <div class="edits-list">
        ${edits.map((edit, i) => {
    const statusClass = edit.applied === true ? 'applied' : edit.applied === false ? 'skipped' : '';
    const statusLabel = edit.applied === true ? 'Applied' : edit.applied === false ? 'Skipped' : '';
    return `
          <div class="edit-item ${statusClass}">
            <div class="edit-header">
              <span class="edit-number">#${i + 1}</span>
              ${statusLabel ? `<span class="edit-status ${statusClass}">${statusLabel}</span>` : ''}
            </div>
            <div class="edit-field">
              <span class="edit-label">Find:</span>
              <span class="edit-value">${escapeHtml(edit.target_text)}</span>
            </div>
            <div class="edit-field">
              <span class="edit-label">Replace:</span>
              <span class="edit-value">${escapeHtml(edit.new_text || '(delete)')}</span>
            </div>
            ${edit.comment ? `
            <div class="edit-field">
              <span class="edit-label">Reason:</span>
              <span class="edit-value edit-comment">${escapeHtml(edit.comment)}</span>
            </div>
            ` : ''}
          </div>`;
  }).join('')}
      </div>
    </details>
  `;
}

function renderBatchPage() {
  const { files, jobs, isProcessing } = state.batch;
  const hasJobs = jobs.length > 0;
  const completedCount = jobs.filter(j => j.status === JOB_STATUS.COMPLETE && j.result).length;
  const allDone = hasJobs && !isProcessing;

  return `
    <div class="page">
      <div class="page-header">
        <h1>Batch Review</h1>
        <p>Process up to ${MAX_BATCH_FILES} contracts at once</p>
      </div>

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

      ${playbookSelect({ disabled: isProcessing })}

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

const BATCH_STATUS_MAP = {
  [JOB_STATUS.PROCESSING]: { icon: '<span class="spinner spinner-dark"></span>', css: 'processing' },
  [JOB_STATUS.COMPLETE]:   { icon: '&#10004;', css: 'complete' },
  [JOB_STATUS.ERROR]:      { icon: '&#10060;', css: 'error' },
  [JOB_STATUS.QUEUED]:     { icon: '&#9679;',  css: 'queued' },
};

function renderBatchJob(job, index) {
  const { icon, css } = BATCH_STATUS_MAP[job.status] || { icon: '', css: '' };

  return `
    <div class="batch-job batch-job--${css}">
      <div class="batch-job-header">
        <div class="batch-job-info">
          <span class="batch-job-status">${icon}</span>
          <span class="batch-job-name">${escapeHtml(job.fileName)}</span>
        </div>
        ${job.status === JOB_STATUS.COMPLETE && job.result ? `
          <button class="btn-text" data-action="batch-download" data-index="${index}">Download</button>
        ` : ''}
      </div>
      ${job.status === JOB_STATUS.PROCESSING ? `
        <div class="batch-job-progress">
          <div class="progress-bar">
            <div class="progress-fill" style="width: ${job.progress}%"></div>
          </div>
          <span class="batch-job-phase">${escapeHtml(job.phase)}</span>
        </div>
      ` : ''}
      ${job.status === JOB_STATUS.COMPLETE ? `
        <span class="batch-job-detail">${job.editCount} change${job.editCount !== 1 ? 's' : ''} applied</span>
      ` : ''}
      ${job.status === JOB_STATUS.ERROR ? `
        <span class="batch-job-error">${escapeHtml(job.error)}</span>
      ` : ''}
    </div>
  `;
}

function renderPlaybooksPage() {
  if (state.editingPlaybookId) return renderPlaybookEditPage();

  return `
    <div class="page">
      <div class="page-header">
        <h1>Playbooks</h1>
        <p>${state.playbooks.length === 0
          ? 'No playbooks yet. Create one to get started.'
          : 'Manage your contract review playbooks'}</p>
        <button class="btn btn-primary" data-action="new-playbook">+ New Playbook</button>
      </div>

      ${state.playbooks.length > 0 ? `
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
      ` : ''}
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
  const isGemini = state.settings.provider === 'gemini';
  const hasAuditEntries = state.auditLog.length > 0;

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
            placeholder="${isGemini ? 'AIza...' : 'sk-or-...'}">
          <p class="form-hint">
            ${isGemini
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

        ${hasAuditEntries ? `
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
          <button class="btn btn-secondary" data-action="export-audit-log" ${!hasAuditEntries ? 'disabled' : ''}>Export Log</button>
          <button class="btn btn-secondary" data-action="clear-audit-log" ${!hasAuditEntries ? 'disabled' : ''}>Clear Log</button>
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
          <a href="disclaimer.html" target="_blank">Disclaimer</a> &middot;
          <a href="privacy-policy.html" target="_blank">Privacy Policy</a>
        </p>
      </div>
    </div>
  `;
}
