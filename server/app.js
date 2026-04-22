import './load-env.js';
import express from 'express';
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';

import authRoutes from './routes/auth.js';
import healthRoutes from './routes/health.js';
import menuRoutes from './routes/menu.js';
import tablesRoutes from './routes/tables.js';
import ordersRoutes from './routes/orders.js';
import staffRoutes from './routes/staff.js';
import paymentsRoutes from './routes/payments.js';
import reportsRoutes from './routes/reports.js';
import printRoutes from './routes/print.js';
import shiftRoutes from './routes/shifts.js';
import discountRoutes from './routes/discounts.js';
import printerRoutes from './routes/printers.js';
import eventsRoutes from './routes/events.js';
import inventoryRoutes from './routes/inventory.js';
import invoiceScanRoutes from './routes/invoice-scan.js';
import ttlockRoutes from './routes/ttlock.js';
import portosRoutes from './routes/portos.js';
import companyProfileRoutes from './routes/company-profile.js';
import fiscalDocumentsRoutes from './routes/fiscal-documents.js';
import { idempotency } from './middleware/idempotency.js';
import { auth } from './middleware/auth.js';
import { ALLOWED_ORIGINS, corsOriginCallback } from './lib/cors-origin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

// PR-2.3: allow req.ip to honour X-Forwarded-For when running behind a
// reverse proxy (Docker, nginx, etc). Must be set BEFORE any middleware.
// Default 0 = do not trust any proxy (preserves current single-machine
// behaviour). Set TRUST_PROXY=1 when deploying behind a single proxy hop.
app.set('trust proxy', Number(process.env.TRUST_PROXY || 0));

// Middleware
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));
app.use(compression());
app.use(cors({ origin: corsOriginCallback }));
app.use(express.json({ limit: '20mb' }));

// Serve fonts with long cache (1 year)
app.use('/fonts', express.static(path.join(__dirname, '..', 'fonts'), {
  maxAge: '365d',
  immutable: true
}));

// Serve frontend files from parent directory
app.use(express.static(path.join(__dirname, '..'), { maxAge: 0 }));

// Public routes (no auth needed)
app.use('/api/auth', authRoutes);
app.use('/api/health', healthRoutes);

// Idempotency middleware for write operations
app.use('/api', idempotency);

// Protected routes
app.use('/api/menu', auth, menuRoutes);
app.use('/api/tables', auth, tablesRoutes);
app.use('/api/orders', auth, ordersRoutes);
app.use('/api/staff', auth, staffRoutes);
app.use('/api/payments', auth, paymentsRoutes);
app.use('/api/reports', auth, reportsRoutes);
app.use('/api/print', auth, printRoutes);
app.use('/api/shifts', auth, shiftRoutes);
app.use('/api/discounts', auth, discountRoutes);
app.use('/api/printers', auth, printerRoutes);
app.use('/api/events', auth, eventsRoutes);
app.use('/api/inventory', auth, inventoryRoutes);
app.use('/api/invoice-scan', auth, invoiceScanRoutes);
app.use('/api/ttlock', auth, ttlockRoutes);
app.use('/api/integrations/portos', auth, portosRoutes);
app.use('/api/company-profile', auth, companyProfileRoutes);
app.use('/api/fiscal-documents', auth, fiscalDocumentsRoutes);

// SPA fallback
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, '..', 'login.html'));
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

export { app, ALLOWED_ORIGINS, auth };
