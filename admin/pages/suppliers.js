// Suppliers page module
let suppliers = [];
let editingId = null;
let _container = null;
let _escHandler = null;

function $(sel) {
  return _container.querySelector(sel);
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ===== LOAD =====
async function loadSuppliers() {
  const tbody = $('#suppliersBody');
  if (tbody) showLoading(tbody.closest('.panel') || tbody, 'Nacitavam dodavatelov...');
  try {
    suppliers = await api.get('/inventory/suppliers');
    if (tbody) hideLoading(tbody.closest('.panel') || tbody);
    renderSuppliers();
  } catch (err) {
    if (tbody) hideLoading(tbody.closest('.panel') || tbody);
    const panel = tbody ? tbody.closest('.panel') : null;
    if (panel) {
      renderError(panel, err.message || 'Chyba pri nacitani dodavatelov', loadSuppliers);
    }
  }
}

// ===== RENDER =====
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

  if (!suppliers || suppliers.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="td-empty">Ziadni dodavatelia. Pridajte prveho dodavatela.</td></tr>';
    return;
  }

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="td-empty">Ziadne vysledky pre zadany filter</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(s =>
    `<tr>
      <td class="td-name">${escapeHtml(s.name)}</td>
      <td>${escapeHtml(s.contactPerson || '')}</td>
      <td>${escapeHtml(s.phone || '')}</td>
      <td>${escapeHtml(s.email || '')}</td>
      <td><span class="badge ${s.active ? 'paid' : 'open'}">${s.active ? 'Aktivny' : 'Neaktivny'}</span></td>
      <td>
        <div class="prod-actions">
          <button class="act-btn" data-edit-id="${s.id}" title="Upravit">
            <svg viewBox="0 0 16 16"><path d="M12.1 1.3a1.5 1.5 0 012.1 2.1L5.8 11.8l-3.3.8.8-3.3z"/></svg>
          </button>
          <button class="act-btn del" data-del-id="${s.id}" title="Odstranit">
            <svg viewBox="0 0 16 16"><path d="M5 2V1h6v1h4v2H1V2h4zm0 4v7h6V6H5zm-3 9h12V5H2v10z"/></svg>
          </button>
        </div>
      </td>
    </tr>`
  ).join('');
}

// ===== MODAL =====
function openModal(id) {
  editingId = id || null;

  const existing = document.getElementById('supplierModal');
  if (existing) existing.remove();

  const s = editingId ? suppliers.find(x => x.id === editingId) : null;
  const title = s ? 'Upravit dodavatela' : 'Pridat dodavatela';

  const ov = document.createElement('div');
  ov.className = 'u-overlay';
  ov.id = 'supplierModal';
  ov.innerHTML = `<div class="u-modal" style="text-align:left;max-width:520px">
    <div class="u-modal-title" style="text-align:center">${title}</div>
    <div class="u-modal-body">
      <div class="u-modal-field">
        <label for="fSupName">Nazov<span class="required-mark" aria-hidden="true"> *</span></label>
        <input id="fSupName" type="text" class="form-input" placeholder="Nazov dodavatela" aria-required="true" data-validate="required" value="${s ? escapeHtml(s.name) : ''}">
      </div>
      <div class="u-modal-field">
        <label for="fSupContact">Kontaktna osoba</label>
        <input id="fSupContact" type="text" class="form-input" placeholder="Meno a priezvisko" value="${s ? escapeHtml(s.contactPerson || '') : ''}">
      </div>
      <div class="u-modal-row">
        <div class="u-modal-field">
          <label for="fSupPhone">Telefon</label>
          <input id="fSupPhone" type="text" class="form-input" placeholder="+421..." value="${s ? escapeHtml(s.phone || '') : ''}">
        </div>
        <div class="u-modal-field">
          <label for="fSupEmail">Email</label>
          <input id="fSupEmail" type="text" class="form-input" placeholder="email@example.com" value="${s ? escapeHtml(s.email || '') : ''}">
        </div>
      </div>
      <div class="u-modal-field">
        <label for="fSupNotes">Poznamky</label>
        <textarea id="fSupNotes" class="form-input" rows="3" placeholder="Dodacie podmienky, poznamky...">${s ? escapeHtml(s.notes || '') : ''}</textarea>
      </div>
    </div>
    <div class="u-modal-btns">
      <button class="u-btn u-btn-ghost" id="supplierModalCancel">Zrusit</button>
      <button class="u-btn u-btn-ice" id="supplierModalSave">Ulozit</button>
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
        showToast('Dodavatel upraveny', true);
      } else {
        await api.post('/inventory/suppliers', { name, contactPerson, phone, email, notes });
        showToast('Dodavatel pridany', true);
      }
      closeModal();
      await loadSuppliers();
    } catch (err) {
      showToast(err.message || 'Chyba ukladania dodavatela', 'error');
    } finally {
      if (saveBtn) btnReset(saveBtn);
    }
  };

  setTimeout(() => document.getElementById('fSupName').focus(), 100);
}

// ===== DELETE =====
function deleteSupplier(id) {
  const s = suppliers.find(x => x.id === id);
  if (!s) return;
  showConfirm(
    'Odstranit dodavatela',
    'Naozaj chcete odstranit dodavatela ' + s.name + '?',
    async function () {
      try {
        await api.del('/inventory/suppliers/' + id);
        suppliers = suppliers.filter(x => x.id !== id);
        renderSuppliers();
        showToast('Dodavatel odstraneny', true);
      } catch (err) {
        showToast('Chyba: ' + err.message);
      }
    },
    { type: 'danger', confirmText: 'Odstranit' }
  );
}

// ===== INIT / DESTROY =====
export function init(container) {
  _container = container;
  container.innerHTML = `
    <div class="top-bar">
      <button class="btn-add" id="addSupplierBtn">
        <svg aria-hidden="true" viewBox="0 0 14 14"><line x1="7" y1="1" x2="7" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="1" y1="7" x2="13" y2="7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        Pridat dodavatela
      </button>
      <div class="search-wrap">
        <svg aria-hidden="true" viewBox="0 0 16 16"><circle cx="6.5" cy="6.5" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="10.5" y1="10.5" x2="15" y2="15" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        <input class="search-input" id="supplierSearch" type="text" placeholder="Hladat dodavatela...">
      </div>
    </div>
    <div class="panel">
      <div class="table-scroll-wrap">
      <table class="data-table" id="suppliersTable">
        <thead>
          <tr>
            <th>Názov</th>
            <th>Kontaktná osoba</th>
            <th>Telefón</th>
            <th>E-mail</th>
            <th>Stav</th>
            <th>Akcie</th>
          </tr>
        </thead>
        <tbody id="suppliersBody">
          <tr><td colspan="6" class="td-empty">Načítavam…</td></tr>
        </tbody>
      </table>
      </div>
    </div>
  `;

  // Top bar events
  $('#addSupplierBtn').addEventListener('click', () => openModal());
  $('#supplierSearch').addEventListener('input', () => renderSuppliers());

  // Table event delegation
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
