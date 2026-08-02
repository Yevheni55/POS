import { desc, eq } from 'drizzle-orm';

import { db } from '../db/index.js';
import { companyProfiles } from '../db/schema.js';
import {
  hasUsablePortosIdentity,
  mapPortosIdentityFromStatus,
  mergePortosIdentityIntoProfileRow,
} from './company-profile-from-portos.js';
import { getStatus, isPortosEnabled } from './portos.js';

const DEFAULT_INTERVAL_MS = Number.parseInt(process.env.PORTOS_PROFILE_SYNC_MS || '300000', 10) || 300000;

/**
 * Kým sa profil ANI RAZ nezosynchronizoval, nemá zmysel čakať plných 5 minút — POS by dovtedy
 * pracoval so starým `company_profiles` riadkom (starý kód pokladne, starý režim DPH).
 * Preto krátky backoff 15 s → 30 s → 60 s (potom drž 60 s) a na DEFAULT_INTERVAL_MS
 * prepneme až po PRVOM úspechu.
 */
const COLD_BACKOFF_MS = Object.freeze([15_000, 30_000, 60_000]);

let timer = null;
let syncInFlight = null;
let lastSyncAt = null;
let lastError = null;
let attempts = 0;
let coldRetries = 0;
let steadyIntervalMs = DEFAULT_INTERVAL_MS;
let scheduledDelayMs = COLD_BACKOFF_MS[0];
// Beží plánovač? Bez tohto by `stop()` počas rozbehnutého syncu neplatil —
// jeho `.finally(scheduleNext)` by si naplánoval ďalšie kolo aj po zastavení.
let schedulerActive = false;

async function loadProfileRow() {
  const [row] = await db.select().from(companyProfiles).orderBy(desc(companyProfiles.id)).limit(1);
  return row || null;
}

/** @returns {Promise<{ok:true,changed:boolean}|{ok:false,error:string}>} */
export async function runPortosProfileSync({ timeoutMs } = {}) {
  if (syncInFlight) return syncInFlight;

  attempts += 1;
  const task = (async () => {
    let cancel;
    const abort = new Promise((_, reject) => {
      cancel = setTimeout(() => reject(new Error('Portos profile sync timeout')), Number(timeoutMs) || 15000);
    });
    try {
      const status = await Promise.race([getStatus(), abort]);
      if (!hasUsablePortosIdentity(status)) {
        const reason = status?.errors?.identity || (status?.identityCount === 0
          ? 'Portos nevrátil žiadnu identitu (identityCount=0)'
          : 'Portos returned no usable identity');
        lastError = String(reason);
        console.warn(`[Portos] Profile sync skipped: ${lastError}`);
        return { ok: false, error: lastError };
      }

      const portosFields = mapPortosIdentityFromStatus(status);
      const existing = await loadProfileRow();
      const merged = mergePortosIdentityIntoProfileRow(portosFields, existing);

      let changed = false;
      if (!existing) {
        await db.insert(companyProfiles).values({ ...merged, updatedAt: new Date() });
        changed = true;
      } else {
        const fieldsToCompare = [
          'businessName', 'ico', 'dic', 'icDph',
          'registeredAddress', 'branchName', 'branchAddress', 'cashRegisterCode',
        ];
        const differs = fieldsToCompare.some(
          (key) => String(existing[key] ?? '').trim() !== String(merged[key] ?? '').trim(),
        );
        if (differs) {
          await db.update(companyProfiles)
            .set({ ...merged, updatedAt: new Date() })
            .where(eq(companyProfiles.id, existing.id));
          changed = true;
        }
      }

      lastSyncAt = new Date();
      lastError = null;
      console.log(
        `[Portos] Company profile sync OK at ${lastSyncAt.toISOString()} ` +
        `(changed=${changed}, businessName="${portosFields.businessName}", cashRegister="${portosFields.cashRegisterCode}")`,
      );
      return { ok: true, changed, portosFields };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastError = message;
      console.warn(`[Portos] Profile sync error: ${message}`);
      return { ok: false, error: message };
    } finally {
      clearTimeout(cancel);
    }
  })();

  syncInFlight = task.finally(() => { syncInFlight = null; });
  return syncInFlight;
}

function nextDelayMs() {
  // Po prvom úspechu ideme do pokojného 5-minútového režimu.
  if (lastSyncAt) return steadyIntervalMs;
  const idx = Math.min(coldRetries, COLD_BACKOFF_MS.length - 1);
  return COLD_BACKOFF_MS[idx];
}

function scheduleNext() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  // PORTOS_ENABLED=false → žiadny sync, žiadne cyklenie.
  if (!schedulerActive || !isPortosEnabled()) return;

  const delayMs = nextDelayMs();
  scheduledDelayMs = delayMs;
  // Stupeň backoffu sa posúva až po naplánovaní, aby PRVÝ retry prišiel o 15 s.
  if (!lastSyncAt) coldRetries += 1;

  timer = setTimeout(() => {
    timer = null;
    runPortosProfileSync()
      .catch(() => { /* lastError already captured */ })
      .finally(scheduleNext);
  }, delayMs);
  if (timer.unref) timer.unref();
}

export function startPortosProfileSync({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  stopPortosProfileSync();
  steadyIntervalMs = Number(intervalMs) > 0 ? Number(intervalMs) : DEFAULT_INTERVAL_MS;
  coldRetries = 0;
  if (!isPortosEnabled()) return null;

  schedulerActive = true;
  runPortosProfileSync()
    .catch(() => { /* lastError already captured */ })
    .finally(scheduleNext);
  return timer;
}

export function stopPortosProfileSync() {
  schedulerActive = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

/**
 * Diagnostika stavu profil-syncu — použiteľná pre /api/health aj admin dlaždicu.
 * `trusted` = profil bol v TOMTO behu aspoň raz naozaj potvrdený z Portosu.
 */
export function getPortosProfileSyncStats() {
  return {
    lastSyncAt: lastSyncAt ? lastSyncAt.toISOString() : null,
    lastError,
    running: Boolean(syncInFlight),
    attempts,
    intervalMs: lastSyncAt ? steadyIntervalMs : scheduledDelayMs,
    trusted: Boolean(lastSyncAt) && !lastError,
  };
}
