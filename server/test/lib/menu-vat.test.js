import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  VAT_RATES,
  assertSupportedVatRates,
  formatSupportedVatRates,
  inferVatRateForCategorySlug,
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
    // 0 % je platná sadzba pre neplatiteľa DPH (firma bez IČ DPH) — pridané
    // v 0eb891e "Force 0% VAT on Portos receipts when company is not
    // VAT-registered". Portos vtedy prijme len položky s vatRate 0.
    assert.equal(isSupportedVatRate(0), true);
    assert.equal(isSupportedVatRate(5), true);
    assert.equal(isSupportedVatRate(19), true);
    assert.equal(isSupportedVatRate(23), true);
    assert.equal(isSupportedVatRate(20), false);
    assert.equal(formatSupportedVatRates(), '0%, 5%, 19%, 23%');
  });
});

// ---------------------------------------------------------------------------
// [13] Kategórie zo seed skriptu (`nealko`, `sekt`, `destilaty`) chýbali v DPH
//      inferencii → padali na tichý fallback 23 %. Nealko nápoje podávané
//      v reštauračnej službe majú 19 %, nie 23 %.
//      Kľúč Finančnej správy: 5 % podávanie jedál | 19 % podávanie nealko
//      nápojov | 23 % alkohol a balený tovar | 0 % záloha za obal.
// ---------------------------------------------------------------------------

describe('[13] inferencia DPH podľa kategórie', () => {
  it('pozná kategórie, ktoré zakladá scripts/seed-urpiner-drinks.mjs', () => {
    assert.equal(inferVatRateForCategorySlug('nealko'), VAT_RATES.NON_ALCOHOLIC_BEVERAGE_SERVICE);
    assert.equal(inferVatRateForCategorySlug('sekt'), VAT_RATES.STANDARD);
    assert.equal(inferVatRateForCategorySlug('destilaty'), VAT_RATES.STANDARD);

    // Scenár z auditu: manažér pridá „Vinea 0,3 l" do existujúcej kategórie
    // Nealko — musí dostať 19 %, nie 23 % ako predtým.
    assert.equal(inferVatRateForMenuItem({ categorySlug: 'nealko', name: 'Vinea 0,3 l' }), 19);
    assert.equal(inferVatRateForMenuItem({ categorySlug: 'sekt', name: 'Prosecco' }), 23);
    assert.equal(inferVatRateForMenuItem({ categorySlug: 'destilaty', name: 'Tatratea 52 %' }), 23);
  });

  it('celá mapa kategórií sedí na sadzby Finančnej správy', () => {
    assert.deepEqual(
      Object.fromEntries(
        ['jedlo', 'kava', 'caj', 'nealko', 'pivo', 'vino', 'sekt', 'destilaty', 'koktaily']
          .map((slug) => [slug, inferVatRateForCategorySlug(slug)]),
      ),
      { jedlo: 5, kava: 19, caj: 19, nealko: 19, pivo: 23, vino: 23, sekt: 23, destilaty: 23, koktaily: 23 },
    );
  });

  it('neznáma kategória vracia null — NIKDY tichých 23 %', () => {
    // Slug `cat_<timestamp>` vyrába admin UI pri každej novej kategórii,
    // takže hardcoded mapa ho z princípu nikdy nepokryje.
    for (const slug of ['limonady', 'cat_1751328000000', 'zmrzlina', 'nezname', '', null, undefined]) {
      assert.equal(
        inferVatRateForCategorySlug(slug),
        null,
        `slug ${JSON.stringify(slug)} musí vrátiť null, nie uhádnutú sadzbu`,
      );
      assert.equal(
        inferVatRateForMenuItem({ categorySlug: slug, name: 'Nová položka' }),
        null,
        `slug ${JSON.stringify(slug)} musí vrátiť null, nie uhádnutú sadzbu`,
      );
    }
  });

  it('categoryDefaultVatRate má prednosť pred hardcoded mapou', () => {
    // Explicitná voľba manažéra (menu_categories.default_vat_rate) je
    // konkrétnejšia než mapa slugov zo seedu.
    assert.equal(inferVatRateForMenuItem({ categorySlug: 'jedlo', name: 'Burger', categoryDefaultVatRate: 23 }), 23);
    assert.equal(inferVatRateForMenuItem({ categorySlug: 'destilaty', name: 'Nealko shot', categoryDefaultVatRate: 5 }), 5);
    assert.equal(inferVatRateForMenuItem({ categorySlug: 'kava', name: 'Espresso', categoryDefaultVatRate: 23 }), 23);

    // Drizzle numeric vracia string — '19.00' musí prejsť rovnako ako 19.
    assert.equal(inferVatRateForMenuItem({ categorySlug: 'vino', name: 'Rosé', categoryDefaultVatRate: '19.00' }), 19);

    // Pri slugu, ktorý mapa nepozná, je default jediný zdroj sadzby.
    assert.equal(inferVatRateForMenuItem({ categorySlug: 'cat_1751328000000', name: 'Limonáda', categoryDefaultVatRate: '5.00' }), 5);

    // 0 % (záloha za obal / neplatiteľ) je platná EXPLICITNÁ voľba, nie „prázdno".
    assert.equal(inferVatRateForMenuItem({ categorySlug: 'jedlo', name: 'Záloha za obal', categoryDefaultVatRate: 0 }), 0);

    // Bez použiteľného defaultu padáme späť na mapu, resp. na null — nie na 23.
    for (const empty of [null, undefined, '', 'nezmysel', NaN]) {
      assert.equal(inferVatRateForMenuItem({ categorySlug: 'jedlo', name: 'Burger', categoryDefaultVatRate: empty }), 5);
      assert.equal(inferVatRateForMenuItem({ categorySlug: 'nezname', name: 'Nieco', categoryDefaultVatRate: empty }), null);
    }
  });

  it('položková výnimka „nealko pivo" prebíja aj default kategórie', () => {
    assert.equal(
      inferVatRateForMenuItem({ categorySlug: 'pivo', name: 'Birell nealko', categoryDefaultVatRate: 23 }),
      VAT_RATES.NON_ALCOHOLIC_BEVERAGE_SERVICE,
    );
    assert.equal(
      inferVatRateForMenuItem({ categorySlug: 'pivo', name: 'Šariš 12', categoryDefaultVatRate: 23 }),
      VAT_RATES.STANDARD,
    );
  });

  it('admin/pages/menu.js CATEGORY_VAT_DEFAULTS ostáva zrkadlom servera', () => {
    // Audit [13] bod 2: web admin, server a Android musia dávať tú istú sadzbu,
    // inak manažér vidí v UI iné číslo, než sa uloží / zafiškalizuje.
    const source = readFileSync(new URL('../../../admin/pages/menu.js', import.meta.url), 'utf8');
    const block = source.match(/const CATEGORY_VAT_DEFAULTS = Object\.freeze\(\{([\s\S]*?)\}\);/);
    assert.ok(block, 'CATEGORY_VAT_DEFAULTS sa v admin/pages/menu.js nenašiel');

    const entries = [...block[1].matchAll(/(\w+)\s*:\s*(\d+(?:\.\d+)?)/g)]
      .map(([, slug, rate]) => [slug, Number(rate)]);
    assert.ok(entries.length >= 9, `očakávam aspoň 9 kategórií, našiel som ${entries.length}`);

    for (const [slug, rate] of entries) {
      assert.equal(
        inferVatRateForCategorySlug(slug),
        rate,
        `slug '${slug}': admin UI predvyplní ${rate} %, server odvodí ${inferVatRateForCategorySlug(slug)} %`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// [25] DB default vat_rate bol 20,00 — sadzba, ktorá na Slovensku od 2025
//      neexistuje a Portos ju odmietne. Guard musí padnúť 400 a POMENOVAŤ
//      položku, aby manažér vedel, čo ide opraviť v menu.
// ---------------------------------------------------------------------------

describe('[25] assertSupportedVatRates', () => {
  it('sadzba 20,00 % → 400 s názvom položky v hláške', () => {
    const items = [
      { name: 'Kofola 0,3 l', vatRate: 19 },
      { name: 'Limonáda domáca', vatRate: 20 },
    ];

    assert.throws(
      () => assertSupportedVatRates(items),
      (err) => {
        assert.equal(err.status, 400);
        assert.equal(err.code, 'UNSUPPORTED_VAT_RATE');
        assert.match(err.message, /Limonáda domáca \(20\.00%\)/);
        assert.match(err.message, /Portos podporuje iba sadzby DPH 0%, 5%, 19%, 23%/);
        // Správne položky sa v hláške nesmú objaviť — inak manažér nevie, čo hľadať.
        assert.equal(err.message.includes('Kofola'), false);
        // Tvar odpovede, na ktorý sa spoliehajú create.js / change-method.js / refiscalize.js.
        assert.equal(err.body.error, err.message);
        assert.equal(err.body.fiscal.status, 'validation_error');
        assert.equal(err.body.fiscal.errorDetail, err.message);
        return true;
      },
    );
  });

  it('vymenuje VŠETKY chybné položky naraz', () => {
    assert.throws(
      () => assertSupportedVatRates([
        { name: 'Limonáda', vatRate: 20 },
        { name: 'Burger', vatRate: 5 },
        { name: 'Zákusok', vatRate: 10 },
      ]),
      /Limonáda \(20\.00%\), Zákusok \(10\.00%\)/,
    );
  });

  it('prijme celú sadu platiteľa DPH aj sadzby ako string z Drizzle numeric', () => {
    assert.doesNotThrow(() => assertSupportedVatRates([
      { name: 'Burger', vatRate: 5 },
      { name: 'Kofola', vatRate: 19 },
      { name: 'Rum', vatRate: 23 },
      { name: 'Záloha za obal', vatRate: 0 },
    ]));
    assert.doesNotThrow(() => assertSupportedVatRates([
      { name: 'Burger', vatRate: '5.00' },
      { name: 'Rum', vatRate: '23.00' },
    ]));
  });

  it('je no-op pre prázdny / chýbajúci zoznam', () => {
    assert.doesNotThrow(() => assertSupportedVatRates([]));
    assert.doesNotThrow(() => assertSupportedVatRates(undefined));
    assert.doesNotThrow(() => assertSupportedVatRates(null));
  });

  it('odmietne položku bez sadzby (raw SQL insert, starý dump)', () => {
    for (const vatRate of [null, undefined, '', 'abc']) {
      assert.throws(
        () => assertSupportedVatRates([{ name: 'Bez sadzby', vatRate }]),
        (err) => {
          assert.equal(err.status, 400);
          assert.equal(err.code, 'UNSUPPORTED_VAT_RATE');
          // Pozn.: hláška takú položku vypíše ako „(0.00%)" (Number(null)=0),
          // čo je zavádzajúce — dôležité je, že platba NEPREJDE.
          assert.ok(err.message.includes('Bez sadzby'));
          return true;
        },
        `vatRate ${JSON.stringify(vatRate)} musí byť odmietnutá`,
      );
    }
  });
});
