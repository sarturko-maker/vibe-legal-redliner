# Development Log — Pre-Release Quality Review

This is a living record of quality and security improvements applied to the Vibe Legal Chrome Extension during a self-directed pre-release review.

Each entry follows the ADR (Architecture Decision Record) format. Entries are updated in-place as changes are implemented. The review covered five categories: code quality, vulnerabilities, maintenance, security controls, and WebAssembly-specific concerns.

Entries are grouped by priority:
- **1-5:** Resolved before the repository was pushed to GitHub
- **6-10:** Resolved shortly after initial push
- **11-15:** Infrastructure improvements
- **16-20:** Future improvements and deferred items

---

## Priority 1-5 — Pre-Push

### ADR-001: Remove MOCK API key backdoor

- **Status:** DONE
- **Issue:** Debug code in `ai-bundle.js` returns hardcoded legal edits when API key equals `"MOCK"`, bypassing all AI provider validation.
- **Decision:** Deleted the entire `if (apiKey === 'MOCK')` block that returned hardcoded edits without calling any AI provider. The existing `if (!apiKey)` check was updated to provide a clear user-facing error message: "No API key configured. Please add your API key in Settings before analyzing a contract."
- **Rationale:** A magic string that bypasses the entire AI analysis pipeline is a security backdoor — anyone who discovers the string can produce fake legal edits that appear to come from AI analysis. Removing it ensures all contract analysis flows through a real, authenticated AI provider. The improved error message guides users to the correct fix instead of showing a generic "API key is required" error.
- **Files Changed:** `src/utils/ai-bundle.js` (`analyzeContract()` — removed MOCK block, improved empty-key error message)
- **Date Resolved:** 2026-02-06

---

### ADR-002: Remove localStorage fallback for API keys

- **Status:** DONE
- **Issue:** `app-bundle.js` falls back to `localStorage` for storing API keys and settings when `chrome.storage` is unavailable, which is less secure and accessible to other scripts in the same origin.
- **Decision:** Removed all `localStorage` usage. API key is now stored separately from other settings, routed to either `chrome.storage.local` (persistent, default) or `chrome.storage.session` (cleared on browser close) based on a "Remember API key" toggle in Settings. The toggle preference itself is always stored in `chrome.storage.local`. On save, the API key is written to the active area and explicitly removed from the other, preventing stale copies. Migration from the old format (apiKey inside the settings object) happens transparently on first load.
- **Rationale:** `localStorage` is accessible to any script running in the same origin and lacks the sandboxing of Chrome extension storage APIs. Splitting the API key into `chrome.storage.session` gives security-conscious users a zero-persistence option where the key is automatically wiped when the browser exits, with no manual cleanup needed.
- **Files Changed:** `src/app-bundle.js` (state, `loadSettings()`, `saveSettings()`, `handleChange()`, `renderSettingsPage()`)
- **Date Resolved:** 2026-02-06

---

### ADR-003: Move Gemini API key from URL parameter to request header

- **Status:** DONE
- **Issue:** The Gemini API key is passed as a URL query parameter (`?key=`), which is logged by proxies, browser history, network monitoring tools, and corporate TLS inspection appliances.
- **Decision:** Replaced `?key=` query parameter with the `x-goog-api-key` request header on both Gemini call sites: `callGemini()` (content generation) and `testConnection()` (model listing). This matches the pattern already used by OpenRouter (`Authorization: Bearer`).
- **Rationale:** HTTP request headers are not logged in browser history, are not visible in URL bars, and are not captured by most proxy access logs. The `x-goog-api-key` header is the Google-recommended alternative to the query parameter for API authentication.
- **Files Changed:** `src/utils/ai-bundle.js` (lines ~131, ~329)
- **Date Resolved:** 2026-02-06

---

### ADR-004: Remove unused CSP domains and host permissions

- **Status:** DONE
- **Issue:** The manifest CSP `connect-src` and `host_permissions` include `pypi.org`, `*.pypi.org`, `files.pythonhosted.org`, `*.pythonhosted.org`, and `cdn.jsdelivr.net` — none of which are used at runtime since Pyodide is bundled locally.
- **Decision:** Removed five domains from CSP `connect-src` (`pypi.org`, `*.pypi.org`, `files.pythonhosted.org`, `*.pythonhosted.org`, `cdn.jsdelivr.net`) and two entries from `host_permissions` (`pypi.org/*`, `files.pythonhosted.org/*`). The manifest now only permits connections to the two AI provider domains actually used at runtime: `generativelanguage.googleapis.com` and `openrouter.ai`.
- **Rationale:** Principle of least privilege. Every allowed domain is a potential exfiltration target if the extension is compromised. These domains were likely left over from early development when Pyodide packages were fetched from PyPI at runtime rather than bundled locally. Removing them shrinks the attack surface to the minimum required for the extension to function.
- **Files Changed:** `manifest.json` (`content_security_policy.extension_pages`, `host_permissions`)
- **Date Resolved:** 2026-02-06

---

### ADR-005: Update privacy policy to accurately describe data flows

- **Status:** DONE
- **Issue:** The privacy policy states "Your documents never leave your browser" but the full contract text is extracted and sent to third-party AI providers (Google Gemini or OpenRouter) for analysis. This is materially misleading.
- **Decision:** Rewrote the privacy policy from scratch. The TL;DR now explicitly states that extracted text is sent to the user's chosen AI provider. Added a prominent amber warning box calling out that contract text goes to a third party. Added a dedicated "Third-Party AI Providers" section with links to each provider's privacy policy. Replaced the misleading "What We Don't Collect" framing with a direct "What We Collect: Nothing" statement. The numbered data flow section now bold-highlights the step where text leaves the browser. Also reflects the new session-only API key storage option from ADR-002.
- **Rationale:** The previous policy drew a distinction between "files" and "text" that no reasonable user or regulator would accept. A privacy policy that understates data sharing is worse than no policy at all — it creates legal liability and erodes trust. The rewrite prioritises clarity over reassurance.
- **Files Changed:** `privacy-policy.html`
- **Date Resolved:** 2026-02-06

---

## Priority 6-10 — Post-Push

### ADR-006: Create SBOM with SHA-256 hashes for all dependencies

- **Status:** DONE
- **Issue:** No Software Bill of Materials exists. Ten Python `.whl` files, a 10MB WASM binary, and `jszip.min.js` are bundled with no integrity hashes or provenance verification.
- **Decision:** Created `SBOM.md` in the project root with a full Software Bill of Materials. Tables are grouped by layer (JavaScript, WebAssembly/Pyodide runtime, Python wheels, Python engine) with columns: Component, Version, Licence, Source URL, SHA-256. Covers 17 components total: JSZip 3.10.1, Pyodide 0.26.4 (5 files), 10 Python wheels, and Adeu 0.6.7. A Licence Compatibility section confirms all dependencies are permissive and compatible with the extension's MIT licence, with an explicit note that JSZip is used under its MIT option (not GPLv3). A verification command is included to re-check all hashes from the CLI.
- **Rationale:** An SBOM is a baseline requirement for any software that bundles third-party binaries. It enables anyone to (a) verify bundled binaries match upstream releases via SHA-256, (b) check for known CVEs against specific versions, (c) confirm licence compatibility before deployment, and (d) detect tampering or supply-chain substitution. Grouping by layer (JS, WASM, Python) matches how the extension loads dependencies and makes it easier to review each trust boundary independently.
- **Files Changed:** `SBOM.md` (new)
- **Date Resolved:** 2026-02-06

---

### ADR-007: Create DEPENDENCIES.md with Pyodide version and source

- **Status:** DONE
- **Issue:** The bundled Pyodide runtime (`pyodide.js`, `pyodide.asm.wasm`) has no version metadata in filenames, manifest, or documentation. There is no way to determine which Pyodide release is in use. No documented procedure exists for updating bundled dependencies. No contributor guidelines or issue-reporting channel is documented.
- **Decision:** Created `DEPENDENCIES.md` in the project root documenting every bundled dependency with name, version, source URL, and SHA-256 hash. Covers: Pyodide runtime (5 files, v0.26.4), 10 Python wheels, JSZip (v3.10.1), and Adeu engine (v0.6.7). Includes a verification command to re-check all hashes. Added an "Update Procedure" section with step-by-step instructions for updating each category of dependency: (1) Pyodide runtime — download from GitHub releases, replace 5 files, check for CPython version compatibility with platform-specific wheels; (2) Python wheels — pure-Python from PyPI, platform-specific from Pyodide release assets, update filename in `offscreen.js`; (3) JSZip — download from GitHub releases, confirm MIT licence option; (4) Adeu — copy source from upstream repo, update VERSION file, add any new files to `loadAdeuSource()`. Each procedure ends with re-computing SHA-256 hashes and updating both `DEPENDENCIES.md` and `SBOM.md`. Created `CONTRIBUTING.md` establishing GitHub Issues as the single channel for bug reports, feature suggestions, and pre-PR discussion. Confirms MIT licence applies to all contributions.
- **Rationale:** A dependency manifest without an update procedure is a snapshot that goes stale. Documenting the exact steps — where to download, which files to replace, which code references to update, and which hashes to recompute — ensures that any maintainer can update dependencies safely without having to reverse-engineer the bundling process. The platform-specific wheel warning (Pyodide CPython version must match) is critical because a mismatch silently produces import errors at runtime. A minimal CONTRIBUTING.md sets expectations for external contributors (discuss first, then PR) and funnels all communication through a single channel.
- **Files Changed:** `DEPENDENCIES.md` (new, then updated with Update Procedure section), `CONTRIBUTING.md` (new)
- **Date Resolved:** 2026-02-06

---

### ADR-008: Pin bundled Adeu engine version

- **Status:** DONE
- **Issue:** The Adeu Python engine resolves its version to `"0.0.0-dev"` at runtime because it is filesystem-injected rather than package-installed. There is no way to determine which upstream version is bundled or whether it has been modified.
- **Decision:** Created a `python/adeu/VERSION` file containing `0.6.7` (confirmed by diffing the bundled source against `_extension_backup/source-adeu-latest` which declares version 0.6.7 in `pyproject.toml`). Updated `__init__.py` so the `PackageNotFoundError` fallback reads from this file via `Path(__file__).parent / "VERSION"` instead of hardcoding `"0.0.0-dev"`. Added the VERSION file to the `loadAdeuSource()` file list in `offscreen.js` so it is written into Pyodide's virtual filesystem. After the test import, `adeu.__version__` is read and logged to console as `Adeu engine v0.6.7`, visible in DevTools when inspecting the offscreen document.
- **Rationale:** A plain-text VERSION file is the simplest mechanism that works within Pyodide's filesystem injection model. It is human-readable, diffable, and trivial to update when rebundling from upstream. Logging the version at init makes it immediately visible during debugging without needing to open a Python REPL.
- **Files Changed:** `python/adeu/VERSION` (new), `python/adeu/__init__.py`, `src/offscreen.js` (file list + version log)
- **Date Resolved:** 2026-02-06

---

### ADR-009: Validate AI model parameter before URL interpolation

- **Status:** DONE
- **Issue:** The `model` value is interpolated directly into the Gemini API URL with no validation or sanitisation, creating a potential SSRF-style path traversal vector against the Google API.
- **Decision:** Added a `validateModelId()` function that rejects any model string not matching `^[a-zA-Z0-9._-]+$`. Called at the top of `callGemini()` before the URL is constructed. This is the only call site where model is interpolated into a URL path. The OpenRouter path puts model into a `JSON.stringify()` body (inherently safe) and the Gemini `testConnection` path does not use model in its URL, so neither requires this check.
- **Rationale:** An allowlist regex is the simplest defence against path traversal. Characters like `/`, `..`, `?`, `#`, and `%` are all rejected, making it impossible to break out of the intended URL path segment. The allowed set (`a-z`, `A-Z`, `0-9`, `.`, `-`, `_`) covers all known Gemini model IDs.
- **Files Changed:** `src/utils/ai-bundle.js` (`SAFE_MODEL_ID` regex, `validateModelId()`, call in `callGemini()`)
- **Date Resolved:** 2026-02-06

---

### ADR-010: Audit all innerHTML interpolations for escaping coverage

- **Status:** DONE
- **Issue:** The entire UI is rebuilt via `innerHTML` template literals. While `escapeHtml()` is used on user-provided strings, this pattern is inherently fragile — a single missed escaping point creates an XSS vector.
- **Decision:** Created `trusted-html.js` with a `safeSetHTML()` function gated by a Trusted Types policy (`vibe-legal`). Replaced every direct `innerHTML =` assignment in active source files with `safeSetHTML()`. Audited all interpolated variables in ui.js; found and fixed two missing `escapeHtml()` calls.
- **Rationale:** Trusted Types enforce that innerHTML can only be set through a registered policy, giving the browser itself the role of watchdog. The full escaping audit confirmed all user-provided strings are now escaped. Defense-in-depth escaping added for code-controlled strings that are interpolated raw.
- **Escaping gaps fixed:**
  - `state.settings.apiKey` in `renderSettingsPage()` — user-provided API key was interpolated into an input `value` attribute without escaping. An API key containing `"` could break out of the attribute. Now passes through `escapeHtml()`.
  - `job.current_phase` in `renderJobStatus()` — currently code-controlled but interpolated raw. Escaped for defense-in-depth.
- **Files Changed:**
  - `src/trusted-html.js` — NEW: `safeSetHTML()` + Trusted Types policy registration
  - `src/ui.js` — replaced `innerHTML =` with `safeSetHTML()`; added `escapeHtml()` to `state.settings.apiKey` and `job.current_phase`
  - `src/app.js` — replaced modal `innerHTML =` with `safeSetHTML()`
  - `src/launcher.js` — replaced both `innerHTML =` with `safeSetHTML()`; converted to ES module
  - `popup.html` — changed launcher script tag to `type="module"`
- **Date Resolved:** 2026-02-06

---

## Infrastructure

### ADR-011: Set up test framework

- **Status:** DONE (unit tests; integration and E2E tests are future work)
- **Issue:** Zero test files exist in the project. No unit tests, no integration tests, no end-to-end tests. For software that modifies legal contracts, this is a critical gap.
- **Decision:** Added Vitest as the test runner with jsdom environment. Created 5 unit test suites (46 tests total) covering the extension's security-critical pure functions: (1) `escape-html.test.js` — XSS escaping of script tags, event handlers (onerror, onclick), attribute-breaking injection, ampersands, angle brackets, nested injection attempts, and null/empty inputs. (2) `ai-response-parsing.test.js` — Gemini and OpenRouter response format extraction, malformed JSON handling (now returns graceful error instead of throwing), empty/whitespace responses, missing edits array, and edit field validation. (3) `model-validation.test.js` — valid model IDs, path traversal rejection (`../../`, `/`, `?`, `#`, `%`-encoded), and empty/null/undefined inputs. (4) `audit-log.test.js` — entry structure, SHA-256 filename hashing (never plain text), hash consistency and uniqueness, time-based purging with configurable retention, and max entries cap (500). (5) `rate-limit.test.js` — requests within the 10/minute limit pass through, the 11th request blocks until the window expires, and old timestamps are cleaned up. Two small source changes were made to support testability: internal functions (`parseAIResponse`, `validateModelId`, `enforceRateLimit`, `REQUEST_FORMATS`, `_rateLimitTimestamps`) are now re-exported with `_` prefix for test access, and `parseAIResponse` was changed to return a graceful error result `{ edits: [], summary: '...' }` instead of throwing on malformed JSON. A `MAX_AUDIT_ENTRIES` cap (500) was added to `state.js` to prevent unbounded log growth.
- **Rationale:** Unit tests for pure functions are the highest-value, lowest-cost tests to add first. They cover the extension's trust boundaries: input sanitisation (escapeHtml), external API response parsing (parseAIResponse), URL safety (validateModelId), audit integrity (hashFilename, purge), and abuse prevention (rate limiter). All 46 tests run in ~1.5 seconds with zero network or browser dependencies. Integration tests (Chrome extension APIs, Pyodide interop) and E2E tests (full upload-to-download flow) are deferred to a follow-up since they require a browser harness and significantly more infrastructure.
- **Files Changed:**
  - `package.json` (new) — vitest + jsdom dev dependencies, `test` and `test:watch` scripts
  - `vitest.config.js` (new) — jsdom environment, `tests/**/*.test.js` include pattern
  - `tests/unit/escape-html.test.js` (new) — 11 tests
  - `tests/unit/ai-response-parsing.test.js` (new) — 10 tests
  - `tests/unit/model-validation.test.js` (new) — 12 tests
  - `tests/unit/audit-log.test.js` (new) — 10 tests
  - `tests/unit/rate-limit.test.js` (new) — 3 tests
  - `src/utils/ai-bundle.js` — added test-only exports; changed `parseAIResponse` catch to return instead of throw
  - `src/state.js` — added `MAX_AUDIT_ENTRIES` constant and enforcement in `writeAuditLogEntry`
- **Date Resolved:** 2026-02-06

---

### ADR-012: Set up CI pipeline with linting and tests

- **Status:** DONE (quality gates; deployment/publishing is future work)
- **Issue:** No build pipeline, no linting (ESLint), no static analysis, no type checking, and no automated quality gates of any kind.
- **Decision:** Created a GitHub Actions CI workflow (`.github/workflows/ci.yml`) that runs on every push and pull request to `main`. Three jobs run in parallel: (1) **Unit tests** — Node 20, `npm ci`, `vitest run` (46 tests across 5 suites). (2) **ESLint** — Node 20, `npm ci`, `eslint src/` with a security-focused ruleset. (3) **SBOM integrity** — `sha256sum --check` against all 16 bundled binary files (JSZip, 5 Pyodide runtime files, 10 Python wheels) using expected hashes hardcoded from `SBOM.md`. Any hash mismatch fails the build. The ESLint configuration (`.eslintrc.json`) enforces: `no-eval`, `no-implied-eval`, `no-new-func`, `no-script-url` (security); `no-restricted-syntax` banning direct `innerHTML` assignment with a message directing to `safeSetHTML()` (XSS prevention); `no-undef` (catches typos and undeclared globals); `no-unused-vars` as warning. Chrome extension globals (`chrome`, `JSZip`, `loadPyodide`) are declared. Third-party code (`src/lib/`) and the legacy non-module file (`src/app-bundle.js`, superseded by the modular split in ADR-013) are excluded from linting. The sole approved `innerHTML` gateway in `trusted-html.js` has inline `eslint-disable` comments with rationale.
- **Rationale:** Three independent quality gates catch different categories of regression: unit tests catch logic bugs, ESLint catches security anti-patterns (eval, raw innerHTML) and undeclared variables at authoring time, and SBOM verification catches supply-chain tampering or accidental binary replacement. Running all three as separate parallel jobs means each gate has its own pass/fail status in PRs and failures are immediately attributable. The `no-restricted-syntax` rule for innerHTML provides a hard lint-time enforcement layer that complements the runtime Trusted Types CSP from ADR-018 — a developer who forgets `safeSetHTML()` will be blocked by CI before the code reaches a browser. Deployment and Chrome Web Store publishing steps are intentionally omitted as future work.
- **Files Changed:**
  - `.github/workflows/ci.yml` (new) — 3 parallel jobs: test, lint, sbom-verify
  - `.eslintrc.json` (new) — security-focused ESLint 8 config
  - `package.json` — added `eslint@^8.57.0` dev dependency, `lint` script
  - `src/trusted-html.js` — added `eslint-disable-next-line` comments for the two approved innerHTML assignments
- **Date Resolved:** 2026-02-06

---

### ADR-013: Refactor app-bundle.js into smaller modules

- **Status:** DONE
- **Issue:** `app-bundle.js` is a single 1,368-line file containing all UI logic, state management, event handling, and rendering. This makes code review difficult and increases maintenance risk.
- **Decision:** Split into ES modules with clear separation of concerns. JSZip remains as a global UMD script.
- **Rationale:** Each module has a single responsibility, making review and maintenance easier. No circular dependencies. Module dependency graph: `config.js` (no deps) -> `state.js` -> `file-processing.js` (no deps) -> `ui.js` -> `api-handler.js` -> `app.js` (entry point).
- **Files Changed:**
  - `src/config.js` — added `export` to `DEFAULT_PLAYBOOKS`, `AI_PROVIDERS`, `JOB_STATUS`
  - `src/utils/ai-bundle.js` — added `export` to `analyzeContract`, `testConnection`
  - `src/state.js` — NEW: state object, `loadSettings`, `saveSettings`, audit log functions
  - `src/file-processing.js` — NEW: file constants, `extractTextFromDocx` (later removed in ADR-025), `isValidZipFile`, `formatFileSize`, `downloadFile`
  - `src/ui.js` — NEW: `escapeHtml`, `render`, all `render*` functions, `closeModal`
  - `src/api-handler.js` — NEW: `handleTestConnection`
  - `src/app.js` — NEW: entry point with `initEngine`, `processDocument`, `processBatch`, event handlers, `init`
  - `app.html`, `sidepanel.html` — replaced 3 script tags with single `<script type="module" src="src/app.js">`
- **Date Resolved:** 2026-02-06

---

### ADR-014: Add local audit logging for document processing

- **Status:** DONE
- **Issue:** No logging of any operations. There is no record of which documents were processed, what edits were suggested, which AI provider was used, or when processing occurred.
- **Decision:** Added a local audit log stored as a JSON array in `chrome.storage.local` under key `auditLog`. Each entry records: ISO 8601 timestamp, SHA-256 hash of the filename (never the filename itself), file size in bytes, provider name, model ID, number of edits returned, and status (success/error). A log entry is written after every document processing operation — both single review and batch — whether it succeeds or fails. Auto-purge runs on every extension startup and before every new log write, deleting entries older than the configured retention period (default 30 days, configurable to 7/30/60/90 days via dropdown). The Settings page now includes an "Audit Log" section with: a retention period dropdown, a table of entries (timestamp, truncated document hash, provider, edit count, status), an "Export Log" button that downloads the full log as JSON, and a "Clear Log" button with a confirmation prompt. The log never stores contract text, AI prompts, AI responses, API keys, or plain-text filenames.
- **Rationale:** Audit logging provides visibility into what was processed, when, and by which AI provider. Hashing the filename with SHA-256 provides a deterministic identifier for correlation (the same file always produces the same hash) without leaking the document name. Auto-purge with a configurable retention period ensures the log does not grow without bound while giving users flexibility to match their retention preferences.
- **Files Changed:** `src/app-bundle.js` (state, `hashFilename()`, `purgeOldAuditEntries()`, `writeAuditLogEntry()`, `exportAuditLog()`, `clearAuditLog()`, `loadSettings()`, `processDocument()`, `processBatch()`, `handleClick()`, `handleChange()`, `renderSettingsPage()`, `init()`), `styles/app.css` (audit log table styles)
- **Date Resolved:** 2026-02-06

---

### ADR-015: Add API rate limiting

- **Status:** DONE
- **Issue:** No protection against API abuse. Batch processing has only a 2-second delay between files. No per-user throttling and no cost controls exist.
- **Decision:** Added a sliding-window rate limiter (10 requests per 60-second window) in `ai-bundle.js`. An `enforceRateLimit()` function is called inside `analyzeContract()` after input validation but before provider dispatch, gating both Gemini and OpenRouter calls through a single checkpoint. When the limit is reached, the function logs "Rate limit reached, waiting Ns..." to the console and sleeps until the oldest request falls outside the window. Timestamps are cleaned up both before the check and after waking. `testConnection()` is intentionally not rate-limited since it is lightweight and manually triggered.
- **Rationale:** A hardcoded client-side limit is the simplest defence against runaway batch processing or accidental loops. 10 requests/minute is generous for normal use (batch max is 5 files) but prevents a bug from generating hundreds of API calls. The sliding window approach is fairer than a fixed-reset bucket since it doesn't penalise users who happen to straddle a boundary.
- **Files Changed:** `src/utils/ai-bundle.js` (`RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`, `_rateLimitTimestamps`, `enforceRateLimit()`, call in `analyzeContract()`)
- **Date Resolved:** 2026-02-06

---

## Future Improvements

### ADR-016: Provider abstraction layer (SSO-ready)

- **Status:** DONE (provider abstraction implemented; SSO/SAML remains future work)
- **Issue:** API keys are entered manually by individual users. There is no centralised key management, and separate code paths for each provider make it difficult to add new providers.
- **Decision:** Replaced separate `callGemini()` and `callOpenRouter()` code paths with a provider abstraction layer. The new architecture has three components: (1) `PROVIDER_PRESETS` — declarative config for each built-in provider (Gemini, OpenRouter) defining endpoint URL construction, auth header format, request format, extra headers, and test connection logic. (2) `buildProviderConfig(provider, apiKey, model)` — resolves a preset into a flat config object with fields: `name`, `endpointUrl`, `authHeaderName`, `authHeaderValue`, `requestFormat`, `modelId`. (3) `sendRequest(config, prompt)` — a single code path that uses `REQUEST_FORMATS` (gemini and openai format handlers) to build the request body and extract the response content. `analyzeContract()` now calls `buildProviderConfig` then `sendRequest`. `testConnection()` uses the preset directly for auth and model-list parsing. No UI changes — the user still picks Gemini or OpenRouter exactly as before. This abstraction makes it possible to add custom endpoints (e.g., an internal API gateway that handles key management upstream) by adding a new entry to `PROVIDER_PRESETS` without modifying the request pipeline.
- **Rationale:** SSO/SAML requires server-side infrastructure outside the scope of a browser extension. The more immediate architectural problem was that provider-specific logic was duplicated across two parallel code paths, making it difficult to add new providers or modify auth behaviour. The abstraction layer addresses this by separating provider configuration (what to call and how to authenticate) from the request pipeline (how to format and parse). A deployment using a centralised key management proxy could now add a preset for an internal endpoint without touching the core request logic.
- **Files Changed:** `src/utils/ai-bundle.js` (removed `callGemini()` and `callOpenRouter()`; added `REQUEST_FORMATS`, `PROVIDER_PRESETS`, `buildProviderConfig()`, `sendRequest()`; refactored `analyzeContract()` and `testConnection()`)
- **Date Resolved:** 2026-02-06

---

### ADR-017: DLP integration

- **Status:** DEFERRED
- **Issue:** The extension has no awareness of document sensitivity. There is no classification tagging and no integration with DLP tools to prevent classified documents from being sent to third-party AI APIs.
- **Decision:** _Deferred — requires server-side infrastructure and policy framework outside current scope._
- **Rationale:** _Deferred_
- **Files Changed:** _None_
- **Date Resolved:** _--_

---

### ADR-018: Trusted Types CSP enforcement

- **Status:** DONE
- **Issue:** The CSP does not enforce `trusted-types`, which would protect against DOM XSS from the `innerHTML` rendering pattern used throughout the UI.
- **Decision:** Added `trusted-types vibe-legal` to the manifest CSP. Created a single Trusted Types policy named `vibe-legal` in `src/trusted-html.js`. All `innerHTML` assignments across the extension now go through `safeSetHTML()` which uses this policy. Graceful fallback for browsers that don't support Trusted Types.
- **Rationale:** With the CSP directive in place, the browser blocks any `innerHTML` assignment that doesn't come through the registered `vibe-legal` policy. This provides a hard enforcement layer that catches any future code that accidentally bypasses `safeSetHTML()`.
- **Files Changed:**
  - `manifest.json` — added `trusted-types vibe-legal` to `content_security_policy.extension_pages`
  - `src/trusted-html.js` — NEW: policy registration + `safeSetHTML()` export
- **Date Resolved:** 2026-02-06

---

### ADR-019: Security documentation and threat model

- **Status:** DONE (self-review documented; formal third-party pentest remains future work)
- **Issue:** No documented threat model, no record of what has been reviewed, and no vulnerability reporting channel.
- **Decision:** Created `SECURITY.md` in the project root with three sections. (1) Threat Model — documents that the extension processes sensitive legal documents locally via Pyodide/WASM, sends extracted text to the user's chosen AI provider (BYOK), has no backend/analytics/telemetry, and identifies the AI provider API as the sole trust boundary. (2) Self-Review — states that a structured review was conducted across five categories (code quality, vulnerabilities, maintenance, security controls, WebAssembly risks) with findings tracked in `DEVELOPMENT_LOG.md`. (3) Reporting Vulnerabilities — directs public findings to GitHub Issues and sensitive findings to GitHub's private vulnerability reporting feature. A formal third-party penetration test is deferred until the extension reaches broader deployment.
- **Rationale:** Documenting the threat model and review methodology gives reviewers visibility into what has been examined and how risks are managed. The threat model makes the single trust boundary (AI provider API) explicit, which focuses future security work on the highest-risk surface. GitHub's private vulnerability reporting provides a responsible disclosure channel without requiring a dedicated security email address.
- **Files Changed:** `SECURITY.md` (new)
- **Date Resolved:** 2026-02-06

---

### ADR-020: Lazy-load Pyodide on demand

- **Status:** SUPERSEDED by ADR-025
- **Issue:** Pyodide loads ~27MB into memory on every browser session at extension startup. The offscreen document persists for the lifetime of the session, creating a permanent resource cost even when the extension is not actively in use.
- **Decision:** Defer offscreen document creation (and thus Pyodide initialization) until the user actually triggers document processing. Engine init runs in parallel with AI analysis so users rarely see extra wait time.
- **Rationale:** AI analysis takes 20-60s while Pyodide init takes ~10-15s. By starting both concurrently, the engine is typically ready before it's needed. The offscreen document is only created on first use and transparently re-created if Chrome destroys it. A 60-second timeout protects against initialization hangs.
- **Files Changed:** `src/background.js`, `src/app-bundle.js`, `src/launcher.js`
- **Date Resolved:** 2026-02-06

---

### ADR-021: Tighten memory cleanup for document data in offscreen document

- **Status:** DONE
- **Issue:** Document bytes processed by Pyodide were not explicitly freed between calls. Python-side BytesIO streams were never closed, module-scope variables (`contract_bytes`, `result`) persisted between sequential batch calls, and the JS-side Uint8Array was not nulled after being copied into the `sendResponse` payload.
- **Decision:** Three layers of cleanup added. (1) Python `process_document` now uses try/finally to explicitly close both `input_stream` and `output_stream` BytesIO objects. (2) After each call, a cleanup `runPythonAsync` deletes the module-scope `contract_bytes` and `result` variables so they do not linger between batch documents. (3) The JS message handler nulls the Uint8Array reference immediately after `Array.from()` copies it into the response. A comment block documents the full data lifecycle: bytes exist only in RAM, never touch disk, and are freed explicitly after send or automatically when the offscreen document is destroyed.
- **Rationale:** The offscreen document is long-lived (persists for the browser session). Without explicit cleanup, each document processed in a batch leaves its full byte content in both the JS heap (Uint8Array) and Pyodide's Python heap (bytes objects, BytesIO buffers) until the next call overwrites the variable names — but does not free the previous allocations until GC runs. For an extension processing confidential legal documents, deterministic cleanup is preferred over relying on garbage collection timing.
- **Files Changed:** `src/offscreen.js` (`process_document` Python function, `processDocument` JS function, message handler)
- **Date Resolved:** 2026-02-06

---

### ADR-022: Document wasm-unsafe-eval CSP requirement

- **Status:** DONE (documented — cannot be removed, inherent to the architecture)
- **Issue:** The manifest CSP includes `'wasm-unsafe-eval'` in `script-src`, which is required to instantiate Pyodide's WebAssembly module. This directive cannot be removed without breaking the extension's core functionality.
- **Decision:** Documented as an acknowledged architectural constraint in `SECURITY.md` under "WebAssembly Design Decisions". Mitigated by tightening all other CSP directives (`object-src 'self'`, allowlisted `connect-src`, `trusted-types vibe-legal`) and limiting `host_permissions` to only the two AI provider origins. Pyodide is bundled locally to eliminate remote code loading.
- **Rationale:** `wasm-unsafe-eval` is the minimum Chrome requires to run any WebAssembly. Since the extension's entire value proposition depends on running Pyodide (Python in WebAssembly) client-side, this directive is non-negotiable. The risk is mitigated at every other layer.
- **Files Changed:** `SECURITY.md` (new section: WebAssembly Design Decisions)
- **Date Resolved:** 2026-02-06

---

### ADR-023: Document runPythonAsync dynamic execution risk

- **Status:** DONE (documented — cannot be removed, inherent to the architecture)
- **Issue:** The offscreen document calls `pyodide.runPythonAsync()` to execute the Adeu redlining engine. This is functionally equivalent to `eval()` for Python code, which would be flagged by static analysis.
- **Decision:** Documented as an acknowledged architectural constraint in `SECURITY.md` under "WebAssembly Design Decisions". Every Python string passed to `runPythonAsync` is hardcoded in `src/offscreen.js`. Contract bytes are passed as a binary argument, never interpolated into Python source. No user input, network response, or external data is ever executed as Python code.
- **Rationale:** Running the Adeu Python engine via Pyodide is the core architectural decision of the extension (see CLAUDE.md — a JavaScript rewrite was analysed and rejected). `runPythonAsync` is the only way to invoke Python code in Pyodide. The risk is fully mitigated by ensuring all Python source strings are static literals.
- **Files Changed:** `SECURITY.md` (new section: WebAssembly Design Decisions)
- **Date Resolved:** 2026-02-06

---

### ADR-024: Prepare repository for GitHub as source-only

- **Status:** DONE
- **Issue:** The repository includes ~27MB of Pyodide binaries and Python wheels that should not be committed to Git. No .gitignore, no setup automation, no packaging script, and no README exist.
- **Decision:** Created project scaffolding for a source-only GitHub repository. (1) `.gitignore` — excludes `node_modules/`, `vibe-legal-extension/pyodide/`, `dist/`, `*.zip`, `_extension_backup/`, `.claude/`, and OS files. (2) `scripts/setup.sh` — automated developer setup that runs `npm install`, downloads all 15 Pyodide files (5 runtime + 10 wheels) from the Pyodide CDN and PyPI with exact version pinning, and verifies every file against its SHA-256 hash from `SBOM.md`. Fails loudly on any hash mismatch. (3) `scripts/package.sh` — creates a distribution .zip containing only shipping files (manifest, src, python, pyodide, styles, icons, HTML pages), excluding tests, config, docs, and dev dependencies. Reads the version from `manifest.json` for the zip filename. (4) `README.md` — developer-focused documentation with quick start for users (load unpacked from release zip), developer setup (clone + setup.sh), packaging instructions, architecture overview, and links to SECURITY.md, CONTRIBUTING.md, SBOM.md, and DEPENDENCIES.md.
- **Rationale:** Committing ~27MB of binaries to Git bloats the repository, slows clones, and makes supply-chain verification harder (binary diffs are opaque). Downloading at setup time with hash verification is more secure — any tampering or corruption is caught immediately. The setup script codifies the exact versions and URLs documented in DEPENDENCIES.md and SBOM.md, ensuring reproducible builds. The packaging script produces a clean distribution zip without dev-only files, ready for Chrome Web Store submission or direct distribution.
- **Files Changed:**
  - `.gitignore` (new) — repo-root gitignore
  - `vibe-legal-extension/scripts/setup.sh` (new) — download + verify Pyodide and wheels
  - `vibe-legal-extension/scripts/package.sh` (new) — create distribution zip
  - `README.md` (new) — project documentation
- **Date Resolved:** 2026-02-06

---

### ADR-025: Eliminate JS text extraction — use Adeu's full pipeline

- **Status:** DONE (supersedes ADR-020)
- **Issue:** The JS `extractTextFromDocx` in `file-processing.js` (~320 lines) duplicated Adeu's `ingest.py` text extraction logic, creating format drift risk. A prior bug (mismatched formatting markers) was caused by this duplication. The JS layer also used "clean view" which hid tracked changes from prior negotiation rounds, preventing the AI from seeing document revision history.
- **Decision:** Removed all JS text extraction code. Text extraction now goes through Adeu's `extract_text_from_stream()` via the offscreen document. The new message protocol is: (1) UI sends `extract-text` to background, which forwards as `extract` to offscreen — Adeu extracts text and offscreen stores the document bytes. (2) After AI analysis, UI sends `apply-edits` to background, which forwards as `apply` to offscreen — Adeu applies edits using the stored bytes (with a fallback to bytes sent in the message if the service worker restarted). Pyodide now initialises eagerly when the UI opens (reversing the lazy-load approach from ADR-020) because text extraction requires the engine to be ready before AI analysis can begin. The AI prompt was updated with a CriticMarkup awareness section explaining `{--del--}`, `{++ins++}`, `{>>comment<<}` syntax so the AI understands document revision history. Playbook creation uses `clean_view=true` to get clean text without revision markers.
- **Rationale:** A single source of truth for text extraction eliminates format drift bugs entirely. Using `clean_view=false` (the default) gives the AI full visibility into tracked changes from prior negotiation rounds, enabling smarter edit suggestions that account for what has already been negotiated. Eager engine init is acceptable because (a) the user opened the extension intending to process documents, and (b) the engine must be ready before text extraction can start (unlike the old flow where JS extraction could run in parallel with engine init).
- **Files Changed:**
  - `src/offscreen.js` — added `storedDocxBytes`, Python `extract_text()` wrapper, JS `extractText()` function, `extract` and `apply` message handlers; removed `redline` handler
  - `src/background.js` — added `extract-text` and `apply-edits` forwarding handlers; removed `process-redline` handler
  - `src/app.js` — added `sendMsg()` helper; rewrote `processDocument()`, `processBatch()`, `createPlaybook()` to use `extract-text`/`apply-edits`; eager engine init in `init()`; removed `extractTextFromDocx` import
  - `src/file-processing.js` — deleted ~320 lines of extraction code and test-only exports; kept constants, `formatFileSize`, `isValidZipFile`, `downloadFile`
  - `src/utils/ai-bundle.js` — added CriticMarkup explanation section to AI system prompt
- **Date Resolved:** 2026-02-07
