import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock chrome.storage globally before state.js loads
globalThis.chrome = {
  storage: {
    local: {
      get: vi.fn((_keys, cb) => cb({})),
      set: vi.fn(),
      remove: vi.fn()
    },
    session: {
      get: vi.fn((_keys, cb) => cb({})),
      set: vi.fn(),
      remove: vi.fn()
    }
  }
};

vi.mock('../../src/config.js', () => ({
  DEFAULT_PLAYBOOKS: []
}));

import {
  state,
  hashFilename,
  purgeOldAuditEntries,
  writeAuditLogEntry,
  MAX_AUDIT_ENTRIES
} from '../../src/state.js';

describe('audit log', () => {
  beforeEach(() => {
    state.auditLog = [];
    state.auditRetentionDays = 30;
    vi.clearAllMocks();
  });

  describe('writeAuditLogEntry', () => {
    it('creates an entry with the correct structure', async () => {
      await writeAuditLogEntry({
        filename: 'contract.docx',
        fileSizeBytes: 2048,
        provider: 'gemini',
        model: 'gemini-2.0-flash',
        editsReturned: 3,
        status: 'success'
      });

      expect(state.auditLog).toHaveLength(1);
      const entry = state.auditLog[0];

      expect(entry).toHaveProperty('timestamp');
      expect(new Date(entry.timestamp).getTime()).not.toBeNaN();
      expect(entry).toHaveProperty('documentHash');
      expect(entry.documentHash).toMatch(/^[a-f0-9]{64}$/);
      expect(entry.fileSizeBytes).toBe(2048);
      expect(entry.provider).toBe('gemini');
      expect(entry.model).toBe('gemini-2.0-flash');
      expect(entry.editsReturned).toBe(3);
      expect(entry.status).toBe('success');
    });

    it('persists to chrome.storage.local', async () => {
      await writeAuditLogEntry({
        filename: 'test.docx',
        fileSizeBytes: 100,
        provider: 'openrouter',
        model: 'gpt-4o',
        editsReturned: 0,
        status: 'error'
      });

      expect(chrome.storage.local.set).toHaveBeenCalledWith(
        expect.objectContaining({ auditLog: expect.any(Array) })
      );
    });
  });

  describe('hashFilename', () => {
    it('hashes document names — never stores plain text', async () => {
      const hash = await hashFilename('confidential-merger-agreement.docx');
      expect(hash).not.toContain('confidential');
      expect(hash).not.toContain('merger');
      expect(hash).not.toContain('.docx');
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('produces consistent hashes for the same filename', async () => {
      const a = await hashFilename('contract.docx');
      const b = await hashFilename('contract.docx');
      expect(a).toBe(b);
    });

    it('produces different hashes for different filenames', async () => {
      const a = await hashFilename('file-a.docx');
      const b = await hashFilename('file-b.docx');
      expect(a).not.toBe(b);
    });
  });

  describe('purgeOldAuditEntries', () => {
    it('removes entries older than the retention period', () => {
      const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      const recentDate = new Date().toISOString();

      state.auditLog = [
        { timestamp: oldDate, documentHash: 'aaa', provider: 'gemini', status: 'success' },
        { timestamp: recentDate, documentHash: 'bbb', provider: 'gemini', status: 'success' }
      ];

      purgeOldAuditEntries();

      expect(state.auditLog).toHaveLength(1);
      expect(state.auditLog[0].documentHash).toBe('bbb');
    });

    it('keeps all entries within the retention window', () => {
      const recent1 = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
      const recent2 = new Date().toISOString();

      state.auditLog = [
        { timestamp: recent1, documentHash: 'aaa', provider: 'gemini', status: 'success' },
        { timestamp: recent2, documentHash: 'bbb', provider: 'gemini', status: 'success' }
      ];

      purgeOldAuditEntries();

      expect(state.auditLog).toHaveLength(2);
    });

    it('respects configurable retention days', () => {
      state.auditRetentionDays = 7;
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();

      state.auditLog = [
        { timestamp: eightDaysAgo, documentHash: 'old', provider: 'gemini', status: 'success' }
      ];

      purgeOldAuditEntries();

      expect(state.auditLog).toHaveLength(0);
    });
  });

  describe('max entries', () => {
    it('does not exceed MAX_AUDIT_ENTRIES', async () => {
      // Pre-fill to the limit
      state.auditLog = Array.from({ length: MAX_AUDIT_ENTRIES }, (_, i) => ({
        timestamp: new Date().toISOString(),
        documentHash: `hash-${i}`,
        fileSizeBytes: 100,
        provider: 'gemini',
        model: 'gemini-2.0-flash',
        editsReturned: 0,
        status: 'success'
      }));

      await writeAuditLogEntry({
        filename: 'one-more.docx',
        fileSizeBytes: 200,
        provider: 'gemini',
        model: 'gemini-2.0-flash',
        editsReturned: 1,
        status: 'success'
      });

      expect(state.auditLog.length).toBeLessThanOrEqual(MAX_AUDIT_ENTRIES);
    });

    it('drops the oldest entry when at capacity', async () => {
      state.auditLog = Array.from({ length: MAX_AUDIT_ENTRIES }, (_, i) => ({
        timestamp: new Date().toISOString(),
        documentHash: `hash-${i}`,
        fileSizeBytes: 100,
        provider: 'gemini',
        model: 'gemini-2.0-flash',
        editsReturned: 0,
        status: 'success'
      }));

      const firstHashBefore = state.auditLog[0].documentHash;

      await writeAuditLogEntry({
        filename: 'overflow.docx',
        fileSizeBytes: 300,
        provider: 'openrouter',
        model: 'gpt-4o',
        editsReturned: 2,
        status: 'success'
      });

      expect(state.auditLog[0].documentHash).not.toBe(firstHashBefore);
      expect(state.auditLog[state.auditLog.length - 1].provider).toBe('openrouter');
    });
  });
});
