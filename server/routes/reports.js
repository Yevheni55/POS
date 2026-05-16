// Thin router — each endpoint's body lives in server/lib/reports/<name>.js
// so this file stays a routing manifest instead of a 1.4k-LOC monolith.
// Shared helpers (TZ, roundMoney) sit in server/lib/reports/shared.js.

import { Router } from 'express';

import { requireRole } from '../middleware/requireRole.js';

import { summaryHandler } from '../lib/reports/summary.js';
import { weatherHandler } from '../lib/reports/weather.js';
import { weeklyHandler } from '../lib/reports/weekly.js';
import { zReportHandler } from '../lib/reports/z-report.js';
import { exportHandler } from '../lib/reports/export.js';
import { staffHandler } from '../lib/reports/staff.js';

const router = Router();
const mgr = requireRole('manazer', 'admin');

router.get('/summary',  mgr, summaryHandler);
router.get('/weather',  mgr, weatherHandler);
router.get('/weekly',   mgr, weeklyHandler);
router.get('/z-report', mgr, zReportHandler);
router.get('/export',   mgr, exportHandler);
router.get('/staff',    mgr, staffHandler);

export default router;
