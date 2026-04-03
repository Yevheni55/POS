/**
 * Unit tests for server/lib/stock.js
 *
 * Uses the real pos_test database via testDb (Drizzle + pg pool from setup.js).
 * closeDb() is called exactly once — in a top-level after() hook — so that all
 * three describe blocks can share the same pool without "pool after end" errors.
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';

import { testDb, truncateAll, seed } from '../helpers/setup.js';
import * as schema from '../../db/schema.js';
import {
  deductStockForSentItems,
  applyWriteOff,
  getLowStockAlerts,
} from '../../lib/stock.js';

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function fetchMenuItem(id) {
  const [row] = await testDb
    .select()
    .from(schema.menuItems)
    .where(eq(schema.menuItems.id, id));
  return row;
}

async function fetchIngredient(id) {
  const [row] = await testDb
    .select()
    .from(schema.ingredients)
    .where(eq(schema.ingredients.id, id));
  return row;
}

async function fetchMovementsFor({ ingredientId, menuItemId }) {
  if (ingredientId !== undefined) {
    return testDb
      .select()
      .from(schema.stockMovements)
      .where(eq(schema.stockMovements.ingredientId, ingredientId));
  }
  return testDb
    .select()
    .from(schema.stockMovements)
    .where(eq(schema.stockMovements.menuItemId, menuItemId));
}

// ---------------------------------------------------------------------------
// deductStockForSentItems
// ---------------------------------------------------------------------------

describe('deductStockForSentItems', () => {
  let fixtures; // populated by before()

  before(async () => {
    await truncateAll();
    fixtures = await seed();
  });

  // -----------------------------------------------------------------------
  // trackMode = 'none'
  // -----------------------------------------------------------------------

  describe('trackMode = none', () => {
    it('returns empty movements and alerts when sentItems is empty', async () => {
      const result = await testDb.transaction(async (tx) =>
        deductStockForSentItems(tx, [], fixtures.cisnik.id, 1),
      );

      assert.deepEqual(result, { movements: [], alerts: [] });
    });

    it('creates no movements and leaves stockQty unchanged', async () => {
      const { itemBurger } = fixtures; // default trackMode = 'none'
      const beforeRow = await fetchMenuItem(itemBurger.id);

      const result = await testDb.transaction(async (tx) =>
        deductStockForSentItems(
          tx,
          [{ menuItemId: itemBurger.id, qty: 2 }],
          fixtures.cisnik.id,
          42,
        ),
      );

      const afterRow = await fetchMenuItem(itemBurger.id);

      assert.deepEqual(result, { movements: [], alerts: [] });
      assert.equal(afterRow.stockQty, beforeRow.stockQty, 'stockQty must be unchanged');
    });

    it('ignores an item whose menuItemId does not exist in the DB', async () => {
      const result = await testDb.transaction(async (tx) =>
        deductStockForSentItems(
          tx,
          [{ menuItemId: 999999, qty: 1 }],
          fixtures.cisnik.id,
          1,
        ),
      );

      assert.deepEqual(result, { movements: [], alerts: [] });
    });
  });

  // -----------------------------------------------------------------------
  // trackMode = 'simple'
  // -----------------------------------------------------------------------

  describe('trackMode = simple', () => {
    let simpleItem; // fresh item inserted before each individual test

    beforeEach(async () => {
      const [item] = await testDb
        .insert(schema.menuItems)
        .values({
          categoryId: fixtures.catDrink.id,
          name: 'Simple Tracked',
          emoji: '🧃',
          price: '3.00',
          trackMode: 'simple',
          stockQty: '10',
          minStockQty: '2',
        })
        .returning();
      simpleItem = item;
    });

    it('decreases stockQty by the sold quantity', async () => {
      await testDb.transaction(async (tx) =>
        deductStockForSentItems(
          tx,
          [{ menuItemId: simpleItem.id, qty: 3 }],
          fixtures.cisnik.id,
          10,
        ),
      );

      const updated = await fetchMenuItem(simpleItem.id);
      assert.equal(parseFloat(updated.stockQty), 7);
    });

    it('creates one stockMovement record of type sale with correct fields', async () => {
      await testDb.transaction(async (tx) =>
        deductStockForSentItems(
          tx,
          [{ menuItemId: simpleItem.id, qty: 1 }],
          fixtures.cisnik.id,
          11,
        ),
      );

      const movements = await fetchMovementsFor({ menuItemId: simpleItem.id });

      assert.equal(movements.length, 1);
      const mv = movements[0];
      assert.equal(mv.type, 'sale');
      assert.equal(parseFloat(mv.quantity), -1);
      assert.equal(parseFloat(mv.previousQty), 10);
      assert.equal(parseFloat(mv.newQty), 9);
      assert.equal(mv.referenceType, 'order');
      assert.equal(mv.referenceId, 11);
      assert.equal(mv.staffId, fixtures.cisnik.id);
    });

    it('returns the created movement in the result object', async () => {
      const result = await testDb.transaction(async (tx) =>
        deductStockForSentItems(
          tx,
          [{ menuItemId: simpleItem.id, qty: 2 }],
          fixtures.cisnik.id,
          12,
        ),
      );

      assert.equal(result.movements.length, 1);
      assert.equal(result.movements[0].type, 'sale');
      assert.equal(parseFloat(result.movements[0].quantity), -2);
    });

    it('generates no alert when stock stays above minStockQty', async () => {
      // stockQty=10, min=2; deduct 1 → 9 (well above threshold)
      const result = await testDb.transaction(async (tx) =>
        deductStockForSentItems(
          tx,
          [{ menuItemId: simpleItem.id, qty: 1 }],
          fixtures.cisnik.id,
          13,
        ),
      );

      assert.equal(result.alerts.length, 0);
    });

    it('emits a menuItem alert when stock drops to exactly minStockQty', async () => {
      // stockQty=10, min=2; deduct 8 → 2 (at threshold)
      const result = await testDb.transaction(async (tx) =>
        deductStockForSentItems(
          tx,
          [{ menuItemId: simpleItem.id, qty: 8 }],
          fixtures.cisnik.id,
          14,
        ),
      );

      const lowAlerts = result.alerts.filter(a => a.type === 'menuItem');
      assert.equal(lowAlerts.length, 1);
      assert.equal(lowAlerts[0].id, simpleItem.id);
      assert.equal(lowAlerts[0].currentQty, 2);
      assert.equal(lowAlerts[0].minQty, 2);
    });

    it('emits a menuItem alert when stock drops below minStockQty', async () => {
      // stockQty=10, min=2; deduct 9 → 1 (below threshold)
      const result = await testDb.transaction(async (tx) =>
        deductStockForSentItems(
          tx,
          [{ menuItemId: simpleItem.id, qty: 9 }],
          fixtures.cisnik.id,
          15,
        ),
      );

      const lowAlerts = result.alerts.filter(a => a.type === 'menuItem');
      assert.equal(lowAlerts.length, 1);
      assert.equal(lowAlerts[0].currentQty, 1);
    });

    it('sets active=false and emits a depleted alert when stock reaches 0', async () => {
      const result = await testDb.transaction(async (tx) =>
        deductStockForSentItems(
          tx,
          [{ menuItemId: simpleItem.id, qty: 10 }],
          fixtures.cisnik.id,
          16,
        ),
      );

      const depletedAlerts = result.alerts.filter(a => a.type === 'menuItem-depleted');
      assert.equal(depletedAlerts.length, 1, 'expected exactly one depleted alert');
      assert.equal(depletedAlerts[0].id, simpleItem.id);

      const updated = await fetchMenuItem(simpleItem.id);
      assert.equal(updated.active, false, 'item must be deactivated when qty reaches 0');
      assert.equal(parseFloat(updated.stockQty), 0);
    });

    it('sets active=false and emits depleted alert when stock goes negative', async () => {
      // deduct 12 from stock of 10 → -2
      const result = await testDb.transaction(async (tx) =>
        deductStockForSentItems(
          tx,
          [{ menuItemId: simpleItem.id, qty: 12 }],
          fixtures.cisnik.id,
          17,
        ),
      );

      const depletedAlerts = result.alerts.filter(a => a.type === 'menuItem-depleted');
      assert.equal(depletedAlerts.length, 1);

      const updated = await fetchMenuItem(simpleItem.id);
      assert.equal(updated.active, false);
      assert.equal(parseFloat(updated.stockQty), -2);
    });

    it('rounds stockQty to 3 decimal places (floating-point safety)', async () => {
      await testDb
        .update(schema.menuItems)
        .set({ stockQty: '3.333' })
        .where(eq(schema.menuItems.id, simpleItem.id));

      await testDb.transaction(async (tx) =>
        deductStockForSentItems(
          tx,
          [{ menuItemId: simpleItem.id, qty: 1 }],
          fixtures.cisnik.id,
          18,
        ),
      );

      const updated = await fetchMenuItem(simpleItem.id);
      // 3.333 - 1.000 = 2.333 — must not drift to 2.3330000000000002 etc.
      assert.equal(parseFloat(updated.stockQty), 2.333);
    });

    it('processes multiple distinct sent items in one call', async () => {
      const [secondItem] = await testDb
        .insert(schema.menuItems)
        .values({
          categoryId: fixtures.catFood.id,
          name: 'Second Simple',
          emoji: '🥤',
          price: '2.00',
          trackMode: 'simple',
          stockQty: '5',
          minStockQty: '1',
        })
        .returning();

      const result = await testDb.transaction(async (tx) =>
        deductStockForSentItems(
          tx,
          [
            { menuItemId: simpleItem.id, qty: 2 },
            { menuItemId: secondItem.id, qty: 1 },
          ],
          fixtures.manazer.id,
          20,
        ),
      );

      assert.equal(result.movements.length, 2);

      const first = await fetchMenuItem(simpleItem.id);
      const second = await fetchMenuItem(secondItem.id);
      assert.equal(parseFloat(first.stockQty), 8);
      assert.equal(parseFloat(second.stockQty), 4);
    });
  });

  // -----------------------------------------------------------------------
  // trackMode = 'recipe'
  // -----------------------------------------------------------------------

  describe('trackMode = recipe', () => {
    let recipeItem;
    let ing1;
    let ing2;

    before(async () => {
      const [item] = await testDb
        .insert(schema.menuItems)
        .values({
          categoryId: fixtures.catFood.id,
          name: 'Recipe Burger',
          emoji: '🍔',
          price: '9.00',
          trackMode: 'recipe',
        })
        .returning();
      recipeItem = item;

      const [i1] = await testDb
        .insert(schema.ingredients)
        .values({
          name: 'Test Flour',
          unit: 'kg',
          currentQty: '10',
          minQty: '1',
          costPerUnit: '0.5',
        })
        .returning();
      ing1 = i1;

      const [i2] = await testDb
        .insert(schema.ingredients)
        .values({
          name: 'Test Sauce',
          unit: 'l',
          currentQty: '5',
          minQty: '0.5',
          costPerUnit: '1.2',
        })
        .returning();
      ing2 = i2;

      await testDb.insert(schema.recipes).values([
        { menuItemId: recipeItem.id, ingredientId: ing1.id, qtyPerUnit: '0.2' },
        { menuItemId: recipeItem.id, ingredientId: ing2.id, qtyPerUnit: '0.1' },
      ]);
    });

    it('deducts each ingredient proportionally when qty=1', async () => {
      // ing1 starts at 10; ing2 starts at 5
      await testDb.transaction(async (tx) =>
        deductStockForSentItems(
          tx,
          [{ menuItemId: recipeItem.id, qty: 1 }],
          fixtures.cisnik.id,
          30,
        ),
      );

      const updatedIng1 = await fetchIngredient(ing1.id);
      const updatedIng2 = await fetchIngredient(ing2.id);

      assert.equal(parseFloat(updatedIng1.currentQty), 9.8);  // 10 - 0.2*1
      assert.equal(parseFloat(updatedIng2.currentQty), 4.9);  // 5  - 0.1*1
    });

    it('deducts each ingredient proportionally when qty=3', async () => {
      // After previous test: ing1=9.8, ing2=4.9
      await testDb.transaction(async (tx) =>
        deductStockForSentItems(
          tx,
          [{ menuItemId: recipeItem.id, qty: 3 }],
          fixtures.cisnik.id,
          31,
        ),
      );

      const updatedIng1 = await fetchIngredient(ing1.id);
      const updatedIng2 = await fetchIngredient(ing2.id);

      assert.equal(parseFloat(updatedIng1.currentQty), 9.2);  // 9.8 - 0.2*3
      assert.equal(parseFloat(updatedIng2.currentQty), 4.6);  // 4.9 - 0.1*3
    });

    it('creates one stockMovement per ingredient', async () => {
      const beforeMovements = await fetchMovementsFor({ ingredientId: ing1.id });
      const beforeCount = beforeMovements.length;

      await testDb.transaction(async (tx) =>
        deductStockForSentItems(
          tx,
          [{ menuItemId: recipeItem.id, qty: 1 }],
          fixtures.cisnik.id,
          32,
        ),
      );

      const afterMovements = await fetchMovementsFor({ ingredientId: ing1.id });
      assert.equal(afterMovements.length, beforeCount + 1);

      const latest = afterMovements.at(-1);
      assert.equal(latest.type, 'sale');
      assert.equal(latest.referenceType, 'order');
      assert.equal(latest.referenceId, 32);
      assert.equal(latest.staffId, fixtures.cisnik.id);
    });

    it('returns two movements in the result (one per ingredient)', async () => {
      const result = await testDb.transaction(async (tx) =>
        deductStockForSentItems(
          tx,
          [{ menuItemId: recipeItem.id, qty: 1 }],
          fixtures.manazer.id,
          33,
        ),
      );

      assert.equal(result.movements.length, 2);
    });

    it('emits an ingredient alert when deduction pushes ingredient below minQty', async () => {
      // Set ing1 close to minimum so one portion tips it under
      await testDb
        .update(schema.ingredients)
        .set({ currentQty: '1.1' })
        .where(eq(schema.ingredients.id, ing1.id));

      // 0.2 * 1 = 0.2 deducted → 1.1 - 0.2 = 0.9, below minQty=1
      const result = await testDb.transaction(async (tx) =>
        deductStockForSentItems(
          tx,
          [{ menuItemId: recipeItem.id, qty: 1 }],
          fixtures.manazer.id,
          34,
        ),
      );

      const ingAlerts = result.alerts.filter(a => a.type === 'ingredient');
      const alert = ingAlerts.find(a => a.id === ing1.id);
      assert.ok(alert, 'expected an ingredient alert for ing1');
      assert.equal(alert.unit, 'kg');
      assert.ok(alert.currentQty < alert.minQty, 'currentQty must be below minQty');
    });

    it('skips the item gracefully when recipe has no lines', async () => {
      const [emptyItem] = await testDb
        .insert(schema.menuItems)
        .values({
          categoryId: fixtures.catFood.id,
          name: 'Empty Recipe Item',
          emoji: '❓',
          price: '5.00',
          trackMode: 'recipe',
        })
        .returning();

      const result = await testDb.transaction(async (tx) =>
        deductStockForSentItems(
          tx,
          [{ menuItemId: emptyItem.id, qty: 2 }],
          fixtures.cisnik.id,
          35,
        ),
      );

      assert.deepEqual(result, { movements: [], alerts: [] });
    });
  });
});

// ---------------------------------------------------------------------------
// applyWriteOff
// ---------------------------------------------------------------------------

describe('applyWriteOff', () => {
  let staffRow;
  let ingredient;
  let writeOff;

  before(async () => {
    await truncateAll();
    const f = await seed();
    staffRow = f.manazer;

    const [ing] = await testDb
      .insert(schema.ingredients)
      .values({
        name: 'Write-Off Ingredient',
        unit: 'kg',
        currentQty: '20',
        minQty: '2',
        costPerUnit: '3.0',
      })
      .returning();
    ingredient = ing;

    const [wo] = await testDb
      .insert(schema.writeOffs)
      .values({
        status: 'approved',
        reason: 'expired',
        note: 'Test write-off',
        totalCost: '15.00',
        createdBy: staffRow.id,
        approvedBy: staffRow.id,
      })
      .returning();
    writeOff = wo;

    await testDb.insert(schema.writeOffItems).values([
      {
        writeOffId: writeOff.id,
        ingredientId: ingredient.id,
        quantity: '3',
        unitCost: '3.0',
        totalCost: '9.00',
      },
      {
        writeOffId: writeOff.id,
        ingredientId: ingredient.id,
        quantity: '2',
        unitCost: '3.0',
        totalCost: '6.00',
      },
    ]);
  });

  it('returns one movement per write-off item', async () => {
    const movements = await testDb.transaction(async (tx) =>
      applyWriteOff(tx, writeOff.id, staffRow.id),
    );

    assert.equal(movements.length, 2);
  });

  it('creates movements of type waste in the database', async () => {
    const allMovements = await fetchMovementsFor({ ingredientId: ingredient.id });
    const wasteMvs = allMovements.filter(m => m.type === 'waste');
    assert.ok(wasteMvs.length >= 2, 'expected at least two waste movements');
  });

  it('sets referenceType=write_off and referenceId on each movement', async () => {
    const allMovements = await fetchMovementsFor({ ingredientId: ingredient.id });
    const wasteMvs = allMovements.filter(m => m.type === 'waste');

    for (const mv of wasteMvs) {
      assert.equal(mv.referenceType, 'write_off');
      assert.equal(mv.referenceId, writeOff.id);
    }
  });

  it('reduces ingredient currentQty by the total written-off quantity', async () => {
    // Starting qty=20; two items of 3 and 2 were written off → 15
    const updated = await fetchIngredient(ingredient.id);
    assert.equal(parseFloat(updated.currentQty), 15);
  });

  it('attaches note containing the write-off id to each movement', async () => {
    const allMovements = await fetchMovementsFor({ ingredientId: ingredient.id });
    const wasteMvs = allMovements.filter(m => m.type === 'waste');

    for (const mv of wasteMvs) {
      assert.ok(
        mv.note.includes(String(writeOff.id)),
        `movement note "${mv.note}" must reference writeOffId ${writeOff.id}`,
      );
    }
  });

  it('returns empty array when write-off has no items', async () => {
    const [emptyWo] = await testDb
      .insert(schema.writeOffs)
      .values({
        status: 'approved',
        reason: 'damage',
        totalCost: '0.00',
        createdBy: staffRow.id,
      })
      .returning();

    const movements = await testDb.transaction(async (tx) =>
      applyWriteOff(tx, emptyWo.id, staffRow.id),
    );

    assert.deepEqual(movements, []);
  });

  it('records correct previousQty and newQty on the movement', async () => {
    const [freshIng] = await testDb
      .insert(schema.ingredients)
      .values({
        name: 'Fresh WO Ing',
        unit: 'l',
        currentQty: '8',
        minQty: '0',
        costPerUnit: '2.0',
      })
      .returning();

    const [freshWo] = await testDb
      .insert(schema.writeOffs)
      .values({
        status: 'approved',
        reason: 'spoilage',
        totalCost: '4.00',
        createdBy: staffRow.id,
      })
      .returning();

    await testDb.insert(schema.writeOffItems).values({
      writeOffId: freshWo.id,
      ingredientId: freshIng.id,
      quantity: '2',
      unitCost: '2.0',
      totalCost: '4.00',
    });

    const movements = await testDb.transaction(async (tx) =>
      applyWriteOff(tx, freshWo.id, staffRow.id),
    );

    assert.equal(movements.length, 1);
    assert.equal(parseFloat(movements[0].previousQty), 8);
    assert.equal(parseFloat(movements[0].newQty), 6);
    assert.equal(parseFloat(movements[0].quantity), -2);
  });
});

// ---------------------------------------------------------------------------
// getLowStockAlerts
// ---------------------------------------------------------------------------

describe('getLowStockAlerts', () => {
  let catId; // single category needed for all insertions

  before(async () => {
    await truncateAll();
    await seed(); // itemTracked: qty=10, min=2 (not low)
    const [cat] = await testDb.select().from(schema.menuCategories).limit(1);
    catId = cat.id;
  });

  it('returns empty arrays when nothing is below threshold', async () => {
    const result = await getLowStockAlerts();

    assert.ok(Array.isArray(result.ingredients));
    assert.ok(Array.isArray(result.menuItems));
    assert.equal(result.ingredients.length, 0);
    assert.equal(result.menuItems.length, 0);
  });

  it('returns a menu item whose stockQty is below minStockQty', async () => {
    const [low] = await testDb
      .insert(schema.menuItems)
      .values({
        categoryId: catId,
        name: 'Low Stock Item',
        emoji: '⚠',
        price: '1.00',
        trackMode: 'simple',
        stockQty: '1',
        minStockQty: '5',
      })
      .returning();

    const result = await getLowStockAlerts();

    const found = result.menuItems.find(m => m.id === low.id);
    assert.ok(found, 'low stock menu item must appear in alerts');
    assert.equal(found.currentQty, 1);
    assert.equal(found.minQty, 5);
  });

  it('returns a menu item when stockQty equals minStockQty', async () => {
    const [atMin] = await testDb
      .insert(schema.menuItems)
      .values({
        categoryId: catId,
        name: 'At Min Item',
        emoji: '🔔',
        price: '2.00',
        trackMode: 'simple',
        stockQty: '3',
        minStockQty: '3',
      })
      .returning();

    const result = await getLowStockAlerts();

    const found = result.menuItems.find(m => m.id === atMin.id);
    assert.ok(found, 'item at exactly minStockQty must appear in alerts');
  });

  it('does not include a trackMode=none item even when qty=0', async () => {
    await testDb
      .insert(schema.menuItems)
      .values({
        categoryId: catId,
        name: 'Untracked Zero',
        emoji: '🚫',
        price: '1.00',
        trackMode: 'none',
        stockQty: '0',
        minStockQty: '5',
      })
      .returning();

    const result = await getLowStockAlerts();

    const found = result.menuItems.find(m => m.name === 'Untracked Zero');
    assert.equal(found, undefined, 'untracked items must not appear in menuItems alerts');
  });

  it('returns an ingredient whose currentQty is below minQty', async () => {
    const [lowIng] = await testDb
      .insert(schema.ingredients)
      .values({
        name: 'Low Flour',
        unit: 'kg',
        currentQty: '0.5',
        minQty: '2',
        costPerUnit: '1.0',
      })
      .returning();

    const result = await getLowStockAlerts();

    const found = result.ingredients.find(i => i.id === lowIng.id);
    assert.ok(found, 'low ingredient must appear in alerts');
    assert.equal(found.currentQty, 0.5);
    assert.equal(found.minQty, 2);
    assert.equal(found.unit, 'kg');
  });

  it('returns an ingredient when currentQty equals minQty', async () => {
    const [atMinIng] = await testDb
      .insert(schema.ingredients)
      .values({
        name: 'At Min Oil',
        unit: 'l',
        currentQty: '1',
        minQty: '1',
        costPerUnit: '2.0',
      })
      .returning();

    const result = await getLowStockAlerts();

    const found = result.ingredients.find(i => i.id === atMinIng.id);
    assert.ok(found, 'ingredient at exactly minQty must appear in alerts');
  });

  it('does not include an inactive ingredient even if below minQty', async () => {
    await testDb
      .insert(schema.ingredients)
      .values({
        name: 'Inactive Low',
        unit: 'g',
        currentQty: '0',
        minQty: '100',
        costPerUnit: '0.1',
        active: false,
      })
      .returning();

    const result = await getLowStockAlerts();

    const found = result.ingredients.find(i => i.name === 'Inactive Low');
    assert.equal(found, undefined, 'inactive ingredients must not appear in alerts');
  });

  it('returns numeric values (not strings) for qty fields on ingredients', async () => {
    const [numIng] = await testDb
      .insert(schema.ingredients)
      .values({
        name: 'Numeric Check',
        unit: 'kg',
        currentQty: '0.25',
        minQty: '1',
        costPerUnit: '0.5',
      })
      .returning();

    const result = await getLowStockAlerts();

    const found = result.ingredients.find(i => i.id === numIng.id);
    assert.ok(found, 'numeric ingredient must appear in result');
    assert.equal(typeof found.currentQty, 'number');
    assert.equal(typeof found.minQty, 'number');
  });

  it('returns numeric values (not strings) for qty fields on menu items', async () => {
    const [numMi] = await testDb
      .insert(schema.menuItems)
      .values({
        categoryId: catId,
        name: 'Numeric Menu Item',
        emoji: '🔢',
        price: '1.00',
        trackMode: 'simple',
        stockQty: '0.5',
        minStockQty: '2',
      })
      .returning();

    const result = await getLowStockAlerts();

    const found = result.menuItems.find(m => m.id === numMi.id);
    assert.ok(found, 'numeric menu item must appear in result');
    assert.equal(typeof found.currentQty, 'number');
    assert.equal(typeof found.minQty, 'number');
  });

  it('includes id and name fields on all returned records', async () => {
    const result = await getLowStockAlerts();

    for (const ing of result.ingredients) {
      assert.equal(typeof ing.id, 'number');
      assert.ok(typeof ing.name === 'string' && ing.name.length > 0);
    }
    for (const mi of result.menuItems) {
      assert.equal(typeof mi.id, 'number');
      assert.ok(typeof mi.name === 'string' && mi.name.length > 0);
    }
  });
});
