'use strict';
// pos-escape.js — HTML/attribute escaping helpers for POS render modules.
// Loaded as a classic script (matches project convention — no ES modules).
// Exposes escHtml() and escAttr() on window so all POS scripts can call them.
//
// Security note (PR-1.3): every user-controlled string that is interpolated
// into innerHTML / insertAdjacentHTML / template-string-assigned-to-.innerHTML
// MUST pass through escHtml() (text content) or escAttr() (attribute context).
// Helmet CSP is disabled in server/app.js, so there is no browser-side fallback
// against a stored XSS (e.g. a menu item named <img src=x onerror=alert(1)>).

(function () {
  function toStr(value) {
    if (value === null || value === undefined) return '';
    return String(value);
  }

  /**
   * Escape HTML special characters for safe interpolation inside element
   * text content or innerHTML. Pure, sync, null/undefined/number-safe.
   * @param {*} value - any value; coerced to string.
   * @returns {string}
   */
  function escHtml(value) {
    return toStr(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Stricter escape for use inside an HTML attribute value ("..." or '...').
   * Encodes quotes, angle brackets, ampersand, newlines, tabs and backticks.
   * Safe to embed inside double- or single-quoted attributes.
   * @param {*} value - any value; coerced to string.
   * @returns {string}
   */
  function escAttr(value) {
    return toStr(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/`/g, '&#96;')
      .replace(/\r/g, '&#13;')
      .replace(/\n/g, '&#10;')
      .replace(/\t/g, '&#9;');
  }

  // Expose to global scope (classic-script convention used by the POS app).
  // Override any prior escHtml (e.g. from /components/escHtml.js) with this
  // stricter, null/undefined-safe implementation — API-compatible.
  if (typeof window !== 'undefined') {
    window.escHtml = escHtml;
    window.escAttr = escAttr;
  }

  // CommonJS export so Node-side unit tests can load this file directly.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { escHtml: escHtml, escAttr: escAttr };
  }
})();
