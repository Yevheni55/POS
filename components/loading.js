/**
 * loading.js — Unified loading state manager
 *
 * Usage:
 *   showLoading(containerEl, 'Nacitavam...')  — spinner overlay on element
 *   hideLoading(containerEl)                  — removes overlay
 *   btnLoading(buttonEl)                      — disables button + spinner
 *   btnReset(buttonEl)                        — restores button
 *
 * Spinner CSS reuses .spinner from a11y.css.
 * Overlay uses absolute positioning within the container.
 */
(function () {
  'use strict';

  var OVERLAY_CLASS = 'loading-overlay';
  var BTN_DATA_KEY = 'data-original-html';

  function injectStyles() {
    if (document.getElementById('loading-styles')) return;

    var style = document.createElement('style');
    style.id = 'loading-styles';
    style.textContent = [
      '.' + OVERLAY_CLASS + ' {',
      '  position: absolute;',
      '  inset: 0;',
      '  display: flex;',
      '  flex-direction: column;',
      '  align-items: center;',
      '  justify-content: center;',
      '  gap: var(--space-3, 12px);',
      '  background: rgba(15, 13, 26, 0.75);',
      '  backdrop-filter: blur(4px);',
      '  border-radius: inherit;',
      '  z-index: var(--z-base, 1);',
      '}',
      '',
      '.' + OVERLAY_CLASS + ' .loading-text {',
      '  font-family: var(--font-body, "Bricolage Grotesque", sans-serif);',
      '  font-size: 13px;',
      '  font-weight: 500;',
      '  color: var(--color-text-sec, rgba(220,240,245,.55));',
      '}',
      '',
      '.btn-spinner {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  gap: var(--space-2, 8px);',
      '}'
    ].join('\n');

    document.head.appendChild(style);
  }

  /**
   * Show a loading overlay inside a container element.
   * The container must have position: relative (or absolute/fixed).
   * If it does not, this function sets it to relative.
   */
  function showLoading(containerEl, text) {
    if (!containerEl) return;

    injectStyles();

    // Ensure container can hold absolute overlay
    var pos = getComputedStyle(containerEl).position;
    if (pos === 'static' || pos === '') {
      containerEl.style.position = 'relative';
      containerEl.setAttribute('data-loading-was-static', 'true');
    }

    // Remove existing overlay if present
    hideLoading(containerEl);

    var overlay = document.createElement('div');
    overlay.className = OVERLAY_CLASS;
    overlay.setAttribute('role', 'status');
    overlay.setAttribute('aria-live', 'polite');

    // Spinner (reuses .spinner from a11y.css)
    var spinner = document.createElement('span');
    spinner.className = 'spinner';
    spinner.setAttribute('aria-hidden', 'true');
    overlay.appendChild(spinner);

    if (text) {
      var label = document.createElement('span');
      label.className = 'loading-text';
      label.textContent = text;
      overlay.appendChild(label);
    }

    containerEl.appendChild(overlay);
  }

  /**
   * Remove loading overlay from a container element.
   */
  function hideLoading(containerEl) {
    if (!containerEl) return;

    var overlay = containerEl.querySelector('.' + OVERLAY_CLASS);
    if (overlay) {
      overlay.parentNode.removeChild(overlay);
    }

    // Restore original position if we changed it
    if (containerEl.getAttribute('data-loading-was-static') === 'true') {
      containerEl.style.position = '';
      containerEl.removeAttribute('data-loading-was-static');
    }
  }

  /**
   * Set a button to loading state: disabled + small spinner.
   */
  function btnLoading(buttonEl) {
    if (!buttonEl) return;

    injectStyles();

    // Store original content
    if (!buttonEl.hasAttribute(BTN_DATA_KEY)) {
      buttonEl.setAttribute(BTN_DATA_KEY, buttonEl.innerHTML);
    }

    buttonEl.disabled = true;
    buttonEl.innerHTML =
      '<span class="btn-spinner">' +
        '<span class="spinner" aria-hidden="true"></span>' +
        '<span>\u2026</span>' +
      '</span>';
  }

  /**
   * Restore a button from loading state.
   */
  function btnReset(buttonEl) {
    if (!buttonEl) return;

    var original = buttonEl.getAttribute(BTN_DATA_KEY);
    if (original !== null) {
      buttonEl.innerHTML = original;
      buttonEl.removeAttribute(BTN_DATA_KEY);
    }

    buttonEl.disabled = false;
  }

  /**
   * Render an error state with optional retry button inside a container.
   */
  function renderError(containerEl, message, retryFn) {
    if (!containerEl) return;
    containerEl.innerHTML =
      '<div class="error-state">' +
      '<div class="error-state-icon">&#9888;</div>' +
      '<div class="error-state-title">Chyba</div>' +
      '<div class="error-state-text">' + (message || 'Neocakavana chyba') + '</div>' +
      (retryFn ? '<button class="btn-outline-accent error-retry-btn">Skusit znova</button>' : '') +
      '</div>';
    if (retryFn) {
      var btn = containerEl.querySelector('.error-retry-btn');
      if (btn) btn.addEventListener('click', retryFn);
    }
  }

  window.showLoading = showLoading;
  window.hideLoading = hideLoading;
  window.btnLoading = btnLoading;
  window.btnReset = btnReset;
  window.renderError = renderError;
})();
