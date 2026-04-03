import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { requireRole } from '../../middleware/requireRole.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockReq(user = null) {
  return { user };
}

function mockRes() {
  let _status = 200;
  let _json = null;
  return {
    status(s) { _status = s; return this; },
    json(d) { _json = d; return this; },
    getStatus() { return _status; },
    getData() { return _json; },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('requireRole middleware', () => {
  describe('when no req.user is present', () => {
    it('returns 403 with Slovak error message', () => {
      const middleware = requireRole('admin');
      const req = mockReq(null);
      const res = mockRes();
      let nextCalled = false;

      middleware(req, res, () => { nextCalled = true; });

      assert.equal(res.getStatus(), 403);
      assert.deepEqual(res.getData(), { error: 'Pristup odmietnuty' });
      assert.equal(nextCalled, false);
    });
  });

  describe('when user role is not in the allowed list', () => {
    it('blocks cisnik from an admin-only route', () => {
      const middleware = requireRole('admin');
      const req = mockReq({ role: 'cisnik' });
      const res = mockRes();
      let nextCalled = false;

      middleware(req, res, () => { nextCalled = true; });

      assert.equal(res.getStatus(), 403);
      assert.deepEqual(res.getData(), { error: 'Pristup odmietnuty' });
      assert.equal(nextCalled, false);
    });

    it('blocks cisnik from a manazer-only route', () => {
      const middleware = requireRole('manazer');
      const req = mockReq({ role: 'cisnik' });
      const res = mockRes();
      let nextCalled = false;

      middleware(req, res, () => { nextCalled = true; });

      assert.equal(res.getStatus(), 403);
      assert.equal(nextCalled, false);
    });

    it('blocks manazer from an admin-only route', () => {
      const middleware = requireRole('admin');
      const req = mockReq({ role: 'manazer' });
      const res = mockRes();
      let nextCalled = false;

      middleware(req, res, () => { nextCalled = true; });

      assert.equal(res.getStatus(), 403);
      assert.equal(nextCalled, false);
    });
  });

  describe('when user role is in the allowed list', () => {
    it('allows manazer on a route that accepts manazer and admin', () => {
      const middleware = requireRole('manazer', 'admin');
      const req = mockReq({ role: 'manazer' });
      const res = mockRes();
      let nextCalled = false;

      middleware(req, res, () => { nextCalled = true; });

      assert.equal(nextCalled, true);
      // status must not have been set to an error code
      assert.equal(res.getStatus(), 200);
    });

    it('allows admin on an admin-only route', () => {
      const middleware = requireRole('admin');
      const req = mockReq({ role: 'admin' });
      const res = mockRes();
      let nextCalled = false;

      middleware(req, res, () => { nextCalled = true; });

      assert.equal(nextCalled, true);
      assert.equal(res.getStatus(), 200);
    });

    it('allows admin on a route that accepts manazer and admin', () => {
      const middleware = requireRole('manazer', 'admin');
      const req = mockReq({ role: 'admin' });
      const res = mockRes();
      let nextCalled = false;

      middleware(req, res, () => { nextCalled = true; });

      assert.equal(nextCalled, true);
    });

    it('allows cisnik when cisnik is in the allowed list', () => {
      const middleware = requireRole('cisnik', 'manazer', 'admin');
      const req = mockReq({ role: 'cisnik' });
      const res = mockRes();
      let nextCalled = false;

      middleware(req, res, () => { nextCalled = true; });

      assert.equal(nextCalled, true);
    });
  });

  describe('edge cases', () => {
    it('blocks everyone when the roles list is empty', () => {
      const middleware = requireRole();
      const req = mockReq({ role: 'admin' });
      const res = mockRes();
      let nextCalled = false;

      middleware(req, res, () => { nextCalled = true; });

      assert.equal(res.getStatus(), 403);
      assert.deepEqual(res.getData(), { error: 'Pristup odmietnuty' });
      assert.equal(nextCalled, false);
    });

    it('blocks when user object has no role property', () => {
      const middleware = requireRole('admin');
      const req = mockReq({});
      const res = mockRes();
      let nextCalled = false;

      middleware(req, res, () => { nextCalled = true; });

      assert.equal(res.getStatus(), 403);
      assert.equal(nextCalled, false);
    });

    it('is case-sensitive — does not match "Admin" against "admin"', () => {
      const middleware = requireRole('admin');
      const req = mockReq({ role: 'Admin' });
      const res = mockRes();
      let nextCalled = false;

      middleware(req, res, () => { nextCalled = true; });

      assert.equal(res.getStatus(), 403);
      assert.equal(nextCalled, false);
    });

    it('returns the same middleware function for multiple role arguments', () => {
      const middleware = requireRole('cisnik', 'manazer', 'admin');
      assert.equal(typeof middleware, 'function');
    });
  });
});
