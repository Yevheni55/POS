// Thin router — each endpoint's body lives in server/lib/payments/<name>.js
// so this file stays a routing manifest instead of a 1.3k-LOC monolith.
// Shared helpers (constants, fiscal-document, fiscal-resolve, context) sit
// in server/lib/payments/.
//
// STORNO_ELIGIBLE_MODES is re-exported below because
// server/routes/fiscal-documents.js still imports it from this module.

import { Router } from 'express';

import { requireRole } from '../middleware/requireRole.js';
import { validate } from '../middleware/validate.js';
import { asyncRoute } from '../lib/async-route.js';
import {
  changePaymentMethodSchema,
  createPaymentSchema,
} from '../schemas/payments.js';

import { changeMethodHandler } from '../lib/payments/change-method.js';
import { createPaymentHandler } from '../lib/payments/create.js';
import { fiscalGetHandler } from '../lib/payments/fiscal-get.js';
import { fiscalStornoHandler } from '../lib/payments/fiscal-storno.js';
import { historyHandler } from '../lib/payments/history.js';
import { receiptCopyHandler } from '../lib/payments/receipt-copy.js';
import { refiscalizeHandler } from '../lib/payments/refiscalize.js';

export { STORNO_ELIGIBLE_MODES } from '../lib/payments/shared.js';

const router = Router();
const mgr = requireRole('manazer', 'admin');
const staff = requireRole('cisnik', 'manazer', 'admin');

router.post('/',                  staff, validate(createPaymentSchema),       asyncRoute(createPaymentHandler));
router.get('/history',            mgr,                                        asyncRoute(historyHandler));
router.get('/:id/fiscal',         mgr,                                        asyncRoute(fiscalGetHandler));
router.post('/:id/receipt-copy',                                              asyncRoute(receiptCopyHandler));
router.post('/:id/refiscalize',   mgr,                                        asyncRoute(refiscalizeHandler));
router.post('/:id/change-method', mgr, validate(changePaymentMethodSchema),   asyncRoute(changeMethodHandler));
router.post('/:id/fiscal-storno', mgr,                                        asyncRoute(fiscalStornoHandler));

export default router;
