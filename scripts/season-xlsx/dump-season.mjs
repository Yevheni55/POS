// Bezi VNUTRI kontajnera pos-app-1 (tam je DB aj env). Vypise dva JSON bloky:
//   PAYLOAD — surovy vystup summaryHandler za celu sezonu (scope=all)
//   VAT     — skutocna DPH na vystupe zo ZMRAZENYCH fiskalnych dokladov
//
// scope=all je nutny: default 'active' filtruje na aktivny cash_register_code,
// lenze mzdy sa podla kasy NEfiltruju. Sezonny P&L by tak postavil cele mzdy
// proti trzbe posledneho subjektu a ukazal fiktivnu stratu.
//
// DPH sa NEberie zo summaryHandler — ten ju pocita z AKTUALNYCH sadzieb menu a
// aplikuje ich aj na obdobie, ked bola firma neplatitel a odviedla 0 EUR.
import { summaryHandler } from './lib/reports/summary.js';
import { db } from './db/index.js';
import { sql } from 'drizzle-orm';

const from = process.env.SEASON_FROM || '2026-04-25';
const to = process.env.SEASON_TO
  || new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Bratislava' }).format(new Date());

let payload = null;
await summaryHandler({ query: { from, to, scope: 'all' } }, { json: (b) => { payload = b; } });
if (!payload) throw new Error('summaryHandler nevratil data');
if (payload.vatModeError) throw new Error('rezim DPH neovereny: ' + payload.vatModeError);

console.log('PAYLOAD_START');
console.log(JSON.stringify({
  from, to,
  totalRevenue: payload.totalRevenue, totalCogs: payload.totalCogs,
  totalLabor: payload.totalLabor, totalStaffMeal: payload.totalStaffMeal,
  totalOdpis: payload.totalOdpis, shisha: payload.shisha,
  totalVatOutput: payload.totalVatOutput,
  daily: payload.daily,
}));
console.log('PAYLOAD_END');

const vat = await db.execute(sql`
  SELECT (it->>'vatRate')::numeric AS sadzba, sum((it->>'price')::numeric) AS brutto
  FROM fiscal_documents fd,
       LATERAL jsonb_array_elements((fd.request_json::jsonb->'request'->'data'->'items')) AS it
  WHERE fd.source_type = 'payment' AND fd.is_successful
    AND fd.created_at >= ${from}
    AND NOT EXISTS (SELECT 1 FROM fiscal_documents s WHERE s.payment_id = fd.payment_id
                    AND s.source_type = 'storno'
                    AND s.result_mode IN ('online_success','offline_accepted','reconciled_online_success','reconciled_offline_accepted'))
  GROUP BY 1 ORDER BY 1`);
const rows = (vat.rows || vat).map((r) => ({
  sadzba: Number(r.sadzba),
  brutto: Number(r.brutto),
  dph: Number(r.brutto) - Number(r.brutto) / (1 + Number(r.sadzba) / 100),
}));
console.log('VAT_START');
console.log(JSON.stringify({ vatRows: rows, vatTotal: rows.reduce((a, b) => a + b.dph, 0) }));
console.log('VAT_END');

// Rozpad podla DANOVEHO SUBJEKTU. Na kase sa vystriedali tri — kazdy ma vlastny
// kod pokladne (DKP) a vlastny rezim DPH. Sucet ich trzieb NIE JE obratom
// ziadneho z nich; DPH realne plati len SL management, predchadzajuce dva
// subjekty boli neplatitelia a ich doklady odisli s 0 %.
//
// Su to trzby CEZ eKASU — bez shishy a odpisu, ktore fiskalny doklad nemaju,
// a teda sa k subjektu nedaju priradit. Preto sa tento blok NEROVNA riadku
// "Celkove trzby". Mzdy sa podla DKP nedelia vobec (su to naklady prevadzky).
const firmy = await db.execute(sql`
  SELECT
    COALESCE(NULLIF(TRIM(fd.cash_register_code), ''), '(bez dokladu)') AS dkp,
    MIN(fd.response_json::jsonb #>> '{request,data,ico}') AS ico,
    COUNT(DISTINCT p.id)::int AS uctov,
    COALESCE(SUM(p.amount::numeric), 0)::float AS trzba,
    MIN((p.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Bratislava')::date)::text AS od,
    MAX((p.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Bratislava')::date)::text AS do,
    COALESCE(SUM((
      SELECT SUM((it->>'price')::numeric - (it->>'price')::numeric
                 / (1 + (it->>'vatRate')::numeric / 100))
      FROM jsonb_array_elements((fd.request_json::jsonb->'request'->'data'->'items')) AS it
    )), 0)::float AS dph
  FROM payments p
  JOIN fiscal_documents fd ON fd.payment_id = p.id AND fd.source_type = 'payment'
                          AND fd.is_successful
  WHERE p.created_at >= ${from}
    AND NOT EXISTS (SELECT 1 FROM fiscal_documents s WHERE s.payment_id = p.id
                    AND s.source_type = 'storno'
                    AND s.result_mode IN ('online_success','offline_accepted','reconciled_online_success','reconciled_offline_accepted'))
  GROUP BY 1 ORDER BY 5`);
console.log('FIRMY_START');
console.log(JSON.stringify((firmy.rows || firmy).map((r) => ({
  dkp: r.dkp, ico: r.ico, uctov: Number(r.uctov), trzba: Number(r.trzba),
  od: r.od, do: r.do, dph: Number(r.dph),
}))));
console.log('FIRMY_END');
process.exit(0);
