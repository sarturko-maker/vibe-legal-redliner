/**
 * Trusted HTML — single approved way to set innerHTML in the extension.
 *
 * When the browser supports Trusted Types, all innerHTML assignments go
 * through the 'vibe-legal' policy so the CSP can enforce that no other
 * code path creates raw HTML strings.  When Trusted Types are unavailable
 * the function still works — it just sets innerHTML directly.
 */

let _policy = null;

if (typeof window !== 'undefined' && window.trustedTypes && window.trustedTypes.createPolicy) {
  _policy = window.trustedTypes.createPolicy('vibe-legal', {
    createHTML: (html) => html
  });
}

/**
 * Set the innerHTML of an element through the Trusted Types policy.
 * This is the ONLY function in the codebase allowed to assign innerHTML.
 *
 * @param {HTMLElement} element — target element
 * @param {string} htmlString — the HTML to set
 */
export function safeSetHTML(element, htmlString) {
  if (_policy) {
    // eslint-disable-next-line no-restricted-syntax -- sole approved innerHTML gateway
    element.innerHTML = _policy.createHTML(htmlString);
  } else {
    // eslint-disable-next-line no-restricted-syntax -- sole approved innerHTML gateway
    element.innerHTML = htmlString;
  }
}
