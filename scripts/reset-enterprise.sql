-- Úplný reset prevádzky: čistý podnik bez menu, skladu, stolov, zliav, tlačiarní a histórie objednávok/platieb.
-- Ponechá: staff (aby sa dalo prihlásiť) + company_profiles (identita firmy z Portos sa auto-synchronizuje).
-- Sekvencie ID sa resetujú na 1.

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
  fiscal_documents,
  discounts,
  printers,
  tables,
  shifts,
  events,
  idempotency_keys,
  print_queue
RESTART IDENTITY CASCADE;

SELECT
  (SELECT COUNT(*) FROM staff)              AS staff,
  (SELECT COUNT(*) FROM company_profiles)   AS company_profiles,
  (SELECT COUNT(*) FROM tables)             AS tables,
  (SELECT COUNT(*) FROM menu_items)         AS menu_items,
  (SELECT COUNT(*) FROM menu_categories)    AS menu_categories,
  (SELECT COUNT(*) FROM ingredients)        AS ingredients,
  (SELECT COUNT(*) FROM suppliers)          AS suppliers,
  (SELECT COUNT(*) FROM purchase_orders)    AS purchase_orders,
  (SELECT COUNT(*) FROM discounts)          AS discounts,
  (SELECT COUNT(*) FROM printers)           AS printers,
  (SELECT COUNT(*) FROM shifts)             AS shifts,
  (SELECT COUNT(*) FROM orders)             AS orders,
  (SELECT COUNT(*) FROM payments)           AS payments,
  (SELECT COUNT(*) FROM fiscal_documents)   AS fiscal_documents,
  (SELECT COUNT(*) FROM assets)             AS assets;
