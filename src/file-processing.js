/**
 * File handling utilities
 */

// Maximum file size: 50MB
export const MAX_FILE_SIZE = 50 * 1024 * 1024;

// Maximum text length to send to AI: 500KB
export const MAX_TEXT_LENGTH = 500 * 1024;

// Maximum batch files
export const MAX_BATCH_FILES = 5;

// ---------------------------------------------------------------------------
// DOCX Text Extraction — matches Adeu ingest.py (clean view)
//
// The extracted text includes Markdown-like formatting markers:
//   **bold**  _italic_  # Heading 1  ## Heading 2  etc.
//
// These markers MUST be present because Adeu's DocumentMapper builds its
// internal full_text with the same markers.  If the AI sees plain text
// without markers, its target_text values will not match the mapper's
// full_text, causing edits to be silently skipped.
//
// Clean view behaviour: text from <w:ins> blocks is included (accepted),
// text from <w:del> blocks is omitted (rejected).  No CriticMarkup.
// ---------------------------------------------------------------------------

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/** Get first direct child element in W_NS with the given local name. */
function _wChild(parent, localName) {
  for (const c of parent.childNodes) {
    if (c.nodeType === 1 && c.localName === localName && c.namespaceURI === W_NS) {
      return c;
    }
  }
  return null;
}

/** Read a w:xxx attribute value from an element. */
function _wAttr(el, name) {
  return el.getAttributeNS(W_NS, name) ?? el.getAttribute('w:' + name);
}

/**
 * Check if a toggle property (w:b, w:i, etc.) is enabled within a rPr.
 * <w:b/> → true, <w:b w:val="true"/> → true, <w:b w:val="0"/> → false.
 */
function _isToggleOn(rPr, propName) {
  const el = _wChild(rPr, propName);
  if (!el) return false;
  const val = _wAttr(el, 'val');
  return val === null || val === 'true' || val === '1';
}

/** Parse word/styles.xml into { styleId: { name, outlineLevel, bold } }. */
function _parseStyles(stylesXml) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(stylesXml, 'application/xml');
  const map = {};

  for (const style of doc.getElementsByTagNameNS(W_NS, 'style')) {
    const id = _wAttr(style, 'styleId');
    if (!id) continue;

    const nameEl = _wChild(style, 'name');
    const name = nameEl ? (_wAttr(nameEl, 'val') || '') : '';

    let outlineLevel = null;
    const pPr = _wChild(style, 'pPr');
    if (pPr) {
      const olEl = _wChild(pPr, 'outlineLvl');
      if (olEl) {
        const v = parseInt(_wAttr(olEl, 'val'), 10);
        if (v >= 0 && v <= 8) outlineLevel = v;
      }
    }

    let bold = false;
    const rPr = _wChild(style, 'rPr');
    if (rPr) bold = _isToggleOn(rPr, 'b');

    map[id] = { name, outlineLevel, bold };
  }
  return map;
}

/**
 * Extract raw text from a <w:r> element.
 * Handles w:t, w:delText, w:tab (→ space), w:br/w:cr (→ newline).
 * Matches Adeu get_run_text().
 */
function _runText(rEl) {
  let text = '';
  for (const child of rEl.childNodes) {
    if (child.nodeType !== 1 || child.namespaceURI !== W_NS) continue;
    switch (child.localName) {
      case 't':
      case 'delText':
        text += child.textContent || '';
        break;
      case 'tab':
        text += ' ';
        break;
      case 'br':
      case 'cr':
        text += '\n';
        break;
    }
  }
  return text;
}

/** Return plain text of a paragraph (no markers). Clean view. */
function _paragraphPlainText(pEl) {
  let text = '';
  for (const child of pEl.childNodes) {
    if (child.nodeType !== 1 || child.namespaceURI !== W_NS) continue;
    if (child.localName === 'r') {
      text += _runText(child);
    } else if (child.localName === 'ins') {
      for (const sc of child.childNodes) {
        if (sc.nodeType === 1 && sc.localName === 'r' && sc.namespaceURI === W_NS) {
          text += _runText(sc);
        }
      }
    }
  }
  return text;
}

/** Check if the first visible run in a paragraph is explicitly bold. */
function _firstRunBold(pEl) {
  for (const child of pEl.childNodes) {
    if (child.nodeType !== 1 || child.namespaceURI !== W_NS) continue;
    if (child.localName === 'r') {
      if (_runText(child).trim()) {
        const rPr = _wChild(child, 'rPr');
        return rPr ? _isToggleOn(rPr, 'b') : false;
      }
    } else if (child.localName === 'ins') {
      for (const sc of child.childNodes) {
        if (sc.nodeType === 1 && sc.localName === 'r' && sc.namespaceURI === W_NS) {
          if (_runText(sc).trim()) {
            const rPr = _wChild(sc, 'rPr');
            return rPr ? _isToggleOn(rPr, 'b') : false;
          }
        }
      }
    }
  }
  return false;
}

/**
 * Determine Markdown heading prefix for a <w:p> element.
 * Matches Adeu get_paragraph_prefix():
 *   1. Direct outline level in <w:pPr>
 *   2. Outline level from paragraph style definition
 *   3. Style name "Heading N" / "Title"
 *   4. Heuristic: Normal + short + ALL CAPS + bold → "## "
 */
function _headingPrefix(pEl, styleMap) {
  const pPr = _wChild(pEl, 'pPr');

  // 1. Direct outline level
  if (pPr) {
    const olEl = _wChild(pPr, 'outlineLvl');
    if (olEl) {
      const lvl = parseInt(_wAttr(olEl, 'val'), 10);
      if (lvl >= 0 && lvl <= 8) return '#'.repeat(lvl + 1) + ' ';
    }
  }

  // Resolve paragraph style
  let styleName = '';
  let styleBold = false;
  if (pPr) {
    const pStyle = _wChild(pPr, 'pStyle');
    if (pStyle) {
      const styleId = _wAttr(pStyle, 'val');
      const info = styleMap[styleId];
      if (info) {
        styleName = info.name;
        styleBold = info.bold;

        // 2. Outline level from style definition
        if (info.outlineLevel !== null) {
          return '#'.repeat(info.outlineLevel + 1) + ' ';
        }
      }
    }
  }

  // 3. Style name patterns
  const hMatch = styleName.match(/^[Hh]eading\s*(\d+)$/);
  if (hMatch) {
    const level = parseInt(hMatch[1], 10);
    if (level >= 1 && level <= 9) return '#'.repeat(level) + ' ';
  }
  if (styleName === 'Title') return '# ';

  // 4. Heuristic: Normal + short + ALL CAPS + bold → sub-heading
  if (styleName === 'Normal' || !styleName) {
    const text = _paragraphPlainText(pEl).trim();
    if (text && text.length < 100 && text === text.toUpperCase() && /[A-Z]/.test(text)) {
      if (styleBold || _firstRunBold(pEl)) return '## ';
    }
  }

  return '';
}

/**
 * Return [prefix, suffix] formatting markers for a <w:r>.
 * Bold → **, Italic → _. Bold wraps italic: **_text_**.
 * Only checks explicit run-level properties (not inherited from styles),
 * matching Adeu get_run_style_markers() where `if run.bold:` is falsy
 * for None (style-inherited bold).
 */
function _runMarkers(rEl) {
  const rPr = _wChild(rEl, 'rPr');
  if (!rPr) return ['', ''];

  let pre = '';
  let suf = '';

  if (_isToggleOn(rPr, 'b')) {
    pre += '**';
    suf = '**' + suf;
  }
  if (_isToggleOn(rPr, 'i')) {
    pre += '_';
    suf = '_' + suf;
  }

  return [pre, suf];
}

/**
 * Apply formatting markers, splitting across newlines.
 * "**A\nB**" → "**A**\n**B**"
 * Matches Adeu apply_formatting_to_segments().
 */
function _applyMarkers(text, prefix, suffix) {
  if (!prefix && !suffix) return text;
  if (!text) return '';
  if (!text.includes('\n')) return prefix + text + suffix;
  return text.split('\n').map(p => p ? prefix + p + suffix : '').join('\n');
}

/** Process a <w:r> and push formatted text to parts array. */
function _processRun(rEl, parts) {
  const [pre, suf] = _runMarkers(rEl);
  const text = _runText(rEl);
  if (text) {
    parts.push(_applyMarkers(text, pre, suf));
  }
}

/**
 * Build text for a <w:p> element with heading prefix and formatting markers.
 * Clean view: <w:ins> text included, <w:del> text skipped.
 * Only handles w:r, w:ins, w:del — all other child elements (hyperlink,
 * sdt, bookmarkStart, commentRange, etc.) are skipped to match Adeu's
 * iter_paragraph_content().
 */
function _buildParagraphText(pEl, styleMap) {
  const prefix = _headingPrefix(pEl, styleMap);
  const parts = [];

  for (const child of pEl.childNodes) {
    if (child.nodeType !== 1 || child.namespaceURI !== W_NS) continue;

    switch (child.localName) {
      case 'r':
        _processRun(child, parts);
        break;
      case 'ins':
        // Clean view: include inserted runs without CriticMarkup wrappers
        for (const sc of child.childNodes) {
          if (sc.nodeType === 1 && sc.localName === 'r' && sc.namespaceURI === W_NS) {
            _processRun(sc, parts);
          }
        }
        break;
      // 'del': skip deleted content (clean view)
      // All other elements: skip (matches iter_paragraph_content)
    }
  }

  return prefix + parts.join('');
}

/** Extract text from a <w:tbl>. Cells: " | ", rows: "\n". */
function _extractTable(tblEl, styleMap) {
  const rows = [];

  for (const child of tblEl.childNodes) {
    if (child.nodeType !== 1 || child.localName !== 'tr' || child.namespaceURI !== W_NS) continue;

    const cellTexts = [];
    for (const tc of child.childNodes) {
      if (tc.nodeType !== 1 || tc.localName !== 'tc' || tc.namespaceURI !== W_NS) continue;
      cellTexts.push(_extractBlocks(tc, styleMap).join('\n\n'));
    }

    rows.push(cellTexts.join(' | '));
  }

  return rows.join('\n');
}

/**
 * Recursively extract blocks from a container element (w:body, w:tc).
 * Returns array of paragraph/table text strings.
 * Only handles w:p and w:tbl — other block-level elements (w:sdt, etc.)
 * are skipped to match Adeu's iter_block_items().
 */
function _extractBlocks(containerEl, styleMap) {
  const blocks = [];

  for (const child of containerEl.childNodes) {
    if (child.nodeType !== 1 || child.namespaceURI !== W_NS) continue;

    if (child.localName === 'p') {
      // Always include paragraphs, even empty ones, to match Adeu
      blocks.push(_buildParagraphText(child, styleMap));
    } else if (child.localName === 'tbl') {
      const t = _extractTable(child, styleMap);
      if (t) blocks.push(t);
    }
  }

  return blocks;
}

/**
 * Extract text from a DOCX ArrayBuffer with Adeu-compatible formatting.
 *
 * Output includes Markdown-like markers that match what Adeu's
 * DocumentMapper produces in its full_text.  This ensures the AI's
 * target_text values (which quote from this text) can be located
 * by the mapper when applying edits.
 */
export async function extractTextFromDocx(arrayBuffer) {
  const zip = await JSZip.loadAsync(arrayBuffer);
  const documentXml = await zip.file('word/document.xml')?.async('string');

  if (!documentXml) {
    throw new Error('Invalid DOCX file: missing document.xml');
  }

  // Parse styles.xml for heading detection and style-level bold
  const stylesXml = await zip.file('word/styles.xml')?.async('string');
  const styleMap = stylesXml ? _parseStyles(stylesXml) : {};

  const parser = new DOMParser();
  const doc = parser.parseFromString(documentXml, 'application/xml');

  const body = doc.getElementsByTagNameNS(W_NS, 'body')[0];
  if (!body) throw new Error('Invalid DOCX file: missing body');

  return _extractBlocks(body, styleMap).join('\n\n');
}

export function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * Verify binary data is a valid ZIP (DOCX) file
 */
export function isValidZipFile(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < 4) return false;
  // ZIP files start with PK\x03\x04
  return bytes[0] === 80 && bytes[1] === 75 && bytes[2] === 3 && bytes[3] === 4;
}

export function downloadFile(data, filename) {
  const blob = new Blob([data], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Test-only exports
if (typeof globalThis.__TEST__ !== 'undefined') {
  globalThis.__TEST_FILE_PROCESSING__ = {
    _parseStyles,
    _headingPrefix,
    _runMarkers,
    _runText,
    _applyMarkers,
    _buildParagraphText,
    _extractBlocks,
    _extractTable,
    W_NS,
  };
}
