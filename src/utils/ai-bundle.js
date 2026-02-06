/**
 * AI Client for contract analysis
 * Supports Google Gemini and OpenRouter APIs via a provider abstraction layer.
 * Non-module version for Chrome extension
 */

// API request timeout (2 minutes)
const API_TIMEOUT = 120000;

/**
 * Fetch with timeout
 */
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

// Base system prompt for contract analysis
const AI_BASE_PROMPT = `You are a legal document reviewer. Analyze this contract against the playbook rules.
Return ONLY a valid JSON object with your suggested edits. No markdown, no explanation, no code blocks.`;

// Detailed analysis instructions
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
- Don't include paragraph numbers or formatting markers
- If text appears multiple times, include surrounding words to disambiguate

### Replacement Text (new_text)
- For modifications: provide the complete replacement text
- For deletions: use empty string ""
- For insertions at a location: include anchor text + new content
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

## Important Notes
- If no changes are needed, return: {"edits": [], "summary": "No changes required based on playbook analysis"}
- Quality over quantity - fewer precise edits are better than many vague ones
- When in doubt, err on the side of caution and explain in the comment
`;

/**
 * Validate model ID for safe URL interpolation.
 * Only allows alphanumeric characters, hyphens, dots, and underscores.
 */
const SAFE_MODEL_ID = /^[a-zA-Z0-9._-]+$/;

function validateModelId(model) {
  if (!model || !SAFE_MODEL_ID.test(model)) {
    throw new Error('Invalid model ID. Please select a valid model in Settings.');
  }
}

// ---------------------------------------------------------------------------
// Provider abstraction layer
// ---------------------------------------------------------------------------

/**
 * Request format handlers.
 * Each format knows how to build a request body and extract the content
 * from the provider's response shape.
 */
const REQUEST_FORMATS = {
  gemini: {
    buildBody(systemMessage, userPrompt) {
      return {
        contents: [{ parts: [{ text: userPrompt }] }],
        systemInstruction: { parts: [{ text: systemMessage }] },
        generationConfig: { temperature: 0.1, maxOutputTokens: 8192 }
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
        max_tokens: 8192
      };
    },
    extractContent(data) {
      return data.choices?.[0]?.message?.content;
    }
  }
};

/**
 * Built-in provider presets.
 * Each preset defines how to build a provider config for that service.
 */
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

/**
 * Build a flat provider config from a preset, API key, and model.
 * Returns an object with: name, endpointUrl, authHeaderName,
 * authHeaderValue, requestFormat, modelId.
 */
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

/**
 * Send a request to any provider through a single code path.
 */
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
    // Gemini returns 200 but no content when safety filters block the response
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

  return parseAIResponse(content);
}

/**
 * Parse and validate AI response
 */
function parseAIResponse(content) {
  let cleaned = content.trim();

  // Remove markdown code blocks anywhere in the response (not just at start)
  const codeBlockMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    cleaned = codeBlockMatch[1].trim();
  }

  // Try to extract JSON object
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    cleaned = jsonMatch[0];
  }

  // Sanitize control characters that break JSON parsing
  cleaned = cleaned.replace(/[\x00-\x1F\x7F]/g, (char) => {
    if (char === '\n' || char === '\r' || char === '\t') return char;
    return '';
  });

  try {
    const parsed = JSON.parse(cleaned);

    if (!parsed.edits || !Array.isArray(parsed.edits)) {
      return { edits: [], summary: 'Invalid response format - no edits array' };
    }

    // Validate and clean each edit
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
  } catch (e) {
    // Include a preview of what the AI returned so the user can diagnose
    const preview = content.length > 200 ? content.substring(0, 200) + '…' : content;
    const noClosingBrace = content.includes('{') && !content.includes('}');
    const hint = noClosingBrace
      ? ' The response appears truncated — try a model with a larger output limit.'
      : ' The AI returned text instead of JSON — try again or use a different model.';
    throw new Error('Failed to parse AI response.' + hint + '\n\nAI returned: ' + preview);
  }
}

/**
 * Simple sliding-window rate limiter.
 * Tracks timestamps of recent API calls and waits if the limit is reached.
 */
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const _rateLimitTimestamps = [];

async function enforceRateLimit() {
  const now = Date.now();

  // Discard timestamps outside the window
  while (_rateLimitTimestamps.length > 0 && _rateLimitTimestamps[0] <= now - RATE_LIMIT_WINDOW_MS) {
    _rateLimitTimestamps.shift();
  }

  if (_rateLimitTimestamps.length >= RATE_LIMIT_MAX) {
    const waitMs = _rateLimitTimestamps[0] + RATE_LIMIT_WINDOW_MS - now;
    console.log(`Rate limit reached, waiting ${Math.ceil(waitMs / 1000)}s...`);
    await new Promise(resolve => setTimeout(resolve, waitMs));
    // Clean up again after waiting
    const after = Date.now();
    while (_rateLimitTimestamps.length > 0 && _rateLimitTimestamps[0] <= after - RATE_LIMIT_WINDOW_MS) {
      _rateLimitTimestamps.shift();
    }
  }

  _rateLimitTimestamps.push(Date.now());
}

/**
 * Main entry point - analyze contract with selected provider
 */
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

/**
 * Test API connection and fetch available models
 */
export async function testConnection({ provider, apiKey }) {
  const TEST_TIMEOUT = 15000; // 15 seconds for connection test

  const preset = PROVIDER_PRESETS[provider];
  if (!preset) {
    return { success: false, error: 'Unknown provider' };
  }

  try {
    const response = await fetchWithTimeout(
      preset.testEndpointUrl,
      { headers: { [preset.authHeaderName]: preset.buildAuthValue(apiKey) } },
      TEST_TIMEOUT
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

// Exported for unit testing — not part of the public API
export { parseAIResponse as _parseAIResponse };
export { validateModelId as _validateModelId };
export { enforceRateLimit as _enforceRateLimit };
export { _rateLimitTimestamps };
export { REQUEST_FORMATS as _REQUEST_FORMATS };
