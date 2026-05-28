import net from 'net';

import { and, eq } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { printers } from '../../db/schema.js';
import { PRINTER_IP, PRINTER_PORT } from './format.js';

// LAN printer odpoveda obvykle <100ms. Po idle (power-save) prvy SYN
// "zobudi" tlaciaren ktora ale na ten prvy pokus casto neodpovie vcas
// (~2-3s wake-up). Riesenie: 2 pokusy v jednom sendToPrinter:
//   - 1. pokus (ATTEMPT1_MS): pri prebudenej tlaciarni vytlaci hned (<200ms).
//     Pri spiacej casto timeout — ALE jeho SYN tlaciaren prebudi.
//   - kratka pauza (WAKE_PAUSE_MS) nech sa stihne prebudit
//   - 2. pokus (ATTEMPT2_MS): tlaciaren uz hore → pripoji sa a vytlaci INLINE
// Tym sa vyhneme falosnemu "tlaciaren offline" toastu + queue fallbacku
// ktory matil cashiera (predtym 1700ms timeout vzdy zlyhal na spiacej
// tlaciarni, bon sa vytlacil az z queue o par sekund neskor).
const ATTEMPT1_MS = 1800;   // warm print OR wake-up poke
const WAKE_PAUSE_MS = 250;  // nech sa tlaciaren stihne prebudit medzi pokusmi
const ATTEMPT2_MS = 3500;   // tlaciaren uz hore — velkorysy strop

// Jeden TCP send pokus. Timeout je parametrizovany (kratky pre wake-up poke,
// dlhsi pre druhy pokus na prebudenu tlaciaren).
function attemptSend(data, targetIp, targetPort, timeoutMs) {
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

    // Hard timer ako poistka — socket.setTimeout je idle timeout, ale connect
    // phase moze na niektorych OS visiet dlhsie (kernel SYN retries).
    const hardTimer = setTimeout(() => {
      settle(new Error('Tlaciaren neodpoveda (timeout ' + timeoutMs + 'ms)'));
    }, timeoutMs + 300);

    client.setTimeout(timeoutMs);
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

export async function sendToPrinter(data, ip, port) {
  const targetIp = ip || PRINTER_IP;
  const targetPort = port || PRINTER_PORT;
  try {
    // 1. pokus — rychly. Pri prebudenej tlaciarni vytlaci hned.
    return await attemptSend(data, targetIp, targetPort, ATTEMPT1_MS);
  } catch (firstErr) {
    // 1. pokus zlyhal → pravdepodobne power-save, jeho SYN tlaciaren prebudil.
    // Kratka pauza a 2. pokus na uz prebudenu tlaciaren.
    await new Promise((r) => setTimeout(r, WAKE_PAUSE_MS));
    try {
      const t0 = Date.now();
      const res = await attemptSend(data, targetIp, targetPort, ATTEMPT2_MS);
      console.log('[Print] wake-up retry success ' + targetIp + ':' + targetPort + ' (' + (Date.now() - t0) + 'ms na 2. pokus)');
      return res;
    } catch (secondErr) {
      // Oba pokusy zlyhali → tlaciaren je naozaj offline. Hodime error,
      // sendOrQueue ho zachyti a zaradi do queue (genuine offline case).
      throw secondErr;
    }
  }
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
