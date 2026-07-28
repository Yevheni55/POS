// js/pos-product-icons.js — farebne emoji ikony per kategoria.
// Mapping: kategoria (REALNY slug z CAT_COLORS / MENU) → emoji.
// Fallback je neutralny tanier glyph.
// Volane z renderProductCard, renderOrder row aj mobile render.
// Nazov funkcie (productIconSVG) ostava kvoli existujucim volaniam.

'use strict';

// Kluce = REALNE slugy kategorii tak ako ich vracia server a pouziva CAT_COLORS
// (pos-state.js). Jedno emoji na kategoriu → konzistentne, farebne, zive.
var _EMOJI_BY_CATEGORY = {
  // --- Drinks ---
  capovane: '🍺',   // čapované pivo
  cisla: '🍹',      // číslované drinky
  nealko: '🧃',     // nealko
  limonady: '🍋',   // limonády
  smoothies: '🥤',  // smoothies
  'kava-caj': '☕',  // káva & čaj
  alko: '🥃',       // destiláty
  drinky: '🍸',     // koktaily
  // --- Food ---
  burgre: '🍔',        // burgre
  croissanty: '🥐',    // croissanty
  prilohy: '🍟',       // prílohy
  'extra-prilohy': '🥫', // extra prílohy / omáčky
  salaty: '🥗',        // šaláty
  pochutiny: '🍿',     // pochutiny
};

// Fallback heuristika podla mena produktu — pouzije sa iba ked kategoriu
// nevieme urcit (napr. MENU este nie je nacitane). Mapuje na REALNE slugy.
function _guessCategoryFromName(productName) {
  var s = String(productName || '').toLowerCase();
  if (/pivo|urpin|tatran|čapovan|capovan/.test(s)) return 'capovane';
  if (/kofol|kola|cola|tonik|tonic|fanta|pepsi|sprit/.test(s)) return 'nealko';
  if (/limonad|limo|citrus|home.?made/.test(s)) return 'limonady';
  if (/smoothie|shake|fresh|džús|dzus/.test(s)) return 'smoothies';
  if (/kafe|kava|káva|espreso|cappuc|lat[eé]|čaj|caj\b/.test(s)) return 'kava-caj';
  if (/burger|hot.?dog|wrap|sendvič|sendvic|panini/.test(s)) return 'burgre';
  if (/croissant|kroasan/.test(s)) return 'croissanty';
  if (/šalát|salat|salad/.test(s)) return 'salaty';
  if (/whisk|rum|vodka|gin|tequil|brandy|liker|bork/.test(s)) return 'alko';
  if (/mojito|aperol|spritz|koktail|cocktail|drink/.test(s)) return 'drinky';
  if (/hranolk|prílo|prilo/.test(s)) return 'prilohy';
  if (/omáč|omac|dip|extra/.test(s)) return 'extra-prilohy';
  if (/chips|nacho|popcorn|orech|slan/.test(s)) return 'pochutiny';
  return null;
}

// Urci realny slug kategorie: 1) ak dostaneme platny slug, pouzijeme ho;
// 2) inak sa spytame MENU cez getItemCat(name); 3) inak heuristika podla mena.
function _resolveCategory(productName, categorySlug) {
  if (categorySlug && _EMOJI_BY_CATEGORY[categorySlug]) return categorySlug;
  if (typeof getItemCat === 'function') {
    var cat = getItemCat(productName);
    if (cat && _EMOJI_BY_CATEGORY[cat]) return cat;
  }
  return _guessCategoryFromName(productName);
}

window.productIconSVG = function (productName, categorySlug) {
  var slug = _resolveCategory(productName, categorySlug);
  if (slug && _EMOJI_BY_CATEGORY[slug]) return _EMOJI_BY_CATEGORY[slug];
  // Fallback: neutralny tanier tak layout nezostane prazdny pri neznamej polozke.
  return '🍽️';
};
