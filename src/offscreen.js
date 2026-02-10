let pyodide = null;
let ready = false;
let storedDocxBytes = null;

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

  pyodide.FS.mkdir('/adeu');
  pyodide.FS.mkdir('/adeu/redline');
  pyodide.FS.mkdir('/adeu/utils');

  for (const file of files) {
    try {
      const url = chrome.runtime.getURL(file.path);
      const response = await fetch(url);
      if (response.ok) {
        pyodide.FS.writeFile(file.dest, await response.text());
      } else if (file.dest.endsWith('__init__.py')) {
        pyodide.FS.writeFile(file.dest, '');
      }
    } catch {
      if (file.dest.endsWith('__init__.py')) {
        pyodide.FS.writeFile(file.dest, '');
      }
    }
  }
}

function cleanupPythonVars(...names) {
  const stmts = names.map(n => `try:\n    del ${n}\nexcept NameError:\n    pass`);
  return pyodide.runPythonAsync(stmts.join('\n'));
}

async function initPyodide() {
  try {
    pyodide = await loadPyodide({
      indexURL: chrome.runtime.getURL('pyodide/')
    });

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

    const packageUrls = packages.map(p => chrome.runtime.getURL(p));
    pyodide.globals.set('package_urls', packageUrls);

    await pyodide.runPythonAsync(`
import micropip
urls = package_urls.to_py()
await micropip.install(urls)
`);

    await loadAdeuSource();

    await pyodide.runPythonAsync(`
import sys
sys.path.insert(0, '/')
`);

    const adeuVersion = await pyodide.runPythonAsync(`
from adeu.models import DocumentEdit
from adeu.redline.engine import RedlineEngine
import adeu
adeu.__version__
`);
    console.log(`Adeu engine v${adeuVersion}`);

    await pyodide.runPythonAsync(`
import json
from io import BytesIO
from adeu.models import DocumentEdit
from adeu.redline.engine import RedlineEngine
from adeu.ingest import extract_text_from_stream
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

def extract_text(docx_bytes: bytes, clean_view: bool = False) -> str:
    stream = BytesIO(docx_bytes)
    try:
        return extract_text_from_stream(stream, clean_view=clean_view)
    finally:
        stream.close()

def enable_track_changes(doc):
    settings = doc.settings.element

    if settings.find(qn('w:trackRevisions')) is None:
        settings.append(OxmlElement('w:trackRevisions'))

    for tag in ['w:revisionView', 'w:documentProtection', 'w:writeProtection', 'w:docFinal']:
        for el in settings.findall(qn(tag)):
            settings.remove(el)

    body = doc.element.body
    if body is not None:
        for perm in body.xpath('//w:permStart | //w:permEnd'):
            perm.getparent().remove(perm)
        for lock in body.xpath('//w:lock'):
            lock.getparent().remove(lock)

def strip_comments(doc):
    from docx.opc.constants import CONTENT_TYPE as CT_CONST
    from docx.opc.constants import RELATIONSHIP_TYPE as RT_CONST

    body = doc.element.body
    if body is not None:
        for tag in ['w:commentRangeStart', 'w:commentRangeEnd']:
            for el in body.xpath(f'//{tag}'):
                el.getparent().remove(el)
        for ref in body.xpath('//w:commentReference'):
            run = ref.getparent()
            if run is not None and run.tag.endswith('}r'):
                run.getparent().remove(run)
            else:
                ref.getparent().remove(ref)

    comment_uri_patterns = ['comments', 'commentsExtended', 'commentsIds', 'commentsExtensible']
    rels_to_remove = []
    for rel_key, rel in doc.part.rels.items():
        rel_type = rel.reltype or ''
        partname = str(getattr(rel, '_target', None))
        if (rel_type == RT_CONST.COMMENTS
            or any(pat in partname.lower() for pat in comment_uri_patterns)
            or 'comment' in rel_type.lower()):
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
    edits = [DocumentEdit(target_text=e.get('target_text', ''), new_text=e.get('new_text', '')) for e in edits_data]

    input_stream = BytesIO(docx_bytes)
    try:
        engine = RedlineEngine(input_stream, author=author)

        indexed = sorted(enumerate(edits), key=lambda x: len(x[1].target_text), reverse=True)

        statuses = [False] * len(edits)
        applied = 0
        skipped = 0

        for orig_idx, edit in indexed:
            preview = edit.target_text[:50].replace('\\n', ' ')
            a, _s = engine.apply_edits([edit])
            if a > 0:
                statuses[orig_idx] = True
                applied += 1
                print(f"[VL-DEBUG] Edit #{orig_idx} APPLIED: \\"{preview}\\"")
            else:
                skipped += 1
                print(f"[VL-DEBUG] Edit #{orig_idx} SKIPPED: \\"{preview}\\"")

        print(f"[VL-DEBUG] Edits summary: {applied} applied, {skipped} skipped out of {len(edits)} total")

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
    chrome.runtime.sendMessage({ type: 'pyodide-ready' });

  } catch (error) {
    chrome.runtime.sendMessage({ type: 'pyodide-error', error: error.message });
  }
}

async function processDocument(contractBytes, editsJson) {
  if (!ready) throw new Error('Pyodide not ready');

  const startTime = Date.now();
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

  if (result.destroy) result.destroy();
  pyodide.globals.delete('js_contract_bytes');
  pyodide.globals.delete('js_edits_json');
  await cleanupPythonVars('contract_bytes', 'result');

  console.log('[VL-DEBUG] Adeu processing complete', {
    applied, skipped, totalEdits: statuses.length,
    elapsedMs: Date.now() - startTime
  });

  return { outputBytes, applied, skipped, statuses };
}

async function extractText(contractBytes, cleanView) {
  if (!ready) throw new Error('Pyodide not ready');

  const startTime = Date.now();
  pyodide.globals.set('js_extract_bytes', contractBytes);
  pyodide.globals.set('js_clean_view', cleanView);

  const text = await pyodide.runPythonAsync(`
doc_bytes = bytes(js_extract_bytes.to_py())
extract_text(doc_bytes, clean_view=js_clean_view)
  `);

  pyodide.globals.delete('js_extract_bytes');
  pyodide.globals.delete('js_clean_view');
  await cleanupPythonVars('doc_bytes');

  console.log('[VL-DEBUG] Text extraction complete', {
    textLength: text.length,
    elapsedMs: Date.now() - startTime
  });

  return text;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'ping') {
    sendResponse({ ready });
    return true;
  }

  if (message.type === 'extract') {
    const bytes = new Uint8Array(message.contractBytes);
    const cleanView = message.cleanView ?? false;
    storedDocxBytes = bytes;

    extractText(bytes, cleanView)
      .then(text => sendResponse({ success: true, text }))
      .catch(error => sendResponse({ success: false, error: error.message || 'Text extraction failed' }));
    return true;
  }

  if (message.type === 'apply') {
    const bytes = storedDocxBytes || (message.contractBytes ? new Uint8Array(message.contractBytes) : null);

    if (!bytes) {
      sendResponse({ success: false, error: 'No document bytes available' });
      return true;
    }

    processDocument(bytes, JSON.stringify(message.edits))
      .then(({ outputBytes, applied, skipped, statuses }) => {
        storedDocxBytes = null;
        sendResponse({ success: true, result: Array.from(outputBytes), applied, skipped, statuses });
      })
      .catch(error => sendResponse({ success: false, error: error.message || 'Document processing failed' }));
    return true;
  }

  return false;
});

initPyodide();
