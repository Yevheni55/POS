import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { explainPortosPrintCopyFailure } from '../../lib/portos.js';

describe('explainPortosPrintCopyFailure', () => {
  it('detects Slovak certificate alias message', () => {
    const hint = explainPortosPrintCopyFailure({
      detail: 'Certifikát s takým aliasom nebol nájdený.',
    });
    assert.ok(hint);
    assert.match(hint, /PORTOS_CASH_REGISTER_CODE/i);
  });
});
