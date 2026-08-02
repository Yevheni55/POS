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

// Marker v note cashflow riadku: za KTORÚ pokladňu (DKP) bol výber vystavený.
// Slúži ako súčasť idempotenčného kľúča v `zReportHandler` — riadok inej
// pokladne nesmie zablokovať nápravný výber v deň prepnutia firmy (audit [27]).
const kasaMark = (code) => `[kasa:${code}]`;

/**
 * Normalizuj `cashFiscalByRegister` z /api/reports/z-report na `[{ code, amount }]`.
 *
 * Tvar poľa určuje server/lib/reports/z-report.js. Čítame ho defenzívne (pole
 * objektov aj mapa kód→suma, viac variantov názvov kľúčov), lebo tento súbor sa
 * nasadzuje aj na kasu so starším reportom. `null` = pole chýba alebo je
 * nepoužiteľné → volajúci padne na dnešné správanie.
 */
function normalizeCashByRegister(raw) {
  if (!raw) return null;
  const out = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      const code = String(entry.cashRegisterCode ?? entry.crc ?? entry.code ?? '').trim();
      const amount = Number(entry.total ?? entry.amount ?? entry.cash ?? 0) || 0;
      out.push({ code, amount });
    }
  } else if (typeof raw === 'object') {
    for (const [code, amount] of Object.entries(raw)) {
      out.push({ code: String(code).trim(), amount: Number(amount) || 0 });
    }
  } else {
    return null;
  }
  return out.length ? out : null;
}

/**
 * Koľko hotovosti smie uzávierka VYBRAŤ z AKTUÁLNEJ Portos pokladne.
 *
 * Doteraz sa brala celá `data.paymentMethods` hotovosť — v deň prepnutia firmy
 * by sa z novej pokladne „vybralo" aj to, čo tam nikdy nebolo vložené (audit [27]).
 * Do výberu ide LEN bucket aktuálneho kódu pokladne + bucket s prázdnym kódom
 * (platby bez fiškálneho dokladu: Portos vypnutý / offline paragón). Cudzie kódy
 * sa vylučujú a vrátia sa ako `foreign` pre varovanie na tikete.
 */
export function resolveWithdrawalCash(data, activeCode) {
  const buckets = normalizeCashByRegister(data && data.cashFiscalByRegister);
  if (!buckets) {
    // Starší /api/reports/z-report bez rozpadu podľa pokladne → dnešné správanie.
    const cashRow = (data.paymentMethods || []).find((pm) => {
      const m = String(pm.method || '').toLowerCase();
      return m === 'hotovost' || m === 'cash';
    });
    return { amount: cashRow ? Number(cashRow.total) || 0 : 0, foreign: [], legacy: true };
  }
  const code = String(activeCode || '').trim();
  if (!code) {
    // Bez známeho kódu pokladne nemáme podľa čoho filtrovať — rovnaký fallback
    // ako notForeignCashRegisterSql / payments/history.js: filter sa neaplikuje.
    const total = buckets.reduce((sum, bucket) => sum + bucket.amount, 0);
    return { amount: Math.round(total * 100) / 100, foreign: [], legacy: false };
  }
  let own = 0;
  const foreign = [];
  for (const bucket of buckets) {
    if (!bucket.code || bucket.code === code) own += bucket.amount;
    else if (Math.abs(bucket.amount) > 0.005) foreign.push(bucket);
  }
  return { amount: Math.round(own * 100) / 100, foreign, legacy: false };
}

/**
 * Pošle Portos paragón výberu (best-effort). Vracia `portosWithdraw` objekt
 * pre odpoveď — `ok:true` znamená, že paragón fakticky vznikol.
 */
async function issueWithdrawalParagon({ isDigital, amount, date, cashRegisterCode }) {
  // V digital mode sa fiškálny paragón výberu zámerne netlačí — výber je
  // zaevidovaný len v cashflow.
  if (isDigital) {
    return { ok: false, skipped: true, digital: true, error: 'Digital mode — Portos výber preskočený' };
  }
  if (!isPortosEnabled()) {
    return { ok: false, error: 'Portos disabled', skipped: true };
  }
  try {
    // Kód pokladne prichádza z volajúceho — musí to byť TÁ ISTÁ pokladňa, za
    // ktorú sa suma spočítala (`resolveWithdrawalCash`).
    const code = String(cashRegisterCode || '').trim() || await getActiveCashRegisterCode();
    // Deterministický externalId → aj keby dva requesty prešli cez
    // DB check súčasne (race), Portos ich zdedupuje na jeden paragón.
    const portosResult = await registerCashWithdrawal({
      cashRegisterCode: code,
      amount,
      externalId: `withdraw-${date}-${code}`,
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

    // Rozpad hotovosti podľa kódu pokladne — kľúčové pre deň, kedy sa na kase
    // zmenil daňový subjekt (iné DKP). Fiškálny výber smie odviezť LEN hotovosť
    // TEJTO pokladne; cudzie kódy idú na tiket ako varovanie (audit [27]).
    const activeCashRegisterCode = String(await getActiveCashRegisterCode() || '').trim();
    const cashSplit = resolveWithdrawalCash(data, activeCashRegisterCode);
    // `mixedRegisters` je informatívny fallback zo servera reportov pre prípad,
    // že rozpad prišiel v inom tvare, než vieme prečítať.
    const foreignCashRegisters = cashSplit.foreign.length
      ? cashSplit.foreign
      : (Array.isArray(data.mixedRegisters) ? data.mixedRegisters : [])
          .map((entry) => (typeof entry === 'string'
            ? { code: entry, amount: null }
            : { code: String((entry && (entry.cashRegisterCode ?? entry.crc ?? entry.code)) || ''), amount: (entry && (entry.total ?? entry.amount)) ?? null }))
          .filter((entry) => entry.code && entry.code !== activeCashRegisterCode);

    // V digital mode neoslovujeme tlačiareň (no paper). Inak — pošli ticket
    // na ESC/POS tlačiareň ako predtým.
    let result = { queued: false };
    if (!isDigital) {
      const printer = await getPrinterForDest('uctenka');
      const ticket = buildZReportTicket({ ...data, foreignCashRegisters, activeCashRegisterCode });
      result = await sendOrQueue('z-report', ticket, printer.ip, printer.port);
    }

    // Po úspešnom vytlačení uzávierky → automaticky zaeviduj výber hotovosti.
    // Dvojstupňový proces:
    //   (a) Portos: POST /api/v1/requests/receipts/withdraw  — fiškálny
    //       paragón „Výber hotovosti", zníži stav v Portos pokladni
    //   (b) Cashflow: insert do cashflow_entries — interná evidencia pre
    //       admin reporty a hospodársky výsledok
    // Suma = fiškálna hotovosť TEJTO pokladne (`resolveWithdrawalCash`), bez
    // shishy (tá je off-fiscal, nikdy nešla do Portos pokladne, takže sa nemá
    // odkiaľ vyberať). Ak Portos call zlyhá,
    // cashflow zápis stále prebehne (best-effort) a operátor dostane
    // varovanie aby paragón vytlačil ručne.
    let withdrawal = null;
    let portosWithdraw = null;
    try {
      // Auto-výber pri uzávierke používa LEN fiškálnu hotovosť — to čo prešlo
      // cez Portos pokladňu (payments.hotovost) A patrí TEJTO pokladni. Shisha
      // cash sa nepočíta sem (Portos o nej nevie + cashflow ju vedie samostatne
      // ako shisha revenue). Operátor podľa SHISHA bloku na tikete oddelene
      // zúčtuje cash zo shisha predajov.
      const cashAmount = cashSplit.amount;
      const shishaCash = data.shisha ? Number(data.shisha.revenue) || 0 : 0;
      const amount = Math.max(0, Math.round(cashAmount * 100) / 100);
      if (amount > 0) {
        // KRITICKÉ (fiškálna idempotencia): existenciu výberu overujeme PRED
        // volaním Portosu. Predtým sa najprv poslal /receipts/withdraw a až
        // potom sa pozrelo do cashflow — druhý ťuk na tablete teda vytlačil
        // DRUHÝ fiškálny paragón výberu, hoci cashflow riadok pribudol len
        // jeden. Zásuvka a papier si potom nesedeli.
        //
        // Idempotency kľúč: ten istý kalendárny deň (Bratislava) + kategória
        // + KÓD POKLADNE. Porovnávame cez occurred_at::date v Bratislava timezone.
        //
        // Kód pokladne je v `note` ako marker `[kasa:<DKP>]`, nie v `category` —
        // `category` je validovaný slug (server/lib/cashflow-categories.js) a
        // admin/Android ho mapujú na label, takže sufix by rozbil cashflow UI.
        // Sémantika: riadok BEZ markera (staré riadky spred tejto zmeny) blokuje
        // vždy — konzervatívne, nikdy nevystavíme druhý paragón. Riadok s markerom
        // INEJ pokladne neblokuje, takže deň prepnutia subjektu dostane nápravný
        // výber pre novú pokladňu (audit [27]).
        const conditions = [
          eq(cashflowEntries.category, 'withdrawal_uzavierka'),
          sql`(${cashflowEntries.occurredAt} AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Bratislava')::date = ${date}::date`,
        ];
        if (activeCashRegisterCode) {
          conditions.push(sql`(
            COALESCE(${cashflowEntries.note}, '') NOT LIKE '%[kasa:%'
            OR COALESCE(${cashflowEntries.note}, '') LIKE ${'%' + kasaMark(activeCashRegisterCode) + '%'}
          )`);
        }
        const [existing] = await db.select({ id: cashflowEntries.id, note: cashflowEntries.note })
          .from(cashflowEntries)
          .where(and(...conditions))
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
          portosWithdraw = await issueWithdrawalParagon({ isDigital, amount, date, cashRegisterCode: activeCashRegisterCode });
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
          portosWithdraw = await issueWithdrawalParagon({ isDigital, amount, date, cashRegisterCode: activeCashRegisterCode });

          // occurredAt = 23:59:59 zvoleného dňa v Bratislava → výber sa
          // vždy zoradí na konci dňa, čo je intuitívne pre Z-report uzávierku.
          const occurredAt = new Date(date + 'T23:59:59+02:00');
          const note = ((isDigital ? 'Digitálna uzávierka ' : 'Auto výber pri uzávierke ')
            + date + ' — fiškálna hotovosť'
            + (shishaCash > 0
                ? ' (shisha ' + shishaCash.toFixed(2) + ' € viď samostatnú sekciu)'
                : '')
            // Marker → ďalšia (papierová) uzávierka smie paragón dotlačiť.
            + (isDigital
                ? ` [bez papiera, ${NO_PARAGON_MARK}]`
                : (portosWithdraw?.ok ? '' : ` [${NO_PARAGON_MARK} — dotlačí ďalšia uzávierka]`))
            // Za KTORÚ pokladňu výber je — idempotency kľúč pre deň prepnutia
            // daňového subjektu (viď SELECT vyššie).
            + (activeCashRegisterCode ? ` ${kasaMark(activeCashRegisterCode)}` : '')
            + (foreignCashRegisters.length
                ? ` [pozor: v dni je aj hotovosť inej pokladne: ${foreignCashRegisters.map((r) => r.code).join(', ')}]`
                : '')
          ).slice(0, 500); // note je varchar(500) — dlhší text by insert zhodil
          const [row] = await db.insert(cashflowEntries).values({
            type: 'expense',
            category: 'withdrawal_uzavierka',
            amount: String(amount),
            occurredAt,
            method: 'cash',
            note,
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

    res.json({
      ok: true,
      digital: isDigital,
      queued: !!result.queued,
      withdrawal,
      portosWithdraw,
      // Za ktorú pokladňu výber prebehol + ktoré cudzie kódy sa do neho NErátali.
      cashRegisterCode: activeCashRegisterCode,
      foreignCashRegisters,
    });
  } catch (e) {
    console.error('Z-report print error:', e.message);
    res.status(500).json({ error: e.message });
  }
}
