// admin/components/toast-undo.js
//
// Gmail-style undoable toast pattern. Namiesto otravného confirm modálu pred
// kazdym mazaním: jeden klik → položka mizne z UI (optimistic) → toast
// "Zmazané · Vrátiť späť" s 5s countdown. Ak používateľ klikne Späť → mazanie
// sa zruší. Ak countdown vyprší → mazanie sa vykoná.
//
// Usage A — high-level helper (recommended):
//   import { softDelete } from '../components/toast-undo.js';
//   async function deleteItem(id, label) {
//     const idx = items.findIndex(i => i.id === id);
//     const snapshot = items[idx];
//     items.splice(idx, 1);
//     render();
//     const result = await softDelete({
//       label: label + ' zmazané',
//       deleteFn: () => api.del('/x/' + id),
//     });
//     if (result.undone) {
//       items.splice(idx, 0, snapshot);
//       render();
//     }
//   }
//
// Usage B — low-level (custom undo logic):
//   showUndoableToast('5 zaznamov skrytych', () => restoreAll(), { duration: 8000 });

const DEFAULT_DURATION = 5000;
let _activeToast = null;
let _activeTimer = null;
let _activeCountdownTimer = null;

/**
 * High-level "deferred delete" helper.
 *
 * @param {object} opts
 * @param {string} opts.label - Toast message (e.g. "Pivo Šariš zmazané")
 * @param {Function} opts.deleteFn - Async function to call after timeout if not undone
 * @param {number} [opts.duration] - Milliseconds before delete fires (default 5000)
 * @returns {Promise<{undone: boolean, error?: Error}>}
 */
export function softDelete(opts) {
  return new Promise(function (resolve) {
    let undone = false;
    const duration = opts.duration || DEFAULT_DURATION;

    const finalize = async function () {
      if (undone) return;
      try {
        await opts.deleteFn();
        resolve({ undone: false });
      } catch (err) {
        // Show error toast — caller is expected to restore UI manually if needed
        if (typeof window.showToast === 'function') {
          window.showToast('Chyba pri mazaní: ' + (err.message || 'neznáma'), 'error');
        }
        resolve({ undone: false, error: err });
      }
    };

    _showUndoableToast({
      message: opts.label,
      duration: duration,
      onUndo: function () {
        undone = true;
        resolve({ undone: true });
      },
      onTimeout: finalize,
    });
  });
}

/**
 * Low-level: show an undoable toast. Caller is responsible for undo + timeout
 * behavior. Use this when you've ALREADY removed item from UI optimistically
 * and want a generic "Vrátiť späť" hook.
 *
 * @param {string} message - Toast text
 * @param {Function} onUndo - Called if user clicks "Späť" within duration
 * @param {object} [opts]
 * @param {number} [opts.duration] - Milliseconds before toast disappears (default 5000)
 * @param {Function} [opts.onTimeout] - Called if no undo within duration
 */
export function showUndoableToast(message, onUndo, opts) {
  _showUndoableToast({
    message: message,
    duration: (opts && opts.duration) || DEFAULT_DURATION,
    onUndo: onUndo,
    onTimeout: opts && opts.onTimeout,
  });
}

function _showUndoableToast(cfg) {
  // If there's already an active undoable toast, finalize it (commit) first
  // so we don't have two stacking.
  if (_activeToast) {
    if (_activeTimer) clearTimeout(_activeTimer);
    if (_activeCountdownTimer) clearInterval(_activeCountdownTimer);
    const old = _activeToast;
    const oldFinalize = old._onTimeout;
    _activeToast = null;
    _activeTimer = null;
    _activeCountdownTimer = null;
    if (old.parentNode) old.parentNode.removeChild(old);
    if (typeof oldFinalize === 'function') oldFinalize();
  }

  const toast = document.createElement('div');
  toast.className = 'toast-undo';
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  toast.innerHTML = ''
    + '<span class="toast-undo-icon" aria-hidden="true">'
    +   '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
    +     '<polyline points="3 6 5 6 21 6"></polyline>'
    +     '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>'
    +   '</svg>'
    + '</span>'
    + '<span class="toast-undo-msg"></span>'
    + '<button type="button" class="toast-undo-btn">Vrátiť späť</button>'
    + '<span class="toast-undo-countdown" aria-hidden="true"></span>';

  const msgEl = toast.querySelector('.toast-undo-msg');
  const btnEl = toast.querySelector('.toast-undo-btn');
  const countdownEl = toast.querySelector('.toast-undo-countdown');
  msgEl.textContent = String(cfg.message || '');

  toast._onTimeout = cfg.onTimeout;

  document.body.appendChild(toast);
  _activeToast = toast;

  // Trigger entrance animation on next frame
  requestAnimationFrame(function () {
    toast.classList.add('show');
  });

  // Countdown indicator (visual progress bar via width animation)
  const startedAt = Date.now();
  function updateCountdown() {
    const elapsed = Date.now() - startedAt;
    const remaining = Math.max(0, cfg.duration - elapsed);
    const pct = (remaining / cfg.duration) * 100;
    countdownEl.style.width = pct.toFixed(1) + '%';
    if (remaining <= 0) {
      clearInterval(_activeCountdownTimer);
      _activeCountdownTimer = null;
    }
  }
  updateCountdown();
  _activeCountdownTimer = setInterval(updateCountdown, 100);

  function finalize(undone) {
    if (_activeTimer) { clearTimeout(_activeTimer); _activeTimer = null; }
    if (_activeCountdownTimer) { clearInterval(_activeCountdownTimer); _activeCountdownTimer = null; }
    btnEl.removeEventListener('click', onUndoClick);

    toast.classList.remove('show');
    setTimeout(function () {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
      if (_activeToast === toast) _activeToast = null;
    }, 300);

    if (undone) {
      if (typeof cfg.onUndo === 'function') cfg.onUndo();
    } else {
      if (typeof cfg.onTimeout === 'function') cfg.onTimeout();
    }
  }

  function onUndoClick() {
    finalize(true);
  }
  btnEl.addEventListener('click', onUndoClick);

  // Schedule auto-commit
  _activeTimer = setTimeout(function () { finalize(false); }, cfg.duration);
}
