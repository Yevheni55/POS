/**
 * toast.js — Unified toast notification system
 *
 * Usage:
 *   showToast('Uložené', 'success')
 *   showToast('Chyba pri ukladaní', 'error')
 *   showToast('Pozor', 'warning')
 *   showToast('Info správa', 'info')
 *
 * Auto-creates container on first call. Stacks up to 3 toasts.
 * Uses CSS variables from tokens.css.
 */
(function () {
  'use strict';

  var CONTAINER_ID = 'toast-container';
  var MAX_VISIBLE = 3;

  var DURATIONS = {
    success: 3000,
    info: 3000,
    error: 5000,
    warning: 5000
  };

  var BORDER_COLORS = {
    success: 'var(--color-success, #5CC49E)',
    error: 'var(--color-danger, #E07070)',
    warning: '#E0A830',
    info: 'var(--color-accent, #8B7CF6)'
  };

  var ICONS = {
    success: '\u2713',
    error: '\u2717',
    warning: '\u26A0',
    info: '\u2139'
  };

  function injectStyles() {
    if (document.getElementById('toast-styles')) return;

    var style = document.createElement('style');
    style.id = 'toast-styles';
    style.textContent = [
      '#' + CONTAINER_ID + ' {',
      '  position: fixed;',
      '  bottom: var(--space-6, 24px);',
      '  right: var(--space-6, 24px);',
      '  z-index: var(--z-toast, 300);',
      '  display: flex;',
      '  flex-direction: column-reverse;',
      '  gap: var(--space-2, 8px);',
      '  pointer-events: none;',
      '}',
      '',
      '.toast-item {',
      '  display: flex;',
      '  align-items: center;',
      '  gap: var(--space-3, 12px);',
      '  min-width: 260px;',
      '  max-width: 380px;',
      '  padding: var(--space-3, 12px) var(--space-4, 16px);',
      '  background: var(--color-bg-elevated, rgba(8,14,20,.95));',
      '  border: 1px solid var(--color-border, rgba(255,255,255,.08));',
      '  border-left: 3px solid currentColor;',
      '  border-radius: var(--radius-sm, 8px);',
      '  box-shadow: var(--shadow-md, 0 4px 20px rgba(0,0,0,.3));',
      '  backdrop-filter: blur(12px);',
      '  font-family: var(--font-body, "Bricolage Grotesque", sans-serif);',
      '  font-size: 13px;',
      '  font-weight: 600;',
      '  color: var(--color-text, rgba(220,240,245,.92));',
      '  pointer-events: auto;',
      '  cursor: pointer;',
      '  transform: translateX(110%);',
      '  opacity: 0;',
      '  transition: transform var(--transition-normal, 250ms ease),',
      '              opacity var(--transition-normal, 250ms ease);',
      '}',
      '',
      '.toast-item.toast-visible {',
      '  transform: translateX(0);',
      '  opacity: 1;',
      '}',
      '',
      '.toast-item.toast-exit {',
      '  transform: translateX(110%);',
      '  opacity: 0;',
      '}',
      '',
      '.toast-icon {',
      '  flex-shrink: 0;',
      '  font-size: 16px;',
      '  line-height: 1;',
      '}',
      '',
      '.toast-message {',
      '  flex: 1;',
      '  line-height: 1.4;',
      '}',
      '',
      '/* POS mobile: tab bar ~64px + safe-area — keep toasts above Objednávka tab */',
      '@media (max-width: 768px) {',
      '  #' + CONTAINER_ID + ' {',
      '    left: 12px;',
      '    right: 12px;',
      '    bottom: calc(72px + env(safe-area-inset-bottom, 0px));',
      '    align-items: stretch;',
      '  }',
      '  .toast-item {',
      '    min-width: 0;',
      '    max-width: none;',
      '    width: 100%;',
      '  }',
      '}'
    ].join('\n');

    document.head.appendChild(style);
  }

  function getContainer() {
    var container = document.getElementById(CONTAINER_ID);
    if (!container) {
      injectStyles();
      container = document.createElement('div');
      container.id = CONTAINER_ID;
      container.setAttribute('role', 'status');
      container.setAttribute('aria-live', 'polite');
      container.setAttribute('aria-relevant', 'additions');
      document.body.appendChild(container);
    }
    return container;
  }

  function removeToast(el) {
    el.classList.remove('toast-visible');
    el.classList.add('toast-exit');
    setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 300);
  }

  function enforceMaxVisible(container) {
    var items = container.querySelectorAll('.toast-item:not(.toast-exit)');
    while (items.length > MAX_VISIBLE) {
      var el = items[0];
      el.classList.add('toast-exit');
      if (el.parentNode) el.parentNode.removeChild(el);
      items = container.querySelectorAll('.toast-item:not(.toast-exit)');
    }
  }

  function showToast(message, type) {
    type = type || 'info';
    if (!BORDER_COLORS[type]) type = 'info';

    var container = getContainer();

    var el = document.createElement('div');
    el.className = 'toast-item';
    el.style.borderLeftColor = BORDER_COLORS[type];
    el.setAttribute('role', 'status');

    var icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.textContent = ICONS[type];
    icon.setAttribute('aria-hidden', 'true');

    var msg = document.createElement('span');
    msg.className = 'toast-message';
    msg.textContent = message;

    el.appendChild(icon);
    el.appendChild(msg);
    container.appendChild(el);

    enforceMaxVisible(container);

    // Trigger slide-in on next frame
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        el.classList.add('toast-visible');
      });
    });

    // Click to dismiss
    el.addEventListener('click', function () {
      clearTimeout(timer);
      removeToast(el);
    });

    // Auto-dismiss
    var timer = setTimeout(function () {
      removeToast(el);
    }, DURATIONS[type]);
  }

  window.showToast = showToast;
})();
