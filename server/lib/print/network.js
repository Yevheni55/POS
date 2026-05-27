import net from 'net';

import { and, eq } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { printers } from '../../db/schema.js';
import { PRINTER_IP, PRINTER_PORT } from './format.js';

// LAN printer odpoveda obvykle <100ms. Po idle (power-save) prvy SYN
// trva ~1-2s kym sa printer "zobudi". Predtym sme tu mali 5000ms — to
// znamenalo ze pri kazdom prvom Send po prestavke cashier cakal ~5s
// (Promise.all caka na pomalsi z 2 printerov). 1700ms je dostatocne
// na wake-up bez ze by sa cashier dostal do "frozen" stavu pri dead
// printeri. Queue worker prevezme ostatne pokusy v pozadi.
const PRINTER_CONNECT_TIMEOUT_MS = 1700;
// Hard timer ako poistka — socket.setTimeout je idle timeout, ale na
// niektorych OS / sietach connect phase moze visiet dlhsie (kernel SYN
// retries). Hard setTimeout garantuje return do tohto casu.
const PRINTER_HARD_TIMEOUT_MS = 2000;

export function sendToPrinter(data, ip, port) {
  const targetIp = ip || PRINTER_IP;
  const targetPort = port || PRINTER_PORT;
  return new Promise((resolve, reject) => {
    let settled = false;
    const client = new net.Socket();

    function settle(err) {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      try { client.destroy(); } catch (_) {}
      if (err) reject(err); else resolve(true);
    }

    const hardTimer = setTimeout(() => {
      settle(new Error('Tlaciaren neodpoveda (hard timeout ' + PRINTER_HARD_TIMEOUT_MS + 'ms)'));
    }, PRINTER_HARD_TIMEOUT_MS);

    client.setTimeout(PRINTER_CONNECT_TIMEOUT_MS);
    client.setNoDelay(true);

    client.connect(targetPort, targetIp, () => {
      client.write(Buffer.from(data, 'binary'), () => {
        client.end();
        settle(null);
      });
    });

    client.on('timeout', () => settle(new Error('Tlaciaren neodpoveda (timeout)')));
    client.on('error', (err) => settle(new Error('Chyba tlaciarni: ' + err.message)));
    client.on('close', () => settle(null));
  });
}

export function checkPrinterOnline(ip, port) {
  return new Promise((resolve) => {
    let done = false;
    const client = new net.Socket();
    const t = setTimeout(() => { if (!done) { done = true; client.destroy(); resolve(false); } }, 1200);
    client.setTimeout(1000);
    client.connect(port, ip, () => { if (!done) { done = true; clearTimeout(t); client.destroy(); resolve(true); } });
    client.on('timeout', () => { if (!done) { done = true; clearTimeout(t); client.destroy(); resolve(false); } });
    client.on('error', () => { if (!done) { done = true; clearTimeout(t); client.destroy(); resolve(false); } });
  });
}

export async function getPrinterForDest(dest) {
  try {
    // Try exact match first
    let [printer] = await db.select().from(printers)
      .where(and(eq(printers.dest, dest), eq(printers.active, true))).limit(1);
    // Fallback to 'all' printer
    if (!printer) {
      [printer] = await db.select().from(printers)
        .where(and(eq(printers.dest, 'all'), eq(printers.active, true))).limit(1);
    }
    // Final fallback to .env
    if (!printer) {
      return { ip: process.env.PRINTER_IP || '192.168.0.107', port: parseInt(process.env.PRINTER_PORT || '9100') };
    }
    return { ip: printer.ip, port: printer.port };
  } catch (e) {
    console.error('getPrinterForDest error:', e.message);
    return { ip: process.env.PRINTER_IP || '192.168.0.107', port: parseInt(process.env.PRINTER_PORT || '9100') };
  }
}
