import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  VAT_RATES,
  formatSupportedVatRates,
  inferVatRateForMenuItem,
  isSupportedVatRate,
} from '../../lib/menu-vat.js';

describe('menu VAT helpers', () => {
  it('maps known categories to supported VAT rates', () => {
    assert.equal(inferVatRateForMenuItem({ categorySlug: 'jedlo', name: 'Burger' }), VAT_RATES.FOOD_SERVICE);
    assert.equal(inferVatRateForMenuItem({ categorySlug: 'kava', name: 'Espresso' }), VAT_RATES.NON_ALCOHOLIC_BEVERAGE_SERVICE);
    assert.equal(inferVatRateForMenuItem({ categorySlug: 'vino', name: 'Rose' }), VAT_RATES.STANDARD);
  });

  it('detects non-alcoholic beer by name', () => {
    assert.equal(inferVatRateForMenuItem({ categorySlug: 'pivo', name: 'Nealko pivo 0.0' }), VAT_RATES.NON_ALCOHOLIC_BEVERAGE_SERVICE);
    assert.equal(inferVatRateForMenuItem({ categorySlug: 'pivo', name: 'Budvar' }), VAT_RATES.STANDARD);
  });

  it('validates the supported Portos VAT set', () => {
    assert.equal(isSupportedVatRate(5), true);
    assert.equal(isSupportedVatRate(19), true);
    assert.equal(isSupportedVatRate(23), true);
    assert.equal(isSupportedVatRate(20), false);
    assert.equal(formatSupportedVatRates(), '5%, 19%, 23%');
  });
});
