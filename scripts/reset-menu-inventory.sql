-- Vyčistí menu, sklad a všetky naviazané objednávky/platby/fiškálne doklady na kase.
-- Ponechá: staff, tables, discounts, printers, company_profiles, shifts, events, idempotency_keys, print_queue.

TRUNCATE TABLE
  menu_items,
  menu_categories,
  recipes,
  ingredients,
  stock_movements,
  suppliers,
  purchase_orders,
  purchase_order_items,
  inventory_audits,
  inventory_audit_items,
  write_offs,
  write_off_items,
  assets,
  asset_depreciations,
  order_items,
  order_events,
  orders,
  payments,
  fiscal_documents
RESTART IDENTITY CASCADE;

SELECT
  (SELECT COUNT(*) FROM menu_items)         AS menu_items,
  (SELECT COUNT(*) FROM menu_categories)    AS menu_categories,
  (SELECT COUNT(*) FROM ingredients)        AS ingredients,
  (SELECT COUNT(*) FROM recipes)            AS recipes,
  (SELECT COUNT(*) FROM suppliers)          AS suppliers,
  (SELECT COUNT(*) FROM purchase_orders)    AS purchase_orders,
  (SELECT COUNT(*) FROM orders)             AS orders,
  (SELECT COUNT(*) FROM payments)           AS payments,
  (SELECT COUNT(*) FROM fiscal_documents)   AS fiscal_documents,
  (SELECT COUNT(*) FROM assets)             AS assets;
