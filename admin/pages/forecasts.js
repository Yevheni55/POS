// admin/pages/forecasts.js — Moja predpoveď vs realita.
// Číta GET /api/reports/forecasts (uložené odhady + živá skutočná denná tržba)
// a zobrazí súhrn presnosti + tabuľku. Vyhodnocujú sa len uzavreté dni.
// Štýly = zdieľané admin triedy (.stat-grid/.stat-card/.panel/.data-table) →
// automaticky správne aj v dark theme.

let _c = null;

function $(s) { return _c.querySelector(s); }
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function fmtEur(n) {
  return (Number(n) || 0).toLocaleString('sk-SK', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' €';
}
function fmtDate(iso) {
  const p = String(iso).split('-');
  return p.length === 3 ? (p[2] + '.' + p[1] + '.') : String(iso);
}
const DOW = ['', 'Po', 'Ut', 'St', 'Št', 'Pi', 'So', 'Ne'];

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

export async function init(container) {
  _c = container;
  container.innerHTML = '<div class="loading-hint" style="padding:24px">Načítavam predpovede…</div>';
  let data;
  try {
    data = await api.get('/reports/forecasts');
  } catch (e) {
    container.innerHTML = '<div class="empty-hint" style="padding:24px;color:var(--color-danger)">Chyba načítania: ' + esc(e && e.message || e) + '</div>';
    return;
  }
  render(data);
}

function card(label, value, sub) {
  return '<div class="stat-card"><div class="stat-info">'
    + '<div class="stat-label">' + esc(label) + '</div>'
    + '<div class="stat-value">' + value + '</div>'
    + (sub ? '<div class="text-muted" style="font-size:12px">' + esc(sub) + '</div>' : '')
    + '</div></div>';
}

function render(data) {
  const f = (data && data.forecasts) || [];
  const s = (data && data.summary) || {};

  let html = '';
  html += '<p class="text-muted" style="margin:0 0 16px">Moje uložené odhady dennej tržby (model podľa počasia) oproti skutočnosti. '
        + 'Odchýlka a kalibrácia sa rátajú len pre <strong>uzavreté dni</strong>; aktuálny a budúce dni sú „prebieha".</p>';

  html += '<div class="stat-grid" style="margin-bottom:20px">';
  html += card('Vyhodnotené dni', (s.evaluated || 0) + ' / ' + (s.total || 0));
  html += card('Ø absolútna odchýlka', s.avgAbsErrorPct == null ? '—' : (s.avgAbsErrorPct + ' %'));
  html += card('Systematický bias',
    s.biasPct == null ? '—' : '<span style="color:' + errColor(s.biasPct) + '">' + (s.biasPct > 0 ? '+' : '') + s.biasPct + ' %</span>',
    s.biasPct == null ? '' : (s.biasPct > 0 ? 'podceňujem tržby' : 'preceňujem tržby'));
  html += card('Trafené do rozpätia', s.evaluated ? ((s.inRange || 0) + ' / ' + s.evaluated) : '—');
  html += '</div>';

  html += '<div class="panel"><div class="table-scroll-wrap"><table class="data-table"><thead><tr>';
  ['Dátum', 'Deň', 'Počasie', 'Predpoveď', 'Realita', 'Odchýlka', 'Stav'].forEach(function (h) {
    html += '<th class="data-th">' + h + '</th>';
  });
  html += '</tr></thead><tbody>';

  if (!f.length) {
    html += '<tr><td class="data-td" colspan="7"><span class="text-muted">Zatiaľ žiadne uložené predpovede.</span></td></tr>';
  }
  f.forEach(function (r) {
    const w = wx(r.code);
    html += '<tr class="data-row">';
    html += '<td class="data-td"><strong>' + fmtDate(r.date) + '</strong></td>';
    html += '<td class="data-td">' + (DOW[r.weekday] || '') + '</td>';
    html += '<td class="data-td">' + w.e + ' ' + esc(w.l)
          + (r.temp != null ? ' · ' + Math.round(r.temp) + '°' : '')
          + (r.precip > 0 ? ' 💧' : '') + '</td>';
    html += '<td class="data-td"><strong>' + fmtEur(r.estimate) + '</strong>'
          + '<div class="text-muted" style="font-size:12px">' + fmtEur(r.low) + '–' + fmtEur(r.high) + '</div></td>';
    html += '<td class="data-td">' + (r.actual != null
          ? '<strong>' + fmtEur(r.actual) + '</strong>'
          : '<span class="text-muted">—</span>') + '</td>';
    if (r.evaluable) {
      html += '<td class="data-td"><span style="font-weight:700;color:' + errColor(r.errorPct) + '">'
            + (r.errorPct > 0 ? '+' : '') + r.errorPct + ' %</span></td>';
      html += '<td class="data-td">' + (r.inRange
            ? '<span style="color:var(--color-success);font-weight:600">✓ v rozpätí</span>'
            : '<span style="color:var(--color-warning);font-weight:600">mimo</span>') + '</td>';
    } else {
      html += '<td class="data-td text-muted">—</td>';
      html += '<td class="data-td"><span class="text-muted">' + (r.isPast ? 'bez dát' : 'prebieha') + '</span></td>';
    }
    html += '</tr>';
  });

  html += '</tbody></table></div></div>';
  _c.innerHTML = html;
}

export function destroy() { _c = null; }
