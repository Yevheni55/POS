import { and, eq, sql } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { cashflowEntries } from '../../db/schema.js';
import { getActiveCashRegisterCode } from '../active-cash-register.js';
import { isPortosEnabled, PortosTransportError, registerCashWithdrawal } from '../portos.js';

import { getPrinterForDest } from './network.js';
import { sendOrQueue } from './queue.js';
import { buildZReportTicket } from './tickets.js';

// POST /api/print/z-report — print Z-report
export async function zReportHandler(req, res) {
  try {
    const { date } = req.body;
    if (!date) return res.status(400).json({ error: 'Chyba datum' });

    // Fetch Z-report data from internal API logic
    const reportRes = await fetch(`http://localhost:${process.env.PORT || 3080}/api/reports/z-report?date=${date}`, {
      headers: { 'Authorization': req.headers.authorization },
    });
    if (!reportRes.ok) {
      const err = await reportRes.json().catch(() => ({}));
      return res.status(500).json({ error: err.error || 'Nepodarilo sa nacitat Z-report' });
    }
    const data = await reportRes.json();

    const printer = await getPrinterForDest('uctenka');
    const ticket = buildZReportTicket(data);
    const result = await sendOrQueue('z-report', ticket, printer.ip, printer.port);

    // Po úspešnom vytlačení uzávierky → automaticky zaeviduj výber hotovosti.
    // Dvojstupňový proces:
    //   (a) Portos: POST /api/v1/requests/receipts/withdraw  — fiškálny
    //       paragón „Výber hotovosti", zníži stav v Portos pokladni
    //   (b) Cashflow: insert do cashflow_entries — interná evidencia pre
    //       admin reporty a hospodársky výsledok
    // Suma = cash z paymentMethods − shisha (shisha je off-fiscal, nikdy nešla
    // do Portos pokladne, takže sa nemá odkiaľ vyberať). Ak Portos call zlyhá,
    // cashflow zápis stále prebehne (best-effort) a operátor dostane
    // varovanie aby paragón vytlačil ručne.
    let withdrawal = null;
    let portosWithdraw = null;
    try {
      // POZN: paymentMethods.hotovost už zahŕňa shisha cash (merged v
      // z-report API). Pre Portos withdraw paragón ale musíme použiť
      // FISKÁLNU cash — Portos pokladňa nevie o shisha, takže odtiaľ
      // môžeme odpočítať len to čo tam prišlo cez fiskálne hotovosť
      // payments. Cashflow zápis naopak používa FYZICKÚ cash z drawer-u
      // (vrátane shisha) — to zaznamenáva reálny pohyb peňazí.
      const cashRow = (data.paymentMethods || []).find(pm => {
        const m = String(pm.method || '').toLowerCase();
        return m === 'hotovost' || m === 'cash';
      });
      const cashPhysical = cashRow ? Number(cashRow.total) || 0 : 0;        // vrátane shisha
      const shishaCash = data.shisha ? Number(data.shisha.revenue) || 0 : 0;
      const cashFiscalOnly = typeof data.cashFiscal === 'number'
        ? data.cashFiscal
        : Math.max(0, cashPhysical - shishaCash); // fallback ak staré API output
      const portosAmount = Math.max(0, Math.round(cashFiscalOnly * 100) / 100);
      const cashflowAmount = Math.max(0, Math.round(cashPhysical * 100) / 100);
      // Použi portosAmount pre Portos paragón, cashflowAmount pre interný zápis.
      const amount = cashflowAmount;
      if (amount > 0) {
        // (a) Portos výber paragón. Best-effort — failure neblokuje cashflow.
        if (isPortosEnabled() && portosAmount > 0) {
          try {
            const cashRegisterCode = await getActiveCashRegisterCode();
            const portosResult = await registerCashWithdrawal({ cashRegisterCode, amount: portosAmount });
            portosWithdraw = {
              ok: portosResult.ok,
              status: portosResult.status,
              receiptId: portosResult.data?.response?.data?.id || null,
              error: portosResult.ok ? null : (portosResult.data?.detail || portosResult.data?.title || ('HTTP ' + portosResult.status)),
            };
            if (!portosResult.ok) {
              console.warn(`[Portos] Withdrawal failed: status=${portosResult.status} detail="${portosWithdraw.error}"`);
            }
          } catch (portosErr) {
            const isTransport = portosErr instanceof PortosTransportError;
            console.warn(`[Portos] Withdrawal ${isTransport ? 'transport' : 'unexpected'} error:`, portosErr.message);
            portosWithdraw = { ok: false, error: portosErr.message, transportError: isTransport };
          }
        } else {
          portosWithdraw = { ok: false, error: 'Portos disabled', skipped: true };
        }

        // Idempotency: ten istý kalendárny deň (Bratislava) + kategória
        // = už existuje výber. Druhé volanie endpointu nepridá duplicit.
        // Porovnávame cez occurred_at::date v Bratislava timezone.
        const [existing] = await db.select({ id: cashflowEntries.id })
          .from(cashflowEntries)
          .where(and(
            eq(cashflowEntries.category, 'withdrawal_uzavierka'),
            sql`(${cashflowEntries.occurredAt} AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Bratislava')::date = ${date}::date`,
          ))
          .limit(1);
        if (!existing) {
          // occurredAt = 23:59:59 zvoleného dňa v Bratislava → výber sa
          // vždy zoradí na konci dňa, čo je intuitívne pre Z-report uzávierku.
          const occurredAt = new Date(date + 'T23:59:59+02:00');
          const [row] = await db.insert(cashflowEntries).values({
            type: 'expense',
            category: 'withdrawal_uzavierka',
            amount: String(amount),
            occurredAt,
            method: 'cash',
            note: 'Auto výber pri uzávierke ' + date
              + (shishaCash > 0
                  ? ' (' + cashFiscalOnly.toFixed(2) + ' € fiskal + ' + shishaCash.toFixed(2) + ' € shisha)'
                  : ''),
            staffId: req.user.id,
          }).returning({ id: cashflowEntries.id });
          withdrawal = { created: true, amount, cashflowEntryId: row?.id };
        } else {
          withdrawal = { created: false, alreadyExists: true, cashflowEntryId: existing.id, amount };
        }
      } else {
        withdrawal = { created: false, amount: 0, reason: 'no_cash' };
      }
    } catch (cfErr) {
      // Cashflow zápis je best-effort — chyba neblokuje úspešnú tlač Z-reportu.
      console.error('Z-report cashflow withdrawal error:', cfErr.message);
      withdrawal = { created: false, error: cfErr.message };
    }

    res.json({ ok: true, queued: !!result.queued, withdrawal, portosWithdraw });
  } catch (e) {
    console.error('Z-report print error:', e.message);
    res.status(500).json({ error: e.message });
  }
}
