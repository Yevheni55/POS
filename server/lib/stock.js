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

  for (const item of sentItems) {
    const mi = menuMap[item.menuItemId];
    if (!mi || mi.trackMode === 'none') continue;

    if (mi.trackMode === 'simple') {
      const prev = parseFloat(mi.stockQty);

      // Atomic decrement — prevents concurrent sends from reading stale prev
      const [updated] = await tx.update(menuItems)
        .set({ stockQty: sql`${menuItems.stockQty} - ${String(item.qty)}` })
        .where(eq(menuItems.id, mi.id))
        .returning({ stockQty: menuItems.stockQty });
      const next = Math.round(parseFloat(updated.stockQty) * 1000) / 1000;

      const [mv] = await tx.insert(stockMovements).values({
        type: 'sale', menuItemId: mi.id,
        quantity: String(-item.qty), previousQty: String(prev), newQty: String(next),
        referenceType: 'order', referenceId: orderId, staffId,
      }).returning();
      movements.push(mv);

      if (next <= parseFloat(mi.minStockQty)) {
        alerts.push({ type: 'menuItem', id: mi.id, name: mi.name, currentQty: next, minQty: parseFloat(mi.minStockQty) });
      }
      if (next <= 0) {
        await tx.update(menuItems).set({ active: false }).where(eq(menuItems.id, mi.id));
        alerts.push({ type: 'menuItem-depleted', id: mi.id, name: mi.name });
      }
    }

    if (mi.trackMode === 'recipe') {
      const recipeLines = await tx.select().from(recipes).where(eq(recipes.menuItemId, mi.id));
      if (!recipeLines.length) continue;

      const ingredientIds = recipeLines.map(r => r.ingredientId);
      const ingredientRows = await tx.select().from(ingredients).where(inArray(ingredients.id, ingredientIds));
      const ingMap = Object.fromEntries(ingredientRows.map(i => [i.id, i]));

      for (const line of recipeLines) {
        const ing = ingMap[line.ingredientId];
        if (!ing) continue;

        const deductAmount = parseFloat(line.qtyPerUnit) * item.qty;
        const prev = parseFloat(ing.currentQty);

        // Atomic decrement — prevents concurrent sends from reading stale prev
        const [updatedIng] = await tx.update(ingredients)
          .set({ currentQty: sql`${ingredients.currentQty} - ${String(deductAmount)}` })
          .where(eq(ingredients.id, ing.id))
          .returning({ currentQty: ingredients.currentQty });
        const next = Math.round(parseFloat(updatedIng.currentQty) * 1000) / 1000;

        const [mv] = await tx.insert(stockMovements).values({
          type: 'sale', ingredientId: ing.id,
          quantity: String(-deductAmount), previousQty: String(prev), newQty: String(next),
          referenceType: 'order', referenceId: orderId, staffId,
        }).returning();
        movements.push(mv);

        if (next <= parseFloat(ing.minQty)) {
          alerts.push({ type: 'ingredient', id: ing.id, name: ing.name, unit: ing.unit, currentQty: next, minQty: parseFloat(ing.minQty) });
        }
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
