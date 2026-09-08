// admin/pages/forecasts.js — Predpoveď tržieb (JEDNA cifra na deň).
// Číta GET /api/reports/forecasts, ale zobrazuje LEN hlavný model v4-loglin:
// hero „Dnes" + najbližšie dni + krátka história. Ostatné modely (v1/v2/v3,
// *-am varianty) sa ďalej LOGUJÚ na pozadí pre vyhodnocovanie — len sa tu
// neukazujú (požiadavka: jedna cifra, žiadne porovnávanie modelov).
// Presnosť sa ráta z v4-loglin-am (ranný zmrazený odhad = poctivý forward).
// Štýly = zdieľané admin triedy → automaticky správne aj v dark theme.

let _c = null;

const PRIMARY = 'v4-loglin';        // živý odhad (intraday nowcast + budúce dni)
const HONEST = 'v4-loglin-am';      // ranný freeze — z neho je „presnosť"

// Jediná implementácia escapovania v projekte je /js/pos-escape.js
// (escHtml pre textový obsah, escAttr pre atribút, escJsAttr pre inline
// handler). Predtým mala takmer každá admin stránka vlastnú kópiu a boli
// medzi nimi ŠTYRI rôzne správania — časť neescapovala apostrof ani
// úvodzovku, čo je práve to, na čom záleží pri interpolácii do atribútu.
// Lokálne meno ostáva, nech sa neprepisujú stovky volaní.
function esc(v) {
  // window.* zamerne: v moduloch, kde sa lokalna funkcia vola tiez escHtml,
  // by holy identifikator ukazoval sam na seba (nekonecna rekurzia).
  if (typeof window !== 'undefined' && typeof window.escHtml === 'function') return window.escHtml(v);
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function fmtEur(n) {
  return (Number(n) || 0).toLocaleString('sk-SK', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' €';
}
function fmt1(n) {
  return (Number(n) || 0).toLocaleString('sk-SK', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}
function fmtDate(iso) {
  const p = String(iso).split('-');
  return p.length === 3 ? (p[2] + '.' + p[1] + '.') : String(iso);
}
const DOW = ['', 'Pondelok', 'Utorok', 'Streda', 'Štvrtok', 'Piatok', 'Sobota', 'Nedeľa'];
const DOW_S = ['', 'Po', 'Ut', 'St', 'Št', 'Pi', 'So', 'Ne'];

function wx(code) {
  const c = Number(code);
  if (c === 0) return { e: '☀️', l: 'jasno' };
  if (c === 1) return { e: '🌤️', l: 'skoro jasno' };
  if (c === 2) return { e: '⛅', l: 'polooblačno' };
  if (c === 3) return { e: '☁️', l: 'zamračené' };
  if (c === 45 || c === 48) return { e: '🌫️', l: 'hmla' };
  if (c >= 51 && c <= 57) return { e: '🌦️', l: 'mrholenie' };
  if (c >= 61 && c <= 67) return { e: '🌧️', l: 'dážď' };
  if (c >= 71 && c <= 77) return { e: '🌨️', l: 'sneženie' };
  if (c >= 80 && c <= 82) return { e: '🌧️', l: 'prehánky' };
  if (c >= 95) return { e: '⛈️', l: 'búrka' };
  return { e: '·', l: '' };
}
function errColor(p) {
  const a = Math.abs(Number(p) || 0);
  return a < 15 ? 'var(--color-success)' : a < 30 ? 'var(--color-warning)' : 'var(--color-danger)';
}
function todayIso() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Bratislava' }).format(new Date());
}

// Zobrazované rozpätie — max ±100 € okolo odhadu (požiadavka prevádzky:
// tolerancia nanajvýš 200 €). Štatisticky poctivé 80 % pásmo je širšie
// a ostáva v DB pre kalibráciu; tu sa len oreže displej.
const MAX_BAND = 200;
function clampBand(est, low, high) {
  const half = MAX_BAND / 2;
  return {
    low: Math.max(0, Math.max(Number(low) || 0, est - half)),
    high: Math.min(Number(high) || est + half, est + half),
  };
}

export async function init(container) {
  _c = container;
  container.innerHTML = '<div class="loading-hint">Načítavam predpoveď…</div>';
  let data, hourly = null;
  try {
    data = await api.get('/reports/forecasts');
  } catch (e) {
    container.innerHTML = '<div class="error-hint">Predpoveď sa nepodarilo načítať: ' + esc(e && e.message || e) + '</div>';
    return;
  }
  try { hourly = await api.get('/reports/forecasts/hourly-today'); } catch (e) { /* bez hodinovky */ }
  render(data, hourly);
}

function render(data, hourly) {
  const all = (data && data.forecasts) || [];
  const today = todayIso();
  // Jedna cifra na deň = hlavný model; pri duplicite dňa ber posledný riadok.
  const byDate = {};
  all.filter((r) => r.method === PRIMARY).forEach((r) => { byDate[r.date] = r; });
  const days = Object.values(byDate).sort((a, b) => a.date < b.date ? -1 : 1);
  const todayRow = byDate[today] || null;
  const future = days.filter((r) => r.date > today);
  const past = days.filter((r) => r.date < today).slice(-7).reverse();
  // Poctivá presnosť: ranné zmrazené odhady vs realita
  const am = all.filter((r) => r.method === HONEST && r.evaluable);
  const avgAbs = am.length ? Math.round(am.reduce((s, x) => s + Math.abs(x.errorPct), 0) / am.length) : null;
  const inRange = am.length ? am.filter((x) => x.inRange).length : 0;

  let html = '';

  // ── Hero: dnešná tržba (jedna cifra) ──
  html += '<div class="rp-hero">';
  if (todayRow) {
    const w = wx(todayRow.code);
    const band = clampBand(todayRow.estimate, todayRow.low, todayRow.high);
    html += '<div class="rp-hero-k">Dnešná tržba — odhad</div>';
    html += '<div class="rp-hero-v is-accent">' + fmtEur(todayRow.estimate) + '</div>';
    html += '<div class="rp-hero-s">'
          + 'rozpätie ' + fmtEur(band.low) + ' – ' + fmtEur(band.high)
          + ' · ' + w.e + ' ' + esc(w.l)
          + (todayRow.temp != null ? ' ' + Math.round(todayRow.temp) + ' °C' : '')
          + (todayRow.actual != null ? ' · zatiaľ natržené ' + fmtEur(todayRow.actual) : '')
          + '</div>';
  } else {
    html += '<div class="rp-hero-k">Dnešná tržba — odhad</div>'
          + '<div class="rp-hero-s">Dnešný odhad ešte nie je uložený — počká na najbližší hodinový beh.</div>';
  }
  html += '</div>';

  // ── Predpoveď tržieb podľa hodín (dnes) ──
  if (hourly && hourly.hours && hourly.hours.length) {
    const hh = hourly.hours;
    const maxV = Math.max(1, ...hh.map((x) => Math.max(x.actual || 0, x.predicted || 0)));
    html += '<div class="panel rp-panel rp-chart">';
    html += '<div class="panel-title">Dnes podľa hodín</div>';
    html += '<div class="rp-sub">'
          + (hourly.banked ? 'zatiaľ ' + fmtEur(hourly.banked) : '')
          + (hourly.hourlyTotal ? (hourly.banked ? ' · ' : '') + 'hodinový model spolu ~' + fmtEur(hourly.hourlyTotal) : '')
          + '</div>';
    html += '<div class="rp-bars">';
    hh.forEach(function (x) {
      const isAct = x.actual != null;
      const val = isAct ? x.actual : x.predicted;
      const pct = Math.max(2, Math.round(100 * (val || 0) / maxV));
      html += '<div class="rp-bars-row">'
        + '<span class="rp-bars-k">' + String(x.hour).padStart(2, '0') + ':00' + (x.current ? ' ▸' : '') + '</span>'
        + '<div class="rp-bars-track"><span class="' + (isAct ? '' : 'is-est') + '" style="width:' + pct + '%"></span></div>'
        + '<span class="rp-bars-v ' + (isAct ? 'is-act' : 'is-est') + '">' + (isAct ? fmtEur(val) : '~' + fmtEur(val)) + '</span>'
        + '</div>';
    });
    html += '</div>';
    html += '<div class="rp-foot">Plné = skutočnosť · bledé ~ = priemer podobných dní'
          + (hourly.similarDays ? ' (' + hourly.similarDays + ' dní: ' + esc(hourly.similarNote || '') + ')' : '')
          + ' — rovnaký typ dňa (pracovný/piatok/víkend), podobná teplota a mokrý/suchý charakter.</div>';
    html += '</div>';
  }

  // ── Najbližšie dni ──
  if (future.length) {
    html += '<div class="panel rp-panel"><div class="panel-title">Najbližšie dni</div>';
    html += '<div class="table-scroll-wrap"><table class="data-table rp-cards rp-t-fnext"><thead><tr>';
    ['Dátum', 'Deň', 'Počasie', 'Odhad tržby'].forEach(function (h) {
      html += '<th class="data-th">' + h + '</th>';
    });
    html += '</tr></thead><tbody>';
    future.forEach(function (r) {
      const w = wx(r.code);
      html += '<tr class="data-row">';
      html += '<td class="data-td"><strong>' + fmtDate(r.date) + '</strong></td>';
      html += '<td class="data-td">' + (DOW[r.weekday] || '') + '</td>';
      html += '<td class="data-td">' + w.e + ' ' + esc(w.l)
            + (r.temp != null ? ' · ' + Math.round(r.temp) + '°' : '')
            + (r.precip > 0.5 ? ' 💧' : '') + '</td>';
      const b = clampBand(r.estimate, r.low, r.high);
      html += '<td class="data-td"><strong style="font-size:16px">' + fmtEur(r.estimate) + '</strong>'
            + '<br><span class="text-muted" style="font-size:12px">' + fmtEur(b.low) + ' – ' + fmtEur(b.high) + '</span></td>';
      html += '</tr>';
    });
    html += '</tbody></table></div></div>';
  }

  // ── Ako presný som bol (krátko, bez modelov) ──
  html += '<div class="doch-sum rp-sum">'
        + (avgAbs == null
            ? '<span class="rp-sum-i">Presnosť ranných odhadov: zatiaľ málo vyhodnotených dní.</span>'
            : '<span class="rp-sum-i"><strong style="color:' + errColor(avgAbs) + '">' + avgAbs + ' %</strong> priemerná odchýlka ranných odhadov</span>'
              + '<span class="rp-sum-i"><strong>' + inRange + ' / ' + am.length + '</strong> dní realita v rozpätí</span>')
        + '</div>';

  // ── Posledné dni: odhad vs realita ──
  if (past.length) {
    html += '<div class="panel rp-panel"><div class="panel-title">Posledných ' + past.length + ' dní</div>';
    html += '<div class="table-scroll-wrap"><table class="data-table rp-cards rp-t-fpast"><thead><tr>';
    ['Dátum', 'Deň', 'Odhad', 'Realita', 'Odchýlka'].forEach(function (h) {
      html += '<th class="data-th">' + h + '</th>';
    });
    html += '</tr></thead><tbody>';
    past.forEach(function (r) {
      html += '<tr class="data-row">';
      html += '<td class="data-td">' + fmtDate(r.date) + '</td>';
      html += '<td class="data-td">' + (DOW_S[r.weekday] || '') + '</td>';
      html += '<td class="data-td">' + fmtEur(r.estimate) + '</td>';
      html += '<td class="data-td"><strong>' + (r.actual != null ? fmtEur(r.actual) : '—') + '</strong></td>';
      html += '<td class="data-td">' + (r.evaluable
            ? '<span style="font-weight:700;color:' + errColor(r.errorPct) + '">' + (r.errorPct > 0 ? '+' : '') + fmt1(r.errorPct) + ' %</span>'
            : '<span class="text-muted">—</span>') + '</td>';
      html += '</tr>';
    });
    html += '</tbody></table></div></div>';
  }

  _c.innerHTML = html;
}

export function destroy() { _c = null; }
