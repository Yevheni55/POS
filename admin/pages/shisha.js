// Shisha — interný counter mimo fiškálneho obehu.
// Tlačidlo +1 pri každom predaji shishy. Štatistiky podľa dní pre účtovníctvo.

let _container = null;
let _refreshing = false;

function fmtMoney(n) {
  return Number(n || 0).toFixed(2).replace('.', ',') + ' €';
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
    html = '<tr><td colspan="3" style="text-align:center;color:var(--color-text-muted);padding:24px">Žiadne predaje za posledných 60 dní.</td></tr>';
  } else {
    html = byDay.map(function (d) {
      return (
        '<tr>' +
        '<td>' + fmtDate(d.day) + '</td>' +
        '<td style="text-align:right;font-weight:700">' + d.count + ' ks</td>' +
        '<td style="text-align:right;font-variant-numeric:tabular-nums">' + fmtMoney(d.revenue) + '</td>' +
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
    rhtml = '<tr><td colspan="' + (canDelete ? 4 : 3) + '" style="text-align:center;color:var(--color-text-muted);padding:16px">—</td></tr>';
  } else {
    rhtml = recent.map(function (r) {
      var cells =
        '<td>' + fmtTime(r.soldAt) + '</td>' +
        '<td>' + (r.staffName || '—') + '</td>' +
        '<td style="text-align:right;font-variant-numeric:tabular-nums">' + fmtMoney(r.price) + '</td>';
      if (canDelete) {
        cells += '<td style="text-align:right"><button class="u-btn u-btn-ghost shisha-delete" data-id="' + r.id + '" title="Zmazať" style="padding:4px 10px;min-height:auto;font-size:12px">×</button></td>';
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
  btn.innerHTML = '<span style="opacity:.7">…</span>';
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
  container.innerHTML = `
    <div style="max-width:1100px;margin:0 auto;padding:24px;display:flex;flex-direction:column;gap:24px">

      <!-- Big +1 button -->
      <div style="background:var(--surface-card);border:1px solid var(--color-border);border-radius:var(--radius-lg);padding:32px;text-align:center">
        <div style="font-size:14px;color:var(--color-text-muted);margin-bottom:6px;text-transform:uppercase;letter-spacing:1px">Predaná shisha</div>
        <button id="shishaAddBtn" class="u-btn u-btn-mint" style="font-size:24px;padding:24px 48px;min-height:80px;width:100%;max-width:420px;margin-top:8px;display:inline-flex;align-items:center;justify-content:center;gap:12px;background:linear-gradient(135deg,rgba(139,124,246,.18),rgba(139,124,246,.30));border:1px solid var(--color-accent-glow);color:var(--color-accent)">
          <span style="font-size:32px">+1</span>
          <span>Predaná shisha (17 €)</span>
        </button>
        <div id="shishaStatus" style="margin-top:12px;font-size:12px;color:var(--color-text-muted)"></div>
      </div>

      <!-- Counters -->
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px">
        <div style="background:var(--surface-card);border:1px solid var(--color-border);border-radius:var(--radius-md);padding:18px">
          <div style="font-size:12px;color:var(--color-text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Dnes</div>
          <div style="font-family:var(--font-display);font-size:32px;font-weight:800;line-height:1.1"><span id="shishaTodayCount">0</span> <span style="font-size:18px;font-weight:600;color:var(--color-text-muted)">ks</span></div>
          <div style="font-size:14px;color:var(--color-accent);margin-top:4px;font-variant-numeric:tabular-nums" id="shishaTodayRevenue">0,00 €</div>
        </div>
        <div style="background:var(--surface-card);border:1px solid var(--color-border);border-radius:var(--radius-md);padding:18px">
          <div style="font-size:12px;color:var(--color-text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Tento mesiac</div>
          <div style="font-family:var(--font-display);font-size:32px;font-weight:800;line-height:1.1"><span id="shishaMonthCount">0</span> <span style="font-size:18px;font-weight:600;color:var(--color-text-muted)">ks</span></div>
          <div style="font-size:14px;color:var(--color-accent);margin-top:4px;font-variant-numeric:tabular-nums" id="shishaMonthRevenue">0,00 €</div>
        </div>
        <div style="background:var(--surface-card);border:1px solid var(--color-border);border-radius:var(--radius-md);padding:18px">
          <div style="font-size:12px;color:var(--color-text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Celkovo</div>
          <div style="font-family:var(--font-display);font-size:32px;font-weight:800;line-height:1.1"><span id="shishaTotalCount">0</span> <span style="font-size:18px;font-weight:600;color:var(--color-text-muted)">ks</span></div>
          <div style="font-size:14px;color:var(--color-accent);margin-top:4px;font-variant-numeric:tabular-nums" id="shishaTotalRevenue">0,00 €</div>
        </div>
      </div>

      <!-- Per-day breakdown -->
      <div style="background:var(--surface-card);border:1px solid var(--color-border);border-radius:var(--radius-md);overflow:hidden">
        <div style="padding:16px 20px;border-bottom:1px solid var(--color-border);font-weight:700">Predaje po dňoch (60 dní)</div>
        <div style="overflow-x:auto;max-height:400px">
          <table id="shishaByDay" style="width:100%;border-collapse:collapse">
            <thead style="position:sticky;top:0;background:var(--surface-card)">
              <tr style="border-bottom:1px solid var(--color-border)">
                <th style="text-align:left;padding:10px 16px;font-size:12px;color:var(--color-text-muted);text-transform:uppercase">Dátum</th>
                <th style="text-align:right;padding:10px 16px;font-size:12px;color:var(--color-text-muted);text-transform:uppercase">Počet</th>
                <th style="text-align:right;padding:10px 16px;font-size:12px;color:var(--color-text-muted);text-transform:uppercase">Tržba</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
      </div>

      <!-- Recent sales -->
      <div style="background:var(--surface-card);border:1px solid var(--color-border);border-radius:var(--radius-md);overflow:hidden">
        <div style="padding:16px 20px;border-bottom:1px solid var(--color-border);font-weight:700">Posledných 20 záznamov</div>
        <div style="overflow-x:auto">
          <table id="shishaRecent" style="width:100%;border-collapse:collapse">
            <thead>
              <tr style="border-bottom:1px solid var(--color-border)">
                <th style="text-align:left;padding:10px 16px;font-size:12px;color:var(--color-text-muted);text-transform:uppercase">Čas</th>
                <th style="text-align:left;padding:10px 16px;font-size:12px;color:var(--color-text-muted);text-transform:uppercase">Predal</th>
                <th style="text-align:right;padding:10px 16px;font-size:12px;color:var(--color-text-muted);text-transform:uppercase">Cena</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
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
