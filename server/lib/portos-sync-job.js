import { desc, eq } from 'drizzle-orm';

import { db } from '../db/index.js';
import { companyProfiles } from '../db/schema.js';
import {
  hasUsablePortosIdentity,
  mapPortosIdentityFromStatus,
  mergePortosIdentityIntoProfileRow,
} from './company-profile-from-portos.js';
import { getStatus } from './portos.js';

const DEFAULT_INTERVAL_MS = Number.parseInt(process.env.PORTOS_PROFILE_SYNC_MS || '300000', 10) || 300000;

let timer = null;
let syncInFlight = null;
let lastSyncAt = null;
let lastError = null;

async function loadProfileRow() {
  const [row] = await db.select().from(companyProfiles).orderBy(desc(companyProfiles.id)).limit(1);
  return row || null;
}

/** @returns {Promise<{ok:true,changed:boolean}|{ok:false,error:string}>} */
export async function runPortosProfileSync({ timeoutMs } = {}) {
  if (syncInFlight) return syncInFlight;

  const task = (async () => {
    let cancel;
    const abort = new Promise((_, reject) => {
      cancel = setTimeout(() => reject(new Error('Portos profile sync timeout')), Number(timeoutMs) || 15000);
    });
    try {
      const status = await Promise.race([getStatus(), abort]);
      if (!hasUsablePortosIdentity(status)) {
        const reason = status?.errors?.identity || 'Portos returned no usable identity';
        lastError = String(reason);
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
      if (changed) {
        console.log(`[Portos] Company profile synced from Portos at ${lastSyncAt.toISOString()}`);
      }
      return { ok: true, changed };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastError = message;
      return { ok: false, error: message };
    } finally {
      clearTimeout(cancel);
    }
  })();

  syncInFlight = task.finally(() => { syncInFlight = null; });
  return syncInFlight;
}

export function startPortosProfileSync({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  stopPortosProfileSync();
  runPortosProfileSync().catch(() => { /* lastError already captured */ });
  timer = setInterval(() => {
    runPortosProfileSync().catch(() => { /* lastError already captured */ });
  }, intervalMs);
  if (timer.unref) timer.unref();
  return timer;
}

export function stopPortosProfileSync() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function getPortosProfileSyncStats() {
  return {
    lastSyncAt: lastSyncAt ? lastSyncAt.toISOString() : null,
    lastError,
    intervalMs: DEFAULT_INTERVAL_MS,
  };
}
