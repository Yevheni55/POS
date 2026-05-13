// admin/components/empty-state.js
//
// Reusable empty-state helper s optional CTA buttonom.
//
// Predtym kazdy admin page module mal vlastny inline HTML pre empty state:
//   container.innerHTML = '<div class="empty-state">...</div>'
// Bez CTA = dead-end pre uzivatela. Teraz: jednotny helper s actionable CTA.
//
// Usage:
//   import { mountEmptyState } from '../components/empty-state.js';
//   mountEmptyState(tableWrap, {
//     icon: '📦',
//     title: 'Žiadne suroviny',
//     text: 'Pridajte prvú surovinu kliknutím na tlačidlo nižšie.',
//     ctaLabel: '＋ Pridať surovinu',
//     onCta: () => openAddIngredientModal(),
//   });

/**
 * Mounts empty-state markup into a container. Optionally wires a CTA button.
 *
 * @param {HTMLElement} container
 * @param {object} opts
 * @param {string} [opts.icon] - Emoji or HTML entity (e.g. '📦' or '&#128203;')
 * @param {string} opts.title - Bold headline
 * @param {string} opts.text - Sub-text describing why empty + what to do
 * @param {string} [opts.ctaLabel] - Action button label, e.g. '＋ Pridať surovinu'
 * @param {Function} [opts.onCta] - Click handler for CTA button
 * @param {string} [opts.variant] - 'default' (cream card) or 'inline' (no card, smaller)
 * @returns {void}
 */
export function mountEmptyState(container, opts) {
  if (!container) return;
  const o = opts || {};
  const icon = o.icon || '';
  const title = escText(o.title || 'Žiadne dáta');
  const text = escText(o.text || '');
  const ctaLabel = o.ctaLabel ? escText(o.ctaLabel) : '';
  const variant = o.variant === 'inline' ? ' empty-state--inline' : '';

  let html = '<div class="empty-state' + variant + '">';
  if (icon) html += '<div class="empty-state-icon">' + icon + '</div>';
  html += '<div class="empty-state-title">' + title + '</div>';
  if (text) html += '<div class="empty-state-text">' + text + '</div>';
  if (ctaLabel) {
    html += '<button type="button" class="empty-state-cta">'
      + '<span aria-hidden="true">＋</span>'
      + '<span>' + ctaLabel.replace(/^＋\s*/, '') + '</span>'
      + '</button>';
  }
  html += '</div>';

  container.innerHTML = html;

  if (ctaLabel && typeof o.onCta === 'function') {
    const btn = container.querySelector('.empty-state-cta');
    if (btn) btn.addEventListener('click', o.onCta);
  }
}

/**
 * Returns empty-state HTML string (for embedding in larger templates).
 * Note: when using this form, the CTA button won't have a wired click handler —
 * use mountEmptyState if you need that.
 */
export function emptyStateHTML(opts) {
  const o = opts || {};
  const icon = o.icon || '';
  const title = escText(o.title || 'Žiadne dáta');
  const text = escText(o.text || '');
  const ctaLabel = o.ctaLabel ? escText(o.ctaLabel) : '';
  const variant = o.variant === 'inline' ? ' empty-state--inline' : '';

  let html = '<div class="empty-state' + variant + '">';
  if (icon) html += '<div class="empty-state-icon">' + icon + '</div>';
  html += '<div class="empty-state-title">' + title + '</div>';
  if (text) html += '<div class="empty-state-text">' + text + '</div>';
  if (ctaLabel) {
    html += '<button type="button" class="empty-state-cta" data-cta>'
      + '<span aria-hidden="true">＋</span>'
      + '<span>' + ctaLabel.replace(/^＋\s*/, '') + '</span>'
      + '</button>';
  }
  html += '</div>';
  return html;
}

function escText(s) {
  const d = document.createElement('div');
  d.textContent = String(s == null ? '' : s);
  return d.innerHTML;
}
