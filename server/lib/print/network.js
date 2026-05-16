import net from 'net';

import { and, eq } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { printers } from '../../db/schema.js';
import { PRINTER_IP, PRINTER_PORT } from './format.js';

export function sendToPrinter(data, ip, port) {
  const targetIp = ip || PRINTER_IP;
  const targetPort = port || PRINTER_PORT;
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    client.setTimeout(5000);

    client.connect(targetPort, targetIp, () => {
      client.write(Buffer.from(data, 'binary'), () => {
        client.end();
        resolve(true);
      });
    });

    client.on('timeout', () => {
      client.destroy();
      reject(new Error('Tlaciaren neodpoveda (timeout)'));
    });

    client.on('error', (err) => {
      reject(new Error('Chyba tlaciarni: ' + err.message));
    });

    client.on('close', () => resolve(true));
  });
}

export function checkPrinterOnline(ip, port) {
  return new Promise((resolve) => {
    const client = new net.Socket();
    client.setTimeout(3000);
    client.connect(port, ip, () => { client.destroy(); resolve(true); });
    client.on('timeout', () => { client.destroy(); resolve(false); });
    client.on('error', () => { client.destroy(); resolve(false); });
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
