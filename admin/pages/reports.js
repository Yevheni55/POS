// Reports page module
import { fmtCost } from '../../components/fmt.js';

let _container = null;
let _lastZData = null;
// Produkty tab sorting — clicking any column header re-sorts client-side
// so the cashier can pick "predalo sa najmenej" or "abecedne" without a
// new request. Default mirrors the natural rank: qty descending.
let _productSort = { col: 'qty', dir: 'desc' };
let _lastProductsData = null;
// Filter Produkty tabu na dest = 'all' | 'kuchyna' | 'bar'. Aplikovany pred
// sortovanim, takze reset zachova zvolene poradie. _productByDayLimit
// controluje kolko top-N items zobrazi v pivot tabulke (vacsie N = vacsia
// tabulka, viac scroll, ale viac videnia).
let _productDestFilter = 'all';
let _productByDayLimit = 20;
// Per-day pivot "Predaj za deň" — prepínateľná metrika a zoskupenie.
// metric: 'qty' (ks) | 'revenue' (tržba €); group: 'item' | 'category'.
// Default = pôvodné správanie (ks po položkách), aby sa nič vizuálne nezmenilo
// kým používateľ neprepne. Nová možnosť: 'revenue' + 'category' = tržba podľa
// kategórií po dňoch.
let _productByDayMetric = 'qty';
let _productByDayGroup = 'item';

// === Rozsah dát ===
// Reporty štandardne filtrujú platby na cash_register_code aktívnej kasy
// ('active'). Na tejto kase sa vystriedali tri daňové subjekty, takže bez
// filtra by sa ich tržby sčítali dokopy — čo je pri platiteľovi DPH zlý
// základ dane. 'all' filter vypne a ukáže celú históriu (len na prehľad).
// Voľba je zdieľaná so stránkou Sezóna cez rovnaký localStorage kľúč.
const SCOPE_KEY = 'pos_reports_scope';
function normalizeScope(v) { return v === 'all' ? 'all' : 'active'; }
function readScope() {
  // localStorage môže hodiť (private mode, zakázané cookies) — nesmie to
  // zhodiť celú stránku, default je bezpečnejší 'active'.
  try { return normalizeScope(localStorage.getItem(SCOPE_KEY)); }
  catch (e) { return 'active'; }
}
function writeScope(v) {
  const s = normalizeScope(v);
  try { localStorage.setItem(SCOPE_KEY, s); } catch (e) { /* ignore */ }
  return s;
}
let _scope = readScope();
function scopeQuery() { return '&scope=' + encodeURIComponent(_scope); }
// Čo server reálne použil. Keď pole `scope` v odpovedi (ešte) nie je,
// padáme na lokálnu voľbu — chýbajúce pole nesmie stránku rozbiť.
function effectiveScope(data) {
  const fromApi = data && data.scope;
  if (fromApi === 'all' || fromApi === 'active') return fromApi;
  return _scope;
}

function $(sel) {
  return _container.querySelector(sel);
}

function $$(sel) {
  return _container.querySelectorAll(sel);
}

function fmtEur(n) {
  return Number(n).toLocaleString('sk-SK', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' \u20AC';
}

// Percent\u00E1 s jedn\u00FDm desatinn\u00FDm miestom v sk-SK (\u010Diarka), napr. \u201E72,1".
function fmtPct1(n) {
  return (Number(n) || 0).toLocaleString('sk-SK', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

// Vsetky tri kotvene na bratislavsky den (bratislavaDayIso / isoAddDays /
// bratislavaMonthStartIso su zdielane globaly z /api.js).
// Predtym isli cez `toISOString()` nad lokalnym Date, co znamenalo:
//   - todayStr()     medzi 00:00 a 02:00 miestneho casu vratil VCERAJSOK,
//   - monthStartStr() cely letny cas vratil POSLEDNY DEN PREDOSLEHO MESIACA,
//     takze report "tento mesiac" tahal do sumy jeden cudzi den.
function todayStr() {
  return bratislavaDayIso(new Date());
}

function weekAgoStr() {
  return isoAddDays(bratislavaDayIso(new Date()), -6);
}

function monthStartStr() {
  return bratislavaMonthStartIso(new Date());
}

// ── Obdobie ako chipy + „Iné…" (len stav UI, dátový tok ostáva) ──────────
// true = rozsah prišiel z polí v „Iné…", takže žiadny chip obdobia nesvieti.
let _customPeriod = false;

// „1. 9. – 8. 9. 2026" — človek nemá lúštiť ISO dátumy z dvoch políčok.
function fmtRange(fromIso, toIso) {
  const parse = (iso) => { const p = String(iso).split('-').map(Number); return { y: p[0], m: p[1], d: p[2] }; };
  const a = parse(fromIso), b = parse(toIso);
  if (!a.y || !b.y) return fromIso + ' – ' + toIso;
  if (fromIso === toIso) return a.d + '. ' + a.m + '. ' + a.y;
  const left = a.d + '. ' + a.m + '.' + (a.y === b.y ? '' : ' ' + a.y);
  return left + ' – ' + b.d + '. ' + b.m + '. ' + b.y;
}

function renderRangeLine(from, to) {
  const el = _container && _container.querySelector('#rpRange');
  if (el) el.textContent = fmtRange(from, to);
}

// Chip „Iné…" svieti, keď je blok rozbalený alebo keď platí vlastný rozsah.
function syncMoreChip() {
  const moreBtn = _container && _container.querySelector('#rpMore');
  const moreBox = _container && _container.querySelector('#rpMoreBox');
  if (!moreBtn || !moreBox) return;
  moreBtn.classList.toggle('is-on', _customPeriod || !moreBox.hidden);
}

// Zmena dátumu v „Iné…": chipy obdobia zhasnú, inak by „Tento týždeň"
// svietil nad úplne iným rozsahom.
function markCustomPeriod() {
  _customPeriod = true;
  $$('.period-btn').forEach(b => { b.classList.remove('active'); b.setAttribute('aria-pressed', 'false'); });
  syncMoreChip();
}

// ===== LOAD REPORTS FROM API =====
async function loadReports() {
  const from = $('#dateFrom').value;
  const to = $('#dateTo').value;
  const activeTabContent = _container.querySelector('.tab-content.active');
  if (activeTabContent) showLoading(activeTabContent, 'Načítavam reporty...');
  try {
    const data = await api.get('/reports/summary?from=' + from + '&to=' + to + scopeQuery());
    if (activeTabContent) hideLoading(activeTabContent);
    renderRangeLine(from, to);
    // Aj pri prázdnej odpovedi — pás musí zodpovedať zvolenému rozsahu.
    renderScopeNotice(data);
    if (data) {
      renderStats(data);
      renderDestSplit(data);
      renderPaymentMethods(data);
      renderTrzby(data);
      renderLaborByStaff(data);
      renderStaffMealByPerson(data);
      renderProdukty(data);
      renderZamestnanci(data);
      renderHodiny(data);
    } else {
      showEmptyReports();
    }
  } catch (err) {
    if (activeTabContent) hideLoading(activeTabContent);
    showToast(err.message || 'Chyba načítania reportov', 'error');
  }
}

function showEmptyReports() {
  const emptyHtml = '<tr><td colspan="8" class="td-empty">Žiadne dáta pre toto obdobie</td></tr>';
  const trzbyBody = $('#table-trzby tbody');
  if (trzbyBody) trzbyBody.innerHTML = emptyHtml;
  const payBody = $('#table-payments tbody');
  if (payBody) payBody.innerHTML = '<tr><td colspan="4" class="td-empty">Žiadne dáta pre toto obdobie</td></tr>';
  const produktyBody = $('#table-produkty tbody');
  if (produktyBody) produktyBody.innerHTML = '<tr><td colspan="8" class="td-empty">Žiadne dáta pre toto obdobie</td></tr>';
  const zamBody = $('#table-zamestnanci tbody');
  if (zamBody) zamBody.innerHTML = '<tr><td colspan="6" class="td-empty">Žiadne dáta pre toto obdobie</td></tr>';
  const hodBody = $('#table-hodiny tbody');
  if (hodBody) hodBody.innerHTML = '<tr><td colspan="6" class="td-empty">Žiadne dáta pre toto obdobie</td></tr>';
}

function renderStats(data) {
  // Hero (tržby) + riadok súčtu sa plnia podľa poradia .rp-kpi-v v TEMPLATE:
  // 0 tržby, 1 objednávky, 2 priem. účet, 3 tržby/zam., 4 výroba, 5 mzdy,
  // 6 zam. spotreba, 7 výsledok, 8 burgery, 9 odpisy (predaj).
  const statValues = $$('.rp-kpi-v');
  if (data.totalRevenue !== undefined && statValues[0]) {
    statValues[0].innerHTML = fmtEur(data.totalRevenue);
  }
  if (data.totalOrders !== undefined && statValues[1]) {
    statValues[1].textContent = data.totalOrders;
  }
  if (data.avgCheck !== undefined && statValues[2]) {
    statValues[2].innerHTML = fmtEur(data.avgCheck);
  }
  if (data.topRevenue !== undefined && statValues[3]) {
    statValues[3].innerHTML = fmtEur(data.topRevenue);
  }
  // Náklady-na-výrobu (COGS) — sum z receptov × predaj. Položky bez receptu
  // (väčšina barových bezreceptových drinkov, kombá pred recept-update)
  // počítame ako 0 €, čo je dohodnuté zjednodušenie. Číslo sa preto chápe
  // ako "garantované známe COGS", nie horný odhad.
  if (data.totalCogs !== undefined && statValues[4]) {
    statValues[4].innerHTML = fmtEur(data.totalCogs);
  }
  // Mzdy — z attendance_events (clock_in→clock_out) × hourly_rate.
  if (data.totalLabor !== undefined && statValues[5]) {
    statValues[5].innerHTML = fmtEur(data.totalLabor);
  }
  // Zamestnanecka spotreba — naklad na suroviny pre staff meals (write_offs
  // s reason='staff_meal'). Server už vie agregovať per period.
  if (data.totalStaffMeal !== undefined && statValues[6]) {
    statValues[6].innerHTML = fmtEur(data.totalStaffMeal);
  }
  // Výsledok = Tržby − Výroba − Mzdy − Zam.spotreba. Farebne zvýrazníme:
  // zelená pre +, červená pre −, šedá pre 0 — operátor potrebuje na prvý
  // pohľad vidieť či je deň/mesiac v pluse.
  if (data.totalProfit !== undefined && statValues[7]) {
    const v = Number(data.totalProfit) || 0;
    const color = v > 0 ? 'var(--color-success, #22c55e)'
                : v < 0 ? 'var(--color-danger, #ef4444)'
                : 'var(--color-text-sec, #94a3b8)';
    statValues[7].innerHTML = '<span style="color:' + color + '">' + fmtEur(v) + '</span>';
  }
  renderVatSplit(data);
  // Predané burgery — počet kusov (4 burgery + 4 combá dokopy) za obdobie.
  if (data.burgersSold !== undefined && statValues[8]) {
    statValues[8].textContent = data.burgersSold;
  }
  // Odpisy (predaj) — predajná hodnota účtov uzavretých ako manažérsky odpis
  // "na účet podniku" (mimo fiškál). Informatívne: nie je v tržbách ani vo
  // Výsledku. Index 9 = posledná karta v hlavnom KPI gride.
  if (data.totalOdpis !== undefined && statValues[9]) {
    statValues[9].innerHTML = fmtEur(data.totalOdpis);
  }
}

// Rozsah dát — pás nad reportom pri „Celá história“ + nenápadná poznámka
// pri celkovej tržbe v default režime. Bez toho majiteľ vidí buď nafúknuté
// čísla bez vysvetlenia, alebo „prepad tržieb“ a nevie prečo.
function renderScopeNotice(data) {
  const banner = $('#scopeNotice');
  const hint = $('#statScopeNote');
  const eff = effectiveScope(data);

  if (banner) {
    if (eff === 'all') {
      banner.style.display = '';
      banner.innerHTML = '<span>Zobrazenie zahŕňa aj obdobia predchádzajúcich '
        + 'daňových subjektov, ktoré na tejto kase pracovali pred aktuálnym. '
        + 'Súčty sú preto prehľadové a <strong>nie sú podkladom pre priznanie '
        + 'DPH</strong>. Pre daňové účely prepnite späť na rozsah '
        + '„Táto kasa“.</span>';
    } else {
      banner.style.display = 'none';
      banner.innerHTML = '';
    }
  }

  // Uzávierka ide vždy v rozsahu aktuálnej kasy — pri 'all' na to upozorni,
  // nech sa rozdiel voči ostatným záložkám nečíta ako chyba.
  const zNote = $('#zScopeNote');
  if (zNote) zNote.style.display = eff === 'all' ? '' : 'none';

  if (hint) {
    if (eff === 'active') {
      const code = data && data.cashRegisterCode ? String(data.cashRegisterCode) : '';
      hint.style.display = '';
      hint.textContent = 'len táto kasa' + (code ? ' (DKP ' + code + ')' : '')
        + ' od jej prvého dokladu — staršie subjekty cez „Celá história“';
    } else {
      hint.style.display = 'none';
      hint.textContent = '';
    }
  }
}

// DPH rozpad + marža zo základu dane. Zobrazí sa LEN platiteľovi
// (data.vatRegistered === true). U neplatiteľa je totalRevenueNet zhodné
// s totalRevenue, obidva riadky ostanú skryté a karty vyzerajú ako doteraz.
function renderVatSplit(data) {
  const vatNote = $('#statVatNote');
  const marginNote = $('#statProfitMargin');
  const hasNet = !!(data && data.vatRegistered === true
    && data.totalRevenueNet !== null && data.totalRevenueNet !== undefined
    && Number.isFinite(Number(data.totalRevenueNet)));

  if (!hasNet) {
    if (vatNote) { vatNote.style.display = 'none'; vatNote.textContent = ''; }
    if (marginNote) { marginNote.style.display = 'none'; marginNote.textContent = ''; }
    return;
  }

  const gross = Number(data.totalRevenue) || 0;
  const net = Number(data.totalRevenueNet) || 0;
  const vat = Number.isFinite(Number(data.totalVatOutput)) ? Number(data.totalVatOutput) : (gross - net);

  if (vatNote) {
    vatNote.style.display = '';
    vatNote.textContent = 'z toho DPH na odvod ' + fmtEur(vat) + ' · základ dane ' + fmtEur(net);
  }
  if (marginNote) {
    const profit = Number(data.totalProfit) || 0;
    const pct = net > 0 ? (profit / net) * 100 : 0;
    marginNote.style.display = '';
    marginNote.textContent = '· ' + fmtPct1(pct) + ' % marža zo základu dane';
  }
}

// Bar vs Kuchyňa revenue split — sits above the daily Trzby table so the
// owner sees at-a-glance how much was earned by each destination. The
// percentage is computed against the sum of (bar+kuchyna) only, NOT the
// fiscal totalRevenue (which includes shisha + item-less payments).
function renderDestSplit(data) {
  const host = $('#destSplit');
  if (!host) return;
  const r = data.revenueByDest || { bar: 0, kuchyna: 0, itemsBar: 0, itemsKuchyna: 0 };
  const bar = Number(r.bar) || 0;
  const kuch = Number(r.kuchyna) || 0;
  const sum = bar + kuch;
  const pct = (n) => sum > 0 ? Math.round((n / sum) * 100) : 0;
  // Jeden pruh + riadok súčtu namiesto dvoch KPI kariet (na telefóne 2 × 91 px).
  host.innerHTML =
    '<div class="rp-split">' +
      '<div class="rp-split-bar" aria-hidden="true">' +
        '<span class="is-bar" style="width:' + pct(bar) + '%"></span>' +
        '<span class="is-kuch" style="width:' + pct(kuch) + '%"></span>' +
      '</div>' +
      '<div class="doch-sum rp-sum">' +
        '<span class="rp-sum-i"><span class="rp-dot is-bar" aria-hidden="true"></span><strong>' + fmtEur(bar) + '</strong> bar <small>' + (r.itemsBar || 0) + ' ks · ' + pct(bar) + ' %</small></span>' +
        '<span class="rp-sum-i"><span class="rp-dot is-kuch" aria-hidden="true"></span><strong>' + fmtEur(kuch) + '</strong> kuchyňa <small>' + (r.itemsKuchyna || 0) + ' ks · ' + pct(kuch) + ' %</small></span>' +
      '</div>' +
    '</div>';
}

// Tržby podľa spôsobu platby za zvolené obdobie. Predtým bolo vidno len na
// dashboarde (dnešný deň). Tu rešpektuje from/to filter. Hotovosť zo shishy
// je mimo fiškál (samostatný counter) — zobrazíme ju ako extra riadok aby
// owner videl kompletný cash obraz pri zúčtovaní zásuvky.
function renderPaymentMethods(data) {
  const tbody = $('#table-payments tbody');
  const tfoot = $('#table-payments tfoot');
  if (!tbody) return;
  const methodLabels = { hotovost: 'Hotovosť', karta: 'Karta', cash: 'Hotovosť', card: 'Karta' };
  const methods = (data.methods || []).slice();
  // Shisha = off-fiscal cash. Pridáme samostatný riadok ak má hodnotu.
  const shishaRev = data.shisha ? Number(data.shisha.revenue) || 0 : 0;
  const shishaCnt = data.shisha ? Number(data.shisha.count) || 0 : 0;

  const fiscalTotal = methods.reduce((s, m) => s + (Number(m.total) || 0), 0);
  const grandTotal = fiscalTotal + shishaRev;

  if (!methods.length && shishaRev <= 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="td-empty">Žiadne platby za toto obdobie</td></tr>';
    if (tfoot) tfoot.innerHTML = '';
    return;
  }

  const rows = methods.map((m) => {
    const label = methodLabels[m.method] || (m.method.charAt(0).toUpperCase() + m.method.slice(1));
    const total = Number(m.total) || 0;
    const share = grandTotal > 0 ? Math.round((total / grandTotal) * 1000) / 10 : 0;
    const barW = grandTotal > 0 ? Math.round((total / grandTotal) * 100) : 0;
    return '<tr>' +
      '<td class="td-name">' + label + '</td>' +
      '<td class="num text-right">' + (m.count || 0) + '×</td>' +
      '<td class="num highlight-cell text-right">' + fmtEur(total) + '</td>' +
      '<td><div class="progress-wrap"><div class="progress-fill" style="width:' + barW + '%"></div></div>' + fmtPct1(share) + ' %</td>' +
    '</tr>';
  });

  if (shishaRev > 0) {
    const share = grandTotal > 0 ? Math.round((shishaRev / grandTotal) * 1000) / 10 : 0;
    const barW = grandTotal > 0 ? Math.round((shishaRev / grandTotal) * 100) : 0;
    rows.push('<tr>' +
      '<td class="td-name">Hotovosť <span style="color:var(--color-text-dim);font-size:11px">(shisha, mimo fiškál)</span></td>' +
      '<td class="num text-right">' + shishaCnt + '×</td>' +
      '<td class="num highlight-cell text-right">' + fmtEur(shishaRev) + '</td>' +
      '<td><div class="progress-wrap"><div class="progress-fill" style="width:' + barW + '%"></div></div>' + fmtPct1(share) + ' %</td>' +
    '</tr>');
  }

  tbody.innerHTML = rows.join('');
  if (tfoot) {
    tfoot.innerHTML = '<tr>' +
      '<td>Spolu</td>' +
      '<td class="num text-right"></td>' +
      '<td class="num text-right color-accent">' + fmtEur(grandTotal) + '</td>' +
      '<td></td>' +
    '</tr>';
  }
}

function renderTrzby(data) {
  const tbody = $('#table-trzby tbody');
  if (!tbody) return;
  if (!data.daily || !data.daily.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="td-empty">Žiadne dáta pre toto obdobie</td></tr>';
    return;
  }
  if (!tbody) return;
  // Per-day rows now also show Výroba (COGS), Mzdy, Výsledok. Profit cell
  // is colored — green for positive day, red for negative — so the operator
  // can scan a week and immediately spot bad days. Edge: if revenue=0 but
  // labor>0 (e.g. paid-shift on a closed day), the row appears with red.
  tbody.innerHTML = data.daily.map(d => {
    const profit = Number(d.profit) || 0;
    const profitColor = profit > 0 ? 'var(--color-success, #22c55e)'
                      : profit < 0 ? 'var(--color-danger, #ef4444)'
                      : 'var(--color-text-sec, #94a3b8)';
    return `<tr>
      <td>${d.date}</td>
      <td class="num">${d.orders}</td>
      <td class="num highlight-cell">${fmtEur(d.revenue)}</td>
      <td class="num">${fmtEur(d.odpis || 0)}</td>
      <td class="num">${fmtEur(d.cogs || 0)}</td>
      <td class="num">${fmtEur(d.labor || 0)}</td>
      <td class="num" style="font-weight:700;color:${profitColor}">${fmtEur(profit)}</td>
      <td class="num">${fmtEur(d.avgCheck)}</td>
    </tr>`;
  }).join('');

  const tfoot = $('#table-trzby tfoot');
  if (tfoot && data.totalRevenue !== undefined) {
    const tProfit = Number(data.totalProfit) || 0;
    const tProfitColor = tProfit > 0 ? 'var(--color-success, #22c55e)'
                      : tProfit < 0 ? 'var(--color-danger, #ef4444)'
                      : 'var(--color-text-sec, #94a3b8)';
    tfoot.innerHTML = `<tr>
      <td>Spolu</td>
      <td class="num text-right">${data.totalOrders || ''}</td>
      <td class="num text-right color-accent">${fmtEur(data.totalRevenue)}</td>
      <td class="num text-right">${data.totalOdpis !== undefined ? fmtEur(data.totalOdpis) : ''}</td>
      <td class="num text-right">${data.totalCogs !== undefined ? fmtEur(data.totalCogs) : ''}</td>
      <td class="num text-right">${data.totalLabor !== undefined ? fmtEur(data.totalLabor) : ''}</td>
      <td class="num text-right" style="font-weight:700;color:${tProfitColor}">${data.totalProfit !== undefined ? fmtEur(tProfit) : ''}</td>
      <td class="num text-right">${data.avgCheck !== undefined ? fmtEur(data.avgCheck) : ''}</td>
    </tr>`;
  }
}

// Mzdy podla zamestnancov — paired clock_in -> clock_out × hourly_rate.
// Skryje cely panel ked nie su data (napr. obdobie bez zmien).
function renderLaborByStaff(data) {
  const panel = $('#laborByStaffPanel');
  if (!panel) return;
  const rows = (data && Array.isArray(data.laborByStaff)) ? data.laborByStaff : [];
  if (!rows.length) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = '';
  const tbody = $('#table-labor-staff tbody');
  const tfoot = $('#table-labor-staff tfoot');
  if (!tbody || !tfoot) return;

  function fmtHours(h) {
    const total = Number(h) || 0;
    const hh = Math.floor(total);
    const mm = Math.round((total - hh) * 60);
    return hh + 'h ' + String(mm).padStart(2, '0') + 'm';
  }

  let totalShifts = 0;
  let totalHours = 0;
  let totalLabor = 0;
  tbody.innerHTML = rows.map(r => {
    const hours = Number(r.hours) || 0;
    const labor = Number(r.labor) || 0;
    const rate = Number(r.hourlyRate) || 0;
    const shifts = Number(r.shifts) || 0;
    totalShifts += shifts;
    totalHours += hours;
    totalLabor += labor;
    return `<tr>
      <td class="td-name">${escapeHtml(r.name || '--')}</td>
      <td>${escapeHtml(r.position) || '<span style="color:var(--color-text-dim)">—</span>'}</td>
      <td class="num text-right">${shifts}</td>
      <td class="num text-right">${fmtHours(hours)}</td>
      <td class="num text-right" style="color:var(--color-text-sec)">${rate > 0 ? fmtEur(rate) + '/h' : '<span style="color:var(--color-text-dim)">—</span>'}</td>
      <td class="num text-right" style="font-weight:var(--weight-bold)">${fmtEur(labor)}</td>
    </tr>`;
  }).join('');

  tfoot.innerHTML = `<tr>
    <td colspan="2">Spolu</td>
    <td class="num text-right">${totalShifts}</td>
    <td class="num text-right">${fmtHours(totalHours)}</td>
    <td class="num text-right" style="color:var(--color-text-sec)">—</td>
    <td class="num text-right" style="font-weight:var(--weight-bold);color:var(--color-accent)">${fmtEur(totalLabor)}</td>
  </tr>`;
}

// Zamestnanecka spotreba podla mena (= meno stola v zone Zamestanci).
// Naklad rozdeleny na jedlo (kuchyna) a napoje (bar) cez category.dest —
// owner vidi ze napr. Yevhen ide hlavne na napoje (kola), Tania na jedlo.
// Skryje cely panel ak nie su data — vacsina periodov ma 0 staff meals,
// nechceme prazdny panel mast vizual.
function renderStaffMealByPerson(data) {
  const panel = $('#staffMealPanel');
  if (!panel) return;
  const rows = (data && Array.isArray(data.staffMealByPerson)) ? data.staffMealByPerson : [];
  if (!rows.length) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = '';
  const tbody = $('#table-staff-meal tbody');
  const tfoot = $('#table-staff-meal tfoot');
  if (!tbody || !tfoot) return;

  let totalMeals = 0;
  let totalFood = 0;
  let totalDrink = 0;
  let totalCost = 0;
  let totalMenuValue = 0;
  tbody.innerHTML = rows.map(r => {
    const meals = Number(r.meals) || 0;
    const food = Number(r.foodCost) || 0;
    const drink = Number(r.drinkCost) || 0;
    const cost = Number(r.cost) || 0;
    const menuValue = Number(r.menuValue) || 0;
    totalMeals += meals;
    totalFood += food;
    totalDrink += drink;
    totalCost += cost;
    totalMenuValue += menuValue;
    return `<tr>
      <td class="td-name">${escapeHtml(r.name || '--')}</td>
      <td class="num text-right">${meals}</td>
      <td class="num text-right" style="color:var(--color-text-sec)">${food > 0 ? fmtEur(food) : '<span style="color:var(--color-text-dim)">—</span>'}</td>
      <td class="num text-right" style="color:var(--color-text-sec)">${drink > 0 ? fmtEur(drink) : '<span style="color:var(--color-text-dim)">—</span>'}</td>
      <td class="num text-right" style="font-weight:var(--weight-bold)">${fmtEur(cost)}</td>
      <td class="num text-right" style="color:var(--color-text)" title="Koľko by zaplatil zákazník">${fmtEur(menuValue)}</td>
    </tr>`;
  }).join('');

  tfoot.innerHTML = `<tr>
    <td>Spolu</td>
    <td class="num text-right">${totalMeals}</td>
    <td class="num text-right" style="color:var(--color-text-sec)">${fmtEur(totalFood)}</td>
    <td class="num text-right" style="color:var(--color-text-sec)">${fmtEur(totalDrink)}</td>
    <td class="num text-right" style="font-weight:var(--weight-bold);color:var(--accent-amber, #f59e0b)">${fmtEur(totalCost)}</td>
    <td class="num text-right" style="font-weight:var(--weight-bold)">${fmtEur(totalMenuValue)}</td>
  </tr>`;
}

function renderProdukty(data) {
  const tbody = $('#table-produkty tbody');
  if (!tbody) return;
  // Cache the dataset so a header-click can re-render without a new request.
  _lastProductsData = data;
  updateProductHeaderArrows();
  updateProductFilterStats();
  if (!data.products || !data.products.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="td-empty">Žiadne dáta pre toto obdobie</td></tr>';
    renderProductsByDay(data);
    return;
  }
  // Apply dest filter BEFORE sorting — operator filtruje pred sort-om
  // (logická poradie: výber zóny → poradie v rámci zóny).
  const filtered = (data.products || []).filter(p => {
    if (_productDestFilter === 'all') return true;
    return (p.dest || 'bar') === _productDestFilter;
  });
  if (!filtered.length) {
    const filterLabel = _productDestFilter === 'kuchyna' ? 'kuchyňa' : 'bar';
    tbody.innerHTML = '<tr><td colspan="8" class="td-empty">Žiadne predaje v zóne ' + filterLabel + ' za toto obdobie</td></tr>';
    renderProductsByDay(data);
    return;
  }
  const sorted = filtered.slice().sort(productComparator(_productSort));
  // The progress bar always uses the period's max revenue as the 100% mark
  // so two products are visually comparable regardless of current sort.
  const maxRev = Math.max(...sorted.map(p => p.revenue));
  tbody.innerHTML = sorted.map((p, i) => {
    const pct = maxRev > 0 ? Math.round((p.revenue / (data.totalRevenue || maxRev)) * 1000) / 10 : 0;
    const barW = maxRev > 0 ? Math.round((p.revenue / maxRev) * 100) : 0;
    let rankStyle = '';
    if (i === 0) rankStyle = 'color:var(--color-accent);font-weight:700';
    else if (i === 1) rankStyle = 'color:var(--color-text-sec);font-weight:700';
    else if (i === 2) rankStyle = 'color:rgba(205,127,50,.7);font-weight:700';
    const display = (p.emoji ? p.emoji + ' ' : '') + (p.name || '');
    // Dest pill — visual ukazovatel zony (kuchyna vs bar) pri kazdom riadku
    const dest = p.dest || 'bar';
    const destPill = dest === 'kuchyna'
      ? ' <span class="rp-pill is-warn rp-pill-xs">kuchyňa</span>'
      : ' <span class="rp-pill is-info rp-pill-xs">bar</span>';
    const categoryCell = (p.category || '') + (_productDestFilter === 'all' ? destPill : '');
    // Per-product Výroba & Výsledok — položky bez receptu majú cogs=0,
    // takže ich Výsledok = Tržba (čisté marže). Farba Výsledku zvýrazní
    // straty (záporná marža = chybný recept alebo nákupná cena).
    const cogs = Number(p.cogs) || 0;
    const profit = Number(p.profit) || 0;
    const profitColor = profit > 0 ? 'var(--color-success, #22c55e)'
                      : profit < 0 ? 'var(--color-danger, #ef4444)'
                      : 'var(--color-text-sec, #94a3b8)';
    return `<tr>
      <td class="num" style="${rankStyle}">${i + 1}</td>
      <td class="td-name">${display}</td>
      <td>${categoryCell}</td>
      <td class="num">${p.qty}</td>
      <td class="num highlight-cell">${fmtEur(p.revenue)}</td>
      <td class="num">${fmtEur(cogs)}</td>
      <td class="num" style="font-weight:700;color:${profitColor}">${fmtEur(profit)}</td>
      <td><div class="progress-wrap"><div class="progress-fill" style="width:${barW}%"></div></div>${fmtPct1(pct)} %</td>
    </tr>`;
  }).join('');

  renderProductsByDay(data);
}

// Update filter chip stats — kazdy chip ma "(N)" suffix s poctom produktov
// v tej zone. Pomaha rychlo vidiet kolko polozk je v kuchyni vs bare.
function updateProductFilterStats() {
  if (!_container || !_lastProductsData) return;
  const all = (_lastProductsData.products || []).length;
  const kuch = (_lastProductsData.products || []).filter(p => (p.dest || 'bar') === 'kuchyna').length;
  const bar = (_lastProductsData.products || []).filter(p => (p.dest || 'bar') === 'bar').length;
  // Sum qty + revenue per filter for the badge under chips
  function sumFor(dest) {
    const items = (_lastProductsData.products || []).filter(p => dest === 'all' || (p.dest || 'bar') === dest);
    const q = items.reduce((s, p) => s + (Number(p.qty) || 0), 0);
    const r = items.reduce((s, p) => s + (Number(p.revenue) || 0), 0);
    return { q, r };
  }
  const stat = sumFor(_productDestFilter);
  const chipAll = _container.querySelector('#chipDestAll .chip-count');
  const chipKuch = _container.querySelector('#chipDestKuch .chip-count');
  const chipBar = _container.querySelector('#chipDestBar .chip-count');
  if (chipAll) chipAll.textContent = '(' + all + ')';
  if (chipKuch) chipKuch.textContent = '(' + kuch + ')';
  if (chipBar) chipBar.textContent = '(' + bar + ')';
  const filterStats = _container.querySelector('#productFilterStats');
  if (filterStats) {
    const filterLabel = _productDestFilter === 'all' ? 'Všetko'
                      : _productDestFilter === 'kuchyna' ? 'Kuchyňa'
                      : 'Bar';
    filterStats.innerHTML = filterLabel + ': ' + stat.q + ' ks · ' + fmtEur(stat.r);
  }
  // Toggle active state on chips
  ['chipDestAll', 'chipDestKuch', 'chipDestBar'].forEach(id => {
    const el = _container.querySelector('#' + id);
    if (!el) return;
    const matches = (id === 'chipDestAll' && _productDestFilter === 'all')
                 || (id === 'chipDestKuch' && _productDestFilter === 'kuchyna')
                 || (id === 'chipDestBar' && _productDestFilter === 'bar');
    el.classList.toggle('chip-active', matches);
  });
}

// Per-day pivot — riadky = položky ALEBO kategórie, stĺpce = dni. Cellka =
// predané ks alebo tržba € (podľa _productByDayMetric). Pomaha managerovi
// vidiet "ako sa burgery / kategórie hybali za tyzden". Top-N riadkov podla
// total (po filtri kuchyna/bar/vsetko). Prazdne dni stale zobrazujeme aby
// trend bol vizualne kontinuálny.
function renderProductsByDay(data) {
  const host = $('#productsByDayHost');
  if (!host) return;
  updateProductByDayToggles();
  updateProductByDaySubtitle();
  const rows = (data && Array.isArray(data.productsByDay)) ? data.productsByDay : [];
  if (!rows.length) {
    host.innerHTML = '<div class="empty-hint" style="padding:14px">Žiadne predaje za toto obdobie.</div>';
    return;
  }
  // Filter pred pivotom (same filter ako tabulka vyssie)
  const filtered = rows.filter(r => {
    if (_productDestFilter === 'all') return true;
    return (r.dest || 'bar') === _productDestFilter;
  });
  if (!filtered.length) {
    host.innerHTML = '<div class="empty-hint" style="padding:14px">Žiadne predaje pre tento filter.</div>';
    return;
  }

  const isRev = _productByDayMetric === 'revenue';
  const byCat = _productByDayGroup === 'category';
  // Bunky: ks = celé kusy, tržba = zaokrúhlené euro bez desatín (aby sa do
  // širokej per-day matice zmestilo viac stĺpcov). Presné € s desatinami
  // ukazujeme v Σ stĺpci a v riadku Spolu, kde je priestor.
  const cellVal = (r) => isRev ? (Number(r.revenue) || 0) : (Number(r.qty) || 0);
  const fmtCellNum = (v) => isRev ? Math.round(v).toLocaleString('sk-SK') : String(v);
  const fmtTotal = (v) => isRev ? fmtEur(v) : String(v);

  // Build pivot: pivotMap[key] = { name, dest, total, days: {date: value} }
  const pivotMap = {};
  const dateSet = new Set();
  for (const r of filtered) {
    const key = byCat ? (r.category || 'Bez kategórie') : r.name;
    if (!pivotMap[key]) pivotMap[key] = { name: key, dest: r.dest || 'bar', total: 0, days: {} };
    pivotMap[key].days[r.date] = (pivotMap[key].days[r.date] || 0) + cellVal(r);
    pivotMap[key].total += cellVal(r);
    dateSet.add(r.date);
  }
  const dates = Array.from(dateSet).sort();
  const items = Object.values(pivotMap).sort((a, b) => b.total - a.total).slice(0, _productByDayLimit);

  // Format date header: '26.5' (SK short) — kratke aby sa zmestilo viac stlpcov
  function shortDate(iso) {
    const parts = iso.split('-'); // [yyyy, mm, dd]
    return parseInt(parts[2], 10) + '.' + parseInt(parts[1], 10) + '.';
  }

  let html = '<div class="table-scroll-wrap"><table class="data-table" style="font-size:13px">';
  html += '<thead><tr>';
  html += '<th>' + (byCat ? 'Kategória' : 'Položka') + '</th>';
  for (const d of dates) {
    html += '<th class="text-right" title="' + d + '">' + shortDate(d) + '</th>';
  }
  html += '<th class="text-right" style="background:rgba(184,84,42,.05)">Σ' + (isRev ? ' €' : '') + '</th>';
  html += '</tr></thead>';

  // Find max cell value across all cells for color intensity
  let maxCell = 0;
  for (const it of items) {
    for (const d of dates) {
      const v = it.days[d] || 0;
      if (v > maxCell) maxCell = v;
    }
  }

  html += '<tbody>';
  for (const it of items) {
    // Pri zoskupení podľa kategórie nedáva dest pill zmysel per riadok
    // (kategória má vlastnú zónu) — pill necháme len pri jednotlivých položkách.
    const destPill = it.dest === 'kuchyna'
      ? '<span class="rp-dot is-kuch" title="kuchyňa"></span>'
      : '<span class="rp-dot is-bar" title="bar"></span>';
    html += '<tr>';
    html += '<td class="td-name">' + (byCat ? '' : destPill) + escapeHtml(it.name) + '</td>';
    for (const d of dates) {
      const q = it.days[d] || 0;
      if (q === 0) {
        html += '<td class="num text-right" style="color:var(--color-text-dim)">·</td>';
      } else {
        // Heat color: vyššia hodnota = intenzivnejsie pozadie
        const intensity = maxCell > 0 ? (q / maxCell) : 0;
        const bg = 'rgba(184,84,42,' + (0.06 + intensity * 0.22).toFixed(3) + ')';
        const fw = intensity > 0.7 ? '700' : intensity > 0.4 ? '600' : '500';
        html += '<td class="num text-right" style="background:' + bg + ';font-weight:' + fw + '">' + fmtCellNum(q) + '</td>';
      }
    }
    html += '<td class="num text-right" style="background:rgba(184,84,42,.05);font-weight:700">' + fmtTotal(it.total) + '</td>';
    html += '</tr>';
  }
  // Sum row na konci — vertikalny total per den
  html += '</tbody><tfoot><tr>';
  html += '<td><strong>Spolu</strong></td>';
  let grandTotal = 0;
  for (const d of dates) {
    let colSum = 0;
    for (const it of items) colSum += (it.days[d] || 0);
    grandTotal += colSum;
    html += '<td class="num text-right"><strong>' + fmtCellNum(colSum) + '</strong></td>';
  }
  html += '<td class="num text-right" style="background:rgba(184,84,42,.08)"><strong>' + fmtTotal(grandTotal) + '</strong></td>';
  html += '</tr></tfoot></table></div>';

  // Hint pod tabulkou
  const totalItems = Object.keys(pivotMap).length;
  if (totalItems > _productByDayLimit) {
    html += '<div style="margin-top:8px;font-size:12px;color:var(--color-text-sec);text-align:right">'
      + 'Zobrazený top ' + _productByDayLimit + ' z ' + totalItems + ' '
      + (byCat ? 'kategórií' : 'položiek') + '.</div>';
  }

  host.innerHTML = html;
}

// Zvýrazní aktívny prepínač metriky/zoskupenia v paneli "Predaj za deň".
function updateProductByDayToggles() {
  if (!_container) return;
  const state = {
    pbdMetricQty: _productByDayMetric === 'qty',
    pbdMetricRev: _productByDayMetric === 'revenue',
    pbdGroupItem: _productByDayGroup === 'item',
    pbdGroupCat: _productByDayGroup === 'category',
  };
  Object.keys(state).forEach((id) => {
    const el = _container.querySelector('#' + id);
    if (el) el.classList.toggle('chip-active', state[id]);
  });
}

// Aktualizuje podnadpis panelu "Predaj za deň" podľa zvolenej metriky/zoskupenia.
function updateProductByDaySubtitle() {
  if (!_container) return;
  const el = _container.querySelector('#pbdSubtitle');
  if (!el) return;
  const metric = _productByDayMetric === 'revenue' ? 'tržba (€)' : 'počet kusov';
  const group = _productByDayGroup === 'category' ? 'podľa kategórie' : 'podľa položky';
  el.textContent = metric + ' ' + group + ' každý deň';
}

// Build a stable comparator from the current sort state. Numeric columns
// (qty, revenue, pct) compare as numbers; text columns (name, category)
// use locale-aware compare so 'Špargľa' sorts where a Slovak speaker
// expects. Falls back to qty desc for unknown column ids.
function productComparator(sort) {
  const dir = sort && sort.dir === 'asc' ? 1 : -1;
  const col = sort && sort.col;
  if (col === 'name') {
    return (a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'sk') * dir;
  }
  if (col === 'category') {
    return (a, b) => {
      const c = String(a.category || '').localeCompare(String(b.category || ''), 'sk') * dir;
      // Tie-break by qty desc so two items in the same category aren't
      // randomly ordered.
      if (c !== 0) return c;
      return ((Number(b.qty) || 0) - (Number(a.qty) || 0));
    };
  }
  if (col === 'revenue' || col === 'pct') {
    return (a, b) => ((Number(a.revenue) || 0) - (Number(b.revenue) || 0)) * dir;
  }
  if (col === 'cogs') {
    return (a, b) => ((Number(a.cogs) || 0) - (Number(b.cogs) || 0)) * dir;
  }
  if (col === 'profit') {
    return (a, b) => ((Number(a.profit) || 0) - (Number(b.profit) || 0)) * dir;
  }
  // default + 'qty'
  return (a, b) => ((Number(a.qty) || 0) - (Number(b.qty) || 0)) * dir;
}

// Toggle the chevron next to each sortable header so the user can see at
// a glance which column drives the current order.
function updateProductHeaderArrows() {
  const ths = _container && _container.querySelectorAll('#table-produkty thead th[data-sort-col]');
  if (!ths) return;
  ths.forEach((th) => {
    const arrow = th.querySelector('.sort-arrow');
    if (!arrow) return;
    if (th.dataset.sortCol === _productSort.col) {
      arrow.textContent = _productSort.dir === 'asc' ? '▲' : '▼';
      th.classList.add('sort-active');
    } else {
      arrow.textContent = '';
      th.classList.remove('sort-active');
    }
  });
}

// Click handler bound once at init: figures out which column was clicked
// and either flips direction (same col) or sets a sensible default
// direction (numeric → desc, text → asc).
function onProductHeaderClick(e) {
  const th = e.target.closest('#table-produkty thead th[data-sort-col]');
  if (!th) return;
  const col = th.dataset.sortCol;
  if (_productSort.col === col) {
    _productSort.dir = _productSort.dir === 'asc' ? 'desc' : 'asc';
  } else {
    _productSort.col = col;
    _productSort.dir = (col === 'name' || col === 'category') ? 'asc' : 'desc';
  }
  if (_lastProductsData) renderProdukty(_lastProductsData);
}

function renderZamestnanci(data) {
  const tbody = $('#table-zamestnanci tbody');
  if (!tbody) return;
  if (!data.staff || !data.staff.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="td-empty">Žiadne dáta pre toto obdobie</td></tr>';
    return;
  }
  if (!tbody) return;
  tbody.innerHTML = data.staff.map(s => {
    const starCount = Math.min(5, Math.max(0, Math.round(s.rating || 0)));
    const stars = '\u2605'.repeat(starCount) + '\u2606'.repeat(5 - starCount);
    return `<tr>
      <td class="td-name">${escapeHtml(s.name)}</td>
      <td class="num">${s.shifts || ''}</td>
      <td class="num">${s.orders || ''}</td>
      <td class="num highlight-cell">${fmtEur(s.revenue)}</td>
      <td class="num">${fmtEur(s.avgCheck)}</td>
      <td><span class="stars">${stars}</span></td>
    </tr>`;
  }).join('');
}

function renderHodiny(data) {
  const tbody = $('#table-hodiny tbody');
  if (!tbody) return;
  if (!data.hourly || !data.hourly.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="td-empty">Žiadne dáta pre toto obdobie</td></tr>';
    const tfootEmpty = $('#table-hodiny tfoot');
    if (tfootEmpty) tfootEmpty.innerHTML = '';
    return;
  }
  // Peak detection still uses the per-hour share of the period's busiest
  // hour (>= 85% of max orders) so the cashier can spot rush hours.
  // Bar/Kuchyňa columns are item-based (qty * price) — the 'Spolu' column
  // shows the payment-based total, so Bar+Kuchyňa may not sum exactly to
  // Spolu when discounts or partial-pay scenarios are involved.
  const maxOrders = Math.max(...data.hourly.map(h => h.orders));
  let totBar = 0, totKuch = 0, totSpolu = 0, totObj = 0;
  tbody.innerHTML = data.hourly.map(h => {
    const pct = maxOrders > 0 ? Math.round((h.orders / maxOrders) * 100) : 0;
    const isPeak = pct >= 85;
    const bar = Number(h.barRevenue) || 0;
    const kuch = Number(h.kuchynaRevenue) || 0;
    totBar += bar; totKuch += kuch;
    totSpolu += Number(h.revenue) || 0;
    totObj += Number(h.orders) || 0;
    return `<tr${isPeak ? ' class="peak-row"' : ''}>
      <td class="num">${h.hour}</td>
      <td class="num">${h.orders}</td>
      <td class="num">${bar > 0 ? fmtEur(bar) : '<span class="color-dim">—</span>'}</td>
      <td class="num">${kuch > 0 ? fmtEur(kuch) : '<span class="color-dim">—</span>'}</td>
      <td class="num${isPeak ? ' highlight-cell' : ''}">${fmtEur(h.revenue)}</td>
      <td>${isPeak ? '<span class="peak-badge">PEAK</span>' : ''}</td>
    </tr>`;
  }).join('');
  const tfoot = $('#table-hodiny tfoot');
  if (tfoot) {
    tfoot.innerHTML = `<tr>
      <td>Spolu</td>
      <td class="num">${totObj}</td>
      <td class="num">${fmtEur(totBar)}</td>
      <td class="num">${fmtEur(totKuch)}</td>
      <td class="num color-accent">${fmtEur(totSpolu)}</td>
      <td></td>
    </tr>`;
  }
}

// ===== STAFF REPORT (CISNICKY TAB) =====
async function loadStaffReport() {
  const from = $('#dateFrom').value;
  const to = $('#dateTo').value;
  const tabContent = _container.querySelector('#tab-cisnicky');
  if (tabContent) showLoading(tabContent, 'Načítavam čašníkov…');
  try {
    const data = await api.get('/reports/staff?from=' + from + '&to=' + to + scopeQuery());
    if (tabContent) hideLoading(tabContent);
    if (!data || data.length === 0) {
      $('#staffTableBody').innerHTML = '<tr><td colspan="9" class="td-empty">Žiadne dáta pre toto obdobie</td></tr>';
      $('#staffBars').innerHTML = '<div class="loading-placeholder">Žiadne dáta pre zvolené obdobie</div>';
      return;
    }

    // Bar chart
    const maxRevenue = Math.max(...data.map(s => s.revenue));
    $('#staffBars').innerHTML = data.map(s => {
      const pct = maxRevenue > 0 ? Math.round((s.revenue / maxRevenue) * 100) : 0;
      return `<div class="staff-bar-row">
        <div class="staff-bar-name">${escapeHtml(s.name)}</div>
        <div class="staff-bar" style="width:${pct}%"><span class="staff-bar-value">${fmtEur(s.revenue)}</span></div>
      </div>`;
    }).join('');

    // Table
    $('#staffTableBody').innerHTML = data.map(s =>
      `<tr>
        <td class="td-name">${escapeHtml(s.name)}</td>
        <td>${s.role}</td>
        <td class="num">${s.ordersCount}</td>
        <td class="num">${s.itemsCount}</td>
        <td class="num highlight-cell">${fmtEur(s.revenue)}</td>
        <td class="num">${fmtEur(s.averageOrder)}</td>
        <td class="num">${fmtEur(s.cashPayments)}</td>
        <td class="num">${fmtEur(s.cardPayments)}</td>
        <td class="num color-danger">${s.cancelledOrders}</td>
      </tr>`
    ).join('');
  } catch (err) {
    if (tabContent) hideLoading(tabContent);
    showToast(err.message || 'Chyba načítania čašníkov', 'error');
    $('#staffTableBody').innerHTML = '<tr><td colspan="9" class="td-empty color-danger">Chyba: ' + err.message + '</td></tr>';
  }
}

// ===== Z-REPORT (UZAVIERKA) =====
async function generateZReport() {
  const date = $('#zReportDate').value;
  if (!date) return;
  const btn = $('#btnGenZReport');
  if (btn) btnLoading(btn);
  try {
    const data = await api.get('/reports/z-report?date=' + date);
    _lastZData = data;
    $('#zReportContent').style.display = 'block';

    $('#zTotalRevenue').innerHTML = fmtEur(data.totalRevenue);
    $('#zOrdersItems').textContent = data.totalOrders + ' / ' + data.totalItems;
    $('#zAvgOrder').innerHTML = fmtEur(data.averageOrder);

    // Payment methods
    const pmDiv = $('#zPaymentMethods');
    if (data.paymentMethods.length === 0) {
      pmDiv.innerHTML = '<div class="loading-placeholder">Žiadne platby</div>';
    } else {
      pmDiv.innerHTML = data.paymentMethods.map(pm => {
        const label = pm.method.charAt(0).toUpperCase() + pm.method.slice(1);
        return `<div class="z-payment-row">
          <span class="td-name">${label} <span class="color-dim">(${pm.count}x)</span></span>
          <span class="uzavierka-value-accent" style="font-size:inherit">${fmtEur(pm.total)}</span></div>`;
      }).join('');
    }

    // Cancelled
    $('#zCancelled').innerHTML =
      `<div class="uzavierka-value color-danger" style="margin-bottom:4px">${data.cancelledItems}</div>` +
      `<div class="loading-placeholder">${data.cancelledTotal > 0 ? 'Strata: ' + fmtEur(data.cancelledTotal) : 'Žiadne storna'}</div>`;

    // Odpisy (predaj) — predajná hodnota účtov uzavretých ako manažérsky odpis
    // (mimo fiškál). Mimo tržby aj mimo platobných metód.
    const zOdEl = $('#zOdpis');
    if (zOdEl) {
      zOdEl.innerHTML = fmtEur(data.odpisTotal || 0)
        + (data.odpisCount ? ` <span class="color-dim" style="font-size:12px">(${data.odpisCount}×)</span>` : '');
    }

    // Category table
    _container.querySelector('#zCategoryTable tbody').innerHTML = data.categoryBreakdown.map(c =>
      `<tr><td class="td-name">${c.category}</td><td class="num highlight-cell">${fmtEur(c.total)}</td><td class="num">${c.count}x</td></tr>`
    ).join('');

    // Top items table
    _container.querySelector('#zTopItemsTable tbody').innerHTML = data.topItems.map((item, i) => {
      const rankStyle = i === 0 ? 'color:var(--color-accent);font-weight:700' : (i < 3 ? 'color:var(--color-text-sec);font-weight:700' : '');
      return `<tr><td class="num" style="${rankStyle}">${i + 1}</td><td class="td-name">${escapeHtml(item.emoji || '')} ${escapeHtml(item.name)}</td><td class="num">${item.qty}x</td><td class="num highlight-cell">${fmtEur(item.revenue)}</td></tr>`;
    }).join('');

  } catch (err) {
    showToast(err.message || 'Chyba generovania Z-reportu', 'error');
  } finally {
    if (btn) btnReset(btn);
  }
}

async function printZReport() {
  return doZReport(false);
}

async function digitalZReport() {
  const date = $('#zReportDate').value;
  if (!date) return;
  // Bez potvrdenia? Digitálna uzávierka nemá fiškálny dopad (Portos paragón
  // výberu sa nevystaví) — ale ide o uzávierku dňa. Spýtaj sa pred odoslaním.
  if (typeof showConfirm === 'function') {
    showConfirm(
      'Digitálna uzávierka',
      'Uzávierka sa zapíše do cashflow BEZ vytlačenia papiera. Portos paragón výberu (fiškálny doklad) sa NEVYTVORÍ. Pre fiškálnu kompletnosť pokladne treba neskôr buď vytlačiť uzávierku, alebo manuálne registrovať výber v Portos.',
      function () { doZReport(true); },
      { type: 'info', confirmText: 'Pokračovať bez papiera' }
    );
  } else {
    doZReport(true);
  }
}

async function doZReport(digital) {
  const date = $('#zReportDate').value;
  if (!date) return;
  const btn = $(digital ? '#btnDigitalZReport' : '#btnPrintZReport');
  if (btn) btnLoading(btn);
  try {
    const res = await api.post('/print/z-report', { date, digital: !!digital });
    // Backend pri tlači uzávierky automaticky:
    //  (1) volá Portos /receipts/withdraw (fiškálny paragón výberu)
    //  (2) vytvorí cashflow_entry pre interný report
    // Tu kombinujeme oba výsledky do jedného toastu, aby operátor v jednom
    // toaste videl či sa Portos paragón fakticky vytlačil.
    var w = res && res.withdrawal;
    var pw = res && res.portosWithdraw;
    var amt = w && w.amount != null ? fmtCost(w.amount) + ' €' : '';
    var prefix = digital ? 'Digitálna uzávierka' : 'Z-report vytlačený';
    if (w && w.reason === 'no_cash') {
      showToast(prefix + '. Žiadna hotovosť na výber.', true);
    } else if (digital && w && (w.created || w.alreadyExists)) {
      // Digital mode — Portos paragón sa neprerváša
      showToast(prefix + '. Cashflow výber ' + amt + '. Portos paragón výberu NEvytvorený (bez papiera).', true);
    } else if (pw && pw.ok) {
      // Najlepší scenár: Portos paragón aj cashflow OK
      showToast(prefix + '. Portos výber ' + amt + (pw.receiptId ? ' (' + pw.receiptId + ')' : '') + ' OK.', true);
    } else if (pw && !pw.ok && pw.skipped) {
      // Portos vypnutý — len cashflow zapísané
      showToast(prefix + '. Cashflow výber ' + amt + ' (Portos je vypnutý).', true);
    } else if (pw && !pw.ok) {
      // Portos zlyhal — cashflow OK, ale paragón treba ručne
      showToast(prefix + ' + cashflow ' + amt + '. ⚠ Portos paragón výberu zlyhal: ' + (pw.error || 'unknown') + ' — vytlač ručne.', 'warning');
    } else if (w && w.alreadyExists) {
      showToast(prefix + '. Výber už evidovaný (' + amt + ').', true);
    } else if (w && w.created) {
      showToast(prefix + '. Cashflow výber ' + amt + '.', true);
    } else {
      showToast(digital ? 'Digitálna uzávierka zaznamenaná.' : 'Z-report odoslaný na tlačiareň', true);
    }
  } catch (err) {
    showToast('Chyba tlace: ' + err.message, 'error');
  } finally {
    if (btn) btnReset(btn);
  }
}

// ===== EXPORT =====
function exportCSV() {
  const activeTab = _container.querySelector('.tab-content.active');
  const table = activeTab.querySelector('.data-table');
  if (!table) return;
  const rows = [];
  // Header
  const headerCells = [];
  table.querySelectorAll('thead th').forEach(th => {
    headerCells.push('"' + th.textContent.trim().replace(/"/g, '""') + '"');
  });
  rows.push(headerCells.join(';'));
  // Body
  table.querySelectorAll('tbody tr').forEach(tr => {
    const cells = [];
    tr.querySelectorAll('td').forEach(td => {
      const val = td.textContent.trim().replace(/\s+/g, ' ').replace(/"/g, '""');
      cells.push('"' + val + '"');
    });
    rows.push(cells.join(';'));
  });
  // Footer
  const tfoot = table.querySelector('tfoot');
  if (tfoot) {
    tfoot.querySelectorAll('tr').forEach(tr => {
      const cells = [];
      tr.querySelectorAll('td').forEach(td => {
        const val = td.textContent.trim().replace(/\s+/g, ' ').replace(/"/g, '""');
        cells.push('"' + val + '"');
      });
      rows.push(cells.join(';'));
    });
  }
  const csv = '\uFEFF' + rows.join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const tabName = _container.querySelector('.tab-btn.active').dataset.tab;
  a.href = url;
  a.download = 'pos-report-' + tabName + '.csv';
  a.click();
  URL.revokeObjectURL(url);
}

function exportAPI() {
  const from = $('#dateFrom').value;
  const to = $('#dateTo').value;
  const format = $('#exportFormat').value;
  const token = api.getToken();
  const url = '/api/reports/export?from=' + from + '&to=' + to + '&format=' + format + scopeQuery();
  const btn = $('#btnExportAPI');
  if (btn) btnLoading(btn);

  fetch(url, { headers: { 'Authorization': 'Bearer ' + token } })
    .then(res => {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.blob();
    })
    .then(blob => {
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = 'pos-export-' + from + '-' + to + '.' + format;
      a.click();
      URL.revokeObjectURL(blobUrl);
      showToast('Export stiahnutý', true);
    })
    .catch(err => showToast('Chyba exportu: ' + err.message, 'error'))
    .finally(() => { if (btn) btnReset(btn); });
}

// Aktívny stav prepínača rozsahu. TEMPLATE je statický (default 'active'),
// takže po init() aj po každom prepnutí ho treba zosúladiť s _scope.
function syncScopeButtons() {
  $$('.scope-btn').forEach(b => {
    const on = b.dataset.scope === _scope;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

// ===== BIND EVENTS =====
function bindEvents() {
  // Period buttons
  $$('.period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.period-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const dr = $('#dateRange');
      const ds = $('#dateSingle');
      // Two pickers are mutually exclusive — only one shows at a time
      dr.classList.toggle('visible', btn.dataset.period === 'custom');
      ds.classList.toggle('visible', btn.dataset.period === 'single');

      const dateFrom = $('#dateFrom');
      const dateTo = $('#dateTo');
      const dateSingle = $('#dateSingleInput');

      // Chip s obdobím zvolený → vlastný rozsah z „Iné…" už neplatí.
      _customPeriod = false;
      $$('.period-btn').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
      syncMoreChip();

      if (btn.dataset.period === 'today') {
        dateTo.value = todayStr();
        dateFrom.value = dateTo.value;
      } else if (btn.dataset.period === 'yesterday') {
        dateTo.value = isoAddDays(todayStr(), -1);
        dateFrom.value = dateTo.value;
      } else if (btn.dataset.period === 'single') {
        // Default the picker to today on first reveal so the user can just
        // change it; if they previously picked a day, keep that selection.
        if (!dateSingle.value) dateSingle.value = todayStr();
        dateFrom.value = dateSingle.value;
        dateTo.value = dateSingle.value;
      } else if (btn.dataset.period === 'week') {
        dateTo.value = todayStr();
        dateFrom.value = weekAgoStr();
      } else if (btn.dataset.period === 'month') {
        dateTo.value = todayStr();
        dateFrom.value = monthStartStr();
      }
      if (btn.dataset.period !== 'custom') loadReports();
    });
  });

  // „Iné…" rozbalí dátumy a export. Čisto stav UI — filter sa aplikuje až
  // zmenou poľa (handlery nižšie), žiadne tlačidlo „Obnoviť".
  const moreBtn = $('#rpMore');
  const moreBox = $('#rpMoreBox');
  if (moreBtn && moreBox) {
    moreBtn.addEventListener('click', () => {
      moreBox.hidden = !moreBox.hidden;
      moreBtn.setAttribute('aria-expanded', String(!moreBox.hidden));
      syncMoreChip();
    });
  }

  // Rozsah dát — prepnutie znamená nový request (filter je na strane servera),
  // nie len re-render cache-u ako pri dest chipoch.
  $$('.scope-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const next = normalizeScope(btn.dataset.scope);
      if (next === _scope) return;
      _scope = writeScope(next);
      syncScopeButtons();
      loadReports();
      if (_container.querySelector('.tab-btn[data-tab="cisnicky"]').classList.contains('active')) {
        loadStaffReport();
      }
    });
  });

  // Single-day picker — sets both from and to to the chosen date so every
  // tab (Trzby, Produkty, Zamestnanci, Hodiny, Bar/Kuchyňa split) reflects
  // exactly that one calendar day.
  $('#dateSingleInput').addEventListener('change', (e) => {
    const v = e.target.value;
    if (!v) return;
    $('#dateFrom').value = v;
    $('#dateTo').value = v;
    markCustomPeriod();
    loadReports();
    if (_container.querySelector('.tab-btn[data-tab="cisnicky"]').classList.contains('active')) {
      loadStaffReport();
    }
  });

  // Custom date change
  $('#dateFrom').addEventListener('change', () => {
    markCustomPeriod();
    loadReports();
    if (_container.querySelector('.tab-btn[data-tab="cisnicky"]').classList.contains('active')) {
      loadStaffReport();
    }
  });
  $('#dateTo').addEventListener('change', () => {
    markCustomPeriod();
    loadReports();
    if (_container.querySelector('.tab-btn[data-tab="cisnicky"]').classList.contains('active')) {
      loadStaffReport();
    }
  });

  // Tab switching
  $$('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.tab-btn').forEach(b => b.classList.remove('active'));
      $$('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      _container.querySelector('#tab-' + btn.dataset.tab).classList.add('active');
      if (btn.dataset.tab === 'cisnicky') loadStaffReport();
    });
  });

  // CSV Export
  $('#btnExport').addEventListener('click', exportCSV);

  // Export to accounting
  $('#btnExportAPI').addEventListener('click', exportAPI);

  // Z-report
  $('#btnGenZReport').addEventListener('click', generateZReport);
  $('#btnPrintZReport').addEventListener('click', printZReport);
  var digBtn = $('#btnDigitalZReport');
  if (digBtn) digBtn.addEventListener('click', digitalZReport);

  // Produkty tab — clickable column headers re-sort the cached dataset.
  // Single delegated listener on the table beats binding per-th and
  // survives if we ever re-render the thead.
  const produktyTable = $('#table-produkty');
  if (produktyTable) produktyTable.addEventListener('click', onProductHeaderClick);

  // Dest filter chips — toggle medzi all/kuchyna/bar. Re-render produkty
  // tabuľky + per-day pivotu. Bez API requestu, pracujeme s cache-om.
  const chipMap = {
    'chipDestAll': 'all',
    'chipDestKuch': 'kuchyna',
    'chipDestBar': 'bar',
  };
  Object.keys(chipMap).forEach(id => {
    const el = $('#' + id);
    if (!el) return;
    el.addEventListener('click', () => {
      _productDestFilter = chipMap[id];
      if (_lastProductsData) renderProdukty(_lastProductsData);
    });
  });

  // Per-day pivot prepínače — metrika (ks/tržba) + zoskupenie (položka/kategória).
  // Prepínajú lokálne nad cache-om (_lastProductsData), bez API requestu.
  const pbdMap = {
    pbdMetricQty: () => { _productByDayMetric = 'qty'; },
    pbdMetricRev: () => { _productByDayMetric = 'revenue'; },
    pbdGroupItem: () => { _productByDayGroup = 'item'; },
    pbdGroupCat: () => { _productByDayGroup = 'category'; },
  };
  Object.keys(pbdMap).forEach(id => {
    const el = $('#' + id);
    if (!el) return;
    el.addEventListener('click', () => {
      pbdMap[id]();
      if (_lastProductsData) renderProductsByDay(_lastProductsData);
    });
  });
}

// ===== TEMPLATE =====
const TEMPLATE = `
  <!-- OBDOBIE: chipy + „Iné…" (dátumy, export). JS: .period-btn[data-period]
       nastaví #dateFrom/#dateTo a načíta; .active = zvolené obdobie. -->
  <div class="doch-head rp-head">
    <div class="doch-chips rp-chips" role="group" aria-label="Obdobie">
      <button type="button" class="doch-chip period-btn" data-period="today" aria-pressed="false">Dnes</button>
      <button type="button" class="doch-chip period-btn" data-period="yesterday" aria-pressed="false">Včera</button>
      <button type="button" class="doch-chip period-btn active" data-period="week" aria-pressed="true">Tento týždeň</button>
      <button type="button" class="doch-chip period-btn" data-period="month" aria-pressed="false">Tento mesiac</button>
      <button type="button" class="doch-chip" id="rpMore" aria-expanded="false" aria-controls="rpMoreBox">Iné…</button>
    </div>
    <div class="doch-more" id="rpMoreBox" hidden>
      <div class="date-single" id="dateSingle">
        <label class="doch-toolbar-label">Jeden deň
          <input type="date" class="date-input" id="dateSingleInput">
        </label>
      </div>
      <div class="date-range" id="dateRange">
        <label class="doch-toolbar-label">Od
          <input type="date" class="date-input" id="dateFrom">
        </label>
        <span class="date-sep">\u2014</span>
        <label class="doch-toolbar-label">Do
          <input type="date" class="date-input" id="dateTo">
        </label>
      </div>
      <div class="rp-more-row">
        <label class="doch-toolbar-label">Formát exportu
          <select id="exportFormat" class="filter-select">
            <option value="csv">CSV</option>
            <option value="json">JSON</option>
          </select>
        </label>
        <button type="button" class="btn-secondary" id="btnExportAPI">Export do účtovníctva</button>
        <button type="button" class="btn-secondary" id="btnExport">Exportovať CSV</button>
      </div>
    </div>
    <!-- Rozsah dát — 'active' (len aktuálna kasa) vs 'all' (celá história
         vrátane predošlých daňových subjektov). Aktívny stav nastavuje init(). -->
    <div class="scope-switch rp-seg" role="group" aria-label="Rozsah dát">
      <button type="button" class="scope-btn active" data-scope="active" aria-pressed="true">Táto kasa</button>
      <button type="button" class="scope-btn" data-scope="all" aria-pressed="false">Celá história</button>
    </div>
    <div class="doch-range" id="rpRange"></div>
  </div>

  <!-- Vysvetľujúci pás — zobrazí sa len pri rozsahu 'all' (renderScopeNotice) -->
  <div class="doch-owe rp-note" id="scopeNotice" role="note" style="display:none"></div>

  <!-- KPI: jedno veľké číslo (tržby) + jeden riadok súčtu. renderStats()
       plní hodnoty podľa poradia .rp-kpi-v v dokumente (0 = tržby … 9 = odpisy
       predaj), preto poradie prvkov nemeň. -->
  <div class="rp-hero">
    <div class="rp-hero-k">Tržby za obdobie</div>
    <div class="rp-hero-v rp-kpi-v">-- &euro;</div>
    <!-- Rozpad DPH sa zobrazí len platiteľovi (server pošle totalRevenueNet). -->
    <div class="stat-change neutral" id="statVatNote" style="display:none"></div>
    <!-- Rozsah 'active': obdobie začína prvým dokladom aktuálnej kasy. -->
    <div class="stat-change neutral" id="statScopeNote" style="display:none"></div>
  </div>
  <div class="doch-sum rp-sum">
    <span class="rp-sum-i"><strong class="rp-kpi-v">--</strong> objednávok</span>
    <span class="rp-sum-i"><strong class="rp-kpi-v">-- &euro;</strong> priemerný účet</span>
    <span class="rp-sum-i"><strong class="rp-kpi-v">-- &euro;</strong> na zamestnanca</span>
    <!-- Náklady na výrobu — recept × predaj; položky bez receptu = 0 €. -->
    <span class="rp-sum-i"><strong class="rp-kpi-v">-- &euro;</strong> výroba</span>
    <!-- Mzdy — clock_in→clock_out × hourly_rate. -->
    <span class="rp-sum-i"><strong class="rp-kpi-v">-- &euro;</strong> mzdy</span>
    <!-- Zamestnanecká spotreba — náklad na suroviny pre staff meals. -->
    <span class="rp-sum-i"><strong class="rp-kpi-v">-- &euro;</strong> zam. spotreba</span>
    <!-- Výsledok = Tržby − Výroba − Mzdy − Zam. spotreba; farbu dáva renderStats(). -->
    <span class="rp-sum-i"><strong class="rp-kpi-v">-- &euro;</strong> výsledok <small id="statProfitMargin" style="display:none"></small></span>
    <span class="rp-sum-i"><strong class="rp-kpi-v">--</strong> burgerov</span>
    <!-- Odpisy (predaj) — MUSÍ ostať posledný: renderStats() ho plní cez index 9. -->
    <span class="rp-sum-i"><strong class="rp-kpi-v">-- &euro;</strong> odpisy</span>
  </div>

  <!-- TABS -->
  <div class="tabs rp-tabs" role="tablist" aria-label="Časti reportu">
    <button class="tab-btn active" data-tab="trzby">Tržby</button>
    <button class="tab-btn" data-tab="produkty">Produkty</button>
    <button class="tab-btn" data-tab="zamestnanci">Zamestnanci</button>
    <button class="tab-btn" data-tab="cisnicky">Čašníci</button>
    <button class="tab-btn" data-tab="hodiny">Hodiny</button>
    <button class="tab-btn" data-tab="uzavierka">Uzávierka</button>
  </div>

  <!-- TAB: TRZBY -->
  <div class="tab-content active" id="tab-trzby">
    <div id="destSplit"></div>

    <!-- Tržby podľa spôsobu platby — rešpektuje from/to filter (predtým len dashboard/dnes) -->
    <div class="panel rp-panel">
      <div class="panel-title">Tržby podľa spôsobu platby</div>
      <div class="table-scroll-wrap">
        <table class="data-table rp-cards rp-t-pay" id="table-payments">
          <thead>
            <tr>
              <th>Spôsob platby</th>
              <th class="text-right">Počet</th>
              <th class="text-right">Tržby</th>
              <th>Podiel</th>
            </tr>
          </thead>
          <tbody><tr><td colspan="4" class="td-empty">Načítavam…</td></tr></tbody>
          <tfoot></tfoot>
        </table>
      </div>
    </div>

    <div class="panel rp-panel">
      <div class="table-scroll-wrap">
      <table class="data-table rp-cards rp-t-trzby" id="table-trzby">
        <thead>
          <tr>
            <th>Dátum</th>
            <th class="text-right">Obj.</th>
            <th class="text-right">Tržby</th>
            <th class="text-right">Odpis</th>
            <th class="text-right">Výroba</th>
            <th class="text-right">Mzdy</th>
            <th class="text-right">Výsledok</th>
            <th class="text-right">Priem. účet</th>
          </tr>
        </thead>
        <tbody>
          <tr><td colspan="8" class="td-empty">Načítavam…</td></tr>
        </tbody>
        <tfoot></tfoot>
      </table>
      </div>
    </div>

    <!-- Mzdy podla zamestnancov — viditelny len ked > 0. Renderuje sa
         cez renderLaborByStaff() z dat.laborByStaff. -->
    <div class="panel rp-panel" id="laborByStaffPanel" style="display:none">
      <div class="panel-title">Mzdy podľa zamestnancov</div>
      <div class="rp-sub">
        odpracované hodiny × hodinová sadzba — len uzavreté zmeny (clock_in → clock_out) v tomto období
      </div>
      <div class="table-scroll-wrap">
        <table class="data-table rp-cards rp-t-labor" id="table-labor-staff">
          <thead>
            <tr>
              <th>Meno</th>
              <th>Pozícia</th>
              <th class="text-right">Smeny</th>
              <th class="text-right">Hodiny</th>
              <th class="text-right">Sadzba</th>
              <th class="text-right">Mzda</th>
            </tr>
          </thead>
          <tbody></tbody>
          <tfoot></tfoot>
        </table>
      </div>
    </div>

    <!-- Zamestnanecka spotreba podla mena — viditelny len ked total > 0.
         Renderuje sa cez renderStaffMealByPerson() z dat.staffMealByPerson.
         Naklad rozdeleny na jedlo (kuchyna) vs napoje (bar) cez category.dest. -->
    <div class="panel rp-panel" id="staffMealPanel" style="display:none">
      <div class="panel-title">Zamestnanecká spotreba podľa mena</div>
      <div class="rp-sub">
        podľa mena stola v zóne Zamestnanci — náklad firmy na jedlo a nápoje zamestnanca
      </div>
      <div class="table-scroll-wrap">
        <table class="data-table rp-cards rp-t-meal" id="table-staff-meal">
          <thead>
            <tr>
              <th>Meno</th>
              <th class="text-right">Počet</th>
              <th class="text-right">Jedlo (kuchyňa)</th>
              <th class="text-right">Nápoje (bar)</th>
              <th class="text-right">Náklad spolu</th>
              <th class="text-right" title="Hodnota benefitu — koľko by zákazník zaplatil za rovnaké položky">Cena na predaj</th>
            </tr>
          </thead>
          <tbody></tbody>
          <tfoot></tfoot>
        </table>
      </div>
    </div>
  </div>

  <!-- TAB: PRODUKTY -->
  <div class="tab-content" id="tab-produkty">
    <!-- Dest filter chips — triedi tabulku produktov na vsetko/kuchyna/bar.
         Pomaha managerovi rychlo videt "len kuchyna" alebo "len bar" bez
         scrollovania zmiesanym zoznamom. Style: vlozenne inline aby sa zladil
         s ostatnymi pages bez extra CSS edit-u. -->
    <div class="doch-head rp-head">
      <div class="doch-chips rp-chips" role="group" aria-label="Zóna">
        <button type="button" id="chipDestAll" class="doch-chip filter-chip chip-active">Všetko <span class="chip-count">(0)</span></button>
        <button type="button" id="chipDestKuch" class="doch-chip filter-chip">Kuchyňa <span class="chip-count">(0)</span></button>
        <button type="button" id="chipDestBar" class="doch-chip filter-chip">Bar <span class="chip-count">(0)</span></button>
      </div>
      <div id="productFilterStats" class="doch-range"></div>
    </div>

    <div class="panel rp-panel">
      <div class="table-scroll-wrap">
      <table class="data-table sortable-table rp-cards rp-t-prod" id="table-produkty">
        <thead>
          <tr>
            <th>Poradie</th>
            <th class="sortable-th" data-sort-col="name">Produkt <span class="sort-arrow"></span></th>
            <th class="sortable-th" data-sort-col="category">Kategória <span class="sort-arrow"></span></th>
            <th class="sortable-th sort-active" data-sort-col="qty">Predaných ks <span class="sort-arrow">▼</span></th>
            <th class="sortable-th" data-sort-col="revenue">Tržby <span class="sort-arrow"></span></th>
            <th class="sortable-th" data-sort-col="cogs">Výroba <span class="sort-arrow"></span></th>
            <th class="sortable-th" data-sort-col="profit">Výsledok <span class="sort-arrow"></span></th>
            <th class="sortable-th" data-sort-col="pct">% z celku <span class="sort-arrow"></span></th>
          </tr>
        </thead>
        <tbody>
          <tr><td colspan="8" class="td-empty">Načítavam…</td></tr>
        </tbody>
      </table>
      </div>
    </div>

    <!-- Per-day pivot — burgers per day per day matrix. Filter (kuchyna/bar)
         zdielany s tabulkou nad. Top-N items, heat-map farby pre rychlu
         identifikaciu peak dni. -->
    <!-- Per-day pivot — matica položky/kategórie × dni. Filter (kuchyňa/bar)
         zdieľaný s tabuľkou nad. Top-N riadkov, heat-map pre rýchlu
         identifikáciu silných dní. -->
    <div class="panel rp-panel">
      <div class="panel-title">Predaj za deň</div>
      <div class="rp-sub" id="pbdSubtitle">počet kusov podľa položky každý deň</div>
      <!-- Prepínače pivotu: metrika (kusy / tržba €) + zoskupenie (položka /
           kategória). JS prepína .chip-active, vzhľad segmentu je v ios-reporty.css. -->
      <div class="rp-seg-wrap" style="margin-bottom:12px">
        <div class="rp-seg rp-seg-sm" role="group" aria-label="Zobraziť">
          <button type="button" id="pbdMetricQty" class="filter-chip chip-active">Kusy</button>
          <button type="button" id="pbdMetricRev" class="filter-chip">Tržba €</button>
        </div>
        <div class="rp-seg rp-seg-sm" role="group" aria-label="Zoskupenie">
          <button type="button" id="pbdGroupItem" class="filter-chip chip-active">Položka</button>
          <button type="button" id="pbdGroupCat" class="filter-chip">Kategória</button>
        </div>
      </div>
      <div id="productsByDayHost"></div>
    </div>
  </div>

  <!-- TAB: ZAMESTNANCI -->
  <div class="tab-content" id="tab-zamestnanci">
    <div class="panel rp-panel">
      <div class="table-scroll-wrap">
      <table class="data-table rp-cards rp-t-zam" id="table-zamestnanci">
        <thead>
          <tr>
            <th>Meno</th>
            <th class="text-right">Zmeny</th>
            <th class="text-right">Objednávky</th>
            <th class="text-right">Tržby</th>
            <th class="text-right">Priem. účet</th>
            <th class="text-right">Hodnotenie</th>
          </tr>
        </thead>
        <tbody>
          <tr><td colspan="6" class="td-empty">Načítavam…</td></tr>
        </tbody>
      </table>
      </div>
    </div>
  </div>

  <!-- TAB: CISNICKY -->
  <div class="tab-content" id="tab-cisnicky">
    <div class="panel rp-panel">
      <div class="panel-title">Výkon čašníkov</div>
      <div id="staffBars" class="staff-bars-container rp-staffbars"></div>
    </div>
    <div class="panel rp-panel">
      <div class="table-scroll-wrap">
      <table class="data-table rp-cards rp-t-cis" id="table-cisnicky">
        <thead>
          <tr>
            <th>Meno</th>
            <th>Rola</th>
            <th class="text-right">Objednávky</th>
            <th class="text-right">Položky</th>
            <th class="text-right">Tržby</th>
            <th class="text-right">Priem. účet</th>
            <th class="text-right">Hotovosť</th>
            <th class="text-right">Karta</th>
            <th class="text-right">Storná</th>
          </tr>
        </thead>
        <tbody id="staffTableBody">
          <tr><td colspan="9" class="td-empty">Načítavam…</td></tr>
        </tbody>
      </table>
      </div>
    </div>
  </div>

  <!-- TAB: HODINY -->
  <div class="tab-content" id="tab-hodiny">
    <div class="panel rp-panel">
      <div class="table-scroll-wrap">
      <table class="data-table rp-cards rp-t-hod" id="table-hodiny">
        <thead>
          <tr>
            <th>Hodina</th>
            <th class="text-right">Obj.</th>
            <th class="text-right">Bar</th>
            <th class="text-right">Kuchyňa</th>
            <th class="text-right">Spolu</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr><td colspan="6" class="td-empty">Načítavam…</td></tr>
        </tbody>
        <tfoot></tfoot>
      </table>
      </div>
    </div>
  </div>

  <!-- TAB: UZAVIERKA -->
  <div class="tab-content" id="tab-uzavierka">
    <div class="doch-head rp-head">
      <div class="rp-actions">
        <label class="doch-toolbar-label">Deň uzávierky
          <input type="date" class="date-input" id="zReportDate">
        </label>
        <button type="button" class="btn-add" id="btnGenZReport">Zobraziť uzávierku</button>
      </div>
      <div class="rp-actions-2">
        <button type="button" class="btn-secondary" id="btnPrintZReport">Tlačiť Z-report</button>
        <button type="button" class="btn-secondary" id="btnDigitalZReport" title="Bez tlače papiera. Cashflow zápis prebehne, Portos paragón výberu sa nevytvorí.">Digitálna uzávierka</button>
      </div>
    </div>

    <!-- Uzávierka zámerne NEreaguje na prepínač rozsahu: je to fiškálny
         doklad aktuálnej pokladne a tlačová cesta (POST /print/z-report)
         rozsah neprijíma. Keby preview bežal v 'all', papier a obrazovka
         by si protirečili. -->
    <div class="doch-owe rp-note is-info" id="zScopeNote" role="note" style="display:none">
      <span>Uzávierka sa vždy počíta len za aktuálnu kasu, aj keď je zapnutý
      rozsah „Celá história“. Je to fiškálny doklad jedného daňového subjektu,
      preto sa čísla tu môžu líšiť od ostatných záložiek.</span>
    </div>

    <div id="zReportContent" style="display:none">
      <div class="rp-hero">
        <div class="rp-hero-k">Tržby dňa</div>
        <div class="rp-hero-v" id="zTotalRevenue">--</div>
      </div>
      <div class="doch-sum rp-sum">
        <span class="rp-sum-i"><strong id="zOrdersItems">--</strong> objednávok / položiek</span>
        <span class="rp-sum-i"><strong id="zAvgOrder">--</strong> priemerná objednávka</span>
        <!-- Odpisy (predaj) — manažérsky odpis "na účet podniku" (mimo fiškál). -->
        <span class="rp-sum-i"><strong id="zOdpis">--</strong> odpisy (predaj)</span>
      </div>

      <div class="grid-2col rp-2col">
        <div class="panel rp-panel">
          <div class="panel-title">Platobné metódy</div>
          <div id="zPaymentMethods"></div>
        </div>
        <div class="panel rp-panel">
          <div class="panel-title">Storná</div>
          <div id="zCancelled" class="loading-placeholder">--</div>
        </div>
      </div>

      <div class="panel rp-panel">
        <div class="panel-title">Kategórie</div>
        <div class="table-scroll-wrap">
        <table class="data-table rp-cards rp-t-zcat" id="zCategoryTable">
          <thead>
            <tr>
              <th>Kategória</th>
              <th class="text-right">Tržby</th>
              <th class="text-right">Počet</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
        </div>
      </div>

      <div class="panel rp-panel">
        <div class="panel-title">Top 10 položiek</div>
        <div class="table-scroll-wrap">
        <table class="data-table rp-cards rp-t-ztop" id="zTopItemsTable">
          <thead>
            <tr>
              <th class="text-right">#</th>
              <th>Položka</th>
              <th class="text-right">Počet</th>
              <th class="text-right">Tržby</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
        </div>
      </div>
    </div>
  </div>
`;

export function init(container) {
  _container = container;
  container.innerHTML = TEMPLATE;

  // Vzhľad chipov, prepínača rozsahu a vysvetľujúceho pásu je v
  // admin/ios-reporty.css (predtým injektované <style> s !important).

  // Set default dates
  // Set default dates
  $('#dateFrom').value = weekAgoStr();
  $('#dateTo').value = todayStr();
  $('#zReportDate').value = todayStr();
  renderRangeLine($('#dateFrom').value, $('#dateTo').value);

  // Obnov zapamätanú voľbu rozsahu (TEMPLATE má natvrdo 'active').
  _scope = readScope();
  syncScopeButtons();

  bindEvents();
  loadReports();
}

export function destroy() {
  _container = null;
  _lastZData = null;
  _lastProductsData = null;
  _customPeriod = false;
  _productSort = { col: 'qty', dir: 'desc' };
  _productDestFilter = 'all';
  _productByDayMetric = 'qty';
  _productByDayGroup = 'item';
}
