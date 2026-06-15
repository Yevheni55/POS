import { sql } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { TZ, roundMoney } from './shared.js';

// GET /api/reports/weekly?from=YYYY-MM-DD&to=YYYY-MM-DD
// Detailný týždenný breakdown — hodina × deň-v-týždni × destinácia
// (bar/kuchyna), plus cook-shifts pre per-hour výpočet kuchárskej
// efektivity. Slúži novej admin stránke "Týždeň".
//
// Pre cook efficiency potrebujeme: kto, koľko hodín, v akých hodinách
// bol v práci, koľko € sa za ten čas vytočilo v kuchyni. Pomer
// kitchen_revenue / cook_hours = €/hod efektivity. Pri viacerých
// kuchároch v rovnakej hodine sa kitchen revenue delí proporčne.
export async function weeklyHandler(req, res) {
  const to = req.query.to || new Date().toISOString().split('T')[0];
  const from = req.query.from || (() => {
    // Default = aktuálny pondelok-nedeľa rozsah
    const d = new Date();
    const dow = d.getDay() === 0 ? 6 : d.getDay() - 1; // Po=0, Ne=6
    d.setDate(d.getDate() - dow);
    return d.toISOString().split('T')[0];
  })();
  const fromBoundary = sql`(${from + ' 00:00:00'})::timestamp AT TIME ZONE ${TZ}`;
  const toBoundary   = sql`(${to + ' 23:59:59'})::timestamp AT TIME ZONE ${TZ}`;

  // Hour × weekday × dest aggregation. dest='kuchyna' alebo 'bar'.
  // Pridávame aj cogs (food cost cez recepty × ingredient cost) aby
  // sme mohli počítať zisk kuchyne, nie len tržby.
  const cellsRows = await db.execute(sql`
    WITH unit_cogs AS (
      SELECT r.menu_item_id, SUM(r.qty_per_unit::numeric * i.cost_per_unit::numeric) AS uc
      FROM recipes r INNER JOIN ingredients i ON i.id = r.ingredient_id
      GROUP BY r.menu_item_id
    )
    SELECT
      EXTRACT(HOUR FROM (o.created_at AT TIME ZONE 'UTC' AT TIME ZONE ${TZ}))::int AS hour,
      EXTRACT(ISODOW FROM (o.created_at AT TIME ZONE 'UTC' AT TIME ZONE ${TZ}))::int AS weekday,
      to_char((o.created_at AT TIME ZONE 'UTC' AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS date,
      c.dest AS dest,
      COALESCE(SUM(oi.qty * mi.price::numeric), 0)::float AS revenue,
      COALESCE(SUM(oi.qty * COALESCE(uc.uc, 0)), 0)::float AS cogs,
      COUNT(DISTINCT o.id)::int AS orders,
      COALESCE(SUM(oi.qty), 0)::int AS items
    FROM order_items oi
    INNER JOIN orders o ON o.id = oi.order_id
    INNER JOIN menu_items mi ON mi.id = oi.menu_item_id
    INNER JOIN menu_categories c ON c.id = mi.category_id
    LEFT JOIN unit_cogs uc ON uc.menu_item_id = mi.id
    WHERE o.created_at >= ${fromBoundary} AND o.created_at <= ${toBoundary}
      AND o.status != 'cancelled'
    GROUP BY 1, 2, 3, 4
  `);

  // Cook shifts — všetky uzavreté smeny v období. Cook = staff.position
  // obsahuje 'kuchár' / 'kuchar' / 'cook' / 'chef' (case-insensitive).
  // Ak nikto taký, vrátime všetkých s hourly_rate>0 (server zaobchádza
  // ako so 'všetkým personálom' a UI to označí).
  const shiftsRows = await db.execute(sql`
    WITH paired AS (
      SELECT ae.staff_id, ae.type, ae.at,
        LEAD(ae.at)   OVER (PARTITION BY ae.staff_id ORDER BY ae.at) AS next_at,
        LEAD(ae.type) OVER (PARTITION BY ae.staff_id ORDER BY ae.at) AS next_type
      FROM attendance_events ae
    )
    SELECT
      paired.staff_id AS "staffId",
      s.name,
      s.position,
      COALESCE(s.hourly_rate, 0)::float AS "hourlyRate",
      paired.at AS "inAt",
      COALESCE(paired.next_at, LEAST((now() AT TIME ZONE 'UTC'), (${toBoundary} AT TIME ZONE 'UTC'))) AS "outAt"
    FROM paired
    JOIN staff s ON s.id = paired.staff_id
    WHERE paired.type = 'clock_in'
      AND (paired.next_type = 'clock_out' OR paired.next_type IS NULL)
      AND paired.at >= ${fromBoundary}
      AND paired.at <= ${toBoundary}
    ORDER BY paired.at
  `);

  // Cells: { date, hour, weekday, kitchenRevenue, barRevenue, orders, items }
  const cellMap = new Map(); // key = date|hour
  for (const r of cellsRows.rows){
    const key = r.date + '|' + r.hour;
    let cell = cellMap.get(key);
    if (!cell){
      cell = {
        date: r.date,
        hour: Number(r.hour),
        weekday: Number(r.weekday), // ISO 1=Po..7=Ne
        kitchenRevenue: 0, kitchenCogs: 0,
        barRevenue: 0, barCogs: 0,
        kitchenItems: 0, barItems: 0,
        orders: 0,
      };
      cellMap.set(key, cell);
    }
    const dest = String(r.dest || 'bar');
    if (dest === 'kuchyna'){
      cell.kitchenRevenue += Number(r.revenue) || 0;
      cell.kitchenCogs    += Number(r.cogs) || 0;
      cell.kitchenItems   += Number(r.items) || 0;
    } else {
      cell.barRevenue += Number(r.revenue) || 0;
      cell.barCogs    += Number(r.cogs) || 0;
      cell.barItems   += Number(r.items) || 0;
    }
    cell.orders += Number(r.orders) || 0;
  }

  // Per-hour-of-day aggregates (24 buckets across whole period)
  const byHour = Array.from({length:24}, (_, i) => ({
    hour: i,
    kitchenRevenue: 0, kitchenCogs: 0,
    barRevenue: 0, barCogs: 0,
    kitchenItems: 0, barItems: 0,
    orders: 0,
    cookMinutes: 0,
    activeCooks: 0,
  }));

  // Per-weekday-hour heatmap (7 × 24 cells, ISO Po=1..Ne=7)
  const heatmapMap = new Map(); // key=weekday|hour
  for (const cell of cellMap.values()){
    const key = cell.weekday + '|' + cell.hour;
    let hm = heatmapMap.get(key);
    if (!hm){
      hm = { weekday: cell.weekday, hour: cell.hour, kitchenRevenue: 0, barRevenue: 0, orders: 0 };
      heatmapMap.set(key, hm);
    }
    hm.kitchenRevenue += cell.kitchenRevenue;
    hm.barRevenue += cell.barRevenue;
    hm.orders += cell.orders;
    byHour[cell.hour].kitchenRevenue += cell.kitchenRevenue;
    byHour[cell.hour].kitchenCogs    += cell.kitchenCogs;
    byHour[cell.hour].barRevenue     += cell.barRevenue;
    byHour[cell.hour].barCogs        += cell.barCogs;
    byHour[cell.hour].kitchenItems   += cell.kitchenItems;
    byHour[cell.hour].barItems       += cell.barItems;
    byHour[cell.hour].orders         += cell.orders;
  }

  // Cook detection — keyword match na position. Ak žiadny cook,
  // UI dostane všetok personál s flag 'noKitchenStaff'.
  const cookKeywords = /kuch|cook|chef/i;
  const allShifts = shiftsRows.rows.map(r => ({
    staffId: Number(r.staffId),
    name: r.name,
    position: r.position || '',
    hourlyRate: Number(r.hourlyRate) || 0,
    inAt: r.inAt,
    outAt: r.outAt,
    isCook: cookKeywords.test(r.position || ''),
  }));
  const cookShifts = allShifts.filter(s => s.isCook);
  const noKitchenStaff = cookShifts.length === 0;
  const usedShifts = noKitchenStaff ? allShifts : cookShifts;

  // For each hour-of-day, count cook-minutes across all shifts.
  // Shift overlap with hour [h, h+1): for each shift, slice into per-hour segments.
  // Day boundary: ak zmena prekročí polnoc, rozdelíme tiež.
  for (const sh of usedShifts){
    const start = new Date(sh.inAt);
    const end = new Date(sh.outAt);
    if (end <= start) continue;
    let cur = new Date(start);
    while (cur < end){
      // Nájdi koniec aktuálneho hour-bucketu (TZ-aware cez Bratislava local)
      const local = new Date(cur.toLocaleString('en-US', { timeZone: 'Europe/Bratislava' }));
      const hour = local.getHours();
      // Compute next hour boundary in UTC
      const localNextHour = new Date(local);
      localNextHour.setHours(hour + 1, 0, 0, 0);
      // Convert local back to UTC
      const offsetMs = (new Date(local.toLocaleString('en-US', { timeZone: 'UTC' })).getTime()
                       - local.getTime());
      const nextBoundaryUtc = new Date(localNextHour.getTime() + offsetMs);
      const sliceEnd = nextBoundaryUtc > end ? end : nextBoundaryUtc;
      const minutes = (sliceEnd - cur) / 60000;
      if (minutes > 0 && hour >= 0 && hour < 24){
        byHour[hour].cookMinutes += minutes;
      }
      cur = sliceEnd;
      if (sliceEnd >= end) break;
    }
  }

  // Per-cook efficiency table — total minutes worked + kitchen revenue
  // attributed (proportionally if multiple cooks active in same hour).
  // Simplifying: split kitchenRevenue v každej hodine medzi aktívnych
  // cookov rovnakou váhou (% ich minút v tej hodine).
  // Per-cook stats. Atribúcie:
  //   minutes        — celkové odpracované minúty
  //   kitchenRevenue — proporčný podiel revenue podľa minút v každej hod
  //   kitchenCogs    — proporčný podiel COGS rovnakým princípom
  //   wage           — minutes × hourlyRate
  //   kitchenProfit  = kitchenRevenue − kitchenCogs (pred mzdou)
  //   netProfit      = kitchenProfit − wage (po mzde — koľko pre šéfa)
  const cookStats = new Map();
  for (const sh of usedShifts){
    const id = sh.staffId;
    if (!cookStats.has(id)){
      cookStats.set(id, {
        staffId: id, name: sh.name, position: sh.position,
        hourlyRate: sh.hourlyRate,
        minutes: 0,
        kitchenRevenue: 0,
        kitchenCogs: 0,
      });
    }
    cookStats.get(id).minutes += (new Date(sh.outAt) - new Date(sh.inAt)) / 60000;
  }

  // Per-hour proporčné rozdelenie kitchen revenue + cogs medzi aktívnymi
  // cookmi v tej hodine. Cook ktorý pracoval 60 min v hodine kde bol
  // sám dostane 100 % daného hour-revenue. Dvaja po 30/30 → každý 50 %.
  for (let h = 0; h < 24; h++){
    const kitchenRev  = byHour[h].kitchenRevenue;
    const kitchenCogs = byHour[h].kitchenCogs;
    if (kitchenRev <= 0 && kitchenCogs <= 0) continue;
    const minutesPerCook = new Map();
    let totalMin = 0;
    for (const sh of usedShifts){
      const start = new Date(sh.inAt);
      const end = new Date(sh.outAt);
      let cur = new Date(start);
      let cookH = 0;
      while (cur < end){
        const local = new Date(cur.toLocaleString('en-US', { timeZone: 'Europe/Bratislava' }));
        const hour = local.getHours();
        const localNextHour = new Date(local);
        localNextHour.setHours(hour + 1, 0, 0, 0);
        const offsetMs = (new Date(local.toLocaleString('en-US', { timeZone: 'UTC' })).getTime()
                         - local.getTime());
        const nextBoundaryUtc = new Date(localNextHour.getTime() + offsetMs);
        const sliceEnd = nextBoundaryUtc > end ? end : nextBoundaryUtc;
        const minutes = (sliceEnd - cur) / 60000;
        if (hour === h) cookH += minutes;
        cur = sliceEnd;
        if (sliceEnd >= end) break;
      }
      if (cookH > 0){
        minutesPerCook.set(sh.staffId, (minutesPerCook.get(sh.staffId) || 0) + cookH);
        totalMin += cookH;
      }
    }
    if (totalMin > 0){
      byHour[h].activeCooks = minutesPerCook.size;
      for (const [id, min] of minutesPerCook){
        const share = min / totalMin;
        const stat = cookStats.get(id);
        if (stat){
          stat.kitchenRevenue += share * kitchenRev;
          stat.kitchenCogs    += share * kitchenCogs;
        }
      }
    }
  }

  // Finalize per-cook s metrikami zisku.
  const cookList = Array.from(cookStats.values()).map(c => {
    const hours = c.minutes / 60;
    const wage = hours * c.hourlyRate;
    const kitchenProfit = c.kitchenRevenue - c.kitchenCogs;
    const netProfit = kitchenProfit - wage;
    return {
      staffId: c.staffId,
      name: c.name,
      position: c.position,
      hourlyRate: c.hourlyRate,
      minutes: c.minutes,
      hours: Math.round(hours * 100) / 100,
      kitchenRevenue: roundMoney(c.kitchenRevenue),
      kitchenCogs: roundMoney(c.kitchenCogs),
      kitchenProfit: roundMoney(kitchenProfit),
      wage: roundMoney(wage),
      netProfit: roundMoney(netProfit),
      // Marža z kuchyne (% z tržby ostáva po surovinách + mzde)
      netMarginPct: c.kitchenRevenue > 0 ? Math.round((netProfit / c.kitchenRevenue) * 1000) / 10 : 0,
    };
  }).sort((a, b) => b.netProfit - a.netProfit);

  const byHourFinal = byHour.map(h => {
    const cookHours = h.cookMinutes / 60;
    // Cook wage allocation per hour = cook minutes × avg hourly rate of all
    // active cooks (priemerná mzda na cook-hodinu — predpokladá rovnaké rate
    // pre všetkých aktívnych v tej hodine; mierne zjednodušenie).
    let wageThisHour = 0;
    if (cookHours > 0){
      // Use weighted avg hourly rate from cookList (those active in any hour)
      const totalRateHours = cookList.reduce((s, c) => s + (c.minutes/60) * c.hourlyRate, 0);
      const totalHours = cookList.reduce((s, c) => s + (c.minutes/60), 0);
      const avgRate = totalHours > 0 ? totalRateHours / totalHours : 0;
      wageThisHour = cookHours * avgRate;
    }
    const kitchenProfit = h.kitchenRevenue - h.kitchenCogs;
    const netProfit = kitchenProfit - wageThisHour;
    return {
      hour: h.hour,
      kitchenRevenue: roundMoney(h.kitchenRevenue),
      kitchenCogs: roundMoney(h.kitchenCogs),
      kitchenProfit: roundMoney(kitchenProfit),
      kitchenWage: roundMoney(wageThisHour),
      kitchenNetProfit: roundMoney(netProfit),
      barRevenue: roundMoney(h.barRevenue),
      totalRevenue: roundMoney(h.kitchenRevenue + h.barRevenue),
      kitchenItems: h.kitchenItems,
      barItems: h.barItems,
      orders: h.orders,
      cookMinutes: Math.round(h.cookMinutes),
      cookHours: Math.round(cookHours * 100) / 100,
      activeCooks: h.activeCooks,
      // Stary alias pre spätnú kompatibilitu UI ak by ho použila stará verzia
      kitchenEfficiency: roundMoney(netProfit),
    };
  });

  const heatmap = Array.from(heatmapMap.values()).map(c => ({
    weekday: c.weekday,
    hour: c.hour,
    kitchenRevenue: roundMoney(c.kitchenRevenue),
    barRevenue: roundMoney(c.barRevenue),
    totalRevenue: roundMoney(c.kitchenRevenue + c.barRevenue),
    orders: c.orders,
  }));

  // Totals
  const totalKitchen = byHourFinal.reduce((s, h) => s + h.kitchenRevenue, 0);
  const totalBar = byHourFinal.reduce((s, h) => s + h.barRevenue, 0);
  const totalCookMinutes = byHourFinal.reduce((s, h) => s + h.cookMinutes, 0);
  const totalCookHours = Math.round((totalCookMinutes / 60) * 100) / 100;
  const totalKitchenCogs = byHourFinal.reduce((s, h) => s + h.kitchenCogs, 0);
  const totalKitchenWage = byHourFinal.reduce((s, h) => s + h.kitchenWage, 0);
  const totalKitchenProfit = totalKitchen - totalKitchenCogs;
  const totalKitchenNetProfit = totalKitchenProfit - totalKitchenWage;

  // Per-day-per-hour breakdown — expandujeme cellMap do dayMap, kde
  // každý deň má svoj 24-hodinový strip s reálnymi sales + cook minutes
  // (NIE priemer cez všetky dni — operátor klikne deň a uvidí presne
  // čo sa v ten deň dialo).
  const dayMap = new Map(); // date -> { date, weekday, hours: Map(hour -> {...}) }
  for (const cell of cellMap.values()){
    if (!dayMap.has(cell.date)){
      const d = new Date(cell.date + 'T12:00:00');
      const isoDow = d.getDay() === 0 ? 7 : d.getDay(); // Po=1..Ne=7
      dayMap.set(cell.date, {
        date: cell.date,
        weekday: isoDow,
        hours: new Map(),
        kitchenRevenue: 0, kitchenCogs: 0,
        barRevenue: 0,
        orders: 0,
      });
    }
    const day = dayMap.get(cell.date);
    let hourCell = day.hours.get(cell.hour);
    if (!hourCell){
      hourCell = {
        hour: cell.hour,
        kitchenRevenue: 0, kitchenCogs: 0,
        barRevenue: 0,
        kitchenItems: 0, barItems: 0,
        orders: 0,
        cookMinutes: 0,
        activeCooks: 0,
      };
      day.hours.set(cell.hour, hourCell);
    }
    hourCell.kitchenRevenue += cell.kitchenRevenue;
    hourCell.kitchenCogs    += cell.kitchenCogs;
    hourCell.barRevenue     += cell.barRevenue;
    hourCell.kitchenItems   += cell.kitchenItems;
    hourCell.barItems       += cell.barItems;
    hourCell.orders         += cell.orders;
    day.kitchenRevenue += cell.kitchenRevenue;
    day.kitchenCogs    += cell.kitchenCogs;
    day.barRevenue     += cell.barRevenue;
    day.orders         += cell.orders;
  }

  // Allokuj cook minutes per (date, hour) — re-iterate shifty s denným bucketom.
  for (const sh of usedShifts){
    const start = new Date(sh.inAt);
    const end = new Date(sh.outAt);
    if (end <= start) continue;
    let cur = new Date(start);
    while (cur < end){
      const local = new Date(cur.toLocaleString('en-US', { timeZone: 'Europe/Bratislava' }));
      const hour = local.getHours();
      const dateStr = local.getFullYear() + '-'
        + String(local.getMonth() + 1).padStart(2, '0') + '-'
        + String(local.getDate()).padStart(2, '0');
      const localNextHour = new Date(local);
      localNextHour.setHours(hour + 1, 0, 0, 0);
      const offsetMs = (new Date(local.toLocaleString('en-US', { timeZone: 'UTC' })).getTime()
                       - local.getTime());
      const nextBoundaryUtc = new Date(localNextHour.getTime() + offsetMs);
      const sliceEnd = nextBoundaryUtc > end ? end : nextBoundaryUtc;
      const minutes = (sliceEnd - cur) / 60000;
      if (minutes > 0 && hour >= 0 && hour < 24){
        // Ensure dayMap has this date even if no sales
        if (!dayMap.has(dateStr)){
          const d = new Date(dateStr + 'T12:00:00');
          const isoDow = d.getDay() === 0 ? 7 : d.getDay();
          dayMap.set(dateStr, {
            date: dateStr, weekday: isoDow,
            hours: new Map(),
            kitchenRevenue: 0, kitchenCogs: 0, barRevenue: 0, orders: 0,
          });
        }
        const day = dayMap.get(dateStr);
        let hourCell = day.hours.get(hour);
        if (!hourCell){
          hourCell = {
            hour, kitchenRevenue: 0, kitchenCogs: 0, barRevenue: 0,
            kitchenItems: 0, barItems: 0, orders: 0, cookMinutes: 0, activeCooks: 0,
          };
          day.hours.set(hour, hourCell);
        }
        hourCell.cookMinutes += minutes;
      }
      cur = sliceEnd;
      if (sliceEnd >= end) break;
    }
  }

  // Avg hourly rate (rovnaké ako pre byHour) na výpočet wage per hour
  const totalRateHours = cookList.reduce((s, c) => s + (c.minutes/60) * c.hourlyRate, 0);
  const totalHours = cookList.reduce((s, c) => s + (c.minutes/60), 0);
  const avgRate = totalHours > 0 ? totalRateHours / totalHours : 0;

  const dailyHours = Array.from(dayMap.values())
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(day => {
      const hours = Array.from(day.hours.values())
        .sort((a, b) => a.hour - b.hour)
        .map(h => {
          const cookHours = h.cookMinutes / 60;
          const wage = cookHours * avgRate;
          const profit = h.kitchenRevenue - h.kitchenCogs;
          const net = profit - wage;
          return {
            hour: h.hour,
            kitchenRevenue: roundMoney(h.kitchenRevenue),
            kitchenCogs: roundMoney(h.kitchenCogs),
            kitchenWage: roundMoney(wage),
            kitchenProfit: roundMoney(profit),
            kitchenNetProfit: roundMoney(net),
            barRevenue: roundMoney(h.barRevenue),
            totalRevenue: roundMoney(h.kitchenRevenue + h.barRevenue),
            kitchenItems: h.kitchenItems,
            barItems: h.barItems,
            orders: h.orders,
            cookMinutes: Math.round(h.cookMinutes),
            cookHours: Math.round(cookHours * 100) / 100,
          };
        });
      return {
        date: day.date,
        weekday: day.weekday,
        kitchenRevenue: roundMoney(day.kitchenRevenue),
        kitchenCogs: roundMoney(day.kitchenCogs),
        kitchenProfit: roundMoney(day.kitchenRevenue - day.kitchenCogs),
        barRevenue: roundMoney(day.barRevenue),
        totalRevenue: roundMoney(day.kitchenRevenue + day.barRevenue),
        orders: day.orders,
        hours,
      };
    });

  res.json({
    period: { from, to },
    byHour: byHourFinal,
    heatmap,
    cooks: cookList,
    dailyHours,
    noKitchenStaff,
    totals: {
      kitchenRevenue: roundMoney(totalKitchen),
      kitchenCogs: roundMoney(totalKitchenCogs),
      kitchenProfit: roundMoney(totalKitchenProfit),
      kitchenWage: roundMoney(totalKitchenWage),
      kitchenNetProfit: roundMoney(totalKitchenNetProfit),
      kitchenNetMarginPct: totalKitchen > 0
        ? Math.round((totalKitchenNetProfit / totalKitchen) * 1000) / 10
        : 0,
      barRevenue: roundMoney(totalBar),
      cookHours: totalCookHours,
    },
  });
}
