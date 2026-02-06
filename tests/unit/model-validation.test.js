import { describe, it, expect } from 'vitest';
import { _validateModelId } from '../../src/utils/ai-bundle.js';

describe('validateModelId', () => {
  describe('valid model strings', () => {
    it('accepts gemini-2.0-flash', () => {
      expect(() => _validateModelId('gemini-2.0-flash')).not.toThrow();
    });

    it('accepts gpt-4o', () => {
      expect(() => _validateModelId('gpt-4o')).not.toThrow();
    });

    it('accepts claude-sonnet-4-20250514', () => {
      expect(() => _validateModelId('claude-sonnet-4-20250514')).not.toThrow();
    });

    it('accepts model IDs with dots and underscores', () => {
      expect(() => _validateModelId('models_v2.5-beta')).not.toThrow();
    });
  });

  describe('path traversal attempts', () => {
    it('rejects ../../v1/other', () => {
      expect(() => _validateModelId('../../v1/other')).toThrow('Invalid model ID');
    });

    it('rejects strings with forward slashes', () => {
      expect(() => _validateModelId('models/gemini-pro')).toThrow('Invalid model ID');
    });

    it('rejects strings with query parameters', () => {
      expect(() => _validateModelId('gemini?key=stolen')).toThrow('Invalid model ID');
    });

    it('rejects strings with hash fragments', () => {
      expect(() => _validateModelId('gemini#fragment')).toThrow('Invalid model ID');
    });

    it('rejects strings with URL-encoded characters', () => {
      expect(() => _validateModelId('gemini%2F..%2Fv1')).toThrow('Invalid model ID');
    });
  });

  describe('empty and missing input', () => {
    it('rejects empty string', () => {
      expect(() => _validateModelId('')).toThrow('Invalid model ID');
    });

    it('rejects null', () => {
      expect(() => _validateModelId(null)).toThrow('Invalid model ID');
    });

    it('rejects undefined', () => {
      expect(() => _validateModelId(undefined)).toThrow('Invalid model ID');
    });
  });
});
