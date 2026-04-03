import 'dotenv/config';
import pg from 'pg';

import { getStatus } from '../lib/portos.js';

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  try {
    const [schemaCheck, printers, portosStatus] = await Promise.all([
      pool.query(`
        select
          exists(
            select 1
            from information_schema.tables
            where table_schema = 'public'
              and table_name = 'fiscal_documents'
          ) as has_fiscal_documents,
          exists(
            select 1
            from information_schema.columns
            where table_schema = 'public'
              and table_name = 'menu_items'
              and column_name = 'vat_rate'
          ) as has_menu_item_vat_rate
      `),
      pool.query(`
        select id, name, ip, port, dest, active
        from printers
        order by id
      `),
      getStatus(),
    ]);

    const result = {
      checkedAt: new Date().toISOString(),
      database: {
        urlConfigured: Boolean(process.env.DATABASE_URL),
        hasFiscalDocumentsTable: schemaCheck.rows[0]?.has_fiscal_documents ?? false,
        hasMenuItemVatRate: schemaCheck.rows[0]?.has_menu_item_vat_rate ?? false,
      },
      portos: {
        enabled: portosStatus.enabled,
        baseUrl: portosStatus.baseUrl,
        configuredCashRegisterCode: portosStatus.configuredCashRegisterCode,
        cashRegisterCode: portosStatus.cashRegisterCode,
        printerName: portosStatus.printerName,
        serviceReachable: portosStatus.serviceReachable,
        connectivityState: portosStatus.connectivity?.state ?? null,
        storageName: portosStatus.storage?.product?.name ?? null,
        storageVersion: portosStatus.storage?.product?.version ?? null,
        storageSerialNumber: portosStatus.storage?.product?.serialNumber ?? null,
        printerState: portosStatus.printer?.state ?? null,
        paperState: portosStatus.printer?.paperState ?? null,
        certificateValid: portosStatus.certificate?.isValid ?? null,
        certificateExpiry: portosStatus.certificate?.expirationDate ?? null,
        certificateDaysToExpire: portosStatus.certificate?.daysToExpire ?? null,
        chduSerialPortName: portosStatus.settings?.storage?.chduSerialPortName ?? null,
        errors: portosStatus.errors,
      },
      legacyPrinters: printers.rows,
    };

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    checkedAt: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
});
