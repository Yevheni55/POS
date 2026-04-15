import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createOrderSchema,
  addItemsSchema,
  updateItemSchema,
  batchSchema,
  splitSchema,
  discountSchema,
} from '../../schemas/orders.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Assert that parsing `input` against `schema` throws a ZodError. */
function assertFails(schema, input) {
  assert.throws(
    () => schema.parse(input),
    (err) => err.constructor.name === 'ZodError',
  );
}

/** Assert that parsing succeeds and return the parsed value. */
function assertPasses(schema, input) {
  return schema.parse(input);
}

// ---------------------------------------------------------------------------
// createOrderSchema
// ---------------------------------------------------------------------------

describe('createOrderSchema', () => {
  const validOrder = {
    tableId: 1,
    items: [{ menuItemId: 5, qty: 2, note: 'no onions' }],
  };

  it('accepts a fully valid order', () => {
    const result = assertPasses(createOrderSchema, validOrder);
    assert.equal(result.tableId, 1);
    assert.equal(result.items.length, 1);
  });

  it('coerces string tableId to number', () => {
    const result = assertPasses(createOrderSchema, { ...validOrder, tableId: '3' });
    assert.equal(result.tableId, 3);
  });

  it('fails when tableId is missing', () => {
    assertFails(createOrderSchema, { items: validOrder.items });
  });

  it('fails when tableId is zero', () => {
    assertFails(createOrderSchema, { ...validOrder, tableId: 0 });
  });

  it('fails when tableId is negative', () => {
    assertFails(createOrderSchema, { ...validOrder, tableId: -1 });
  });

  it('fails when tableId is not a number string', () => {
    assertFails(createOrderSchema, { ...validOrder, tableId: 'abc' });
  });

  it('allows empty items array (new blank account)', () => {
    const result = assertPasses(createOrderSchema, { tableId: 1, items: [] });
    assert.deepEqual(result.items, []);
  });

  it('defaults items to empty array when missing', () => {
    const result = assertPasses(createOrderSchema, { tableId: 1 });
    assert.deepEqual(result.items, []);
  });

  it('fails when menuItemId is zero', () => {
    assertFails(createOrderSchema, {
      tableId: 1,
      items: [{ menuItemId: 0, qty: 1 }],
    });
  });

  it('fails when menuItemId is missing from an item', () => {
    assertFails(createOrderSchema, {
      tableId: 1,
      items: [{ qty: 1 }],
    });
  });

  it('defaults qty to 1 when omitted', () => {
    const result = assertPasses(createOrderSchema, {
      tableId: 1,
      items: [{ menuItemId: 5 }],
    });
    assert.equal(result.items[0].qty, 1);
  });

  it('defaults note to empty string when omitted', () => {
    const result = assertPasses(createOrderSchema, {
      tableId: 1,
      items: [{ menuItemId: 5 }],
    });
    assert.equal(result.items[0].note, '');
  });

  it('rejects a note longer than 200 characters', () => {
    assertFails(createOrderSchema, {
      tableId: 1,
      items: [{ menuItemId: 5, note: 'x'.repeat(201) }],
    });
  });

  it('accepts an optional label up to 20 characters', () => {
    const result = assertPasses(createOrderSchema, {
      ...validOrder,
      label: 'Table A',
    });
    assert.equal(result.label, 'Table A');
  });

  it('rejects a label longer than 20 characters', () => {
    assertFails(createOrderSchema, {
      ...validOrder,
      label: 'x'.repeat(21),
    });
  });

  it('accepts multiple items', () => {
    const result = assertPasses(createOrderSchema, {
      tableId: 2,
      items: [
        { menuItemId: 1, qty: 1 },
        { menuItemId: 2, qty: 3, note: 'extra sauce' },
      ],
    });
    assert.equal(result.items.length, 2);
  });
});

// ---------------------------------------------------------------------------
// addItemsSchema
// ---------------------------------------------------------------------------

describe('addItemsSchema', () => {
  const validPayload = {
    items: [{ menuItemId: 7, qty: 1 }],
  };

  it('accepts a valid payload', () => {
    const result = assertPasses(addItemsSchema, validPayload);
    assert.equal(result.items.length, 1);
  });

  it('fails when items is empty', () => {
    assertFails(addItemsSchema, { items: [] });
  });

  it('fails when menuItemId is not a positive integer', () => {
    assertFails(addItemsSchema, { items: [{ menuItemId: -5 }] });
  });

  it('fails when menuItemId is a non-numeric string', () => {
    assertFails(addItemsSchema, { items: [{ menuItemId: 'bad' }] });
  });

  it('defaults qty to 1', () => {
    const result = assertPasses(addItemsSchema, {
      items: [{ menuItemId: 3 }],
    });
    assert.equal(result.items[0].qty, 1);
  });

  it('accepts an optional version', () => {
    const result = assertPasses(addItemsSchema, { ...validPayload, version: 5 });
    assert.equal(result.version, 5);
  });

  it('coerces string version to number', () => {
    const result = assertPasses(addItemsSchema, { ...validPayload, version: '2' });
    assert.equal(result.version, 2);
  });

  it('accepts when version is omitted', () => {
    const result = assertPasses(addItemsSchema, validPayload);
    assert.equal(result.version, undefined);
  });
});

// ---------------------------------------------------------------------------
// updateItemSchema
// ---------------------------------------------------------------------------

describe('updateItemSchema', () => {
  it('accepts an empty object (all fields optional)', () => {
    const result = assertPasses(updateItemSchema, {});
    assert.equal(result.qty, undefined);
    assert.equal(result.note, undefined);
    assert.equal(result.version, undefined);
  });

  it('accepts qty of 0 (remove item)', () => {
    const result = assertPasses(updateItemSchema, { qty: 0 });
    assert.equal(result.qty, 0);
  });

  it('fails when qty is negative', () => {
    assertFails(updateItemSchema, { qty: -1 });
  });

  it('accepts a note string', () => {
    const result = assertPasses(updateItemSchema, { note: 'extra spicy' });
    assert.equal(result.note, 'extra spicy');
  });

  it('rejects a note longer than 200 characters', () => {
    assertFails(updateItemSchema, { note: 'x'.repeat(201) });
  });

  it('accepts a version integer', () => {
    const result = assertPasses(updateItemSchema, { version: 10 });
    assert.equal(result.version, 10);
  });

  it('coerces string qty to number', () => {
    const result = assertPasses(updateItemSchema, { qty: '3' });
    assert.equal(result.qty, 3);
  });
});

// ---------------------------------------------------------------------------
// batchSchema
// ---------------------------------------------------------------------------

describe('batchSchema', () => {
  const addOp = { action: 'add', menuItemId: 1, qty: 1 };
  const updateOp = { action: 'update', itemId: 10, qty: 2 };
  const removeOp = { action: 'remove', itemId: 10 };

  it('accepts a valid add operation', () => {
    const result = assertPasses(batchSchema, { operations: [addOp] });
    assert.equal(result.operations[0].action, 'add');
  });

  it('accepts a valid update operation', () => {
    const result = assertPasses(batchSchema, { operations: [updateOp] });
    assert.equal(result.operations[0].action, 'update');
  });

  it('accepts a valid remove operation', () => {
    const result = assertPasses(batchSchema, { operations: [removeOp] });
    assert.equal(result.operations[0].action, 'remove');
  });

  it('accepts multiple mixed operations', () => {
    const result = assertPasses(batchSchema, {
      operations: [addOp, updateOp, removeOp],
    });
    assert.equal(result.operations.length, 3);
  });

  it('fails when operations array is empty', () => {
    assertFails(batchSchema, { operations: [] });
  });

  it('fails when operations is missing', () => {
    assertFails(batchSchema, {});
  });

  it('fails when action is an unknown value', () => {
    assertFails(batchSchema, {
      operations: [{ action: 'delete', itemId: 1 }],
    });
  });

  it('accepts optional top-level version', () => {
    const result = assertPasses(batchSchema, { operations: [addOp], version: 3 });
    assert.equal(result.version, 3);
  });

  it('fails when menuItemId is zero', () => {
    assertFails(batchSchema, {
      operations: [{ action: 'add', menuItemId: 0 }],
    });
  });
});

// ---------------------------------------------------------------------------
// splitSchema
// ---------------------------------------------------------------------------

describe('splitSchema', () => {
  it('accepts parts = 2 (minimum)', () => {
    const result = assertPasses(splitSchema, { parts: 2 });
    assert.equal(result.parts, 2);
  });

  it('accepts parts = 10 (maximum)', () => {
    const result = assertPasses(splitSchema, { parts: 10 });
    assert.equal(result.parts, 10);
  });

  it('fails when parts = 1 (below minimum)', () => {
    assertFails(splitSchema, { parts: 1 });
  });

  it('fails when parts = 11 (above maximum)', () => {
    assertFails(splitSchema, { parts: 11 });
  });

  it('fails when parts = 0', () => {
    assertFails(splitSchema, { parts: 0 });
  });

  it('accepts an empty object (all fields optional)', () => {
    const result = assertPasses(splitSchema, {});
    assert.equal(result.parts, undefined);
  });

  it('accepts itemGroups as an array of arrays of integers', () => {
    const result = assertPasses(splitSchema, {
      itemGroups: [[1, 2], [3, 4]],
    });
    assert.deepEqual(result.itemGroups, [[1, 2], [3, 4]]);
  });

  it('coerces string parts to number', () => {
    const result = assertPasses(splitSchema, { parts: '3' });
    assert.equal(result.parts, 3);
  });
});

// ---------------------------------------------------------------------------
// discountSchema
// ---------------------------------------------------------------------------

describe('discountSchema', () => {
  it('accepts an empty object (all fields optional)', () => {
    const result = assertPasses(discountSchema, {});
    assert.equal(result.discountId, undefined);
    assert.equal(result.customPercent, undefined);
  });

  it('accepts customPercent = 0', () => {
    const result = assertPasses(discountSchema, { customPercent: 0 });
    assert.equal(result.customPercent, 0);
  });

  it('accepts customPercent = 100', () => {
    const result = assertPasses(discountSchema, { customPercent: 100 });
    assert.equal(result.customPercent, 100);
  });

  it('accepts customPercent = 50.5 (decimal)', () => {
    const result = assertPasses(discountSchema, { customPercent: 50.5 });
    assert.equal(result.customPercent, 50.5);
  });

  it('fails when customPercent is below 0', () => {
    assertFails(discountSchema, { customPercent: -1 });
  });

  it('fails when customPercent is above 100', () => {
    assertFails(discountSchema, { customPercent: 101 });
  });

  it('accepts a valid discountId', () => {
    const result = assertPasses(discountSchema, { discountId: 7 });
    assert.equal(result.discountId, 7);
  });

  it('accepts an optional version', () => {
    const result = assertPasses(discountSchema, { version: 2 });
    assert.equal(result.version, 2);
  });

  it('coerces string customPercent to number', () => {
    const result = assertPasses(discountSchema, { customPercent: '25' });
    assert.equal(result.customPercent, 25);
  });

  it('accepts all three optional fields together', () => {
    const result = assertPasses(discountSchema, {
      discountId: 1,
      customPercent: 10,
      version: 4,
    });
    assert.equal(result.discountId, 1);
    assert.equal(result.customPercent, 10);
    assert.equal(result.version, 4);
  });
});
