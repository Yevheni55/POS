import jwt from 'jsonwebtoken';

// JWT auth middleware. Verifies Bearer token against JWT_SECRET (HS256 only)
// and attaches decoded payload to req.user. Responds 401 on missing or invalid
// token.
export function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'Token chyba' });

  const token = header.replace('Bearer ', '');
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    next();
  } catch {
    res.status(401).json({ error: 'Neplatny token' });
  }
}
