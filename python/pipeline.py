"""
Two-phase pipeline orchestrator for Vibe Legal.

Wraps RedlineEngine to guarantee one Document load and one normalization
serves both text extraction and edit application.

Phase 1 — prepare(): creates engine, extracts text, stores engine
Phase 2 — apply_edits(): retrieves stored engine, applies edits, returns bytes
"""

import json
from io import BytesIO

from docx.oxml import OxmlElement
from docx.oxml.ns import qn

from adeu.ingest import _extract_blocks
from adeu.models import DocumentEdit
from adeu.redline.comments import CommentsManager
from adeu.redline.engine import RedlineEngine
from adeu.utils.docx import iter_document_parts

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
        a, _s = engine.apply_edits([edit])
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
