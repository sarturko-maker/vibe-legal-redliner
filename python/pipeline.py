"""
Two-phase pipeline orchestrator for Vibe Legal.

Wraps RedlineEngine to guarantee one Document load and one normalization
serves both text extraction and edit application.

Phase 1 — prepare(): creates engine, extracts text, stores engine
Phase 2 — apply_edits(): retrieves stored engine, applies edits, returns bytes

Word-level diff: MODIFICATION edits are intercepted and diffed at word
granularity so only changed words get w:del/w:ins track changes, not
entire phrases.
"""

import json
import re
from copy import deepcopy
from io import BytesIO

from diff_match_patch import diff_match_patch
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

from adeu.ingest import _extract_blocks
from adeu.models import DocumentEdit
from adeu.redline.comments import CommentsManager
from adeu.redline.engine import RedlineEngine
from adeu.redline.mapper import DocumentMapper
from adeu.utils.docx import create_element, iter_document_parts

_engine = None
_original_bytes = None


# ---------------------------------------------------------------------------
# PlainTextIndex — formatting-marker-aware position mapping
# ---------------------------------------------------------------------------

class PlainTextIndex:
    """
    Builds a plain-text view of a DocumentMapper by stripping virtual spans
    (formatting markers like ** and _, CriticMarkup wrappers, separators).

    Only text from real spans (those backed by a w:r Run) is kept.
    A position map allows translating a match position in plain_text back
    to the corresponding offset in the mapper's full_text.

    This class is intentionally decoupled from Adeu internals — it reads
    only the public .spans list and the TextSpan dataclass fields (.run,
    .start, .text). If Adeu changes its mapper structure, only this class
    needs updating.
    """

    __slots__ = ("plain_text", "_plain_to_full")

    def __init__(self, mapper):
        plain_chars = []
        pos_map = []  # pos_map[plain_idx] = full_text offset

        for span in mapper.spans:
            if span.run is None:
                # Virtual span (formatting marker, CriticMarkup, separator) — skip
                continue
            for i, ch in enumerate(span.text):
                plain_chars.append(ch)
                pos_map.append(span.start + i)

        self.plain_text = "".join(plain_chars)
        self._plain_to_full = pos_map

    def find_match(self, target_text):
        """
        Search plain_text for target_text using three strategies
        (mirroring DocumentMapper.find_match_index):
          1. Exact match
          2. Smart-quote normalisation
          3. Fuzzy regex (flexible whitespace, underscores, quotes)

        Returns (full_text_start, full_text_length) or (-1, 0).
        The returned coordinates are in the *mapper's full_text* space,
        so they can be passed directly to find_target_runs_by_index().
        """
        idx = self._search(target_text)
        if idx == -1:
            return -1, 0
        return self._map_range(idx, len(target_text))

    # -- internal helpers --------------------------------------------------

    def _search(self, target_text):
        """Return start index in plain_text, or -1."""
        # 1. Exact
        idx = self.plain_text.find(target_text)
        if idx != -1:
            return idx

        # 2. Smart-quote normalisation
        norm = _normalize_quotes(self.plain_text)
        norm_t = _normalize_quotes(target_text)
        idx = norm.find(norm_t)
        if idx != -1:
            return idx

        # 3. Fuzzy regex
        try:
            pattern = _make_fuzzy_regex(target_text)
            m = re.search(pattern, self.plain_text)
            if m:
                return m.start()
        except re.error:
            pass

        return -1

    def _map_range(self, plain_start, plain_len):
        """Convert (plain_start, plain_len) → (full_start, full_len)."""
        if not self._plain_to_full:
            return -1, 0
        full_start = self._plain_to_full[plain_start]
        end = min(plain_start + plain_len - 1, len(self._plain_to_full) - 1)
        full_end = self._plain_to_full[end] + 1  # exclusive
        return full_start, full_end - full_start


def _normalize_quotes(text):
    """Replace smart/curly quotes with ASCII equivalents."""
    return text.replace("\u201c", '"').replace("\u201d", '"').replace("\u2018", "'").replace("\u2019", "'")


def _make_fuzzy_regex(target_text):
    """
    Build a fuzzy regex from target_text (mirrors DocumentMapper._make_fuzzy_regex).

    Permits flexible whitespace, underscores, and quote variants.
    """
    target_text = _normalize_quotes(target_text)
    parts = []
    token_pat = re.compile(r"(_+)|(\s+)|(['\"])")

    last = 0
    for m in token_pat.finditer(target_text):
        lit = target_text[last:m.start()]
        if lit:
            parts.append(re.escape(lit))
        g_under, g_space, g_quote = m.groups()
        if g_under:
            parts.append(r"_+")
        elif g_space:
            parts.append(r"\s+")
        elif g_quote:
            parts.append(r"[''']" if g_quote == "'" else r'["""\u201c\u201d]')
        last = m.end()

    tail = target_text[last:]
    if tail:
        parts.append(re.escape(tail))
    return "".join(parts)


def prepare(docx_bytes: bytes, clean_view: bool = False, author: str = "Vibe Legal") -> str:
    """
    Phase 1: Create RedlineEngine, extract text, store engine.

    The engine normalizes the Document once. Text is extracted from that
    same normalized Document so the AI sees exactly what the mapper will
    match against in Phase 2.

    When clean_view is False (default, used for AI analysis), the returned
    text is prepended with a structural context header from doc_analyser
    so the AI understands the document's numbering scheme and styles.
    """
    global _engine, _original_bytes

    _original_bytes = bytes(docx_bytes)

    stream = BytesIO(docx_bytes)
    try:
        _engine = RedlineEngine(stream, author=author)
    finally:
        stream.close()

    comments_mgr = CommentsManager(_engine.doc)
    comments_map = comments_mgr.extract_comments_data()

    full_text = []
    for part in iter_document_parts(_engine.doc):
        part_text = _extract_blocks(part, comments_map, clean_view)
        if part_text:
            full_text.append(part_text)

    extracted = "\n\n".join(full_text)

    # Prepend structural context header for AI analysis (not for playbook extraction)
    if not clean_view:
        try:
            from doc_analyser import build_context_header
            context_header = build_context_header(bytes(docx_bytes))
            extracted = context_header + "\n\n---\n\nCONTRACT TEXT:\n\n" + extracted
        except Exception as e:
            print(f"[VL-DEBUG] doc_analyser failed (non-fatal): {e}")

    return extracted


def apply_edits(edits_json: str, fallback_bytes: bytes = None, polish_formatting: bool = False) -> dict:
    """
    Phase 2: Apply edits using the stored engine.

    If no engine is stored (e.g. extension reloaded between phases),
    falls back to creating a new engine from fallback_bytes.
    """
    global _engine, _original_bytes

    if _engine is None:
        if fallback_bytes is None:
            raise RuntimeError("No engine prepared and no fallback bytes provided.")
        print("[VL-DEBUG] Pipeline: no stored engine, using fallback bytes")
        stream = BytesIO(fallback_bytes)
        try:
            _engine = RedlineEngine(stream, author="Vibe Legal")
        finally:
            stream.close()

    engine = _engine
    _engine = None

    edits_data = json.loads(edits_json)
    edits = [
        DocumentEdit(target_text=e.get("target_text", ""), new_text=e.get("new_text", ""))
        for e in edits_data
    ]

    # Issue 7: Remove edits with overlapping target_text
    edits = _deduplicate_edits(edits)

    indexed = sorted(enumerate(edits), key=lambda x: len(x[1].target_text), reverse=True)
    statuses = [False] * len(edits)
    applied = 0
    skipped = 0

    for orig_idx, edit in indexed:
        preview = edit.target_text[:50].replace("\n", " ")
        a, _s = _apply_edit_with_word_diff(engine, edit)
        if a > 0:
            statuses[orig_idx] = True
            applied += 1
            print(f'[VL-DEBUG] Edit #{orig_idx} APPLIED: "{preview}"')
        else:
            skipped += 1
            print(f'[VL-DEBUG] Edit #{orig_idx} SKIPPED: "{preview}"')

    print(f"[VL-DEBUG] Edits summary: {applied} applied, {skipped} skipped out of {len(edits)} total")

    _enable_track_changes(engine.doc)
    _strip_comments(engine.doc)

    output_stream = engine.save_to_stream()
    try:
        doc_bytes = output_stream.getvalue()
    finally:
        output_stream.close()

    # Styler post-processing (opt-in)
    styler_fixes = 0
    styler_warnings = []
    if polish_formatting:
        try:
            from styler import Styler
            # Detect reference formats from ORIGINAL document
            ref_formats = None
            original = _original_bytes or fallback_bytes
            if original:
                ref_styler = Styler(original, author="Vibe Legal")
                ref_formats = ref_styler.detect_reference_formats()

            # Run Styler on REDLINED document with original reference
            styler = Styler(doc_bytes, author="Vibe Legal", original_reference=ref_formats)
            result = styler.run()
            doc_bytes = result.modified_bytes
            styler_fixes = result.fix_count
            styler_warnings = result.warnings
            print(f"[VL-DEBUG] Styler: {styler_fixes} fixes applied, {len(styler_warnings)} warnings")
            for fix in result.fixes_applied:
                print(f"[VL-DEBUG]   fix: {fix}")
            for warn in result.warnings:
                print(f"[VL-DEBUG]   warn: {warn}")
        except Exception as e:
            print(f"[VL-DEBUG] Styler error (non-fatal): {e}")

    _original_bytes = None

    return {
        "doc_bytes": doc_bytes,
        "applied": applied,
        "skipped": skipped,
        "statuses": json.dumps(statuses),
        "styler_fixes": styler_fixes,
        "styler_warnings": json.dumps(styler_warnings),
    }


# ---------------------------------------------------------------------------
# Word-level diff helpers
# ---------------------------------------------------------------------------

def _diff_words(old_text, new_text):
    """
    Word-level diff using diff-match-patch with token encoding.

    Tokenizes with r'\\S+|\\s+' so punctuation stays attached to words
    (legal standard: "claims." is one token). Whitespace is a separate token.
    Encodes tokens to unique Unicode chars, diffs, then decodes back.

    Returns: list[tuple[int, str]] — [(0, "equal"), (-1, "deleted"), (1, "inserted")]
    """
    dmp = diff_match_patch()

    old_tokens = re.findall(r'\S+|\s+', old_text) if old_text else []
    new_tokens = re.findall(r'\S+|\s+', new_text) if new_text else []

    if not old_tokens and not new_tokens:
        return []

    token_to_char = {}
    char_to_token = {}
    next_code = 0x100  # Start above ASCII

    def encode(tokens):
        nonlocal next_code
        chars = []
        for token in tokens:
            if token not in token_to_char:
                token_to_char[token] = chr(next_code)
                char_to_token[chr(next_code)] = token
                next_code += 1
            chars.append(token_to_char[token])
        return "".join(chars)

    old_encoded = encode(old_tokens)
    new_encoded = encode(new_tokens)

    diffs = dmp.diff_main(old_encoded, new_encoded)
    dmp.diff_cleanupSemantic(diffs)

    result = []
    for op, encoded_text in diffs:
        decoded = "".join(char_to_token[c] for c in encoded_text)
        if decoded:
            result.append((op, decoded))

    return result


def _build_char_format_map(target_runs):
    """
    Build character-position-to-rPr mapping from resolved target runs.

    Each index in the returned list corresponds to a character in the
    concatenated text of all target runs, mapping to the rPr element
    of the run that character belongs to.

    Returns: list[Optional[Element]] — rPr references (NOT copies)
    """
    char_map = []
    for run in target_runs:
        rPr = run._r.rPr  # python-docx CT_R.rPr property
        text = run.text or ""
        for _ in text:
            char_map.append(rPr)
    return char_map


def _get_rpr_at(char_format_map, char_pos):
    """
    Get a deep copy of the rPr at char_pos.

    Returns None when the position has no explicit formatting (plain text run).
    In OOXML, a missing rPr means "use paragraph default style", so None is
    the correct return value — we must NOT inherit bold/italic from a
    neighboring run.
    """
    if not char_format_map:
        return None

    pos = max(0, min(char_pos, len(char_format_map) - 1))

    if char_format_map[pos] is not None:
        return deepcopy(char_format_map[pos])

    return None


def _rpr_equal(rPr1, rPr2):
    """Compare two rPr elements for formatting equality (bold, italic, underline)."""
    if rPr1 is None and rPr2 is None:
        return True
    if rPr1 is None or rPr2 is None:
        return False
    if rPr1 is rPr2:
        return True
    for tag in ["w:b", "w:i", "w:u"]:
        if (rPr1.find(qn(tag)) is not None) != (rPr2.find(qn(tag)) is not None):
            return False
    return True


def _split_by_formatting(text, char_format_map, start_pos):
    """
    Split text into (text, rPr) segments at formatting boundaries.

    Compares original rPr references from char_format_map to detect
    boundaries. Returns deep-copied rPr in each segment tuple.
    """
    if not text:
        return []

    segments = []
    seg_text = ""
    seg_rPr = None
    started = False

    for i, char in enumerate(text):
        pos = start_pos + i
        clamped = max(0, min(pos, len(char_format_map) - 1)) if char_format_map else 0
        rPr = char_format_map[clamped] if char_format_map else None

        if not started:
            seg_text = char
            seg_rPr = rPr
            started = True
        elif _rpr_equal(seg_rPr, rPr):
            seg_text += char
        else:
            segments.append((seg_text, deepcopy(seg_rPr) if seg_rPr is not None else None))
            seg_text = char
            seg_rPr = rPr

    if seg_text:
        segments.append((seg_text, deepcopy(seg_rPr) if seg_rPr is not None else None))

    return segments


def _build_diff_elements(engine, diffs, char_format_map):
    """
    Build OOXML elements from word-level diff segments.

    EQUAL segments become plain w:r runs (split at formatting boundaries).
    DELETE segments become w:del > w:r > w:delText (split at formatting boundaries).
    INSERT segments become w:ins > w:r > w:t (inherit rPr from deletion position).

    old_pos tracks position in the original text — advances on EQUAL and DELETE,
    stays put on INSERT (so inserted text inherits formatting from what it replaces).
    """
    elements = []
    old_pos = 0
    # ins_inherit_pos tracks where INSERT should read formatting from.
    # For DELETE+INSERT replacements, it points to the DELETE's start position
    # (so "SELLER"→"VENDOR" inherits bold from SELLER, not from the next run).
    # For pure INSERTs (after EQUAL), it equals old_pos.
    ins_inherit_pos = 0

    for op, text in diffs:
        if not text:
            continue

        if op == 0:  # EQUAL — preserve original formatting per character
            segments = _split_by_formatting(text, char_format_map, old_pos)
            for seg_text, seg_rPr in segments:
                run = create_element("w:r")
                if seg_rPr is not None:
                    run.append(seg_rPr)
                t = create_element("w:t")
                t.text = seg_text
                t.set(qn("xml:space"), "preserve")
                run.append(t)
                elements.append(run)
            old_pos += len(text)
            ins_inherit_pos = old_pos

        elif op == -1:  # DELETE — wrap in w:del, split at formatting boundaries
            ins_inherit_pos = old_pos  # Remember position BEFORE delete
            del_tag = engine._create_track_change_tag("w:del")
            segments = _split_by_formatting(text, char_format_map, old_pos)
            for seg_text, seg_rPr in segments:
                run = create_element("w:r")
                if seg_rPr is not None:
                    run.append(seg_rPr)
                dt = create_element("w:delText")
                dt.text = seg_text
                dt.set(qn("xml:space"), "preserve")
                run.append(dt)
                del_tag.append(run)
            elements.append(del_tag)
            old_pos += len(text)

        elif op == 1:  # INSERT — inherit formatting from deletion start position
            ins_tag = engine._create_track_change_tag("w:ins")
            rPr = _get_rpr_at(char_format_map, ins_inherit_pos)
            run = create_element("w:r")
            if rPr is not None:
                run.append(rPr)
            t = create_element("w:t")
            t.text = text
            t.set(qn("xml:space"), "preserve")
            run.append(t)
            ins_tag.append(run)
            elements.append(ins_tag)
            # INSERT does NOT advance old_pos or ins_inherit_pos

    return elements


# ---------------------------------------------------------------------------
# Issue fix helpers — compensate for Adeu behaviours
# ---------------------------------------------------------------------------

def _strip_formatting_markers(text):
    """
    Strip ** (bold) and _ (italic) formatting markers from text.

    Compensates for: Adeu's mapper decorates full_text with ** and _ markers
    (get_run_style_markers, docx.py:105-124). The AI may echo these markers
    back in new_text. Our word-diff inserts text literally without parsing
    markdown, unlike the engine's _parse_inline_markdown (engine.py:211-270).

    Note: Inserted text inherits formatting from the character position in
    the original document, not from the AI's markdown hints. For legal edits
    this is correct behaviour — the replacement should match surrounding style.

    When upgrading Adeu: Check if _parse_inline_markdown is called in the
    word-diff path. If so, this function can be removed.
    """
    # Strip balanced bold markers (keep inner text)
    text = re.sub(r'\*\*(.+?)\*\*', r'\1', text)
    # Strip remaining unbalanced **
    text = text.replace('**', '')
    # Strip balanced italic markers at word boundaries (avoid snake_case)
    text = re.sub(r'(?<![a-zA-Z0-9])_(.+?)_(?![a-zA-Z0-9])', r'\1', text)
    return text


def _normalize_edit_whitespace(edit):
    """
    Normalize tab characters to spaces in edit texts.

    Compensates for: get_run_text() (docx.py:258) converts <w:tab/> to space,
    but literal \\t in <w:t> passes through. The AI sees \\t in extracted text
    but returns spaces in new_text, causing spurious whitespace redlines.

    When upgrading Adeu: Check if get_run_text() normalizes \\t to space.
    If so, this function can be removed.
    """
    target = edit.target_text.replace('\t', ' ') if edit.target_text else edit.target_text
    new = edit.new_text.replace('\t', ' ') if edit.new_text else edit.new_text
    if target == edit.target_text and new == edit.new_text:
        return edit  # No change needed
    return DocumentEdit(target_text=target, new_text=new)


def _deduplicate_edits(edits):
    """
    Remove edits with overlapping target_text to prevent duplicate insertions.

    If edit A's target_text is a substring of edit B's target_text (or vice versa),
    keep only the longer edit (which provides more context for matching).

    Compensates for: The AI sometimes returns overlapping edits for the same
    paragraph. While the mapper rebuild after each edit usually prevents
    double-application, edge cases with fuzzy matching can slip through.

    When upgrading Adeu: This is independent of Adeu. Remove only if the AI
    prompt reliably avoids overlapping edits.
    """
    if len(edits) <= 1:
        return edits

    # Sort longest first (same order as apply_edits)
    sorted_edits = sorted(edits, key=lambda e: len(e.target_text), reverse=True)
    kept = []
    consumed_targets = []

    for edit in sorted_edits:
        target = edit.target_text
        is_duplicate = False
        for prev_target in consumed_targets:
            # Check if this edit's target overlaps with an already-kept edit
            if target in prev_target or prev_target in target:
                is_duplicate = True
                break
        if not is_duplicate:
            kept.append(edit)
            consumed_targets.append(target)
        else:
            print(f'[VL-DEBUG] Dedup: dropping overlapping edit "{target[:40]}..."')

    return kept


def _delegate_with_match(engine, edit, mapper, start_idx):
    """
    Delegate an edit to the engine with a pre-computed match position.

    Creates a proxy DocumentEdit with _match_start_index set so the engine
    uses its indexed path (engine.py:708-845) directly, bypassing heuristic
    matching. This ensures the engine's track_insert() handles paragraph
    creation for multi-line new_text.

    Compensates for: Our word-diff path only does inline modifications within
    a single <w:p>. Adeu's track_insert() (engine.py:272-413) splits on
    newlines and creates new paragraphs.

    When upgrading Adeu: This delegation pattern is stable — it uses
    _match_start_index and _active_mapper_ref which are public PrivateAttr
    on DocumentEdit (models.py:44-46). Check if these fields still exist.
    """
    proxy = DocumentEdit(target_text=edit.target_text, new_text=edit.new_text)
    proxy._match_start_index = start_idx
    proxy._active_mapper_ref = mapper
    return engine.apply_edits([proxy])


def _strip_redundant_clause_number(new_text, paragraph_element):
    """
    Strip leading clause numbers from new_text when the target paragraph
    has OOXML auto-numbering (<w:numPr>).

    Compensates for: get_paragraph_prefix() (docx.py:49-102) does not handle
    <w:numPr>. The AI includes clause numbers in new_text, but the paragraph
    already auto-generates them. This causes "10.10." collisions.

    When upgrading Adeu: Check if track_insert() or _apply_single_edit_indexed()
    detects <w:numPr> and strips redundant numbers. If so, remove this function.
    """
    if not new_text or paragraph_element is None:
        return new_text

    pPr = paragraph_element.find(qn("w:pPr"))
    if pPr is None:
        return new_text

    numPr = pPr.find(qn("w:numPr"))
    if numPr is None:
        return new_text

    # Paragraph has auto-numbering — strip leading clause number patterns
    # Patterns: "10.", "10.1", "(a)", "(iv)", "Section 10."
    stripped = re.sub(
        r'^(?:'
        r'(?:Section|Article|Clause)\s+)?'  # Optional prefix
        r'(?:\d+(?:\.\d+)*\.?\s*'           # "10." or "10.1." or "10 "
        r'|\([a-z]+\)\s*'                    # "(a)" or "(iv)"
        r'|\([A-Z]+\)\s*'                    # "(A)" or "(IV)"
        r'|\([ivxlcdm]+\)\s*'               # "(iv)" roman
        r')',
        '',
        new_text
    )
    return stripped if stripped else new_text  # Don't return empty


def _check_rewrite_ratio(diffs):
    """
    Calculate the ratio of changed characters to total characters in a diff.

    Compensates for: AI sometimes rewrites entire sentences instead of making
    minimal word-level changes. This function measures the severity for logging.

    When upgrading Adeu: This is independent of Adeu. It measures AI output quality.
    Remove only if the AI prompt is reliably producing minimal edits.
    """
    total_old = sum(len(t) for op, t in diffs if op <= 0)  # EQUAL + DELETE
    changed = sum(len(t) for op, t in diffs if op != 0)    # DELETE + INSERT
    if total_old == 0:
        return 0.0
    return changed / (total_old * 2)  # Normalize: 0.0 = no change, 1.0 = total rewrite


def _apply_edit_with_word_diff(engine, edit):
    """
    Apply a single edit using word-level diff for precise track changes.

    Returns (applied, skipped) to match engine.apply_edits() return signature.
    Delegates to engine for: empty target, pure deletion, nested insertion,
    multi-paragraph spans, and safety-check failures.
    """
    # Issue 3: Normalize tabs to spaces
    edit = _normalize_edit_whitespace(edit)

    # No target text — delegate
    if not edit.target_text:
        return engine.apply_edits([edit])

    # 1. Match against mapper (with clean_view and plain-text fallbacks)
    mapper = engine.mapper
    start_idx, match_len = mapper.find_match_index(edit.target_text)

    if start_idx == -1:
        # Fallback 1: clean mapper (strips CriticMarkup, keeps ** / _)
        if not engine.clean_mapper:
            engine.clean_mapper = DocumentMapper(engine.doc, clean_view=True)
        start_idx, match_len = engine.clean_mapper.find_match_index(edit.target_text)
        if start_idx != -1:
            mapper = engine.clean_mapper

    if start_idx == -1:
        # Fallback 2: plain-text index (strips ALL virtual spans including ** / _)
        # Searches against real run text only, then maps back to mapper coordinates.
        pti = PlainTextIndex(engine.mapper)
        start_idx, match_len = pti.find_match(edit.target_text)
        if start_idx != -1:
            mapper = engine.mapper  # coordinates are in raw mapper space
            print(f"[VL-DEBUG] Word-diff: matched via plain-text index")

    if start_idx == -1:
        print(f"[VL-DEBUG] Word-diff: no match, skipping")
        return (0, 1)

    # 2. Nested check: if inside w:ins, delegate to engine
    context = mapper.get_context_at_range(start_idx, start_idx + match_len)
    if context and context.ins_id:
        print(f"[VL-DEBUG] Word-diff: inside w:ins, delegating to engine")
        return engine.apply_edits([edit])

    # 3. Pure deletion → delegate to engine
    if not edit.new_text:
        return engine.apply_edits([edit])

    # 4. Resolve target runs (may split at boundaries internally)
    target_runs = mapper.find_target_runs_by_index(start_idx, match_len)
    if not target_runs:
        print(f"[VL-DEBUG] Word-diff: no runs resolved, skipping")
        return (0, 1)

    # 5. Multi-paragraph check — delegate if runs span paragraphs
    parents = {id(run._element.getparent()) for run in target_runs if run._element.getparent() is not None}
    if len(parents) > 1:
        print(f"[VL-DEBUG] Word-diff: spans {len(parents)} paragraphs, delegating to engine")
        return engine.apply_edits([edit])

    # 6. Extract plain text from resolved runs
    runs_plain_text = "".join(run.text or "" for run in target_runs)

    # Issue 1: Strip formatting markers from new_text
    clean_new_text = _strip_formatting_markers(edit.new_text)

    # Issue 4: Strip redundant clause numbers when paragraph has auto-numbering
    parent_p = target_runs[0]._element.getparent()
    clean_new_text = _strip_redundant_clause_number(clean_new_text, parent_p)

    # Issue 6: Multi-line new_text → delegate to engine for paragraph creation
    if '\n' in clean_new_text:
        print(f"[VL-DEBUG] Word-diff: new_text has newlines, delegating for paragraph creation")
        proxy = DocumentEdit(target_text=edit.target_text, new_text=clean_new_text)
        return _delegate_with_match(engine, proxy, mapper, start_idx)

    if runs_plain_text == clean_new_text:
        return (0, 1)

    # 7. Build char format map
    char_format_map = _build_char_format_map(target_runs)

    # 8. Word-level diff
    diffs = _diff_words(runs_plain_text, clean_new_text)

    # Issue 2: Monitor rewrite ratio
    ratio = _check_rewrite_ratio(diffs)
    if ratio > 0.7:
        print(f"[VL-DEBUG] Word-diff: heavy rewrite detected ({ratio:.0%})")

    # 9. Safety check: verify accept-all-changes produces correct output
    reconstructed = "".join(text for op, text in diffs if op >= 0)
    if reconstructed != clean_new_text:
        print(f"[VL-DEBUG] Word-diff: reconstruction mismatch, delegating to engine")
        proxy = DocumentEdit(target_text=edit.target_text, new_text=clean_new_text)
        return _delegate_with_match(engine, proxy, mapper, start_idx)

    # 10. Build OOXML elements from diff
    new_elements = _build_diff_elements(engine, diffs, char_format_map)
    if not new_elements:
        return (0, 1)

    # 11. DOM surgery: insert new elements before first target run, remove old runs
    first_run_elem = target_runs[0]._element
    parent = first_run_elem.getparent()
    insert_idx = list(parent).index(first_run_elem)

    for i, elem in enumerate(new_elements):
        parent.insert(insert_idx + i, elem)

    for run in target_runs:
        r_parent = run._element.getparent()
        if r_parent is not None:
            r_parent.remove(run._element)

    # 12. Rebuild mapper after DOM surgery.
    # NOTE: _build_map() is a private method on DocumentMapper — fragile coupling.
    # If Adeu renames/refactors this method, this call will break.
    mapper._build_map()
    if hasattr(engine, 'clean_mapper') and engine.clean_mapper is not None:
        engine.clean_mapper = None

    return (1, 0)


# ---------------------------------------------------------------------------
# Post-processing helpers
# ---------------------------------------------------------------------------

def _enable_track_changes(doc):
    settings = doc.settings.element

    if settings.find(qn("w:trackRevisions")) is None:
        settings.append(OxmlElement("w:trackRevisions"))

    for tag in ["w:revisionView", "w:documentProtection", "w:writeProtection", "w:docFinal"]:
        for el in settings.findall(qn(tag)):
            settings.remove(el)

    body = doc.element.body
    if body is not None:
        for perm in body.xpath("//w:permStart | //w:permEnd"):
            perm.getparent().remove(perm)
        for lock in body.xpath("//w:lock"):
            lock.getparent().remove(lock)


def _strip_comments(doc):
    from docx.opc.constants import RELATIONSHIP_TYPE as RT_CONST

    body = doc.element.body
    if body is not None:
        for tag in ["w:commentRangeStart", "w:commentRangeEnd"]:
            for el in body.xpath(f"//{tag}"):
                el.getparent().remove(el)
        for ref in body.xpath("//w:commentReference"):
            run = ref.getparent()
            if run is not None and run.tag.endswith("}r"):
                run.getparent().remove(run)
            else:
                ref.getparent().remove(ref)

    comment_uri_patterns = ["comments", "commentsExtended", "commentsIds", "commentsExtensible"]
    rels_to_remove = []
    for rel_key, rel in doc.part.rels.items():
        rel_type = rel.reltype or ""
        partname = str(getattr(rel, "_target", None))
        if (
            rel_type == RT_CONST.COMMENTS
            or any(pat in partname.lower() for pat in comment_uri_patterns)
            or "comment" in rel_type.lower()
        ):
            rels_to_remove.append(rel_key)

    for rel_key in rels_to_remove:
        try:
            target_part = doc.part.rels[rel_key].target_part
            if target_part in doc.part.package.parts:
                doc.part.package.parts.remove(target_part)
        except Exception:
            pass
        del doc.part.rels[rel_key]
