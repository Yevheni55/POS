import { Router } from 'express';
import { requireRole } from '../middleware/requireRole.js';
import { getStatus } from '../lib/portos.js';

const router = Router();

router.get('/status', requireRole('manazer', 'admin'), async (req, res) => {
  try {
    const status = await getStatus();
    res.json(status);
  } catch (error) {
    console.error('Portos status error:', error);
    res.status(503).json({ error: 'Nepodarilo sa nacitat stav Portos', detail: error.message });
  }
});

export default router;
