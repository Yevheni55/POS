import jwt from 'jsonwebtoken';

// JWT auth middleware. Verifies Bearer token against JWT_SECRET (HS256 only)
// and attaches decoded payload to req.user. Responds 401 on missing or invalid
// token.
export function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'Token chyba' });

  // RFC 7235 §2.1: scheme is case-insensitive. Plain string `.replace('Bearer ', '')`
  // silently passes the raw header value to jwt.verify on `bearer xyz`, breaking
  // clients that lowercase the scheme.
  const token = header.replace(/^bearer\s+/i, '');
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    next();
  } catch {
    res.status(401).json({ error: 'Neplatny token' });
  }
}
