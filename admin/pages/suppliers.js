// Suppliers page module
import { softDelete } from '../components/toast-undo.js';

let suppliers = [];
let editingId = null;
// Hľadanie má zmysel až od SEARCH_FROM dodávateľov; pod tým je celý zoznam
// na jednej obrazovke.
const SEARCH_FROM = 9;
let _container = null;
let _escHandler = null;

function $(sel) {
  return _container.querySelector(sel);
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

// ===== LOAD =====
async function loadSuppliers() {
  const tbody = $('#suppliersBody');
  if (tbody) showLoading(tbody.closest('.panel') || tbody, 'Načítavam dodávateľov…');
  try {
    suppliers = await api.get('/inventory/suppliers');
    if (tbody) hideLoading(tbody.closest('.panel') || tbody);
    renderSuppliers();
  } catch (err) {
    if (tbody) hideLoading(tbody.closest('.panel') || tbody);
    const panel = tbody ? tbody.closest('.panel') : null;
    if (panel) {
      renderError(panel, err.message || 'Chyba pri načítaní dodávateľov', loadSuppliers);
    }
  }
}

// ===== RENDER =====
function supplierWord(n) {
  if (n === 1) return 'dodávateľ';
  if (n >= 2 && n <= 4) return 'dodávatelia';
  return 'dodávateľov';
}

// Riadok dodávateľa: názov, pod ním kontakt a telefón; „neaktívny" je
// výnimka a hlási sa pilulkou. Celý riadok otvára úpravu.
function rowHtml(s) {
  const parts = [];
  if (s.contactPerson) parts.push(escapeHtml(s.contactPerson));
  if (s.phone) parts.push(escapeHtml(s.phone));
  if (!parts.length && s.email) parts.push(escapeHtml(s.email));
  return '<button type="button" class="sk-row' + (s.active ? '' : ' is-off') + '" data-edit-id="' + s.id + '">' +
    '<span class="sk-row-main">' +
      '<span class="sk-row-name">' + escapeHtml(s.name) + '</span>' +
      (parts.length ? '<span class="sk-row-sub">' + parts.join(' · ') + '</span>' : '') +
    '</span>' +
    '<span class="sk-row-side">' +
      (s.active ? '' : '<span class="sk-pill is-dim">neaktívny</span>') +
    '</span>' +
    '<svg class="sk-row-chev" aria-hidden="true" viewBox="0 0 16 16"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
  '</button>';
}

function renderSuppliers() {
  const search = ($('#supplierSearch') || {}).value || '';
  const searchLower = search.toLowerCase();

  const filtered = suppliers.filter(s => {
    if (!searchLower) return true;
    const haystack = (s.name + ' ' + (s.contactPerson || '') + ' ' + (s.email || '')).toLowerCase();
    return haystack.includes(searchLower);
  });

  const tbody = $('#suppliersBody');
  if (!tbody) return;

  const countEl = $('#supplierCount');
  if (countEl) {
    const off = suppliers.filter(s => !s.active).length;
    countEl.textContent = suppliers.length + ' ' + supplierWord(suppliers.length)
      + (off ? ' · ' + off + (off === 1 ? ' neaktívny' : ' neaktívni') : '');
  }
  const searchWrap = $('#supplierSearchWrap');
  if (searchWrap) searchWrap.hidden = suppliers.length < SEARCH_FROM;

  if (!suppliers || suppliers.length === 0) {
    tbody.innerHTML = '<div class="empty-hint">Zatiaľ žiadni dodávatelia. Pridajte prvého tlačidlom „Pridať" — objednávky skladu potom pôjdu na jeho meno.</div>';
    return;
  }

  if (filtered.length === 0) {
    tbody.innerHTML = '<div class="empty-hint">Nič sa nenašlo. Skúste iný výraz alebo hľadanie vymažte.</div>';
    return;
  }

  // Aktívni hore, neaktívni dole.
  const sorted = filtered.slice().sort((a, b) => (a.active === b.active ? 0 : (a.active ? -1 : 1)));
  tbody.innerHTML = sorted.map(rowHtml).join('');
}

// ===== MODAL =====
function openModal(id) {
  editingId = id || null;

  const existing = document.getElementById('supplierModal');
  if (existing) existing.remove();

  const s = editingId ? suppliers.find(x => x.id === editingId) : null;
  const title = s ? 'Upraviť dodávateľa' : 'Pridať dodávateľa';

  // Odstránenie je vo formulári, nie na každom riadku zoznamu.
  const deleteBlock = s
    ? '<div class="sk-actions"><button type="button" class="u-btn u-btn-rose" id="supplierModalDelete">Odstrániť dodávateľa</button></div>'
    : '';

  const ov = document.createElement('div');
  ov.className = 'u-overlay';
  ov.id = 'supplierModal';
  ov.innerHTML = `<div class="u-modal sk-modal" style="max-width:520px">
    <div class="u-modal-title">${title}</div>
    <div class="u-modal-body">
      <div class="u-modal-field">
        <label for="fSupName">Názov<span class="required-mark" aria-hidden="true"> *</span></label>
        <input id="fSupName" type="text" class="form-input" placeholder="Názov dodávateľa" aria-required="true" data-validate="required" value="${s ? escapeHtml(s.name) : ''}">
      </div>
      <div class="u-modal-field">
        <label for="fSupContact">Kontaktná osoba</label>
        <input id="fSupContact" type="text" class="form-input" placeholder="Meno a priezvisko" value="${s ? escapeHtml(s.contactPerson || '') : ''}">
      </div>
      <div class="u-modal-row">
        <div class="u-modal-field">
          <label for="fSupPhone">Telefón</label>
          <input id="fSupPhone" type="tel" class="form-input" placeholder="+421…" value="${s ? escapeHtml(s.phone || '') : ''}">
        </div>
        <div class="u-modal-field">
          <label for="fSupEmail">E-mail</label>
          <input id="fSupEmail" type="email" class="form-input" placeholder="meno@firma.sk" value="${s ? escapeHtml(s.email || '') : ''}">
        </div>
      </div>
      <div class="u-modal-field">
        <label for="fSupNotes">Poznámky</label>
        <textarea id="fSupNotes" class="form-input" rows="3" placeholder="Dodacie podmienky, poznámky…">${s ? escapeHtml(s.notes || '') : ''}</textarea>
      </div>
      ${deleteBlock}
    </div>
    <div class="u-modal-btns">
      <button class="u-btn u-btn-ghost" id="supplierModalCancel">Zrušiť</button>
      <button class="u-btn u-btn-ice" id="supplierModalSave">${s ? 'Uložiť zmeny' : 'Pridať dodávateľa'}</button>
    </div>
  </div>`;

  document.body.appendChild(ov);
  requestAnimationFrame(() => ov.classList.add('show'));

  wireValidation(ov);

  const closeModal = () => {
    ov.classList.remove('show');
    setTimeout(() => ov.remove(), 300);
    editingId = null;
  };

  document.getElementById('supplierModalCancel').onclick = closeModal;
  ov.addEventListener('click', e => { if (e.target === ov) closeModal(); });

  const delBtn = document.getElementById('supplierModalDelete');
  if (delBtn && s) {
    delBtn.onclick = () => {
      const delId = s.id;
      closeModal();
      deleteSupplier(delId);
    };
  }

  document.getElementById('supplierModalSave').onclick = async () => {
    if (!validateForm(ov)) return;

    const name = document.getElementById('fSupName').value.trim();
    const contactPerson = document.getElementById('fSupContact').value.trim();
    const phone = document.getElementById('fSupPhone').value.trim();
    const email = document.getElementById('fSupEmail').value.trim();
    const notes = document.getElementById('fSupNotes').value.trim();

    const saveBtn = document.getElementById('supplierModalSave');
    if (saveBtn) btnLoading(saveBtn);
    try {
      if (editingId) {
        await api.put('/inventory/suppliers/' + editingId, { name, contactPerson, phone, email, notes });
        showToast('Dodávateľ upravený', true);
      } else {
        await api.post('/inventory/suppliers', { name, contactPerson, phone, email, notes });
        showToast('Dodávateľ pridaný', true);
      }
      closeModal();
      await loadSuppliers();
    } catch (err) {
      showToast(err.message || 'Chyba ukladania dodávateľa', 'error');
    } finally {
      if (saveBtn) btnReset(saveBtn);
    }
  };

  setTimeout(() => document.getElementById('fSupName').focus(), 100);
}

// ===== DELETE (optimistic + undo-toast) =====
async function deleteSupplier(id) {
  const idx = suppliers.findIndex(x => x.id === id);
  if (idx < 0) return;
  const snapshot = suppliers[idx];

  // Optimistic remove
  suppliers.splice(idx, 1);
  renderSuppliers();

  const result = await softDelete({
    label: 'Dodávateľ „' + snapshot.name + '" odstránený',
    deleteFn: function () { return api.del('/inventory/suppliers/' + id); },
  });

  if (result.undone) {
    suppliers.splice(idx, 0, snapshot);
    renderSuppliers();
    showToast('Vrátené', true);
  } else if (result.error) {
    // Server failed — restore
    suppliers.splice(idx, 0, snapshot);
    renderSuppliers();
  }
}

// ===== INIT / DESTROY =====
export function init(container) {
  _container = container;
  container.innerHTML = `
    <div class="sk-head">
      <div class="sk-count" id="supplierCount" aria-live="polite"></div>
      <button class="btn-add" id="addSupplierBtn">
        <svg aria-hidden="true" viewBox="0 0 14 14"><line x1="7" y1="1" x2="7" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="1" y1="7" x2="13" y2="7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        Pridať
      </button>
    </div>
    <div class="search-wrap sk-search" id="supplierSearchWrap" hidden>
      <svg aria-hidden="true" viewBox="0 0 16 16"><circle cx="6.5" cy="6.5" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="10.5" y1="10.5" x2="15" y2="15" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      <input class="search-input" id="supplierSearch" type="search" placeholder="Hľadať dodávateľa…" aria-label="Hľadať dodávateľa">
    </div>
    <div class="panel sk-bare" id="suppliersTable">
      <div class="sk-list" id="suppliersBody">
        <div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div>
      </div>
    </div>
  `;

  // Top bar events
  $('#addSupplierBtn').addEventListener('click', () => openModal());
  $('#supplierSearch').addEventListener('input', () => renderSuppliers());

  // List event delegation
  $('#suppliersTable').addEventListener('click', e => {
    const editBtn = e.target.closest('[data-edit-id]');
    if (editBtn) {
      openModal(Number(editBtn.dataset.editId));
      return;
    }
    const delBtn = e.target.closest('[data-del-id]');
    if (delBtn) {
      deleteSupplier(Number(delBtn.dataset.delId));
      return;
    }
  });

  // Escape key handler
  _escHandler = e => {
    if (e.key === 'Escape') {
      const modal = document.getElementById('supplierModal');
      if (modal && modal.classList.contains('show')) {
        modal.classList.remove('show');
        setTimeout(() => modal.remove(), 300);
        editingId = null;
      }
    }
  };
  document.addEventListener('keydown', _escHandler);

  // Load data
  loadSuppliers();

  // Cmd+K action hook
  if (window.cmdPalette && window.cmdPalette.consumeActionFlag) {
    if (window.cmdPalette.consumeActionFlag() === 'new-supplier') {
      setTimeout(function () { openModal(); }, 120);
    }
  }
}

export function destroy() {
  if (_escHandler) {
    document.removeEventListener('keydown', _escHandler);
    _escHandler = null;
  }

  const modal = document.getElementById('supplierModal');
  if (modal) modal.remove();

  suppliers = [];
  editingId = null;
  _container = null;
}
