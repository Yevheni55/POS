// Shisha — interný counter mimo fiškálneho obehu.
// Tlačidlo +1 pri každom predaji shishy. Štatistiky podľa dní pre účtovníctvo.

import { fmtCost } from '../../components/fmt.js';

// Escapovanie: jediná implementácia je /js/pos-escape.js (načítaná v
// admin/index.html). Táto stránka predtým NEescapovala vôbec nič — názov
// kategórie / produktu / stola / suroviny / zamestnanca ide z DB rovno do
// innerHTML, takže čokoľvek, čo si manažér uloží ako názov, sa v admine
// vykoná ako HTML (CSP má 'unsafe-inline', takže aj ako skript).
function escapeHtml(v) {
  if (typeof window !== 'undefined' && typeof window.escHtml === 'function') return window.escHtml(v);
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}


let _container = null;
let _refreshing = false;

function fmtMoney(n) {
  return fmtCost(n) + ' €';
}

function fmtDate(iso) {
  if (!iso) return '';
  // iso = YYYY-MM-DD
  var parts = String(iso).split('-');
  if (parts.length !== 3) return iso;
  var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  var weekday = ['Ne', 'Po', 'Ut', 'St', 'Št', 'Pi', 'So'][d.getDay()];
  return weekday + ' ' + parts[2] + '.' + parts[1] + '.';
}

function fmtTime(iso) {
  if (!iso) return '';
  try {
    var d = new Date(iso);
    return d.toLocaleString('sk-SK', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
  } catch (e) { return ''; }
}

async function loadAndRender() {
  if (!_container) return;
  try {
    var data = await api.get('/shisha/summary');
    render(data);
  } catch (err) {
    _container.querySelector('#shishaStatus').textContent = 'Chyba načítania: ' + (err && err.message);
  }
}

function render(data) {
  var s = data.summary || { today: { count: 0, revenue: 0 }, month: { count: 0, revenue: 0 }, total: { count: 0, revenue: 0 } };
  var byDay = data.byDay || [];
  var recent = data.recent || [];

  _container.querySelector('#shishaTodayCount').textContent = s.today.count;
  _container.querySelector('#shishaTodayRevenue').textContent = fmtMoney(s.today.revenue);
  _container.querySelector('#shishaMonthCount').textContent = s.month.count;
  _container.querySelector('#shishaMonthRevenue').textContent = fmtMoney(s.month.revenue);
  _container.querySelector('#shishaTotalCount').textContent = s.total.count;
  _container.querySelector('#shishaTotalRevenue').textContent = fmtMoney(s.total.revenue);

  // Per-day table
  var html = '';
  if (!byDay.length) {
    html = '<tr><td colspan="3" class="td-empty">Žiadne predaje za posledných 60 dní.</td></tr>';
  } else {
    html = byDay.map(function (d) {
      return (
        '<tr>' +
        '<td class="td-name">' + fmtDate(d.day) + '</td>' +
        '<td class="num">' + d.count + ' ks</td>' +
        '<td class="num">' + fmtMoney(d.revenue) + '</td>' +
        '</tr>'
      );
    }).join('');
  }
  _container.querySelector('#shishaByDay tbody').innerHTML = html;

  // Recent sales (with delete for managers)
  var user = (typeof api !== 'undefined' && api.getUser) ? api.getUser() : null;
  var canDelete = user && (user.role === 'manazer' || user.role === 'admin');
  var rhtml = '';
  if (!recent.length) {
    rhtml = '<tr><td colspan="' + (canDelete ? 4 : 3) + '" class="td-empty">Zatiaľ žiadny záznam — prvý pridáte tlačidlom hore.</td></tr>';
  } else {
    rhtml = recent.map(function (r) {
      var cells =
        '<td class="num" style="text-align:left">' + fmtTime(r.soldAt) + '</td>' +
        '<td>' + escapeHtml(r.staffName || '—') + '</td>' +
        '<td class="num">' + fmtMoney(r.price) + '</td>';
      if (canDelete) {
        cells += '<td class="num"><button type="button" class="sk-shisha-del shisha-delete" data-id="' + r.id + '" title="Zmazať záznam" aria-label="Zmazať záznam">×</button></td>';
      }
      return '<tr>' + cells + '</tr>';
    }).join('');
  }
  _container.querySelector('#shishaRecent tbody').innerHTML = rhtml;
}

async function recordSale() {
  if (_refreshing) return;
  _refreshing = true;
  var btn = _container.querySelector('#shishaAddBtn');
  btn.disabled = true;
  var origLabel = btn.innerHTML;
  btn.innerHTML = '…';
  try {
    await api.post('/shisha', {});
    if (typeof showToast === 'function') showToast('+1 shisha zaznamenaná', true);
    await loadAndRender();
  } catch (err) {
    if (typeof showToast === 'function') showToast('Chyba: ' + (err && err.message), 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = origLabel;
    _refreshing = false;
  }
}

async function deleteSale(id) {
  if (!confirm('Naozaj zmazať tento záznam?')) return;
  try {
    await api.del('/shisha/' + id);
    if (typeof showToast === 'function') showToast('Záznam zmazaný', true);
    await loadAndRender();
  } catch (err) {
    if (typeof showToast === 'function') showToast('Chyba: ' + (err && err.message), 'error');
  }
}

export function init(container) {
  _container = container;
  container.className = 'content';
  // Jedna hlavná akcia (+1), dnešok ako hlavná odpoveď, mesiac a celkovo
  // jedným riadkom súčtu. Predtým tri rovnocenné karty s 32 px číslami.
  container.innerHTML = `
    <div class="sk-shisha-wrap">
      <div>
        <button id="shishaAddBtn" class="btn-add sk-shisha-btn" type="button">
          <span class="sk-plus" aria-hidden="true">+1</span>
          <span>Predaná shisha · 17 €</span>
        </button>
        <div id="shishaStatus" class="sk-status" aria-live="polite"></div>
      </div>

      <div class="sk-hero">
        <div class="sk-hero-k">Dnes</div>
        <div class="sk-hero-v"><span id="shishaTodayCount">0</span> <small>ks</small></div>
        <div class="sk-hero-sub" id="shishaTodayRevenue">0,00 €</div>
      </div>

      <div class="sk-sum">
        <span>Tento mesiac <strong><span id="shishaMonthCount">0</span> ks</strong> · <strong id="shishaMonthRevenue">0,00 €</strong></span>
        <span>Celkovo <strong><span id="shishaTotalCount">0</span> ks</strong> · <strong id="shishaTotalRevenue">0,00 €</strong></span>
      </div>

      <div>
        <div class="sk-list-title">Predaje po dňoch (60 dní)</div>
        <div class="sk-list">
          <div class="sk-scroll sk-table-wrap">
            <table id="shishaByDay" class="sk-table sh-table">
              <thead class="is-sticky">
                <tr>
                  <th>Dátum</th>
                  <th class="num">Počet</th>
                  <th class="num">Tržba</th>
                </tr>
              </thead>
              <tbody></tbody>
            </table>
          </div>
        </div>
      </div>

      <div>
        <div class="sk-list-title">Posledných 20 záznamov</div>
        <div class="sk-list">
          <div class="sk-table-wrap">
            <table id="shishaRecent" class="sk-table sh-table">
              <thead>
                <tr>
                  <th>Čas</th>
                  <th>Predal</th>
                  <th class="num">Cena</th>
                </tr>
              </thead>
              <tbody></tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  `;

  container.querySelector('#shishaAddBtn').addEventListener('click', recordSale);
  container.querySelector('#shishaRecent').addEventListener('click', function (e) {
    var btn = e.target.closest('.shisha-delete');
    if (btn) deleteSale(btn.dataset.id);
  });

  loadAndRender();
}

export function destroy() {
  _container = null;
}
