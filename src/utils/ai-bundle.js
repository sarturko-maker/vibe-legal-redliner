const API_TIMEOUT = 120000;

async function fetchWithTimeout(url, options, timeout = API_TIMEOUT) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

const AI_BASE_PROMPT = `You are a legal document reviewer. Analyze this contract against the playbook rules.
Return ONLY a valid JSON object with your suggested edits. No markdown, no explanation, no code blocks.`;

const AI_ANALYSIS_INSTRUCTIONS = `
## Your Task
Analyze the CONTRACT against the PLAYBOOK rules and suggest specific text changes.

## Output Format
Return a JSON object with this exact structure:
{
  "edits": [
    {
      "target_text": "exact text to find in the document",
      "new_text": "replacement text (empty string to delete)",
      "comment": "brief explanation referencing the playbook rule"
    }
  ],
  "summary": "brief summary of changes (1-2 sentences)"
}

## Rules for Creating Edits

### Finding Text (target_text)
- Must be an EXACT quote from the document - copy/paste precision
- Include enough context to be unique (usually 5-15 words)
- Copy text exactly as it appears, including any **bold** or _italic_ markers
- Don't include paragraph numbers like "1." or "a)"
- If text appears multiple times, include surrounding words to disambiguate

### Replacement Text (new_text)
- For modifications: provide the complete replacement text
- For deletions: use empty string ""
- For insertions at a location: include anchor text + new content
- Do NOT include ** or _ markers — formatting is preserved automatically
- Preserve the original style and tone of the document

### Comments
- Reference the specific playbook rule that triggered this edit
- Be concise (1 sentence)
- Explain WHY the change is needed, not just WHAT changed

## Redlining Principles

1. **Minimal Changes**: Only change what the playbook requires. Don't rewrite clauses unnecessarily.

2. **Surgical Precision**: Target the specific problematic language, not entire paragraphs.

3. **Preserve Structure**: Keep numbering, formatting, and document organization intact.

4. **Legal Accuracy**: Ensure replacements are legally sound and internally consistent.

5. **Balanced Approach**: Flag issues for review rather than making aggressive changes when uncertain.

## Examples

### Example 1: Modifying a Liability Cap
{
  "target_text": "Supplier's total liability shall not exceed $10,000",
  "new_text": "Supplier's total liability shall not exceed the total fees paid under this Agreement in the twelve (12) months preceding the claim",
  "comment": "Playbook requires liability cap tied to fees paid, not fixed amount"
}

### Example 2: Adding Missing Language
{
  "target_text": "shall keep confidential all information",
  "new_text": "shall keep confidential all information, provided that this obligation shall not apply to information that: (a) is or becomes publicly available through no fault of the receiving party; (b) was known to the receiving party prior to disclosure; or (c) is independently developed by the receiving party",
  "comment": "Adding standard confidentiality exclusions per playbook"
}

### Example 3: Deleting Problematic Text
{
  "target_text": "The Receiving Party shall not challenge the validity of any intellectual property rights of the Disclosing Party.",
  "new_text": "",
  "comment": "Removing non-challenge provision - not acceptable per playbook"
}

## CriticMarkup — Document Revision History

The contract text may contain CriticMarkup showing tracked changes from prior negotiation rounds:
- {--deleted text--} — text that was deleted in a previous round
- {++inserted text++} — text that was inserted in a previous round
- {>>comment text<<} — a reviewer comment attached to nearby text

Consider this revision history when analyzing the contract. It provides context about what has already been negotiated and changed. However:
- Do NOT use CriticMarkup syntax in your target_text or new_text values
- When quoting text in target_text, include the CriticMarkup markers exactly as they appear
- Your new_text should contain plain text only (no CriticMarkup wrappers)

## Important Notes
- If no changes are needed, return: {"edits": [], "summary": "No changes required based on playbook analysis"}
- Quality over quantity - fewer precise edits are better than many vague ones
- When in doubt, err on the side of caution and explain in the comment
`;

const SAFE_MODEL_ID = /^[a-zA-Z0-9._-]+$/;

function validateModelId(model) {
  if (!model || !SAFE_MODEL_ID.test(model)) {
    throw new Error('Invalid model ID. Please select a valid model in Settings.');
  }
}

const REQUEST_FORMATS = {
  gemini: {
    buildBody(systemMessage, userPrompt) {
      return {
        contents: [{ parts: [{ text: userPrompt }] }],
        systemInstruction: { parts: [{ text: systemMessage }] },
        generationConfig: { temperature: 0.1, maxOutputTokens: 65536 }
      };
    },
    extractContent(data) {
      return data.candidates?.[0]?.content?.parts?.[0]?.text;
    }
  },
  openai: {
    buildBody(systemMessage, userPrompt, modelId) {
      return {
        model: modelId,
        messages: [
          { role: 'system', content: systemMessage },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.1,
        max_tokens: 65536
      };
    },
    extractContent(data) {
      return data.choices?.[0]?.message?.content;
    }
  }
};

const PROVIDER_PRESETS = {
  gemini: {
    name: 'Gemini',
    buildEndpointUrl(model) {
      validateModelId(model);
      return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    },
    authHeaderName: 'x-goog-api-key',
    buildAuthValue(apiKey) { return apiKey; },
    requestFormat: 'gemini',
    extraHeaders: {},
    testEndpointUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
    parseTestModels(data) {
      return data.models
        ?.filter(m => m.supportedGenerationMethods?.includes('generateContent'))
        ?.map(m => ({
          id: m.name.replace('models/', ''),
          name: m.displayName || m.name.replace('models/', '')
        })) || [];
    }
  },
  openrouter: {
    name: 'OpenRouter',
    buildEndpointUrl() {
      return 'https://openrouter.ai/api/v1/chat/completions';
    },
    authHeaderName: 'Authorization',
    buildAuthValue(apiKey) { return `Bearer ${apiKey}`; },
    requestFormat: 'openai',
    extraHeaders: {
      'HTTP-Referer': 'chrome-extension://vibe-legal-redliner',
      'X-Title': 'Vibe Legal Redliner'
    },
    testEndpointUrl: 'https://openrouter.ai/api/v1/models',
    parseTestModels(data) {
      return data.data
        ?.filter(m => m.id.includes('gemini') || m.id.includes('claude') || m.id.includes('gpt'))
        ?.slice(0, 20)
        ?.map(m => ({
          id: m.id,
          name: m.name || m.id
        })) || [];
    }
  }
};

function buildProviderConfig(providerKey, apiKey, model) {
  const preset = PROVIDER_PRESETS[providerKey];
  if (!preset) {
    throw new Error(`Unknown provider: ${providerKey}`);
  }
  return {
    name: preset.name,
    endpointUrl: preset.buildEndpointUrl(model),
    authHeaderName: preset.authHeaderName,
    authHeaderValue: preset.buildAuthValue(apiKey),
    requestFormat: preset.requestFormat,
    modelId: model,
    extraHeaders: preset.extraHeaders
  };
}

async function sendRequest(config, prompt) {
  const format = REQUEST_FORMATS[config.requestFormat];
  if (!format) {
    throw new Error(`Unknown request format: ${config.requestFormat}`);
  }

  const headers = {
    'Content-Type': 'application/json',
    [config.authHeaderName]: config.authHeaderValue,
    ...config.extraHeaders
  };

  let response;
  try {
    response = await fetchWithTimeout(config.endpointUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(format.buildBody(prompt.system, prompt.user, config.modelId))
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('API request timed out. Please try again.');
    }
    throw new Error('Network error. Please check your connection and try again.');
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `${config.name} API error: ${response.status}`);
  }

  const data = await response.json();
  const content = format.extractContent(data);

  if (!content) {
    const blockReason = data.promptFeedback?.blockReason;
    const finishReason = data.candidates?.[0]?.finishReason;

    if (blockReason) {
      throw new Error(`${config.name} blocked the request (${blockReason}). The contract text may have triggered a safety filter. Try shortening the document or removing sensitive content.`);
    }
    if (finishReason && finishReason !== 'STOP') {
      throw new Error(`${config.name} stopped generating (${finishReason}). Try a different model or shorten the document.`);
    }
    throw new Error(`No response from ${config.name}. The model returned an empty result — try a different model.`);
  }

  const parsed = parseAIResponse(content);
  parsed.rawContent = content;
  return parsed;
}

function parseAIResponse(content) {
  let cleaned = content.trim();

  const codeBlockMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)(?:\n?```|$)/);
  if (codeBlockMatch) cleaned = codeBlockMatch[1].trim();

  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) cleaned = jsonMatch[0];

  cleaned = cleaned.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  const parsed = tryParseJSON(cleaned);
  if (parsed) return validateEdits(parsed);

  const fixedCommas = cleaned.replace(/,\s*([}\]])/g, '$1');
  const parsed2 = tryParseJSON(fixedCommas);
  if (parsed2) return validateEdits(parsed2);

  const repaired = repairTruncatedJSON(fixedCommas);
  if (repaired) {
    const parsed3 = tryParseJSON(repaired);
    if (parsed3) return validateEdits(parsed3);
  }

  const rescued = rescueEdits(cleaned);
  if (rescued.length > 0) {
    return {
      edits: rescued,
      summary: `Recovered ${rescued.length} edits from malformed response`
    };
  }

  const preview = content.length > 200 ? content.substring(0, 200) + '…' : content;
  throw new Error('Failed to parse AI response. Try a different model or simplify the playbook.\n\nAI returned: ' + preview);
}

function tryParseJSON(str) {
  try { return JSON.parse(str); } catch { return null; }
}

function validateEdits(parsed) {
  if (!Array.isArray(parsed.edits)) return { edits: [], summary: 'Invalid response format - no edits array' };
  const validEdits = parsed.edits
    .filter(edit => typeof edit.target_text === 'string' && typeof edit.new_text === 'string')
    .map(edit => ({
      target_text: edit.target_text.trim(),
      new_text: edit.new_text,
      comment: edit.comment || ''
    }));
  return {
    edits: validEdits,
    summary: parsed.summary || `Found ${validEdits.length} suggested changes`
  };
}

function repairTruncatedJSON(str) {
  let repaired = str.replace(/,\s*"[^"]*":\s*"[^"]*$/, '');
  if (repaired === str) repaired = str.replace(/,\s*\{[^}]*$/, '');

  const stack = [];
  let inString = false;
  let escaped = false;
  for (const ch of repaired) {
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') stack.push(ch);
    if (ch === '}' || ch === ']') stack.pop();
  }

  if (stack.length === 0) return null;
  const closers = stack.reverse().map(ch => ch === '{' ? '}' : ']').join('');
  return repaired + closers;
}

function rescueEdits(str) {
  const edits = [];
  const pattern = /\{\s*"target_text"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"new_text"\s*:\s*"((?:[^"\\]|\\.)*)"\s*(?:,\s*"comment"\s*:\s*"((?:[^"\\]|\\.)*)")?\s*\}/g;
  let m;
  while ((m = pattern.exec(str)) !== null) {
    try {
      edits.push({
        target_text: JSON.parse('"' + m[1] + '"').trim(),
        new_text: JSON.parse('"' + m[2] + '"'),
        comment: m[3] ? JSON.parse('"' + m[3] + '"') : ''
      });
    } catch {
      // skip malformed edit
    }
  }
  return edits;
}

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;
const _rateLimitTimestamps = [];

function pruneExpiredTimestamps() {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
  while (_rateLimitTimestamps.length > 0 && _rateLimitTimestamps[0] <= cutoff) {
    _rateLimitTimestamps.shift();
  }
}

async function enforceRateLimit() {
  pruneExpiredTimestamps();

  if (_rateLimitTimestamps.length >= RATE_LIMIT_MAX) {
    const waitMs = _rateLimitTimestamps[0] + RATE_LIMIT_WINDOW_MS - Date.now();
    await new Promise(resolve => setTimeout(resolve, waitMs));
    pruneExpiredTimestamps();
  }

  _rateLimitTimestamps.push(Date.now());
}

export async function analyzeContract({ provider, apiKey, model, contractText, playbookText }) {
  if (!apiKey) {
    throw new Error('No API key configured. Please add your API key in Settings before analyzing a contract.');
  }

  if (!contractText) {
    throw new Error('Contract text is required');
  }

  if (!playbookText) {
    throw new Error('Playbook rules are required');
  }

  await enforceRateLimit();

  const config = buildProviderConfig(provider, apiKey, model);

  return sendRequest(config, {
    system: AI_BASE_PROMPT + AI_ANALYSIS_INSTRUCTIONS,
    user: `PLAYBOOK RULES:
${playbookText}

---

CONTRACT TO REVIEW:
${contractText}

---

Analyze this contract against the playbook rules above. Return ONLY a JSON object with your suggested edits.`
  });
}

export async function testConnection({ provider, apiKey }) {
  const preset = PROVIDER_PRESETS[provider];
  if (!preset) {
    return { success: false, error: 'Unknown provider' };
  }

  try {
    const response = await fetchWithTimeout(
      preset.testEndpointUrl,
      { headers: { [preset.authHeaderName]: preset.buildAuthValue(apiKey) } },
      15000
    );

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error?.message || 'Invalid API key');
    }

    const data = await response.json();
    return { success: true, models: preset.parseTestModels(data) };
  } catch (error) {
    if (error.name === 'AbortError') {
      return { success: false, error: 'Connection timed out. Please check your API key and try again.' };
    }
    return { success: false, error: error.message };
  }
}

export { parseAIResponse as _parseAIResponse };
export { validateModelId as _validateModelId };
export { enforceRateLimit as _enforceRateLimit };
export { _rateLimitTimestamps };
export { REQUEST_FORMATS as _REQUEST_FORMATS };
