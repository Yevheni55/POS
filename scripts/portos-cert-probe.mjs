const BASE = (process.env.PORTOS_BASE_URL || 'http://host.docker.internal:3010').replace(/\/$/, '');
const CODE = (process.env.PORTOS_CASH_REGISTER_CODE || '').trim();

async function probe(label, path) {
  try {
    const res = await fetch(`${BASE}${path}`);
    const text = await res.text();
    console.log(`\n=== ${label} (${res.status}) ===`);
    console.log(text.slice(0, 2000));
  } catch (e) {
    console.log(`\n=== ${label} ERROR ===`);
    console.log(e.message || String(e));
  }
}

(async () => {
  console.log('PORTOS_BASE_URL =', BASE);
  console.log('PORTOS_CASH_REGISTER_CODE =', CODE || '(empty)');

  await probe('GET /api/v1/identities', '/api/v1/identities');
  await probe('GET /api/v1/certificates', '/api/v1/certificates');
  if (CODE) {
    await probe(
      'GET /api/v1/certificates/valid/latest?CashRegisterCode=' + CODE,
      '/api/v1/certificates/valid/latest?CashRegisterCode=' + encodeURIComponent(CODE),
    );
    await probe(
      'GET /api/v1/certificates?CashRegisterCode=' + CODE,
      '/api/v1/certificates?CashRegisterCode=' + encodeURIComponent(CODE),
    );
  }
  await probe('GET /api/v1/printers/status', '/api/v1/printers/status');
  await probe('GET /api/v1/storage/info', '/api/v1/storage/info');
  await probe('GET /api/v1/connectivity/status', '/api/v1/connectivity/status');
})();
