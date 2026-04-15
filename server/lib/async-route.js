/**
 * Wraps an async Express route handler so that rejected promises
 * are forwarded to Express's error handler instead of hanging.
 * Express 4 does not do this automatically.
 */
export const asyncRoute = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
