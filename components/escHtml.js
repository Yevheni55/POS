'use strict';
/**
 * Escape HTML special characters to prevent XSS when inserting into innerHTML.
 * @param {*} str - Value to escape (coerced to string)
 * @returns {string} HTML-safe string
 */
function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
