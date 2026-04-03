import { Router } from 'express';
import { db } from '../db/index.js';
import {
  ingredients, recipes, stockMovements, menuItems,
  suppliers, purchaseOrders, purchaseOrderItems,
  inventoryAudits, inventoryAuditItems, staff,
  writeOffs, writeOffItems, assets, assetDepreciations
} from '../db/schema.js';
import { eq, desc, and, inArray, sql, asc, count, lte, gte, sum } from 'drizzle-orm';
import { validate } from '../middleware/validate.js';
import { requireRole } from '../middleware/requireRole.js';
import {
  createIngredientSchema, updateIngredientSchema, setRecipeSchema,
  stockAdjustSchema, stockConfigSchema,
  createSupplierSchema, updateSupplierSchema,
  createPurchaseOrderSchema, updatePurchaseOrderSchema,
  createAuditSchema, updateAuditItemSchema,
  createWriteOffSchema, createAssetSchema, updateAssetSchema,
} from '../schemas/inventory.js';
import { getLowStockAlerts, applyWriteOff } from '../lib/stock.js';
import { emitEvent } from '../lib/emit.js';

const router = Router();

// All inventory write operations require manazer/admin role
const mgr = requireRole('manazer', 'admin');

// ===================== DASHBOARD =====================

router.get('/dashboard', async (req, res) => {
  const [alerts, recentMv, [ingCount], [mvToday]] = await Promise.all([
    getLowStockAlerts(),
    db.select().from(stockMovements).orderBy(desc(stockMovements.createdAt)).limit(20),
    db.select({ count: count() }).from(ingredients).where(eq(ingredients.active, true)),
    db.select({ count: count() }).from(stockMovements)
      .where(gte(stockMovements.createdAt, sql`CURRENT_DATE`)),
  ]);
  res.json({
    lowStockIngredients: alerts.ingredients,
    lowStockMenuItems: alerts.menuItems,
    recentMovements: recentMv,
    stats: {
      totalIngredients: ingCount.count,
      totalLowStock: alerts.ingredients.length + alerts.menuItems.length,
      todayMovements: mvToday.count,
    },
  });
});

// ===================== INGREDIENTS =====================

router.get('/ingredients', async (req, res) => {
  const where = [];
  if (req.query.active !== 'false') where.push(eq(ingredients.active, true));
  if (req.query.type) where.push(eq(ingredients.type, req.query.type));
  if (req.query.lowStock === 'true') where.push(lte(ingredients.currentQty, ingredients.minQty));
  const rows = await db.select().from(ingredients)
    .where(where.length ? and(...where) : undefined)
    .orderBy(asc(ingredients.name));
  res.json(rows.map(r => ({ ...r, currentQty: parseFloat(r.currentQty), minQty: parseFloat(r.minQty), costPerUnit: parseFloat(r.costPerUnit) })));
});

router.get('/ingredients/:id', async (req, res) => {
  const [row] = await db.select().from(ingredients).where(eq(ingredients.id, +req.params.id));
  if (!row) return res.status(404).json({ error: 'Not found' });
  const mvs = await db.select().from(stockMovements)
    .where(eq(stockMovements.ingredientId, row.id))
    .orderBy(desc(stockMovements.createdAt)).limit(50);
  res.json({ ...row, currentQty: parseFloat(row.currentQty), minQty: parseFloat(row.minQty), costPerUnit: parseFloat(row.costPerUnit), movements: mvs });
});

router.post('/ingredients', mgr, validate(createIngredientSchema), async (req, res) => {
  const [row] = await db.insert(ingredients).values({
    name: req.body.name, unit: req.body.unit, type: req.body.type || 'ingredient',
    currentQty: String(req.body.currentQty), minQty: String(req.body.minQty),
    costPerUnit: String(req.body.costPerUnit),
  }).returning();
  res.status(201).json(row);
});

router.put('/ingredients/:id', mgr, validate(updateIngredientSchema), async (req, res) => {
  const data = {};
  if (req.body.name !== undefined) data.name = req.body.name;
  if (req.body.unit !== undefined) data.unit = req.body.unit;
  if (req.body.minQty !== undefined) data.minQty = String(req.body.minQty);
  if (req.body.costPerUnit !== undefined) data.costPerUnit = String(req.body.costPerUnit);
  if (req.body.active !== undefined) data.active = req.body.active;
  const [row] = await db.update(ingredients).set(data).where(eq(ingredients.id, +req.params.id)).returning();
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

router.delete('/ingredients/:id', mgr, async (req, res) => {
  await db.update(ingredients).set({ active: false }).where(eq(ingredients.id, +req.params.id));
  res.json({ ok: true });
});

// ===================== RECIPES =====================

router.get('/recipes/:menuItemId', async (req, res) => {
  const rows = await db.select({
    id: recipes.id, ingredientId: recipes.ingredientId, qtyPerUnit: recipes.qtyPerUnit,
    ingredientName: ingredients.name, ingredientUnit: ingredients.unit,
  })
  .from(recipes)
  .innerJoin(ingredients, eq(recipes.ingredientId, ingredients.id))
  .where(eq(recipes.menuItemId, +req.params.menuItemId));
  res.json(rows.map(r => ({ ...r, qtyPerUnit: parseFloat(r.qtyPerUnit) })));
});

router.put('/recipes/:menuItemId', mgr, validate(setRecipeSchema), async (req, res) => {
  const menuItemId = +req.params.menuItemId;
  await db.transaction(async (tx) => {
    await tx.delete(recipes).where(eq(recipes.menuItemId, menuItemId));
    for (const line of req.body.lines) {
      await tx.insert(recipes).values({
        menuItemId, ingredientId: line.ingredientId, qtyPerUnit: String(line.qtyPerUnit),
      });
    }
  });
  const rows = await db.select({
    id: recipes.id, ingredientId: recipes.ingredientId, qtyPerUnit: recipes.qtyPerUnit,
    ingredientName: ingredients.name, ingredientUnit: ingredients.unit,
  })
  .from(recipes)
  .innerJoin(ingredients, eq(recipes.ingredientId, ingredients.id))
  .where(eq(recipes.menuItemId, menuItemId));
  res.json(rows.map(r => ({ ...r, qtyPerUnit: parseFloat(r.qtyPerUnit) })));
});

router.delete('/recipes/:menuItemId', mgr, async (req, res) => {
  await db.delete(recipes).where(eq(recipes.menuItemId, +req.params.menuItemId));
  res.json({ ok: true });
});

// ===================== STOCK MOVEMENTS =====================

router.get('/movements', async (req, res) => {
  const where = [];
  if (req.query.type) where.push(eq(stockMovements.type, req.query.type));
  if (req.query.ingredientId) where.push(eq(stockMovements.ingredientId, +req.query.ingredientId));
  if (req.query.menuItemId) where.push(eq(stockMovements.menuItemId, +req.query.menuItemId));
  if (req.query.from) where.push(gte(stockMovements.createdAt, new Date(req.query.from)));
  if (req.query.to) where.push(lte(stockMovements.createdAt, new Date(req.query.to)));

  const limit = Math.min(+(req.query.limit || 50), 200);
  const offset = +(req.query.offset || 0);

  const [rows, [totalRow]] = await Promise.all([
    db.select().from(stockMovements)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(stockMovements.createdAt))
      .limit(limit).offset(offset),
    db.select({ count: count() }).from(stockMovements)
      .where(where.length ? and(...where) : undefined),
  ]);
  res.json({ data: rows, total: totalRow.count });
});

router.post('/movements/adjust', mgr, validate(stockAdjustSchema), async (req, res) => {
  const { ingredientId, menuItemId, quantity, type, note } = req.body;
  const staffId = req.user.id;

  const result = await db.transaction(async (tx) => {
    if (ingredientId) {
      const [ing] = await tx.select().from(ingredients).where(eq(ingredients.id, ingredientId));
      if (!ing) throw new Error('Ingredient not found');
      const prev = parseFloat(ing.currentQty);
      const next = Math.round((prev + quantity) * 1000) / 1000;
      await tx.update(ingredients).set({ currentQty: String(next) }).where(eq(ingredients.id, ingredientId));
      const [mv] = await tx.insert(stockMovements).values({
        type, ingredientId, quantity: String(quantity),
        previousQty: String(prev), newQty: String(next), note, staffId,
      }).returning();
      return mv;
    }
    if (menuItemId) {
      const [mi] = await tx.select().from(menuItems).where(eq(menuItems.id, menuItemId));
      if (!mi) throw new Error('Menu item not found');
      const prev = parseFloat(mi.stockQty);
      const next = Math.round((prev + quantity) * 1000) / 1000;
      await tx.update(menuItems).set({ stockQty: String(next) }).where(eq(menuItems.id, menuItemId));
      const [mv] = await tx.insert(stockMovements).values({
        type, menuItemId, quantity: String(quantity),
        previousQty: String(prev), newQty: String(next), note, staffId,
      }).returning();
      return mv;
    }
  });
  res.status(201).json(result);
});

// ===================== MENU ITEM STOCK CONFIG =====================

router.get('/menu-items', async (req, res) => {
  const { menuCategories } = await import('../db/schema.js');
  const rows = await db.select({
    id: menuItems.id, name: menuItems.name, emoji: menuItems.emoji, price: menuItems.price,
    trackMode: menuItems.trackMode, stockQty: menuItems.stockQty, minStockQty: menuItems.minStockQty,
    categoryId: menuItems.categoryId, categoryLabel: menuCategories.label, categorySlug: menuCategories.slug,
  })
  .from(menuItems)
  .innerJoin(menuCategories, eq(menuItems.categoryId, menuCategories.id))
  .where(eq(menuItems.active, true))
  .orderBy(asc(menuCategories.sortKey), asc(menuItems.name));
  res.json(rows.map(m => ({
    ...m, price: parseFloat(m.price), stockQty: parseFloat(m.stockQty), minStockQty: parseFloat(m.minStockQty),
  })));
});

router.put('/menu-items/:id/stock-config', mgr, validate(stockConfigSchema), async (req, res) => {
  const data = { trackMode: req.body.trackMode };
  if (req.body.stockQty !== undefined) data.stockQty = String(req.body.stockQty);
  if (req.body.minStockQty !== undefined) data.minStockQty = String(req.body.minStockQty);
  const [row] = await db.update(menuItems).set(data).where(eq(menuItems.id, +req.params.id)).returning();
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ ...row, price: parseFloat(row.price), stockQty: parseFloat(row.stockQty), minStockQty: parseFloat(row.minStockQty) });
});

// ===================== SUPPLIERS =====================

router.get('/suppliers', async (req, res) => {
  const where = req.query.active !== 'false' ? eq(suppliers.active, true) : undefined;
  const rows = await db.select().from(suppliers).where(where).orderBy(asc(suppliers.name));
  res.json(rows);
});

router.post('/suppliers', mgr, validate(createSupplierSchema), async (req, res) => {
  const [row] = await db.insert(suppliers).values(req.body).returning();
  res.status(201).json(row);
});

router.put('/suppliers/:id', mgr, validate(updateSupplierSchema), async (req, res) => {
  const [row] = await db.update(suppliers).set(req.body).where(eq(suppliers.id, +req.params.id)).returning();
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

router.delete('/suppliers/:id', mgr, async (req, res) => {
  await db.update(suppliers).set({ active: false }).where(eq(suppliers.id, +req.params.id));
  res.json({ ok: true });
});

// ===================== PURCHASE ORDERS =====================

router.get('/purchase-orders', async (req, res) => {
  const where = [];
  if (req.query.status) where.push(eq(purchaseOrders.status, req.query.status));
  if (req.query.supplierId) where.push(eq(purchaseOrders.supplierId, +req.query.supplierId));

  const rows = await db.select().from(purchaseOrders)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(purchaseOrders.createdAt));

  const poIds = rows.map(r => r.id);
  const items = poIds.length
    ? await db.select({
        id: purchaseOrderItems.id, purchaseOrderId: purchaseOrderItems.purchaseOrderId,
        ingredientId: purchaseOrderItems.ingredientId, quantity: purchaseOrderItems.quantity,
        unitCost: purchaseOrderItems.unitCost, totalCost: purchaseOrderItems.totalCost,
        ingredientName: ingredients.name, ingredientUnit: ingredients.unit,
      }).from(purchaseOrderItems)
      .innerJoin(ingredients, eq(purchaseOrderItems.ingredientId, ingredients.id))
      .where(inArray(purchaseOrderItems.purchaseOrderId, poIds))
    : [];

  const supplierIds = [...new Set(rows.map(r => r.supplierId))];
  const supplierRows = supplierIds.length
    ? await db.select().from(suppliers).where(inArray(suppliers.id, supplierIds))
    : [];
  const supplierMap = Object.fromEntries(supplierRows.map(s => [s.id, s]));

  res.json(rows.map(r => ({
    ...r, totalCost: parseFloat(r.totalCost), hasImage: !!r.imageData, imageData: undefined,
    supplier: supplierMap[r.supplierId] || null,
    items: items.filter(i => i.purchaseOrderId === r.id).map(i => ({
      ...i, quantity: parseFloat(i.quantity), unitCost: parseFloat(i.unitCost), totalCost: parseFloat(i.totalCost),
    })),
  })));
});

router.get('/purchase-orders/:id', async (req, res) => {
  const [po] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, +req.params.id));
  if (!po) return res.status(404).json({ error: 'Not found' });
  const [supplier] = await db.select().from(suppliers).where(eq(suppliers.id, po.supplierId));
  const items = await db.select({
    id: purchaseOrderItems.id, ingredientId: purchaseOrderItems.ingredientId,
    quantity: purchaseOrderItems.quantity, unitCost: purchaseOrderItems.unitCost,
    totalCost: purchaseOrderItems.totalCost, ingredientName: ingredients.name,
    ingredientUnit: ingredients.unit,
  })
  .from(purchaseOrderItems)
  .innerJoin(ingredients, eq(purchaseOrderItems.ingredientId, ingredients.id))
  .where(eq(purchaseOrderItems.purchaseOrderId, po.id));
  res.json({
    ...po, totalCost: parseFloat(po.totalCost), supplier,
    items: items.map(i => ({ ...i, quantity: parseFloat(i.quantity), unitCost: parseFloat(i.unitCost), totalCost: parseFloat(i.totalCost) })),
  });
});

router.post('/purchase-orders', mgr, validate(createPurchaseOrderSchema), async (req, res) => {
  const { supplierId, note, items, imageData } = req.body;
  const staffId = req.user.id;

  const po = await db.transaction(async (tx) => {
    const totalCost = items.reduce((s, i) => s + i.quantity * i.unitCost, 0);
    const values = { supplierId, note, totalCost: String(totalCost), createdBy: staffId };
    if (imageData) values.imageData = imageData;
    const [po] = await tx.insert(purchaseOrders).values(values).returning();

    for (const item of items) {
      await tx.insert(purchaseOrderItems).values({
        purchaseOrderId: po.id, ingredientId: item.ingredientId,
        quantity: String(item.quantity),
        invoiceUnit: item.invoiceUnit || '',
        conversionFactor: String(item.conversionFactor || 1),
        unitCost: String(item.unitCost),
        totalCost: String(item.quantity * item.unitCost),
      });
    }
    return po;
  });
  res.status(201).json({ ...po, totalCost: parseFloat(po.totalCost) });
});

router.put('/purchase-orders/:id', mgr, validate(updatePurchaseOrderSchema), async (req, res) => {
  const poId = +req.params.id;
  const [po] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId));
  if (!po) return res.status(404).json({ error: 'Not found' });
  if (po.status !== 'draft') return res.status(400).json({ error: 'Can only edit draft orders' });

  await db.transaction(async (tx) => {
    if (req.body.note !== undefined) {
      await tx.update(purchaseOrders).set({ note: req.body.note }).where(eq(purchaseOrders.id, poId));
    }
    if (req.body.items) {
      await tx.delete(purchaseOrderItems).where(eq(purchaseOrderItems.purchaseOrderId, poId));
      let totalCost = 0;
      for (const item of req.body.items) {
        const lineCost = item.quantity * item.unitCost;
        totalCost += lineCost;
        await tx.insert(purchaseOrderItems).values({
          purchaseOrderId: poId, ingredientId: item.ingredientId,
          quantity: String(item.quantity), unitCost: String(item.unitCost), totalCost: String(lineCost),
        });
      }
      await tx.update(purchaseOrders).set({ totalCost: String(totalCost) }).where(eq(purchaseOrders.id, poId));
    }
  });
  const [updated] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId));
  res.json({ ...updated, totalCost: parseFloat(updated.totalCost) });
});

router.post('/purchase-orders/:id/receive', mgr, async (req, res) => {
  const poId = +req.params.id;
  const staffId = req.user.id;

  const result = await db.transaction(async (tx) => {
    const [po] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId));
    if (!po) throw new Error('Not found');
    if (po.status !== 'draft') throw new Error('Already processed');

    const items = await tx.select().from(purchaseOrderItems).where(eq(purchaseOrderItems.purchaseOrderId, poId));

    for (const item of items) {
      const [ing] = await tx.select().from(ingredients).where(eq(ingredients.id, item.ingredientId));
      if (!ing) continue;
      const prev = parseFloat(ing.currentQty);
      const convFactor = parseFloat(item.conversionFactor) || 1;
      const stockQty = Math.round(parseFloat(item.quantity) * convFactor * 1000) / 1000;
      const next = Math.round((prev + stockQty) * 1000) / 1000;

      await tx.update(ingredients).set({ currentQty: String(next), costPerUnit: item.unitCost }).where(eq(ingredients.id, ing.id));
      await tx.insert(stockMovements).values({
        type: 'purchase', ingredientId: ing.id,
        quantity: String(stockQty), previousQty: String(prev), newQty: String(next),
        referenceType: 'purchase_order', referenceId: poId, staffId,
      });
    }

    const [updated] = await tx.update(purchaseOrders).set({
      status: 'received', receivedBy: staffId, receivedAt: new Date(),
    }).where(eq(purchaseOrders.id, poId)).returning();
    return updated;
  });
  res.json({ ...result, totalCost: parseFloat(result.totalCost) });
});

router.post('/purchase-orders/:id/cancel', mgr, async (req, res) => {
  const [po] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, +req.params.id));
  if (!po) return res.status(404).json({ error: 'Not found' });
  const [updated] = await db.update(purchaseOrders).set({ status: 'cancelled' }).where(eq(purchaseOrders.id, po.id)).returning();
  res.json({ ...updated, totalCost: parseFloat(updated.totalCost) });
});

router.post('/purchase-orders/:id/reopen', mgr, async (req, res) => {
  const [po] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, +req.params.id));
  if (!po) return res.status(404).json({ error: 'Not found' });
  const [updated] = await db.update(purchaseOrders).set({ status: 'draft', receivedBy: null, receivedAt: null }).where(eq(purchaseOrders.id, po.id)).returning();
  res.json({ ...updated, totalCost: parseFloat(updated.totalCost) });
});

router.delete('/purchase-orders/:id', mgr, async (req, res) => {
  const [po] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, +req.params.id));
  if (!po) return res.status(404).json({ error: 'Not found' });
  await db.transaction(async (tx) => {
    await tx.delete(purchaseOrderItems).where(eq(purchaseOrderItems.purchaseOrderId, po.id));
    await tx.delete(purchaseOrders).where(eq(purchaseOrders.id, po.id));
  });
  res.json({ ok: true });
});

router.get('/purchase-orders/:id/image', async (req, res) => {
  const [po] = await db.select({ imageData: purchaseOrders.imageData }).from(purchaseOrders).where(eq(purchaseOrders.id, +req.params.id));
  if (!po || !po.imageData) return res.status(404).json({ error: 'No image' });
  res.json({ imageData: po.imageData });
});

// ===================== INVENTORY AUDITS =====================

router.get('/audits', async (req, res) => {
  const where = req.query.status ? eq(inventoryAudits.status, req.query.status) : undefined;
  const rows = await db.select().from(inventoryAudits).where(where).orderBy(desc(inventoryAudits.createdAt));
  res.json(rows);
});

router.get('/audits/:id', async (req, res) => {
  const [audit] = await db.select().from(inventoryAudits).where(eq(inventoryAudits.id, +req.params.id));
  if (!audit) return res.status(404).json({ error: 'Not found' });
  const items = await db.select({
    id: inventoryAuditItems.id, ingredientId: inventoryAuditItems.ingredientId,
    expectedQty: inventoryAuditItems.expectedQty, actualQty: inventoryAuditItems.actualQty,
    difference: inventoryAuditItems.difference,
    ingredientName: ingredients.name, ingredientUnit: ingredients.unit,
  })
  .from(inventoryAuditItems)
  .innerJoin(ingredients, eq(inventoryAuditItems.ingredientId, ingredients.id))
  .where(eq(inventoryAuditItems.auditId, audit.id));
  res.json({
    ...audit,
    items: items.map(i => ({
      ...i,
      expectedQty: parseFloat(i.expectedQty),
      actualQty: i.actualQty != null ? parseFloat(i.actualQty) : null,
      difference: i.difference != null ? parseFloat(i.difference) : null,
    })),
  });
});

router.post('/audits', mgr, validate(createAuditSchema), async (req, res) => {
  const staffId = req.user.id;
  const { note, ingredientIds } = req.body;

  const audit = await db.transaction(async (tx) => {
    const [audit] = await tx.insert(inventoryAudits).values({ note, createdBy: staffId }).returning();

    const where = ingredientIds?.length
      ? and(eq(ingredients.active, true), inArray(ingredients.id, ingredientIds))
      : eq(ingredients.active, true);
    const ings = await tx.select().from(ingredients).where(where);

    for (const ing of ings) {
      await tx.insert(inventoryAuditItems).values({
        auditId: audit.id, ingredientId: ing.id, expectedQty: ing.currentQty,
      });
    }
    return audit;
  });
  res.status(201).json(audit);
});

router.put('/audits/:auditId/items/:itemId', mgr, validate(updateAuditItemSchema), async (req, res) => {
  const actualQty = req.body.actualQty;
  const [item] = await db.select().from(inventoryAuditItems).where(eq(inventoryAuditItems.id, +req.params.itemId));
  if (!item) return res.status(404).json({ error: 'Not found' });
  const diff = Math.round((actualQty - parseFloat(item.expectedQty)) * 1000) / 1000;
  const [updated] = await db.update(inventoryAuditItems).set({
    actualQty: String(actualQty), difference: String(diff),
  }).where(eq(inventoryAuditItems.id, item.id)).returning();
  res.json({ ...updated, expectedQty: parseFloat(updated.expectedQty), actualQty: parseFloat(updated.actualQty), difference: parseFloat(updated.difference) });
});

router.post('/audits/:id/complete', mgr, async (req, res) => {
  const auditId = +req.params.id;
  const staffId = req.user.id;

  const result = await db.transaction(async (tx) => {
    const [audit] = await tx.select().from(inventoryAudits).where(eq(inventoryAudits.id, auditId));
    if (!audit || audit.status !== 'open') throw new Error('Audit not open');

    const items = await tx.select().from(inventoryAuditItems).where(eq(inventoryAuditItems.auditId, auditId));

    for (const item of items) {
      if (item.actualQty == null) continue;
      const diff = parseFloat(item.difference || '0');
      if (diff === 0) continue;

      const [ing] = await tx.select().from(ingredients).where(eq(ingredients.id, item.ingredientId));
      if (!ing) continue;
      const prev = parseFloat(ing.currentQty);
      const next = Math.round((prev + diff) * 1000) / 1000;

      await tx.update(ingredients).set({ currentQty: String(next) }).where(eq(ingredients.id, ing.id));
      await tx.insert(stockMovements).values({
        type: 'inventory', ingredientId: ing.id,
        quantity: String(diff), previousQty: String(prev), newQty: String(next),
        referenceType: 'audit', referenceId: auditId, staffId,
      });
    }

    const [updated] = await tx.update(inventoryAudits).set({
      status: 'completed', completedBy: staffId, completedAt: new Date(),
    }).where(eq(inventoryAudits.id, auditId)).returning();
    return updated;
  });
  res.json(result);
});

router.post('/audits/:id/cancel', mgr, async (req, res) => {
  const [audit] = await db.select().from(inventoryAudits).where(eq(inventoryAudits.id, +req.params.id));
  if (!audit) return res.status(404).json({ error: 'Not found' });
  if (audit.status !== 'open') return res.status(400).json({ error: 'Audit not open' });
  const [updated] = await db.update(inventoryAudits).set({ status: 'cancelled' }).where(eq(inventoryAudits.id, audit.id)).returning();
  res.json(updated);
});

// ===================== WRITE-OFFS =====================

const WRITE_OFF_AUTO_APPROVE_THRESHOLD = 50; // EUR

router.get('/write-offs', async (req, res) => {
  const where = [];
  if (req.query.status) where.push(eq(writeOffs.status, req.query.status));
  if (req.query.reason) where.push(eq(writeOffs.reason, req.query.reason));
  if (req.query.from) where.push(gte(writeOffs.createdAt, new Date(req.query.from)));
  if (req.query.to) where.push(lte(writeOffs.createdAt, new Date(req.query.to)));

  const rows = await db.select().from(writeOffs)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(writeOffs.createdAt));

  const woIds = rows.map(r => r.id);
  const items = woIds.length
    ? await db.select({
        id: writeOffItems.id, writeOffId: writeOffItems.writeOffId,
        ingredientId: writeOffItems.ingredientId, quantity: writeOffItems.quantity,
        unitCost: writeOffItems.unitCost, totalCost: writeOffItems.totalCost,
        ingredientName: ingredients.name, ingredientUnit: ingredients.unit,
      }).from(writeOffItems)
      .innerJoin(ingredients, eq(writeOffItems.ingredientId, ingredients.id))
      .where(inArray(writeOffItems.writeOffId, woIds))
    : [];

  const staffIds = [...new Set(rows.map(r => r.createdBy).concat(rows.filter(r => r.approvedBy).map(r => r.approvedBy)))];
  const staffRows = staffIds.length ? await db.select({ id: staff.id, name: staff.name }).from(staff).where(inArray(staff.id, staffIds)) : [];
  const staffMap = Object.fromEntries(staffRows.map(s => [s.id, s.name]));

  res.json(rows.map(r => ({
    ...r, totalCost: parseFloat(r.totalCost),
    createdByName: staffMap[r.createdBy] || '—',
    approvedByName: r.approvedBy ? (staffMap[r.approvedBy] || '—') : null,
    items: items.filter(i => i.writeOffId === r.id).map(i => ({
      ...i, quantity: parseFloat(i.quantity), unitCost: parseFloat(i.unitCost), totalCost: parseFloat(i.totalCost),
    })),
  })));
});

router.get('/write-offs/:id', async (req, res) => {
  const [wo] = await db.select().from(writeOffs).where(eq(writeOffs.id, +req.params.id));
  if (!wo) return res.status(404).json({ error: 'Not found' });
  const items = await db.select({
    id: writeOffItems.id, ingredientId: writeOffItems.ingredientId,
    quantity: writeOffItems.quantity, unitCost: writeOffItems.unitCost, totalCost: writeOffItems.totalCost,
    ingredientName: ingredients.name, ingredientUnit: ingredients.unit,
  }).from(writeOffItems)
    .innerJoin(ingredients, eq(writeOffItems.ingredientId, ingredients.id))
    .where(eq(writeOffItems.writeOffId, wo.id));
  res.json({ ...wo, totalCost: parseFloat(wo.totalCost), items: items.map(i => ({ ...i, quantity: parseFloat(i.quantity), unitCost: parseFloat(i.unitCost), totalCost: parseFloat(i.totalCost) })) });
});

router.post('/write-offs', mgr, validate(createWriteOffSchema), async (req, res) => {
  const { reason, note, items: reqItems } = req.body;
  const staffId = req.user.id;
  const userRole = req.user.role;

  const wo = await db.transaction(async (tx) => {
    // Fetch ingredient costs
    const ingIds = reqItems.map(i => i.ingredientId);
    const ings = await tx.select().from(ingredients).where(inArray(ingredients.id, ingIds));
    const ingMap = Object.fromEntries(ings.map(i => [i.id, i]));

    let totalCost = 0;
    const itemValues = reqItems.map(item => {
      const ing = ingMap[item.ingredientId];
      const unitCost = ing ? parseFloat(ing.costPerUnit) : 0;
      const lineCost = Math.round(item.quantity * unitCost * 100) / 100;
      totalCost += lineCost;
      return { ingredientId: item.ingredientId, quantity: String(item.quantity), unitCost: String(unitCost), totalCost: String(lineCost) };
    });

    // Auto-approve if under threshold or user is manager/admin
    const autoApprove = totalCost < WRITE_OFF_AUTO_APPROVE_THRESHOLD || userRole === 'manazer' || userRole === 'admin';

    const [wo] = await tx.insert(writeOffs).values({
      status: autoApprove ? 'approved' : 'pending',
      reason, note, totalCost: String(totalCost), createdBy: staffId,
      approvedBy: autoApprove ? staffId : null,
      approvedAt: autoApprove ? new Date() : null,
    }).returning();

    for (const v of itemValues) {
      await tx.insert(writeOffItems).values({ writeOffId: wo.id, ...v });
    }

    // If auto-approved, deduct stock immediately
    if (autoApprove) {
      await applyWriteOff(tx, wo.id, staffId);
    }

    return wo;
  });

  res.status(201).json({ ...wo, totalCost: parseFloat(wo.totalCost) });
});

router.post('/write-offs/:id/approve', mgr, async (req, res) => {
  if (req.user.role !== 'manazer' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Len manazer alebo admin moze schvalit odpis' });
  }
  const result = await db.transaction(async (tx) => {
    const [wo] = await tx.select().from(writeOffs).where(eq(writeOffs.id, +req.params.id));
    if (!wo) throw new Error('Not found');
    if (wo.status !== 'pending') throw new Error('Odpis nie je v stave na schvalenie');

    const [updated] = await tx.update(writeOffs).set({
      status: 'approved', approvedBy: req.user.id, approvedAt: new Date(),
    }).where(eq(writeOffs.id, wo.id)).returning();

    await applyWriteOff(tx, wo.id, req.user.id);
    return updated;
  });
  res.json({ ...result, totalCost: parseFloat(result.totalCost) });
});

router.post('/write-offs/:id/reject', mgr, async (req, res) => {
  if (req.user.role !== 'manazer' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Len manazer alebo admin moze zamietnuť odpis' });
  }
  const [wo] = await db.select().from(writeOffs).where(eq(writeOffs.id, +req.params.id));
  if (!wo) return res.status(404).json({ error: 'Not found' });
  if (wo.status !== 'pending') return res.status(400).json({ error: 'Odpis nie je v stave na zamietnutie' });
  const [updated] = await db.update(writeOffs).set({
    status: 'rejected', approvedBy: req.user.id, approvedAt: new Date(),
  }).where(eq(writeOffs.id, wo.id)).returning();
  res.json({ ...updated, totalCost: parseFloat(updated.totalCost) });
});

router.get('/write-offs-summary', async (req, res) => {
  const from = req.query.from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const to = req.query.to || new Date().toISOString();

  const rows = await db.select().from(writeOffs)
    .where(and(eq(writeOffs.status, 'approved'), gte(writeOffs.createdAt, new Date(from)), lte(writeOffs.createdAt, new Date(to))));

  const byReason = {};
  let total = 0;
  rows.forEach(r => {
    const cost = parseFloat(r.totalCost);
    total += cost;
    byReason[r.reason] = (byReason[r.reason] || 0) + cost;
  });

  res.json({ total: Math.round(total * 100) / 100, count: rows.length, byReason, from, to });
});

// ===================== ASSETS =====================

router.get('/assets', async (req, res) => {
  const where = req.query.active !== 'false' ? eq(assets.active, true) : undefined;
  const rows = await db.select().from(assets).where(where).orderBy(asc(assets.name));
  res.json(rows.map(a => ({
    ...a, purchasePrice: parseFloat(a.purchasePrice), residualValue: parseFloat(a.residualValue),
    monthlyDepreciation: parseFloat(a.monthlyDepreciation), totalDepreciated: parseFloat(a.totalDepreciated),
    currentValue: parseFloat(a.currentValue),
  })));
});

router.get('/assets/:id', async (req, res) => {
  const [a] = await db.select().from(assets).where(eq(assets.id, +req.params.id));
  if (!a) return res.status(404).json({ error: 'Not found' });
  const deps = await db.select().from(assetDepreciations)
    .where(eq(assetDepreciations.assetId, a.id))
    .orderBy(desc(assetDepreciations.month));
  res.json({
    ...a, purchasePrice: parseFloat(a.purchasePrice), residualValue: parseFloat(a.residualValue),
    monthlyDepreciation: parseFloat(a.monthlyDepreciation), totalDepreciated: parseFloat(a.totalDepreciated),
    currentValue: parseFloat(a.currentValue),
    depreciations: deps.map(d => ({ ...d, amount: parseFloat(d.amount), previousValue: parseFloat(d.previousValue), newValue: parseFloat(d.newValue) })),
  });
});

router.post('/assets', mgr, validate(createAssetSchema), async (req, res) => {
  const { name, category, purchasePrice, purchaseDate, usefulLifeMonths, residualValue, note } = req.body;
  const monthly = Math.round((purchasePrice - residualValue) / usefulLifeMonths * 100) / 100;
  const [a] = await db.insert(assets).values({
    name, category, purchasePrice: String(purchasePrice), purchaseDate: new Date(purchaseDate),
    usefulLifeMonths, residualValue: String(residualValue),
    monthlyDepreciation: String(monthly), currentValue: String(purchasePrice), note,
  }).returning();
  res.status(201).json({ ...a, purchasePrice: parseFloat(a.purchasePrice), monthlyDepreciation: parseFloat(a.monthlyDepreciation), currentValue: parseFloat(a.currentValue) });
});

router.put('/assets/:id', mgr, validate(updateAssetSchema), async (req, res) => {
  const [a] = await db.update(assets).set(req.body).where(eq(assets.id, +req.params.id)).returning();
  if (!a) return res.status(404).json({ error: 'Not found' });
  res.json({ ...a, purchasePrice: parseFloat(a.purchasePrice), currentValue: parseFloat(a.currentValue) });
});

router.delete('/assets/:id', mgr, async (req, res) => {
  await db.update(assets).set({ active: false }).where(eq(assets.id, +req.params.id));
  res.json({ ok: true });
});

router.post('/assets/run-depreciation', mgr, async (req, res) => {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const result = await db.transaction(async (tx) => {
    const allAssets = await tx.select().from(assets).where(eq(assets.active, true));
    let processed = 0;

    for (const a of allAssets) {
      const currentVal = parseFloat(a.currentValue);
      const residual = parseFloat(a.residualValue);
      const monthly = parseFloat(a.monthlyDepreciation);
      if (currentVal <= residual || monthly <= 0) continue;

      // Check if already depreciated this month
      const [existing] = await tx.select().from(assetDepreciations)
        .where(and(eq(assetDepreciations.assetId, a.id), eq(assetDepreciations.month, monthStart)));
      if (existing) continue;

      const amount = Math.min(monthly, currentVal - residual);
      const newVal = Math.round((currentVal - amount) * 100) / 100;

      await tx.insert(assetDepreciations).values({
        assetId: a.id, month: monthStart, amount: String(amount),
        previousValue: String(currentVal), newValue: String(newVal),
      });

      await tx.update(assets).set({
        totalDepreciated: String(Math.round((parseFloat(a.totalDepreciated) + amount) * 100) / 100),
        currentValue: String(newVal),
      }).where(eq(assets.id, a.id));

      processed++;
    }
    return { processed, month: monthStart.toISOString().slice(0, 7) };
  });
  res.json(result);
});

router.get('/assets-summary', async (req, res) => {
  const allAssets = await db.select().from(assets).where(eq(assets.active, true));
  let totalValue = 0, totalMonthly = 0, totalPurchase = 0;
  allAssets.forEach(a => {
    totalValue += parseFloat(a.currentValue);
    totalMonthly += parseFloat(a.monthlyDepreciation);
    totalPurchase += parseFloat(a.purchasePrice);
  });
  res.json({
    count: allAssets.length,
    totalPurchasePrice: Math.round(totalPurchase * 100) / 100,
    totalCurrentValue: Math.round(totalValue * 100) / 100,
    totalMonthlyDepreciation: Math.round(totalMonthly * 100) / 100,
  });
});

export default router;
