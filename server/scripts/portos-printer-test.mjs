const baudRate = Number.parseInt(process.argv[2] || '115200', 10);
const label = process.argv.slice(3).join(' ').trim() || `PORTOS TEST ${baudRate}`;

if (!Number.isFinite(baudRate) || baudRate <= 0) {
  console.error(JSON.stringify({ error: 'Invalid baud rate', value: process.argv[2] || null }, null, 2));
  process.exit(1);
}

async function main() {
  const currentRes = await fetch('http://localhost:3010/api/v1/settings');
  if (!currentRes.ok) {
    throw new Error(`Cannot load Portos settings: HTTP ${currentRes.status}`);
  }

  const settings = await currentRes.json();
  settings.storage.chduPrinterBaudRate = baudRate;

  const updateRes = await fetch('http://localhost:3010/api/v1/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  if (!updateRes.ok) {
    throw new Error(`Cannot update Portos settings: HTTP ${updateRes.status}`);
  }

  const verifyRes = await fetch('http://localhost:3010/api/v1/settings');
  const verifySettings = await verifyRes.json();

  const payload = {
    text: `${label}\nBAUD ${baudRate}\nASCII 123 ABC`,
    cashRegisterCode: '88812345678900001',
    contentFlags: [],
  };

  const printRes = await fetch('http://localhost:3010/api/v1/printers/print', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const printData = await printRes.json();

  console.log(JSON.stringify({
    updateStatus: updateRes.status,
    verifiedBaudRate: verifySettings.storage?.chduPrinterBaudRate ?? null,
    printStatus: printRes.status,
    printData,
    label,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    error: error instanceof Error ? error.message : String(error),
    baudRate,
    label,
  }, null, 2));
  process.exit(1);
});
