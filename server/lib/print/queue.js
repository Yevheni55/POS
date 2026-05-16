import { and, eq, lte } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { printQueue } from '../../db/schema.js';
import { PRINTER_IP, PRINTER_PORT } from './format.js';
import { checkPrinterOnline, sendToPrinter } from './network.js';

const RETRY_INTERVAL_MS = 15_000;   // check queue every 15s
const MAX_RETRY_ATTEMPTS = 50;      // give up after 50 tries (~12 min)

// ===== Print Queue: queue on failure, auto-retry when printer is back =====

export async function sendOrQueue(endpoint, ticketData, printerIp, printerPort) {
  try {
    await sendToPrinter(ticketData, printerIp, printerPort);
    return { ok: true };
  } catch (e) {
    // Printer offline — save to queue (base64 because ESC/POS has null bytes)
    await db.insert(printQueue).values({
      endpoint,
      payload: Buffer.from(ticketData, 'binary').toString('base64'),
      printerIp: printerIp || PRINTER_IP,
      printerPort: printerPort || PRINTER_PORT,
      attempts: 1,
      lastError: e.message.slice(0, 300),
      status: 'pending',
    });
    console.log(`[PrintQueue] Queued ${endpoint} job for ${printerIp}:${printerPort} — ${e.message}`);
    return { ok: false, queued: true, error: e.message };
  }
}

let _retryRunning = false;
export async function processQueue() {
  if (_retryRunning) return;
  _retryRunning = true;
  try {
    const jobs = await db.select().from(printQueue)
      .where(and(eq(printQueue.status, 'pending'), lte(printQueue.nextRetryAt, new Date())))
      .limit(20);

    if (!jobs.length) return;

    // Group by printer to avoid hammering a dead printer
    const byPrinter = {};
    for (const job of jobs) {
      const key = job.printerIp + ':' + job.printerPort;
      if (!byPrinter[key]) byPrinter[key] = { ip: job.printerIp, port: job.printerPort, jobs: [] };
      byPrinter[key].jobs.push(job);
    }

    for (const printer of Object.values(byPrinter)) {
      const online = await checkPrinterOnline(printer.ip, printer.port);
      if (!online) {
        // Bump retry time for all jobs on this printer
        for (const job of printer.jobs) {
          const nextAttempts = job.attempts + 1;
          if (nextAttempts >= MAX_RETRY_ATTEMPTS) {
            await db.update(printQueue).set({ status: 'failed', attempts: nextAttempts })
              .where(eq(printQueue.id, job.id));
            console.log(`[PrintQueue] Job #${job.id} gave up after ${nextAttempts} attempts`);
          } else {
            await db.update(printQueue).set({
              attempts: nextAttempts,
              nextRetryAt: new Date(Date.now() + RETRY_INTERVAL_MS),
            }).where(eq(printQueue.id, job.id));
          }
        }
        continue;
      }

      // Printer is online — flush jobs in order
      for (const job of printer.jobs) {
        try {
          const ticketData = Buffer.from(job.payload, 'base64').toString('binary');
          await sendToPrinter(ticketData, job.printerIp, job.printerPort);
          await db.update(printQueue).set({ status: 'done' }).where(eq(printQueue.id, job.id));
          console.log(`[PrintQueue] Job #${job.id} (${job.endpoint}) printed successfully`);
        } catch (e) {
          const nextAttempts = job.attempts + 1;
          await db.update(printQueue).set({
            attempts: nextAttempts,
            lastError: e.message.slice(0, 300),
            nextRetryAt: new Date(Date.now() + RETRY_INTERVAL_MS),
            status: nextAttempts >= MAX_RETRY_ATTEMPTS ? 'failed' : 'pending',
          }).where(eq(printQueue.id, job.id));
          break; // printer went offline again, skip remaining
        }
      }
    }
  } catch (e) {
    console.error('[PrintQueue] processQueue error:', e.message);
  } finally {
    _retryRunning = false;
  }
}

let _queueInterval = null;
export function startPrintQueue() {
  if (_queueInterval) return;
  _queueInterval = setInterval(processQueue, RETRY_INTERVAL_MS);
  console.log(`[PrintQueue] Worker started (every ${RETRY_INTERVAL_MS / 1000}s)`);
}
