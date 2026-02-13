const API_TIMEOUT = 120000;

let _lastRequestElapsedMs = 0;

async function fetchWithTimeout(url, options, timeout = API_TIMEOUT) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  const startTime = Date.now();

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    return response;
  } catch (error) {
    _lastRequestElapsedMs = Date.now() - startTime;
    throw error;
  } finally {
    _lastRequestElapsedMs = Date.now() - startTime;
    clearTimeout(timeoutId);
  }
}

const AI_BASE_PROMPT = `You are a senior commercial lawyer conducting a thorough redline review. You analyze contracts against playbook rules to identify both missing provisions (GAPs) and misaligned language (MISALIGNMENTs), then produce precise edits.
Return ONLY a valid JSON object. No markdown, no explanation, no code blocks.`;

const AI_ANALYSIS_INSTRUCTIONS = `
## Your Task
Analyze the CONTRACT against the PLAYBOOK rules and suggest specific text changes. You must identify BOTH:
- **Missing clauses** that the playbook requires but the contract lacks entirely (GAPs)
- **Misaligned language** where the contract addresses a topic but differently from the playbook (MISALIGNMENTs)

## Step 1: Structured Reasoning (MANDATORY)

You MUST complete the following analysis BEFORE generating edits. Your reasoning MUST be returned as a structured object (not a plain string).

### Document Scan
Read the entire contract. If a DOCUMENT STRUCTURE ANALYSIS and PARAGRAPH MAP appear at the top of the contract text, use them. If not, determine the structure yourself: what clauses exist, whether numbering is automatic (Word styles) or manual (typed), and the clause hierarchy.

### Rule Extraction
Read the playbook carefully. Extract every distinct rule or position it contains. Count them. Each rule becomes one entry in your analysis array — no exceptions.

### Classification (MANDATORY — every rule must appear)
For EACH rule extracted from the playbook:
1. Name the rule (what the playbook requires)
2. Find the corresponding contract clause (or note "None — missing")
3. Classify as MISALIGNMENT, GAP, ADEQUATE, or FLAGGED
4. State what action you took (edit generated, new clause inserted, no edit, or flagged)
5. Explain why in one sentence

Status definitions:
- **MISALIGNMENT**: Contract addresses this but differs from playbook → surgical edit generated
- **GAP**: Contract does not address this at all → new clause inserted
- **ADEQUATE**: Contract already meets playbook intent → no edit needed
- **FLAGGED**: Requires human judgment (e.g., deleting entire clause, commercial decisions) → flagged for review

MANDATORY: If the playbook contains 12 rules, your analysis array must contain 12 entries. Silent omissions are not acceptable. If you considered a rule and decided not to act, you must still include it as ADEQUATE or FLAGGED with an explanation.

### Edit Planning
Before writing edits, plan each one:
- GAPs: WHERE to insert (anchor clause) and WHAT the new text should say
- MISALIGNMENTs: the MINIMUM text to target and MINIMUM change needed
- Each edit must reference the specific playbook rule it addresses (in the "rule" field)

### Completeness Check
Before returning your response:
1. Count the rules in the playbook. Count entries in your analysis array. These numbers MUST match.
2. Verify every analysis entry with status MISALIGNMENT or GAP has a corresponding edit.
3. Verify every edit references a rule from the analysis.
4. Common rules models skip (check you haven't missed these):
   - Compelled disclosure (often missing from contracts — this is a GAP, not something to ignore)
   - Remedies / equitable relief (often missing — GAP)
   - No implied licence / IP (often missing — GAP)
   - Non-solicitation (must be addressed even if FLAGGED)
   - Liability caps (must be addressed even if the decision is complex)

## Output Format
Return a JSON object with this exact structure:
{
  "reasoning": {
    "document_summary": "Brief description: document type, parties, key terms",
    "playbook_rules_found": 12,
    "analysis": [
      {
        "rule": "Name of the playbook rule/position",
        "contract_clause": "Clause X(y) or 'None — missing'",
        "status": "MISALIGNMENT | GAP | ADEQUATE | FLAGGED",
        "action": "What was done (e.g., 'Narrowed scope to 12 months', 'No edit', 'Inserted new clause')",
        "explanation": "Why — what the document says vs what the playbook requires"
      }
    ]
  },
  "edits": [
    {
      "rule": "Name of the playbook rule this edit addresses",
      "edit_type": "GAP or MISALIGNMENT",
      "target_text": "exact text to find in the document",
      "new_text": "replacement text (empty string to delete)",
      "comment": "brief explanation referencing the playbook rule"
    }
  ],
  "summary": "brief summary of changes (1-2 sentences)"
}

The analysis array must have one entry per playbook rule. playbook_rules_found must equal analysis.length.

### edit_type Values
- **"GAP"**: Inserting a new clause or provision that is entirely missing from the document
- **"MISALIGNMENT"**: Modifying existing text to align with the playbook position

## Rules for Creating Edits

### Finding Text (target_text)
- Must be an EXACT quote from the document — copy/paste precision
- Include enough context to be unique (usually 5-15 words)
- Copy text exactly as it appears, including any **bold** or _italic_ markers
- If text appears multiple times, include surrounding words to disambiguate

### Replacement Text (new_text)
- For modifications: provide the complete replacement text
- For deletions: use empty string ""
- For insertions at a location: include anchor text + new content
- Do NOT include ** or _ markers — formatting is preserved automatically
- Preserve the original style and tone of the document

### Comments
- Start with "GAP:" or "MISALIGNMENT:" to match the edit_type
- Reference the specific playbook rule that triggered this edit
- Be concise (1 sentence)
- Explain WHY the change is needed, not just WHAT changed

## Edit Precision Rules (CRITICAL)

### Surgical Precision — change ONLY what the playbook requires
- Make ONLY the changes justified by the playbook. Do not "improve", "clean up", or "modernise" surrounding text.
- Preserve sentence structure. If the playbook requires changing "exclusive" to "non-exclusive", edit that one word — do not rewrite the entire clause.
- When adding new language to an existing clause (e.g., adding a carve-out, a proviso, or extending a definition), INSERT at the right point. Include the anchor text + your addition. Do NOT delete and rewrite the whole clause.
- Do not modify whitespace characters (tabs, spaces, extra line breaks) unless the edit substantively requires it. Whitespace-only changes produce confusing visual noise in track changes.
- Never include ** or __ formatting markers in target_text or new_text.

### Insertion Rules (CRITICAL for GAP edits)
- Never delete existing adequate text to make room for new insertions. When inserting new clauses, anchor to the END of the preceding clause and append using \\n. The original clauses must remain untouched in the redline.
- When inserting a new sub-clause (e.g., adding 1(d) after 1(c)), anchor to the end of the preceding sub-clause and append. Do NOT delete and reinsert the preceding text — this creates visual noise (a strikethrough and reinsertion of identical words).
- Never produce an edit where target_text and new_text differ only in whitespace. If your only change would be adding or removing spaces, tabs, or line breaks, skip that edit entirely.
- When modifying a sentence, ensure your target_text includes ALL the text that needs to change. If you are replacing the end of a sentence, include everything from your edit point through to the period. Do not leave orphaned words from the original text.

### WRONG vs RIGHT Examples

MISALIGNMENT — WRONG (rewriting a whole clause):
  target_text: "The Receiving Party shall keep all Confidential Information strictly confidential and shall not disclose it to any third party"
  new_text: "The Receiving Party agrees to maintain the confidentiality of all Confidential Information received from the Disclosing Party and shall not disclose such information to any third party without prior written consent"
  (This rewrites the entire sentence when only the consent requirement needed adding)

MISALIGNMENT — RIGHT (surgical insertion):
  target_text: "shall not disclose it to any third party"
  new_text: "shall not disclose it to any third party without the prior written consent of the Disclosing Party"
  (Targets only the specific phrase that needs the addition)

WRONG — rewriting a clause that already achieves the playbook's intent:
  target_text: "keep information confidential using reasonable measures"
  new_text: "maintain the confidentiality of information using commercially reasonable security measures"
  (Same meaning, different words — no edit needed)

RIGHT — no edit produced (the clause already achieves the playbook's intent)

GAP — RIGHT (inserting a missing clause):
  edit_type: "GAP"
  target_text: "and shall provide written certification of such destruction within 7 days of the request."
  new_text: "and shall provide written certification of such destruction within 7 days of the request.\\n\\nCompelled Disclosure\\n\\nIf the Receiving Party is required by law, regulation, or court order to disclose any Confidential Information, it shall (to the extent legally permitted) give the Disclosing Party prompt written notice and cooperate to limit the scope of disclosure."
  comment: "GAP: Playbook requires a compelled disclosure provision — no such clause exists in this document."
  (Anchors to the end of a nearby clause and appends the new provision using \\n for paragraph breaks)

WRONG — deleting an existing clause to insert new content before it:
  target_text: "9. This Agreement constitutes the entire agreement between the parties..."
  new_text: "9. Nothing in this Agreement shall be construed as granting any licence... 9A. [remedies clause]... 9B. This Agreement constitutes the entire agreement..."
  (This deletes the original clause 9 and recreates it later — produces an alarming strikethrough of the entire clause)

RIGHT — anchoring to the clause BEFORE the insertion point:
  target_text: "The parties submit to the exclusive jurisdiction of the English courts."
  new_text: "The parties submit to the exclusive jurisdiction of the English courts.\\n\\n8A. Nothing in this Agreement shall be construed as granting any licence..."
  (Inserts new clauses AFTER the preceding clause, leaving all existing clauses untouched)

WRONG — renumbering all clauses after an insertion:
  Multiple edits changing "5.", "6.", "7." to "6.", "7.", "8."
  (Never renumber existing clauses)

RIGHT — using sub-numbering for inserted clauses:
  "4A." inserted between clauses 4 and 5

## Numbering Rules

If a DOCUMENT STRUCTURE ANALYSIS section appears at the top of the contract text, follow its numbering guidance. Otherwise, determine the numbering scheme yourself:
- If clauses have consistent formatting and indentation-based hierarchy with no visible numbers in the text, treat the document as AUTO-NUMBERED (Word styles generate the numbers)
- If clause numbers are typed directly in the text, treat it as MANUALLY-NUMBERED

Key rules:
- For AUTO-NUMBERED documents: do NOT include clause numbers in target_text or new_text. The document styles generate numbers automatically. Just provide the text content.
- For MANUALLY-NUMBERED documents: when inserting between existing clauses, use sub-numbering (e.g., "4A." between 4 and 5). Never renumber existing clauses — this creates a cascade of cosmetic track changes.
- For BOTH: when inserting a new clause, use \\n (newline) to separate the heading from the body text if the document uses block-style clauses.

## Track Change Awareness

Your edits will be converted into Word track changes:
- Deleted text appears as red strikethrough
- Inserted text appears as coloured underline
- A redline with 5 precise word-level changes is far more useful to a reviewing lawyer than 2 whole-clause rewrites
- Heavy edits (deleting and reinserting 30+ words) produce cluttered, hard-to-review documents
- The reviewing lawyer needs to see exactly what changed — your comment field should explain the playbook justification

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
- If no changes are needed, return the full structured response with an empty edits array — every playbook rule must still appear in the analysis with ADEQUATE status
- Quality over quantity — fewer precise edits are better than many vague ones
- When in doubt, err on the side of caution and explain in the comment
- A clause that says "keep information confidential" does NOT need rewriting just because the playbook says "maintain the confidentiality of information" — same meaning, different words
- You MUST produce GAP edits for missing clauses — finding only text swaps is incomplete analysis
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
        generationConfig: { temperature: 1.0, maxOutputTokens: 65536 }
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
        temperature: 1.0,
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
      console.warn(`[VL-DEBUG] API timeout after ${_lastRequestElapsedMs}ms (limit: ${API_TIMEOUT}ms)`, { url: config.endpointUrl });
      throw new Error('API request timed out. Please try again.');
    }
    throw new Error('Network error. Please check your connection and try again.');
  }

  if (!response.ok) {
    const status = response.status;
    const retryAfter = response.headers.get('retry-after');
    const rateLimitRemaining = response.headers.get('x-ratelimit-remaining-requests')
      || response.headers.get('x-ratelimit-remaining-requests-per-minute');
    const errorBody = await response.text().catch(() => '');
    let errorObj = {};
    try { errorObj = JSON.parse(errorBody); } catch {}

    console.warn('[VL-DEBUG] API error response', {
      status,
      statusText: response.statusText,
      retryAfter,
      rateLimitRemaining,
      body: errorBody.slice(0, 500)
    });

    if (status === 429) {
      throw new Error(`Rate limited by ${config.name} (429). ${retryAfter ? `Retry after ${retryAfter}s.` : 'Please wait and try again.'}`);
    }

    const errorMessage = errorObj.error?.message || errorBody;
    if (config.name === 'OpenRouter' && (status === 401 || status === 403 || /no user found|invalid.*key|unauthorized/i.test(errorMessage))) {
      throw new Error('OpenRouter API key not recognised. Please check your key in Settings.');
    }
    throw new Error(errorObj.error?.message || `${config.name} API error: ${status}`);
  }

  console.log('[VL-DEBUG] API response OK', {
    elapsedMs: _lastRequestElapsedMs,
    rateLimitRemaining: response.headers.get('x-ratelimit-remaining-requests')
      || response.headers.get('x-ratelimit-remaining-requests-per-minute')
  });

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
  let parseMethod = 'unknown';

  const codeBlockMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)(?:\n?```|$)/);
  if (codeBlockMatch) cleaned = codeBlockMatch[1].trim();

  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) cleaned = jsonMatch[0];

  cleaned = cleaned.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  const parsed = tryParseJSON(cleaned);
  if (parsed) {
    parseMethod = 'direct';
    const result = validateEdits(parsed);
    console.log('[VL-DEBUG] AI response parsed', { parseMethod, editCount: result.edits.length });
    return result;
  }

  const fixedCommas = cleaned.replace(/,\s*([}\]])/g, '$1');
  const parsed2 = tryParseJSON(fixedCommas);
  if (parsed2) {
    parseMethod = 'trailing-comma-fix';
    const result = validateEdits(parsed2);
    console.log('[VL-DEBUG] AI response parsed', { parseMethod, editCount: result.edits.length });
    return result;
  }

  const repaired = repairTruncatedJSON(fixedCommas);
  if (repaired) {
    const parsed3 = tryParseJSON(repaired);
    if (parsed3) {
      parseMethod = 'truncation-repair';
      const result = validateEdits(parsed3);
      console.log('[VL-DEBUG] AI response parsed', { parseMethod, editCount: result.edits.length });
      return result;
    }
  }

  const rescued = rescueEdits(cleaned);
  if (rescued.length > 0) {
    parseMethod = 'regex-rescue';
    console.log('[VL-DEBUG] AI response parsed', { parseMethod, editCount: rescued.length });
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
      rule: edit.rule || '',
      edit_type: edit.edit_type || 'MISALIGNMENT',
      target_text: edit.target_text.trim(),
      new_text: edit.new_text,
      comment: edit.comment || ''
    }));
  const result = {
    edits: validEdits,
    summary: parsed.summary || `Found ${validEdits.length} suggested changes`
  };
  // Extract structured reasoning — check multiple locations where the AI might place it
  let reasoning = parsed.reasoning;
  if (!reasoning && parsed.analysis) {
    // AI put analysis at top level instead of inside reasoning
    reasoning = { analysis: parsed.analysis, document_summary: parsed.document_summary || '', playbook_rules_found: parsed.playbook_rules_found };
    console.log('[VL-DEBUG] AI placed analysis at top level — restructured into reasoning object');
  }
  if (reasoning) {
    if (typeof reasoning === 'object' && !Array.isArray(reasoning)) {
      // Ensure analysis array exists — check alternative key names
      if (!reasoning.analysis && Array.isArray(reasoning.rules)) {
        reasoning.analysis = reasoning.rules;
      } else if (!reasoning.analysis && Array.isArray(reasoning.assessments)) {
        reasoning.analysis = reasoning.assessments;
      } else if (!reasoning.analysis && Array.isArray(reasoning.entries)) {
        reasoning.analysis = reasoning.entries;
      }
      if (Array.isArray(reasoning.analysis)) {
        result.reasoning = reasoning;
        const statuses = reasoning.analysis.map(a => a.status);
        console.log('[VL-DEBUG] AI reasoning (structured):', {
          document_summary: (reasoning.document_summary || '').substring(0, 200),
          topics: reasoning.analysis.length,
          statuses: statuses.reduce((acc, s) => { acc[s] = (acc[s] || 0) + 1; return acc; }, {})
        });
      } else {
        // Object but no analysis array found
        result.reasoning = JSON.stringify(reasoning);
        console.warn('[VL-DEBUG] AI reasoning is object but has no analysis array, keys:', Object.keys(reasoning));
      }
    } else if (typeof reasoning === 'string') {
      result.reasoning = reasoning;
      console.log('[VL-DEBUG] AI reasoning (string):', reasoning.substring(0, 500));
    } else {
      result.reasoning = JSON.stringify(reasoning);
      console.log('[VL-DEBUG] AI reasoning (other):', typeof reasoning);
    }
  } else {
    console.warn('[VL-DEBUG] AI response missing reasoning field — model may have skipped structured analysis');
  }
  const gapCount = validEdits.filter(e => e.edit_type === 'GAP').length;
  const misalignCount = validEdits.filter(e => e.edit_type === 'MISALIGNMENT').length;
  console.log('[VL-DEBUG] Edit types', { GAP: gapCount, MISALIGNMENT: misalignCount, total: validEdits.length });
  return result;
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
  const pattern = /\{\s*(?:"rule"\s*:\s*"(?:[^"\\]|\\.)*"\s*,\s*)?(?:"edit_type"\s*:\s*"(?:[^"\\]|\\.)*"\s*,\s*)?"target_text"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"new_text"\s*:\s*"((?:[^"\\]|\\.)*)"\s*(?:,\s*"comment"\s*:\s*"((?:[^"\\]|\\.)*)")?\s*\}/g;
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
    console.log(`[VL-DEBUG] Local rate limit reached, waiting ${Math.ceil(waitMs / 1000)}s`);
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

  const result = await sendRequest(config, {
    system: AI_BASE_PROMPT + AI_ANALYSIS_INSTRUCTIONS,
    user: `CONTRACT:
${contractText}

---

PLAYBOOK RULES:
${playbookText}

---

Analyze the contract above against the playbook rules. You MUST address EVERY rule in the playbook — extract each rule, find the corresponding contract clause, classify it, and explain your decision. Your analysis array must have one entry per playbook rule with no omissions. Then generate edits for every MISALIGNMENT and GAP. Return the complete JSON with reasoning and edits.`
  });

  const playbookLines = playbookText.split('\n').filter(l => l.trim().length > 0);
  console.log('[VL-DEBUG] AI edit coverage', {
    playbookLines: playbookLines.length,
    editsReturned: result.edits.length
  });

  return result;
}

export async function testConnection({ provider, apiKey }) {
  const preset = PROVIDER_PRESETS[provider];
  if (!preset) {
    return { success: false, error: 'Unknown provider' };
  }

  try {
    if (provider === 'openrouter') {
      const authResp = await fetchWithTimeout(
        'https://openrouter.ai/api/v1/auth/key',
        { headers: { 'Authorization': `Bearer ${apiKey}` } },
        15000
      );
      if (!authResp.ok) {
        return { success: false, error: 'API key not recognised. Check your key starts with sk-or-v1-' };
      }
    }

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
