/**
 * Background Service Worker
 * Manages the offscreen document for Pyodide execution
 * Handles side panel and full screen modes
 */

let pyodideReady = false;
let creatingOffscreen = null;
let pyodideReadyPromise = null;
let pyodideReadyResolve = null;
let pyodideReadyReject = null;

// Enable side panel on all pages
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});

/**
 * Returns a promise that resolves when Pyodide is ready.
 * Rejects if Pyodide fails to initialize.
 * Resolves immediately if already ready.
 */
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

/**
 * Create the offscreen document if it doesn't exist.
 * Resets pyodideReady when a new document is created.
 */
async function ensureOffscreenDocument() {
  // Return existing promise if creation is in progress
  if (creatingOffscreen) {
    return creatingOffscreen;
  }

  creatingOffscreen = (async () => {
    // Check if offscreen document already exists
    try {
      const existingContexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT']
      });

      if (existingContexts.length > 0) {
        // Offscreen doc exists — if service worker restarted, pyodideReady
        // was reset to false. Ping the offscreen doc to recover state.
        if (!pyodideReady) {
          try {
            const pingResp = await chrome.runtime.sendMessage({ type: 'ping' });
            if (pingResp && pingResp.ready) {
              pyodideReady = true;
              if (pyodideReadyResolve) {
                pyodideReadyResolve();
                pyodideReadyPromise = null;
                pyodideReadyResolve = null;
                pyodideReadyReject = null;
              }
            }
          } catch (e) {
            // Ping failed — offscreen doc may still be initializing
          }
        }
        return;
      }
    } catch (e) {
      // getContexts might fail, proceed to try creating
    }

    // New offscreen doc needed — reset ready state so waitForPyodideReady() waits
    pyodideReady = false;
    pyodideReadyPromise = null;
    pyodideReadyResolve = null;
    pyodideReadyReject = null;

    // Create offscreen document
    try {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['WORKERS'],
        justification: 'Run Pyodide for document processing'
      });
    } catch (e) {
      // Ignore "already exists" error
      if (!e.message.includes('single offscreen')) {
        throw e;
      }
    }
  })();

  // Reset the promise after completion to allow retry on failure
  creatingOffscreen.finally(() => {
    creatingOffscreen = null;
  });

  return creatingOffscreen;
}

/**
 * Handle messages from popup
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Handle pyodide ready notification from offscreen
  if (message.type === 'pyodide-ready') {
    pyodideReady = true;
    // Resolve any pending waitForPyodideReady() callers
    if (pyodideReadyResolve) {
      pyodideReadyResolve();
      pyodideReadyPromise = null;
      pyodideReadyResolve = null;
      pyodideReadyReject = null;
    }
    // Broadcast to all extension pages
    chrome.runtime.sendMessage({ type: 'engine-ready' }).catch(() => {});
    return;
  }

  if (message.type === 'pyodide-error') {
    // Reject any pending waitForPyodideReady() callers
    if (pyodideReadyReject) {
      pyodideReadyReject(new Error('Engine failed to initialise: ' + (message.error || 'unknown error')));
      pyodideReadyPromise = null;
      pyodideReadyResolve = null;
      pyodideReadyReject = null;
    }
    chrome.runtime.sendMessage({ type: 'engine-error', error: message.error }).catch(() => {});
    return;
  }

  // Handle status check from popup — synchronous, no offscreen creation
  if (message.type === 'check-engine-status') {
    sendResponse({ ready: pyodideReady });
    return;
  }

  // Handle ensure-engine request — creates offscreen doc and waits for Pyodide
  if (message.type === 'ensure-engine') {
    ensureOffscreenDocument()
      .then(() => waitForPyodideReady())
      .then(() => sendResponse({ ready: true }))
      .catch((err) => sendResponse({ ready: false, error: err.message }));
    return true;
  }

  // Handle text extraction request
  if (message.type === 'extract-text') {
    ensureOffscreenDocument().then(async () => {
      try {
        await waitForPyodideReady();
        const response = await chrome.runtime.sendMessage({
          type: 'extract',
          contractBytes: message.contractBytes,
          cleanView: message.cleanView
        });
        sendResponse(response);
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
    });
    return true;
  }

  // Handle apply-edits request
  if (message.type === 'apply-edits') {
    ensureOffscreenDocument().then(async () => {
      try {
        await waitForPyodideReady();
        const response = await chrome.runtime.sendMessage({
          type: 'apply',
          contractBytes: message.contractBytes,
          edits: message.edits
        });
        sendResponse(response);
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
    });
    return true;
  }

  return false;
});
