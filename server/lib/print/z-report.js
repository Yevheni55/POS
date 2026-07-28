import { and, eq, sql } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { cashflowEntries } from '../../db/schema.js';
import { getActiveCashRegisterCode } from '../active-cash-register.js';
import { isPortosEnabled, PortosTransportError, registerCashWithdrawal } from '../portos.js';

import { getPrinterForDest } from './network.js';
import { sendOrQueue } from './queue.js';
import { buildZReportTicket } from './tickets.js';

// Marker v note cashflow riadku: pre tento deň fiškálny paragón výberu
// NEVZNIKOL (digitálna uzávierka / Portos vypnutý / Portos zlyhal). Iba riadok
// s týmto markerom smie ešte raz osloviť Portos — riadok BEZ markera (vrátane
// starých riadkov spred tejto zmeny) považujeme za „paragón už vytlačený"
// a druhý nikdy neposielame.
const NO_PARAGON_MARK = 'Portos paragón výberu nebol vytvorený';

/**
 * Pošle Portos paragón výberu (best-effort). Vracia `portosWithdraw` objekt
 * pre odpoveď — `ok:true` znamená, že paragón fakticky vznikol.
 */
async function issueWithdrawalParagon({ isDigital, amount, date }) {
  // V digital mode sa fiškálny paragón výberu zámerne netlačí — výber je
  // zaevidovaný len v cashflow.
  if (isDigital) {
    return { ok: false, skipped: true, digital: true, error: 'Digital mode — Portos výber preskočený' };
  }
  if (!isPortosEnabled()) {
    return { ok: false, error: 'Portos disabled', skipped: true };
  }
  try {
    const cashRegisterCode = await getActiveCashRegisterCode();
    // Deterministický externalId → aj keby dva requesty prešli cez
    // DB check súčasne (race), Portos ich zdedupuje na jeden paragón.
    const portosResult = await registerCashWithdrawal({
      cashRegisterCode,
      amount,
      externalId: `withdraw-${date}-${cashRegisterCode}`,
    });
    const out = {
      ok: portosResult.ok,
      status: portosResult.status,
      receiptId: portosResult.data?.response?.data?.id || null,
      error: portosResult.ok ? null : (portosResult.data?.detail || portosResult.data?.title || ('HTTP ' + portosResult.status)),
    };
    if (!portosResult.ok) {
      console.warn(`[Portos] Withdrawal failed: status=${portosResult.status} detail="${out.error}"`);
    }
    return out;
  } catch (portosErr) {
    const isTransport = portosErr instanceof PortosTransportError;
    console.warn(`[Portos] Withdrawal ${isTransport ? 'transport' : 'unexpected'} error:`, portosErr.message);
    return { ok: false, error: portosErr.message, transportError: isTransport };
  }
}

// POST /api/print/z-report — print Z-report.
//
// Body:
//   - date (required): YYYY-MM-DD
//   - digital (optional, default false): ak true, preskočí tlač Z-report
//     ticketu na ESC/POS tlačiarni AJ volanie Portos /receipts/withdraw
//     (čím sa nevytlačí fiškálny paragón výberu). Cashflow zápis stále
//     prebehne — uzávierka je internally zaznamenaná, len bez papiera.
//     Pre fiškálnu kompletnosť (pokladňa balance v Portos) treba neskôr
//     vytlačiť papierovú uzávierku alebo manuálne registrovať výber.
export async function zReportHandler(req, res) {
  try {
    const { date, digital } = req.body;
    if (!date) return res.status(400).json({ error: 'Chyba datum' });
    const isDigital = digital === true;

    // Fetch Z-report data from internal API logic
    const reportRes = await fetch(`http://localhost:${process.env.PORT || 3080}/api/reports/z-report?date=${date}`, {
      headers: { 'Authorization': req.headers.authorization },
    });
    if (!reportRes.ok) {
      const err = await reportRes.json().catch(() => ({}));
      return res.status(500).json({ error: err.error || 'Nepodarilo sa nacitat Z-report' });
    }
    const data = await reportRes.json();

    // V digital mode neoslovujeme tlačiareň (no paper). Inak — pošli ticket
    // na ESC/POS tlačiareň ako predtým.
    let result = { queued: false };
    if (!isDigital) {
      const printer = await getPrinterForDest('uctenka');
      const ticket = buildZReportTicket(data);
      result = await sendOrQueue('z-report', ticket, printer.ip, printer.port);
    }

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
      // Auto-výber pri uzávierke používa LEN fiškálnu hotovosť — to čo prešlo
      // cez Portos pokladňu (payments.hotovost). Shisha cash sa nepočíta
      // sem (Portos o nej nevie + cashflow ju vedie samostatne ako shisha
      // revenue). Operátor podľa SHISHA bloku na tikete oddelene zúčtuje
      // cash zo shisha predajov.
      const cashRow = (data.paymentMethods || []).find(pm => {
        const m = String(pm.method || '').toLowerCase();
        return m === 'hotovost' || m === 'cash';
      });
      const cashAmount = cashRow ? Number(cashRow.total) || 0 : 0;
      const shishaCash = data.shisha ? Number(data.shisha.revenue) || 0 : 0;
      const amount = Math.max(0, Math.round(cashAmount * 100) / 100);
      if (amount > 0) {
        // KRITICKÉ (fiškálna idempotencia): existenciu výberu overujeme PRED
        // volaním Portosu. Predtým sa najprv poslal /receipts/withdraw a až
        // potom sa pozrelo do cashflow — druhý ťuk na tablete teda vytlačil
        // DRUHÝ fiškálny paragón výberu, hoci cashflow riadok pribudol len
        // jeden. Zásuvka a papier si potom nesedeli.
        //
        // Idempotency kľúč: ten istý kalendárny deň (Bratislava) + kategória.
        // Porovnávame cez occurred_at::date v Bratislava timezone.
        const [existing] = await db.select({ id: cashflowEntries.id, note: cashflowEntries.note })
          .from(cashflowEntries)
          .where(and(
            eq(cashflowEntries.category, 'withdrawal_uzavierka'),
            sql`(${cashflowEntries.occurredAt} AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Bratislava')::date = ${date}::date`,
          ))
          .limit(1);

        // Chýba k existujúcemu riadku fiškálny paragón? Vieme to LEN ak sme si
        // to sami poznačili (digitálna uzávierka / Portos vypnutý / zlyhanie).
        // Konzervatívne: žiadny marker = paragón existuje = nič neposielame.
        const paragonMissing = existing
          ? String(existing.note || '').includes(NO_PARAGON_MARK)
          : false;

        if (existing && (isDigital || !paragonMissing)) {
          // Výber pre tento deň už existuje a paragón (podľa záznamu) tiež,
          // resp. digitálna uzávierka paragón aj tak netlačí → Portos vôbec
          // neoslovujeme. Toto je jadro fixu: druhý ťuk na uzávierku už
          // NEVYTLAČÍ druhý fiškálny paragón výberu.
          //
          // portosWithdraw ostáva null zámerne — klient (admin reports.js aj
          // Android ReportsDailyScreen) vetví toast tak, že `pw.skipped`
          // znamená „Portos je vypnutý". Bez pw ukáže správne „Výber už
          // evidovaný".
          portosWithdraw = null;
          withdrawal = {
            created: false,
            alreadyExists: true,
            cashflowEntryId: existing.id,
            amount,
            paragon: paragonMissing ? 'missing_digital' : 'already_issued',
          };
        } else if (existing) {
          // Dotlač chýbajúceho paragónu: predchádzajúca uzávierka bola
          // digitálna (alebo vtedy Portos zlyhal/bol vypnutý) a operátor teraz
          // tlačí papierovú — presne postup, ktorý mu sľubuje potvrdzovacie
          // okno „Digitálna uzávierka". Cashflow riadok NEduplikujeme, len
          // doplníme fiškálny paragón a zmažeme marker, aby tretí ťuk už
          // netlačil znova.
          portosWithdraw = await issueWithdrawalParagon({ isDigital, amount, date });
          if (portosWithdraw?.ok) {
            await db.update(cashflowEntries)
              .set({
                note: String(existing.note || '')
                  .replace(NO_PARAGON_MARK, 'Portos paragón výberu dotlačený dodatočne'),
              })
              .where(eq(cashflowEntries.id, existing.id));
          }
          withdrawal = {
            created: false,
            alreadyExists: true,
            cashflowEntryId: existing.id,
            amount,
            paragon: portosWithdraw?.ok ? 'issued_now' : 'missing',
          };
        } else {
          // (a) Portos výber paragón — best-effort, failure neblokuje cashflow.
          portosWithdraw = await issueWithdrawalParagon({ isDigital, amount, date });

          // occurredAt = 23:59:59 zvoleného dňa v Bratislava → výber sa
          // vždy zoradí na konci dňa, čo je intuitívne pre Z-report uzávierku.
          const occurredAt = new Date(date + 'T23:59:59+02:00');
          const [row] = await db.insert(cashflowEntries).values({
            type: 'expense',
            category: 'withdrawal_uzavierka',
            amount: String(amount),
            occurredAt,
            method: 'cash',
            note: (isDigital ? 'Digitálna uzávierka ' : 'Auto výber pri uzávierke ')
              + date + ' — fiškálna hotovosť'
              + (shishaCash > 0
                  ? ' (shisha ' + shishaCash.toFixed(2) + ' € viď samostatnú sekciu)'
                  : '')
              // Marker → ďalšia (papierová) uzávierka smie paragón dotlačiť.
              + (isDigital
                  ? ` [bez papiera, ${NO_PARAGON_MARK}]`
                  : (portosWithdraw?.ok ? '' : ` [${NO_PARAGON_MARK} — dotlačí ďalšia uzávierka]`)),
            staffId: req.user.id,
          }).returning({ id: cashflowEntries.id });
          withdrawal = { created: true, amount, cashflowEntryId: row?.id };
        }
      } else {
        withdrawal = { created: false, amount: 0, reason: 'no_cash' };
      }
    } catch (cfErr) {
      // Cashflow zápis je best-effort — chyba neblokuje úspešnú tlač Z-reportu.
      console.error('Z-report cashflow withdrawal error:', cfErr.message);
      withdrawal = { created: false, error: cfErr.message };
    }

    res.json({ ok: true, digital: isDigital, queued: !!result.queued, withdrawal, portosWithdraw });
  } catch (e) {
    console.error('Z-report print error:', e.message);
    res.status(500).json({ error: e.message });
  }
}
