/**
 * 0 je povolená sadzba pre neplatiteľa DPH (firma bez IČ DPH) — Portos vtedy prijíma
 * iba položky s `vatRate: 0`, inak vráti validation_error.
 */
export const SUPPORTED_VAT_RATES = Object.freeze([0, 5, 19, 23]);

export const VAT_RATES = Object.freeze({
  FOOD_SERVICE: 5,
  NON_ALCOHOLIC_BEVERAGE_SERVICE: 19,
  STANDARD: 23,
});

function normalizeText(value = '') {
  return String(value).trim().toLocaleLowerCase('sk-SK');
}

export function isSupportedVatRate(value) {
  const normalized = Math.round(Number.parseFloat(value) * 100) / 100;
  return Number.isFinite(normalized) && SUPPORTED_VAT_RATES.includes(normalized);
}

export function formatSupportedVatRates() {
  return SUPPORTED_VAT_RATES.map((rate) => `${rate}%`).join(', ');
}

export function inferVatRateForCategorySlug(categorySlug) {
  switch (normalizeText(categorySlug)) {
    case 'jedlo':
      return VAT_RATES.FOOD_SERVICE;
    case 'kava':
    case 'caj':
    case 'nealko':
      return VAT_RATES.NON_ALCOHOLIC_BEVERAGE_SERVICE;
    case 'koktaily':
    case 'vino':
    case 'sekt':
    case 'destilaty':
      return VAT_RATES.STANDARD;
    case 'pivo':
      return VAT_RATES.STANDARD;
    default:
      return null;
  }
}

/**
 * Poradie zdrojov sadzby (od najkonkrétnejšieho):
 *   1) nealko pivo v kategórii `pivo` — položková výnimka, je konkrétnejšia než celá kategória
 *   2) `categoryDefaultVatRate` — explicitná voľba manažéra (menu_categories.default_vat_rate)
 *   3) hardcoded mapa slugov (historické kategórie zo seedu)
 * Pri neznámej kategórii BEZ defaultu vracia `null` — NIKDY tichý fallback na 23 %.
 * Volajúci musí sadzbu vypýtať od používateľa, nie ju uhádnuť.
 */
export function inferVatRateForMenuItem({ categorySlug, name = '', categoryDefaultVatRate = null }) {
  const slug = normalizeText(categorySlug);
  const normalizedName = normalizeText(name);

  if (slug === 'pivo' && /nealko|nealkohol|0[,.]0|alkohol\s*free/.test(normalizedName)) {
    return VAT_RATES.NON_ALCOHOLIC_BEVERAGE_SERVICE;
  }

  const explicit = Number.parseFloat(categoryDefaultVatRate);
  if (Number.isFinite(explicit)) return Math.round(explicit * 100) / 100;

  return inferVatRateForCategorySlug(slug);
}

/**
 * Sadzba 0 % je legálna IBA pre neplatiteľa DPH — Portos vtedy prijíma výlučne `vatRate: 0`.
 * Platiteľ DPH ju nesmie použiť (0 % v SR pre reštauračné služby neexistuje).
 */
export function isZeroVatAllowed(vatRegistered) {
  return !vatRegistered;
}

/**
 * Zdieľaný guard pôvodne v server/lib/payments/create.js:94-111. Hláška aj tvar odpovede
 * ostávajú BITOVO rovnaké, aby sa správanie existujúcich volajúcich nezmenilo.
 *
 * @param {Array<{ name?: string, vatRate?: unknown }>} items
 * @throws {Error & { status: 400, code: 'UNSUPPORTED_VAT_RATE', body: { error: string, fiscal: { status: 'validation_error', errorDetail: string } } }}
 */
export function assertSupportedVatRates(items) {
  const unsupportedVatItems = (Array.isArray(items) ? items : [])
    .filter((item) => !isSupportedVatRate(item?.vatRate));
  if (!unsupportedVatItems.length) return;

  const itemList = unsupportedVatItems
    .map((item) => `${item.name} (${Number(item.vatRate).toFixed(2)}%)`)
    .join(', ');
  const errorDetail = `Portos podporuje iba sadzby DPH ${formatSupportedVatRates()}. Skontroluj polozky: ${itemList}`;

  const error = new Error(errorDetail);
  error.status = 400;
  error.code = 'UNSUPPORTED_VAT_RATE';
  error.body = {
    error: errorDetail,
    fiscal: {
      status: 'validation_error',
      errorDetail,
    },
  };
  throw error;
}
