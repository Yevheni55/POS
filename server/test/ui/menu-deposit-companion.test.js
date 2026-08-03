// Automaticka zaloha k polozkam kategorie `nealko` (admin/pages/menu.js).
//
// Zaloha za flasu sa k napoju pripina cez menu_items.companion_menu_item_id —
// mechanizmus v js/pos-orders.js:17-77 ju pri pridani napoja nahodi sam,
// zrkadli mnozstvo a pri odobrati primaru ju zmaze. Problem nebol v kode ale
// v datach: polozky 128-132 pribudli neskor a companion im nikto nenastavil,
// takze Rajec, Targa, Dilmah, Vinea ani Thomas Henry zalohu NEUCTOVALI.
//
// Tento test drzi prevenciu: pri ZAKLADANI novej polozky v `nealko` sa zaloha
// predvyplni sama. Vynimky, ktore sa predvyplnit NESMU: editacia existujucej
// polozky (nesmieme prepisat volbu manazera), polozka po rucnej zmene pola,
// ina kategoria, a samotna Zaloha (companionom sama sebe byt nemoze).
//
// Bez jsdom v repe sa netestuje render — vytiahne sa realny zdroj helperov
// a spusti vo `vm`, takze sa testuje odoslany kod, nie jeho kopia v teste.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const MENU_SRC = readFileSync(path.join(REPO_ROOT, 'admin/pages/menu.js'), 'utf8').replace(/\r\n/g, '\n');

/**
 * Vytiahne blok zalohovych helperov zo zdroja admin stranky a spusti ho vo `vm`
 * so stubmi za DOM a modulovy stav.
 *
 * @param {object} opts
 * @param {Array}  opts.menuData      stub MENU_DATA
 * @param {string} opts.selectedCatId hodnota #fCategory
 * @param {number|null} opts.editingProductId null = zakladame novu polozku
 * @param {boolean} opts.companionTouched manazer uz pole rucne menil
 */
function loadDepositHelpers(opts) {
  const start = MENU_SRC.indexOf("const DEPOSIT_CATEGORY_SLUG = 'nealko';");
  assert.notEqual(start, -1, 'blok DEPOSIT_* helperov sa nenasiel — presunul sa?');
  const endMarker = 'function syncCompanionSuggestion';
  const endIdx = MENU_SRC.indexOf(endMarker, start);
  assert.notEqual(endIdx, -1, 'syncCompanionSuggestion() sa nenasiel');
  const tail = MENU_SRC.slice(endIdx);
  const bodyEnd = tail.indexOf('\n}\n');
  assert.notEqual(bodyEnd, -1, 'telo syncCompanionSuggestion() sa neda ohranicit');
  const block = MENU_SRC.slice(start, endIdx) + tail.slice(0, bodyEnd + 3);

  const companionSelect = { value: '' };
  const sandbox = {
    console,
    MENU_DATA: opts.menuData,
    activeCatId: opts.selectedCatId,
    editingProductId: opts.editingProductId ?? null,
    companionTouched: Boolean(opts.companionTouched),
    byId: (id) => (id === 'fCompanion' ? companionSelect : { value: String(opts.selectedCatId) }),
    findCategory: (id) => opts.menuData.find((c) => String(c.id) === String(id)) || null,
  };
  vm.createContext(sandbox);
  vm.runInContext(
    block + '\nglobalThis.__api = { findDepositItemId, syncCompanionSuggestion };',
    sandbox,
  );
  return { api: sandbox.__api, companionSelect };
}

const DEPOSIT_ID = 87;
const COLA_ID = 16;

function menuFixture() {
  return [
    {
      id: 3,
      slug: 'nealko',
      label: 'Nealko',
      items: [
        { id: COLA_ID, name: 'Coca-Cola 0,5 l', companionMenuItemId: null },
        { id: 22, name: 'Džús 0,2 l', companionMenuItemId: null },
        { id: DEPOSIT_ID, name: 'Záloha fľaša', companionMenuItemId: null },
      ],
    },
    {
      id: 4,
      slug: 'alko',
      label: 'Alko',
      items: [{ id: 30, name: 'Vodka Finlandia 0,04 l', companionMenuItemId: null }],
    },
  ];
}

test('findDepositItemId najde zalohu v kategorii nealko podla nazvu, nie podla natvrdo zapisaneho id', () => {
  const { api } = loadDepositHelpers({ menuData: menuFixture(), selectedCatId: 3 });
  assert.equal(api.findDepositItemId(), DEPOSIT_ID);
});

test('findDepositItemId vrati null, ked zaloha v menu nie je', () => {
  const data = menuFixture();
  data[0].items = data[0].items.filter((i) => i.id !== DEPOSIT_ID);
  const { api } = loadDepositHelpers({ menuData: data, selectedCatId: 3 });
  assert.equal(api.findDepositItemId(), null);
});

test('nova polozka v nealko dostane zalohu predvyplnenu', () => {
  const { api, companionSelect } = loadDepositHelpers({ menuData: menuFixture(), selectedCatId: 3 });
  api.syncCompanionSuggestion(true);
  assert.equal(companionSelect.value, String(DEPOSIT_ID));
});

test('nova polozka v inej kategorii zalohu NEdostane', () => {
  const { api, companionSelect } = loadDepositHelpers({ menuData: menuFixture(), selectedCatId: 4 });
  api.syncCompanionSuggestion(true);
  assert.equal(companionSelect.value, '', 'alko polozka nema vratny obal');
});

test('pri EDITACII existujucej polozky sa volba manazera neprepise', () => {
  const { api, companionSelect } = loadDepositHelpers({
    menuData: menuFixture(), selectedCatId: 3, editingProductId: COLA_ID,
  });
  api.syncCompanionSuggestion(false);
  assert.equal(companionSelect.value, '');
});

test('ked manazer pole uz rucne menil, navrh sa nevnucuje', () => {
  const { api, companionSelect } = loadDepositHelpers({
    menuData: menuFixture(), selectedCatId: 3, companionTouched: true,
  });
  api.syncCompanionSuggestion(false);
  assert.equal(companionSelect.value, '');
});

test('samotna Zaloha nedostane companionom samu seba', () => {
  const { api, companionSelect } = loadDepositHelpers({
    menuData: menuFixture(), selectedCatId: 3, editingProductId: DEPOSIT_ID,
  });
  api.syncCompanionSuggestion(true);
  assert.equal(companionSelect.value, '', 'inak by vznikla nekonecna slucka companionov');
});

test('zhoda nazvu je diakritiky-tolerantna na velkost pismen', () => {
  const data = menuFixture();
  data[0].items = data[0].items.map((i) => (i.id === DEPOSIT_ID ? { ...i, name: 'ZÁLOHA fľaša 0,5 l' } : i));
  const { api } = loadDepositHelpers({ menuData: data, selectedCatId: 3 });
  assert.equal(api.findDepositItemId(), DEPOSIT_ID);
});
