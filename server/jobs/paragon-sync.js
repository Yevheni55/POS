// server/jobs/paragon-sync.js
//
// Background worker: keď je Portos / eKasa znova dostupné, postupne registruje
// pending paragóny ktoré boli vystavené počas výpadku.
//
// § 10 z. 289/2008 vyžaduje aby paragóny boli zaregistrované "bez zbytočného
// odkladu" po obnove ERP — typicky do 48 hodín. Tento worker beží každých 60 s
// a snaží sa pretlačiť pending zoznam.
//
// Triggers:
//   - Periodic interval (60 s)
//   - Manual: POST /api/paragons/sync (admin button)
//   - Po každom úspešnom online cash_register payment-e (signál že eKasa je up)

import { syncPendingParagons } from '../routes/paragons.js';
import { isPortosEnabled } from '../lib/portos.js';

const SYNC_INTERVAL_MS = 60_000;

let _running = false;
let _intervalHandle = null;
let _lastResult = null;

async function tick() {
  if (_running) return;
  if (!isPortosEnabled()) return;
  _running = true;
  try {
    _lastResult = await syncPendingParagons();
    if (_lastResult && _lastResult.total > 0) {
      console.log(
        `[ParagonSync] Processed ${_lastResult.total} pending: ` +
        `${_lastResult.registered} registered, ${_lastResult.failed} failed`,
      );
      if (_lastResult.errors && _lastResult.errors.length) {
        for (const e of _lastResult.errors.slice(0, 5)) {
          console.warn(`[ParagonSync]   paragon #${e.id}: ${e.reason || ''} ${e.message || e.error || ''}`);
        }
      }
    }
  } catch (err) {
    console.error('[ParagonSync] tick failed:', err.message);
  } finally {
    _running = false;
  }
}

export function startParagonSync() {
  if (_intervalHandle) return;
  _intervalHandle = setInterval(tick, SYNC_INTERVAL_MS);
  console.log(`[ParagonSync] Worker started (every ${SYNC_INTERVAL_MS / 1000}s)`);
  // První tick okamžite — nie čakaj 60 s na úvodný štart
  setTimeout(tick, 5_000);
}

export function stopParagonSync() {
  if (_intervalHandle) {
    clearInterval(_intervalHandle);
    _intervalHandle = null;
  }
}

export function getLastSyncResult() {
  return _lastResult;
}

/**
 * Volaj z payment-flow po každom úspešnom online cash_register —
 * signál že Portos je up a dá sa pretlačiť pending backlog hneď.
 */
export function triggerSyncIfPending() {
  // Defer (non-blocking) — payment caller nečaká.
  setImmediate(() => { tick(); });
}
