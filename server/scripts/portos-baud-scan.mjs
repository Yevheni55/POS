/**
 * Ak je text na fiškálnej tlačiarni pri teste z Portosu nečitateľný (náhodné symboly),
 * takmer vždy ide o nesúlad baud rate medzi Portosom a CHDU/tlačiarňou (nie o kódovanie znakov).
 *
 * Spustenie na PC kde beží Portos (nie v Docker kontajneri), z priečinka server:
 *   cd server
 *   node scripts/portos-baud-scan.mjs
 * (načíta server/.env cez dotenv — PORTOS_BASE_URL, PORTOS_CASH_REGISTER_CODE)
 *
 * Skript nastaví po jednom bežné baudy, pri každom vytlačí jasný ASCII riadok s číslom.
 * Na ústrižku nájdi jediný čitateľný blok — ten baud nastav natrvalo v Portose.
 */

import 'dotenv/config';

const DEFAULT_BASE = 'http://127.0.0.1:3010';
const DEFAULT_CASH_REGISTER = '88812345678900001';
const BAUD_CANDIDATES = [9600, 19200, 38400, 57600, 115200];
const PAUSE_MS = 5000;

function baseUrl() {
  return (process.env.PORTOS_BASE_URL || DEFAULT_BASE).replace(/\/$/, '');
}

function cashRegisterCode() {
  return process.env.PORTOS_CASH_REGISTER_CODE || DEFAULT_CASH_REGISTER;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function loadSettings() {
  const res = await fetch(`${baseUrl()}/api/v1/settings`);
  if (!res.ok) throw new Error(`GET settings HTTP ${res.status}`);
  return res.json();
}

async function saveSettings(settings) {
  const res = await fetch(`${baseUrl()}/api/v1/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`PUT settings HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

async function rawPrint(textLines) {
  const res = await fetch(`${baseUrl()}/api/v1/printers/print`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: textLines.join('\n'),
      cashRegisterCode: cashRegisterCode(),
      contentFlags: [],
    }),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function main() {
  console.error('');
  console.error('Portos baud scan — tlačí čisté ASCII; medzi krokmi je pauza.');
  console.error(`API: ${baseUrl()}  CashRegister: ${cashRegisterCode()}`);
  console.error('Ak je všetko stále „šum“, skontroluj v Portose správny COM port (CHDU sériový port).');
  console.error('');

  const initial = await loadSettings();
  const storage = initial.storage || {};
  const originalBaud = storage.chduPrinterBaudRate;
  const comPort = storage.chduSerialPortName ?? '(nenastaveny v API)';

  console.error(JSON.stringify({
    predSkanim: {
      chduSerialPortName: comPort,
      chduPrinterBaudRate: originalBaud,
    },
  }, null, 2));
  console.error('');

  for (const baud of BAUD_CANDIDATES) {
    const settings = await loadSettings();
    settings.storage = settings.storage || {};
    settings.storage.chduPrinterBaudRate = baud;
    await saveSettings(settings);

    const lines = [
      `*** TEST BAUD ${baud} ***`,
      '0123456789',
      'ABCDEFGHIJKLMNOP',
      'end',
    ];
    const printResult = await rawPrint(lines);

    console.error(JSON.stringify({
      krok: { baud, printHttp: printResult.status, printBody: printResult.data },
    }, null, 2));
    console.error(`-> Pozri ústrižok: mal by byť čitateľný riadok "*** TEST BAUD ${baud} ***".`);
    console.error('');

    if (baud !== BAUD_CANDIDATES[BAUD_CANDIDATES.length - 1]) {
      await sleep(PAUSE_MS);
    }
  }

  if (originalBaud != null && originalBaud !== '') {
    const restore = await loadSettings();
    restore.storage = restore.storage || {};
    restore.storage.chduPrinterBaudRate = originalBaud;
    await saveSettings(restore);
    console.error(JSON.stringify({
      obnovene: { chduPrinterBaudRate: originalBaud },
      hint: 'Ak si identifikoval správny baud, nastav ho v Portose ručne a tento skript už nespúšťaj s obnovením — uprav finálne v UI.',
    }, null, 2));
  }
}

main().catch((e) => {
  console.error(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }, null, 2));
  process.exit(1);
});
