// Staff page module
let staff = [];
let editingId = null;
let revealedPins = new Set();

let _container = null;
let _escHandler = null;

function $(sel) {
  return _container.querySelector(sel);
}

function getInitials(name, surname) {
  return (name.charAt(0) + surname.charAt(0)).toUpperCase();
}

function getRoleClass(role) {
  return 'role-' + role.toLowerCase();
}

function formatNum(n) {
  return n.toLocaleString('sk-SK');
}

async function loadStaff() {
  const grid = $('#staffGrid');
  if (grid) showLoading(grid, 'Nacitavam zamestnancov...');
  try {
    staff = await api.get('/staff');
    if (grid) hideLoading(grid);
    if (!staff || staff.length === 0) {
      if (grid) grid.innerHTML = '<div class="empty-state"><div class="empty-state-icon">\uD83D\uDC65</div><div class="empty-state-title">Ziadni zamestnanci</div><div class="empty-state-text">Pridajte prveho zamestnanca do systemu</div><button class="btn-outline-accent" onclick="document.getElementById(\'addStaffBtn\').click()">Pridat zamestnanca</button></div>';
      return;
    }
    renderStaff();
  } catch (err) {
    if (grid) hideLoading(grid);
    renderError(grid, err.message || 'Chyba pri nacitani zamestnancov', loadStaff);
  }
}

function renderStaff() {
  const search = $('#staffSearch').value.toLowerCase();
  const roleF = $('#roleFilter').value;

  const filtered = staff.filter(e => {
    const fullName = (e.name + ' ' + e.surname).toLowerCase();
    if (search && !fullName.includes(search)) return false;
    if (roleF && e.role !== roleF) return false;
    return true;
  });

  const grid = $('#staffGrid');
  if (filtered.length === 0) {
    grid.innerHTML = '<div class="empty-state"><div class="empty-state-icon">\uD83D\uDD0D</div><div class="empty-state-title">Ziadne vysledky</div><div class="empty-state-text">Pre zadany filter sa nenasli ziadni zamestnanci</div><button class="btn-outline-accent" onclick="document.getElementById(\'staffSearch\').value=\'\';document.getElementById(\'roleFilter\').value=\'\';document.getElementById(\'staffSearch\').dispatchEvent(new Event(\'input\'))">Zrusit filter</button></div>';
    return;
  }

  grid.innerHTML = filtered.map((e, i) => {
    const pinDisplay = revealedPins.has(e.id) ? e.pin : '\u25CF\u25CF\u25CF\u25CF';
    const eyeIcon = revealedPins.has(e.id)
      ? '<svg viewBox="0 0 20 20"><path d="M2 10s3-6 8-6 8 6 8 6-3 6-8 6-8-6-8-6z" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="10" cy="10" r="2.5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="3" y1="17" x2="17" y2="3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
      : '<svg viewBox="0 0 20 20"><path d="M2 10s3-6 8-6 8 6 8 6-3 6-8 6-8-6-8-6z" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="10" cy="10" r="2.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';

    return `<div class="staff-card" style="animation-delay:${i * 50}ms">
      <div class="staff-top">
        <div class="staff-avatar ${getRoleClass(e.role)}">${getInitials(e.name, e.surname)}</div>
        <div>
          <div class="staff-name">${e.name} ${e.surname}</div>
          <div class="staff-role-wrap">
            <span class="role-badge ${getRoleClass(e.role)}">${e.role}</span>
            <span class="status-dot ${e.active ? 'active' : 'inactive'}"></span>
            <span class="status-label">${e.active ? 'Aktivny' : 'Neaktivny'}</span>
          </div>
        </div>
      </div>
      <div class="staff-pin">
        <span class="pin-label">PIN:</span>
        <span class="pin-value">${pinDisplay}</span>
        <button class="pin-toggle" data-pin-id="${e.id}" aria-label="Zobrazit/skryt PIN">${eyeIcon}</button>
      </div>
      <div class="staff-stats"><span>${formatNum(e.orders)}</span> objednavok | <span>${formatNum(e.revenue)} EUR</span> trzby</div>
      <div class="staff-actions">
        <button class="btn-edit" data-edit-id="${e.id}">Upravit</button>
        <button class="btn-toggle-status ${!e.active ? 'activate' : ''}" data-toggle-id="${e.id}">${e.active ? 'Deaktivovat' : 'Aktivovat'}</button>
      </div>
    </div>`;
  }).join('');

  // Bind card action listeners via delegation is handled in init
}

function togglePin(id) {
  if (revealedPins.has(id)) {
    revealedPins.delete(id);
  } else {
    revealedPins.add(id);
  }
  renderStaff();
}

async function toggleStatus(id) {
  const emp = staff.find(e => e.id === id);
  if (!emp) return;
  const name = emp.name + ' ' + emp.surname;
  const active = emp.active;
  showConfirm(
    active ? 'Deaktivovat zamestnanca' : 'Aktivovat zamestnanca',
    'Naozaj chcete zmenit stav zamestnanca ' + name + '?',
    async function() {
      try {
        await api.put('/staff/' + id, { active: !active });
        emp.active = !active;
        showToast(name + (emp.active ? ' aktivovany' : ' deaktivovany'));
        renderStaff();
      } catch (err) {
        showToast('Chyba: ' + err.message);
      }
    },
    { type: active ? 'danger' : 'info', confirmText: active ? 'Deaktivovat' : 'Aktivovat' }
  );
}

function generatePin() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function openStaffModal(id) {
  editingId = id || null;

  // Remove existing modal if any
  const existing = document.getElementById('staffModal');
  if (existing) existing.remove();

  const emp = editingId ? staff.find(e => e.id === editingId) : null;
  const title = emp ? 'Upravit zamestnanca' : 'Pridat zamestnanca';

  const ov = document.createElement('div');
  ov.className = 'u-overlay';
  ov.id = 'staffModal';
  ov.innerHTML = `<div class="u-modal" style="text-align:left;max-width:520px">
    <div class="u-modal-title" style="text-align:center">${title}</div>
    <div class="u-modal-body">
      <div class="u-modal-row">
        <div class="u-modal-field">
          <label for="fName">Meno<span class="required-mark" aria-hidden="true"> *</span></label>
          <input id="fName" type="text" placeholder="Meno" aria-required="true" data-validate="required" value="${emp ? emp.name : ''}">
        </div>
        <div class="u-modal-field">
          <label for="fSurname">Priezvisko<span class="required-mark" aria-hidden="true"> *</span></label>
          <input id="fSurname" type="text" placeholder="Priezvisko" aria-required="true" data-validate="required" value="${emp ? emp.surname : ''}">
        </div>
      </div>
      <div class="u-modal-field">
        <label for="fRole">Rola</label>
        <select id="fRole">
          <option value="Admin"${emp && emp.role === 'Admin' ? ' selected' : ''}>Admin</option>
          <option value="Manazer"${emp && emp.role === 'Manazer' ? ' selected' : ''}>Manazer</option>
          <option value="Cisnik"${(!emp || emp.role === 'Cisnik') ? ' selected' : ''}>Cisnik</option>
        </select>
      </div>
      <div class="u-modal-row" style="align-items:flex-end">
        <div class="u-modal-field">
          <label for="fPin">PIN kod<span class="required-mark" aria-hidden="true"> *</span></label>
          <input id="fPin" type="text" placeholder="4 cislice" aria-required="true" data-validate="required|pin" maxlength="4" pattern="[0-9]{4}" value="${emp ? emp.pin : ''}">
        </div>
        <div style="flex:0 0 auto">
          <button class="btn-generate" id="btnGenPin">Generovat</button>
        </div>
      </div>
      <div class="u-modal-row">
        <div class="u-modal-field">
          <label for="fPhone">Telefon</label>
          <input id="fPhone" type="text" placeholder="+421..." value="${emp ? emp.phone : ''}">
        </div>
        <div class="u-modal-field">
          <label for="fEmail">Email</label>
          <input id="fEmail" type="text" placeholder="email@example.com" value="${emp ? emp.email : ''}">
        </div>
      </div>
      <div class="u-modal-row">
        <div class="u-modal-field">
          <label for="fPosition">Pozicia</label>
          <input id="fPosition" type="text" maxlength="50" placeholder="napr. Casnik" value="${emp && emp.position ? emp.position : ''}">
        </div>
        <div class="u-modal-field">
          <label for="fHourlyRate">Hodinova sadza (EUR)</label>
          <input id="fHourlyRate" type="number" step="0.01" min="0" placeholder="0.00" value="${emp && emp.hourlyRate != null ? emp.hourlyRate : ''}">
        </div>
      </div>
      <div class="u-modal-field">
        <label for="fAttendancePin">Dochadzka PIN (4-6 cifier)</label>
        <input id="fAttendancePin" type="text" pattern="\\d{4,6}" placeholder="Nastavit / zmenit" value="">
        <small id="fAttendancePinStatus" class="muted" style="display:block;margin-top:4px">${emp && emp.hasAttendancePin ? 'PIN je nastaveny - vyplnte len ak chcete zmenit' : (emp ? 'PIN nie je nastaveny' : '')}</small>
      </div>
      <div class="u-modal-field">
        <label>Stav</label>
        <div class="u-toggle" id="fActiveToggle">
          <div class="u-toggle-track${(!emp || emp.active) ? ' on' : ''}" id="fActive"><div class="u-toggle-knob"></div></div>
          <span class="u-toggle-label">Aktivny</span>
        </div>
      </div>
    </div>
    <div class="u-modal-btns">
      <button class="u-btn u-btn-ghost" id="staffModalCancel">Zrusit</button>
      <button class="u-btn u-btn-ice" id="staffModalSave">Ulozit</button>
    </div>
  </div>`;

  document.body.appendChild(ov);
  requestAnimationFrame(() => ov.classList.add('show'));

  // Inline validation listeners (centralized)
  wireValidation(ov);

  // Bind modal events
  const closeModal = () => {
    ov.classList.remove('show');
    setTimeout(() => ov.remove(), 300);
    editingId = null;
  };

  document.getElementById('staffModalCancel').onclick = closeModal;
  ov.addEventListener('click', e => { if (e.target === ov) closeModal(); });

  document.getElementById('btnGenPin').onclick = () => {
    document.getElementById('fPin').value = generatePin();
  };

  document.getElementById('fActiveToggle').onclick = () => {
    document.getElementById('fActive').classList.toggle('on');
  };

  document.getElementById('staffModalSave').onclick = async () => {
    if (!validateForm(ov)) return;

    const name = document.getElementById('fName').value.trim();
    const surname = document.getElementById('fSurname').value.trim();
    const role = document.getElementById('fRole').value;
    const pin = document.getElementById('fPin').value.trim();
    const phone = document.getElementById('fPhone').value.trim();
    const email = document.getElementById('fEmail').value.trim();
    const active = document.getElementById('fActive').classList.contains('on');
    const position = document.getElementById('fPosition').value.trim();
    const hourlyRate = document.getElementById('fHourlyRate').value.trim();
    const attendancePin = document.getElementById('fAttendancePin').value.trim();

    const body = { name, surname, role, pin, phone, email, active, position };
    if (hourlyRate !== '') body.hourlyRate = hourlyRate;
    if (attendancePin) body.attendancePin = attendancePin;

    const saveBtn = document.getElementById('staffModalSave');
    if (saveBtn) btnLoading(saveBtn);
    try {
      if (editingId) {
        await api.put('/staff/' + editingId, body);
        showToast('Zamestnanec upraveny', true);
      } else {
        await api.post('/staff', body);
        showToast('Zamestnanec pridany', true);
      }
      closeModal();
      await loadStaff();
    } catch (err) {
      showToast(err.message || 'Chyba ukladania zamestnanca', 'error');
    } finally {
      if (saveBtn) btnReset(saveBtn);
    }
  };
}

export function init(container) {
  _container = container;
  container.innerHTML = `
    <div class="top-bar">
      <button class="btn-add" id="addStaffBtn">
        <svg aria-hidden="true" viewBox="0 0 14 14"><line x1="7" y1="1" x2="7" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="1" y1="7" x2="13" y2="7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        Pridat zamestnanca
      </button>
      <div class="search-wrap">
        <svg aria-hidden="true" viewBox="0 0 16 16"><circle cx="6.5" cy="6.5" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="10.5" y1="10.5" x2="15" y2="15" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        <input class="search-input" id="staffSearch" type="text" placeholder="Hladat podla mena...">
      </div>
      <select class="filter-select" id="roleFilter">
        <option value="">Vsetky role</option>
        <option value="Admin">Admin</option>
        <option value="Manazer">Manazer</option>
        <option value="Cisnik">Cisnik</option>
      </select>
    </div>
    <div class="staff-grid" id="staffGrid">
      <div class="skeleton-card"></div>
      <div class="skeleton-card"></div>
      <div class="skeleton-card"></div>
      <div class="skeleton-card"></div>
    </div>
  `;

  // Bind top bar events
  $('#addStaffBtn').addEventListener('click', () => openStaffModal());
  $('#staffSearch').addEventListener('input', () => renderStaff());
  $('#roleFilter').addEventListener('change', () => renderStaff());

  // Delegate click events on the staff grid
  $('#staffGrid').addEventListener('click', e => {
    const pinBtn = e.target.closest('[data-pin-id]');
    if (pinBtn) {
      togglePin(Number(pinBtn.dataset.pinId));
      return;
    }
    const editBtn = e.target.closest('[data-edit-id]');
    if (editBtn) {
      openStaffModal(Number(editBtn.dataset.editId));
      return;
    }
    const toggleBtn = e.target.closest('[data-toggle-id]');
    if (toggleBtn) {
      toggleStatus(Number(toggleBtn.dataset.toggleId));
      return;
    }
  });

  // Escape key handler
  _escHandler = e => {
    if (e.key === 'Escape') {
      const modal = document.getElementById('staffModal');
      if (modal && modal.classList.contains('show')) {
        modal.classList.remove('show');
        setTimeout(() => modal.remove(), 300);
        editingId = null;
      }
    }
  };
  document.addEventListener('keydown', _escHandler);

  // Load data
  loadStaff();
}

export function destroy() {
  // Remove escape handler
  if (_escHandler) {
    document.removeEventListener('keydown', _escHandler);
    _escHandler = null;
  }

  // Remove modal if open
  const modal = document.getElementById('staffModal');
  if (modal) modal.remove();

  // Reset state
  staff = [];
  editingId = null;
  revealedPins = new Set();
  _container = null;
}
