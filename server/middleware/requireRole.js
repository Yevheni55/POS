/**
 * Express middleware factory for role-based authorization.
 * Usage: requireRole('manazer', 'admin') — allows only those roles.
 */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Pristup odmietnuty' });
    }
    next();
  };
}
