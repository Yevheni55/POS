'use strict';
// pos-render.js — All rendering/UI functions: clock, views, floor, categories, products, order, discounts

// Clock
function updateClock(){
  const n=new Date();
  document.getElementById('clock').textContent=String(n.getHours()).padStart(2,'0')+':'+String(n.getMinutes()).padStart(2,'0');
  const d=['Nedela','Pondelok','Utorok','Streda','Stvrtok','Piatok','Sobota'];
  const m=['jan','feb','mar','apr','maj','jun','jul','aug','sep','okt','nov','dec'];
  document.getElementById('date').textContent=`${d[n.getDay()]}, ${n.getDate()}. ${m[n.getMonth()]}`;
}
updateClock();setInterval(updateClock,30000);

// View toggle
function _toastSendKitchenError(err){
  var msg=(err&&err.message)?('Chyba odoslania: '+err.message):'Nepodarilo sa odoslat na kuchynu';
  if(typeof showToast==='function')showToast(msg,'error');
}

var _tableLeaveFlushPromise = null;

function hasPendingOrderFlushState() {
  return !!(_orderDirty || (_pendingStorno && _pendingStorno.length) || getOrder().length);
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
      return false;
    })
    .finally(function() {
      _tableLeaveFlushPromise = null;
    });

  return _tableLeaveFlushPromise;
}

async function switchView(v){
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
  if(v==='tables')renderFloor();if(v==='products')renderProducts();
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
  if(!editMode)savePositions();
  renderFloor();
}

// Floor zones
function renderFloorZones(){
  document.getElementById('floorZones').innerHTML=ZONES.map(z=>
    `<button class="zone-btn ${z.id===activeZone?'active':''}" onclick="setZone('${escAttr(z.id)}')">${escHtml(z.label)}</button>`
  ).join('');
}
function setZone(id){activeZone=id;renderFloorZones();renderFloor()}

// Floor canvas — absolute-pixel positioning, identical coordinate system to admin.
// Admin drag-and-drop on /admin#tables writes the same (x,y) integers we read here.
// Canvas becomes scrollable if tables extend beyond its visible area.
function renderFloor(){
  const canvas=document.getElementById('floorCanvas');
  if(!canvas)return;
  const filtered=TABLES.filter(t=>t.zone===activeZone);
  const sl={free:'Volny',occupied:'Obsad.',reserved:'Rez.',dirty:'Cistit'};
  const titles={free:'Otvorit objednavku',occupied:'Zobrazit ucet',reserved:'Otvorit rezervaciu',dirty:'Oznacit ako volny'};
  const personIcon='<svg aria-hidden="true" viewBox="0 0 16 16" width="10" height="10"><path d="M8 7a3 3 0 100-6 3 3 0 000 6zm-5 9a5 5 0 0110 0H3z" fill="currentColor"/></svg>';

  // Grow the canvas so the rightmost / bottom-most chip isn't clipped. Chip reaches
  // roughly 150x110 beyond its top-left anchor, plus breathing room.
  var maxX=0,maxY=0;
  for(var i=0;i<filtered.length;i++){
    if(filtered[i].x>maxX)maxX=filtered[i].x;
    if(filtered[i].y>maxY)maxY=filtered[i].y;
  }
  canvas.style.minWidth=Math.max(maxX+220,600)+'px';
  canvas.style.minHeight=Math.max(maxY+180,400)+'px';

  canvas.innerHTML=filtered.map(t=>{
    const ord=tableOrders[t.id]||[];
    const total=ord.reduce((s,o)=>s+o.price*o.qty,0);
    const isSel=t.id===selectedTableId;
    const shapeClass=t.shape==='round'?'round':t.shape==='large'?'large':'';
    const posStyle=`left:${t.x}px;top:${t.y}px`;

    const ariaParts=[escHtml(t.name),sl[t.status]||t.status,t.seats+' miest'];
    if(t.status==='occupied'&&total>0)ariaParts.push(fmt(total));
    if(t.status==='reserved'&&t.time)ariaParts.push(t.time);
    const ariaLabel=ariaParts.join(', ');

    let chipBody=`<div class="chip-name">${escHtml(t.name)}</div>`;
    chipBody+=`<span class="chip-badge ${t.status}">${sl[t.status]||t.status}</span>`;
    chipBody+=`<div class="chip-guests">${personIcon} ${t.seats}</div>`;
    if(t.status==='occupied'&&total>0){
      chipBody+=`<div class="chip-amount">${fmt(total)}</div>`;
    }
    if(t.status==='reserved'&&t.time){
      chipBody+=`<div class="chip-time">${t.time}</div>`;
    }

    return `<div class="table-chip s-${t.status} ${shapeClass} ${isSel?'selected':''}"
      data-id="${t.id}" style="${posStyle}" tabindex="0" role="button"
      aria-label="${ariaLabel}" title="${titles[t.status]||''}"
      ${editMode?`onmousedown="startDrag(event,${t.id})"`:`onclick="chipClick(${t.id})"`}>
      ${chipBody}
    </div>`;
  }).join('');

  // Always-visible Storno chip in the top-right corner of the floor canvas.
  // Renders separately so renderStornoChip() can refresh badge/value without
  // re-rendering the whole floor.
  if (typeof renderStornoChip === 'function') renderStornoChip();
}

// Storno chip — fixed-position badge in floor canvas. Click opens overlay.
function renderStornoChip() {
  var canvas = document.getElementById('floorCanvas');
  if (!canvas) return;
  var c = (typeof _stornoBasketCache !== 'undefined') ? _stornoBasketCache : { count: 0, value: 0 };
  var existing = document.getElementById('stornoChip');
  var html =
    '<div id="stornoChip" class="table-chip storno-chip" role="button" tabindex="0"' +
    ' aria-label="Storno tabuľa, ' + c.count + ' položiek" onclick="openStornoBasket()">' +
      '<div class="chip-name">STORNO</div>' +
      (c.count > 0
        ? '<span class="chip-badge storno-badge">' + c.count + '</span>' +
          '<div class="chip-amount">' + fmt(c.value) + '</div>'
        : '<div class="chip-guests" style="opacity:.55">prázdna</div>') +
    '</div>';
  if (existing) {
    existing.outerHTML = html;
  } else {
    canvas.insertAdjacentHTML('beforeend', html);
  }
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
        '<div style="font-size:36px;margin-bottom:8px">⚠️</div>' +
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
}

async function chipClick(id){
  if (moveMode) { await handleMoveToTable(id); return; }
  await openTable(id);
  renderFloor();
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
  await loadTableOrder(id);
  // If multiple accounts, show picker before opening products
  if (tableOrdersList.length > 1) {
    showAccountPicker(id, true);
  } else {
    switchView('products');renderOrder();updateQtyBadges();
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
      return { id:i.id, name:i.name, emoji:i.emoji, price:parseFloat(i.price), qty:i.qty, note:i.note, menuItemId:i.menuItemId, sent:!!i.sent, _sentQty:i.sent?i.qty:0 };
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
function setCategory(key){activeCategory=key;searchQuery='';document.getElementById('searchInput').value='';renderCategories();renderProducts()}

(function(){var searchTimer=null;document.getElementById('searchInput').addEventListener('input',function(e){searchQuery=e.target.value.toLowerCase().trim();clearTimeout(searchTimer);searchTimer=setTimeout(function(){renderProducts()},200)})})();

function renderProducts(){
  const grid=document.getElementById('productsGrid');
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
  grid.innerHTML=items.map((item)=>{
    const cat=itemCats[item.name]||activeCategory;
    const cc=CAT_COLORS[cat]||'125,211,252';
    const inOrder=order.find(o=>o.name===item.name);
    const qtyBadge=inOrder?`<span class="product-qty-badge">${inOrder.qty}</span>`:'';
    // Photo above name when set; emoji is the fallback when there's no photo.
    const visualHtml = item.imageUrl
      ? `<div class="product-photo" style="background-image:url('${escAttr(item.imageUrl)}')"></div>`
      : `<span class="product-emoji">${escHtml(item.emoji)}</span>`;
    var _esc = escAttr(item.name.replace(/'/g, "\\'"));
    var _emoji = escAttr(item.emoji);
    return `<div class="product-card${item.imageUrl?' has-photo':''}" data-name="${escAttr(item.name)}" tabindex="0" role="button" style="--cat-color:${cc}" onclick="addToOrderClick('${_esc}','${_emoji}',${item.price})" onpointerdown="ripple(event);_lpStart(event,'${_esc}','${_emoji}',${item.price})" onpointerup="_lpCancel()" onpointerleave="_lpCancel()" onpointercancel="_lpCancel()" oncontextmenu="event.preventDefault()">
      ${qtyBadge}${visualHtml}<div class="product-name">${escHtml(item.name)}</div><div class="product-desc">${escHtml(item.desc)}</div><div class="product-price">${fmt(item.price)}</div></div>`;
  }).join('');
}

// Update only qty badges without re-rendering entire grid
// When menuItemId is provided, update only that item's card for O(1) performance
function updateQtyBadges(menuItemId){
  const order=getOrder();
  if(menuItemId){
    // Targeted update — find the specific card by data-name
    var itemName=null;
    for(var i=0;i<order.length;i++){if(order[i].menuItemId===menuItemId){itemName=order[i].name;break}}
    // Also check MENU_ID_MAP reverse lookup if item was just removed
    if(!itemName){MENU_ID_MAP.forEach(function(id,name){if(id===menuItemId)itemName=name})}
    if(itemName){
      var card=document.querySelector('.product-card[data-name="'+itemName.replace(/"/g,'\\"')+'"]');
      if(card){
        var inOrder=order.find(function(o){return o.name===itemName});
        var badge=card.querySelector('.product-qty-badge');
        if(inOrder){
          if(badge){badge.textContent=inOrder.qty}
          else{badge=document.createElement('span');badge.className='product-qty-badge';badge.textContent=inOrder.qty;card.prepend(badge)}
        } else {
          if(badge)badge.remove();
        }
      }
      return;
    }
  }
  // Full update fallback (used after sync, table switch, etc.)
  document.querySelectorAll('.product-card').forEach(card=>{
    const name=card.getAttribute('data-name');
    const inOrder=order.find(o=>o.name===name);
    let badge=card.querySelector('.product-qty-badge');
    if(inOrder){
      if(badge){badge.textContent=inOrder.qty}
      else{badge=document.createElement('span');badge.className='product-qty-badge';badge.textContent=inOrder.qty;card.prepend(badge)}
    } else {
      if(badge)badge.remove();
    }
  });
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
    b.style.cssText = 'min-width:54px;min-height:54px;padding:0;background:var(--color-accent,#8B7CF6);color:#fff;border:none;border-radius:10px;font-size:18px;font-weight:700;cursor:pointer;touch-action:manipulation';
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      if (typeof addToOrderN === 'function') addToOrderN(name, emoji, price, q);
      else { for (var i = 0; i < q; i++) addToOrder(name, emoji, price); }
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
    el.style.cssText = 'display:inline-block;margin-left:10px;font-size:12px;font-weight:600;padding:3px 8px;border-radius:8px;letter-spacing:.3px;vertical-align:middle;white-space:nowrap';
    label.parentNode.insertBefore(el, label.nextSibling);
  }

  var t = (typeof TABLES !== 'undefined' && Array.isArray(TABLES) && typeof selectedTableId !== 'undefined')
    ? TABLES.find(function (x) { return x.id === selectedTableId; })
    : null;

  // No table selected → hide the badge.
  if (!t) { el.style.display = 'none'; el.textContent = ''; return; }
  el.style.display = 'inline-block';

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

  var text, bg, fg;
  if (status === 'free' || (!ord && !localItems.length)) {
    text = '🟢 voľný'; // 🟢
    bg = 'rgba(92,196,158,.18)';
    fg = '#5CC49E';
  } else if (sentQty > 0) {
    text = '📤 ' + sentQty + ' ks v kuchyni' + (minutesOpen != null ? ' · ' + minutesOpen + ' min' : ''); // 📤
    bg = 'rgba(139,124,246,.18)';
    fg = '#8B7CF6';
  } else {
    text = '🟠 otvorený' + (minutesOpen != null ? ' ' + minutesOpen + ' min' : ''); // 🟠
    bg = 'rgba(224,168,48,.18)';
    fg = '#E0A830';
  }
  el.textContent = text;
  el.style.background = bg;
  el.style.color = fg;
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
  if(!order.length){c.innerHTML=`<div class="order-empty"><div class="order-empty-icon">&#128203;</div><div class="order-empty-title">Prazdna objednavka</div><div class="order-empty-text">Pridajte polozky z menu alebo kliknite na stol</div><div class="order-empty-hint"><span>&#8592;</span> Vyberte z menu</div></div>`}
  else{var sorted=order.slice().sort(function(a,b){return (b.id||0)-(a.id||0)});c.innerHTML=sorted.map(o=>{
    const esc=escAttr(o.name.replace(/'/g,"\\'"));
    const _isSent=o.sent;
    const _moveSelected=moveMode&&moveSelectedItems.indexOf(o.id)>=0;
    // Companion rows (auto-mirrored qty, e.g. Záloha fľaša) get a small chain badge
    // so cashiers know "where this row came from" — primary stays unchanged.
    const _isCompanion=!!o._companionOf;
    const _parent=_isCompanion?order.find(function(p){return p.id===o._companionOf}):null;
    const _parentName=_parent?_parent.name:'';
    const _companionBadge=_isCompanion?`<span class="companion-badge" title="Auto: viazane na ${escHtml(_parentName)}" style="margin-left:6px;opacity:.6;font-size:14px">&#128279;</span>`:'';
    const _companionTitleAttr=_isCompanion?` title="Auto: viazane na ${escHtml(_parentName)}"`:'';
    if(moveMode){
      return `<div class="order-item-wrap${_moveSelected?' move-selected':''}" data-item-id="${o.id}"${_companionTitleAttr} onclick="toggleMoveSelection(${o.id})">
  <div class="order-item-inner${_isSent?' sent':''}"><div class="move-sel">${_moveSelected?'&#10003;':''}</div><span class="order-item-emoji">${escHtml(o.emoji)}</span>
  <div class="order-item-info"><div class="order-item-name">${escHtml(o.name)}</div>${o.note?`<div class="order-item-note">${escHtml(o.note)}</div>`:''}</div>
  <span class="order-item-total">${o.qty}x${_companionBadge} &middot; ${fmt(o.price*o.qty)}</span></div>
</div>`;
    }
    return `<div class="order-item-wrap" data-item-id="${o.id}"${_companionTitleAttr} ontouchstart="swipeStart(event,this)" ontouchmove="swipeMove(event,this)" ontouchend="swipeEnd(event,this)" onmousedown="swipeStart(event,this)" onmousemove="swipeMove(event,this)" onmouseup="swipeEnd(event,this)">
  <div class="order-item-inner${_isSent?' sent':''}"><span class="order-item-emoji">${escHtml(o.emoji)}</span>
  <div class="order-item-info order-item-info--note" role="button" tabindex="0" onclick="openNoteModal('${esc}', ${o.id})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openNoteModal('${esc}', ${o.id});}"><div class="order-item-name">${escHtml(o.name)}</div>${o.note?`<div class="order-item-note">&#9998; ${escHtml(o.note)}</div>`:'<div class="order-item-note-placeholder">&#9998; Pridať poznámku</div>'}</div>
  <button class="order-item-move" onclick="enterMoveMode(${o.id})" aria-label="Presunut">&#8599;</button>
  <div class="order-item-qty"><button class="qty-btn" onclick="changeQty('${esc}', -1, ${o.id})" onpointerdown="startQtyHold('${esc}', -1, ${o.id})">&minus;</button><span class="qty-val">${o.qty}</span>${_companionBadge}<button class="qty-btn" onclick="changeQty('${esc}', 1, ${o.id})" onpointerdown="startQtyHold('${esc}', 1, ${o.id})">+</button></div>
  <div class="order-item-total">${fmt(o.price*o.qty)}</div></div>
  <div class="order-item-swipe-left"><button class="swipe-btn swipe-btn-move" onclick="enterMoveMode(${o.id})" aria-label="Presunut polozku">&#8599;</button><button class="swipe-btn swipe-btn-note" onclick="openNoteModal('${esc}', ${o.id})" aria-label="Poznamka">&#9998;</button><button class="swipe-btn swipe-btn-del" onclick="removeItem('${esc}')" aria-label="Odstranit polozku">&#10005;</button></div>
</div>`}).join('')}
  // Update send button state
  const btnSend=document.getElementById('btnSend');
  if(btnSend){btnSend.disabled=!order.length;}
  updateTotals();
}
function updateTotals(){
  const order=getOrder(),subtotal=order.reduce((s,o)=>s+o.price*o.qty,0);
  const currentOrd=tableOrdersList.find(o=>o.id===currentOrderId);
  const discountAmt=currentOrd&&currentOrd.discountAmount?parseFloat(currentOrd.discountAmount):0;
  const disc=currentOrd?currentOrd.discount:null;
  const discDisplay=document.getElementById('discountDisplay');
  if(discountAmt>0&&discDisplay){
    discDisplay.classList.remove('pos-hidden');
    document.getElementById('subtotalVal').textContent=fmt(subtotal);
    var lbl='Zlava';
    if(disc){
      lbl=disc.name||(disc.type==='percent'?'Zlava -'+disc.value+'%':'Zlava -'+fmt(disc.value));
    }else if(currentOrd&&currentOrd.discountAmount&&!currentOrd.discountId){
      var pct=subtotal>0?Math.round(discountAmt/subtotal*100):0;
      lbl='Zlava -'+pct+'%';
    }
    document.getElementById('discountLabel').innerHTML=escHtml(lbl)+' <button class="discount-remove" onclick="removeDiscount()" title="Odstranit zlavu" aria-label="Odstranit zlavu">&times;</button>';
    document.getElementById('discountVal').textContent='-'+fmt(discountAmt);
    document.getElementById('total').textContent=fmt(subtotal-discountAmt);
  }else{
    if(discDisplay)discDisplay.classList.add('pos-hidden');
    document.getElementById('total').textContent=fmt(subtotal);
  }
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

// Keep the "X min" portion of the order header status badge fresh without
// forcing a full renderOrder pass.
setInterval(function(){
  if (typeof _renderTableStatus === 'function') {
    try { _renderTableStatus(); } catch (e) { /* badge is non-essential */ }
  }
}, 60000);
