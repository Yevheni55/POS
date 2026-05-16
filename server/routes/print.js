// Thin router — each endpoint's body lives in server/lib/print/<name>.js.
// Shared helpers (format/network/queue/tickets) sit in server/lib/print/.
// Re-exports startPrintQueue so server/server.js can keep its existing
// `import { startPrintQueue } from './routes/print.js'`.

import { Router } from 'express';

import { requireRole } from '../middleware/requireRole.js';

import { kitchenHandler } from '../lib/print/kitchen.js';
import { lockCodeHandler } from '../lib/print/lockcode.js';
import { paragonHandler } from '../lib/print/paragon.js';
import { preBillHandler } from '../lib/print/pre-bill.js';
import {
  queueDeleteHandler,
  queueListHandler,
  queueRetryHandler,
} from '../lib/print/queue-handlers.js';
import { receiptHandler } from '../lib/print/receipt.js';
import { testHandler } from '../lib/print/test.js';
import { zReportHandler } from '../lib/print/z-report.js';

export { startPrintQueue } from '../lib/print/queue.js';

const router = Router();
const mgr = requireRole('manazer', 'admin');

router.post('/kitchen',         kitchenHandler);
router.post('/receipt',         receiptHandler);
router.post('/paragon',         paragonHandler);
router.post('/pre-bill',        preBillHandler);
router.post('/z-report',   mgr, zReportHandler);
router.post('/lockcode',        lockCodeHandler);
router.get('/test',             testHandler);
router.get('/queue',            queueListHandler);
router.post('/queue/retry',     queueRetryHandler);
router.delete('/queue/:id',     queueDeleteHandler);

export default router;
