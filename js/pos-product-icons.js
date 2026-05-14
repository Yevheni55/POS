// js/pos-product-icons.js — jednotny SVG icon set pre produkty.
// Mapping: category slug → SVG markup. Fallback je generic "dot" glyph.
// Volane z renderProductCard a renderOrder row.

'use strict';

var _SVG_BY_CATEGORY = {
  // Drinks
  pivo: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8h11v11a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8z"/><path d="M17 11h2a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-2"/><path d="M9 12v4M12 12v4"/></svg>',
  nealko: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4h12l-2 16a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2L6 4z"/><path d="M8 10h8"/></svg>',
  limonady: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 7h12M7 7l1.5 13a2 2 0 0 0 2 2h3a2 2 0 0 0 2-2L17 7"/><path d="M9 11h6M9 15h6"/><path d="M11 3l1 2 1-2"/></svg>',
  smoothies: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 8h8l-1 12a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2L8 8z"/><path d="M10 4h4l-1 4h-2z"/><path d="M14 3v2"/></svg>',
  kava: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10h13v6a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4v-6z"/><path d="M17 12h2a2 2 0 0 1 2 2v1a2 2 0 0 1-2 2h-2"/><path d="M7 7c0-1 1-1 1-2s-1-1-1-2M11 7c0-1 1-1 1-2s-1-1-1-2"/></svg>',
  alkohol: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3h8v4l-2 6v6h-4v-6L8 7z"/><path d="M9 13h6"/></svg>',

  // Food
  jedlo: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 11h18a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3z"/><path d="M3 11c0-4 4-7 9-7s9 3 9 7"/><path d="M7 8h0M11 7h0M15 8h0"/><path d="M2 17h20"/></svg>',
  burger: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 11h18a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3z"/><path d="M3 11c0-4 4-7 9-7s9 3 9 7"/><path d="M2 17h20"/></svg>',
  doplnky: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v18M3 12h18"/><circle cx="12" cy="12" r="9"/></svg>',
};

// Fallback heuristic: ak nevieme presnu kategoriu, pozri na meno produktu.
function _guessCategorySlug(productName, categorySlug) {
  if (categorySlug && _SVG_BY_CATEGORY[categorySlug]) return categorySlug;
  var s = String(productName || '').toLowerCase();
  if (/pivo|urpin|tatran|čapovan|capovan/.test(s)) return 'pivo';
  if (/kofol|kola|cola|sprit|tonik|tonic|fanta|pepsi/.test(s)) return 'nealko';
  if (/limonad|limo|citrus|home.?made/.test(s)) return 'limonady';
  if (/smoothie|shake|fresh|džús|dzus/.test(s)) return 'smoothies';
  if (/kafe|kava|kava|espreso|cappuc|lat[eé]/.test(s)) return 'kava';
  if (/burger|hot.?dog|wrap|sendvič|sendvic|panini/.test(s)) return 'burger';
  if (/whisk|rum|vodka|gin|tequil|brandy|liker|bork/.test(s)) return 'alkohol';
  if (/omáč|omac|hranolk|chips|prílo|prilo|extra/.test(s)) return 'doplnky';
  return null;
}

window.productIconSVG = function (productName, categorySlug) {
  var slug = _guessCategorySlug(productName, categorySlug);
  if (slug && _SVG_BY_CATEGORY[slug]) return _SVG_BY_CATEGORY[slug];
  // Fallback: small dot glyph so layout doesn't break for unknown items.
  return '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/></svg>';
};
