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
  zmrzlina: '🍦',      // zmrzlina — CELÁ kategória (8 položiek) padala na tanier
};

// Ten istý mapping, ale kľúčovaný NÁZVOM kategórie.
// Prečo: slug sa dá v admine zmeniť a pri kategórii vytvorenej cez UI je
// automatický — na kase má „Čapované" (14 položiek, najsilnejšia barová
// kategória) slug `cat_1776806631615`, takže sa v mape podľa slugu netrafí.
// Kľúče sú názvy bez diakritiky a malými písmenami.
var _EMOJI_BY_LABEL = {
  capovane: '🍺',
  cisla: '🍹',
  nealko: '🧃',
  limonady: '🍋',
  smoothies: '🥤',
  'kava a caj': '☕',
  kava: '☕',
  caj: '🍵',
  alko: '🥃',
  drinky: '🍸',
  koktaily: '🍸',
  burgre: '🍔',
  croissanty: '🥐',
  prilohy: '🍟',
  'extra prilohy': '🥫',
  salaty: '🥗',
  pochutiny: '🍿',
  zmrzlina: '🍦',
  jedlo: '🍽️',
  vino: '🍷',
  pivo: '🍺',
};

function _normalizeLabel(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')  // odstráň diakritiku
    .toLowerCase().trim().replace(/\s+/g, ' ');
}

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
  if (/zmrzlin|nanuk|cornetto|magnum|calippo|nogger|twister|míša|misa\b/.test(s)) return 'zmrzlina';
  if (/prosecco|sekt|šampan|sampan|víno|vino\b/.test(s)) return 'vino';
  if (/sóda|soda|minerál|mineral|voda\b/.test(s)) return 'nealko';
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
  return null;
}

// Emoji podľa NÁZVU kategórie — hrubá poistka pre kategórie, ktorých slug nie
// je v mape (typicky vytvorené cez admin, kde je slug automatický).
function _emojiFromCategoryLabel(productName, categorySlug) {
  if (typeof MENU === 'undefined' || !MENU) return null;
  var slug = categorySlug;
  if ((!slug || !MENU[slug]) && typeof getItemCat === 'function') slug = getItemCat(productName);
  var entry = slug && MENU[slug];
  if (!entry || !entry.label) return null;
  return _EMOJI_BY_LABEL[_normalizeLabel(entry.label)] || null;
}

window.productIconSVG = function (productName, categorySlug) {
  // 1) presný slug kategórie
  var slug = _resolveCategory(productName, categorySlug);
  if (slug && _EMOJI_BY_CATEGORY[slug]) return _EMOJI_BY_CATEGORY[slug];

  // 2) heuristika podľa NÁZVU POLOŽKY — konkrétnejšia než kategória.
  //    Musí ísť pred názvom kategórie: v „Čapované" je aj Kofola a Prosecco,
  //    ktoré si zaslúžia vlastnú ikonu, nie pivový korbeľ.
  var guessed = _guessCategoryFromName(productName);
  if (guessed && _EMOJI_BY_CATEGORY[guessed]) return _EMOJI_BY_CATEGORY[guessed];
  if (guessed && _EMOJI_BY_LABEL[guessed]) return _EMOJI_BY_LABEL[guessed];

  // 3) názov kategórie (rieši automatické slugy)
  var byLabel = _emojiFromCategoryLabel(productName, categorySlug);
  if (byLabel) return byLabel;

  // 4) neutrálny tanier, nech layout nezostane prázdny
  return '🍽️';
};
