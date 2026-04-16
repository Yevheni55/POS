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
      return VAT_RATES.NON_ALCOHOLIC_BEVERAGE_SERVICE;
    case 'koktaily':
    case 'vino':
      return VAT_RATES.STANDARD;
    case 'pivo':
      return VAT_RATES.STANDARD;
    default:
      return null;
  }
}

export function inferVatRateForMenuItem({ categorySlug, name = '' }) {
  const slug = normalizeText(categorySlug);
  const normalizedName = normalizeText(name);

  if (slug === 'pivo' && /nealko|nealkohol|0[,.]0|alkohol\s*free/.test(normalizedName)) {
    return VAT_RATES.NON_ALCOHOLIC_BEVERAGE_SERVICE;
  }

  return inferVatRateForCategorySlug(slug);
}
