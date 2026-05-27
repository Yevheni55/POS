import jwt from 'jsonwebtoken';
const secret = process.env.JWT_SECRET || 'change-me-in-production';
const token = jwt.sign({ id: 1, name: 'admin', role: 'admin' }, secret, { expiresIn: '4h' });
console.log(token);
