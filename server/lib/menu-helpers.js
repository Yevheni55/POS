// Helpers for menu-item name pattern checks shared between routes.
//
// Pravidlo "ktoré položky majú side-sauce v cene" žije tu, aby sa
// frontend (js/pos-orders.js → _needsSaucePicker) a backend
// (consolidate-duplicates skip + kitchen ticket inline sauce) nikdy
// neoddialili. Ak treba pridať ďalšie chicken-style položky so
// zahrnutou omáčkou, doplň regex.

/**
 * Vracia true ak menu item potrebuje sauce-picker pri pridaní do
 * objednávky a annotation row "Omáčka (combo)" sa s ním páruje 1:1.
 *
 * Combos: omáčka v recepte + na bone musí byť videná samostatne.
 * Kuracie hranolky: rovnaký princíp — omáčka je v cene, kuchár musí
 * vidieť presnú voľbu zákazníka.
 *
 * @param {string|null|undefined} name
 * @returns {boolean}
 */
export function needsSaucePicker(name) {
  if (!name) return false;
  if (/^combo\s/i.test(name)) return true;
  if (/kuracie\s+hranolky/i.test(name)) return true;
  return false;
}

/**
 * Annotation row name. Generic placeholder ktorý sa pridá za primary
 * položku s vybranou omáčkou v `note`. 0 EUR cena, žiadny recept →
 * žiadna double-deduction surovín.
 */
export const SAUCE_ANNOTATION_NAME = 'Omáčka (combo)';

/**
 * Return true ak je to placeholder annotation row (nie primary item).
 */
export function isSauceAnnotationRow(name) {
  return name === SAUCE_ANNOTATION_NAME;
}
