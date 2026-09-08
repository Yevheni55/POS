let _container = null;
let searchResults = [];
let selectedDocument = null;

function byId(id) {
  return _container.querySelector('#' + id);
}

// Jediná implementácia escapovania v projekte je /js/pos-escape.js
// (escHtml pre textový obsah, escAttr pre atribút, escJsAttr pre inline
// handler). Predtým mala takmer každá admin stránka vlastnú kópiu a boli
// medzi nimi ŠTYRI rôzne správania — časť neescapovala apostrof ani
// úvodzovku, čo je práve to, na čom záleží pri interpolácii do atribútu.
// Lokálne meno ostáva, nech sa neprepisujú stovky volaní.
function escapeHtml(v) {
  // window.* zamerne: v moduloch, kde sa lokalna funkcia vola tiez escHtml,
  // by holy identifikator ukazoval sam na seba (nekonecna rekurzia).
  if (typeof window !== 'undefined' && typeof window.escHtml === 'function') return window.escHtml(v);
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
        <label for="fiscalExternalId">Externé ID</label>
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
    <div class="rp-form-2">
      <div class="form-group">
        <label for="fiscalYear">Rok</label>
        <input class="form-input" id="fiscalYear" type="number" min="2020" max="2100" value="${new Date().getFullYear()}">
      </div>
      <div class="form-group">
        <label for="fiscalMonth">Mesiac</label>
        <input class="form-input" id="fiscalMonth" type="number" min="1" max="12" value="${new Date().getMonth() + 1}">
      </div>
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

function resultTone(mode) {
  const m = String(mode || '');
  if (/success|online|reconcil/.test(m)) return 'is-ok';
  if (/offline|accepted|pending/.test(m)) return 'is-warn';
  if (/ambig|error|reject|block|invalid/.test(m)) return 'is-bad';
  return 'is-muted';
}

function renderResults() {
  const el = byId('fiscalResults');
  if (!el) return;

  if (!searchResults.length) {
    el.innerHTML = '<div class="empty-hint">Zatiaľ žiadne výsledky. Zadaj údaje z bločku a klepni na „Vyhľadať doklad".</div>';
    return;
  }

  // Zoznam riadkov: identifikátor + typ/čas/objednávka, stav ako pilulka
  // vpravo. Celý riadok otvorí detail (panel zdola).
  let html = '<div class="rp-list">';
  searchResults.forEach((item) => {
    const active = selectedDocument && selectedDocument.id === item.id;
    const sub = [
      item.sourceType ? escapeHtml(item.sourceType) : '',
      escapeHtml(formatDate(item.processDate)),
      item.orderId ? 'obj. #' + item.orderId : '',
      item.tableName ? escapeHtml(item.tableName) : '',
    ].filter(Boolean).join(' · ');
    html += `<button type="button" class="rp-row has-chev${active ? ' is-on' : ''}" data-fiscal-row="${item.id}" aria-pressed="${active ? 'true' : 'false'}">`
      + `<span class="rp-row-main"><span class="rp-row-t">${escapeHtml(item.receiptId || item.externalId || ('#' + item.id))}</span>`
      + `<span class="rp-row-s">${sub}${item.okp ? '<br>' + escapeHtml(item.okp) : ''}</span></span>`
      + `<span class="rp-row-side"><span class="rp-pill ${resultTone(item.resultMode)}">${escapeHtml(item.resultMode || '—')}</span></span>`
      + '<svg class="rp-row-chev" aria-hidden="true" viewBox="0 0 16 16"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      + '</button>';
  });
  html += '</div>';
  el.innerHTML = html;
}

function renderDetail() {
  const el = byId('fiscalDetail');
  if (!el) return;

  if (!selectedDocument) {
    el.innerHTML = '';
    return;
  }

  const d = selectedDocument;
  const copyBtn = d.paymentId
    ? '<button type="button" class="btn-add" id="btnFiscalCopy">Vytlačiť kópiu dokladu</button>'
    : '';
  // Zmena spôsobu platby — iba ak je doklad eligible na storno a má platbu.
  // Backend urobí storno + nový doklad s novým spôsobom.
  const changeMethodBtn = (d.stornoEligible && d.paymentId && d.paymentMethod)
    ? '<button type="button" class="btn-secondary" id="btnFiscalChangeMethod">Zmeniť spôsob platby</button>'
    : '';
  const stornoBtn = d.stornoEligible
    ? '<button type="button" class="btn-secondary rp-btn-danger" id="btnFiscalDocStorno">Odoslať STORNO</button>'
    : '';
  const stornoState = d.stornoDone ? 'už odoslané' : (d.stornoEligible ? 'možné' : 'nie je možné');
  const kv = (k, v) => '<dt>' + k + '</dt><dd>' + v + '</dd>';

  el.innerHTML = `
    <div class="u-overlay show" role="dialog" aria-modal="true" aria-labelledby="fiscalDetailTitle">
      <button type="button" class="rp-scrim" id="btnFiscalScrim" aria-label="Zavrieť"></button>
      <div class="u-modal rp-sheet">
        <div class="rp-sheet-head">
          <div>
            <h3 class="rp-sheet-title" id="fiscalDetailTitle">${escapeHtml(d.receiptId || d.externalId || ('Doklad #' + d.id))}</h3>
            <div class="rp-sheet-sub">${escapeHtml(formatDate(d.processDate))}</div>
          </div>
          <button type="button" class="rp-sheet-close" id="btnFiscalClose" aria-label="Zavrieť">×</button>
        </div>
        <div class="rp-sheet-body">
          <dl class="rp-kv">
            ${kv('Stav', '<span class="rp-pill ' + resultTone(d.resultMode) + '">' + escapeHtml(d.resultMode || '—') + '</span>')}
            ${kv('Typ', escapeHtml(d.sourceType || '-'))}
            ${kv('Číslo dokladu', escapeHtml(d.receiptNumber || '-'))}
            ${kv('OKP', escapeHtml(d.okp || '-'))}
            ${kv('Externé ID', escapeHtml(d.externalId || '-'))}
            ${kv('Kód pokladnice', escapeHtml(d.cashRegisterCode || '-'))}
            ${kv('Platba', d.paymentId ? '#' + escapeHtml(d.paymentId) : '-')}
            ${kv('Objednávka', d.orderId ? '#' + escapeHtml(d.orderId) : '-')}
            ${kv('Storno', stornoState)}
          </dl>
        </div>
        ${(copyBtn || changeMethodBtn || stornoBtn) ? '<div class="rp-sheet-actions">' + copyBtn + changeMethodBtn + stornoBtn + '</div>' : ''}
      </div>
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

  // Zavretie detailu (krížik alebo klepnutie mimo panel).
  if (event.target.closest('#btnFiscalClose') || event.target.closest('#btnFiscalScrim')) {
    selectedDocument = null;
    renderResults();
    renderDetail();
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
    <div class="panel rp-panel rp-form">
      <div class="form-group">
        <label for="fiscalSearchMode">Hľadať podľa</label>
        <select class="form-select" id="fiscalSearchMode">
          <option value="receiptId">Identifikátor dokladu</option>
          <option value="externalId">Externé ID</option>
          <option value="receiptTriplet">Kód pokladnice + rok + mesiac + číslo dokladu</option>
        </select>
      </div>
      <div id="fiscalSearchFields" class="rp-form"></div>
      <button type="button" class="btn-add" id="btnFiscalSearch">Vyhľadať doklad</button>
    </div>
    <div class="rp-sub">Klepnutím na doklad otvoríš detail s kópiou, zmenou spôsobu platby a stornom.</div>
    <div id="fiscalResults"></div>
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
