// Lístok „DO TAŠKY" na bar: všetky položky (aj mimo kasy), platba, bez znakov mimo CP437.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPackingTicket } from '../../lib/print/tickets.js';
import { packingTicketData } from '../../lib/online-order-fire.js';

const strip = (t) => t.replace(/[\x00-\x1f]/g, '');

describe('lístok DO TAŠKY', () => {
  it('Wolt: zaplatené cez Wolt, položka mimo kasy s hviezdičkou, vyzdvihnutie', () => {
    const d = packingTicketData({
      publicCode: 'W-1234', source: 'wolt', customerName: 'Zuzana Šťastná', customerPhone: '+421 900 000 000', total: '18.80',
      paymentMethod: 'wolt', deliveryType: 'takeaway', note: 'bez ľadu',
      items: [{ menuItemId: 5, name: 'Čaj', qty: 2, note: '' }, { menuItemId: null, name: 'Wolt bonus dezert', qty: 1 }],
    });
    assert.equal(d.items[1].outside, true);
    const t = buildPackingTicket({ ...d, time: '12:34', staffName: 'Peter', copy: false });
    const plain = strip(t);
    assert.match(plain, /DO TASKY/);
    assert.match(plain, /WOLT W-1234/);
    assert.match(plain, /Zuzana Stastna/);
    assert.match(plain, /\[ \] 2x Caj/);
    assert.match(plain, /\[ \] 1x Wolt bonus dezert \*/);
    assert.match(plain, /mimo kasy/);
    assert.match(plain, /Zakaznik si vyzdvihne/);
    assert.match(plain, /ZAPLATENE CEZ WOLT/);
    assert.match(plain, /SPOLU\s+18,80 EUR/);
    assert.match(plain, /Poznamka: bez ladu/);
    assert.ok(![...t].some((c) => c.charCodeAt(0) > 255), 'iba znaky do 255 (tlačiareň CP437)');
  });

  it('web s hotovosťou: suma pre kuriéra, adresa a čas doručenia, kópia označená', () => {
    const d = packingTicketData({
      publicCode: 'SS-ABCDE', source: 'web', customerName: 'Jana', customerPhone: '', total: 14.7, paymentMethod: 'cash',
      dropoffStreet: 'Tematínska 5', dropoffCity: 'Bratislava', scheduledFor: new Date('2026-09-14T16:00:00Z'), items: [{ menuItemId: 1, name: 'Burger', qty: 1 }],
    });
    const plain = strip(buildPackingTicket({ ...d, time: '17:00', staffName: 'Online', copy: true }));
    assert.match(plain, /KOPIA: ROZVOZ SS-ABCDE/);
    assert.match(plain, /HOTOVOST KURIEROVI: 14,70 EUR/);
    assert.match(plain, /Dorucit: /);
    assert.match(plain, /Tematinska 5, Bratislava/);
  });
});
