import fs from 'fs';
import jwt from 'jsonwebtoken';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import { Server as SocketServer } from 'socket.io';

import { app, ALLOWED_ORIGINS } from './app.js';
import { startIdempotencyCleanup } from './middleware/idempotency.js';
import { startPrintQueue } from './routes/print.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3080;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;

// HTTP server
const httpServer = createServer(app);

// HTTPS server (self-signed cert for PWA fullscreen on LAN)
let httpsServer = null;
try {
  const certPath = path.join(__dirname, 'certs');
  const sslKey = fs.readFileSync(path.join(certPath, 'key.pem'));
  const sslCert = fs.readFileSync(path.join(certPath, 'cert.pem'));
  httpsServer = createHttpsServer({ key: sslKey, cert: sslCert }, app);
} catch (e) { /* no certs = no HTTPS, that's fine */ }

const ioServer = httpsServer || httpServer;
const io = new SocketServer(ioServer, { cors: { origin: ALLOWED_ORIGINS } });
// Also attach to HTTP server if HTTPS exists
if (httpsServer) new SocketServer(httpServer, { cors: { origin: ALLOWED_ORIGINS } });

// Auth middleware for sockets
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('No token'));
  try {
    socket.user = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  console.log('WS connected:', socket.user.name);
  socket.on('disconnect', () => console.log('WS disconnected:', socket.user.name));
});

// Make io available to routes
app.set('io', io);

// Crash logging
const LOG_FILE = path.join(__dirname, 'crash.log');

function logCrash(type, err) {
  const entry = `[${new Date().toISOString()}] ${type}: ${err.stack || err}\n`;
  fs.appendFileSync(LOG_FILE, entry);
  console.error(entry);
}

process.on('uncaughtException', (err) => {
  logCrash('UNCAUGHT_EXCEPTION', err);
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  logCrash('UNHANDLED_REJECTION', err);
});

process.on('SIGTERM', () => { logCrash('SIGNAL', new Error('SIGTERM')); process.exit(0); });
process.on('SIGINT', () => { logCrash('SIGNAL', new Error('SIGINT')); process.exit(0); });

httpServer.listen(PORT, () => {
  const msg = `[${new Date().toISOString()}] Server started on port ${PORT}\n`;
  fs.appendFileSync(LOG_FILE, msg);
  const loginUrl = `http://localhost:${PORT}/login.html`;
  console.log(`POS server running on http://localhost:${PORT}`);
  console.log(`Open POS login: ${loginUrl}`);
  if (Number(PORT) !== 3000) {
    console.log('(If http://localhost:3000 shows 404, another app is using port 3000 — use the URL above.)');
  }
  startIdempotencyCleanup();
  startPrintQueue();
});

if (httpsServer) {
  httpsServer.listen(HTTPS_PORT, () => {
    console.log(`POS HTTPS running on https://localhost:${HTTPS_PORT}`);
  });
}
