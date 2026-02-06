# Vibe Legal Redliner

100% client-side contract redlining Chrome extension. Your documents never leave your browser.

## What It Does

- Upload a .docx contract and a playbook describing your review position
- AI analyses the contract clause-by-clause against your playbook rules
- Generates a Microsoft Word document with tracked changes — accept or reject like a normal legal markup
- Bring your own API key (Google Gemini or OpenRouter) — no accounts, no subscriptions

## Quick Start (Users)

1. Download the latest `.zip` from [GitHub Releases](https://github.com/sarturko-maker/vibe-legal-redliner/releases)
2. Unzip to a folder
3. Open `chrome://extensions`, enable **Developer Mode**
4. Click **Load unpacked** and select the unzipped folder
5. Click the extension icon, go to **Settings**, and add your API key

## Developer Setup

```bash
git clone https://github.com/sarturko-maker/vibe-legal-redliner.git
cd vibe-legal-redliner
./scripts/setup.sh
```

This installs npm dependencies, downloads Pyodide (v0.26.4) and all Python wheels, and verifies SHA-256 hashes against the [SBOM](SBOM.md). Then load unpacked from the repo root in Chrome.

### Running Tests

```bash
npm test          # run once
npm run test:watch # watch mode
npm run lint       # ESLint
```

## Packaging

```bash
./scripts/package.sh
```

Creates `vibe-legal-redliner-v{VERSION}.zip` containing only shipping files (no tests, config, or docs). Upload to the Chrome Web Store or distribute directly.

## Architecture

Chrome Manifest V3 extension. Document processing runs client-side via [Pyodide](https://pyodide.org/) (CPython compiled to WebAssembly) in an offscreen document. The [Adeu](https://github.com/dealfluence/adeu) Python engine handles OOXML tracked-change generation. [JSZip](https://stuk.github.io/jszip/) handles .docx parsing. Contract text is sent to the user's chosen AI provider (Google Gemini or OpenRouter) for clause analysis — the user supplies their own API key. No backend, no analytics, no telemetry.

## Documentation

- [SECURITY.md](SECURITY.md) — threat model, self-review findings, vulnerability reporting
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to contribute
- [SBOM.md](SBOM.md) — software bill of materials with SHA-256 hashes
- [DEPENDENCIES.md](DEPENDENCIES.md) — bundled dependency versions and update procedures
- [Privacy Policy](privacy-policy.html)

## License

[MIT](LICENSE)
