'use strict';
// pos-render.js — All rendering/UI functions: clock, views, floor, categories, products, order, discounts

// Module-scope SVG constants — built once, reused across renders.
// Person icon — uses currentColor so it inherits chip-guests text tone.
// PERF: hoisted from renderFloor() local var to avoid ~30 string allocations per render.
const PERSON_ICON_SVG = '<svg aria-hidden="true" viewBox="0 0 16 16" width="11" height="11"><path d="M8 7a3 3 0 100-6 3 3 0 000 6zm-5 9a5 5 0 0110 0H3z" fill="currentColor"/></svg>';

// Spec 2.3 — single source of truth pre buttons disabled/visible state.
// Vracia jeden zo stringov: 'empty' | 'new' | 'partial' | 'sent' | 'paid'.
//   empty   = no items
//   new     = at least one item, NONE sent yet
//   partial = some sent, some pending — send button still shines
//   sent    = all sent, nothing paid yet — payments + predúčet are primary
//   paid    = order has been paid (rare in this UI since paid orders close)
function _computeOrderState() {
  var order = (typeof getOrder === 'function') ? getOrder() : [];
  if (!order.length) return 'empty';
  var hasPending = order.some(function (o) { return !o.sent; });
  var hasSent = order.some(function (o) { return o.sent; });
  if (hasPending && hasSent) return 'partial';
  if (hasPending) return 'new';
  if (hasSent) return 'sent';
  return 'empty';
}
window._computeOrderState = _computeOrderState;

function _applyActionButtonState() {
  var state = _computeOrderState();
  var btnSend    = document.getElementById('btnSend');
  var btnPreBill = document.getElementById('btnPreBill');
  var btnCash    = document.querySelector('.btn-cash');
  var btnCard    = document.querySelector('.btn-card');
  var btnOdpis   = document.getElementById('btnOdpis');
  var btnCancel  = document.querySelector('.actions .btn-cancel');

  // Disabled in 'empty' state (Spec 2.4)
  if (btnSend)    btnSend.disabled    = (state === 'empty' || state === 'sent');
  if (btnPreBill) btnPreBill.disabled = (state === 'empty');
  if (btnCash)    btnCash.disabled    = (state === 'empty');
  if (btnCard)    btnCard.disabled    = (state === 'empty');
  if (btnOdpis)   btnOdpis.disabled   = (state === 'empty');
  if (btnCancel) {
    btnCancel.disabled = (state === 'empty');
    btnCancel.classList.toggle('pos-hidden', state === 'empty');
  }

  // Primary emphasis swaps per state.
  // 'new' / 'partial' → Poslat je hlavna akcia.
  // 'sent'            → Hotovost/Karta a Preducet su hlavne; Poslat disabled.
  if (btnSend)    btnSend.classList.toggle('is-primary',    state === 'new' || state === 'partial');
  if (btnCash)    btnCash.classList.toggle('is-primary',    state === 'sent' || state === 'partial');
  if (btnCard)    btnCard.classList.toggle('is-primary',    state === 'sent' || state === 'partial');
  if (btnPreBill) btnPreBill.classList.toggle('is-primary', state === 'sent');
}
window._applyActionButtonState = _applyActionButtonState;

// Clock
function updateClock(){
  const n=new Date();
  document.getElementById('clock').textContent=String(n.getHours()).padStart(2,'0')+':'+String(n.getMinutes()).padStart(2,'0');
  const dateEl=document.getElementById('date');
  if(dateEl){
    // Slovak genitive date — Intl.DateTimeFormat('sk-SK', month:'long')
    // produces '23. mája' (correct genitive) instead of '23. maj'.
    // Capitalize weekday: 'sobota' → 'Sobota'.
    const s=new Intl.DateTimeFormat('sk-SK',{weekday:'long',day:'numeric',month:'long'}).format(n);
    dateEl.textContent=s.charAt(0).toUpperCase()+s.slice(1);
  }
}
updateClock();setInterval(updateClock,30000);

// Shift strip refresh — pulls revenue + open table count from POS state.
// Re-runs every 30s + on table/order state change events. Light DOM work.
function updateShiftStrip() {
  // Shift duration: time since first order today (or session start fallback)
  var ssDur = document.getElementById('ssShiftDuration');
  var ssRev = document.getElementById('ssRevenue');
  var ssOpen = document.getElementById('ssOpenTables');
  if (!ssDur || !ssRev || !ssOpen) return;
  var shiftStart = window._shiftStartedAt || sessionStorage.getItem('pos_shift_started_at');
  if (!shiftStart) {
    shiftStart = Date.now();
    window._shiftStartedAt = shiftStart;
    try { sessionStorage.setItem('pos_shift_started_at', String(shiftStart)); } catch (_) {}
  }
  shiftStart = Number(shiftStart);
  var elapsedMs = Date.now() - shiftStart;
  var hours = Math.floor(elapsedMs / 3600000);
  var mins = Math.floor((elapsedMs % 3600000) / 60000);
  ssDur.textContent = hours + 'h ' + String(mins).padStart(2, '0') + 'm';

  var rev = (typeof window._todayRevenue === 'number') ? window._todayRevenue : 0;
  ssRev.textContent = (typeof fmt === 'function') ? fmt(rev) : (rev.toFixed(2) + ' €');

  // Open tables = TABLES filter status occupied + has order rows
  var open = 0;
  if (typeof TABLES !== 'undefined' && Array.isArray(TABLES)) {
    open = TABLES.filter(function (t) {
      return t.status === 'occupied'
        || t.status === 'reserved';
    }).length;
  }
  var total = (typeof TABLES !== 'undefined') ? TABLES.length : 0;
  ssOpen.textContent = open + ' / ' + total;
}
// Tick every 30s for duration; revenue/open updated also from event listeners
setInterval(updateShiftStrip, 30000);
// Initial call after DOM ready (use rAF to ensure DOM mount)
requestAnimationFrame(updateShiftStrip);
window.updateShiftStrip = updateShiftStrip;

// View toggle
function _toastSendKitchenError(err){
  var msg=(err&&err.message)?('Chyba odoslania: '+err.message):'Nepodarilo sa odoslat na kuchynu';
  if(typeof showToast==='function')showToast(msg,'error');
}

var _tableLeaveFlushPromise = null;

function hasPendingOrderFlushState() {
  return !!(_orderDirty || (_pendingStorno && _pendingStorno.length) || getOrder().length);
}

// Ak sa odoslanie nepodarí, opýtaj sa — nezamykaj čašníka na stole.
// Volajúci používajú vzor `if (!flushed) return;`, takže tvrdé `false` pri
// každom 409/5xx/výpadku znamenalo, že tap na „Stoly", na iný stôl aj mobilná
// záložka „Stoly" neurobili NIČ okrem dvoch surových anglických toastov.
// Čašník zostal uväznený na jednom účte a nevedel obslúžiť iný stôl.
// Lokálny stav je pritom persistovaný (_persistTableOrdersNow), takže odchod
// nič nestráca — položky sa odošlú pri ďalšom pokuse.
function _confirmLeaveDespiteFlushError(err) {
  return new Promise(function (resolve) {
    var detail = (err && err.message) ? (' (' + err.message + ')') : '';
    if (typeof showConfirm !== 'function') { resolve(false); return; }
    var done = false;
    function settle(v) { if (!done) { done = true; resolve(v); } }
    showConfirm(
      'Odoslanie zlyhalo',
      'Položky sa nepodarilo odoslať na kuchyňu/bar' + detail
        + '. Zostávajú uložené na účte a odošlú sa pri ďalšom pokuse.<br><br>Chceš aj tak odísť zo stola?',
      function () { settle(true); },
      {
        type: 'danger',
        confirmText: 'Odísť zo stola',
        cancelText: 'Zostať',
        // onDismiss pokryje aj Escape a klik na pozadie — inak by promise
        // ostal visieť a čašník by bol zaseknutý ešte tvrdšie než predtým.
        onDismiss: function () { settle(false); },
      }
    );
  });
}

function flushOrderBeforeTableLeave() {
  // Resolve "true" when there is nothing to flush so that callers using the
  // !flushed-as-abort pattern (e.g. openTable / mobile pickTable) don't bail
  // out silently on a clean switch and prevent the new table from opening.
  if (!hasPendingOrderFlushState()) return Promise.resolve(true);
  if (_renderTimer) { clearTimeout(_renderTimer); _renderTimer = null; }
  if (_tableLeaveFlushPromise) return _tableLeaveFlushPromise;

  _tableLeaveFlushPromise = Promise.resolve()
    .then(function() { return sendToKitchen(); })
    .then(function() { return true; })
    .catch(function(err) {
      _toastSendKitchenError(err);
      return _confirmLeaveDespiteFlushError(err);
    })
    .finally(function() {
      _tableLeaveFlushPromise = null;
    });

  return _tableLeaveFlushPromise;
}

async function switchView(v){
  // Ak sa odchádza zo stola a operátor je v move-mode bez selekcie,
  // ticho ho ukončíme — inak by zostal v stave kde "klik na stôl"
  // zobrazí "Nie je co presunut" namiesto otvorenia stola.
  if (typeof moveMode !== 'undefined' && moveMode && (!moveSelectedItems || !moveSelectedItems.length)) {
    if (typeof exitMoveMode === 'function') exitMoveMode();
  }
  // Auto-send to kitchen when leaving table (also flush storno + dirty state)
  if (v === 'tables' && currentView !== 'tables' && hasPendingOrderFlushState()) {
    var flushed = await flushOrderBeforeTableLeave();
    if (!flushed) return;
  }
  // Catch up on admin-side layout changes if the socket was offline while away
  if (v === 'tables') {
    try { await loadTables(); } catch (e) { /* offline, render cached */ }
  }
  currentView=v;
  document.getElementById('btnTableView').classList.toggle('active',v==='tables');
  document.getElementById('btnProductView').classList.toggle('active',v==='products');
  document.getElementById('tableView').classList.toggle('active',v==='tables');
  document.getElementById('productsPanel').classList.toggle('active',v==='products');
  document.querySelector('.order-panel').classList.toggle('pos-hidden', v==='tables');
  // Reclaim the shift-strip band (~30px) on the products view where row count
  // matters; keep the owner-glance metrics on the floor (tables) view.
  var _ss=document.getElementById('shiftStrip');
  if(_ss)_ss.classList.toggle('pos-hidden', v==='products');
  if(v==='tables')renderFloor();if(v==='products')renderProducts();
  if (typeof persistUIState === 'function') persistUIState();
}

// Edit mode — POS-local floor rearrangement. Positions persist via PUT /tables/:id
// and are emitted as `table:updated` to all clients, so what gets saved here shows
// up identically in the admin floor plan and on every other device without reload.
function toggleEdit(){
  editMode=!editMode;
  document.getElementById('editToggle').classList.toggle('active',editMode);
  document.getElementById('editLabel').textContent=editMode?'Hotovo':'Upravit';
  document.getElementById('floorCanvas').classList.toggle('edit-mode',editMode);
  document.body.classList.toggle('edit-mode',editMode);
  // Non-passive touch listenery viažeme len počas edit módu — mimo neho
  // zbytočne vypínali asynchrónny scrolling celej stránky (pos-ui.js).
  if (typeof bindEditTouchDrag === 'function') bindEditTouchDrag(editMode);
  if(!editMode)savePositions();
  renderFloor();
}

// Floor zones — pills with table count + occupied count per zone.
// Operator vidí na prvý pohľad „terasa 8/12, interier 4/16" — kam ísť.
function renderFloorZones(){
  document.getElementById('floorZones').innerHTML=ZONES.map(z=>{
    var zoneTables = TABLES.filter(function(t){ return t.zone === z.id; });
    var total = zoneTables.length;
    var occupied = zoneTables.filter(function(t){ return t.status === 'occupied' || t.status === 'reserved'; }).length;
    var meta = total > 0 ? (occupied + '/' + total) : '';
    return '<button class="zone-btn ' + (z.id===activeZone?'active':'') + '" onclick="setZone(\'' + escAttr(z.id) + '\')">' +
      '<span class="zone-label">' + escHtml(z.label) + '</span>' +
      (meta ? '<span class="zone-meta">' + meta + '</span>' : '') +
    '</button>';
  }).join('');
}
function setZone(id){activeZone=id;renderFloorZones();renderFloor();if(typeof persistUIState==='function')persistUIState();}

// Floor canvas — absolute-pixel positioning, identical coordinate system to admin.
// Admin drag-and-drop on /admin#tables writes the same (x,y) integers we read here.
// Canvas becomes scrollable if tables extend beyond its visible area.
// Net total for a table chip / floor summary — subtracts BOTH the order-level
// zľava (lives on the order object, surfaced via allOrdersCache) and per-item
// zľavy (rule stored on the line items in tableOrders). Matches the account
// panel's getOrderTotal so floor a účet ukazujú rovnakú sumu.
// Riadky, z ktorých sa počíta suma na chipe stola.
// Pre NEvybrané stoly je zdrojom tableOrders[id] (tam loadAllOrders zloží súčet
// všetkých účtov stola). Pre VYBRANÝ stôl tam ale zámerne nesiahame — tableOrders
// je preň len aktuálny účet (viď loadAllOrders v pos-state.js) — takže súčet za
// celý stôl skladáme tu z allOrdersCache (server = všetky účty) a dopĺňame
// lokálne ešte neodoslané riadky, ktoré server logicky nepozná.
function _tableChipRows(tableId){
  if (typeof selectedTableId === 'undefined' || tableId !== selectedTableId) {
    return tableOrders[tableId] || [];
  }
  var rows = [];
  var cached = (typeof allOrdersCache !== 'undefined' && allOrdersCache[tableId]) || [];
  cached.forEach(function(o){
    (o.items || []).forEach(function(i){
      rows.push({
        id: i.id, price: parseFloat(i.price), qty: i.qty,
        discountType: i.discountType || null,
        discountValue: i.discountValue != null ? parseFloat(i.discountValue) : null,
      });
    });
  });
  (tableOrders[tableId] || []).forEach(function(p){
    if (!p || p.sent) return;
    if (typeof p.id !== 'number' || p.id <= 1000000000) return;   // len local-only
    if (rows.some(function(r){ return r.id === p.id; })) return;
    rows.push(p);
  });
  return rows;
}

function _tableNetTotal(tableId){
  var ord = _tableChipRows(tableId);
  var gross = ord.reduce(function(s,o){ return s + o.price * o.qty; }, 0);
  var itemDisc = (typeof itemLineDiscount === 'function')
    ? ord.reduce(function(s,o){ return s + itemLineDiscount(o); }, 0)
    : 0;
  var cached = (typeof allOrdersCache !== 'undefined' && allOrdersCache[tableId]) || [];
  var orderDisc = cached.reduce(function(s,o){ return s + (o && o.discountAmount ? parseFloat(o.discountAmount) : 0); }, 0);
  return Math.max(0, Math.round((gross - itemDisc - orderDisc) * 100) / 100);
}

// Vlastný názov účtu (meno hosťa) pre stôl — ak je label otvoreného účtu iný
// než default „Ucet N". Vracia null keď nič vlastné nie je (→ chip ukáže názov
// stola). Pre vybraný stôl je zdroj pravdy tableOrdersList.
function _tableCustomName(tableId){
  var list = (typeof allOrdersCache !== 'undefined' && allOrdersCache[tableId]) || [];
  if (typeof selectedTableId !== 'undefined' && tableId === selectedTableId
      && typeof tableOrdersList !== 'undefined' && tableOrdersList && tableOrdersList.length) {
    list = tableOrdersList;
  }
  for (var i = 0; i < list.length; i++){
    var lbl = list[i] && list[i].label;
    if (lbl && !/^ucet\s*\d+$/i.test(String(lbl).trim())) return lbl;
  }
  return null;
}

// Pomenovať aktuálny otvorený účet (napr. menom hosťa) — aby sa dal ľahko nájsť
// na podlaží. Po zaplatení sa účet zatvorí, takže názov sa „vráti" sám.
function renameCurrentOrder(){
  if (!currentOrderId) { showToast('Najprv otvor účet', 'warning'); return; }
  var cur = (typeof tableOrdersList !== 'undefined' && tableOrdersList)
    ? tableOrdersList.find(function(o){ return o.id === currentOrderId; }) : null;
  var curLabel = (cur && cur.label && !/^ucet\s*\d+$/i.test(String(cur.label).trim())) ? cur.label : '';
  showPrompt('Pomenovať účet', 'napr. Janko / pri okne', function(name){
    name = String(name || '').trim().slice(0, 40);
    if (!name) return;
    api.patch('/orders/' + currentOrderId + '/label', { label: name }).then(function(res){
      var lbl = (res && res.order && res.order.label) || name;
      if (cur) cur.label = lbl;
      try {
        var arr = (typeof allOrdersCache !== 'undefined') ? (allOrdersCache[selectedTableId] || []) : [];
        for (var i = 0; i < arr.length; i++) if (arr[i].id === currentOrderId) arr[i].label = lbl;
      } catch (e) {}
      showToast('Účet pomenovaný: ' + lbl, 'success');
      if (typeof renderOrder === 'function') renderOrder();
      if (typeof renderFloor === 'function') renderFloor();
    }).catch(function(e){
      showToast((e && e.message) || 'Premenovanie zlyhalo', 'error');
    });
  }, { defaultValue: curLabel, confirmText: 'Uložiť' });
}

function renderFloor(){
  const canvas=document.getElementById('floorCanvas');
  if(!canvas)return;
  // PERF: skip floor rebuild if user is on products view — DOM mutations
  // are invisible. Floor will be rebuilt when user returns via switchView('tables').
  if (typeof currentView !== 'undefined' && currentView !== 'tables') return;
  const filtered=TABLES.filter(t=>t.zone===activeZone);
  const sl={free:'Volny',occupied:'Obsad.',reserved:'Rez.',dirty:'Cistit'};
  // Status glyph — color-independent indicator pre WCAG 1.4.1 compliance.
  // Deuteranopia (8% mužov) nerozozná zelená vs terra → kombinujeme color
  // status-dot + glyph leading the name. Glyphs sú unicode geometric
  // shapes — render bez extra font load, vidno aj v black-and-white.
  //   ○ free      — empty circle (low-prominence, prázdne miesto)
  //   ●  occupied  — filled circle (busy, plný)
  //   ▲ reserved  — triangle (cancelable timeline event)
  //   ✕ dirty     — cross (needs attention)
  const GLYPHS = { free: '○', occupied: '●', reserved: '▲', dirty: '✕' };
  const titles={free:'Otvorit objednavku',occupied:'Zobrazit ucet',reserved:'Otvorit rezervaciu',dirty:'Oznacit ako volny'};
  // Person icon — uses currentColor so it inherits chip-guests text tone.
  // Hoisted to module scope (PERSON_ICON_SVG) — reused below.
  const personIcon = PERSON_ICON_SVG;

  // EMPTY ZONE state — show helpful illustration + copy instead of empty canvas.
  if (!filtered.length && !editMode) {
    canvas.innerHTML = ''
      + '<div class="floor-empty">'
      +   '<svg viewBox="0 0 64 64" width="80" height="80" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      +     '<rect x="8" y="20" width="22" height="22" rx="3"/>'
      +     '<rect x="34" y="20" width="22" height="22" rx="3"/>'
      +     '<path d="M16 12v8M22 12v8M40 12v8M50 12v8"/>'
      +   '</svg>'
      +   '<div class="floor-empty-title">Žiadne stoly v tejto zóne</div>'
      +   '<div class="floor-empty-text">Pridaj stoly cez admin → Stoly, alebo prepni zónu vyššie.</div>'
      + '</div>';
    if (typeof renderStornoChip === 'function') renderStornoChip();
    return;
  }

  // Grow the canvas so the rightmost / bottom-most chip isn't clipped. Chip reaches
  // roughly 150x110 beyond its top-left anchor, plus breathing room.
  var maxX=0,maxY=0;
  for(var i=0;i<filtered.length;i++){
    if(filtered[i].x>maxX)maxX=filtered[i].x;
    if(filtered[i].y>maxY)maxY=filtered[i].y;
  }
  // Chip reaches ~140x110 beyond its top-left anchor (large tablet chip + padding).
  canvas.style.minWidth=Math.max(maxX+170,600)+'px';
  canvas.style.minHeight=Math.max(maxY+140,400)+'px';

  // Detect "forgotten" tables — occupied for > 20 min without payment activity
  // (we use createdAt of the first open order on this table to compute age).
  // Useful signal: čašníčka vie ktorý stôl chce platiť ale „zabudnutý". Tu len
  // jednoduchá heuristika podľa časového trvania objednávky.
  function isForgottenTable(tableId){
    var orders = (typeof allOrdersCache !== 'undefined' && allOrdersCache[tableId]) || [];
    if (!orders.length) return false;
    var oldest = orders[0];
    if (!oldest || !oldest.createdAt) return false;
    var age = Date.now() - new Date(oldest.createdAt).getTime();
    return age > 20 * 60 * 1000; // 20 min
  }

  canvas.innerHTML=filtered.map(t=>{
    const total=_tableNetTotal(t.id);
    const isSel=t.id===selectedTableId;
    const isForgotten = t.status==='occupied' && isForgottenTable(t.id);
    const shapeClass=t.shape==='round'?'round':t.shape==='large'?'large':'';
    // Per-table size override (null/undefined → fallback na CSS default ze shape).
    // Manazer ich nastavi v edit mode dragom za pravy dolny roh — savePositions
    // posle width/height na server cez PUT /tables/:id.
    const sizeStyle = (t.width && t.height)
      ? `;width:${t.width}px;height:${t.height}px`
      : '';
    const posStyle=`left:${t.x}px;top:${t.y}px${sizeStyle}`;

    const ariaParts=[escHtml(t.name),sl[t.status]||t.status,t.seats+' miest'];
    if(t.status==='occupied'&&total>0)ariaParts.push(fmt(total));
    if(t.status==='reserved'&&t.time)ariaParts.push(t.time);
    if(isForgotten)ariaParts.push('zabudnuty - cas > 20 min');
    const ariaLabel=ariaParts.join(', ');

    // Information hierarchy — top: name + status dot, mid: amount/time, bottom: seats.
    var classes = [
      'table-chip',
      's-' + t.status,
      shapeClass,
      isSel ? 'selected' : '',
      isForgotten ? 'is-forgotten' : '',
    ].filter(Boolean).join(' ');

    var glyph = GLYPHS[t.status] || '';
    var bodyHtml = ''
      + '<div class="chip-top">'
      +   '<span class="chip-status-dot ' + t.status + '" aria-hidden="true"></span>'
      +   '<span class="chip-glyph s-' + t.status + '" aria-hidden="true">' + glyph + '</span>'
      +   '<div class="chip-name">' + escHtml(t.name) + '</div>'
      + '</div>';

    // Vlastný názov účtu (meno hosťa) — aby sa stôl ľahko našiel pri platbe.
    var custName = _tableCustomName(t.id);
    if (custName) {
      bodyHtml += '<div class="chip-customer" title="Hosť">' + escHtml(custName) + '</div>';
    }

    if (t.status === 'occupied' && total > 0) {
      bodyHtml += '<div class="chip-amount">' + fmt(total) + '</div>';
    } else if (t.status === 'reserved' && t.time) {
      bodyHtml += '<div class="chip-time">' + escHtml(t.time) + '</div>';
    } else if (t.status === 'dirty') {
      bodyHtml += '<div class="chip-state-label">vyčistiť</div>';
    } else if (t.status === 'occupied') {
      // Occupied but no order amount yet (just-opened) — show "Otvorený" hint
      bodyHtml += '<div class="chip-state-label">otvorený</div>';
    }
    // status === 'free' → no label, status dot color suffices

    // Capacity (seat count) only when chip is occupied/reserved/dirty AND in
    // edit mode — for empty tables the number is noise. In edit mode it's
    // useful for layout decisions, so always show there.
    if (t.status !== 'free' || (typeof editMode !== 'undefined' && editMode)) {
      bodyHtml += '<div class="chip-guests">' + personIcon + ' ' + t.seats + '</div>';
    }

    // Resize handle — iba v edit móde (visible cez .edit-mode CSS rule).
    // Po stlačení sa spustí startTableResize() z pos-ui.js.
    bodyHtml += '<button type="button" class="table-chip-resize"'
      + ' data-resize-id="' + t.id + '"'
      + ' aria-label="Zmenit velkost stola ' + escAttr(t.name) + '"'
      + ' title="Drag za roh — meni velkost stola">'
      + '<svg viewBox="0 0 16 16" aria-hidden="true" width="14" height="14">'
      +   '<path d="M14 2 L14 6 M14 2 L10 2 M2 14 L6 14 M2 14 L2 10 M14 14 L8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>'
      + '</svg>'
      + '</button>';

    // PERF: data-table-id replaces inline onclick/onmousedown — single delegated
    // listener attached below routes events to chipClick / startDrag.
    return '<div class="' + classes + '"'
      + ' data-id="' + t.id + '"'
      + ' data-table-id="' + t.id + '"'
      + ' style="' + posStyle + '"'
      + ' tabindex="0" role="button"'
      + ' aria-label="' + ariaLabel + '"'
      + ' title="' + (titles[t.status] || '') + '"'
      + '>' + bodyHtml + '</div>';
  }).join('');

  // Attach delegated listeners ONCE on the canvas. Idempotent via dataset flag —
  // renderFloor() rewrites canvas.innerHTML but dataset survives.
  if (!canvas.dataset.delegated) {
    canvas.dataset.delegated = '1';
    canvas.addEventListener('click', function(e){
      // Edit-mode pôvodne NEvolala chipClick (na inline onclick sa
      // pripojil iba mimo edit-mode). Tu zachovavame správanie:
      // v edit-mode klik na stôl je iba začiatok dragu, nie navigacia.
      if (typeof editMode !== 'undefined' && editMode) return;
      var chip = e.target.closest('[data-table-id]');
      if (!chip) return;
      var id = Number(chip.dataset.tableId);
      if (!id || !chip.classList.contains('table-chip')) return;
      if (typeof chipClick === 'function') chipClick(id);
    });
    canvas.addEventListener('mousedown', function(e){
      if (typeof editMode === 'undefined' || !editMode) return;
      // Resize handle má precedens nad chip drag — ak je klik na handle,
      // odštartuj resize, nie position drag.
      var resizeBtn = e.target.closest('[data-resize-id]');
      if (resizeBtn) {
        var rid = Number(resizeBtn.dataset.resizeId);
        if (rid && typeof startTableResize === 'function') {
          e.stopPropagation();
          startTableResize(e, rid);
        }
        return;
      }
      var chip = e.target.closest('[data-table-id]');
      if (!chip) return;
      var id = Number(chip.dataset.tableId);
      if (id && typeof startDrag === 'function') startDrag(e, id);
    });
    // Touch start na resize handle — paralelná cesta pre tablet (touchstart
    // listener vyssie zachytí mouseDown na chip, ale resize handle si musí
    // mat vlastny touch handler pre stopPropagation).
    canvas.addEventListener('touchstart', function(e){
      if (typeof editMode === 'undefined' || !editMode) return;
      var resizeBtn = e.target.closest('[data-resize-id]');
      if (!resizeBtn) return;
      var rid = Number(resizeBtn.dataset.resizeId);
      if (rid && typeof startTableResize === 'function') {
        e.stopPropagation();
        e.preventDefault();
        startTableResize(e, rid);
      }
    }, { passive: false });
  }

  // Always-visible Storno chip in the top-right corner of the floor canvas.
  // Renders separately so renderStornoChip() can refresh badge/value without
  // re-rendering the whole floor.
  if (typeof renderStornoChip === 'function') renderStornoChip();

  // Floor summary widget — total revenue for this zone today (sum of all
  // currently-open table totals). Pomáha manažérovi/owner-ovi na prvý pohľad.
  if (typeof renderFloorSummary === 'function') renderFloorSummary(filtered);
}

// Floor summary — bottom-left of canvas, shows zone occupancy + total revenue.
// Operator vidí "12 stolov · 7 obsadených · 245,80 €" priamo na floor mape.
function renderFloorSummary(filteredTables){
  var canvas = document.getElementById('floorCanvas');
  if (!canvas) return;
  var existing = document.getElementById('floorSummary');
  if (existing) existing.remove();

  var total = (filteredTables || []).reduce(function(s, t){
    return s + _tableNetTotal(t.id);
  }, 0);
  var occupied = (filteredTables || []).filter(function(t){ return t.status === 'occupied'; }).length;
  var totalCount = (filteredTables || []).length;

  // Nothing meaningful to show? Skip.
  if (!totalCount) return;

  var el = document.createElement('div');
  el.id = 'floorSummary';
  el.className = 'floor-summary';
  el.innerHTML = ''
    + '<div class="fs-row">'
    +   '<span class="fs-label">Stoly</span>'
    +   '<span class="fs-val">' + occupied + ' / ' + totalCount + '</span>'
    + '</div>'
    + (total > 0
        ? '<div class="fs-row fs-row--accent">'
          + '<span class="fs-label">V predaji</span>'
          + '<span class="fs-val">' + fmt(total) + '</span>'
        + '</div>'
        : '');
  canvas.appendChild(el);
}

// Storno koš pill — PRESUNUTÉ do admin panelu (#storno). Cashier v POS už
// storná NErieši (vrátiť/odpísať je manažérske rozhodnutie). Pill teda
// nezobrazujeme — funkcia ostáva ako no-op (a odstráni starý pill ak by
// nejaký zostal z predošlej session) aby sme nemuseli hľadať všetky
// call-sites. Storná sa stále VYTVÁRAJÚ z POS (POST /storno-basket),
// len resolve UI sa presunulo do adminu.
function renderStornoChip() {
  var existing = document.getElementById('stornoPill');
  if (existing) existing.remove();
}

function openStornoBasket() {
  var c = (typeof _stornoBasketCache !== 'undefined') ? _stornoBasketCache : { items: [] };
  var existing = document.getElementById('stornoBasketModal');
  if (existing) existing.remove();

  var rowsHtml = (c.items && c.items.length)
    ? c.items.map(function(it){
        var when = it.createdAt ? new Date(it.createdAt).toLocaleTimeString('sk-SK',{hour:'2-digit',minute:'2-digit'}) : '';
        var pricedQty = (Number(it.unitPrice||0) * it.qty);
        // Cashier-suggested wasPrepared shown as a soft hint — admin makes the final call.
        var suggested = it.wasPrepared
          ? '<span class="storno-suggest suggest-prep">🔥 Čašník: pripravené</span>'
          : '<span class="storno-suggest suggest-noprep">🔄 Čašník: nepripravené</span>';
        var reasonLabel = ({order_error:'Chyba obj.', complaint:'Reklamácia', breakage:'Rozbité', staff_meal:'Zam. spotreba', other:'Iné'})[it.reason] || it.reason || '';
        return ''+
        '<div class="storno-row" data-id="'+it.id+'">'+
          '<div class="storno-row-main">'+
            '<div class="storno-row-name">'+escHtml(it.itemName)+' &times;'+it.qty+'</div>'+
            '<div class="storno-row-meta">'+escHtml(reasonLabel)+' · '+escHtml(it.staffName||'')+(when?' · '+when:'')+(it.note?' · '+escHtml(it.note):'')+'</div>'+
            '<div class="storno-row-suggest">'+suggested+'</div>'+
          '</div>'+
          '<div class="storno-row-price">'+fmt(pricedQty)+'</div>'+
          '<div class="storno-row-actions">'+
            '<button class="u-btn u-btn-mint storno-action-return" onclick="resolveStornoBasketItem('+it.id+',false)" title="Vrátiť suroviny späť na sklad (jedlo nebolo urobené)">🔄 Vrátiť</button>'+
            '<button class="u-btn u-btn-rose storno-action-writeoff" onclick="resolveStornoBasketItem('+it.id+',true)" title="Odpísať: jedlo bolo urobené, ide ako strata">🔥 Odpísať</button>'+
            '<button class="u-btn u-btn-ghost storno-action-delete" onclick="deleteStornoBasketItem('+it.id+')" title="Zmazať záznam bez akcie skladu">×</button>'+
          '</div>'+
        '</div>';
      }).join('')
    : '<div style="padding:32px;text-align:center;color:var(--color-text-sec)">Žiadne čakajúce storná. 🎉</div>';

  var ov = document.createElement('div');
  ov.className = 'u-overlay';
  ov.id = 'stornoBasketModal';
  ov.innerHTML =
    '<div class="u-modal" style="max-width:760px;width:96%;text-align:left">'+
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">'+
        '<div class="u-modal-title" style="margin:0">Storno — čaká na spracovanie</div>'+
        '<button class="u-btn u-btn-ghost" style="flex:0 0 auto;padding:6px 14px;min-height:auto" onclick="closeStornoBasket()">×</button>'+
      '</div>'+
      '<div style="font-size:var(--text-sm);color:var(--color-text-sec);margin-bottom:16px">'+
        '<b>🔄 Vrátiť</b> = suroviny ide späť na sklad (rozhodne admin). '+
        '<b>🔥 Odpísať</b> = jedlo už bolo urobené, ide ako strata. '+
        '<b>×</b> = záznam bol omyl, žiadna akcia skladu.'+
      '</div>'+
      '<div class="storno-list" style="max-height:60vh;overflow-y:auto">'+rowsHtml+'</div>'+
    '</div>';
  document.body.appendChild(ov);
  requestAnimationFrame(function(){ ov.classList.add('show'); });
  ov.addEventListener('click', function(e){ if(e.target===ov) closeStornoBasket(); });
}

function closeStornoBasket() {
  var ov = document.getElementById('stornoBasketModal');
  if (ov) { ov.classList.remove('show'); setTimeout(function(){ if(ov.parentNode) ov.remove(); }, 250); }
}

// Admin makes the final wasPrepared call: false = return to stock, true = write-off.
// Whatever the cashier captured at storno time is shown as a hint but the
// override here wins.
async function resolveStornoBasketItem(id, wasPrepared) {
  try {
    var body = (wasPrepared === true || wasPrepared === false)
      ? { override: { wasPrepared: !!wasPrepared } }
      : {};
    var r = await api.post('/storno-basket/' + id + '/resolve', body);
    if (r && r.result) {
      if (r.result.action === 'returned') showToast('Suroviny vrátené na sklad', true);
      else if (r.result.action === 'write_off') showToast('Odpis: ' + (r.result.totalCost || 0).toFixed(2) + ' €', true);
      else showToast('Spracované', true);
    }
    await loadStornoBasket();
    openStornoBasket(); // re-render the list
  } catch (e) {
    showToast('Chyba: ' + (e && e.message), 'error');
  }
}

// Confirm overlay before destructive delete — admin can mis-tap × under stress
// (it sits next to 🔄 Vrátiť / 🔥 Odpísať). Cancel/Esc/backdrop = no API call.
function _confirmStornoDelete(label) {
  return new Promise(function (resolve) {
    var ov = document.createElement('div');
    ov.className = 'u-overlay';
    ov.id = 'stornoDeleteConfirm';
    ov.innerHTML =
      '<div class="u-modal" role="dialog" aria-modal="true" style="max-width:380px;text-align:center">' +
        '<div style="display:flex;justify-content:center;margin-bottom:8px;color:var(--color-warning,#e0a830)"><svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="svg-icon"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></div>' +
        '<div class="u-modal-title">Naozaj zmazať záznam?</div>' +
        '<div class="u-modal-text" style="margin:8px 0 18px">' + escHtml(label) + '<br><span style="opacity:.7;font-size:13px">Sklad sa nedotkne — záznam jednoducho zmizne z prehľadu.</span></div>' +
        '<div class="u-modal-btns" style="gap:12px">' +
          '<button type="button" class="u-btn u-btn-ghost" id="stornoDelCancel">Zrušiť</button>' +
          '<button type="button" class="u-btn u-btn-rose" id="stornoDelOk">Zmazať</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);
    requestAnimationFrame(function () { ov.classList.add('show'); });

    function close(result) {
      ov.classList.remove('show');
      setTimeout(function () { if (ov.parentNode) ov.remove(); }, 250);
      resolve(result);
    }
    ov.querySelector('#stornoDelCancel').addEventListener('click', function () { close(false); });
    ov.querySelector('#stornoDelOk').addEventListener('click', function () { close(true); });
    ov.addEventListener('click', function (e) { if (e.target === ov) close(false); });
    document.addEventListener('keydown', function escH(ev) {
      if (ev.key === 'Escape') { document.removeEventListener('keydown', escH, true); close(false); }
    }, true);
  });
}

async function deleteStornoBasketItem(id) {
  // Find the basket item so we can show its name in the confirm
  var cache = (typeof _stornoBasketCache !== 'undefined') ? _stornoBasketCache : null;
  var items = (cache && cache.items) || [];
  var item = items.find(function (x) { return x.id === id; });
  var label = item ? (item.qty + '× ' + item.itemName) : ('záznam #' + id);
  var ok = await _confirmStornoDelete(label);
  if (!ok) return;
  try {
    await api.del('/storno-basket/' + id);
    showToast('Záznam zmazaný', true);
    await loadStornoBasket();
    openStornoBasket();
  } catch (e) {
    showToast('Chyba: ' + (e && e.message), 'error');
  }
}

/** Select table and load order without switching view (e.g. initial load). */
async function selectTableAndLoadOrder(id){
  _pendingStorno = [];
  selectedTableId=id;
  const t=TABLES.find(x=>x.id===id);
  document.getElementById('orderTableLabel').textContent=t?t.name:'';
  renderFloor();
  await loadTableOrder(id);
  if (tableOrdersList.length > 1 && isMobile()) {
    showAccountPicker(id, false);
  } else {
    renderOrder();updateQtyBadges();
  }
  if (typeof persistUIState === 'function') persistUIState();
}

async function chipClick(id){
  if (moveMode) { await handleMoveToTable(id); return; }
  await openTable(id);
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(function(){ renderFloor(); }, { timeout: 800 });
  } else {
    setTimeout(renderFloor, 200);
  }
}

async function openTable(id){
  // Auto-send previous table's order before switching
  if(selectedTableId && selectedTableId !== id) {
    var flushed = await flushOrderBeforeTableLeave();
    if (!flushed) return;
  }
  _pendingStorno = [];
  selectedTableId=id;
  const t=TABLES.find(x=>x.id===id);
  document.getElementById('orderTableLabel').textContent=t?t.name:'';

  switchView('products');
  renderOrder();
  updateQtyBadges();

  await loadTableOrder(id);
  if (tableOrdersList.length > 1) {
    showAccountPicker(id, true);
  } else {
    renderOrder();updateQtyBadges();
  }
}

var _apOpenProducts = false;

function showAccountPicker(tableId, openProducts) {
  _apOpenProducts = !!openProducts;
  var t = TABLES.find(function(x) { return x.id === tableId; });
  var tableName = t ? t.name : 'Stol';

  document.getElementById('apTableBadge').textContent = tableName;

  var html = tableOrdersList.map(function(o) {
    var total = o.items ? o.items.reduce(function(s, i) { return s + parseFloat(i.price) * i.qty; }, 0) : 0;
    var count = o.items ? o.items.reduce(function(s, i) { return s + i.qty; }, 0) : 0;
    var itemPreview = o.items ? o.items.slice(0, 4).map(function(i) { return escHtml(i.emoji); }).join(' ') : '';
    if (o.items && o.items.length > 4) itemPreview += ' +' + (o.items.length - 4);

    return '<div class="ap-card" onclick="pickAccount(' + o.id + ',' + _apOpenProducts + ')">' +
      '<div class="ap-card-accent"></div>' +
      '<div class="ap-card-info">' +
        '<div class="ap-card-label">' + escHtml(o.label || 'Ucet') + '</div>' +
        '<div class="ap-card-items">' + (itemPreview || 'Prazdny ucet') + '</div>' +
      '</div>' +
      '<div class="ap-card-right">' +
        '<div class="ap-card-total">' + fmt(total) + '</div>' +
        '<div class="ap-card-count">' + count + ' pol.</div>' +
      '</div>' +
    '</div>';
  }).join('');

  html += '<div class="ap-card-new" onclick="pickNewAccount(' + _apOpenProducts + ')">+ Novy ucet</div>';

  document.getElementById('apCards').innerHTML = html;
  document.getElementById('accountPicker').classList.add('show');
}

function closeAccountPicker() {
  document.getElementById('accountPicker').classList.remove('show');
}

function pickAccount(orderId, openProducts) {
  currentOrderId = orderId;
  var order = tableOrdersList.find(function(o) { return o.id === orderId; });
  currentOrderVersion = order ? (order.version || null) : null;
  if (order) {
    tableOrders[selectedTableId] = order.items.map(function(i) {
      return { id:i.id, name:i.name, emoji:i.emoji, price:parseFloat(i.price), qty:i.qty, note:i.note, menuItemId:i.menuItemId, sent:!!i.sent, _sentQty:i.sent?i.qty:0, discountType:i.discountType||null, discountValue:i.discountValue!=null?parseFloat(i.discountValue):null, discountName:i.discountName||null };
    });
  }
  closeAccountPicker();
  if (openProducts) {
    if (isMobile()) switchMobTab('mobTabMenu');
    else switchView('products');
  }
  renderOrder();updateQtyBadges();
  if (isMobile()) renderMobOrder();
}

async function pickNewAccount(openProducts) {
  try {
    var label = 'Ucet ' + (tableOrdersList.length + 1);
    var newOrder = await api.post('/orders', { tableId: selectedTableId, items: [], label: label });
    currentOrderId = newOrder.id;
    currentOrderVersion = newOrder.version || 1;
    await loadTableOrder(selectedTableId, true);
    closeAccountPicker();
    if (openProducts) {
      if (isMobile()) switchMobTab('mobTabMenu');
      else switchView('products');
    }
    renderOrder();updateQtyBadges();
    if (isMobile()) renderMobOrder();
    showToast('Novy ucet vytvoreny', true);
  } catch(e) {
    showToast(e.message || 'Chyba pri vytvarani uctu', 'error');
  }
}

// Categories
function renderCategories(){
  document.getElementById('categories').innerHTML=Object.entries(MENU).map(([key,cat])=>
    `<button class="cat-btn ${key===activeCategory?'active':''}" onclick="setCategory('${escAttr(key)}')"><span class="cat-icon">${escHtml(cat.icon)}</span>${escHtml(cat.label)}<span class="cat-key">${escHtml(cat.key)}</span></button>`
  ).join('');
}
function setCategory(key){activeCategory=key;searchQuery='';document.getElementById('searchInput').value='';renderCategories();renderProducts();if(typeof persistUIState==='function')persistUIState();}

(function(){var searchTimer=null;document.getElementById('searchInput').addEventListener('input',function(e){searchQuery=e.target.value.toLowerCase().trim();clearTimeout(searchTimer);searchTimer=setTimeout(function(){renderProducts()},200)})})();

// PERF cache: skip full grid rebuild ak sa nezmenila category / search.
// HLAVNÁ NÁPRAVA: predtým kluč obsahoval qtyHash z getOrder() — to
// znamenalo ze tap na druhy stol s rovnakou kategoriou cache MISS
// (qtyHash sa lisi medzi stolmi) -> ~150ms rebuild kazdy raz.
// Teraz: grid HTML zavisi LEN od search + category. Badges per-card
// updatujem osobne cez updateQtyBadges() po renderProducts. Tap na
// rozny stol s rovnakou kategoriou = cache HIT (~5ms) + badge sync.
var _lastProductsRenderKey = null;
function _productsRenderKey(){
  return (searchQuery || '') + '|' + (activeCategory || '');
}

function renderProducts(){
  const grid=document.getElementById('productsGrid');
  // Cache: ak sa rendrovacie inputs nezmenili od minula, skip celý rebuild.
  var key = _productsRenderKey();
  if (key === _lastProductsRenderKey && grid.innerHTML) return;
  _lastProductsRenderKey = key;
  let items;let itemCats={};
  // Logical sort — defined in pos-state.js. Strips volume suffix to a
  // family key and orders alphabetically, then by volume ascending. So
  // 'Urpiner 10° 0,3 l' lands right next to 'Urpiner 10° 0,5 l' instead
  // of being scattered by sales rank. Used in search results and every
  // real category; the '__top__' pseudo-category keeps its sales order.
  const cmpItems = (typeof compareByMenuLogic === 'function') ? compareByMenuLogic
    : ((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
  if(searchQuery){
    items=[];
    Object.entries(MENU).forEach(([cat,c])=>{c.items.forEach(i=>{
      if(i.name.toLowerCase().includes(searchQuery)||i.desc.toLowerCase().includes(searchQuery)){items.push(i);itemCats[i.name]=cat}
    })});
    items.sort(cmpItems);
  } else if (activeCategory === '__top__') {
    // "Najcastejsie" pseudo-category — TOP_ITEMS already carries the same
    // shape as MENU[*].items, so the existing product-card template Just Works.
    // Backend now returns up to 500 ranked items so the same payload also
    // drives in-category sorting; show only the first 12 here.
    var topList = (typeof TOP_ITEMS !== 'undefined' && Array.isArray(TOP_ITEMS)) ? TOP_ITEMS : [];
    items = topList.slice(0, 12);
    // Map each row back to its real category so the per-card accent color
    // (CAT_COLORS lookup in the template) still matches its origin tab.
    items.forEach(function(i){
      var realCat = null;
      Object.entries(MENU).forEach(function(entry){
        var cat = entry[0]; var c = entry[1];
        if (cat === '__top__') return;
        if (c.items && c.items.some(function(m){ return m.id === i.id; })) realCat = cat;
      });
      itemCats[i.name] = realCat || 'jedlo';
    });
  } else {
    if (!activeCategory || !MENU[activeCategory]) { grid.innerHTML=''; return; }
    // Take a copy before sorting so we don't mutate the shared MENU array.
    items=MENU[activeCategory].items.slice().sort(cmpItems);
    items.forEach(i=>{itemCats[i.name]=activeCategory});
  }
  if(!items.length){grid.innerHTML='<div class="products-empty-state" role="status">' +
    '<div class="products-empty-icon" aria-hidden="true">&#128270;</div>' +
    '<div class="products-empty-title">Ziadne vysledky</div>' +
    '<div class="products-empty-hint">Skuste iny nazov alebo kategoriu</div>' +
    '</div>';return}
  const order=getOrder();
  // Aggregate qty per name (skip companion-mirror rows) so the initial render
  // paints .in-cart synchronously — no 1-frame flash before updateQtyBadges().
  const _qtyByName={};
  for(let oi=0;oi<order.length;oi++){
    const _o=order[oi];
    if(_o._companionOf) continue;
    const _k=String(_o.name);
    _qtyByName[_k]=(_qtyByName[_k]||0)+_o.qty;
  }
  grid.innerHTML=items.map((item)=>{
    const cat=itemCats[item.name]||activeCategory;
    const cc=CAT_COLORS[cat]||'150,120,90';
    const q=_qtyByName[item.name]||0;
    const qtyBadge=q>0?`<span class="product-qty-badge">${q}</span>`:'';
    // Photo above name when set; emoji is the fallback when there's no photo.
    const visualHtml = item.imageUrl
      ? `<div class="product-photo" style="background-image:url('${escAttr(item.imageUrl)}')"></div>`
      : `<span class="product-emoji" aria-hidden="true">${(typeof productIconSVG==='function'?productIconSVG(item.name,item.categorySlug):escHtml(item.emoji||''))}</span>`;
    var _esc = escAttr(item.name.replace(/'/g, "\\'"));
    var _emoji = escAttr(item.emoji);
    return `<div class="product-card${item.imageUrl?' has-photo':''}${q>0?' in-cart':''}" data-name="${escAttr(item.name)}" tabindex="0" role="button" style="--cat-color:${cc}" onclick="addToOrderClick('${_esc}','${_emoji}',${item.price})" onpointerdown="ripple(event);_lpStart(event,'${_esc}','${_emoji}',${item.price})" onpointerup="_lpCancel()" onpointerleave="_lpCancel()" onpointercancel="_lpCancel()" oncontextmenu="event.preventDefault()">
      ${qtyBadge}${visualHtml}<div class="product-name">${escHtml(item.name)}</div>${item.desc?`<div class="product-desc">${escHtml(item.desc)}</div>`:''}<div class="product-price">${fmt(item.price)}</div></div>`;
  }).join('');
}

// Update only qty badges without re-rendering entire grid
// When menuItemId is provided, update only that item's card for O(1) performance
// Spec 1.6 + 2.6 — toggle .in-cart on the card too, so cashier sees terra
// border + tint, not just a small corner number. Companion rows (sauce
// auto-mirror) are skipped so their qty doesn't double-count the primary.
function updateQtyBadges(menuItemId){
  const order=getOrder();
  // Aggregate qty per product name, skipping companion-mirror rows.
  var totals={};
  for(var i=0;i<order.length;i++){
    var o=order[i];
    if(o._companionOf) continue;
    var k=String(o.name);
    totals[k]=(totals[k]||0)+o.qty;
  }
  function applyToCard(card){
    var name=card.getAttribute('data-name');
    var q=totals[name]||0;
    var badge=card.querySelector('.product-qty-badge');
    if(q>0){
      card.classList.add('in-cart');
      if(badge){badge.textContent=q}
      else{badge=document.createElement('span');badge.className='product-qty-badge';badge.textContent=q;card.prepend(badge)}
    } else {
      card.classList.remove('in-cart');
      if(badge)badge.remove();
    }
  }
  if(menuItemId){
    // Targeted update — find the specific card by data-name
    var itemName=null;
    for(var j=0;j<order.length;j++){if(order[j].menuItemId===menuItemId){itemName=order[j].name;break}}
    // Also check MENU_ID_MAP reverse lookup if item was just removed
    if(!itemName){MENU_ID_MAP.forEach(function(id,name){if(id===menuItemId)itemName=name})}
    if(itemName){
      var card=document.querySelector('.product-card[data-name="'+itemName.replace(/"/g,'\\"')+'"]');
      if(card)applyToCard(card);
      return;
    }
  }
  // Full update fallback (used after sync, table switch, etc.)
  document.querySelectorAll('.product-card').forEach(applyToCard);
}

function ripple(e){
  const card=e.currentTarget;
  const rect=card.getBoundingClientRect();
  const x=((e.clientX-rect.left)/rect.width*100).toFixed(0);
  const y=((e.clientY-rect.top)/rect.height*100).toFixed(0);
  card.style.setProperty('--ripple-x',x+'%');
  card.style.setProperty('--ripple-y',y+'%');
  card.classList.add('ripple');
  setTimeout(()=>card.classList.remove('ripple'),400);
}

// ===== Long-press qty popup on product cards =====
// 5 people order Pivo → 1 long-press → tap +5 instead of 5 separate taps.
// Detector lives on the card template itself (onpointerdown/up/leave) so we
// don't have to delegate; the click is then short-circuited by addToOrderClick
// when _lpFired is true so a single tap still adds 1 normally.
var _lpTimer = null;
var _lpFired = false;
var _lpStartX = 0, _lpStartY = 0;
function _lpStart(ev, name, emoji, price) {
  if (ev.button !== undefined && ev.button !== 0) return; // ignore right/middle click
  _lpFired = false;
  _lpCancel();
  _lpStartX = ev.clientX || 0;
  _lpStartY = ev.clientY || 0;
  _lpTimer = setTimeout(function () {
    _lpFired = true;
    _showQtyPopup(ev, name, emoji, price);
  }, 500);
}
function _lpCancel() {
  if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; }
}
function addToOrderClick(name, emoji, price) {
  // Long-press already showed the popup; swallow the trailing click.
  if (_lpFired) { _lpFired = false; return; }
  addToOrder(name, emoji, price);
}
function _showQtyPopup(ev, name, emoji, price) {
  var existing = document.getElementById('qtyPopup');
  if (existing) existing.remove();

  var p = document.createElement('div');
  p.id = 'qtyPopup';
  p.setAttribute('role', 'dialog');
  p.setAttribute('aria-label', 'Pridať viac kusov');
  p.style.cssText = 'position:fixed;z-index:300;display:flex;gap:8px;padding:10px;background:rgba(8,14,20,.96);border:1px solid rgba(255,255,255,.12);border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.5);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)';

  var qtys = [1, 2, 3, 5, 10];
  qtys.forEach(function (q) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = '+' + q;
    b.style.cssText = 'min-width:54px;min-height:54px;padding:0;background:var(--color-accent);color:#fff;border:none;border-radius:10px;font-size:18px;font-weight:700;cursor:pointer;touch-action:manipulation';
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      if (typeof addToOrderN === 'function') addToOrderN(name, emoji, price, q);
      else { for (var i = 0; i < q; i++) addToOrder(name, emoji, price); }
      // Mobile parity: addToOrder's fast-path only refreshes the desktop
      // panel, so on a phone refresh the mobile menu badges + tab badge.
      if (typeof isMobile === 'function' && isMobile()) {
        if (typeof renderMobMenu === 'function') renderMobMenu();
        if (typeof renderMobOrder === 'function') renderMobOrder();
        if (typeof updateMobBadge === 'function') updateMobBadge();
      }
      if (p.parentNode) p.remove();
    });
    p.appendChild(b);
  });
  document.body.appendChild(p);

  // Position near touch — clamp to viewport so the whole row stays visible.
  var x = ev.clientX || (ev.touches && ev.touches[0] && ev.touches[0].clientX) || _lpStartX || 100;
  var y = ev.clientY || (ev.touches && ev.touches[0] && ev.touches[0].clientY) || _lpStartY || 100;
  var rect = p.getBoundingClientRect();
  var vw = window.innerWidth, vh = window.innerHeight;
  var left = Math.min(Math.max(8, x - rect.width / 2), vw - rect.width - 8);
  var top = Math.min(Math.max(8, y - rect.height - 16), vh - rect.height - 8);
  p.style.left = left + 'px';
  p.style.top = top + 'px';

  // Dismiss on outside tap (defer to skip the same pointer event that opened it).
  setTimeout(function () {
    function dismiss(e) {
      if (!p.contains(e.target)) {
        if (p.parentNode) p.remove();
        document.removeEventListener('pointerdown', dismiss, true);
        document.removeEventListener('keydown', escDismiss, true);
      }
    }
    function escDismiss(e) {
      if (e.key === 'Escape') {
        if (p.parentNode) p.remove();
        document.removeEventListener('pointerdown', dismiss, true);
        document.removeEventListener('keydown', escDismiss, true);
      }
    }
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('keydown', escDismiss, true);
  }, 0);
}

// ===== Live table status badge in the order panel header =====
// Sits next to "Stol N" so the cashier sees, at a glance, whether the table
// is free, just opened (dwell time), or has items already in the kitchen.
function _renderTableStatus() {
  var label = document.getElementById('orderTableLabel');
  if (!label || !label.parentNode) return;
  var el = document.getElementById('tableStatusBadge');
  if (!el) {
    el = document.createElement('span');
    el.id = 'tableStatusBadge';
    // Rozmery aj farby su v css/pos.css (.table-status-badge) — inline styl
    // sa nedal preladit temou ani zosuladit s tokenmi.
    el.className = 'table-status-badge';
    label.parentNode.insertBefore(el, label.nextSibling);
  }

  var t = (typeof TABLES !== 'undefined' && Array.isArray(TABLES) && typeof selectedTableId !== 'undefined')
    ? TABLES.find(function (x) { return x.id === selectedTableId; })
    : null;

  // No table selected → hide the badge.
  if (!t) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;

  var status = t.status;

  // Pick the active order for time + sent-qty stats.
  var ord = null;
  if (typeof tableOrdersList !== 'undefined' && tableOrdersList.length) {
    ord = tableOrdersList.find(function (o) { return o.id === currentOrderId; }) || tableOrdersList[0];
  }

  var minutesOpen = null;
  if (ord && ord.createdAt) {
    var ms = Date.now() - new Date(ord.createdAt).getTime();
    if (!isNaN(ms) && ms >= 0) minutesOpen = Math.floor(ms / 60000);
  }

  // Items already sent to kitchen (server-side flag mirrored locally).
  var sentQty = 0;
  var localItems = (typeof tableOrders !== 'undefined' && tableOrders[selectedTableId]) || [];
  for (var i = 0; i < localItems.length; i++) {
    if (localItems[i] && localItems[i].sent) sentQty += (localItems[i].qty || 0);
  }
  // If we have no local items yet but the active order from the server has sent items, fall back to it.
  if (!sentQty && ord && ord.items) {
    for (var j = 0; j < ord.items.length; j++) {
      if (ord.items[j] && ord.items[j].sent) sentQty += (ord.items[j].qty || 0);
    }
  }

  var text, cls;
  var since = formatOpenDuration(minutesOpen);
  if (status === 'free' || (!ord && !localItems.length)) {
    text = '🟢 voľný';
    cls = 'tsb-free';
  } else if (sentQty > 0) {
    text = '📤 ' + sentQty + ' ks v kuchyni' + (since ? ' · ' + since : '');
    cls = 'tsb-sent';
  } else {
    text = '🟠 otvorený' + (since ? ' ' + since : '');
    cls = 'tsb-open';
  }
  el.textContent = text;
  // Farby cez triedy v css/pos.css, nie inline hex.
  // Predtým tu boli natvrdo #5CC49E / #8B7CF6 / #E0A830 — hodnoty z VYRADENEJ
  // fialovej palety. Na krémovom podklade mali kontrast ~1,5–2,4:1 (teda text
  // sa prakticky nedal prečítať) a v tmavom režime sa nemenili vôbec.
  el.className = 'table-status-badge ' + cls;
  el.style.background = '';
  el.style.color = '';
}

/**
 * Ľudsky čitateľné trvanie otvoreného účtu.
 * Predtým sa vypisovali surové minúty, takže účet otvorený pred tromi mesiacmi
 * hlásil „147560 min" — číslo, ktoré obsluhe nič nehovorí a v paneli zaberá
 * pol riadku.
 * @param {number|null} minutes
 * @returns {string} '' keď nie je čo zobraziť
 */
function formatOpenDuration(minutes) {
  if (minutes == null || !isFinite(minutes) || minutes < 0) return '';
  if (minutes < 60) return minutes + ' min';
  var hours = Math.floor(minutes / 60);
  if (hours < 24) {
    var rem = minutes % 60;
    return rem ? (hours + ' h ' + rem + ' m') : (hours + ' h');
  }
  var days = Math.floor(hours / 24);
  if (days === 1) return '1 deň';
  if (days < 5) return days + ' dni';
  return days + ' dní';
}
if (typeof window !== 'undefined') window.formatOpenDuration = formatOpenDuration;

/**
 * Group order rows for DISPLAY by (menuItemId, note) — zlučuje sent +
 * unsent páry do jedinej radky. Order array sa nemení (sync s serverom
 * naďalej posiela oddelené rady), iba render layer ich zobrazí ako jednu.
 *
 * User UX request: pri klepnutí + na poslanú položku sa nemá zjaviť nová
 * unsent rada navrchu — má sa zvýšiť qty existujúcej rady a zelená sa
 * stratí (lebo qty > sentQty). Pri − dolu kým unsent delta > 0 zelená
 * sa vráti keď qty == sentQty.
 *
 * Logika:
 *   - sent row + unsent twin so zhodným menuItemId+note → 1 display row
 *   - row.qty = súčet, row._sentQty = sent portion, row.id = sent ID
 *     (preferujeme stable server id pre routing button clicks)
 *   - row.sent = true ak any sent (kompatibilita s existujúcim kódom)
 *   - row._hasUnsentDelta = true ak qty > sentQty
 *
 * Companion rows (_companionOf) sa nemerge-ujú — patria k svojmu primary.
 */
function _groupOrderForDisplay(order) {
  if (!order || !order.length) return [];
  var merged = [];
  var seenIdx = Object.create(null);
  for (var i = 0; i < order.length; i++) {
    var item = order[i];
    if (item._companionOf) {
      // Companion (napr. Zaloha flase) ostáva ako separátna rada
      merged.push(item);
      continue;
    }
    var key = item.menuItemId + '|' + (item.note || '');
    if (seenIdx[key] === undefined) {
      // Plytka copy — nemenime original v `order`
      var clone = {};
      for (var k in item) if (Object.prototype.hasOwnProperty.call(item, k)) clone[k] = item[k];
      clone.qty = item.qty;
      clone._sentQty = item.sent ? item.qty : 0;
      clone._hasUnsentDelta = !item.sent;
      seenIdx[key] = merged.length;
      merged.push(clone);
    } else {
      var existing = merged[seenIdx[key]];
      existing.qty += item.qty;
      if (item.sent) {
        existing._sentQty += item.qty;
        // Prefer sent row's id pre routing — server-stable
        existing.id = item.id;
        existing.sent = true;
      } else {
        existing._hasUnsentDelta = true;
      }
    }
  }
  return merged;
}

function renderOrder(){
  const order=getOrder(),c=document.getElementById('orderItems');
  const countEl=document.getElementById('orderCount');
  const newCount=order.reduce((s,o)=>s+o.qty,0);
  const oldCount=parseInt(countEl.textContent)||0;
  countEl.textContent=newCount;
  countEl.classList.toggle('zero',newCount===0);
  if(newCount!==oldCount&&newCount>0){countEl.classList.add('bump');setTimeout(()=>countEl.classList.remove('bump'),250)}
  _renderTableStatus();
  // Render account tabs (rich: label + meta with item count & total)
  var tabsEl=document.getElementById('orderTabs');
  var orderPanel=document.getElementById('orderItems');
  if(tabsEl){
    if(tableOrdersList.length>1){
      tabsEl.setAttribute('role','tablist');
      tabsEl.setAttribute('aria-label','Ucty pri stole');
      var tabsHtml=tableOrdersList.map(function(o){
        var isActive=o.id===currentOrderId;
        var cnt=o.items?o.items.reduce(function(s,i){return s+i.qty},0):0;
        var tot=o.items?o.items.reduce(function(s,i){return s+parseFloat(i.price)*i.qty},0):0;
        if(moveMode&&!isActive){
          // In move mode: non-active tabs are drop targets
          return '<button type="button" class="order-tab" role="tab" onclick="moveToTab('+o.id+')" title="Presunut sem"><span class="tab-label">'+escHtml(o.label||'Ucet')+' &#8599;</span><span class="tab-meta">'+cnt+' pol. &middot; '+fmt(tot)+'</span></button>';
        }
        return '<button type="button" class="order-tab'+(isActive?' active':'')+'" role="tab" id="order-tab-'+o.id+'" aria-selected="'+isActive+'" aria-controls="orderItems" onclick="switchAccount('+o.id+')"><span class="tab-label">'+escHtml(o.label||'Ucet')+'</span><span class="tab-meta">'+cnt+' pol. &middot; '+fmt(tot)+'</span></button>';
      }).join('');
      if(moveMode){
        tabsHtml+='<button type="button" class="order-tab move-new-target" onclick="moveToNewAccountInline()">+ Novy ucet</button>';
        tabsHtml+='<button type="button" class="order-tab move-table-target" onclick="showTablePicker()">Na iny stol</button>';
        tabsHtml+='<button type="button" class="order-tab order-tab-cancel" onclick="exitMoveMode()">Zrusit</button>';
      } else {
        tabsHtml+='<button type="button" class="order-tab order-tab-new" onclick="newAccount()" aria-label="Novy ucet">+</button>';
        tabsHtml+='<button type="button" class="order-tab order-tab-merge" onclick="mergeAccounts()" title="Spojit ucty">&#x21C4;</button>';
      }
      tabsEl.innerHTML=tabsHtml;
      tabsEl.classList.remove('pos-hidden');
    } else if(tableOrdersList.length===1){
      tabsEl.setAttribute('role','tablist');
      tabsEl.setAttribute('aria-label','Ucet');
      var o1=tableOrdersList[0];
      var cnt1=o1.items?o1.items.reduce(function(s,i){return s+i.qty},0):0;
      var tot1=o1.items?o1.items.reduce(function(s,i){return s+parseFloat(i.price)*i.qty},0):0;
      var singleHtml='<button type="button" class="order-tab active" role="tab" id="order-tab-single" aria-selected="true" aria-controls="orderItems"><span class="tab-label">'+escHtml(o1.label||'Ucet 1')+'</span><span class="tab-meta">'+cnt1+' pol. &middot; '+fmt(tot1)+'</span></button>';
      if(moveMode){
        singleHtml+='<button type="button" class="order-tab move-new-target" onclick="moveToNewAccountInline()">+ Novy ucet</button>';
        singleHtml+='<button type="button" class="order-tab move-table-target" onclick="showTablePicker()">Na iny stol</button>';
        singleHtml+='<button type="button" class="order-tab order-tab-cancel" onclick="exitMoveMode()">Zrusit</button>';
      } else {
        singleHtml+='<button type="button" class="order-tab order-tab-new" onclick="newAccount()" aria-label="Novy ucet">+</button>';
      }
      tabsEl.innerHTML=singleHtml;
      tabsEl.classList.remove('pos-hidden');
    } else {
      tabsEl.removeAttribute('role');
      tabsEl.removeAttribute('aria-label');
      tabsEl.innerHTML='';tabsEl.classList.add('pos-hidden');
    }
  }
  if(orderPanel){
    if(tableOrdersList.length)orderPanel.setAttribute('role','tabpanel');
    else orderPanel.removeAttribute('role');
  }
  if(!order.length){c.innerHTML=`<div class="order-empty"><div class="order-empty-icon"><svg viewBox="0 0 64 64" width="56" height="56" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 18h40v40H12z"/><path d="M18 26h28M18 32h28M18 38h20"/><circle cx="32" cy="10" r="4"/><path d="M28 10h-4M40 10h-4"/></svg></div><div class="order-empty-title">Prazdna objednavka</div><div class="order-empty-text">Pridajte polozky z menu alebo kliknite na stol</div><div class="order-empty-hint"><span>&#8592;</span> Vyberte z menu</div></div>`}
  else{
    // GROUP display: sent + unsent páry sa zlúčia do jednej rady. Zelená
    // (sent indikátor) je True iba ak qty == sentQty (všetko poslané).
    var displayOrder = _groupOrderForDisplay(order);
    var sorted=displayOrder.sort(function(a,b){return (b.id||0)-(a.id||0)});
    c.innerHTML=sorted.map(o=>{
    const esc=escAttr(o.name.replace(/'/g,"\\'"));
    // Sent indikator = "all sent" — iba ak qty matches sentQty (no unsent delta)
    const _isSent = o.sent && !o._hasUnsentDelta;
    // Po refaktore moveSelectedItems = [{id, qty}]. Pomocou _moveSelectionQtyFor
    // zistíme či je item vybraný a aký qty (null = celé). Ak je qty kratšie
    // ako pôvodné, ukážeme badge "qty/total" aby operátor videl o koľko ide.
    const _selectedQty=moveMode?_moveSelectionQtyFor(o.id):null;
    const _moveSelected=moveMode && (_selectedQty!=null || _findSelectedIdx(o.id)>=0);
    const _movePartialBadge=(moveMode && _selectedQty!=null && _selectedQty<o.qty)
      ? `<span class="move-partial-badge" style="margin-left:6px;font-size:11px;padding:2px 6px;border-radius:6px;background:rgba(245,158,11,.18);color:#f59e0b;font-weight:700">${_selectedQty}/${o.qty}</span>`
      : '';
    // Companion rows (auto-mirrored qty, e.g. Záloha fľaša) get a small chain badge
    // so cashiers know "where this row came from" — primary stays unchanged.
    const _isCompanion=!!o._companionOf;
    const _parent=_isCompanion?order.find(function(p){return p.id===o._companionOf}):null;
    const _parentName=_parent?_parent.name:'';
    const _companionBadge=_isCompanion?`<span class="companion-badge" title="Auto: viazane na ${escHtml(_parentName)}" style="margin-left:6px;opacity:.6;font-size:14px">&#128279;</span>`:'';
    const _companionTitleAttr=_isCompanion?` title="Auto: viazane na ${escHtml(_parentName)}"`:'';
    // Per-item zľava — derived live so it tracks local qty edits.
    const _itemDisc=(typeof itemLineDiscount==='function')?itemLineDiscount(o):0;
    const _gross=o.price*o.qty;
    const _net=_gross-_itemDisc;
    const _hasItemDisc=_itemDisc>0.005;
    const _discText=o.discountName||(o.discountType==='percent'?('-'+o.discountValue+'%'):('-'+fmt(o.discountValue||0)));
    const _discBadge=_hasItemDisc?`<span class="oi-disc-badge" title="Zlava na polozku">${escHtml(_discText)}</span>`:'';
    const _totalHtml=_hasItemDisc?`<span class="oi-gross">${fmt(_gross)}</span><span class="oi-net">${fmt(_net)}</span>`:fmt(_gross);
    const _canDiscount=(typeof getUserRole==='function'&&getUserRole()!=='cisnik');
    const _discBtn=_canDiscount?`<button type="button" class="order-item-disc-btn${_hasItemDisc?' has-disc':''}" onclick="event.stopPropagation();openItemDiscountModal('${esc}', ${o.id})" aria-label="${_hasItemDisc?'Upravit zlavu polozky':'Zlava na polozku'}" title="${_hasItemDisc?'Upravit zlavu polozky':'Zlava na polozku'}">%</button>`:'';
    if(moveMode){
      return `<div class="order-item-wrap${_moveSelected?' move-selected':''}" data-item-id="${o.id}"${_companionTitleAttr} onclick="toggleMoveSelection(${o.id})">
  <div class="order-item-inner${_isSent?' sent':''}"><div class="move-sel">${_moveSelected?'&#10003;':''}</div><span class="order-item-emoji" aria-hidden="true">${(typeof productIconSVG==='function'?productIconSVG(o.name,o.categorySlug):escHtml(o.emoji||''))}</span>
  <div class="order-item-info"><div class="order-item-name">${escHtml(o.name)}${_movePartialBadge}</div>${o.note?`<div class="order-item-note">${escHtml(o.note)}</div>`:''}</div>
  <span class="order-item-total">${o.qty}x${_companionBadge} &middot; ${_totalHtml}</span></div>
</div>`;
    }
    return `<div class="order-item-wrap" data-item-id="${o.id}"${_companionTitleAttr} ontouchstart="swipeStart(event,this)" ontouchmove="swipeMove(event,this)" ontouchend="swipeEnd(event,this)" onmousedown="swipeStart(event,this)" onmousemove="swipeMove(event,this)" onmouseup="swipeEnd(event,this)">
  <div class="order-item-inner${_isSent?' sent':''}">
    <span class="order-item-emoji" aria-hidden="true">${(typeof productIconSVG==='function'?productIconSVG(o.name,o.categorySlug):escHtml(o.emoji||''))}</span>
    <div class="order-item-stack">
      <div class="order-item-info">
        <div class="order-item-name-row">
          <div class="order-item-name">${escHtml(o.name)}${_discBadge}</div>
          <button type="button" class="order-item-note-btn${o.note?' has-note':''}" onclick="event.stopPropagation();openNoteModal('${esc}', ${o.id})" aria-label="${o.note?'Upravit poznamku':'Pridat poznamku'}" title="${o.note?'Upravit poznamku':'Pridat poznamku'}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
          </button>${_discBtn}
        </div>
        ${o.note?`<div class="order-item-note">&#9998; ${escHtml(o.note)}</div>`:''}
      </div>
      <div class="order-item-controls">
        <div class="order-item-qty">
          <button type="button" class="qty-btn" onclick="event.stopPropagation();changeQty('${esc}', -1, ${o.id})" onpointerdown="startQtyHold('${esc}', -1, ${o.id})" aria-label="Znizit pocet">&minus;</button>
          <span class="qty-val">${o.qty}</span>${_companionBadge}
          <button type="button" class="qty-btn" onclick="event.stopPropagation();changeQty('${esc}', 1, ${o.id})" onpointerdown="startQtyHold('${esc}', 1, ${o.id})" aria-label="Zvysit pocet">+</button>
        </div>
        <div class="order-item-total">${_totalHtml}</div>
        <button type="button" class="order-item-remove" onclick="event.stopPropagation();confirmRemoveItem('${esc}', ${o.id})" aria-label="Odstranit polozku">&times;</button>
      </div>
    </div>
  </div>
  <div class="order-item-swipe-left"><button class="swipe-btn swipe-btn-move" onclick="enterMoveMode(${o.id})" aria-label="Presunut polozku">&#8599;</button><button class="swipe-btn swipe-btn-note" onclick="openNoteModal('${esc}', ${o.id})" aria-label="Poznamka">&#9998;</button><button class="swipe-btn swipe-btn-del" onclick="confirmRemoveItem('${esc}', ${o.id})" aria-label="Odstranit polozku">&#10005;</button></div>
</div>`}).join('')}
  // has-pending toggles a subtle CSS animation on btnSend (line 2832).
  // Disabled/primary-emphasis is now governed centrally by _applyActionButtonState below.
  const btnSend=document.getElementById('btnSend');
  if(btnSend){btnSend.classList.toggle('has-pending',order.some(function(o){return o&&!o.sent;}));}
  updateTotals();
  _applyActionButtonState();
}
function updateTotals(){
  const order=getOrder(),subtotal=order.reduce((s,o)=>s+o.price*o.qty,0);
  const currentOrd=tableOrdersList.find(o=>o.id===currentOrderId);
  const orderDiscAmt=currentOrd&&currentOrd.discountAmount?parseFloat(currentOrd.discountAmount):0;
  const itemDiscAmt=(typeof orderItemsDiscountTotal==='function')?orderItemsDiscountTotal():0;
  const totalDisc=Math.min(subtotal,Math.round((orderDiscAmt+itemDiscAmt)*100)/100);
  const disc=currentOrd?currentOrd.discount:null;
  const discDisplay=document.getElementById('discountDisplay');
  if(totalDisc>0.005&&discDisplay){
    discDisplay.classList.remove('pos-hidden');
    document.getElementById('subtotalVal').textContent=fmt(subtotal);
    var lbl;
    if(orderDiscAmt>0&&itemDiscAmt>0){
      lbl='Zlava (ucet + polozky)';
    }else if(itemDiscAmt>0){
      lbl='Zlava na polozky';
    }else if(disc){
      lbl=disc.name||(disc.type==='percent'?'Zlava -'+disc.value+'%':'Zlava -'+fmt(disc.value));
    }else if(currentOrd&&currentOrd.discountAmount&&!currentOrd.discountId){
      var pct=subtotal>0?Math.round(orderDiscAmt/subtotal*100):0;
      lbl='Zlava -'+pct+'%';
    }else{
      lbl='Zlava';
    }
    // The × removes only the ORDER-level discount; per-item zľavy sa rušia
    // priamo na riadku (tlačidlo % → Odstrániť).
    var removeBtn=orderDiscAmt>0?' <button class="discount-remove" onclick="removeDiscount()" title="Odstranit zlavu uctu" aria-label="Odstranit zlavu uctu">&times;</button>':'';
    document.getElementById('discountLabel').innerHTML=escHtml(lbl)+removeBtn;
    document.getElementById('discountVal').textContent='-'+fmt(totalDisc);
    document.getElementById('total').textContent=fmt(Math.max(0,subtotal-totalDisc));
  }else{
    if(discDisplay)discDisplay.classList.add('pos-hidden');
    document.getElementById('total').textContent=fmt(subtotal);
  }
  _applyActionButtonState();
}

// ===== DISCOUNT SYSTEM =====
var _selectedDiscountId=null;

function showDiscountModal(){
  var role=getUserRole();
  if(role==='cisnik'){showToast('Zlavu moze aplikovat len manazer/admin');return}
  if(!currentOrderId){showToast('Ziadna objednavka');return}
  _selectedDiscountId=null;
  document.getElementById('customDiscountInput').value='';
  var listEl=document.getElementById('discountList');
  listEl.innerHTML='<div class="u-modal-loading">Nacitavam...</div>';
  document.getElementById('discountModal').classList.add('show');
  api.get('/discounts').then(function(dList){
    if(!dList.length){
      listEl.innerHTML='<div class="discount-list-empty">Ziadne preddefinovane zlavy</div>';
      return;
    }
    listEl.innerHTML=dList.map(function(d){
      var valLabel=d.type==='percent'?('-'+d.value+'%'):('-'+d.value.toFixed(2)+' EUR');
      return '<div class="discount-item" data-id="'+d.id+'" onclick="selectDiscount('+d.id+',this)"><span class="discount-item-name">'+escHtml(d.name)+'</span><span class="discount-item-value">'+escHtml(valLabel)+'</span></div>';
    }).join('');
  }).catch(function(){
    listEl.innerHTML='<div class="discount-list-error">Chyba nacitania</div>';
  });
}

function closeDiscountModal(){
  document.getElementById('discountModal').classList.remove('show');
  _selectedDiscountId=null;
}

function selectDiscount(id,el){
  document.querySelectorAll('#discountList .discount-item').forEach(function(e){e.classList.remove('selected')});
  if(_selectedDiscountId===id){_selectedDiscountId=null;return}
  _selectedDiscountId=id;
  el.classList.add('selected');
  document.getElementById('customDiscountInput').value='';
}

async function applyDiscount(){
  if(!currentOrderId){showToast('Ziadna objednavka');return}
  var customPct=parseInt(document.getElementById('customDiscountInput').value);
  var body={};
  if(_selectedDiscountId){
    body.discountId=_selectedDiscountId;
  }else if(customPct>0&&customPct<=100){
    body.customPercent=customPct;
  }else{
    showToast('Vyberte zlavu alebo zadajte vlastnu');return;
  }
  if(currentOrderVersion!==null) body.version=currentOrderVersion;
  try{
    await api.post('/orders/'+currentOrderId+'/discount',body);
    closeDiscountModal();
    await loadTableOrder(selectedTableId, true);
    renderOrder();if(isMobile())renderMobOrder();
    showToast('Zlava aplikovana',true);
  }catch(e){
    showToast('Chyba: '+e.message);
  }
}

async function removeDiscount(){
  if(!currentOrderId)return;
  showConfirm('Odstranit zlavu','Naozaj chcete odstranit zlavu z objednavky?',async function(){
    try{
      await api.del('/orders/'+currentOrderId+'/discount', { version: currentOrderVersion });
      await loadTableOrder(selectedTableId, true);
      renderOrder();if(isMobile())renderMobOrder();
      showToast('Zlava odstranena');
    }catch(e){
      showToast('Chyba: '+e.message);
    }
  },{type:'danger',confirmText:'Odstranit'});
}

// Listen for custom discount input to deselect predefined
document.addEventListener('DOMContentLoaded',function(){
  var ci=document.getElementById('customDiscountInput');
  if(ci)ci.addEventListener('input',function(){
    if(this.value){
      _selectedDiscountId=null;
      document.querySelectorAll('#discountList .discount-item').forEach(function(e){e.classList.remove('selected')});
    }
  });
  // Close discount modal on backdrop click
  var dm=document.getElementById('discountModal');
  if(dm)dm.addEventListener('click',function(e){if(e.target===this)closeDiscountModal()});
});

// ===== PER-ITEM DISCOUNT (zľava na položku) =====
var _selectedItemDiscountId=null;
var _itemDiscountTargetId=null;

function openItemDiscountModal(esc,itemId){
  var role=getUserRole();
  if(role==='cisnik'){showToast('Zlavu moze aplikovat len manazer/admin');return}
  if(!currentOrderId){showToast('Ziadna objednavka');return}
  // Lokálne (ešte nesynchronizované) položky nemajú serverové id.
  if(typeof itemId==='number'&&itemId>1000000000){showToast('Najprv posli polozku do kuchyne');return}
  var item=getOrder().find(function(o){return o.id===itemId});
  if(!item){showToast('Polozka nenajdena');return}
  _itemDiscountTargetId=itemId;
  _selectedItemDiscountId=null;
  var hasDisc=(typeof itemLineDiscount==='function')&&itemLineDiscount(item)>0.005;
  var titleEl=document.getElementById('itemDiscountModalTitle');
  if(titleEl)titleEl.textContent='Zlava: '+(item.name||'polozka');
  var rmBtn=document.getElementById('itemDiscountRemoveBtn');
  if(rmBtn)rmBtn.style.display=hasDisc?'':'none';
  var ci=document.getElementById('customItemDiscountInput');
  if(ci)ci.value='';
  var listEl=document.getElementById('itemDiscountList');
  listEl.innerHTML='<div class="u-modal-loading">Nacitavam...</div>';
  document.getElementById('itemDiscountModal').classList.add('show');
  api.get('/discounts').then(function(dList){
    if(!dList.length){
      listEl.innerHTML='<div class="discount-list-empty">Ziadne preddefinovane zlavy</div>';
      return;
    }
    listEl.innerHTML=dList.map(function(d){
      var valLabel=d.type==='percent'?('-'+d.value+'%'):('-'+d.value.toFixed(2)+' EUR');
      return '<div class="discount-item" data-id="'+d.id+'" onclick="selectItemDiscount('+d.id+',this)"><span class="discount-item-name">'+escHtml(d.name)+'</span><span class="discount-item-value">'+escHtml(valLabel)+'</span></div>';
    }).join('');
  }).catch(function(){
    listEl.innerHTML='<div class="discount-list-error">Chyba nacitania</div>';
  });
}

function closeItemDiscountModal(){
  document.getElementById('itemDiscountModal').classList.remove('show');
  _selectedItemDiscountId=null;
  _itemDiscountTargetId=null;
}

function selectItemDiscount(id,el){
  document.querySelectorAll('#itemDiscountList .discount-item').forEach(function(e){e.classList.remove('selected')});
  if(_selectedItemDiscountId===id){_selectedItemDiscountId=null;return}
  _selectedItemDiscountId=id;
  el.classList.add('selected');
  var ci=document.getElementById('customItemDiscountInput');
  if(ci)ci.value='';
}

async function applyItemDiscount(){
  if(!currentOrderId||!_itemDiscountTargetId){showToast('Ziadna polozka');return}
  var customPct=parseInt(document.getElementById('customItemDiscountInput').value);
  var body={};
  if(_selectedItemDiscountId){
    body.discountId=_selectedItemDiscountId;
  }else if(customPct>0&&customPct<=100){
    body.customPercent=customPct;
  }else{
    showToast('Vyberte zlavu alebo zadajte vlastnu');return;
  }
  if(currentOrderVersion!==null)body.version=currentOrderVersion;
  var itemId=_itemDiscountTargetId;
  try{
    await api.post('/orders/'+currentOrderId+'/items/'+itemId+'/discount',body);
    closeItemDiscountModal();
    await loadTableOrder(selectedTableId,true);
    renderOrder();if(isMobile())renderMobOrder();
    showToast('Zlava na polozku aplikovana',true);
  }catch(e){
    showToast('Chyba: '+e.message);
  }
}

async function removeItemDiscount(){
  if(!currentOrderId||!_itemDiscountTargetId)return;
  var itemId=_itemDiscountTargetId;
  try{
    await api.del('/orders/'+currentOrderId+'/items/'+itemId+'/discount',{ version: currentOrderVersion });
    closeItemDiscountModal();
    await loadTableOrder(selectedTableId,true);
    renderOrder();if(isMobile())renderMobOrder();
    showToast('Zlava z polozky odstranena');
  }catch(e){
    showToast('Chyba: '+e.message);
  }
}

document.addEventListener('DOMContentLoaded',function(){
  var ci=document.getElementById('customItemDiscountInput');
  if(ci)ci.addEventListener('input',function(){
    if(this.value){
      _selectedItemDiscountId=null;
      document.querySelectorAll('#itemDiscountList .discount-item').forEach(function(e){e.classList.remove('selected')});
    }
  });
  var dm=document.getElementById('itemDiscountModal');
  if(dm)dm.addEventListener('click',function(e){if(e.target===this)closeItemDiscountModal()});
});

// Keep the "X min" portion of the order header status badge fresh without
// forcing a full renderOrder pass.
setInterval(function(){
  if (typeof _renderTableStatus === 'function') {
    try { _renderTableStatus(); } catch (e) { /* badge is non-essential */ }
  }
}, 60000);
