# Security

## Threat Model

Vibe Legal is a Chrome extension that redlines legal contracts using AI. The documents it processes are assumed to be sensitive and confidential.

**Local processing.** Contract and playbook files are parsed entirely within the browser using Pyodide (CPython compiled to WebAssembly) running in a Chrome extension offscreen document. No backend server is involved. Document bytes exist only in RAM and are never written to disk or transmitted to any server controlled by this project.

**AI provider (single external data flow).** Extracted contract text is sent to the user's chosen AI provider (Google Gemini or OpenRouter) for analysis. The user supplies their own API key (BYOK). This is the only point where data leaves the browser and represents the sole trust boundary.

**No data collection.** The extension has no backend, no analytics, no telemetry, and no crash reporting. It does not collect, store, or transmit any user data beyond the AI API call described above.

### WebAssembly Design Decisions

The extension runs Pyodide (CPython compiled to WebAssembly) inside a Chrome extension offscreen document. This architecture carries two acknowledged risks that are inherent to the design and cannot be eliminated — only mitigated.

**1. `wasm-unsafe-eval` CSP directive (audit ref 5.1).** The manifest CSP includes `'wasm-unsafe-eval'` in `script-src`. This is required by Chrome to instantiate any WebAssembly module, including Pyodide's `pyodide.asm.wasm`. It cannot be removed without breaking Pyodide entirely. Mitigations: all other CSP directives are tightened (`object-src 'self'`; `connect-src` allowlists only the two AI provider origins; `trusted-types vibe-legal` restricts innerHTML); `host_permissions` are limited to the same two AI provider origins; Pyodide is bundled locally rather than loaded from a CDN, eliminating a remote code-loading vector.

**2. `runPythonAsync` dynamic execution (audit ref 5.3).** The offscreen document calls `pyodide.runPythonAsync()` to invoke the Adeu redlining engine. This is functionally equivalent to `eval()` for Python code and would be flagged by any static analysis tool. However, every Python string passed to `runPythonAsync` is hardcoded in `src/offscreen.js` — none originate from user input, network responses, or any other external source. The contract bytes are passed as a binary argument to a Python function; they are never interpolated into a Python source string. This is a deliberate architectural choice (running a battle-tested Python library in-browser via WebAssembly) rather than an oversight.

## Self-Review

A structured pre-release quality review was conducted covering five categories:

1. **Code quality** — architecture, test coverage, linting, module structure
2. **Vulnerabilities** — API key handling, XSS vectors, input validation, CSP policy
3. **Maintenance** — dependency versioning, SBOM, update procedures, contributor guidelines
4. **Security controls** — rate limiting, memory cleanup, privacy policy accuracy, permissions scope
5. **WebAssembly risks** — WASM binary integrity, Python wheel provenance, Pyodide memory lifecycle

Findings are tracked in `DEVELOPMENT_LOG.md` using the ADR (Architecture Decision Record) format. Changes are applied incrementally, with each entry updated in-place as it is resolved.

## Reporting Vulnerabilities

If you discover a security issue, please report it through one of these channels:

- **Public issues:** Open a [GitHub Issue](../../issues) for non-sensitive findings.
- **Private reporting:** For vulnerabilities that could be exploited if disclosed publicly, use GitHub's [private vulnerability reporting](../../security/advisories/new) feature. This allows you to report the issue confidentially to the maintainers.

Please include steps to reproduce and the affected file(s) where possible.
