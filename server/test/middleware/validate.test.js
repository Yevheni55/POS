import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockReq(body = {}) {
  return { body };
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
// Test schemas
// ---------------------------------------------------------------------------

const nameSchema = z.object({ name: z.string() });

const strictSchema = z.object({
  name: z.string().min(1),
  age: z.number().int().positive(),
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validate middleware', () => {
  describe('valid input', () => {
    it('calls next() when body matches the schema', () => {
      const middleware = validate(nameSchema);
      const req = mockReq({ name: 'Jan' });
      const res = mockRes();
      let nextCalled = false;

      middleware(req, res, () => { nextCalled = true; });

      assert.equal(nextCalled, true);
      assert.equal(res.getStatus(), 200);
    });

    it('replaces req.body with the parsed (coerced) output', () => {
      const coerceSchema = z.object({ count: z.coerce.number() });
      const middleware = validate(coerceSchema);
      const req = mockReq({ count: '42' });
      const res = mockRes();

      middleware(req, res, () => {});

      assert.equal(req.body.count, 42);
    });

    it('strips extra fields that are not in the schema', () => {
      const middleware = validate(nameSchema);
      const req = mockReq({ name: 'Maria', secret: 'leaked' });
      const res = mockRes();

      middleware(req, res, () => {});

      assert.equal(req.body.name, 'Maria');
      assert.equal('secret' in req.body, false);
    });

    it('preserves default values added by the schema', () => {
      const schemaWithDefault = z.object({
        name: z.string(),
        active: z.boolean().default(true),
      });
      const middleware = validate(schemaWithDefault);
      const req = mockReq({ name: 'Test' });
      const res = mockRes();

      middleware(req, res, () => {});

      assert.equal(req.body.active, true);
    });
  });

  describe('invalid input', () => {
    it('returns 400 when a required field is missing', () => {
      const middleware = validate(nameSchema);
      const req = mockReq({});
      const res = mockRes();
      let nextCalled = false;

      middleware(req, res, (err) => { nextCalled = true; });

      assert.equal(res.getStatus(), 400);
      assert.equal(nextCalled, false);
    });

    it('returns the Slovak error label "Neplatne data"', () => {
      const middleware = validate(nameSchema);
      const req = mockReq({});
      const res = mockRes();

      middleware(req, res, () => {});

      assert.equal(res.getData().error, 'Neplatne data');
    });

    it('includes a details array in the 400 response', () => {
      const middleware = validate(nameSchema);
      const req = mockReq({ name: 123 });
      const res = mockRes();

      middleware(req, res, () => {});

      const data = res.getData();
      assert.ok(Array.isArray(data.details));
      assert.ok(data.details.length > 0);
    });

    it('each detail has a path and message string', () => {
      const middleware = validate(strictSchema);
      const req = mockReq({ name: '', age: -1 });
      const res = mockRes();

      middleware(req, res, () => {});

      const { details } = res.getData();
      for (const detail of details) {
        assert.equal(typeof detail.path, 'string');
        assert.equal(typeof detail.message, 'string');
      }
    });

    it('dot-joins nested field paths', () => {
      const nested = z.object({
        address: z.object({ city: z.string() }),
      });
      const middleware = validate(nested);
      const req = mockReq({ address: { city: 99 } });
      const res = mockRes();

      middleware(req, res, () => {});

      const { details } = res.getData();
      const paths = details.map((d) => d.path);
      assert.ok(paths.some((p) => p === 'address.city'));
    });

    it('returns 400 when body is null', () => {
      const middleware = validate(nameSchema);
      const req = mockReq(null);
      const res = mockRes();

      middleware(req, res, () => {});

      assert.equal(res.getStatus(), 400);
    });

    it('reports multiple field errors in a single response', () => {
      const middleware = validate(strictSchema);
      const req = mockReq({});
      const res = mockRes();

      middleware(req, res, () => {});

      const { details } = res.getData();
      assert.ok(details.length >= 2);
    });
  });

  describe('non-Zod errors', () => {
    it('forwards unexpected errors to next(err)', () => {
      const boom = new Error('unexpected');
      const throwingSchema = {
        parse() { throw boom; },
      };
      const middleware = validate(throwingSchema);
      const req = mockReq({ name: 'x' });
      const res = mockRes();
      let forwarded = null;

      middleware(req, res, (err) => { forwarded = err; });

      assert.strictEqual(forwarded, boom);
      // must NOT have set a status on res
      assert.equal(res.getStatus(), 200);
    });
  });
});
