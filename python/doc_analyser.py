"""
Document Structure Analyser for Vibe Legal AI Prompt Context.

Extracts numbering scheme, available styles, and paragraph map from a DOCX
so the AI understands document structure when generating edits.

Runs in Pyodide (WebAssembly) — uses only lxml + stdlib.
Must complete in <2 seconds for 50-page documents.
"""

import re
from io import BytesIO
from zipfile import ZipFile
from lxml import etree

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def build_context_header(docx_bytes: bytes) -> str:
    """
    Build the structural context header to prepend to the AI prompt.

    Returns a text block describing:
    - Numbering scheme (automatic vs manual)
    - Available styles and their hierarchy
    - Paragraph map with style, numbering, and content preview
    """
    with ZipFile(BytesIO(docx_bytes)) as zf:
        doc_xml = etree.fromstring(zf.read('word/document.xml'))
        styles_xml = etree.fromstring(zf.read('word/styles.xml')) if 'word/styles.xml' in zf.namelist() else None
        numbering_xml = etree.fromstring(zf.read('word/numbering.xml')) if 'word/numbering.xml' in zf.namelist() else None

    body = doc_xml.find(f'{W}body')
    paragraphs = body.findall(f'{W}p')

    # Analyse numbering
    numbering_info = analyse_numbering(paragraphs, numbering_xml, styles_xml)

    # Analyse styles
    style_info = analyse_styles(paragraphs, styles_xml, numbering_xml)

    # Build paragraph map
    para_map = build_paragraph_map(paragraphs, numbering_xml)

    # Detect clause pattern
    clause_pattern = _detect_clause_pattern(paragraphs)

    # Find last clause number
    last_clause = _find_last_clause_number(paragraphs, numbering_info)

    # Assemble header
    sections = []

    sections.append("DOCUMENT STRUCTURE ANALYSIS:")
    sections.append(f"- Numbering: {numbering_info['scheme']}")
    if numbering_info['auto_styles']:
        sections.append(f"- Auto-numbered styles: {', '.join(numbering_info['auto_styles'])}")
    if numbering_info['num_formats']:
        fmts = ', '.join(f"{s}: {f}" for s, f in numbering_info['num_formats'].items())
        sections.append(f"- Number formats: {fmts}")
    sections.append(f"- Clause pattern: {clause_pattern}")
    if last_clause:
        sections.append(f"- Last clause number: {last_clause}")

    if style_info['heading_styles'] or style_info['body_styles']:
        sections.append("")
        sections.append("AVAILABLE STYLES:")
        if style_info['heading_styles']:
            sections.append(f"- Heading styles: {', '.join(style_info['heading_styles'])}")
        if style_info['body_styles']:
            sections.append(f"- Body styles: {', '.join(style_info['body_styles'])}")

    # Numbering rules
    sections.append("")
    sections.append("NUMBERING RULES FOR THIS DOCUMENT:")
    if numbering_info['scheme'] == 'automatic':
        sections.append("- This document uses AUTOMATIC numbering (Word styles generate numbers)")
        sections.append("- Do NOT include clause numbers in your edits — the document styles handle numbering automatically. Just provide the clause text.")
        sections.append("- When inserting a new clause, the numbering engine will assign the correct number.")
    elif numbering_info['scheme'] == 'manual':
        sections.append("- This document uses MANUAL numbering (literal numbers in paragraph text)")
        sections.append("- When inserting a new clause between existing numbered clauses, use sub-numbering (e.g., '4A.' between clauses 4 and 5) to avoid a renumbering cascade. Never renumber existing clauses.")
    else:
        sections.append("- This document has mixed or no numbering")
        sections.append("- Follow the existing pattern for any new insertions")

    sections.append("")
    sections.append("PARAGRAPH MAP:")
    sections.append(para_map)

    return "\n".join(sections)


def analyse_numbering(paragraphs, numbering_xml, styles_xml):
    """
    Detect whether the document uses automatic or manual numbering.

    Returns dict with:
    - scheme: 'automatic' | 'manual' | 'mixed' | 'none'
    - auto_styles: list of style names that have linked numbering
    - num_formats: dict of style -> format description
    """
    # Count paragraphs with w:numPr (auto-numbered)
    auto_count = 0
    manual_count = 0
    auto_styles = set()

    # Build abstractNum lookup for format info
    abstract_nums = {}
    if numbering_xml is not None:
        for abst in numbering_xml.findall(f'{W}abstractNum'):
            abst_id = abst.get(f'{W}abstractNumId')
            levels = {}
            for lvl in abst.findall(f'{W}lvl'):
                ilvl = lvl.get(f'{W}ilvl', '0')
                fmt = lvl.find(f'{W}numFmt')
                fmt_val = fmt.get(f'{W}val') if fmt is not None else 'none'
                lvl_text = lvl.find(f'{W}lvlText')
                lvl_text_val = lvl_text.get(f'{W}val') if lvl_text is not None else ''
                levels[ilvl] = {'format': fmt_val, 'text': lvl_text_val}
            abstract_nums[abst_id] = levels

    # Build numId -> abstractNumId map
    num_to_abstract = {}
    if numbering_xml is not None:
        for num in numbering_xml.findall(f'{W}num'):
            num_id = num.get(f'{W}numId')
            abst_ref = num.find(f'{W}abstractNumId')
            if abst_ref is not None:
                num_to_abstract[num_id] = abst_ref.get(f'{W}val')

    # Check styles for embedded numPr
    style_num_info = {}
    if styles_xml is not None:
        for style in styles_xml.findall(f'{W}style'):
            if style.get(f'{W}type') != 'paragraph':
                continue
            sid = style.get(f'{W}styleId', '')
            pPr = style.find(f'{W}pPr')
            if pPr is not None:
                numPr = pPr.find(f'{W}numPr')
                if numPr is not None:
                    numId_el = numPr.find(f'{W}numId')
                    ilvl_el = numPr.find(f'{W}ilvl')
                    style_num_info[sid] = {
                        'numId': numId_el.get(f'{W}val') if numId_el is not None else '0',
                        'ilvl': ilvl_el.get(f'{W}val') if ilvl_el is not None else '0',
                    }

    # Manual numbering pattern: "1.", "1.1", "(a)", "(i)"
    manual_pat = re.compile(r'^(?:\d+(?:\.\d+)*\.?\s|\([a-z]+\)\s|\([ivxlcdm]+\)\s)', re.IGNORECASE)

    for para in paragraphs:
        pPr = para.find(f'{W}pPr')
        has_numPr = False
        para_style = None

        if pPr is not None:
            ps = pPr.find(f'{W}pStyle')
            para_style = ps.get(f'{W}val') if ps is not None else None

            # Direct numPr on paragraph
            numPr = pPr.find(f'{W}numPr')
            if numPr is not None:
                has_numPr = True

        # Style-inherited numPr
        if not has_numPr and para_style and para_style in style_num_info:
            has_numPr = True

        if has_numPr:
            auto_count += 1
            if para_style:
                auto_styles.add(para_style)
        else:
            # Check for manual numbering in text
            text = _get_para_text(para)
            if text.strip() and manual_pat.match(text.strip()):
                manual_count += 1

    # Determine scheme
    if auto_count > 0 and manual_count == 0:
        scheme = 'automatic'
    elif manual_count > 0 and auto_count == 0:
        scheme = 'manual'
    elif auto_count > 0 and manual_count > 0:
        scheme = 'mixed'
    else:
        scheme = 'none'

    # Build format descriptions for auto-numbered styles
    num_formats = {}
    for para in paragraphs:
        pPr = para.find(f'{W}pPr')
        if pPr is None:
            continue
        numPr = pPr.find(f'{W}numPr')
        if numPr is None:
            continue
        numId_el = numPr.find(f'{W}numId')
        ilvl_el = numPr.find(f'{W}ilvl')
        if numId_el is None:
            continue
        numId = numId_el.get(f'{W}val')
        ilvl = ilvl_el.get(f'{W}val', '0') if ilvl_el is not None else '0'
        abst_id = num_to_abstract.get(numId)
        if abst_id and abst_id in abstract_nums:
            lvl_info = abstract_nums[abst_id].get(ilvl)
            if lvl_info:
                fmt = lvl_info['format']
                fmt_text = lvl_info['text']
                desc = _format_description(fmt, fmt_text)
                ps = pPr.find(f'{W}pStyle')
                style_name = ps.get(f'{W}val') if ps is not None else f'numId{numId}'
                if style_name not in num_formats:
                    num_formats[style_name] = desc

    return {
        'scheme': scheme,
        'auto_styles': sorted(auto_styles),
        'num_formats': num_formats,
    }


def analyse_styles(paragraphs, styles_xml, numbering_xml):
    """
    Catalogue available paragraph styles and their usage in the document.

    Returns dict with:
    - heading_styles: list of heading style names used
    - body_styles: list of body style names used
    - all_styles: dict of styleId -> {name, count, is_heading}
    """
    # Collect styles actually used in the document
    used_styles = {}
    for para in paragraphs:
        pPr = para.find(f'{W}pPr')
        if pPr is not None:
            ps = pPr.find(f'{W}pStyle')
            if ps is not None:
                sid = ps.get(f'{W}val')
                used_styles[sid] = used_styles.get(sid, 0) + 1

    # Get style definitions
    style_defs = {}
    if styles_xml is not None:
        for style in styles_xml.findall(f'{W}style'):
            if style.get(f'{W}type') != 'paragraph':
                continue
            sid = style.get(f'{W}styleId', '')
            name_el = style.find(f'{W}name')
            name = name_el.get(f'{W}val') if name_el is not None else sid
            style_defs[sid] = name

    heading_styles = []
    body_styles = []

    for sid, count in sorted(used_styles.items(), key=lambda x: -x[1]):
        name = style_defs.get(sid, sid)
        is_heading = (
            'heading' in name.lower()
            or 'title' in name.lower()
            or sid.startswith('Heading')
        )
        entry = f"{name} ({count} paragraphs)"
        if is_heading:
            heading_styles.append(entry)
        else:
            body_styles.append(entry)

    return {
        'heading_styles': heading_styles,
        'body_styles': body_styles,
    }


def build_paragraph_map(paragraphs, numbering_xml):
    """
    Build a paragraph map with index, style, numbering info, and content preview.

    Returns string like:
    [0] Title: "NON-DISCLOSURE AGREEMENT"
    [1] (no style): "Dated: 1 January 2025"
    [5] Heading1: "DEFINITIONS"
    [6] ListParagraph [AUTO-NUMBERED, level 0, decimal]: "In this Agreement:"
    """
    # Build numId -> abstractNumId -> level info
    num_to_abstract = {}
    abstract_nums = {}
    if numbering_xml is not None:
        for num in numbering_xml.findall(f'{W}num'):
            num_id = num.get(f'{W}numId')
            abst_ref = num.find(f'{W}abstractNumId')
            if abst_ref is not None:
                num_to_abstract[num_id] = abst_ref.get(f'{W}val')

        for abst in numbering_xml.findall(f'{W}abstractNum'):
            abst_id = abst.get(f'{W}abstractNumId')
            levels = {}
            for lvl in abst.findall(f'{W}lvl'):
                ilvl = lvl.get(f'{W}ilvl', '0')
                fmt = lvl.find(f'{W}numFmt')
                levels[ilvl] = fmt.get(f'{W}val') if fmt is not None else 'none'
            abstract_nums[abst_id] = levels

    lines = []
    for i, para in enumerate(paragraphs):
        text = _get_para_text(para)
        if not text.strip():
            continue

        pPr = para.find(f'{W}pPr')
        style_name = None
        num_info = ''

        if pPr is not None:
            ps = pPr.find(f'{W}pStyle')
            style_name = ps.get(f'{W}val') if ps is not None else None

            numPr = pPr.find(f'{W}numPr')
            if numPr is not None:
                numId_el = numPr.find(f'{W}numId')
                ilvl_el = numPr.find(f'{W}ilvl')
                numId = numId_el.get(f'{W}val') if numId_el is not None else '0'
                ilvl = ilvl_el.get(f'{W}val', '0') if ilvl_el is not None else '0'

                # Look up format
                abst_id = num_to_abstract.get(numId)
                fmt = 'numbered'
                if abst_id and abst_id in abstract_nums:
                    fmt = abstract_nums[abst_id].get(ilvl, 'numbered')

                num_info = f" [AUTO-NUMBERED, level {ilvl}, {fmt}]"

        style_str = style_name if style_name else "(no style)"
        preview = text.strip()[:80]
        lines.append(f"[{i}] {style_str}{num_info}: \"{preview}\"")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _get_para_text(para):
    """Get plain text content of a paragraph, preserving element order."""
    texts = []
    for run in para.findall(f'.//{W}r'):
        # Iterate children in document order to handle interspersed <w:t> and <w:tab>
        for child in run:
            tag = child.tag.split('}')[-1] if '}' in child.tag else child.tag
            if tag == 't' and child.text:
                texts.append(child.text)
            elif tag == 'tab':
                texts.append('\t')
    return ''.join(texts)


def _format_description(fmt, fmt_text):
    """Human-readable description of a numbering format."""
    descs = {
        'decimal': 'decimal (1, 2, 3...)',
        'lowerLetter': 'lowercase letter (a, b, c...)',
        'upperLetter': 'uppercase letter (A, B, C...)',
        'lowerRoman': 'lowercase roman (i, ii, iii...)',
        'upperRoman': 'uppercase roman (I, II, III...)',
        'bullet': 'bullet',
    }
    base = descs.get(fmt, fmt)
    if fmt_text and fmt != 'bullet':
        return f"{base} pattern: '{fmt_text}'"
    return base


def _detect_clause_pattern(paragraphs):
    """
    Detect whether the document uses block-style or inline-style clauses.

    Block: heading on its own paragraph, body follows in next paragraph(s)
    Inline: heading and body in the same paragraph ("1. Purpose. The Parties...")
    """
    heading_then_body = 0
    inline_title = 0
    title_pattern = re.compile(r'^\d+\.?\s+\w+\.\s+\S', re.IGNORECASE)

    for i, para in enumerate(paragraphs):
        pPr = para.find(f'{W}pPr')
        if pPr is not None:
            ps = pPr.find(f'{W}pStyle')
            style = ps.get(f'{W}val') if ps is not None else None
            if style and 'heading' in style.lower():
                heading_then_body += 1
                continue

        text = _get_para_text(para).strip()
        if title_pattern.match(text):
            inline_title += 1

    if heading_then_body > inline_title and heading_then_body > 0:
        return "Block (heading on own paragraph, body follows)"
    elif inline_title > heading_then_body and inline_title > 0:
        return "Inline (heading and body in same paragraph)"
    elif heading_then_body > 0:
        return "Block (heading on own paragraph, body follows)"
    else:
        return "Flat (no clear heading/body distinction)"


def _find_last_clause_number(paragraphs, numbering_info):
    """Find the last main clause number in the document."""
    last_num = None

    if numbering_info['scheme'] == 'automatic':
        # Count paragraphs at the highest level of auto-numbering
        # that have decimal format (not bullets)
        count = 0
        for para in paragraphs:
            pPr = para.find(f'{W}pPr')
            if pPr is None:
                continue
            numPr = pPr.find(f'{W}numPr')
            if numPr is None:
                continue
            ilvl_el = numPr.find(f'{W}ilvl')
            ilvl = ilvl_el.get(f'{W}val', '0') if ilvl_el is not None else '0'
            # Only count top-level items (ilvl=0) that aren't bullets
            if ilvl == '0':
                count += 1
        if count > 0:
            # Check if main numbering uses heading styles
            # Look at heading counts instead
            heading_count = 0
            for para in paragraphs:
                pPr = para.find(f'{W}pPr')
                if pPr is not None:
                    ps = pPr.find(f'{W}pStyle')
                    style = ps.get(f'{W}val') if ps is not None else None
                    if style and style.startswith('Heading'):
                        heading_count += 1
            last_num = str(heading_count) if heading_count > 0 else str(count)
    else:
        # Manual: find the highest clause number in the text
        clause_pat = re.compile(r'^(\d+)\.?\s')
        for para in paragraphs:
            text = _get_para_text(para).strip()
            m = clause_pat.match(text)
            if m:
                num = int(m.group(1))
                if last_num is None or num > int(last_num):
                    last_num = str(num)

    return last_num
