import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

/**
 * Generate a valid JWT token for test requests.
 * @param {object} payload — { id, name, role }
 * @returns {string} Bearer-ready JWT token
 */
export function makeToken(payload = { id: 1, name: 'Test', role: 'cisnik' }) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h', algorithm: 'HS256' });
}

/**
 * Pre-built tokens for common test roles.
 */
export const tokens = {
  cisnik: () => makeToken({ id: 1, name: 'Test Cisnik', role: 'cisnik' }),
  manazer: () => makeToken({ id: 2, name: 'Test Manazer', role: 'manazer' }),
  admin: () => makeToken({ id: 3, name: 'Test Admin', role: 'admin' }),
};
