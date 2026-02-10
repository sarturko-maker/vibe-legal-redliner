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


def prepare(docx_bytes: bytes, clean_view: bool = False, author: str = "Vibe Legal") -> str:
    """
    Phase 1: Create RedlineEngine, extract text, store engine.

    The engine normalizes the Document once. Text is extracted from that
    same normalized Document so the AI sees exactly what the mapper will
    match against in Phase 2.
    """
    global _engine

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

    return "\n\n".join(full_text)


def apply_edits(edits_json: str, fallback_bytes: bytes = None) -> dict:
    """
    Phase 2: Apply edits using the stored engine.

    If no engine is stored (e.g. extension reloaded between phases),
    falls back to creating a new engine from fallback_bytes.
    """
    global _engine

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

    return {
        "doc_bytes": doc_bytes,
        "applied": applied,
        "skipped": skipped,
        "statuses": json.dumps(statuses),
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
    Get a deep copy of the rPr at char_pos, with fallback to nearest non-None.
    """
    if not char_format_map:
        return None

    pos = max(0, min(char_pos, len(char_format_map) - 1))

    if char_format_map[pos] is not None:
        return deepcopy(char_format_map[pos])

    # Search backwards for non-None
    for i in range(pos - 1, -1, -1):
        if char_format_map[i] is not None:
            return deepcopy(char_format_map[i])

    # Search forwards for non-None
    for i in range(pos + 1, len(char_format_map)):
        if char_format_map[i] is not None:
            return deepcopy(char_format_map[i])

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

        elif op == -1:  # DELETE — wrap in w:del, split at formatting boundaries
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

        elif op == 1:  # INSERT — inherit formatting from current deletion position
            ins_tag = engine._create_track_change_tag("w:ins")
            rPr = _get_rpr_at(char_format_map, old_pos)
            run = create_element("w:r")
            if rPr is not None:
                run.append(rPr)
            t = create_element("w:t")
            t.text = text
            t.set(qn("xml:space"), "preserve")
            run.append(t)
            ins_tag.append(run)
            elements.append(ins_tag)
            # INSERT does NOT advance old_pos

    return elements


def _apply_edit_with_word_diff(engine, edit):
    """
    Apply a single edit using word-level diff for precise track changes.

    Returns (applied, skipped) to match engine.apply_edits() return signature.
    Delegates to engine for: empty target, pure deletion, nested insertion,
    multi-paragraph spans, and safety-check failures.
    """
    # No target text — delegate
    if not edit.target_text:
        return engine.apply_edits([edit])

    # 1. Match against mapper (with clean_view fallback)
    mapper = engine.mapper
    start_idx, match_len = mapper.find_match_index(edit.target_text)

    if start_idx == -1:
        if not engine.clean_mapper:
            engine.clean_mapper = DocumentMapper(engine.doc, clean_view=True)
        start_idx, match_len = engine.clean_mapper.find_match_index(edit.target_text)
        if start_idx != -1:
            mapper = engine.clean_mapper
        else:
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

    if runs_plain_text == edit.new_text:
        return (0, 1)

    # 7. Build char format map
    char_format_map = _build_char_format_map(target_runs)

    # 8. Word-level diff
    diffs = _diff_words(runs_plain_text, edit.new_text)

    # 9. Safety check: verify accept-all-changes produces correct output
    reconstructed = "".join(text for op, text in diffs if op >= 0)
    if reconstructed != edit.new_text:
        print(f"[VL-DEBUG] Word-diff: reconstruction mismatch, delegating to engine")
        return engine.apply_edits([edit])

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
