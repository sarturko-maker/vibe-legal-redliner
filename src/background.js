let pyodideReady = false;
let creatingOffscreen = null;
let pyodideReadyPromise = null;
let pyodideReadyResolve = null;
let pyodideReadyReject = null;

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});

function resetReadyState() {
  pyodideReadyPromise = null;
  pyodideReadyResolve = null;
  pyodideReadyReject = null;
}

function resolveReady() {
  pyodideReady = true;
  if (pyodideReadyResolve) {
    pyodideReadyResolve();
    resetReadyState();
  }
}

function waitForPyodideReady() {
  if (pyodideReady) return Promise.resolve();
  if (!pyodideReadyPromise) {
    pyodideReadyPromise = new Promise((resolve, reject) => {
      pyodideReadyResolve = resolve;
      pyodideReadyReject = reject;
    });
  }
  return pyodideReadyPromise;
}

async function ensureOffscreenDocument() {
  if (creatingOffscreen) return creatingOffscreen;

  creatingOffscreen = (async () => {
    try {
      const existingContexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT']
      });

      if (existingContexts.length > 0) {
        if (!pyodideReady) {
          try {
            const pingResp = await chrome.runtime.sendMessage({ type: 'ping' });
            if (pingResp?.ready) resolveReady();
          } catch {
            // Offscreen doc may still be initializing
          }
        }
        return;
      }
    } catch {
      // getContexts might fail, proceed to try creating
    }

    pyodideReady = false;
    resetReadyState();

    try {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['WORKERS'],
        justification: 'Run Pyodide for document processing'
      });
    } catch (e) {
      if (!e.message.includes('single offscreen')) throw e;
    }
  })();

  creatingOffscreen.finally(() => { creatingOffscreen = null; });
  return creatingOffscreen;
}

async function forwardToOffscreen(offscreenType, message, sendResponse) {
  try {
    await ensureOffscreenDocument();
    await waitForPyodideReady();
    const response = await chrome.runtime.sendMessage({
      type: offscreenType,
      ...message
    });
    sendResponse(response);
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'pyodide-ready') {
    resolveReady();
    chrome.runtime.sendMessage({ type: 'engine-ready' }).catch(() => {});
    return;
  }

  if (message.type === 'pyodide-error') {
    if (pyodideReadyReject) {
      pyodideReadyReject(new Error('Engine failed to initialise: ' + (message.error || 'unknown error')));
      resetReadyState();
    }
    chrome.runtime.sendMessage({ type: 'engine-error', error: message.error }).catch(() => {});
    return;
  }

  if (message.type === 'check-engine-status') {
    sendResponse({ ready: pyodideReady });
    return;
  }

  if (message.type === 'ensure-engine') {
    ensureOffscreenDocument()
      .then(() => waitForPyodideReady())
      .then(() => sendResponse({ ready: true }))
      .catch((err) => sendResponse({ ready: false, error: err.message }));
    return true;
  }

  if (message.type === 'extract-text') {
    forwardToOffscreen('extract', {
      contractBytes: message.contractBytes,
      cleanView: message.cleanView
    }, sendResponse);
    return true;
  }

  if (message.type === 'apply-edits') {
    forwardToOffscreen('apply', {
      contractBytes: message.contractBytes,
      edits: message.edits,
      polishFormatting: message.polishFormatting
    }, sendResponse);
    return true;
  }

  return false;
});
