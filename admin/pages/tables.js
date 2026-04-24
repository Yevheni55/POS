// Tables page module
let ZONES = [];
let TABLES = [];
let activeZone = 'all';
let selectedTableId = null;
let gridSnap = true;
let dragId = null;
let dragOffX = 0;
let dragOffY = 0;
let didDrag = false;
let saveTimer = null;

let _container = null;

// Store references for cleanup
const _docListeners = [];

function addDocListener(event, handler, opts) {
  document.addEventListener(event, handler, opts);
  _docListeners.push({ event, handler, opts });
}

function $(sel) {
  return _container.querySelector(sel);
}

// ===== PERSISTENCE (API) =====
async function loadTables() {
  const canvas = $('#floorCanvas');
  if (canvas) showLoading(canvas, 'Nacitavam stoly...');
  try {
    const tables = await api.get('/tables');
    if (canvas) hideLoading(canvas);
    TABLES = tables;
    const zoneSet = new Map();
    TABLES.forEach(t => {
      if (t.zone && !zoneSet.has(t.zone)) {
        zoneSet.set(t.zone, { id: t.zone, label: t.zone.charAt(0).toUpperCase() + t.zone.slice(1) });
      }
    });
    if (zoneSet.size > 0) {
      ZONES = Array.from(zoneSet.values());
    } else {
      ZONES = [{ id: 'interior', label: 'Interier' }, { id: 'bar', label: 'Bar' }, { id: 'terasa', label: 'Terasa' }];
    }
    renderZoneBtns();
    populateZoneSelects();
    renderFloor();
    if (!TABLES || TABLES.length === 0) {
      if (canvas) canvas.innerHTML = '<div class="empty-state"><div class="empty-state-icon">\uD83E\uDE91</div><div class="empty-state-title">Ziadne stoly</div><div class="empty-state-text">Pridajte prvy stol do planocky</div><button class="btn-outline-accent" onclick="document.getElementById(\'addTableBtn\').click()">Pridat stol</button></div>';
    }
  } catch (err) {
    if (canvas) hideLoading(canvas);
    renderError(canvas, err.message || 'Chyba pri nacitani stolov', loadTables);
  }
}

async function savePositions() {
  try {
    for (const t of TABLES) {
      await api.put('/tables/' + t.id, { x: t.x, y: t.y });
    }
    showToast('Pozicie ulozene', true);
  } catch (err) {
    showToast(err.message || 'Chyba pri ukladani pozicii', 'error');
  }
}

function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(savePositions, 500);
}

// ===== ZONES =====
function renderZoneBtns() {
  const allZones = [{ id: 'all', label: 'Vsetky' }, ...ZONES];
  const el = $('#zoneBtns');
  if (el) {
    el.innerHTML = allZones.map(z =>
      `<button class="zone-btn ${z.id === activeZone ? 'active' : ''}" data-zone="${z.id}">${z.label}</button>`
    ).join('');
  }
}

function setZone(id) {
  activeZone = id;
  renderZoneBtns();
  renderFloor();
}

function populateZoneSelects() {
  const opts = ZONES.map(z => `<option value="${z.id}">${z.label}</option>`).join('');
  const pz = $('#pZone');
  const atz = $('#atZone');
  if (pz) pz.innerHTML = opts;
  if (atz) atz.innerHTML = opts;
}

// ===== GRID =====
function toggleGrid() {
  gridSnap = !gridSnap;
  const gc = $('#gridCheck');
  const fc = $('#floorCanvas');
  if (gc) gc.classList.toggle('on', gridSnap);
  if (fc) fc.classList.toggle('grid-on', gridSnap);
}

// ===== FLOOR RENDERING =====
function renderFloor() {
  const canvas = $('#floorCanvas');
  if (!canvas) return;
  const filtered = activeZone === 'all' ? TABLES : TABLES.filter(t => t.zone === activeZone);
  const zoneLabels = { interior: 'Interier', bar: 'Bar', terasa: 'Terasa' };
  ZONES.forEach(z => { if (!zoneLabels[z.id]) zoneLabels[z.id] = z.label; });

  canvas.innerHTML = filtered.map(t => {
    const isSel = t.id === selectedTableId;
    return `<div class="table-chip ${t.shape} z-${t.zone} ${isSel ? 'selected' : ''}"
      data-id="${t.id}" style="left:${t.x}px;top:${t.y}px">
      <div class="chip-name">${t.name}</div>
      <div class="chip-seats">${t.seats} miest</div>
      <div class="chip-zone">${zoneLabels[t.zone] || t.zone}</div>
    </div>`;
  }).join('');
}

// ===== TABLE SELECTION =====
function selectTable(e, id) {
  if (e._fromDrag) return;
  selectedTableId = id;
  renderFloor();
  openProps();
}

function openProps() {
  const t = TABLES.find(x => x.id === selectedTableId);
  if (!t) return;
  const pName = $('#pName');
  const pSeats = $('#pSeats');
  const pZone = $('#pZone');
  const pShape = $('#pShape');
  if (pName) pName.value = t.name;
  if (pSeats) pSeats.value = t.seats;
  populateZoneSelects();
  if (pZone) pZone.value = t.zone;
  if (pShape) pShape.value = t.shape;
  const panel = $('#propsPanel');
  const backdrop = $('#propsBackdrop');
  if (panel) panel.classList.add('open');
  if (backdrop) backdrop.classList.add('show');
}

function closeProps() {
  const panel = $('#propsPanel');
  const backdrop = $('#propsBackdrop');
  if (panel) panel.classList.remove('open');
  if (backdrop) backdrop.classList.remove('show');
  selectedTableId = null;
  renderFloor();
}

async function updateTableProp(prop, val) {
  const t = TABLES.find(x => x.id === selectedTableId);
  if (!t) return;
  try {
    await api.put('/tables/' + selectedTableId, { [prop]: val });
    const updated = { ...t, [prop]: val };
    const idx = TABLES.findIndex(x => x.id === selectedTableId);
    TABLES[idx] = updated;
    renderFloor();
  } catch (err) {
    showToast('Chyba: ' + err.message);
  }
}

// ===== DRAG (mouse) =====
function startDrag(e, id) {
  if (e.button !== 0) return;
  e.preventDefault();
  dragId = id;
  didDrag = false;
  const el = e.currentTarget;
  const rect = el.getBoundingClientRect();
  dragOffX = e.clientX - rect.left;
  dragOffY = e.clientY - rect.top;
  el.classList.add('dragging');
  document.addEventListener('mousemove', onDrag);
  document.addEventListener('mouseup', endDrag);
}

function onDrag(e) {
  if (!dragId) return;
  didDrag = true;
  const canvas = $('#floorCanvas');
  if (!canvas) return;
  const cr = canvas.getBoundingClientRect();
  let nx = e.clientX - cr.left - dragOffX + canvas.scrollLeft;
  let ny = e.clientY - cr.top - dragOffY + canvas.scrollTop;
  if (gridSnap) { nx = Math.round(nx / 20) * 20; ny = Math.round(ny / 20) * 20; }
  else { nx = Math.round(nx); ny = Math.round(ny); }
  nx = Math.max(0, nx);
  ny = Math.max(0, ny);
  const idx = TABLES.findIndex(x => x.id === dragId);
  if (idx >= 0) TABLES[idx] = { ...TABLES[idx], x: nx, y: ny };
  const el = _container.querySelector(`[data-id="${dragId}"]`);
  if (el) { el.style.left = nx + 'px'; el.style.top = ny + 'px'; }
}

function endDrag(e) {
  if (dragId) {
    const el = _container.querySelector(`[data-id="${dragId}"]`);
    if (el) el.classList.remove('dragging');
    if (didDrag) {
      saveState();
      if (e) { e._fromDrag = true; }
      selectedTableId = dragId;
      renderFloor();
      openProps();
    }
    dragId = null;
  }
  document.removeEventListener('mousemove', onDrag);
  document.removeEventListener('mouseup', endDrag);
}

// ===== DRAG (touch) =====
function onTouchStart(e) {
  const chip = e.target.closest('.table-chip');
  if (!chip) return;
  e.preventDefault();
  // dataset.id is a string; coerce so later === comparisons against TABLES[*].id (number) match
  const id = Number(chip.dataset.id);
  dragId = id;
  didDrag = false;
  const rect = chip.getBoundingClientRect();
  const touch = e.touches[0];
  dragOffX = touch.clientX - rect.left;
  dragOffY = touch.clientY - rect.top;
  chip.classList.add('dragging');
}

function onTouchMove(e) {
  if (!dragId) return;
  e.preventDefault();
  didDrag = true;
  const touch = e.touches[0];
  const canvas = $('#floorCanvas');
  if (!canvas) return;
  const cr = canvas.getBoundingClientRect();
  let nx = touch.clientX - cr.left - dragOffX + canvas.scrollLeft;
  let ny = touch.clientY - cr.top - dragOffY + canvas.scrollTop;
  if (gridSnap) { nx = Math.round(nx / 20) * 20; ny = Math.round(ny / 20) * 20; }
  else { nx = Math.round(nx); ny = Math.round(ny); }
  nx = Math.max(0, nx);
  ny = Math.max(0, ny);
  const idx = TABLES.findIndex(x => x.id === dragId);
  if (idx >= 0) TABLES[idx] = { ...TABLES[idx], x: nx, y: ny };
  const el = _container.querySelector(`[data-id="${dragId}"]`);
  if (el) { el.style.left = nx + 'px'; el.style.top = ny + 'px'; }
}

function onTouchEnd() {
  if (dragId) {
    const el = _container.querySelector(`[data-id="${dragId}"]`);
    if (el) el.classList.remove('dragging');
    if (didDrag) saveState();
    dragId = null;
  }
}

// ===== DELETE TABLE =====
function deleteTable() {
  const t = TABLES.find(x => x.id === selectedTableId);
  if (!t) return;
  showConfirm('Zmazat', 'Tato akcia sa neda vratit.', async function () {
    try {
      await api.del('/tables/' + selectedTableId);
      TABLES = TABLES.filter(t => t.id !== selectedTableId);
      closeProps();
      renderFloor();
      showToast('Stol odstraneny', true);
    } catch (err) {
      showToast('Chyba: ' + err.message);
    }
  }, { type: 'danger' });
}

// ===== ADD TABLE MODAL =====
function openAddTable() {
  populateZoneSelects();
  const atName = $('#atName');
  const atSeats = $('#atSeats');
  const atZone = $('#atZone');
  const atShape = $('#atShape');
  if (atName) atName.value = 'Stol ' + (TABLES.length + 1);
  if (atSeats) atSeats.value = '4';
  if (atZone) atZone.value = ZONES[0]?.id || 'interior';
  if (atShape) atShape.value = 'rect';
  const modal = $('#addTableModal');
  if (modal) modal.classList.add('show');
  setTimeout(() => { if (atName) atName.focus(); }, 100);
}

function closeAddTable() {
  const modal = $('#addTableModal');
  if (modal) modal.classList.remove('show');
}

async function saveNewTable() {
  var addModal = $('#addTableModal');
  if (addModal && !validateForm(addModal)) return;

  const nameEl = $('#atName');
  const seatsEl = $('#atSeats');
  const zoneEl = $('#atZone');
  const shapeEl = $('#atShape');
  const name = nameEl ? nameEl.value.trim() : '';
  const seats = seatsEl ? parseInt(seatsEl.value) || 4 : 4;
  const zone = zoneEl ? zoneEl.value : 'interior';
  const shape = shapeEl ? shapeEl.value : 'rect';
  if (!name) { showToast('Zadajte nazov stola'); return; }
  const canvas = $('#floorCanvas');
  const cx = canvas ? Math.round((canvas.scrollLeft + canvas.clientWidth / 2 - 40) / 20) * 20 : 100;
  const cy = canvas ? Math.round((canvas.scrollTop + canvas.clientHeight / 2 - 40) / 20) * 20 : 100;
  const btn = $('#saveAddTable');
  if (btn) btnLoading(btn);
  try {
    const created = await api.post('/tables', { name, seats, zone, shape, x: cx, y: cy });
    const id = created.id || ('t_' + Date.now());
    TABLES = [...TABLES, { id, name, seats, zone, shape, x: cx, y: cy }];
    closeAddTable();
    renderFloor();
    selectedTableId = id;
    openProps();
    showToast('Stol pridany', true);
  } catch (err) {
    showToast(err.message || 'Chyba pridania stola', 'error');
  } finally {
    if (btn) btnReset(btn);
  }
}

// ===== ADD ZONE MODAL =====
function openAddZone() {
  const azName = $('#azName');
  if (azName) azName.value = '';
  const modal = $('#addZoneModal');
  if (modal) modal.classList.add('show');
  setTimeout(() => { if (azName) azName.focus(); }, 100);
}

function closeAddZone() {
  const modal = $('#addZoneModal');
  if (modal) modal.classList.remove('show');
}

function saveNewZone() {
  var zoneModal = $('#addZoneModal');
  if (zoneModal && !validateForm(zoneModal)) return;

  const azName = $('#azName');
  const name = azName ? azName.value.trim() : '';
  if (!name) { showToast('Zadajte nazov zony'); return; }
  const id = name.toLowerCase().replace(/[^a-z0-9]/g, '_');
  if (ZONES.find(z => z.id === id)) { showToast('Zona uz existuje'); return; }
  ZONES = [...ZONES, { id, label: name }];
  closeAddZone();
  saveState();
  renderZoneBtns();
  populateZoneSelects();
  showToast('Zona pridana', true);
}

// ===== KEYBOARD =====
function onKeydown(e) {
  const dynModal = document.getElementById('dynModal');
  if (dynModal && dynModal.classList.contains('show')) {
    if (e.key === 'Escape') { const cb = document.getElementById('dynCancel'); if (cb) cb.click(); }
    return;
  }
  const addTableModal = $('#addTableModal');
  if (addTableModal && addTableModal.classList.contains('show')) {
    if (e.key === 'Escape') closeAddTable();
    return;
  }
  const addZoneModal = $('#addZoneModal');
  if (addZoneModal && addZoneModal.classList.contains('show')) {
    if (e.key === 'Escape') closeAddZone();
    return;
  }
  if (e.key === 'Escape' && selectedTableId) closeProps();
  if (e.key === 'Delete' && selectedTableId) deleteTable();
}

// ===== INIT / DESTROY =====
export function init(container) {
  _container = container;
  container.className = 'content admin-page-fill-col';

  container.innerHTML = `
    <div class="toolbar">
      <div class="toolbar-left">
        <div class="zone-btns" id="zoneBtns">
          <button class="zone-btn active" data-zone="all">Vsetky</button>
          <button class="zone-btn" data-zone="interior">Interier</button>
          <button class="zone-btn" data-zone="bar">Bar</button>
          <button class="zone-btn" data-zone="terasa">Terasa</button>
        </div>
      </div>
      <div class="toolbar-right">
        <label class="grid-toggle" id="gridToggle">
          <div class="grid-check on" id="gridCheck"><svg aria-hidden="true" viewBox="0 0 12 12"><path d="M2 6l3 3 5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
          Mriezka
        </label>
        <button class="toolbar-btn" id="addZoneBtn">
          <svg aria-hidden="true" viewBox="0 0 16 16"><path d="M8 2v12M2 8h12" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>
          Pridat zonu
        </button>
        <button class="toolbar-btn primary" id="addTableBtn">
          <svg aria-hidden="true" viewBox="0 0 16 16"><path d="M8 2v12M2 8h12" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>
          Pridat stol
        </button>
      </div>
    </div>
    <div class="floor-wrap">
      <div class="floor-canvas grid-on" id="floorCanvas"></div>
      <div class="props-backdrop" id="propsBackdrop"></div>
      <div class="props-panel" id="propsPanel">
        <div class="props-header">
          <div class="props-title">Vlastnosti stola</div>
          <button class="props-close" id="propsClose" aria-label="Zavriet">&times;</button>
        </div>
        <div class="props-body">
          <div class="form-group">
            <label class="form-label" for="pName">Nazov<span class="required-mark" aria-hidden="true"> *</span></label>
            <input class="form-input" id="pName" type="text" data-validate="required">
          </div>
          <div class="form-group">
            <label class="form-label" for="pSeats">Pocet miest</label>
            <input class="form-input" id="pSeats" type="number" min="1" max="20" data-validate="number">
          </div>
          <div class="form-group">
            <label class="form-label" for="pZone">Zona</label>
            <select class="form-select" id="pZone"></select>
          </div>
          <div class="form-group">
            <label class="form-label" for="pShape">Tvar</label>
            <select class="form-select" id="pShape">
              <option value="rect">Obdlznik</option>
              <option value="round">Kruh</option>
              <option value="large">Velky</option>
            </select>
          </div>
        </div>
        <div class="props-actions">
          <button class="btn btn-danger" id="deleteTableBtn">Odstranit stol</button>
          <button class="btn btn-secondary" id="closePanelBtn">Zavriet</button>
        </div>
      </div>
    </div>

    <!-- Add Table Modal -->
    <div class="u-overlay" id="addTableModal">
      <div class="u-modal u-modal-left">
        <div class="u-modal-title text-center">Pridat stol</div>
        <div class="u-modal-body">
          <div class="u-modal-field">
            <label for="atName">Nazov<span class="required-mark" aria-hidden="true"> *</span></label>
            <input id="atName" type="text" placeholder="napr. Stol 9" aria-required="true" data-validate="required">
          </div>
          <div class="u-modal-field">
            <label for="atSeats">Pocet miest</label>
            <input id="atSeats" type="number" min="1" max="20" value="4" data-validate="number">
          </div>
          <div class="u-modal-field">
            <label for="atZone">Zona</label>
            <select id="atZone"></select>
          </div>
          <div class="u-modal-field">
            <label for="atShape">Tvar</label>
            <select id="atShape">
              <option value="rect">Obdlznik</option>
              <option value="round">Kruh</option>
              <option value="large">Velky</option>
            </select>
          </div>
        </div>
        <div class="u-modal-btns">
          <button class="u-btn u-btn-ghost" id="cancelAddTable">Zrusit</button>
          <button class="u-btn u-btn-ice" id="saveAddTable">Ulozit</button>
        </div>
      </div>
    </div>

    <!-- Add Zone Modal -->
    <div class="u-overlay" id="addZoneModal">
      <div class="u-modal u-modal-left">
        <div class="u-modal-title text-center">Pridat zonu</div>
        <div class="u-modal-body">
          <div class="u-modal-field">
            <label for="azName">Nazov zony<span class="required-mark" aria-hidden="true"> *</span></label>
            <input id="azName" type="text" placeholder="napr. VIP" data-validate="required">
          </div>
        </div>
        <div class="u-modal-btns">
          <button class="u-btn u-btn-ghost" id="cancelAddZone">Zrusit</button>
          <button class="u-btn u-btn-ice" id="saveAddZone">Ulozit</button>
        </div>
      </div>
    </div>
  `;

  // Wire up event listeners via delegation and direct binding
  $('#zoneBtns').addEventListener('click', function (e) {
    const btn = e.target.closest('.zone-btn');
    if (btn) setZone(btn.dataset.zone);
  });

  $('#gridToggle').addEventListener('click', toggleGrid);
  $('#addTableBtn').addEventListener('click', openAddTable);
  $('#addZoneBtn').addEventListener('click', openAddZone);
  $('#propsClose').addEventListener('click', closeProps);
  $('#propsBackdrop').addEventListener('click', closeProps);
  $('#deleteTableBtn').addEventListener('click', deleteTable);
  $('#closePanelBtn').addEventListener('click', closeProps);

  // Props field changes
  $('#pName').addEventListener('change', function () { updateTableProp('name', this.value); });
  $('#pSeats').addEventListener('change', function () { updateTableProp('seats', parseInt(this.value) || 1); });
  $('#pZone').addEventListener('change', function () { updateTableProp('zone', this.value); });
  $('#pShape').addEventListener('change', function () { updateTableProp('shape', this.value); });

  // Modal buttons
  $('#cancelAddTable').addEventListener('click', closeAddTable);
  $('#saveAddTable').addEventListener('click', saveNewTable);
  $('#cancelAddZone').addEventListener('click', closeAddZone);
  $('#saveAddZone').addEventListener('click', saveNewZone);

  // Modal overlay click to close
  $('#addTableModal').addEventListener('click', function (e) { if (e.target === this) closeAddTable(); });
  $('#addZoneModal').addEventListener('click', function (e) { if (e.target === this) closeAddZone(); });

  // Inline validation listeners
  container.querySelectorAll('[data-validate]').forEach(function(input) {
    input.addEventListener('blur', function() {
      var rules = this.getAttribute('data-validate').split('|');
      var self = this;
      rules.forEach(function(rule) { validateField(self, rule); });
    });
    input.addEventListener('input', function() { clearFieldError(this); });
  });

  // Floor canvas: mousedown for drag, click for select/deselect
  // NOTE: dataset.id is a string, but TABLES[*].id is a number from the DB.
  // Coerce here so findIndex/===/data-id lookups all work.
  $('#floorCanvas').addEventListener('mousedown', function (e) {
    const chip = e.target.closest('.table-chip');
    if (chip) startDrag(e, Number(chip.dataset.id));
  });
  $('#floorCanvas').addEventListener('click', function (e) {
    const chip = e.target.closest('.table-chip');
    if (chip) {
      selectTable(e, Number(chip.dataset.id));
    } else if (e.target === this && selectedTableId && !didDrag) {
      closeProps();
    }
  });

  // Touch drag (on document, scoped to our canvas chips)
  addDocListener('touchstart', onTouchStart, { passive: false });
  addDocListener('touchmove', onTouchMove, { passive: false });
  addDocListener('touchend', onTouchEnd);

  // Keyboard
  addDocListener('keydown', onKeydown);

  // Load data
  loadTables();
}

export function destroy() {
  // Remove all document-level listeners
  for (const { event, handler, opts } of _docListeners) {
    document.removeEventListener(event, handler, opts);
  }
  _docListeners.length = 0;

  // Remove any lingering drag listeners
  document.removeEventListener('mousemove', onDrag);
  document.removeEventListener('mouseup', endDrag);

  // Clear timers
  clearTimeout(saveTimer);

  // Reset state
  ZONES = [];
  TABLES = [];
  activeZone = 'all';
  selectedTableId = null;
  gridSnap = true;
  dragId = null;
  _container = null;
}
