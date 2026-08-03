import { eq, sql } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { orders, orderItems, payments, staff } from '../../db/schema.js';
import { localYmd } from '../print/format.js';

import { TZ, notStornoedSql, notForeignCashRegisterSql, resolveScope } from './shared.js';

// GET /api/reports/staff?from=&to=&scope=active|all
export async function staffHandler(req, res) {
  // Defaultny rozsah = poslednych 30 LOKALNYCH dni (UTC den sa po polnoci lisi).
  const from = req.query.from || localYmd(new Date(Date.now() - 30 * 86400000));
  const to = req.query.to || localYmd();

  // Okno dna sa pocita v Europe/Bratislava, nie v UTC (server bezi v Dockeri
  // v UTC a created_at je `timestamp` bez zony s UTC nastennym casom).
  // `new Date(from)` predtym znamenalo 02:00 lokalneho casu → vecerne trzby
  // z posledneho dna vypadli a rannne z predosleho pribudli. Stlpec
  // interpretujeme explicitne ako UTC, aby vysledok nezavisel od session
  // TimeZone databazy. Rovnaky princip ako server/lib/reports/summary.js.
  const fromBoundary = sql`(${from + ' 00:00:00'})::timestamp AT TIME ZONE ${TZ}`;
  const toBoundary   = sql`(${to + ' 23:59:59.999'})::timestamp AT TIME ZONE ${TZ}`;
  const inRange = (col) => sql`(${col} AT TIME ZONE 'UTC') >= ${fromBoundary} AND (${col} AT TIME ZONE 'UTC') <= ${toBoundary}`;

  try {
    // Tržby dvoch daňových subjektov sa nesmú miešať — platba, ktorej PREDAJNÝ
    // doklad patrí cudziemu kódu pokladne, sem default (`scope=active`)
    // nepatrí. `scope=all` pošle do helpera prázdny kód → filter sa neaplikuje
    // a čísla čašníkov pokryjú celú históriu všetkých subjektov.
    const { scope, cashRegisterCode, filterCode } = await resolveScope(req);

    // Pocty objednavok a poloziek. Platby sa tu UZ NEJOINUJU: join na
    // order_items robil fan-out (jeden riadok platby na kazdu polozku) a
    // povodny `SUM(DISTINCT payments.amount)` to riesil tak, ze dve rozne
    // ucty s rovnakou sumou zlucil do jednej → trzba cisnika bola systematicky
    // podhodnotena (v bare je vacsina uctov cennikovy sucet, takze rovnake
    // sumy su bezne). Trzba sa preto berie z paymentBreakdown nizsie, ktory
    // agreguje platby bez fan-outu a uz filtruje stornovane doklady.
    const staffStats = await db.select({
      staffId: staff.id,
      name: staff.name,
      role: staff.role,
      ordersCount: sql`COUNT(DISTINCT ${orders.id})`,
      itemsCount: sql`COALESCE(SUM(${orderItems.qty}), 0)`,
      cancelledOrders: sql`COUNT(DISTINCT ${orders.id}) FILTER (WHERE ${orders.status} = 'cancelled')`,
    })
    .from(staff)
    .leftJoin(orders, sql`${orders.staffId} = ${staff.id} AND ${inRange(orders.createdAt)}`)
    .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
    .where(eq(staff.active, true))
    .groupBy(staff.id, staff.name, staff.role);

    // Get payment method breakdown per staff
    const paymentBreakdown = await db.select({
      staffId: staff.id,
      method: payments.method,
      total: sql`SUM(${payments.amount}::numeric)`,
    })
    .from(payments)
    .innerJoin(orders, eq(payments.orderId, orders.id))
    .innerJoin(staff, eq(orders.staffId, staff.id))
    .where(
      sql`${inRange(payments.createdAt)}
        AND ${sql.raw(notStornoedSql('payments'))}
        AND ${sql.raw(notForeignCashRegisterSql('payments', filterCode))}`   // stornované platby nie sú tržba, cudzia kasa tiež nie (pri scope=all sa filter kasy neaplikuje)
    )
    .groupBy(staff.id, payments.method);

    const breakdownMap = {};
    for (const pb of paymentBreakdown) {
      if (!breakdownMap[pb.staffId]) breakdownMap[pb.staffId] = {};
      breakdownMap[pb.staffId][pb.method] = parseFloat(pb.total);
    }

    // POS zapisuje sposoby platby ako 'hotovost' / 'karta' (js/pos-payments.js),
    // anglicke 'cash' / 'card' su len historicke/importovane riadky. Stlpce
    // Hotovost/Karta v admin/pages/reports.js preto ukazovali 0,00 € pri
    // kazdom cisnikovi. Akceptujeme obe pisania — rovnako ako z-report.js
    // pri vypocte `cashFiscal`.
    const sumMethods = (bd, names) => Math.round(
      names.reduce((sum, n) => sum + (bd[n] || 0), 0) * 100
    ) / 100;

    const result = staffStats.map(s => {
      const bd = breakdownMap[s.staffId] || {};
      // Headline trzba = sucet metod z breakdownu → uz bez stornovanych
      // platieb (predtym headline stornovane obsahoval, breakdown nie, takze
      // si navzajom nesedeli).
      const revenue = Math.round(Object.values(bd).reduce((sum, v) => sum + v, 0) * 100) / 100;
      const ordersCount = parseInt(s.ordersCount);
      return {
        staffId: s.staffId,
        name: s.name,
        role: s.role,
        // Rozsah nesie KAŽDÝ riadok — odpoveď je historicky ploché pole
        // (admin/pages/reports.js:821 aj testy s ním tak pracujú), takže sa
        // tvar nemení. Rovnaká dvojica je aj v hlavičkách odpovede.
        scope,
        cashRegisterCode,
        ordersCount,
        itemsCount: parseInt(s.itemsCount),
        revenue,
        averageOrder: ordersCount > 0 ? Math.round((revenue / ordersCount) * 100) / 100 : 0,
        cancelledOrders: parseInt(s.cancelledOrders),
        cashPayments: sumMethods(bd, ['hotovost', 'cash']),
        cardPayments: sumMethods(bd, ['karta', 'card']),
      };
    });
    // Poradie podla trzby — predtym to robil ORDER BY nad SUM(DISTINCT),
    // teraz je trzba pocitana v JS, takze sa triedi tu.
    result.sort((a, b) => b.revenue - a.revenue);

    // Aj pre prázdne pole musí byť rozsah čitateľný.
    res.setHeader('X-Report-Scope', scope);
    res.setHeader('X-Cash-Register-Code', cashRegisterCode || '');
    res.json(result);
  } catch (err) {
    console.error('Staff report error:', err);
    res.status(500).json({ error: 'Chyba pri generovani reportu cisnikov' });
  }
}
