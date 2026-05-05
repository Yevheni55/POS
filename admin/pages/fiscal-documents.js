let _container = null;
let searchResults = [];
let selectedDocument = null;

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

function formatDate(value) {
  if (!value) return 'Neznámy';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('sk-SK');
}

function formatSearchModeFields() {
  const mode = byId('fiscalSearchMode').value;
  const wrap = byId('fiscalSearchFields');
  if (!wrap) return;

  if (mode === 'receiptId') {
    wrap.innerHTML = `
      <div class="form-group">
        <label for="fiscalReceiptId">Identifikátor dokladu</label>
        <input class="form-input" id="fiscalReceiptId" type="text" placeholder="napr. O-123456789">
      </div>
    `;
    return;
  }

  if (mode === 'externalId') {
    wrap.innerHTML = `
      <div class="form-group">
        <label for="fiscalExternalId">External ID</label>
        <input class="form-input" id="fiscalExternalId" type="text" placeholder="napr. order-42-payment">
      </div>
    `;
    return;
  }

  wrap.innerHTML = `
    <div class="form-group">
      <label for="fiscalCashRegisterCode">Kód pokladnice</label>
      <input class="form-input" id="fiscalCashRegisterCode" type="text" placeholder="88812345678900001">
    </div>
    <div class="form-group">
      <label for="fiscalYear">Rok</label>
      <input class="form-input" id="fiscalYear" type="number" min="2020" max="2100" value="${new Date().getFullYear()}">
    </div>
    <div class="form-group">
      <label for="fiscalMonth">Mesiac</label>
      <input class="form-input" id="fiscalMonth" type="number" min="1" max="12" value="${new Date().getMonth() + 1}">
    </div>
    <div class="form-group">
      <label for="fiscalReceiptNumber">Číslo dokladu</label>
      <input class="form-input" id="fiscalReceiptNumber" type="number" min="1" step="1" placeholder="napr. 152">
    </div>
  `;
}

function gatherSearchParams() {
  const mode = byId('fiscalSearchMode').value;
  if (mode === 'receiptId') {
    return { receiptId: byId('fiscalReceiptId').value.trim() };
  }
  if (mode === 'externalId') {
    return { externalId: byId('fiscalExternalId').value.trim() };
  }
  return {
    cashRegisterCode: byId('fiscalCashRegisterCode').value.trim(),
    year: byId('fiscalYear').value,
    month: byId('fiscalMonth').value,
    receiptNumber: byId('fiscalReceiptNumber').value,
  };
}

function renderResults() {
  const el = byId('fiscalResults');
  if (!el) return;

  if (!searchResults.length) {
    el.innerHTML = '<div class="empty-hint">Zatiaľ žiadne výsledky. Vyhľadaj doklad podľa údajov z bločku.</div>';
    return;
  }

  let html = '<div class="table-scroll-wrap"><table class="data-table"><thead><tr>';
  html += '<th class="data-th">Doklad</th>';
  html += '<th class="data-th">Typ</th>';
  html += '<th class="data-th">Objednávka</th>';
  html += '<th class="data-th">Stôl</th>';
  html += '<th class="data-th">Dátum</th>';
  html += '<th class="data-th">Stav</th>';
  html += '</tr></thead><tbody>';

  searchResults.forEach((item) => {
    const active = selectedDocument && selectedDocument.id === item.id ? ' style="background:rgba(139,124,246,.08)"' : '';
    html += `<tr class="data-row" data-fiscal-row="${item.id}"${active}>`;
    html += `<td class="data-td"><strong>${escapeHtml(item.receiptId || item.externalId || ('#' + item.id))}</strong><div class="text-muted" style="font-size:12px">${escapeHtml(item.okp || '')}</div></td>`;
    html += `<td class="data-td">${escapeHtml(item.sourceType)}</td>`;
    html += `<td class="data-td">#${item.orderId || '-'} / payment #${item.paymentId || '-'}</td>`;
    html += `<td class="data-td">${escapeHtml(item.tableName || '-')}</td>`;
    html += `<td class="data-td">${escapeHtml(formatDate(item.processDate))}</td>`;
    html += `<td class="data-td">${escapeHtml(item.resultMode)}</td>`;
    html += '</tr>';
  });

  html += '</tbody></table></div>';
  el.innerHTML = html;
}

function renderDetail() {
  const el = byId('fiscalDetail');
  if (!el) return;

  if (!selectedDocument) {
    el.innerHTML = '<div class="empty-hint">Vyber doklad zo zoznamu pre detail a storno.</div>';
    return;
  }

  const copyBtn = selectedDocument.paymentId
    ? '<button class="btn-save btn-sm" id="btnFiscalCopy">Vytlačiť kópiu</button>'
    : '';
  const stornoBtn = selectedDocument.stornoEligible
    ? '<button class="btn-save btn-sm" id="btnFiscalDocStorno" style="background:var(--color-danger, #c44)">Odoslať STORNO</button>'
    : '';
  // "Zmenit sposob platby" — viditeľné iba ak je doklad eligible na storno
  // (úspešný sale doc bez existujúceho storno) a má naviazanú platbu.
  // Po klikuotvorí dropdown s 'hotovost' / 'karta' a zavolá change-method
  // endpoint ktorý automaticky urobí storno + nový doklad s novou metódou.
  const changeMethodBtn = (selectedDocument.stornoEligible && selectedDocument.paymentId && selectedDocument.paymentMethod)
    ? '<button class="btn-save btn-sm" id="btnFiscalChangeMethod" style="background:var(--accent-amber, #d97706)">Zmeniť spôsob platby</button>'
    : '';

  el.innerHTML = `
    <div class="section" style="margin:0">
      <div class="section-title">Detail dokladu</div>
      <div class="form-grid">
        <div class="form-group"><label>Receipt ID</label><div>${escapeHtml(selectedDocument.receiptId || '-')}</div></div>
        <div class="form-group"><label>External ID</label><div>${escapeHtml(selectedDocument.externalId || '-')}</div></div>
        <div class="form-group"><label>OKP</label><div>${escapeHtml(selectedDocument.okp || '-')}</div></div>
        <div class="form-group"><label>Číslo dokladu</label><div>${escapeHtml(selectedDocument.receiptNumber || '-')}</div></div>
        <div class="form-group"><label>Kód pokladnice</label><div>${escapeHtml(selectedDocument.cashRegisterCode || '-')}</div></div>
        <div class="form-group"><label>Dátum</label><div>${escapeHtml(formatDate(selectedDocument.processDate))}</div></div>
        <div class="form-group"><label>Platba</label><div>#${escapeHtml(selectedDocument.paymentId || '-')}</div></div>
        <div class="form-group"><label>Objednávka</label><div>#${escapeHtml(selectedDocument.orderId || '-')}</div></div>
        <div class="form-group"><label>Typ</label><div>${escapeHtml(selectedDocument.sourceType)}</div></div>
        <div class="form-group"><label>Stav</label><div>${escapeHtml(selectedDocument.resultMode)}</div></div>
        <div class="form-group"><label>Storno</label><div>${selectedDocument.stornoDone ? 'Už odoslané' : (selectedDocument.stornoEligible ? 'Možné' : 'Nie')}</div></div>
      </div>
      <div class="flex-row gap-2 mt-3">${copyBtn}${stornoBtn}${changeMethodBtn}</div>
    </div>
  `;
}

async function runSearch() {
  const btn = byId('btnFiscalSearch');
  if (btn) btn.disabled = true;
  try {
    const response = await api.searchFiscalDocuments(gatherSearchParams());
    searchResults = response.items || [];
    selectedDocument = null;
    renderResults();
    renderDetail();
    if (!searchResults.length) {
      showToast('Doklad sa nenašiel', 'warning');
    }
  } catch (error) {
    searchResults = [];
    selectedDocument = null;
    renderResults();
    renderDetail();
    showToast(error.message || 'Chyba vyhľadávania dokladov', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function loadDetail(documentId) {
  try {
    selectedDocument = await api.getFiscalDocument(documentId);
    renderResults();
    renderDetail();
  } catch (error) {
    showToast(error.message || 'Nepodarilo sa načítať detail dokladu', 'error');
  }
}

async function printCopy() {
  if (!selectedDocument || !selectedDocument.paymentId) return;
  try {
    const result = await api.post('/payments/' + selectedDocument.paymentId + '/receipt-copy', {});
    showToast(result && result.printed ? 'Kópia dokladu vytlačená' : 'Požiadavka na kópiu odoslaná', true);
  } catch (error) {
    showToast(error.message || 'Kópiu sa nepodarilo vytlačiť', 'error');
  }
}

function confirmChangeMethod() {
  if (!selectedDocument || !selectedDocument.stornoEligible || !selectedDocument.paymentId) return;
  // Súčasná metóda = label v detaile. Ponúkneme tú druhú možnosť (jediný
  // valid prepínač pre operátora — nemá zmysel meniť hotovost na hotovost).
  const current = String(selectedDocument.paymentMethod || '').toLowerCase();
  const target = (current === 'hotovost' || current === 'cash') ? 'karta' : 'hotovost';
  const labelMap = { hotovost: 'Hotovosť', karta: 'Karta' };
  const newLabel = labelMap[target] || target;
  const oldLabel = labelMap[current] || current;

  showConfirm(
    'Zmena spôsobu platby',
    `Pôvodný doklad (${oldLabel}) sa vystorno na Portos a vytlačí sa nový doklad s metódou ${newLabel}. Pokračovať?`,
    async function () {
      try {
        const result = await api.post('/payments/' + selectedDocument.paymentId + '/change-method', { newMethod: target });
        showToast('Metóda zmenená: ' + oldLabel + ' → ' + newLabel + (result.newSaleFiscal && result.newSaleFiscal.receiptId ? ' (' + result.newSaleFiscal.receiptId + ')' : ''), true);
        await loadDetail(selectedDocument.id);
      } catch (error) {
        showToast(error.message || 'Chyba zmeny metódy', 'error');
      }
    },
    { type: 'warning', confirmText: 'Storno + nový doklad' }
  );
}

function confirmStorno() {
  if (!selectedDocument || !selectedDocument.stornoEligible) return;
  showConfirm(
    'Fiškálne STORNO',
    'Naozaj odoslať STORNO pre vybraný doklad? Táto operácia odošle opravný doklad do eKasa cez Portos.',
    async function () {
      try {
        const result = await api.stornoFiscalDocument(selectedDocument.id);
        showToast('STORNO odoslané (' + (result.fiscal?.status || 'ok') + ')', true);
        await loadDetail(selectedDocument.id);
      } catch (error) {
        showToast(error.message || 'Chyba STORNO', 'error');
      }
    },
    { type: 'danger', confirmText: 'Odoslať STORNO' }
  );
}

function onClick(event) {
  const row = event.target.closest('[data-fiscal-row]');
  if (row) {
    loadDetail(Number(row.dataset.fiscalRow));
    return;
  }

  if (event.target.id === 'btnFiscalSearch' || event.target.closest('#btnFiscalSearch')) {
    runSearch();
    return;
  }

  if (event.target.id === 'btnFiscalCopy' || event.target.closest('#btnFiscalCopy')) {
    printCopy();
    return;
  }

  if (event.target.id === 'btnFiscalDocStorno' || event.target.closest('#btnFiscalDocStorno')) {
    confirmStorno();
    return;
  }

  if (event.target.id === 'btnFiscalChangeMethod' || event.target.closest('#btnFiscalChangeMethod')) {
    confirmChangeMethod();
  }
}

function onChange(event) {
  if (event.target.id === 'fiscalSearchMode') {
    formatSearchModeFields();
  }
}

function getTemplate() {
  return `
    <div class="section">
      <div class="section-title">Fiškálne doklady</div>
      <div class="form-grid">
        <div class="form-group">
          <label for="fiscalSearchMode">Spôsob hľadania</label>
          <select class="form-select" id="fiscalSearchMode">
            <option value="receiptId">Identifikátor dokladu</option>
            <option value="externalId">External ID</option>
            <option value="receiptTriplet">Kód pokladnice + rok + mesiac + číslo dokladu</option>
          </select>
        </div>
      </div>
      <div id="fiscalSearchFields" class="form-grid"></div>
      <div class="flex-row gap-2 mt-3">
        <button class="btn-save btn-sm" id="btnFiscalSearch">Vyhľadať doklad</button>
      </div>
    </div>
    <div class="section">
      <div class="section-title">Výsledky</div>
      <div id="fiscalResults"></div>
    </div>
    <div id="fiscalDetail"></div>
  `;
}

export function init(container) {
  _container = container;
  container.innerHTML = getTemplate();
  container.addEventListener('click', onClick);
  container.addEventListener('change', onChange);
  formatSearchModeFields();
  renderResults();
  renderDetail();
}

export function destroy() {
  if (_container) {
    _container.removeEventListener('click', onClick);
    _container.removeEventListener('change', onChange);
  }
  _container = null;
  searchResults = [];
  selectedDocument = null;
}
