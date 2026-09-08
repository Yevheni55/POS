// Staff page module — zoznam ľudí.
//
// Predtým mriežka kariet: každý človek 239 px, nad zoznamom 200 px filtrov
// (hľadanie, rola, "Zobraziť PIN-y"), na každej karte PIN, badge "Dochádzka
// PIN" a dve tlačidlá. Šesť ľudí = 1,4 obrazovky scrollovania kvôli štyrom
// faktom na osobu. Teraz: jeden riadok na človeka, celý riadok otvára úpravu,
// PIN a deaktivácia sú vo formulári. Výnimky (neaktívny, chýba PIN na
// dochádzku) sa hlásia len tam, kde nastali — nie na každom riadku.
import { mountEmptyState } from '../components/empty-state.js';
import { fmtCost } from '../../components/fmt.js';

let staff = [];
let editingId = null;
// "Zobraziť PIN-y" — jeden prepínač pre celý zoznam. Pri prvom zapnutí sa
// načíta _pinMap[staffId] = pin | null z /staff/pins-visible (admin/manažér).
// null = záznam pred migráciou, PIN treba nastaviť cez Upraviť.
let _showAllPins = false;
let _pinMap = null;

let _container = null;
let _escHandler = null;

const ROLE_LABEL = { admin: 'Admin', manazer: 'Manažér', cisnik: 'Čašník' };
// Od tohto počtu ľudí má hľadanie zmysel. Pod ním je celý zoznam na jednej
// obrazovke a políčko by len odsúvalo prvého človeka nižšie.
const SEARCH_FROM = 9;

function $(sel) {
  return _container.querySelector(sel);
}

// Iniciály z celého mena ("Mária Horváthová" → MH). Priezvisko je od
// zjednotenia formulára súčasťou `name`, samostatné pole neexistuje.
function getInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  const a = parts[0] ? parts[0].charAt(0) : '?';
  const b = parts[1] ? parts[1].charAt(0) : '';
  return (a + b).toUpperCase();
}

function getRoleClass(role) {
  return 'role-' + String(role || '').toLowerCase();
}

function peopleWord(n) {
  if (n === 1) return 'človek';
  if (n >= 2 && n <= 4) return 'ľudia';
  return 'ľudí';
}

function updateCount() {
  const el = $('#staffCount');
  if (!el) return;
  const off = staff.filter((e) => !e.active).length;
  el.textContent = staff.length + ' ' + peopleWord(staff.length)
    + (off ? ' · ' + off + (off === 1 ? ' neaktívny' : ' neaktívni') : '');
}

async function loadStaff() {
  const grid = $('#staffGrid');
  if (grid) showLoading(grid, 'Načítavam zamestnancov…');
  try {
    staff = await api.get('/staff');
    if (grid) hideLoading(grid);
    const searchWrap = $('#staffSearchWrap');
    if (searchWrap) searchWrap.hidden = !(staff && staff.length >= SEARCH_FROM);
    updateCount();
    if (!staff || staff.length === 0) {
      if (grid) mountEmptyState(grid, {
        icon: '👥',
        title: 'Žiadni zamestnanci',
        text: 'Tu sa zobrazujú čašníci, manažéri a admin používatelia. Pridajte prvého zamestnanca.',
        ctaLabel: 'Pridať zamestnanca',
        onCta: function () { const b = document.getElementById('addStaffBtn'); if (b) b.click(); },
      });
      return;
    }
    renderStaff();
  } catch (err) {
    if (grid) hideLoading(grid);
    renderError(grid, err.message || 'Chyba pri načítaní zamestnancov', loadStaff);
  }
}

function rowHtml(e) {
  const name = String(e.name || '').trim() || '—';
  const roleLabel = ROLE_LABEL[e.role] || e.role || '';
  const position = String(e.position || '').trim();
  // "Čašník · Čašník" — keď je pozícia to isté slovo ako rola, stačí raz.
  const sub = (position && position.toLowerCase() !== roleLabel.toLowerCase())
    ? position + ' · ' + roleLabel
    : (position || roleLabel);
  const rate = e.hourlyRate != null ? fmtCost(e.hourlyRate) + ' €/h' : '';

  // Badge "Dochádzka PIN" mal každý, takže nehovoril nič. Upozorníme len na
  // človeka, ktorému sa počíta mzda (má sadzbu) a PIN nemá — ten sa do
  // dochádzky nevie prihlásiť a jeho hodiny sa nezapisujú.
  const warn = (e.hourlyRate != null && !e.hasAttendancePin)
    ? '<span class="person-warn">nemá PIN na dochádzku</span>'
    : '';

  let pin = '';
  if (_showAllPins) {
    const p = _pinMap ? _pinMap[e.id] : undefined;
    pin = p
      ? '<span class="person-pin">PIN <b>' + escapeHtml(p) + '</b></span>'
      : '<span class="person-pin is-missing">PIN treba nastaviť (Upraviť)</span>';
  }

  return '<button type="button" class="person' + (e.active ? '' : ' is-off') + '" data-edit-id="' + e.id + '">' +
    '<span class="person-avatar ' + getRoleClass(e.role) + '" aria-hidden="true">' + getInitials(name) + '</span>' +
    '<span class="person-main">' +
      '<span class="person-name">' + escapeHtml(name) +
        (e.active ? '' : ' <span class="person-off">neaktívny</span>') +
      '</span>' +
      (sub ? '<span class="person-sub">' + escapeHtml(sub) + '</span>' : '') +
      pin +
    '</span>' +
    '<span class="person-side">' +
      (rate ? '<span class="person-rate">' + rate + '</span>' : '') +
      warn +
    '</span>' +
    '<svg class="person-chev" aria-hidden="true" viewBox="0 0 16 16"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
  '</button>';
}

function renderStaff() {
  const search = ($('#staffSearch').value || '').trim().toLowerCase();
  const filtered = staff.filter((e) => !search || String(e.name || '').toLowerCase().includes(search));
  // Aktívni hore, neaktívni dole — neaktívny človek nepatrí medzi tých,
  // ktorých manažér hľadá najčastejšie.
  const sorted = filtered.slice().sort((a, b) => (a.active === b.active ? 0 : (a.active ? -1 : 1)));

  const grid = $('#staffGrid');
  if (sorted.length === 0) {
    mountEmptyState(grid, {
      icon: '🔍',
      title: 'Žiadne výsledky',
      text: 'Pre zadané meno sa nenašiel nikto. Skús hľadanie vymazať.',
      ctaLabel: 'Vymazať hľadanie',
      onCta: function () {
        const s = document.getElementById('staffSearch');
        if (s) { s.value = ''; s.dispatchEvent(new Event('input')); }
      },
    });
    return;
  }
  grid.innerHTML = sorted.map(rowHtml).join('');
}

// Prepínač "Zobraziť PIN-y" — odkryje PIN-y na prihlásenie pri všetkých
// naraz. Pri prvom zapnutí načíta _pinMap z API. Druhý klik = skryť.
async function toggleAllPins() {
  const btn = $('#btnTogglePins');
  if (_showAllPins) {
    _showAllPins = false;
    renderStaff();
    updatePinsBtn();
    return;
  }
  if (btn) btnLoading(btn);
  try {
    if (!_pinMap) {
      const rows = await api.get('/staff/pins-visible');
      _pinMap = {};
      for (const r of rows) _pinMap[r.id] = r.pin;
    }
    _showAllPins = true;
    renderStaff();
  } catch (err) {
    showToast(err.message || 'Chyba načítania PIN-ov', 'error');
  } finally {
    if (btn) btnReset(btn);
    updatePinsBtn();
  }
}

function updatePinsBtn() {
  const btn = $('#btnTogglePins');
  if (!btn) return;
  btn.textContent = _showAllPins ? 'Skryť PIN-y' : 'Zobraziť PIN-y na prihlásenie';
  btn.classList.toggle('is-on', _showAllPins);
  btn.setAttribute('aria-pressed', _showAllPins ? 'true' : 'false');
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
  const title = emp ? 'Upraviť zamestnanca' : 'Pridať zamestnanca';

  const ov = document.createElement('div');
  ov.className = 'u-overlay';
  ov.id = 'staffModal';
  ov.innerHTML = `<div class="u-modal" style="text-align:left;max-width:520px">
    <div class="u-modal-title" style="text-align:center">${title}</div>
    <div class="u-modal-body">
      <div class="u-modal-field">
        <label for="fName">Meno<span class="required-mark" aria-hidden="true"> *</span></label>
        <input id="fName" type="text" placeholder="Meno (alebo Meno Priezvisko)" aria-required="true" data-validate="required" value="${emp && emp.name ? escapeHtml(emp.name) : ''}">
      </div>
      <input id="fSurname" type="hidden" value="">
      <div class="u-modal-field">
        <label for="fRole">Rola</label>
        <select id="fRole">
          <option value="admin"${emp && emp.role === 'admin' ? ' selected' : ''}>Admin</option>
          <option value="manazer"${emp && emp.role === 'manazer' ? ' selected' : ''}>Manažér</option>
          <option value="cisnik"${(!emp || emp.role === 'cisnik') ? ' selected' : ''}>Čašník</option>
        </select>
      </div>
      <div class="u-modal-row" style="align-items:flex-end">
        <div class="u-modal-field">
          <label for="fPin">PIN na prihlásenie<span class="required-mark" aria-hidden="true"> *</span></label>
          <input id="fPin" type="text" placeholder="${emp ? 'Vyplňte len pri zmene' : '4 číslice'}" ${emp ? '' : 'aria-required="true" data-validate="required|pin"'} maxlength="6" pattern="[0-9]{4,6}" value="">
        </div>
        <div style="flex:0 0 auto">
          <button class="btn-generate" id="btnGenPin">Generovať</button>
        </div>
      </div>
      <input id="fPhone" type="hidden" value="">
      <input id="fEmail" type="hidden" value="">
      <div class="u-modal-row">
        <div class="u-modal-field">
          <label for="fPosition">Pozícia</label>
          <input id="fPosition" type="text" maxlength="50" placeholder="napr. Čašník" value="${emp && emp.position ? escapeHtml(emp.position) : ''}">
        </div>
        <div class="u-modal-field">
          <label for="fHourlyRate">Hodinová sadzba (€/h)</label>
          <input id="fHourlyRate" type="number" step="0.01" min="0" placeholder="0,00" value="${emp && emp.hourlyRate != null ? emp.hourlyRate : ''}">
        </div>
      </div>
      <div class="u-modal-field">
        <label for="fAttendancePin">PIN na dochádzku (4–6 číslic)</label>
        <input id="fAttendancePin" type="text" pattern="\\d{4,6}" placeholder="Nastaviť / zmeniť" value="">
        <small id="fAttendancePinStatus" class="muted" style="display:block;margin-top:4px">${emp && emp.hasAttendancePin ? 'PIN je nastavený — vyplňte len ak ho chcete zmeniť' : (emp ? 'PIN nie je nastavený — bez neho sa nevie prihlásiť do dochádzky' : '')}</small>
      </div>
      <div class="u-modal-field">
        <label>Stav</label>
        <div class="u-toggle" id="fActiveToggle">
          <div class="u-toggle-track${(!emp || emp.active) ? ' on' : ''}" id="fActive"><div class="u-toggle-knob"></div></div>
          <span class="u-toggle-label">Aktívny</span>
        </div>
      </div>
    </div>
    <div class="u-modal-btns">
      <button class="u-btn u-btn-ghost" id="staffModalCancel">Zrušiť</button>
      <button class="u-btn u-btn-ice" id="staffModalSave">Uložiť</button>
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

    const nameRaw = document.getElementById('fName').value.trim();
    const surnameRaw = document.getElementById('fSurname').value.trim();
    const role = document.getElementById('fRole').value;
    const pin = document.getElementById('fPin').value.trim();
    const active = document.getElementById('fActive').classList.contains('on');
    const position = document.getElementById('fPosition').value.trim();
    const hourlyRate = document.getElementById('fHourlyRate').value.trim();
    const attendancePin = document.getElementById('fAttendancePin').value.trim();

    // The staff table has no surname/phone/email columns — fold surname into
    // the single `name` field (zod schema accepts up to 100 chars). Phone/email
    // inputs are kept in the form for now but not sent.
    const fullName = (nameRaw + (surnameRaw ? ' ' + surnameRaw : '')).trim();
    const body = { name: fullName, role, position, active };
    if (pin) body.pin = pin;
    if (hourlyRate !== '') body.hourlyRate = hourlyRate;
    if (attendancePin) body.attendancePin = attendancePin;

    const saveBtn = document.getElementById('staffModalSave');
    if (saveBtn) btnLoading(saveBtn);
    try {
      if (editingId) {
        await api.put('/staff/' + editingId, body);
        showToast('Zamestnanec upravený', true);
      } else {
        await api.post('/staff', body);
        showToast('Zamestnanec pridaný', true);
      }
      closeModal();
      // Zmenený PIN by inak ostal v cache — odkryté PIN-y sa načítajú nanovo.
      _pinMap = null;
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
    <div class="people-head">
      <div class="people-count" id="staffCount" aria-live="polite"></div>
      <button class="btn-add" id="addStaffBtn">
        <svg aria-hidden="true" viewBox="0 0 14 14"><line x1="7" y1="1" x2="7" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="1" y1="7" x2="13" y2="7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        Pridať
      </button>
    </div>
    <div class="search-wrap people-search" id="staffSearchWrap" hidden>
      <svg aria-hidden="true" viewBox="0 0 16 16"><circle cx="6.5" cy="6.5" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="10.5" y1="10.5" x2="15" y2="15" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      <input class="search-input" id="staffSearch" type="search" placeholder="Hľadať meno…" aria-label="Hľadať podľa mena">
    </div>
    <div class="people-list" id="staffGrid">
      <div class="skeleton-card"></div>
      <div class="skeleton-card"></div>
      <div class="skeleton-card"></div>
      <div class="skeleton-card"></div>
    </div>
    <div class="people-foot">
      <button type="button" class="people-pins" id="btnTogglePins" aria-pressed="false">Zobraziť PIN-y na prihlásenie</button>
    </div>
  `;

  $('#addStaffBtn').addEventListener('click', () => openStaffModal());
  $('#staffSearch').addEventListener('input', () => renderStaff());
  $('#btnTogglePins').addEventListener('click', toggleAllPins);

  // Celý riadok je tlačidlo — otvára úpravu.
  $('#staffGrid').addEventListener('click', e => {
    const row = e.target.closest('[data-edit-id]');
    if (row) openStaffModal(Number(row.dataset.editId));
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

  // Cmd+K action hook
  if (window.cmdPalette && window.cmdPalette.consumeActionFlag) {
    if (window.cmdPalette.consumeActionFlag() === 'new-staff') {
      setTimeout(function () {
        const b = document.getElementById('addStaffBtn');
        if (b) b.click();
      }, 120);
    }
  }
}

export function destroy() {
  if (_escHandler) {
    document.removeEventListener('keydown', _escHandler);
    _escHandler = null;
  }
  const modal = document.getElementById('staffModal');
  if (modal) modal.remove();

  staff = [];
  editingId = null;
  _showAllPins = false;
  _pinMap = null;
  _container = null;
}
