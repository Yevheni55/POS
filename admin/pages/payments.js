let _container = null;
let items = [];
let filter = { method: '', q: '', scope: 'current' };
let loading = false;
let lastMeta = { hiddenByScope: 0, activeCashRegisterCode: '' };

function byId(id) {
  return _container.querySelector('#' + id);
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtEur(value) {
  var n = Number(value);
  if (!Number.isFinite(n)) return '-';
  return n.toFixed(2) + ' €';
}

function fmtDate(value) {
  if (!value) return '-';
  var d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('sk-SK', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function methodLabel(method) {
  if (method === 'hotovost') return 'Hotovosť';
  if (method === 'karta') return 'Karta';
  return method || '-';
}

function statusBadge(status, tone) {
  var palette = {
    success: 'background:#1f8a4c33;color:#4fd491;border:1px solid #1f8a4c66',
    warning: 'background:#c8991e33;color:#ffd37a;border:1px solid #c8991e66',
    error: 'background:#c4434333;color:#ff8b8b;border:1px solid #c4434366',
    muted: 'background:#2a2a2f;color:#b9b9c7;border:1px solid #3a3a44',
  };
  var style = palette[tone] || palette.muted;
  return '<span style="display:inline-flex;align-items:center;padding:3px 9px;border-radius:999px;font-size:12px;font-weight:600;' + style + '">' + escapeHtml(status) + '</span>';
}

function fiscalCell(item) {
  if (item.storno) {
    return statusBadge('Stornované', 'warning') + '<div class="text-muted" style="font-size:12px;margin-top:2px">' + escapeHtml(item.storno.externalId || '') + '</div>';
  }
  if (!item.fiscal) {
    return statusBadge('bez eKasa', 'muted');
  }
  var s = item.fiscal.status;
  var tone = /success/.test(s) ? 'success' : (/accepted/.test(s) ? 'warning' : (/ambig|error|reject|block|valid/.test(s) ? 'error' : 'muted'));
  var meta = '';
  if (item.fiscal.receiptNumber) meta += 'č. ' + escapeHtml(item.fiscal.receiptNumber);
  if (item.fiscal.okp) meta += (meta ? ' · ' : '') + escapeHtml(item.fiscal.okp);
  return statusBadge(s, tone) + (meta ? '<div class="text-muted" style="font-size:12px;margin-top:2px">' + meta + '</div>' : '');
}

function actionsCell(item) {
  var html = '';
  if (item.copyAvailable) {
    html += '<button class="btn-save btn-sm" data-payment-copy="' + item.id + '" style="margin-right:6px">Kópia dokladu</button>';
  }
  // Re-fiškalizácia: pre prípady keď doklad v Portos nezodpovedá objednávke
  // (mismatch_rejected) alebo keď cashier hlási že blok nevyšiel / vyšiel cudzí.
  // Pošle nový request s reálnymi položkami pod novým unique externalId
  // a hneď vytlačí kópiu. Vyžaduje manazer/admin role.
  if (item.fiscal) {
    var fiscalStatus = String(item.fiscal.status || '');
    var needsRefiscalize = fiscalStatus === 'mismatch_rejected' || fiscalStatus === 'ambiguous' || fiscalStatus === 'rejected';
    var btnTone = needsRefiscalize ? 'background:var(--color-warning,#E0A830)' : '';
    html += '<button class="btn-save btn-sm" data-payment-refiscalize="' + item.id + '" style="margin-right:6px;' + btnTone + '" title="Pošle nový fiškálny request a vytlačí blok">Re-fiškalizovať</button>';
  }
  if (item.stornoEligible) {
    html += '<button class="btn-save btn-sm" data-payment-storno="' + item.id + '" style="background:var(--color-danger,#c44)">STORNO</button>';
  } else if (item.storno) {
    html += '<span class="text-muted" style="font-size:12px">Už stornované</span>';
  } else if (!item.fiscal) {
    html += '<span class="text-muted" style="font-size:12px">—</span>';
  } else {
    html += '<span class="text-muted" style="font-size:12px">Nedostupné</span>';
  }
  return html;
}

function renderTable() {
  var el = byId('paymentsTable');
  if (!el) return;

  if (loading) {
    el.innerHTML = '<div class="loading-hint">Nacitavam historiu platieb...</div>';
    return;
  }

  if (!items.length) {
    el.innerHTML = '<div class="empty-hint">Žiadne platby podľa filtra.</div>';
    return;
  }

  var html = '<div class="table-scroll-wrap"><table class="data-table"><thead><tr>';
  html += '<th class="data-th">ID</th>';
  html += '<th class="data-th">Kedy</th>';
  html += '<th class="data-th">Stôl / Účet</th>';
  html += '<th class="data-th">Spôsob</th>';
  html += '<th class="data-th">Suma</th>';
  html += '<th class="data-th">Fiškalizácia</th>';
  html += '<th class="data-th">Akcie</th>';
  html += '</tr></thead><tbody>';

  items.forEach(function (item) {
    html += '<tr class="data-row">';
    html += '<td class="data-td"><strong>#' + item.id + '</strong><div class="text-muted" style="font-size:12px">obj. #' + (item.orderId || '-') + '</div></td>';
    html += '<td class="data-td">' + escapeHtml(fmtDate(item.createdAt)) + '</td>';
    html += '<td class="data-td">' + escapeHtml(item.tableName || '-') + '<div class="text-muted" style="font-size:12px">' + escapeHtml(item.orderLabel || '') + '</div></td>';
    html += '<td class="data-td">' + escapeHtml(methodLabel(item.method)) + '</td>';
    html += '<td class="data-td num">' + escapeHtml(fmtEur(item.amount)) + '</td>';
    html += '<td class="data-td">' + fiscalCell(item) + '</td>';
    html += '<td class="data-td">' + actionsCell(item) + '</td>';
    html += '</tr>';
  });
  html += '</tbody></table></div>';
  el.innerHTML = html;
}

async function loadHistory() {
  loading = true;
  renderTable();
  try {
    var res = await api.getPaymentsHistory({
      method: filter.method || undefined,
      q: filter.q || undefined,
      scope: filter.scope,
      limit: 200,
    });
    items = (res && res.items) || [];
    lastMeta = {
      hiddenByScope: res && Number(res.hiddenByScope) || 0,
      activeCashRegisterCode: (res && res.activeCashRegisterCode) || '',
    };
  } catch (e) {
    items = [];
    lastMeta = { hiddenByScope: 0, activeCashRegisterCode: '' };
    showToast(e.message || 'Chyba načítania histórie', 'error');
  } finally {
    loading = false;
    renderTable();
    renderScopeHint();
  }
}

function renderScopeHint() {
  var el = byId('paymentsScopeHint');
  if (!el) return;
  if (filter.scope === 'all') {
    el.innerHTML = 'Zobrazené sú <strong>všetky</strong> platby (vrátane platieb zo starej eKasy / inej firmy).';
    return;
  }
  if (lastMeta.hiddenByScope > 0) {
    el.innerHTML = 'Zobrazené sú iba platby <strong>aktuálnej eKasy</strong> (' + escapeHtml(lastMeta.activeCashRegisterCode || '-') + '). Skrytých: <strong>' + lastMeta.hiddenByScope + '</strong> zo starej eKasy. Prepni na „Všetky" pre zobrazenie celej histórie.';
    return;
  }
  el.innerHTML = 'Zobrazené sú iba platby aktuálnej eKasy (' + escapeHtml(lastMeta.activeCashRegisterCode || '-') + ').';
}

async function printCopy(id) {
  try {
    var r = await api.printReceiptCopy(id);
    showToast(r && r.printed ? 'Kópia odoslaná na CHDU' : 'Požiadavka na kópiu prijatá', true);
  } catch (e) {
    var msg = (e && e.data && (e.data.error || e.data.detail)) || e.message || 'Kópiu sa nepodarilo vytlačiť';
    showToast(msg, 'error');
  }
}

function confirmRefiscalize(id) {
  showConfirm(
    'Re-fiškalizovať platbu',
    'Pošle nový fiškálny request pre platbu #' + id + ' s reálnymi položkami pod novým externalId. Pôvodný fiškálny záznam bude nahradený a kópia bonu sa hneď vytlačí na CHDU. Použiť keď blok nevyšiel alebo vyšiel cudzí.',
    async function () {
      try {
        var r = await api.refiscalizePayment(id);
        var st = (r && r.fiscal && r.fiscal.status) || 'ok';
        var printed = r && r.print && r.print.printed;
        showToast('Re-fiškalizácia OK (' + st + ')' + (printed ? ' · blok vytlačený' : ' · blok v queue'), true);
        await loadHistory();
      } catch (e) {
        var msg = (e && e.data && (e.data.error || e.data.detail)) || e.message || 'Re-fiškalizácia zlyhala';
        showToast(msg, 'error');
      }
    },
    { type: 'danger', confirmText: 'Re-fiškalizovať' },
  );
}

function confirmStorno(id) {
  showConfirm(
    'Fiškálne STORNO',
    'Naozaj odoslať STORNO pre platbu #' + id + '? Operácia odošle opravný doklad do eKasy cez Portos a vytlačí blok na CHDU.',
    async function () {
      try {
        var r = await api.stornoPayment(id);
        var st = (r && r.fiscal && r.fiscal.status) || 'ok';
        showToast('STORNO odoslané (' + st + ')', true);
        await loadHistory();
      } catch (e) {
        var msg = (e && e.data && (e.data.error || e.data.detail)) || e.message || 'Chyba STORNO';
        showToast(msg, 'error');
      }
    },
    { type: 'danger', confirmText: 'Odoslať STORNO' },
  );
}

function onClick(event) {
  var storno = event.target.closest('[data-payment-storno]');
  if (storno) {
    confirmStorno(Number(storno.dataset.paymentStorno));
    return;
  }
  var copy = event.target.closest('[data-payment-copy]');
  if (copy) {
    printCopy(Number(copy.dataset.paymentCopy));
    return;
  }
  var refisc = event.target.closest('[data-payment-refiscalize]');
  if (refisc) {
    confirmRefiscalize(Number(refisc.dataset.paymentRefiscalize));
    return;
  }
  if (event.target.id === 'btnPaymentsRefresh' || event.target.closest('#btnPaymentsRefresh')) {
    loadHistory();
  }
}

function onChange(event) {
  if (event.target.id === 'paymentsMethod') {
    filter.method = event.target.value;
    loadHistory();
    return;
  }
  if (event.target.id === 'paymentsScope') {
    filter.scope = event.target.value;
    loadHistory();
  }
}

function onInput(event) {
  if (event.target.id === 'paymentsQuery') {
    filter.q = event.target.value;
    clearTimeout(onInput._timer);
    onInput._timer = setTimeout(loadHistory, 250);
  }
}

function getTemplate() {
  return `
    <div class="section">
      <div class="section-title">História platieb</div>
      <div class="text-muted" style="font-size:13px;line-height:1.5;margin-bottom:12px">
        Zoznam platieb s fiškálnym stavom. Pri úspešne zaevidovanom doklade sa dá priamo vytlačiť kópia alebo odoslať <strong>STORNO</strong>. STORNO je dostupné iba pre platby registrované v Portos (online/offline/reconciled) a pokiaľ ešte nebolo odoslané.
      </div>
      <div class="form-grid" style="margin-bottom:12px">
        <div class="form-group">
          <label for="paymentsScope">Rozsah</label>
          <select class="form-select" id="paymentsScope">
            <option value="current" selected>Iba aktuálna eKasa</option>
            <option value="all">Všetky (vrátane starej firmy)</option>
          </select>
        </div>
        <div class="form-group">
          <label for="paymentsMethod">Spôsob platby</label>
          <select class="form-select" id="paymentsMethod">
            <option value="">Všetky</option>
            <option value="hotovost">Hotovosť</option>
            <option value="karta">Karta</option>
          </select>
        </div>
        <div class="form-group">
          <label for="paymentsQuery">Hľadať</label>
          <input class="form-input" id="paymentsQuery" type="text" placeholder="ID platby, stôl, objednávka...">
        </div>
        <div class="form-group" style="display:flex;align-items:flex-end">
          <button class="btn-save btn-sm" id="btnPaymentsRefresh">Obnoviť</button>
        </div>
      </div>
      <div id="paymentsScopeHint" class="text-muted" style="font-size:12px;margin:0 0 10px"></div>
      <div id="paymentsTable"></div>
    </div>
  `;
}

export async function init(container) {
  _container = container;
  container.innerHTML = getTemplate();
  container.addEventListener('click', onClick);
  container.addEventListener('change', onChange);
  container.addEventListener('input', onInput);
  await loadHistory();
}

export function destroy() {
  if (_container) {
    _container.removeEventListener('click', onClick);
    _container.removeEventListener('change', onChange);
    _container.removeEventListener('input', onInput);
  }
  _container = null;
  items = [];
  filter = { method: '', q: '' };
  loading = false;
}
