/**
 * confirm.js — Unified confirmation dialog
 *
 * Usage:
 *   showConfirm({
 *     title: 'Zmazat polozku?',
 *     message: 'Tuto akciu nie je mozne vratit.',
 *     confirmText: 'Zmazat',
 *     cancelText: 'Zrusit',
 *     danger: true,
 *     onConfirm: function() { deleteItem(id); }
 *   })
 *
 * Accessible: role="alertdialog", aria-modal, focus trap, Escape to cancel.
 * Glass surface styling matching the design system.
 */
(function () {
  'use strict';

  var DIALOG_ID = 'confirm-dialog';

  function injectStyles() {
    if (document.getElementById('confirm-styles')) return;

    var style = document.createElement('style');
    style.id = 'confirm-styles';
    style.textContent = [
      '.confirm-overlay {',
      '  position: fixed;',
      '  inset: 0;',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: center;',
      '  background: rgba(0, 0, 0, 0.6);',
      '  backdrop-filter: blur(4px);',
      '  z-index: var(--z-modal, 200);',
      '  opacity: 0;',
      '  transition: opacity var(--transition-normal, 250ms ease);',
      '}',
      '',
      '.confirm-overlay.confirm-visible {',
      '  opacity: 1;',
      '}',
      '',
      '.confirm-dialog {',
      '  background: var(--color-bg-elevated, rgba(8,14,20,.95));',
      '  border: 1px solid var(--color-border, rgba(255,255,255,.08));',
      '  border-radius: var(--radius-md, 14px);',
      '  box-shadow: var(--shadow-lg, 0 8px 40px rgba(0,0,0,.4));',
      '  backdrop-filter: blur(16px);',
      '  padding: var(--space-6, 24px);',
      '  min-width: 320px;',
      '  max-width: 420px;',
      '  width: 90vw;',
      '  transform: scale(0.95) translateY(8px);',
      '  transition: transform var(--transition-normal, 250ms ease);',
      '}',
      '',
      '.confirm-overlay.confirm-visible .confirm-dialog {',
      '  transform: scale(1) translateY(0);',
      '}',
      '',
      '.confirm-title {',
      '  font-family: var(--font-display, "Newsreader", serif);',
      '  font-size: 18px;',
      '  font-weight: 600;',
      '  color: var(--color-text, rgba(220,240,245,.92));',
      '  margin: 0 0 var(--space-2, 8px) 0;',
      '}',
      '',
      '.confirm-message {',
      '  font-family: var(--font-body, "Bricolage Grotesque", sans-serif);',
      '  font-size: 14px;',
      '  color: var(--color-text-sec, rgba(220,240,245,.55));',
      '  line-height: 1.5;',
      '  margin: 0 0 var(--space-6, 24px) 0;',
      '}',
      '',
      '.confirm-buttons {',
      '  display: flex;',
      '  justify-content: flex-end;',
      '  gap: var(--space-3, 12px);',
      '}',
      '',
      '.confirm-btn {',
      '  padding: var(--space-2, 8px) var(--space-5, 20px);',
      '  border-radius: var(--radius-sm, 8px);',
      '  font-family: var(--font-body, "Bricolage Grotesque", sans-serif);',
      '  font-size: 13px;',
      '  font-weight: 600;',
      '  cursor: pointer;',
      '  border: 1px solid transparent;',
      '  transition: background var(--transition-fast, 150ms ease),',
      '              border-color var(--transition-fast, 150ms ease);',
      '}',
      '',
      '.confirm-btn-cancel {',
      '  background: var(--color-bg-surface, rgba(255,255,255,.05));',
      '  border-color: var(--color-border, rgba(255,255,255,.08));',
      '  color: var(--color-text-sec, rgba(220,240,245,.55));',
      '}',
      '',
      '.confirm-btn-cancel:hover {',
      '  background: var(--color-bg-hover, rgba(255,255,255,.07));',
      '  border-color: var(--color-border-hover, rgba(255,255,255,.12));',
      '  color: var(--color-text, rgba(220,240,245,.92));',
      '}',
      '',
      '.confirm-btn-ok {',
      '  background: var(--color-accent, #8B7CF6);',
      '  color: #fff;',
      '}',
      '',
      '.confirm-btn-ok:hover {',
      '  background: var(--color-accent-dim, #7B6EC7);',
      '}',
      '',
      '.confirm-btn-danger {',
      '  background: var(--color-danger, #E07070);',
      '  color: #fff;',
      '}',
      '',
      '.confirm-btn-danger:hover {',
      '  background: #c85e5e;',
      '}'
    ].join('\n');

    document.head.appendChild(style);
  }

  function showConfirm(options) {
    options = options || {};

    var title = options.title || 'Potvrdenie';
    var message = options.message || '';
    var confirmText = options.confirmText || 'Potvrdit\u0165';
    var cancelText = options.cancelText || 'Zru\u0161i\u0165';
    var danger = options.danger || false;
    var onConfirm = options.onConfirm || null;
    var onCancel = options.onCancel || null;

    injectStyles();

    // Remove any existing dialog
    var existing = document.getElementById(DIALOG_ID);
    if (existing) existing.parentNode.removeChild(existing);

    // Build DOM
    var titleId = 'confirm-title-' + Date.now();

    var overlay = document.createElement('div');
    overlay.id = DIALOG_ID;
    overlay.className = 'confirm-overlay';
    overlay.setAttribute('role', 'alertdialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', titleId);

    var dialog = document.createElement('div');
    dialog.className = 'confirm-dialog';
    dialog.setAttribute('tabindex', '-1');

    var titleEl = document.createElement('h2');
    titleEl.id = titleId;
    titleEl.className = 'confirm-title';
    titleEl.textContent = title;

    var messageEl = document.createElement('p');
    messageEl.className = 'confirm-message';
    messageEl.textContent = message;

    var buttons = document.createElement('div');
    buttons.className = 'confirm-buttons';

    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'confirm-btn confirm-btn-cancel';
    cancelBtn.textContent = cancelText;
    cancelBtn.type = 'button';

    var okBtn = document.createElement('button');
    okBtn.className = 'confirm-btn ' + (danger ? 'confirm-btn-danger' : 'confirm-btn-ok');
    okBtn.textContent = confirmText;
    okBtn.type = 'button';

    buttons.appendChild(cancelBtn);
    buttons.appendChild(okBtn);

    dialog.appendChild(titleEl);
    dialog.appendChild(messageEl);
    dialog.appendChild(buttons);
    overlay.appendChild(dialog);

    document.body.appendChild(overlay);

    // Store previous focus to restore later
    var previousFocus = document.activeElement;

    // Animate in
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        overlay.classList.add('confirm-visible');
        okBtn.focus();
      });
    });

    // --- Close helpers ---
    function close() {
      overlay.classList.remove('confirm-visible');
      setTimeout(function () {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        // Restore focus
        if (previousFocus && previousFocus.focus) {
          previousFocus.focus();
        }
      }, 300);
    }

    function handleConfirm() {
      close();
      if (onConfirm) onConfirm();
    }

    function handleCancel() {
      close();
      if (onCancel) onCancel();
    }

    // --- Event listeners ---
    okBtn.addEventListener('click', handleConfirm);
    cancelBtn.addEventListener('click', handleCancel);

    // Overlay click (outside dialog) cancels
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) handleCancel();
    });

    // Keyboard handling
    overlay.addEventListener('keydown', function (e) {
      // Escape cancels
      if (e.key === 'Escape') {
        e.preventDefault();
        handleCancel();
        return;
      }

      // Focus trap: Tab cycles within dialog only
      if (e.key === 'Tab') {
        var focusable = dialog.querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length === 0) return;

        var first = focusable[0];
        var last = focusable[focusable.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    });
  }

  window.showConfirm = showConfirm;
})();
