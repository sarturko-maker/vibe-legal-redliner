import { describe, it, expect } from 'vitest';
import { _parseAIResponse, _REQUEST_FORMATS } from '../../src/utils/ai-bundle.js';

const VALID_EDITS_JSON = JSON.stringify({
  edits: [
    {
      target_text: 'unlimited liability',
      new_text: 'liability capped at $1,000,000',
      comment: 'Per playbook section 4.2'
    }
  ],
  summary: 'Added liability cap'
});

describe('AI response parsing', () => {

  describe('Gemini format', () => {
    it('extracts and parses a valid Gemini response', () => {
      const geminiResponse = {
        candidates: [{
          content: {
            parts: [{ text: VALID_EDITS_JSON }]
          }
        }]
      };

      const content = _REQUEST_FORMATS.gemini.extractContent(geminiResponse);
      expect(content).toBe(VALID_EDITS_JSON);

      const result = _parseAIResponse(content);
      expect(result.edits).toHaveLength(1);
      expect(result.edits[0].target_text).toBe('unlimited liability');
      expect(result.edits[0].new_text).toBe('liability capped at $1,000,000');
      expect(result.edits[0].comment).toBe('Per playbook section 4.2');
      expect(result.summary).toBe('Added liability cap');
    });
  });

  describe('OpenRouter (OpenAI) format', () => {
    it('extracts and parses a valid OpenRouter response', () => {
      const openRouterResponse = {
        choices: [{
          message: { content: VALID_EDITS_JSON }
        }]
      };

      const content = _REQUEST_FORMATS.openai.extractContent(openRouterResponse);
      expect(content).toBe(VALID_EDITS_JSON);

      const result = _parseAIResponse(content);
      expect(result.edits).toHaveLength(1);
      expect(result.edits[0].target_text).toBe('unlimited liability');
      expect(result.summary).toBe('Added liability cap');
    });
  });

  describe('malformed JSON', () => {
    it('throws on unparseable input', () => {
      expect(() => _parseAIResponse('this is not json at all')).toThrow(/failed to parse/i);
    });

    it('handles JSON wrapped in markdown code blocks', () => {
      const wrapped = '```json\n' + VALID_EDITS_JSON + '\n```';
      const result = _parseAIResponse(wrapped);
      expect(result.edits).toHaveLength(1);
      expect(result.edits[0].target_text).toBe('unlimited liability');
    });

    it('handles code blocks preceded by text', () => {
      const wrapped = 'Here are the suggested edits:\n```json\n' + VALID_EDITS_JSON + '\n```\n';
      const result = _parseAIResponse(wrapped);
      expect(result.edits).toHaveLength(1);
      expect(result.edits[0].target_text).toBe('unlimited liability');
    });

    it('handles JSON embedded in surrounding text', () => {
      const messy = 'Here are the edits:\n' + VALID_EDITS_JSON + '\nHope that helps!';
      const result = _parseAIResponse(messy);
      expect(result.edits).toHaveLength(1);
    });
  });

  describe('empty response', () => {
    it('throws for empty string', () => {
      expect(() => _parseAIResponse('')).toThrow();
    });

    it('throws for whitespace-only', () => {
      expect(() => _parseAIResponse('   \n\n  ')).toThrow();
    });
  });

  describe('response with no edits array', () => {
    it('returns empty edits with descriptive summary', () => {
      const result = _parseAIResponse('{"summary": "Looks good", "notes": "no issues"}');
      expect(result.edits).toEqual([]);
      expect(result.summary).toBe('Invalid response format - no edits array');
    });

    it('handles edits that is not an array', () => {
      const result = _parseAIResponse('{"edits": "none", "summary": "ok"}');
      expect(result.edits).toEqual([]);
      expect(result.summary).toBe('Invalid response format - no edits array');
    });
  });

  describe('edit validation', () => {
    it('filters out edits missing target_text or new_text', () => {
      const json = JSON.stringify({
        edits: [
          { target_text: 'valid', new_text: 'also valid', comment: 'ok' },
          { target_text: 'missing new_text' },
          { new_text: 'missing target_text' },
          { comment: 'missing both' }
        ],
        summary: 'Mixed'
      });
      const result = _parseAIResponse(json);
      expect(result.edits).toHaveLength(1);
      expect(result.edits[0].target_text).toBe('valid');
    });
  });
});
