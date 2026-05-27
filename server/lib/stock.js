import { db } from '../db/index.js';
import { menuItems, ingredients, recipes, stockMovements, writeOffItems } from '../db/schema.js';
import { eq, inArray, and, sql, lt, lte } from 'drizzle-orm';

/**
 * Deduct stock for items just marked as sent to kitchen.
 * Runs within the caller's transaction for atomicity.
 *
 * @param {object} tx - Drizzle transaction handle
 * @param {Array<{menuItemId: number, qty: number}>} sentItems
 * @param {number} staffId
 * @param {number} orderId
 * @returns {Promise<{movements: object[], alerts: object[]}>}
 */
export async function deductStockForSentItems(tx, sentItems, staffId, orderId) {
  if (!sentItems.length) return { movements: [], alerts: [] };

  const menuItemIds = [...new Set(sentItems.map(i => i.menuItemId))];
  const menuItemRows = await tx.select().from(menuItems).where(inArray(menuItems.id, menuItemIds));
  const menuMap = Object.fromEntries(menuItemRows.map(m => [m.id, m]));

  const movements = [];
  const alerts = [];

  // ====== PERF OPTIMIZATION (batch queries) ======
  // Predtym sme robili sequentially per-item:
  //   1) SELECT recipes WHERE menu_item_id = X
  //   2) SELECT ingredients WHERE id IN ...
  //   3) UPDATE ingredient + INSERT stock_movement
  // Pre order s 5 jedlami × 3 ingredienciami = ~40 sequential queries.
  // Teraz aggregujeme:
  //   1) 1× SELECT vsetkych recipes pre vsetky recipe items
  //   2) 1× SELECT vsetkych ingredients
  //   3) Per unique ingredient: 1 UPDATE (atomic, agregovany deduct)
  //   4) 1× batch INSERT vsetkych stock_movements
  // Pre 5×3 = max ~10 queries.

  // Spracuj 'simple' trackMode items
  // Aggregate qty per menu_item (multiple sent items of same product)
  const simpleAgg = new Map(); // menuItemId -> { mi, totalQty }
  // Aggregate ingredient deductions for recipe items
  const recipeMenuItemIds = [];
  for (const item of sentItems) {
    const mi = menuMap[item.menuItemId];
    if (!mi || mi.trackMode === 'none') continue;
    if (mi.trackMode === 'simple') {
      const cur = simpleAgg.get(mi.id);
      if (cur) cur.totalQty += item.qty;
      else simpleAgg.set(mi.id, { mi, totalQty: item.qty });
    } else if (mi.trackMode === 'recipe') {
      recipeMenuItemIds.push(item);
    }
  }

  // ====== SIMPLE TRACK ======
  for (const { mi, totalQty } of simpleAgg.values()) {
    const prev = parseFloat(mi.stockQty);
    // Atomic decrement (must be sequential per menu_item kvoli RETURNING per row)
    const [updated] = await tx.update(menuItems)
      .set({ stockQty: sql`${menuItems.stockQty} - ${String(totalQty)}` })
      .where(eq(menuItems.id, mi.id))
      .returning({ stockQty: menuItems.stockQty });
    const next = Math.round(parseFloat(updated.stockQty) * 1000) / 1000;

    const [mv] = await tx.insert(stockMovements).values({
      type: 'sale', menuItemId: mi.id,
      quantity: String(-totalQty), previousQty: String(prev), newQty: String(next),
      referenceType: 'order', referenceId: orderId, staffId,
    }).returning();
    movements.push(mv);

    if (next <= parseFloat(mi.minStockQty)) {
      alerts.push({ type: 'menuItem', id: mi.id, name: mi.name, currentQty: next, minQty: parseFloat(mi.minStockQty) });
    }
    if (next <= 0) {
      alerts.push({ type: 'menuItem-depleted', id: mi.id, name: mi.name });
    }
  }

  // ====== RECIPE TRACK (batched) ======
  if (recipeMenuItemIds.length) {
    // 1× SELECT všetkých recipes pre všetky recipe-tracked menu items
    const uniqueRecipeMenuIds = [...new Set(recipeMenuItemIds.map(i => menuMap[i.menuItemId].id))];
    const allRecipeLines = await tx.select().from(recipes).where(inArray(recipes.menuItemId, uniqueRecipeMenuIds));

    if (allRecipeLines.length) {
      // 1× SELECT všetkých ingredients
      const allIngredientIds = [...new Set(allRecipeLines.map(r => r.ingredientId))];
      const ingredientRows = await tx.select().from(ingredients).where(inArray(ingredients.id, allIngredientIds));
      const ingMap = Object.fromEntries(ingredientRows.map(i => [i.id, i]));

      // Aggregate total deduct per ingredient across vsetkych sent items + recipe lines
      const recipesByMenuItem = new Map();
      for (const line of allRecipeLines) {
        const arr = recipesByMenuItem.get(line.menuItemId) || [];
        arr.push(line);
        recipesByMenuItem.set(line.menuItemId, arr);
      }
      const deductByIngredient = new Map(); // ingredientId -> total deduct amount
      for (const item of recipeMenuItemIds) {
        const lines = recipesByMenuItem.get(item.menuItemId);
        if (!lines) continue;
        for (const line of lines) {
          if (!ingMap[line.ingredientId]) continue;
          const amt = parseFloat(line.qtyPerUnit) * item.qty;
          deductByIngredient.set(
            line.ingredientId,
            (deductByIngredient.get(line.ingredientId) || 0) + amt,
          );
        }
      }

      // Per-ingredient atomic UPDATE (sequential, ale len 1 per unique ingredient)
      // Plus pripravujeme batch INSERT movements.
      const movementRows = [];
      for (const [ingId, totalDeduct] of deductByIngredient.entries()) {
        const ing = ingMap[ingId];
        const prev = parseFloat(ing.currentQty);
        const [updatedIng] = await tx.update(ingredients)
          .set({ currentQty: sql`${ingredients.currentQty} - ${String(totalDeduct)}` })
          .where(eq(ingredients.id, ing.id))
          .returning({ currentQty: ingredients.currentQty });
        const next = Math.round(parseFloat(updatedIng.currentQty) * 1000) / 1000;

        movementRows.push({
          type: 'sale', ingredientId: ing.id,
          quantity: String(-totalDeduct), previousQty: String(prev), newQty: String(next),
          referenceType: 'order', referenceId: orderId, staffId,
        });

        if (next <= parseFloat(ing.minQty)) {
          alerts.push({ type: 'ingredient', id: ing.id, name: ing.name, unit: ing.unit, currentQty: next, minQty: parseFloat(ing.minQty) });
        }
      }

      // 1× batch INSERT vsetkych stock_movements (1 round trip namiesto N)
      if (movementRows.length) {
        const inserted = await tx.insert(stockMovements).values(movementRows).returning();
        movements.push(...inserted);
      }
    }
  }

  return { movements, alerts };
}

/**
 * Apply a write-off: deduct stock for each item and log movements.
 * Called when write-off is approved (or auto-approved).
 */
export async function applyWriteOff(tx, writeOffId, staffId) {
  const items = await tx.select().from(writeOffItems).where(eq(writeOffItems.writeOffId, writeOffId));
  const movements = [];

  for (const item of items) {
    const [ing] = await tx.select().from(ingredients).where(eq(ingredients.id, item.ingredientId));
    if (!ing) continue;

    const prev = parseFloat(ing.currentQty);
    const deduct = parseFloat(item.quantity);

    // Atomic decrement for write-off
    const [updatedIng] = await tx.update(ingredients)
      .set({ currentQty: sql`${ingredients.currentQty} - ${String(deduct)}` })
      .where(eq(ingredients.id, ing.id))
      .returning({ currentQty: ingredients.currentQty });
    const next = Math.round(parseFloat(updatedIng.currentQty) * 1000) / 1000;

    const [mv] = await tx.insert(stockMovements).values({
      type: 'waste', ingredientId: ing.id,
      quantity: String(-deduct), previousQty: String(prev), newQty: String(next),
      referenceType: 'write_off', referenceId: writeOffId, staffId,
      note: 'Odpis #' + writeOffId,
    }).returning();
    movements.push(mv);
  }
  return movements;
}

/**
 * Get all items/ingredients below their minimum stock threshold.
 */
export async function getLowStockAlerts() {
  const lowIngredients = await db.select().from(ingredients)
    .where(and(eq(ingredients.active, true), lte(ingredients.currentQty, ingredients.minQty)));

  const lowMenuItems = await db.select().from(menuItems)
    .where(and(eq(menuItems.trackMode, 'simple'), lte(menuItems.stockQty, menuItems.minStockQty)));

  return {
    ingredients: lowIngredients.map(i => ({
      id: i.id, name: i.name, unit: i.unit,
      currentQty: parseFloat(i.currentQty), minQty: parseFloat(i.minQty),
    })),
    menuItems: lowMenuItems.map(m => ({
      id: m.id, name: m.name,
      currentQty: parseFloat(m.stockQty), minQty: parseFloat(m.minStockQty),
    })),
  };
}
