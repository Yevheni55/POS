// Tables page module
import { mountEmptyState } from '../components/empty-state.js';

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
  return _container.querySelector(sel) || (sel.charAt(0) === '#' ? document.getElementById(sel.slice(1)) : null);
}

const SHAPE_LABEL = { rect: 'obdĺžnik', round: 'kruh', large: 'veľký' };
const STATUS_LABEL = { occupied: 'obsadený', reserved: 'rezervovaný', paying: 'platí' };
function tablesWord(n) { return n === 1 ? 'stôl' : (n >= 2 && n <= 4 ? 'stoly' : 'stolov'); }
function zonesWord(n) { return n === 1 ? 'zóna' : (n >= 2 && n <= 4 ? 'zóny' : 'zón'); }
function seatsWord(n) { return n === 1 ? 'miesto' : (n >= 2 && n <= 4 ? 'miesta' : 'miest'); }

function updateTableCount() {
  const el = $('#tableCount');
  if (!el) return;
  const busy = TABLES.filter((t) => t.status && t.status !== 'free').length;
  el.textContent = TABLES.length + ' ' + tablesWord(TABLES.length) + ' · ' + ZONES.length + ' ' + zonesWord(ZONES.length)
    + (busy ? ' · ' + busy + (busy === 1 ? ' obsadený' : (busy <= 4 ? ' obsadené' : ' obsadených')) : '');
}

// ===== PERSISTENCE (API) =====
async function loadTables() {
  const canvas = $('#floorCanvas');
  if (canvas) showLoading(canvas, 'Načítavam stoly…');
  try {
    // Fetch tables and zone labels in parallel — zones is tiny so no
    // perf concern; doing it together keeps the floor layout and the
    // zone tabs consistent on the same render.
    const [tables, zonesData] = await Promise.all([
      api.get('/tables'),
      api.get('/zones').catch(() => []),
    ]);
    if (canvas) hideLoading(canvas);
    TABLES = tables;
    // Build a slug -> label map from the zones endpoint, then fold in any
    // legacy zones that exist on tables.zone but not yet in the zones
    // table (auto-seed should have caught them, but defend anyway).
    const labelMap = new Map();
    (zonesData || []).forEach((z) => labelMap.set(z.slug, z.label));
    const zoneSet = new Map();
    (zonesData || []).forEach((z) => zoneSet.set(z.slug, { id: z.slug, label: z.label }));
    TABLES.forEach((t) => {
      if (t.zone && !zoneSet.has(t.zone)) {
        const lbl = labelMap.get(t.zone) || (t.zone.charAt(0).toUpperCase() + t.zone.slice(1));
        zoneSet.set(t.zone, { id: t.zone, label: lbl });
      }
    });
    if (zoneSet.size > 0) {
      ZONES = Array.from(zoneSet.values());
    } else {
      ZONES = [{ id: 'interior', label: 'Interiér' }, { id: 'bar', label: 'Bar' }, { id: 'terasa', label: 'Terasa' }];
    }
    renderZoneBtns();
    populateZoneSelects();
    renderFloor();
    if (!TABLES || TABLES.length === 0) {
      const list = $('#tableList');
      if (list) mountEmptyState(list, {
        icon: '\uD83E\uDE91',
        title: 'Zatiaľ žiadne stoly',
        text: 'Stoly, ktoré tu pridáš, uvidí obsluha na kase pri otváraní účtu. Začni prvým stolom.',
        ctaLabel: 'Pridať stôl',
        onCta: openAddTable,
      });
    }
  } catch (err) {
    if (canvas) hideLoading(canvas);
    renderError($('#tableList') || canvas, err.message || 'Chyba pri načítaní stolov', loadTables);
  }
}

async function savePositions() {
  try {
    for (const t of TABLES) {
      await api.put('/tables/' + t.id, { x: t.x, y: t.y });
    }
    showToast('Pozície uložené', true);
  } catch (err) {
    showToast(err.message || 'Chyba pri ukladaní pozícií', 'error');
  }
}

function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(savePositions, 500);
}

// ===== ZONES =====
// Zóny sú rad chipov (na telefóne roluje vbok) + chip „Zóna" na pridanie.
// Premenovanie nie je ceruzka pri každom chipe — je v hlavičke skupiny zóny
// v zozname stolov (renderTableList).
function renderZoneBtns() {
  const allZones = [{ id: 'all', label: 'Všetky' }, ...ZONES];
  const el = $('#zoneBtns');
  if (!el) return;
  el.innerHTML = allZones.map((z) => {
    const on = z.id === activeZone;
    return '<button type="button" class="doch-chip mn-cat zone-btn' + (on ? ' is-on' : '') + '" data-zone="' + escapeHtml(z.id) + '"'
      + ' aria-pressed="' + (on ? 'true' : 'false') + '">' + escapeHtml(z.label) + '</button>';
  }).join('')
  + '<button type="button" class="doch-chip mn-cat mn-cat-add" id="addZoneBtn">'
  + '<svg aria-hidden="true" viewBox="0 0 14 14"><line x1="7" y1="1" x2="7" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="1" y1="7" x2="13" y2="7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
  + 'Zóna</button>';
}

function setZone(id) {
  activeZone = id;
  renderZoneBtns();
  renderFloor();
}

async function renameZone(slug) {
  const cur = ZONES.find((z) => z.id === slug);
  if (!cur) return;
  // Lightweight inline prompt — the admin Tables page already uses
  // window.prompt for similar one-shot renames (table names) so this
  // matches the existing UX without dragging a modal into the bundle.
  const next = window.prompt('Nový názov zóny "' + cur.label + '":', cur.label);
  if (next == null) return;
  const trimmed = String(next).trim();
  if (!trimmed || trimmed === cur.label) return;
  if (trimmed.length > 50) {
    showToast('Názov zóny môže mať najviac 50 znakov', 'error');
    return;
  }
  try {
    await api.patch('/zones/' + encodeURIComponent(slug), { label: trimmed });
    cur.label = trimmed;
    renderZoneBtns();
    populateZoneSelects();
    renderFloor();
    showToast('Zóna premenovaná', true);
  } catch (err) {
    showToast(err.message || 'Premenovanie zlyhalo', 'error');
  }
}

function populateZoneSelects() {
  const opts = ZONES.map(z => `<option value="${z.id}">${escapeHtml(z.label)}</option>`).join('');
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
  const zoneLabels = { interior: 'Interiér', bar: 'Bar', terasa: 'Terasa' };
  ZONES.forEach(z => { if (!zoneLabels[z.id]) zoneLabels[z.id] = z.label; });

  canvas.innerHTML = filtered.map(t => {
    const isSel = t.id === selectedTableId;
    return `<div class="table-chip ${t.shape} z-${t.zone} ${isSel ? 'selected' : ''}"
      data-id="${t.id}" style="left:${t.x}px;top:${t.y}px">
      <div class="chip-name">${escapeHtml(t.name)}</div>
      <div class="chip-seats">${t.seats} ${seatsWord(t.seats)}</div>
      <div class="chip-zone">${escapeHtml(zoneLabels[t.zone] || t.zone)}</div>
    </div>`;
  }).join('');
  renderTableList();
}

// ===== LIST (zóny ako skupiny, stoly ako riadky) =====
function renderTableList() {
  const list = $('#tableList');
  if (!list) return;
  if (!TABLES.length) return; // prázdny stav rieši loadTables
  const zones = activeZone === 'all' ? ZONES : ZONES.filter((z) => z.id === activeZone);
  // Stoly v zóne, ktorú nikto nepomenoval (stará hodnota v DB) — nech nezmiznú.
  const known = new Set(ZONES.map((z) => z.id));
  const orphans = TABLES.filter((t) => !known.has(t.zone));
  const groups = zones.map((z) => ({ zone: z, tables: TABLES.filter((t) => t.zone === z.id) }));
  if (activeZone === 'all' && orphans.length) groups.push({ zone: { id: '', label: 'Bez zóny' }, tables: orphans });

  list.innerHTML = groups.map((g) => {
    const rows = g.tables.map((t) => {
      const status = t.status && t.status !== 'free' ? (STATUS_LABEL[t.status] || t.status) : '';
      const shape = SHAPE_LABEL[t.shape] || t.shape || '';
      return '<button type="button" class="mn-row tb-row' + (t.id === selectedTableId ? ' is-selected' : '') + '" data-table-id="' + t.id + '">'
        + '<span class="mn-row-lead tb-shape" aria-hidden="true"><span class="tb-shape-i is-' + escapeHtml(t.shape || 'rect') + '"></span></span>'
        + '<span class="mn-row-main">'
          + '<span class="mn-row-name">' + escapeHtml(t.name) + '</span>'
          + '<span class="mn-row-sub">' + t.seats + ' ' + seatsWord(t.seats) + (shape ? ' · ' + shape : '') + '</span>'
        + '</span>'
        + '<span class="mn-row-side">' + (status ? '<span class="mn-pill is-warn">' + escapeHtml(status) + '</span>' : '') + '</span>'
        + '<svg class="mn-chev" aria-hidden="true" viewBox="0 0 16 16"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        + '</button>';
    }).join('');
    const rename = g.zone.id
      ? '<button type="button" class="btn-secondary mn-group-edit zone-rename-btn" data-rename-zone="' + escapeHtml(g.zone.id) + '" aria-label="Premenovať zónu ' + escapeHtml(g.zone.label) + '">Premenovať</button>'
      : '';
    return '<div class="mn-group tb-group">'
      + '<div class="mn-group-head">'
        + '<div class="mn-group-title"><span class="mn-group-name">' + escapeHtml(g.zone.label) + '</span>'
        + '<span class="mn-group-n">' + g.tables.length + ' ' + tablesWord(g.tables.length) + '</span></div>'
        + rename
      + '</div>'
      + '<div class="mn-list">' + (rows || '<div class="empty-hint tb-group-empty">V tejto zóne zatiaľ nie je žiadny stôl.</div>') + '</div>'
      + '</div>';
  }).join('');
  updateTableCount();
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
  // The mousedown listener is delegated on #floorCanvas, so e.currentTarget is
  // the canvas — NOT the chip. Resolve the chip from e.target so dragOffX/Y are
  // measured from the chip's top-left corner (otherwise the first onDrag
  // teleports the chip to x=0,y=0 and the cursor stays behind).
  const el = e.target.closest('.table-chip');
  if (!el) return;
  e.preventDefault();
  dragId = id;
  didDrag = false;
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
  showConfirm('Odstrániť stôl „' + t.name + '"?', 'Stôl zmizne z plánu aj z kasy. Túto akciu sa nedá vrátiť.', async function () {
    try {
      await api.del('/tables/' + selectedTableId);
      TABLES = TABLES.filter(t => t.id !== selectedTableId);
      closeProps();
      renderFloor();
      showToast('Stôl odstránený', true);
    } catch (err) {
      showToast('Chyba: ' + err.message);
    }
  }, { type: 'danger', confirmText: 'Odstrániť stôl' });
}

// ===== ADD TABLE MODAL =====
function openAddTable() {
  populateZoneSelects();
  const atName = $('#atName');
  const atSeats = $('#atSeats');
  const atZone = $('#atZone');
  const atShape = $('#atShape');
  if (atName) atName.value = 'Stôl ' + (TABLES.length + 1);
  if (atSeats) atSeats.value = '4';
  // Default zone = aktívna zóna v hornom paneli (ak nie je 'all'). Operátor
  // typicky stoji na zóne kde chce nový stôl (klikne Zamestnanci → "Pridať
  // stôl") a očakáva, že stôl spadne tam. Pred fixom sa default vždy
  // zobral z ZONES[0], takže nový stôl sa dal do Exteriéru / prvej zóny.
  if (atZone) {
    var defaultZone = (activeZone && activeZone !== 'all') ? activeZone : (ZONES[0]?.id || 'interior');
    // Over že hodnota existuje v <select> options (môže to byť stará zóna).
    var hasOption = Array.prototype.some.call(atZone.options, function (o) { return o.value === defaultZone; });
    atZone.value = hasOption ? defaultZone : (ZONES[0]?.id || 'interior');
  }
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
  if (!name) { showToast('Zadajte názov stola'); return; }
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
    showToast('Stôl pridaný', true);
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

async function saveNewZone() {
  var zoneModal = $('#addZoneModal');
  if (zoneModal && !validateForm(zoneModal)) return;

  const azName = $('#azName');
  const name = azName ? azName.value.trim() : '';
  if (!name) { showToast('Zadaj názov zóny'); return; }
  const id = name.toLowerCase().replace(/[^a-z0-9]/g, '_');
  if (ZONES.find(z => z.id === id)) { showToast('Zóna už existuje'); return; }
  // Persist before touching local state so a server-side reject (auth,
  // validation) doesn't leave a ghost zone in the UI.
  try {
    await api.post('/zones', { slug: id, label: name, sortOrder: (ZONES.length + 1) * 100 });
  } catch (err) {
    showToast(err.message || 'Pridanie zóny zlyhalo', 'error');
    return;
  }
  ZONES = [...ZONES, { id, label: name }];
  closeAddZone();
  saveState();
  renderZoneBtns();
  populateZoneSelects();
  showToast('Zóna pridaná', true);
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
  container.className = 'content tb-page';

  container.innerHTML = `
    <div class="mn-head">
      <div class="mn-count" id="tableCount" aria-live="polite"></div>
      <button class="btn-add" id="addTableBtn">
        <svg aria-hidden="true" viewBox="0 0 14 14"><line x1="7" y1="1" x2="7" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="1" y1="7" x2="13" y2="7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        Pridať stôl
      </button>
    </div>
    <div class="mn-cats tb-zones" id="zoneBtns" role="group" aria-label="Zóny">
      <button type="button" class="doch-chip mn-cat zone-btn is-on" data-zone="all" aria-pressed="true">Všetky</button>
    </div>
    <div class="tb-body">
      <div class="tb-list" id="tableList">
        <div class="mn-group"><div class="mn-list">
          <div class="skeleton-row"></div>
          <div class="skeleton-row"></div>
          <div class="skeleton-row"></div>
        </div></div>
      </div>
      <div class="tb-plan">
        <div class="tb-tools">
          <div class="tb-tools-hint">Plán kasy — stôl presunieš ťahaním, pozícia sa uloží sama.</div>
          <label class="grid-toggle" id="gridToggle">
            <div class="grid-check on" id="gridCheck"><svg aria-hidden="true" viewBox="0 0 12 12"><path d="M2 6l3 3 5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
            Prichytávať k mriežke
          </label>
        </div>
        <div class="floor-wrap tb-floor">
          <div class="floor-canvas grid-on" id="floorCanvas"></div>
        </div>
      </div>
    </div>
    <div class="props-backdrop tb-backdrop" id="propsBackdrop"></div>
    <div class="props-panel tb-props" id="propsPanel" role="dialog" aria-labelledby="propsTitle">
      <div class="props-header">
        <div class="props-title" id="propsTitle">Upraviť stôl</div>
        <button class="props-close" id="propsClose" aria-label="Zavrieť">&times;</button>
      </div>
      <div class="props-body">
        <div class="form-group">
          <label class="form-label" for="pName">Názov<span class="required-mark" aria-hidden="true"> *</span></label>
          <input class="form-input" id="pName" type="text" data-validate="required">
        </div>
        <div class="form-group">
          <label class="form-label" for="pSeats">Počet miest</label>
          <input class="form-input" id="pSeats" type="number" min="1" max="20" inputmode="numeric" data-validate="number">
        </div>
        <div class="form-group">
          <label class="form-label" for="pZone">Zóna</label>
          <select class="form-select" id="pZone"></select>
        </div>
        <div class="form-group">
          <label class="form-label" for="pShape">Tvar na pláne</label>
          <select class="form-select" id="pShape">
            <option value="rect">Obdĺžnik</option>
            <option value="round">Kruh</option>
            <option value="large">Veľký</option>
          </select>
        </div>
        <div class="mn-hint tb-props-hint">Zmeny sa ukladajú hneď po opustení poľa.</div>
      </div>
      <div class="props-actions">
        <button class="btn btn-danger" id="deleteTableBtn">Odstrániť stôl</button>
        <button class="btn btn-secondary" id="closePanelBtn">Hotovo</button>
      </div>
    </div>

    <!-- Add Table Modal -->
    <div class="u-overlay" id="addTableModal">
      <div class="u-modal u-modal-left">
        <div class="u-modal-title text-center">Pridať stôl</div>
        <div class="u-modal-body">
          <div class="u-modal-field">
            <label for="atName">Názov<span class="required-mark" aria-hidden="true"> *</span></label>
            <input id="atName" type="text" placeholder="napr. Stôl 9" aria-required="true" data-validate="required">
          </div>
          <div class="u-modal-field">
            <label for="atSeats">Počet miest</label>
            <input id="atSeats" type="number" min="1" max="20" value="4" inputmode="numeric" data-validate="number">
          </div>
          <div class="u-modal-field">
            <label for="atZone">Zóna</label>
            <select id="atZone"></select>
          </div>
          <div class="u-modal-field">
            <label for="atShape">Tvar na pláne</label>
            <select id="atShape">
              <option value="rect">Obdĺžnik</option>
              <option value="round">Kruh</option>
              <option value="large">Veľký</option>
            </select>
          </div>
        </div>
        <div class="u-modal-btns">
          <button class="u-btn u-btn-ghost" id="cancelAddTable">Zrušiť</button>
          <button class="u-btn u-btn-ice" id="saveAddTable">Pridať stôl</button>
        </div>
      </div>
    </div>

    <!-- Add Zone Modal -->
    <div class="u-overlay" id="addZoneModal">
      <div class="u-modal u-modal-left">
        <div class="u-modal-title text-center">Pridať zónu</div>
        <div class="u-modal-body">
          <div class="u-modal-field">
            <label for="azName">Názov zóny<span class="required-mark" aria-hidden="true"> *</span></label>
            <input id="azName" type="text" placeholder="napr. Terasa pri mori" data-validate="required">
          </div>
          <div class="mn-hint">Zóna zoskupuje stoly na kase aj v tomto zozname. Premenovať ju vieš neskôr v hlavičke skupiny.</div>
        </div>
        <div class="u-modal-btns">
          <button class="u-btn u-btn-ghost" id="cancelAddZone">Zrušiť</button>
          <button class="u-btn u-btn-ice" id="saveAddZone">Pridať zónu</button>
        </div>
      </div>
    </div>
  `;

  // Wire up event listeners via delegation and direct binding
  $('#zoneBtns').addEventListener('click', function (e) {
    // Chip „Zóna" sa prekresľuje spolu so zónami — preto delegácia.
    if (e.target.closest('#addZoneBtn')) { openAddZone(); return; }
    const btn = e.target.closest('.zone-btn');
    if (btn) setZone(btn.dataset.zone);
  });
  // Zoznam: riadok otvára úpravu stola, „Premenovať" v hlavičke skupiny zónu.
  $('#tableList').addEventListener('click', function (e) {
    const renameBtn = e.target.closest('.zone-rename-btn');
    if (renameBtn) {
      e.stopPropagation();
      renameZone(renameBtn.dataset.renameZone);
      return;
    }
    const row = e.target.closest('.tb-row');
    if (row) selectTable(e, Number(row.dataset.tableId));
  });

  $('#gridToggle').addEventListener('click', toggleGrid);
  $('#addTableBtn').addEventListener('click', openAddTable);
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

  // Panel stola a modálne okná idú do <body>: .app má stacking context
  // (z-index:2) a spodný tab bar (z-index:50) by ich inak prekrýval.
  ['propsBackdrop', 'propsPanel', 'addTableModal', 'addZoneModal'].forEach(function (id) {
    const el = _container.querySelector('#' + id);
    if (el) document.body.appendChild(el);
  });

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

  ['propsBackdrop', 'propsPanel', 'addTableModal', 'addZoneModal'].forEach(function (id) {
    const el = document.getElementById(id);
    if (el) el.remove();
  });

  // Reset state
  ZONES = [];
  TABLES = [];
  activeZone = 'all';
  selectedTableId = null;
  gridSnap = true;
  dragId = null;
  _container = null;
}
