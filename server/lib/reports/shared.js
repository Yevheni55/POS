// Shared constants and helpers used across the report handlers in
// server/lib/reports/. Extracted from the original monolithic reports.js
// route so each handler can sit in its own file.

export const TZ = 'Europe/Bratislava';

export function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

// Fiškálne STORNOVANÁ platba sa NESMIE počítať do tržieb: opravný doklad
// v eKase peniaze vrátil, ale payments riadok ostáva (unique(order_id)
// bráni zápornej kompenzačnej platbe). Zdroj pravdy = fiscal_documents
// (source_type='storno' + úspešný result_mode; failure módy sa od fixu
// nepersistujú, ale historické riadky ich mať môžu → filter nutný).
// RAW SQL fragment do WHERE — parameter = alias payments tabuľky.
export const notStornoedSql = (paymentsAlias = 'payments') => `NOT EXISTS (
  SELECT 1 FROM fiscal_documents fd
  WHERE fd.payment_id = ${paymentsAlias}.id
    AND fd.source_type = 'storno'
    AND fd.result_mode IN ('online_success','offline_accepted','reconciled_online_success','reconciled_offline_accepted')
)`;
