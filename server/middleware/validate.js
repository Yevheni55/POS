import { ZodError } from 'zod';

/**
 * Express middleware factory for validating request body with a Zod schema.
 * Uses parse() which strips unknown fields and coerces types as defined.
 */
export function validate(schema) {
  return (req, res, next) => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (e) {
      if (e instanceof ZodError) {
        return res.status(400).json({
          error: 'Neplatne data',
          details: e.errors.map(err => ({ path: err.path.join('.'), message: err.message })),
        });
      }
      next(e);
    }
  };
}
