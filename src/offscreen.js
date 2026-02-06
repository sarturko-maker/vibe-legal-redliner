/**
 * Offscreen Document for Pyodide execution
 * This runs in a separate context with fewer CSP restrictions
 */

let pyodide = null;
let ready = false;

/**
 * Load Adeu Python source files into Pyodide's virtual filesystem
 */
async function loadAdeuSource() {
  const files = [
    { path: 'python/adeu/__init__.py', dest: '/adeu/__init__.py' },
    { path: 'python/adeu/models.py', dest: '/adeu/models.py' },
    { path: 'python/adeu/diff.py', dest: '/adeu/diff.py' },
    { path: 'python/adeu/ingest.py', dest: '/adeu/ingest.py' },
    { path: 'python/adeu/markup.py', dest: '/adeu/markup.py' },
    { path: 'python/adeu/redline/__init__.py', dest: '/adeu/redline/__init__.py' },
    { path: 'python/adeu/redline/engine.py', dest: '/adeu/redline/engine.py' },
    { path: 'python/adeu/redline/mapper.py', dest: '/adeu/redline/mapper.py' },
    { path: 'python/adeu/redline/comments.py', dest: '/adeu/redline/comments.py' },
    { path: 'python/adeu/utils/__init__.py', dest: '/adeu/utils/__init__.py' },
    { path: 'python/adeu/utils/docx.py', dest: '/adeu/utils/docx.py' },
    { path: 'python/adeu/VERSION', dest: '/adeu/VERSION' }
  ];

  // Create directory structure
  pyodide.FS.mkdir('/adeu');
  pyodide.FS.mkdir('/adeu/redline');
  pyodide.FS.mkdir('/adeu/utils');

  for (const file of files) {
    try {
      const url = chrome.runtime.getURL(file.path);
      const response = await fetch(url);
      if (response.ok) {
        const content = await response.text();
        pyodide.FS.writeFile(file.dest, content);
      } else if (file.dest.endsWith('__init__.py')) {
        pyodide.FS.writeFile(file.dest, '');
      }
    } catch (e) {
      if (file.dest.endsWith('__init__.py')) {
        pyodide.FS.writeFile(file.dest, '');
      }
      // Non-init files failing to load will cause import errors later
    }
  }
}

/**
 * Initialize Pyodide
 */
async function initPyodide() {
  try {
    // Load Pyodide with local index URL
    pyodide = await loadPyodide({
      indexURL: chrome.runtime.getURL('pyodide/')
    });

    // Load micropip
    await pyodide.loadPackage('micropip');
    
    const packages = [
      'pyodide/typing_extensions-4.11.0-py3-none-any.whl',
      'pyodide/annotated_types-0.6.0-py3-none-any.whl',
      'pyodide/pydantic_core-2.18.1-cp312-cp312-pyodide_2024_0_wasm32.whl',
      'pyodide/pydantic-2.7.0-py3-none-any.whl',
      'pyodide/lxml-5.2.1-cp312-cp312-pyodide_2024_0_wasm32.whl',
      'pyodide/python_docx-1.2.0-py3-none-any.whl',
      'pyodide/diff_match_patch-20241021-py3-none-any.whl',
      'pyodide/structlog-25.5.0-py3-none-any.whl'
    ];

    // Build full URLs in JavaScript and pass to Python
    const packageUrls = packages.map(p => chrome.runtime.getURL(p));
    pyodide.globals.set('package_urls', packageUrls);

    await pyodide.runPythonAsync(`
import micropip
urls = package_urls.to_py()
await micropip.install(urls)
`);

    // Load Adeu source files
    await loadAdeuSource();

    // Set up Python path
    await pyodide.runPythonAsync(`
import sys
sys.path.insert(0, '/')
`);

    // Test import and log version
    const adeuVersion = await pyodide.runPythonAsync(`
from adeu.models import DocumentEdit
from adeu.redline.engine import RedlineEngine
import adeu
adeu.__version__
`);
    console.log(`Adeu engine v${adeuVersion}`);

    // Load wrapper code
    await pyodide.runPythonAsync(`
import json
from io import BytesIO
from adeu.models import DocumentEdit
from adeu.redline.engine import RedlineEngine
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

def enable_track_changes(doc):
    """
    Enable track changes visibility in the document settings.
    Removes ALL protection mechanisms that could cause read-only mode.
    """
    settings = doc.settings.element

    # Add w:trackRevisions if not present (tells Word track changes exist)
    if settings.find(qn('w:trackRevisions')) is None:
        track_revisions = OxmlElement('w:trackRevisions')
        settings.append(track_revisions)

    # Remove any w:revisionView that might hide markup
    for rv in settings.findall(qn('w:revisionView')):
        settings.remove(rv)

    # Remove document protection (causes read-only)
    for dp in settings.findall(qn('w:documentProtection')):
        settings.remove(dp)

    # Remove write protection
    for wp in settings.findall(qn('w:writeProtection')):
        settings.remove(wp)

    # Remove document being marked as "final" (read-only recommendation)
    for df in settings.findall(qn('w:docFinal')):
        settings.remove(df)

    # Also check the document body for content locks
    body = doc.element.body
    if body is not None:
        # Remove permission ranges that might restrict editing
        for perm in body.xpath('//w:permStart | //w:permEnd'):
            perm.getparent().remove(perm)

        # Remove content locks
        for lock in body.xpath('//w:lock'):
            lock.getparent().remove(lock)

def strip_comments(doc):
    """
    Remove all comment-related parts and XML elements from the document.
    CommentsManager creates these parts on init even when no comments are added,
    which can cause Word to show an empty comments panel.
    """
    from docx.opc.constants import CONTENT_TYPE as CT_CONST
    from docx.opc.constants import RELATIONSHIP_TYPE as RT_CONST

    # 1. Remove comment range markers and references from document body
    body = doc.element.body
    if body is not None:
        for tag in ['w:commentRangeStart', 'w:commentRangeEnd']:
            for el in body.xpath(f'//{tag}'):
                el.getparent().remove(el)
        # Remove comment reference runs
        for ref in body.xpath('//w:commentReference'):
            run = ref.getparent()
            if run is not None and run.tag.endswith('}r'):
                run.getparent().remove(run)
            else:
                ref.getparent().remove(ref)

    # 2. Remove comment-related relationships and parts
    comment_rel_types = [
        RT_CONST.COMMENTS,
    ]
    # Also match extended comment relationship types by URI pattern
    comment_uri_patterns = [
        'comments',
        'commentsExtended',
        'commentsIds',
        'commentsExtensible',
    ]
    rels_to_remove = []
    for rel_key, rel in doc.part.rels.items():
        rel_type = rel.reltype or ''
        partname = str(getattr(rel, '_target', None))
        # Match by relationship type
        if rel_type in comment_rel_types:
            rels_to_remove.append(rel_key)
        # Match by partname pattern
        elif any(pat in partname.lower() for pat in comment_uri_patterns):
            rels_to_remove.append(rel_key)
        # Match by relationship type URI containing 'comment'
        elif 'comment' in rel_type.lower():
            rels_to_remove.append(rel_key)

    for rel_key in rels_to_remove:
        try:
            target_part = doc.part.rels[rel_key].target_part
            if target_part in doc.part.package.parts:
                doc.part.package.parts.remove(target_part)
        except Exception:
            pass
        del doc.part.rels[rel_key]

def process_document(docx_bytes: bytes, edits_json: str, author: str = 'Vibe Legal') -> dict:
    edits_data = json.loads(edits_json)
    edits = []
    for edit in edits_data:
        edits.append(DocumentEdit(
            target_text=edit.get('target_text', ''),
            new_text=edit.get('new_text', '')
        ))
    input_stream = BytesIO(docx_bytes)
    try:
        engine = RedlineEngine(input_stream, author=author)

        # Apply edits one at a time to track per-edit status.
        # Sort longest target_text first (matches Adeu's internal strategy)
        # but preserve original indices for status reporting.
        indexed = list(enumerate(edits))
        indexed.sort(key=lambda x: len(x[1].target_text), reverse=True)

        statuses = [False] * len(edits)
        applied = 0
        skipped = 0

        for orig_idx, edit in indexed:
            a, _s = engine.apply_edits([edit])
            if a > 0:
                statuses[orig_idx] = True
                applied += 1
            else:
                skipped += 1

        enable_track_changes(engine.doc)
        strip_comments(engine.doc)
        output_stream = engine.save_to_stream()
        try:
            doc_bytes = output_stream.getvalue()
        finally:
            output_stream.close()
        return {"doc_bytes": doc_bytes, "applied": applied, "skipped": skipped, "statuses": json.dumps(statuses)}
    finally:
        input_stream.close()
`);

    ready = true;

    // Notify that we're ready
    chrome.runtime.sendMessage({ type: 'pyodide-ready' });

  } catch (error) {
    chrome.runtime.sendMessage({ type: 'pyodide-error', error: error.message });
  }
}

/**
 * Process a document with redlines
 */
async function processDocument(contractBytes, editsJson) {
  if (!ready) {
    throw new Error('Pyodide not ready');
  }

  pyodide.globals.set('js_contract_bytes', contractBytes);
  pyodide.globals.set('js_edits_json', editsJson);

  const result = await pyodide.runPythonAsync(`
contract_bytes = bytes(js_contract_bytes.to_py())
result = process_document(contract_bytes, js_edits_json)
result
  `);

  const resultMap = result.toJs();
  const outputBytes = new Uint8Array(resultMap.get('doc_bytes'));
  const applied = resultMap.get('applied');
  const skipped = resultMap.get('skipped');
  const statuses = JSON.parse(resultMap.get('statuses'));

  // -----------------------------------------------------------------------
  // Data lifecycle cleanup
  //
  // Document bytes exist ONLY in RAM and are NEVER written to disk.
  // The lifecycle is:
  //   1. The UI sends contract bytes via chrome.runtime.sendMessage
  //   2. This function passes them into Pyodide for processing
  //   3. Pyodide returns redlined bytes, copied into a JS Uint8Array above
  //   4. The message handler sends the Uint8Array back to the UI, then
  //      the reference is nulled out
  //
  // All memory is also released automatically if the offscreen document
  // is destroyed (happens when the popup/tab closes or the extension
  // is unloaded). The explicit cleanup below ensures that between
  // sequential calls (e.g. batch processing), the previous document's
  // data does not linger in either the JS heap or Pyodide's Python heap.
  // -----------------------------------------------------------------------

  // 1. Destroy the Pyodide proxy that bridges Python bytes → JS
  if (result.destroy) result.destroy();

  // 2. Remove the JS→Python bridge globals (input bytes and edits JSON)
  pyodide.globals.delete('js_contract_bytes');
  pyodide.globals.delete('js_edits_json');

  // 3. Delete Python-side intermediate variables that persist in module scope
  //    (contract_bytes and result survive between calls if not explicitly deleted)
  await pyodide.runPythonAsync(`
try:
    del contract_bytes
except NameError:
    pass
try:
    del result
except NameError:
    pass
  `);

  return { outputBytes, applied, skipped, statuses };
}

// Listen for messages from the service worker or popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'ping') {
    sendResponse({ ready });
    return true;
  }

  if (message.type === 'redline') {
    const { contractBytes, edits } = message;

    processDocument(new Uint8Array(contractBytes), JSON.stringify(edits))
      .then(({ outputBytes, applied, skipped, statuses }) => {
        // Array.from() copies the bytes into the response; null the
        // Uint8Array immediately so it can be GC'd without waiting
        // for the callback scope to unwind.
        const response = Array.from(outputBytes);
        outputBytes = null;
        sendResponse({ success: true, result: response, applied, skipped, statuses });
      })
      .catch(error => {
        sendResponse({ success: false, error: error.message || 'Document processing failed' });
      });

    return true; // Keep channel open for async response
  }

  return false;
});

// Start initialization
initPyodide();
