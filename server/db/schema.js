import { pgTable, serial, text, integer, numeric, boolean, timestamp, varchar, index, uniqueIndex } from 'drizzle-orm/pg-core';

export const staff = pgTable('staff', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  pin: varchar('pin', { length: 255 }).notNull(),
  role: varchar('role', { length: 20 }).notNull().default('cisnik'),
  active: boolean('active').notNull().default(true),
  // Attendance / payroll. attendance_pin is a separate bcrypt hash so
  // a leaked POS PIN can't be used to clock anyone in/out, and vice versa.
  position: varchar('position', { length: 50 }).notNull().default(''),
  hourlyRate: numeric('hourly_rate', { precision: 8, scale: 2 }),
  attendancePin: varchar('attendance_pin', { length: 60 }),
  createdAt: timestamp('created_at').defaultNow(),
});

// Shisha — interný counter mimo fiškálneho obehu. Každý klik tlačidla v admin
// vloží jeden riadok. Slúži iba pre naše účtovníctvo.
export const shishaSales = pgTable('shisha_sales', {
  id: serial('id').primaryKey(),
  staffId: integer('staff_id').references(() => staff.id),
  soldAt: timestamp('sold_at', { withTimezone: true }).defaultNow().notNull(),
  price: numeric('price', { precision: 8, scale: 2 }).notNull().default('17.00'),
});

// Manual cashflow ledger — owner-recorded incomes and expenses that aren't
// already captured by the automated POS payment / shisha sale flows.
// Categories are validated against a frontend constant list but stored as
// free-text so adding a new bucket later doesn't need a migration.
export const cashflowEntries = pgTable('cashflow_entries', {
  id: serial('id').primaryKey(),
  type: varchar('type', { length: 20 }).notNull(), // 'income' | 'expense'
  category: varchar('category', { length: 50 }).notNull(),
  amount: numeric('amount', { precision: 10, scale: 2 }).notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  method: varchar('method', { length: 20 }).notNull().default('cash'),
  note: varchar('note', { length: 500 }).notNull().default(''),
  staffId: integer('staff_id').references(() => staff.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('cashflow_occurred_idx').on(t.occurredAt),
  index('cashflow_type_occurred_idx').on(t.type, t.occurredAt),
]);

// Storno basket — bucket pre stornované sent položky. Cashier `−` na
// poslanej položke → zápis sem (žiaden stock change). Admin v Storno
// stránke spracuje (resolve) → vtedy sa spustí stock revert / write-off
// podľa zachyteného wasPrepared + reason.
export const stornoBasket = pgTable('storno_basket', {
  id: serial('id').primaryKey(),
  menuItemId: integer('menu_item_id').notNull().references(() => menuItems.id),
  qty: integer('qty').notNull().default(1),
  itemName: varchar('item_name', { length: 100 }).notNull(),
  unitPrice: numeric('unit_price', { precision: 8, scale: 2 }).notNull().default('0'),
  note: varchar('note', { length: 200 }).notNull().default(''),
  reason: varchar('reason', { length: 50 }).notNull().default('other'),
  // wasPrepared=true → jedlo bolo urobené, write-off (peniaze von)
  // wasPrepared=false → jedlo sa nestihlo urobiť, return to stock
  wasPrepared: boolean('was_prepared').notNull().default(false),
  orderId: integer('order_id'),
  staffId: integer('staff_id').references(() => staff.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolvedByStaffId: integer('resolved_by_staff_id').references(() => staff.id),
});

export const tables = pgTable('tables', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 50 }).notNull(),
  seats: integer('seats').notNull().default(4),
  zone: varchar('zone', { length: 50 }).notNull().default('interior'),
  shape: varchar('shape', { length: 20 }).notNull().default('rect'),
  x: integer('x').notNull().default(0),
  y: integer('y').notNull().default(0),
  status: varchar('status', { length: 20 }).notNull().default('free'),
});

// User-editable zone labels. The slug stays the primary identifier (and
// remains on tables.zone) so existing data needs no migration; the label
// is what's shown in every UI. Auto-seeded from distinct tables.zone
// values on first request when the table is empty.
export const zones = pgTable('zones', {
  slug: varchar('slug', { length: 50 }).primaryKey(),
  label: varchar('label', { length: 50 }).notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
});

export const menuCategories = pgTable('menu_categories', {
  id: serial('id').primaryKey(),
  slug: varchar('slug', { length: 50 }).notNull().unique(),
  label: varchar('label', { length: 100 }).notNull(),
  icon: varchar('icon', { length: 10 }).notNull(),
  sortKey: varchar('sort_key', { length: 5 }).notNull(),
  dest: varchar('dest', { length: 20 }).notNull().default('bar'),
});

export const menuItems = pgTable('menu_items', {
  id: serial('id').primaryKey(),
  categoryId: integer('category_id').notNull().references(() => menuCategories.id),
  name: varchar('name', { length: 100 }).notNull(),
  emoji: varchar('emoji', { length: 10 }).notNull(),
  price: numeric('price', { precision: 8, scale: 2 }).notNull(),
  vatRate: numeric('vat_rate', { precision: 5, scale: 2 }).notNull().default('20.00'),
  desc: varchar('desc', { length: 200 }).notNull().default(''),
  active: boolean('active').notNull().default(true),
  trackMode: varchar('track_mode', { length: 10 }).notNull().default('none'),
  stockQty: numeric('stock_qty', { precision: 10, scale: 3 }).notNull().default('0'),
  minStockQty: numeric('min_stock_qty', { precision: 10, scale: 3 }).notNull().default('0'),
  // Companion item that POS auto-adds alongside this one (e.g. glass-bottle deposit).
  // Client-side auto-adds/removes/syncs qty; null means no companion.
  companionMenuItemId: integer('companion_menu_item_id'),
  // Optional photo, served from /uploads/menu/<id>.<ext>. Null falls back to emoji.
  imageUrl: varchar('image_url', { length: 255 }),
});

export const shifts = pgTable('shifts', {
  id: serial('id').primaryKey(),
  staffId: integer('staff_id').notNull().references(() => staff.id),
  openedAt: timestamp('opened_at').defaultNow(),
  closedAt: timestamp('closed_at'),
  openingCash: numeric('opening_cash', { precision: 10, scale: 2 }).notNull().default('0'),
  closingCash: numeric('closing_cash', { precision: 10, scale: 2 }),
  status: varchar('status', { length: 20 }).notNull().default('open'),
}, (t) => [
  index('shifts_staff_status_idx').on(t.staffId, t.status),
]);

export const discounts = pgTable('discounts', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  type: varchar('type', { length: 10 }).notNull().default('percent'),
  value: numeric('value', { precision: 8, scale: 2 }).notNull(),
  active: boolean('active').notNull().default(true),
});

export const orders = pgTable('orders', {
  id: serial('id').primaryKey(),
  tableId: integer('table_id').notNull().references(() => tables.id),
  staffId: integer('staff_id').notNull().references(() => staff.id),
  shiftId: integer('shift_id').references(() => shifts.id),
  status: varchar('status', { length: 20 }).notNull().default('open'),
  label: varchar('label', { length: 20 }).notNull().default('Ucet 1'),
  discountId: integer('discount_id').references(() => discounts.id),
  discountAmount: numeric('discount_amount', { precision: 10, scale: 2 }),
  createdAt: timestamp('created_at').defaultNow(),
  closedAt: timestamp('closed_at'),
  version: integer('version').notNull().default(1),
}, (t) => [
  index('orders_table_status_idx').on(t.tableId, t.status),
  index('orders_status_created_idx').on(t.status, t.createdAt),
]);

export const orderItems = pgTable('order_items', {
  id: serial('id').primaryKey(),
  orderId: integer('order_id').notNull().references(() => orders.id),
  menuItemId: integer('menu_item_id').notNull().references(() => menuItems.id),
  qty: integer('qty').notNull().default(1),
  note: varchar('note', { length: 200 }).notNull().default(''),
  sent: boolean('sent').notNull().default(false),
}, (t) => [
  index('order_items_order_id_idx').on(t.orderId),
  index('order_items_menu_item_idx').on(t.menuItemId),
]);

export const printers = pgTable('printers', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  ip: varchar('ip', { length: 45 }).notNull(),
  port: integer('port').notNull().default(9100),
  dest: varchar('dest', { length: 20 }).notNull().default('all'),
  active: boolean('active').notNull().default(true),
});

export const orderEvents = pgTable('order_events', {
  id: serial('id').primaryKey(),
  orderId: integer('order_id').notNull().references(() => orders.id, { onDelete: 'cascade' }),
  type: varchar('type', { length: 30 }).notNull(),
  payload: text('payload').notNull().default('{}'),
  staffId: integer('staff_id').notNull().references(() => staff.id),
  createdAt: timestamp('created_at').defaultNow(),
}, (t) => [
  index('order_events_order_id_idx').on(t.orderId, t.createdAt),
]);

export const events = pgTable('events', {
  id: serial('id').primaryKey(),
  type: varchar('type', { length: 50 }).notNull(),
  payload: text('payload').notNull().default('{}'),
  createdAt: timestamp('created_at').defaultNow(),
});

export const idempotencyKeys = pgTable('idempotency_keys', {
  key: varchar('key', { length: 64 }).primaryKey(),
  statusCode: integer('status_code').notNull(),
  response: text('response').notNull().default('{}'),
  createdAt: timestamp('created_at').defaultNow(),
});

export const payments = pgTable('payments', {
  id: serial('id').primaryKey(),
  orderId: integer('order_id').notNull().references(() => orders.id),
  method: varchar('method', { length: 20 }).notNull(),
  amount: numeric('amount', { precision: 10, scale: 2 }).notNull(),
  createdAt: timestamp('created_at').defaultNow(),
}, (t) => [
  uniqueIndex('payments_order_id_uidx').on(t.orderId),
]);

export const companyProfiles = pgTable('company_profiles', {
  id: serial('id').primaryKey(),
  businessName: varchar('business_name', { length: 150 }).notNull().default(''),
  ico: varchar('ico', { length: 32 }).notNull().default(''),
  dic: varchar('dic', { length: 32 }).notNull().default(''),
  icDph: varchar('ic_dph', { length: 32 }).notNull().default(''),
  registeredAddress: varchar('registered_address', { length: 250 }).notNull().default(''),
  branchName: varchar('branch_name', { length: 150 }).notNull().default(''),
  branchAddress: varchar('branch_address', { length: 250 }).notNull().default(''),
  cashRegisterCode: varchar('cash_register_code', { length: 32 }).notNull().default(''),
  contactPhone: varchar('contact_phone', { length: 50 }).notNull().default(''),
  contactEmail: varchar('contact_email', { length: 120 }).notNull().default(''),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const fiscalDocuments = pgTable('fiscal_documents', {
  id: serial('id').primaryKey(),
  sourceType: varchar('source_type', { length: 20 }).notNull().default('payment'),
  sourceId: integer('source_id'),
  orderId: integer('order_id').references(() => orders.id),
  paymentId: integer('payment_id').references(() => payments.id),
  externalId: varchar('external_id', { length: 120 }).notNull(),
  cashRegisterCode: varchar('cash_register_code', { length: 32 }).notNull(),
  requestType: varchar('request_type', { length: 30 }).notNull(),
  httpStatus: integer('http_status'),
  resultMode: varchar('result_mode', { length: 40 }).notNull(),
  isSuccessful: boolean('is_successful'),
  receiptId: varchar('receipt_id', { length: 120 }),
  receiptNumber: integer('receipt_number'),
  okp: varchar('okp', { length: 120 }),
  portosRequestId: varchar('portos_request_id', { length: 64 }),
  printerName: varchar('printer_name', { length: 50 }),
  processDate: timestamp('process_date'),
  requestJson: text('request_json').notNull().default('{}'),
  responseJson: text('response_json').notNull().default('{}'),
  errorCode: integer('error_code'),
  errorDetail: text('error_detail').notNull().default(''),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (t) => [
  uniqueIndex('fiscal_documents_external_id_uidx').on(t.externalId),
  index('fiscal_documents_order_idx').on(t.orderId),
  index('fiscal_documents_payment_idx').on(t.paymentId),
  index('fiscal_documents_mode_idx').on(t.resultMode, t.createdAt),
]);

// ===================== PRINT QUEUE =====================

export const printQueue = pgTable('print_queue', {
  id: serial('id').primaryKey(),
  endpoint: varchar('endpoint', { length: 30 }).notNull(),
  payload: text('payload').notNull(),
  printerIp: varchar('printer_ip', { length: 45 }).notNull(),
  printerPort: integer('printer_port').notNull().default(9100),
  attempts: integer('attempts').notNull().default(0),
  lastError: varchar('last_error', { length: 300 }).notNull().default(''),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  createdAt: timestamp('created_at').defaultNow(),
  nextRetryAt: timestamp('next_retry_at').defaultNow(),
}, (t) => [
  index('pq_status_retry_idx').on(t.status, t.nextRetryAt),
]);

// ===================== INVENTORY =====================

export const ingredients = pgTable('ingredients', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  unit: varchar('unit', { length: 10 }).notNull(),
  type: varchar('type', { length: 10 }).notNull().default('ingredient'),
  currentQty: numeric('current_qty', { precision: 12, scale: 3 }).notNull().default('0'),
  minQty: numeric('min_qty', { precision: 12, scale: 3 }).notNull().default('0'),
  costPerUnit: numeric('cost_per_unit', { precision: 10, scale: 4 }).notNull().default('0'),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow(),
}, (t) => [
  index('ingredients_name_idx').on(t.name),
  index('ingredients_type_idx').on(t.type),
]);

export const recipes = pgTable('recipes', {
  id: serial('id').primaryKey(),
  menuItemId: integer('menu_item_id').notNull().references(() => menuItems.id, { onDelete: 'cascade' }),
  ingredientId: integer('ingredient_id').notNull().references(() => ingredients.id, { onDelete: 'cascade' }),
  qtyPerUnit: numeric('qty_per_unit', { precision: 10, scale: 3 }).notNull(),
}, (t) => [
  index('recipes_menu_item_idx').on(t.menuItemId),
  index('recipes_ingredient_idx').on(t.ingredientId),
]);

export const stockMovements = pgTable('stock_movements', {
  id: serial('id').primaryKey(),
  type: varchar('type', { length: 20 }).notNull(),
  ingredientId: integer('ingredient_id').references(() => ingredients.id),
  menuItemId: integer('menu_item_id').references(() => menuItems.id),
  quantity: numeric('quantity', { precision: 12, scale: 3 }).notNull(),
  previousQty: numeric('previous_qty', { precision: 12, scale: 3 }).notNull(),
  newQty: numeric('new_qty', { precision: 12, scale: 3 }).notNull(),
  referenceType: varchar('reference_type', { length: 20 }),
  referenceId: integer('reference_id'),
  note: varchar('note', { length: 200 }).notNull().default(''),
  staffId: integer('staff_id').notNull().references(() => staff.id),
  createdAt: timestamp('created_at').defaultNow(),
}, (t) => [
  index('stock_mv_ingredient_idx').on(t.ingredientId),
  index('stock_mv_menu_item_idx').on(t.menuItemId),
  index('stock_mv_type_idx').on(t.type, t.createdAt),
]);

export const suppliers = pgTable('suppliers', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  contactPerson: varchar('contact_person', { length: 100 }).notNull().default(''),
  phone: varchar('phone', { length: 30 }).notNull().default(''),
  email: varchar('email', { length: 100 }).notNull().default(''),
  notes: text('notes').notNull().default(''),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow(),
});

export const purchaseOrders = pgTable('purchase_orders', {
  id: serial('id').primaryKey(),
  supplierId: integer('supplier_id').notNull().references(() => suppliers.id),
  status: varchar('status', { length: 20 }).notNull().default('draft'),
  totalCost: numeric('total_cost', { precision: 12, scale: 2 }).notNull().default('0'),
  note: varchar('note', { length: 500 }).notNull().default(''),
  imageData: text('image_data'),
  createdBy: integer('created_by').notNull().references(() => staff.id),
  receivedBy: integer('received_by').references(() => staff.id),
  createdAt: timestamp('created_at').defaultNow(),
  receivedAt: timestamp('received_at'),
}, (t) => [
  index('po_supplier_idx').on(t.supplierId),
  index('po_status_idx').on(t.status, t.createdAt),
]);

export const purchaseOrderItems = pgTable('purchase_order_items', {
  id: serial('id').primaryKey(),
  purchaseOrderId: integer('purchase_order_id').notNull().references(() => purchaseOrders.id, { onDelete: 'cascade' }),
  ingredientId: integer('ingredient_id').notNull().references(() => ingredients.id),
  quantity: numeric('quantity', { precision: 12, scale: 3 }).notNull(),
  invoiceUnit: varchar('invoice_unit', { length: 20 }).notNull().default(''),
  conversionFactor: numeric('conversion_factor', { precision: 12, scale: 4 }).notNull().default('1'),
  unitCost: numeric('unit_cost', { precision: 10, scale: 4 }).notNull(),
  totalCost: numeric('total_cost', { precision: 12, scale: 2 }).notNull(),
}, (t) => [
  index('poi_po_idx').on(t.purchaseOrderId),
]);

export const inventoryAudits = pgTable('inventory_audits', {
  id: serial('id').primaryKey(),
  status: varchar('status', { length: 20 }).notNull().default('open'),
  note: varchar('note', { length: 500 }).notNull().default(''),
  createdBy: integer('created_by').notNull().references(() => staff.id),
  completedBy: integer('completed_by').references(() => staff.id),
  createdAt: timestamp('created_at').defaultNow(),
  completedAt: timestamp('completed_at'),
});

export const inventoryAuditItems = pgTable('inventory_audit_items', {
  id: serial('id').primaryKey(),
  auditId: integer('audit_id').notNull().references(() => inventoryAudits.id, { onDelete: 'cascade' }),
  ingredientId: integer('ingredient_id').notNull().references(() => ingredients.id),
  expectedQty: numeric('expected_qty', { precision: 12, scale: 3 }).notNull(),
  actualQty: numeric('actual_qty', { precision: 12, scale: 3 }),
  difference: numeric('difference', { precision: 12, scale: 3 }),
}, (t) => [
  index('audit_items_audit_idx').on(t.auditId),
]);

// ===================== WRITE-OFFS =====================

export const writeOffs = pgTable('write_offs', {
  id: serial('id').primaryKey(),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  reason: varchar('reason', { length: 20 }).notNull(),
  note: varchar('note', { length: 500 }).notNull().default(''),
  totalCost: numeric('total_cost', { precision: 12, scale: 2 }).notNull().default('0'),
  createdBy: integer('created_by').notNull().references(() => staff.id),
  approvedBy: integer('approved_by').references(() => staff.id),
  createdAt: timestamp('created_at').defaultNow(),
  approvedAt: timestamp('approved_at'),
}, (t) => [
  index('write_offs_status_idx').on(t.status, t.createdAt),
]);

export const writeOffItems = pgTable('write_off_items', {
  id: serial('id').primaryKey(),
  writeOffId: integer('write_off_id').notNull().references(() => writeOffs.id, { onDelete: 'cascade' }),
  ingredientId: integer('ingredient_id').notNull().references(() => ingredients.id),
  quantity: numeric('quantity', { precision: 12, scale: 3 }).notNull(),
  unitCost: numeric('unit_cost', { precision: 10, scale: 4 }).notNull(),
  totalCost: numeric('total_cost', { precision: 12, scale: 2 }).notNull(),
}, (t) => [
  index('wo_items_wo_idx').on(t.writeOffId),
]);

// ===================== ASSETS =====================

export const assets = pgTable('assets', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  category: varchar('category', { length: 50 }).notNull().default('other'),
  purchasePrice: numeric('purchase_price', { precision: 12, scale: 2 }).notNull(),
  purchaseDate: timestamp('purchase_date').notNull(),
  usefulLifeMonths: integer('useful_life_months').notNull(),
  residualValue: numeric('residual_value', { precision: 12, scale: 2 }).notNull().default('0'),
  monthlyDepreciation: numeric('monthly_depreciation', { precision: 12, scale: 2 }).notNull(),
  totalDepreciated: numeric('total_depreciated', { precision: 12, scale: 2 }).notNull().default('0'),
  currentValue: numeric('current_value', { precision: 12, scale: 2 }).notNull(),
  active: boolean('active').notNull().default(true),
  note: varchar('note', { length: 500 }).notNull().default(''),
  createdAt: timestamp('created_at').defaultNow(),
});

export const assetDepreciations = pgTable('asset_depreciations', {
  id: serial('id').primaryKey(),
  assetId: integer('asset_id').notNull().references(() => assets.id, { onDelete: 'cascade' }),
  month: timestamp('month').notNull(),
  amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
  previousValue: numeric('previous_value', { precision: 12, scale: 2 }).notNull(),
  newValue: numeric('new_value', { precision: 12, scale: 2 }).notNull(),
  createdAt: timestamp('created_at').defaultNow(),
}, (t) => [
  index('asset_dep_asset_idx').on(t.assetId),
]);

// ===================== AUTH ATTEMPTS =====================
// PR-2.3: DB-backed per-account PIN lockout. Replaces the in-memory IP-keyed
// limiter that collapses to a single IP inside Docker. See routes/auth.js.
export const authAttempts = pgTable('auth_attempts', {
  id: serial('id').primaryKey(),
  staffId: integer('staff_id').references(() => staff.id),
  ip: varchar('ip', { length: 45 }).notNull().default(''),
  success: boolean('success').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow(),
}, (t) => [
  index('auth_attempts_staff_created_idx').on(t.staffId, t.createdAt),
  index('auth_attempts_ip_created_idx').on(t.ip, t.createdAt),
]);

// ===================== ATTENDANCE =====================

export const attendanceEvents = pgTable('attendance_events', {
  id: serial('id').primaryKey(),
  staffId: integer('staff_id').notNull().references(() => staff.id),
  // 'clock_in' or 'clock_out'. Kept as varchar to mirror the existing
  // schema style instead of a Drizzle enum (no migration churn).
  type: varchar('type', { length: 12 }).notNull(),
  at: timestamp('at').notNull().defaultNow(),
  // 'pin' for the dochadzka.html terminal, 'manual' for admin overrides.
  source: varchar('source', { length: 20 }).notNull().default('pin'),
  note: varchar('note', { length: 200 }).notNull().default(''),
  // For source='manual': required reason from a fixed enum (forgot,
  // wrong_time, shift_change, pin_failed, other). NULL for PIN-driven
  // and auto_close rows so the column is always meaningful.
  reason: varchar('reason', { length: 20 }),
  // For manual edits: who entered/edited the row.
  editedBy: integer('edited_by').references(() => staff.id),
}, (t) => [
  index('attendance_events_staff_at_idx').on(t.staffId, t.at),
  index('attendance_events_at_idx').on(t.at),
]);
