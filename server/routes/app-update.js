// Android tablet auto-update — servíruje manifest + APK pre natívnu appku
// (android-tablet/). Súbory ležia na durable volume /backups/app (pos_backups),
// takže prežijú redeploy/rebuild image. Publikácia novej verzie = docker cp
// APK + latest.json do pos-app-1:/backups/app (viď android-tablet/README.md).
//
//   GET /api/app/latest    → latest.json { versionCode, versionName, url, notes }
//   GET /api/app/download  → SurfSpiritPOS.apk (stream)
//
// PUBLIC (bez auth) — UpdateGate v appke beží aj pred prihlásením; APK nad
// LAN/Tailscale je nízko-citlivý. Mountuje sa v app.js v public sekcii.

import { Router } from 'express';
import fs from 'fs';
import path from 'path';

const router = Router();
const APP_DIR = path.join(process.env.BACKUP_DIR || '/backups', 'app');
const MANIFEST = path.join(APP_DIR, 'latest.json');
const APK = path.join(APP_DIR, 'SurfSpiritPOS.apk');

// GET /api/app/latest — verzia. Ak manifest chýba, vráť versionCode 0
// (appka to vyhodnotí ako "žiadny update").
router.get('/latest', (req, res) => {
  try {
    if (!fs.existsSync(MANIFEST)) {
      return res.json({ versionCode: 0, versionName: '', url: '', notes: '' });
    }
    res.type('application/json').send(fs.readFileSync(MANIFEST, 'utf8'));
  } catch (e) {
    res.json({ versionCode: 0, versionName: '', url: '', notes: '' });
  }
});

// GET /api/app/download — APK stream.
router.get('/download', (req, res) => {
  if (!fs.existsSync(APK)) return res.status(404).json({ error: 'APK nie je nahraté' });
  res.type('application/vnd.android.package-archive');
  res.setHeader('Content-Disposition', 'attachment; filename="SurfSpiritPOS.apk"');
  fs.createReadStream(APK).pipe(res);
});

export default router;
