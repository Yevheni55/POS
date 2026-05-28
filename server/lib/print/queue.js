import { and, eq, lte } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { printQueue, printers } from '../../db/schema.js';
import { PRINTER_IP, PRINTER_PORT } from './format.js';
import { checkPrinterOnline, sendToPrinter, pokePrinter } from './network.js';

const RETRY_INTERVAL_MS = 15_000;   // check queue every 15s
const MAX_RETRY_ATTEMPTS = 50;      // give up after 50 tries (~12 min)

// Keep-alive — interval kratsi nez power-save timeout tlaciarne (typicky
// 1-5 min). 25s drzi NIC prebudenu s rezervou aj pre agresivnejsie modely.
// Konfigurovatelne cez env ak by konkretna tlaciaren potrebovala iny interval.
const KEEPALIVE_SEC = parseInt(process.env.PRINTER_KEEPALIVE_SEC || '25', 10);

// ===== Print Queue: queue on failure, auto-retry when printer is back =====

export async function sendOrQueue(endpoint, ticketData, printerIp, printerPort) {
  const t0 = Date.now();
  try {
    await sendToPrinter(ticketData, printerIp, printerPort);
    const elapsed = Date.now() - t0;
    // Log slow inline prints (> 800ms) — odhalia power-save wake-up vs.
    // network issues. Rychle (<300ms) nas nezaujimaju, len signal pre debug.
    if (elapsed > 800) {
      console.log(`[Print] SLOW inline send ${endpoint} ${printerIp}:${printerPort} elapsed=${elapsed}ms`);
    }
    return { ok: true, elapsed };
  } catch (e) {
    const elapsed = Date.now() - t0;
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
    console.log(`[PrintQueue] Queued ${endpoint} job for ${printerIp}:${printerPort} elapsed=${elapsed}ms — ${e.message}`);
    return { ok: false, queued: true, error: e.message, elapsed };
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

// ===== Printer keep-alive — drzi tlaciarne prebudene =====
// Periodicky TCP poke na kazdu aktivnu tlaciaren, aby jej sietovy modul
// nezaspal do power-save (co sposobovalo 2-3s wake-up delay pri Send).
// Loguje len ZMENY stavu (online↔offline), nie kazdy tick — inak by cez
// noc ked je bar zavrety spamoval log "neodpoveda" kazdych 25s.
let _keepAliveInterval = null;
let _kaRunning = false;
const _lastOnline = new Map(); // 'ip:port' -> bool

async function pokeAllPrinters() {
  if (_kaRunning) return;
  _kaRunning = true;
  try {
    const active = await db.select().from(printers).where(eq(printers.active, true));
    for (const p of active) {
      const key = p.ip + ':' + p.port;
      const ok = await pokePrinter(p.ip, p.port);
      const prev = _lastOnline.get(key);
      if (prev !== ok) {
        console.log(`[PrinterKeepAlive] ${p.name} (${key}) → ${ok ? 'ONLINE' : 'OFFLINE'}`);
        _lastOnline.set(key, ok);
      }
    }
  } catch (e) {
    console.error('[PrinterKeepAlive] error:', e.message);
  } finally {
    _kaRunning = false;
  }
}

export function startPrinterKeepAlive() {
  if (_keepAliveInterval) return;
  const ms = Math.max(5, KEEPALIVE_SEC) * 1000;
  _keepAliveInterval = setInterval(pokeAllPrinters, ms);
  console.log(`[PrinterKeepAlive] Worker started (every ${KEEPALIVE_SEC}s)`);
  pokeAllPrinters(); // initial poke pri starte
}
