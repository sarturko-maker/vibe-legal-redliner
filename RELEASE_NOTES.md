# Vibe Legal Redliner v1.2.0 — Release Notes

## Headline

Precision redlining: word-level track changes, document structure awareness, and post-processing formatting fixes.

## What's New

### Word-Level Track Changes
- Edits now produce minimal, word-level `w:del`/`w:ins` pairs instead of replacing entire phrases
- Formatting (bold, italic, font) is preserved through edits character-by-character
- Reconstruction safety check: if word-diff produces incorrect output, falls back to engine's proven path

### Document Structure Analysis
- New `doc_analyser.py` detects auto vs manual clause numbering from OOXML (`w:numPr`)
- AI receives a structural context header with paragraph map, numbering scheme, and available styles
- Prevents AI from inserting literal clause numbers into auto-numbered paragraphs

### AI Prompt Overhaul
- Structured reasoning process: Topic Inventory, Playbook Comparison, Edit Plan, Verification
- Playbook positions classified as GAP / MISALIGNMENT / ADEQUATE before generating edits
- WRONG/RIGHT examples teach the AI surgical precision over heavy-handed rewrites
- Track change awareness section explains how edits appear in Word

### Post-Processing Styler
- New `styler.py` fixes formatting on inserted paragraphs after Adeu applies track changes
- Deterministic (no AI calls) — reads original document for reference formatting
- Fixes: section header bold, inline title bold, body indentation, paragraph spacing, double numbering
- Opt-in via `polishFormatting` flag on apply-edits message

### Pipeline Hardening
- `PlainTextIndex`: third-tier text matching that strips formatting markers for reliable edit location
- Edit deduplication: overlapping AI edits are merged before applying
- Tab/whitespace normalization: prevents spurious whitespace-only track changes
- Redundant clause number stripping: detects `w:numPr` and removes AI-generated number prefixes

### Per-Provider API Keys
- Separate API key storage for Gemini and OpenRouter
- Smart model selection based on connected provider

## Technical Details

- **67 files** in package, **9.4 MB** compressed
- **76 tests** passing (51 JS + 9 doc_analyser + 8 pipeline + 8 styler)
- Pyodide + Adeu engine v0.6.7 (unchanged)
- Manifest V3, Chrome 120+

## Known Limitations

- Formatting inheritance from adjacent bold/caps placeholder text (e.g. "[INSERT PERIOD]") may produce bold insertions — Styler mitigates but doesn't fully resolve
- Risk tolerance and terminology map features from the server are not yet ported (no UI controls)
