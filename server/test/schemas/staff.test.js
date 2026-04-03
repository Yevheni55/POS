import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createStaffSchema, updateStaffSchema } from '../../schemas/staff.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertFails(schema, input) {
  assert.throws(
    () => schema.parse(input),
    (err) => err.constructor.name === 'ZodError',
  );
}

function assertPasses(schema, input) {
  return schema.parse(input);
}

// ---------------------------------------------------------------------------
// createStaffSchema
// ---------------------------------------------------------------------------

describe('createStaffSchema', () => {
  const validStaff = { name: 'Jana Novak', pin: '1234', role: 'cisnik' };

  it('accepts a fully valid staff member', () => {
    const result = assertPasses(createStaffSchema, validStaff);
    assert.equal(result.name, 'Jana Novak');
    assert.equal(result.pin, '1234');
    assert.equal(result.role, 'cisnik');
  });

  it('defaults role to "cisnik" when omitted', () => {
    const result = assertPasses(createStaffSchema, { name: 'Peter', pin: '0000' });
    assert.equal(result.role, 'cisnik');
  });

  it('accepts role "manazer"', () => {
    const result = assertPasses(createStaffSchema, {
      name: 'Anna',
      pin: '5678',
      role: 'manazer',
    });
    assert.equal(result.role, 'manazer');
  });

  it('accepts role "admin"', () => {
    const result = assertPasses(createStaffSchema, {
      name: 'Boss',
      pin: '9999',
      role: 'admin',
    });
    assert.equal(result.role, 'admin');
  });

  describe('name validation', () => {
    it('fails when name is empty string', () => {
      assertFails(createStaffSchema, { ...validStaff, name: '' });
    });

    it('fails when name is missing', () => {
      assertFails(createStaffSchema, { pin: '1234' });
    });

    it('accepts a name with exactly 1 character', () => {
      const result = assertPasses(createStaffSchema, { ...validStaff, name: 'A' });
      assert.equal(result.name, 'A');
    });

    it('accepts a name with exactly 100 characters', () => {
      const result = assertPasses(createStaffSchema, {
        ...validStaff,
        name: 'x'.repeat(100),
      });
      assert.equal(result.name.length, 100);
    });

    it('fails when name exceeds 100 characters', () => {
      assertFails(createStaffSchema, { ...validStaff, name: 'x'.repeat(101) });
    });

    it('accepts names with special characters and spaces', () => {
      const result = assertPasses(createStaffSchema, {
        ...validStaff,
        name: 'Ján Nováček-Šimák',
      });
      assert.equal(result.name, 'Ján Nováček-Šimák');
    });
  });

  describe('pin validation', () => {
    it('fails when pin has fewer than 4 characters', () => {
      assertFails(createStaffSchema, { ...validStaff, pin: '123' });
    });

    it('accepts a pin with exactly 4 characters (minimum)', () => {
      const result = assertPasses(createStaffSchema, { ...validStaff, pin: '1234' });
      assert.equal(result.pin, '1234');
    });

    it('accepts a pin with exactly 20 characters (maximum)', () => {
      const result = assertPasses(createStaffSchema, {
        ...validStaff,
        pin: '12345678901234567890',
      });
      assert.equal(result.pin.length, 20);
    });

    it('fails when pin exceeds 20 characters', () => {
      assertFails(createStaffSchema, { ...validStaff, pin: '1'.repeat(21) });
    });

    it('fails when pin is missing', () => {
      assertFails(createStaffSchema, { name: 'Test' });
    });

    it('accepts alphanumeric pins', () => {
      const result = assertPasses(createStaffSchema, { ...validStaff, pin: 'abcd1234' });
      assert.equal(result.pin, 'abcd1234');
    });
  });

  describe('role validation', () => {
    it('fails for an unknown role', () => {
      assertFails(createStaffSchema, { ...validStaff, role: 'superuser' });
    });

    it('fails for an empty role string', () => {
      assertFails(createStaffSchema, { ...validStaff, role: '' });
    });

    it('is case-sensitive — "Cisnik" is not valid', () => {
      assertFails(createStaffSchema, { ...validStaff, role: 'Cisnik' });
    });

    it('is case-sensitive — "ADMIN" is not valid', () => {
      assertFails(createStaffSchema, { ...validStaff, role: 'ADMIN' });
    });
  });
});

// ---------------------------------------------------------------------------
// updateStaffSchema
// ---------------------------------------------------------------------------

describe('updateStaffSchema', () => {
  it('accepts an empty object (all fields optional)', () => {
    const result = assertPasses(updateStaffSchema, {});
    assert.equal(result.name, undefined);
    assert.equal(result.pin, undefined);
    assert.equal(result.role, undefined);
    assert.equal(result.active, undefined);
  });

  it('accepts only name', () => {
    const result = assertPasses(updateStaffSchema, { name: 'Lukas' });
    assert.equal(result.name, 'Lukas');
  });

  it('accepts only pin', () => {
    const result = assertPasses(updateStaffSchema, { pin: '4321' });
    assert.equal(result.pin, '4321');
  });

  it('accepts only role', () => {
    const result = assertPasses(updateStaffSchema, { role: 'manazer' });
    assert.equal(result.role, 'manazer');
  });

  it('accepts only active = false', () => {
    const result = assertPasses(updateStaffSchema, { active: false });
    assert.equal(result.active, false);
  });

  it('accepts only active = true', () => {
    const result = assertPasses(updateStaffSchema, { active: true });
    assert.equal(result.active, true);
  });

  it('accepts all fields together', () => {
    const result = assertPasses(updateStaffSchema, {
      name: 'Eva',
      pin: '8888',
      role: 'admin',
      active: true,
    });
    assert.equal(result.name, 'Eva');
    assert.equal(result.pin, '8888');
    assert.equal(result.role, 'admin');
    assert.equal(result.active, true);
  });

  describe('name validation when provided', () => {
    it('fails when name is an empty string', () => {
      assertFails(updateStaffSchema, { name: '' });
    });

    it('fails when name exceeds 100 characters', () => {
      assertFails(updateStaffSchema, { name: 'x'.repeat(101) });
    });
  });

  describe('pin validation when provided', () => {
    it('fails when pin has fewer than 4 characters', () => {
      assertFails(updateStaffSchema, { pin: '12' });
    });

    it('fails when pin exceeds 20 characters', () => {
      assertFails(updateStaffSchema, { pin: '1'.repeat(21) });
    });
  });

  describe('role validation when provided', () => {
    it('fails for an unknown role', () => {
      assertFails(updateStaffSchema, { role: 'waiter' });
    });

    it('fails for role "superadmin"', () => {
      assertFails(updateStaffSchema, { role: 'superadmin' });
    });

    it('accepts all three valid roles', () => {
      for (const role of ['cisnik', 'manazer', 'admin']) {
        const result = assertPasses(updateStaffSchema, { role });
        assert.equal(result.role, role);
      }
    });
  });

  describe('active field when provided', () => {
    it('fails when active is a string instead of boolean', () => {
      assertFails(updateStaffSchema, { active: 'true' });
    });

    it('fails when active is a number', () => {
      assertFails(updateStaffSchema, { active: 1 });
    });
  });
});
