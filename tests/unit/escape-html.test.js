import { describe, it, expect, vi } from 'vitest';

// Mock ui.js dependencies so only escapeHtml is exercised
vi.mock('../../src/state.js', () => ({ state: {} }));
vi.mock('../../src/config.js', () => ({ AI_PROVIDERS: {}, JOB_STATUS: {} }));
vi.mock('../../src/file-processing.js', () => ({ formatFileSize: () => '', MAX_BATCH_FILES: 5 }));
vi.mock('../../src/trusted-html.js', () => ({ safeSetHTML: () => {} }));

import { escapeHtml } from '../../src/ui.js';

describe('escapeHtml', () => {
  it('escapes script tags', () => {
    const result = escapeHtml('<script>alert("xss")</script>');
    expect(result).not.toContain('<script>');
    expect(result).toContain('&lt;script&gt;');
  });

  it('escapes onerror event handlers', () => {
    const result = escapeHtml('<img onerror="alert(1)">');
    expect(result).not.toContain('<img');
    expect(result).toContain('&lt;img');
  });

  it('escapes onclick event handlers', () => {
    const result = escapeHtml('<div onclick="steal()">click</div>');
    expect(result).not.toContain('<div');
    expect(result).toContain('&lt;div');
  });

  it('escapes quote characters in attribute-breaking attempts', () => {
    const result = escapeHtml('"><script>alert(1)</script>');
    expect(result).not.toContain('<script>');
    expect(result).toContain('&lt;script&gt;');
  });

  it('escapes ampersands', () => {
    expect(escapeHtml('foo & bar')).toContain('&amp;');
  });

  it('escapes angle brackets', () => {
    const result = escapeHtml('1 < 2 > 0');
    expect(result).toContain('&lt;');
    expect(result).toContain('&gt;');
  });

  it('escapes nested injection attempts', () => {
    const nested = '<img src=x onerror="<script>alert(1)</script>">';
    const result = escapeHtml(nested);
    expect(result).not.toContain('<script>');
    expect(result).not.toContain('<img');
  });

  it('returns empty string for empty input', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('returns empty string for null', () => {
    expect(escapeHtml(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(escapeHtml(undefined)).toBe('');
  });

  it('passes through normal text unchanged', () => {
    expect(escapeHtml('Hello World')).toBe('Hello World');
    expect(escapeHtml('contract clause 4.2')).toBe('contract clause 4.2');
  });
});
