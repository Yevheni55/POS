// Stock manipulation extracted from /api/orders/:id/storno-write-off so the
// new /api/storno-basket flow can call it at admin-resolution time without
// duplicating logic.
//
// applyStornoStockResolution(tx, { menuItem, qty, wasPrepared, reason, note, orderId, staffId })
//   wasPrepared=false → revert deduction (food was never made)
//     simple   trackMode → menu_items.stock_qty += qty
//     recipe   trackMode → ingredients.current_qty += qtyPerUnit*qty for each recipe line
//   wasPrepared=true  → write-off (food was made, money lost)
//     creates an approved writeOffs row with writeOffItems for each ingredient
//     stock was already deducted at send time, so no further deduction here
//
// Returns { action, totalCost, writeOffId } describing what happened so the
// caller can echo it back to the cashier toast.

import { eq } from 'drizzle-orm';
import {
  menuItems, recipes, ingredients, writeOffs, writeOffItems,
} from '../db/schema.js';

const REASON_TO_WRITE_OFF = {
  order_error: 'other',
  complaint: 'damage',
  breakage: 'damage',
  staff_meal: 'other',
  other: 'other',
};

export async function applyStornoStockResolution(tx, params) {
  const { menuItem, qty, wasPrepared, reason, note, orderId, staffId } = params;
  if (!menuItem || !(qty > 0)) {
    return { action: 'skipped', reason: 'missing menuItem or qty' };
  }

  // Path A — food not made: revert the deduction that happened at send time.
  if (!wasPrepared) {
    if (menuItem.trackMode === 'simple') {
      const prev = parseFloat(menuItem.stockQty);
      const next = Math.round((prev + qty) * 1000) / 1000;
      await tx.update(menuItems).set({ stockQty: String(next) }).where(eq(menuItems.id, menuItem.id));
    } else if (menuItem.trackMode === 'recipe') {
      const recipeLines = await tx.select().from(recipes).where(eq(recipes.menuItemId, menuItem.id));
      for (const line of recipeLines) {
        const [ing] = await tx.select().from(ingredients).where(eq(ingredients.id, line.ingredientId));
        if (!ing) continue;
        const addBack = parseFloat(line.qtyPerUnit) * qty;
        const next = Math.round((parseFloat(ing.currentQty) + addBack) * 1000) / 1000;
        await tx.update(ingredients).set({ currentQty: String(next) }).where(eq(ingredients.id, ing.id));
      }
    }
    return { action: 'returned', menuItemId: menuItem.id, qty };
  }

  // Path B — food was made: record the loss as an approved write-off.
  const woItems = [];
  if (menuItem.trackMode === 'simple') {
    woItems.push({ ingredientId: null, menuItemId: menuItem.id, qty, unitCost: parseFloat(menuItem.price) });
  } else if (menuItem.trackMode === 'recipe') {
    const recipeLines = await tx.select().from(recipes).where(eq(recipes.menuItemId, menuItem.id));
    for (const line of recipeLines) {
      const [ing] = await tx.select().from(ingredients).where(eq(ingredients.id, line.ingredientId));
      if (!ing) continue;
      woItems.push({ ingredientId: ing.id, qty: parseFloat(line.qtyPerUnit) * qty, unitCost: parseFloat(ing.costPerUnit) });
    }
  }

  const totalCost = woItems.length
    ? woItems.reduce((s, i) => s + Math.round(i.qty * i.unitCost * 100) / 100, 0)
    : Math.round(parseFloat(menuItem.price) * qty * 100) / 100;

  const woReason = REASON_TO_WRITE_OFF[reason] || 'other';
  const noteText = `POS storno: ${note || reason || 'other'}`
    + (orderId ? ` (Obj. #${orderId}, ${menuItem.name} x${qty})` : ` (${menuItem.name} x${qty})`);

  const [wo] = await tx.insert(writeOffs).values({
    status: 'approved',
    reason: woReason,
    note: noteText,
    totalCost: String(totalCost),
    createdBy: staffId,
    approvedBy: staffId,
    approvedAt: new Date(),
  }).returning();

  for (const item of woItems) {
    if (!item.ingredientId) continue;
    const lineCost = Math.round(item.qty * item.unitCost * 100) / 100;
    await tx.insert(writeOffItems).values({
      writeOffId: wo.id,
      ingredientId: item.ingredientId,
      quantity: String(item.qty),
      unitCost: String(item.unitCost),
      totalCost: String(lineCost),
    });
  }

  return { action: 'write_off', writeOffId: wo.id, totalCost, menuItemId: menuItem.id, qty };
}
