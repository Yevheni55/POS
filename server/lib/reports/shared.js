// Shared constants and helpers used across the report handlers in
// server/lib/reports/. Extracted from the original monolithic reports.js
// route so each handler can sit in its own file.

export const TZ = 'Europe/Bratislava';

export function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

// Úspešne zaevidovaný doklad — rovnaký zoznam ako STORNO_ELIGIBLE_MODES /
// `payments/shared.js`. Failure módy sa od fixu nepersistujú, ale historické
// riadky ich mať môžu → filter je nutný.
const ACCEPTED_FISCAL_MODES = "'online_success','offline_accepted','reconciled_online_success','reconciled_offline_accepted'";

/**
 * Očakávaný `external_id` STORNA k AKTUÁLNEMU predajnému dokladu platby.
 *
 * Presná SQL kópia derivácie z `server/lib/payments/fiscal-get.js` a
 * `history.js`: salt sa berie z externalId predajného dokladu
 * (`parsePaymentExternalIdSalt`) a storno externalId = ten istý tvar + '-storno'
 * (`buildPaymentStornoExternalId`). Pre legacy `order-N-payment` aj pre nový
 * `order-N-pay-<salt>` platí `storno = sale || '-storno'`; nerozpoznateľný tvar
 * (salt = null) padá na legacy `order-N-payment-storno`, presne ako v JS.
 *
 * Aktuálny predajný doklad = `source_type='payment'` (po `change-method` je ten
 * starý prepísaný na `payment_superseded`, takže tu vždy vyjde ten NOVÝ).
 */
const currentSaleStornoExternalIdSql = (paymentsAlias) => `(
    SELECT CASE
             WHEN fd_sale.external_id ~ '^order-[0-9]+-(payment|pay-[A-Za-z0-9-]+)$'
               THEN fd_sale.external_id || '-storno'
             ELSE 'order-' || ${paymentsAlias}.order_id || '-payment-storno'
           END
    FROM fiscal_documents fd_sale
    WHERE fd_sale.payment_id = ${paymentsAlias}.id
      AND fd_sale.source_type = 'payment'
    ORDER BY fd_sale.id DESC
    LIMIT 1
  )`;

/**
 * „Táto platba je fiškálne vystornovaná" — EXISTS fragment nad `payments`.
 *
 * Fiškálne STORNOVANÁ platba sa NESMIE počítať do tržieb: opravný doklad
 * v eKase peniaze vrátil, ale payments riadok ostáva (unique(order_id)
 * bráni zápornej kompenzačnej platbe).
 *
 * POZOR na `change-method`: po zmene spôsobu platby visia na JEDNEJ platbe TRI
 * doklady — starý predajný (`payment_superseded`), jeho `storno` a NOVÝ platný
 * `payment`. Peniaze vrátené neboli, len sa preúčtoval spôsob platby. Preto sa
 * storno páruje s AKTUÁLNYM predajným dokladom (cez externalId), nie s platbou:
 * platba vypadne z tržieb LEN keď je vystornovaný jej AKTUÁLNY doklad.
 *
 * Fallback (`NOT EXISTS payment_superseded`) drží pôvodné správanie na
 * historických riadkoch, kde externalId nemá dnešný formát — tam ako doteraz
 * stačí akékoľvek úspešné storno. Rovnaká sémantika ako
 * `payments/history.js:89-97`.
 */
const stornoedPaymentSql = (paymentsAlias) => `EXISTS (
  SELECT 1 FROM fiscal_documents fd
  WHERE fd.payment_id = ${paymentsAlias}.id
    AND fd.source_type = 'storno'
    AND fd.result_mode IN (${ACCEPTED_FISCAL_MODES})
    AND (
      fd.external_id = ${currentSaleStornoExternalIdSql(paymentsAlias)}
      OR NOT EXISTS (
        SELECT 1 FROM fiscal_documents fd_sup
        WHERE fd_sup.payment_id = ${paymentsAlias}.id
          AND fd_sup.source_type = 'payment_superseded'
      )
    )
)`;

// RAW SQL fragment do WHERE — parameter = alias payments tabuľky.
export const notStornoedSql = (paymentsAlias = 'payments') => `NOT ${stornoedPaymentSql(paymentsAlias)}`;

// Variant pre item-agregáty kľúčované cez `orders` (kategórie, topItems,
// productsByDay, vatMix) — tie nemajú alias na `payments`, takže storno hľadáme
// cez platbu daného účtu. Účet BEZ platby (odpis, otvorený účet) ostáva
// započítaný. Sémantika je zhodná s `notStornoedSql` (tá istá derivácia).
export const notStornoedOrderSql = (ordersAlias = 'orders') => `NOT EXISTS (
  SELECT 1 FROM payments p_st
  WHERE p_st.order_id = ${ordersAlias}.id
    AND ${stornoedPaymentSql('p_st')}
)`;

/** Bezpečné vloženie stringu z DB do RAW SQL fragmentu (standard_conforming_strings = on). */
function sqlLiteral(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/'/g, "''");
}

// Na kase sa môže zmeniť daňový subjekt (iné DKP v Portose). Reporty nesmú miešať tržby
// dvoch firiem. Sémantika je PRESNÁ kópia server/lib/payments/history.js:119-127:
//   • platba BEZ fiškálneho dokladu ostáva započítaná (paragóny, lokálny režim, staré riadky),
//   • vylúči sa iba tá, ktorej PREDAJNÝ doklad (source_type='payment') patrí CUDZIEMU
//     cash_register_code — vrátane prázdneho kódu, presne ako `String(...).trim() === activeCode`.
// Prázdny `activeCode` → 'TRUE' (filter sa neaplikuje, rovnaký fallback ako history.js).
// RAW SQL fragment do WHERE — parametre = alias payments tabuľky + aktívny kód pokladne.
export const notForeignCashRegisterSql = (paymentsAlias = 'payments', activeCode = '') => {
  const code = String(activeCode ?? '').trim();
  if (!code) return 'TRUE';
  return `NOT EXISTS (
  SELECT 1 FROM fiscal_documents fd
  WHERE fd.payment_id = ${paymentsAlias}.id
    AND fd.source_type = 'payment'
    AND COALESCE(TRIM(fd.cash_register_code), '') <> '${sqlLiteral(code)}'
)`;
};

// Variant pre agregáty kľúčované cez `orders` (topItems, destRows, cogsRows, odpisRows) —
// tie nemajú alias na payments, takže cudzia kasa sa hľadá cez platbu daného účtu.
// Účet BEZ platby alebo bez predajného dokladu ostáva započítaný (rovnaká sémantika ako vyššie).
export const notForeignCashRegisterOrderSql = (ordersAlias = 'orders', activeCode = '') => {
  const code = String(activeCode ?? '').trim();
  if (!code) return 'TRUE';
  return `NOT EXISTS (
  SELECT 1 FROM payments p_crc
  JOIN fiscal_documents fd_crc ON fd_crc.payment_id = p_crc.id
  WHERE p_crc.order_id = ${ordersAlias}.id
    AND fd_crc.source_type = 'payment'
    AND COALESCE(TRIM(fd_crc.cash_register_code), '') <> '${sqlLiteral(code)}'
)`;
};
