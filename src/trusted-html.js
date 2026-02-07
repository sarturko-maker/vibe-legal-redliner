let _policy = null;

if (typeof window !== 'undefined' && window.trustedTypes && window.trustedTypes.createPolicy) {
  _policy = window.trustedTypes.createPolicy('vibe-legal', {
    createHTML: (html) => html
  });
}

export function safeSetHTML(element, htmlString) {
  // eslint-disable-next-line no-restricted-syntax -- sole approved innerHTML gateway
  element.innerHTML = _policy ? _policy.createHTML(htmlString) : htmlString;
}
