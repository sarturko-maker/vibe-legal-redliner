let pyodide = null;
let ready = false;

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
    { path: 'python/adeu/VERSION', dest: '/adeu/VERSION' },
    { path: 'python/pipeline.py', dest: '/pipeline.py' }
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
from pipeline import prepare as pipeline_prepare, apply_edits as pipeline_apply
`);

    ready = true;
    chrome.runtime.sendMessage({ type: 'pyodide-ready' });

  } catch (error) {
    chrome.runtime.sendMessage({ type: 'pyodide-error', error: error.message });
  }
}

async function processDocument(editsJson, fallbackBytes) {
  if (!ready) throw new Error('Pyodide not ready');

  const startTime = Date.now();
  pyodide.globals.set('js_edits_json', editsJson);

  let pyCode;
  if (fallbackBytes) {
    pyodide.globals.set('js_fallback_bytes', fallbackBytes);
    pyCode = `
fb = bytes(js_fallback_bytes.to_py())
result = pipeline_apply(js_edits_json, fallback_bytes=fb)
result
    `;
  } else {
    pyCode = `
result = pipeline_apply(js_edits_json)
result
    `;
  }

  const result = await pyodide.runPythonAsync(pyCode);

  const resultMap = result.toJs();
  const outputBytes = new Uint8Array(resultMap.get('doc_bytes'));
  const applied = resultMap.get('applied');
  const skipped = resultMap.get('skipped');
  const statuses = JSON.parse(resultMap.get('statuses'));

  if (result.destroy) result.destroy();
  pyodide.globals.delete('js_edits_json');
  if (fallbackBytes) pyodide.globals.delete('js_fallback_bytes');
  await cleanupPythonVars('fb', 'result');

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
pipeline_prepare(doc_bytes, clean_view=js_clean_view)
  `);

  pyodide.globals.delete('js_extract_bytes');
  pyodide.globals.delete('js_clean_view');
  await cleanupPythonVars('doc_bytes');

  console.log('[VL-DEBUG] Text extraction (prepare) complete', {
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

    extractText(bytes, cleanView)
      .then(text => sendResponse({ success: true, text }))
      .catch(error => sendResponse({ success: false, error: error.message || 'Text extraction failed' }));
    return true;
  }

  if (message.type === 'apply') {
    const fallbackBytes = message.contractBytes ? new Uint8Array(message.contractBytes) : null;

    processDocument(JSON.stringify(message.edits), fallbackBytes)
      .then(({ outputBytes, applied, skipped, statuses }) => {
        sendResponse({ success: true, result: Array.from(outputBytes), applied, skipped, statuses });
      })
      .catch(error => sendResponse({ success: false, error: error.message || 'Document processing failed' }));
    return true;
  }

  return false;
});

initPyodide();
