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
  if (!hasPendingOrderFlushState()) return Promise.resolve(false);
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
  currentView=v;
  document.getElementById('btnTableView').classList.toggle('active',v==='tables');
  document.getElementById('btnProductView').classList.toggle('active',v==='products');
  document.getElementById('tableView').classList.toggle('active',v==='tables');
  document.getElementById('productsPanel').classList.toggle('active',v==='products');
  document.querySelector('.order-panel').classList.toggle('pos-hidden', v==='tables');
  if(v==='tables')renderFloor();if(v==='products')renderProducts();
}

// Edit mode
function toggleEdit(){
  editMode=!editMode;
  document.getElementById('editToggle').classList.toggle('active',editMode);
  document.getElementById('editLabel').textContent=editMode?'Hotovo':'Upravit';
  document.getElementById('floorCanvas').classList.toggle('edit-mode',editMode);
  document.getElementById('floorCanvas').classList.toggle('edit-abs',editMode);
  if(!editMode)savePositions();
  renderFloor();
}

// Floor zones
function renderFloorZones(){
  document.getElementById('floorZones').innerHTML=ZONES.map(z=>
    `<button class="zone-btn ${z.id===activeZone?'active':''}" onclick="setZone('${z.id}')">${z.label}</button>`
  ).join('');
}
function setZone(id){activeZone=id;renderFloorZones();renderFloor()}

// Floor canvas with draggable chips
function renderFloor(){
  const canvas=document.getElementById('floorCanvas');
  const filtered=TABLES.filter(t=>t.zone===activeZone);
  const sl={free:'Volny',occupied:'Obsad.',reserved:'Rez.',dirty:'Cistit'};
  const titles={free:'Otvorit objednavku',occupied:'Zobrazit ucet',reserved:'Otvorit rezervaciu',dirty:'Oznacit ako volny'};
  const personIcon='<svg aria-hidden="true" viewBox="0 0 16 16" width="10" height="10"><path d="M8 7a3 3 0 100-6 3 3 0 000 6zm-5 9a5 5 0 0110 0H3z" fill="currentColor"/></svg>';

  canvas.innerHTML=filtered.map(t=>{
    const ord=tableOrders[t.id]||[];
    const total=ord.reduce((s,o)=>s+o.price*o.qty,0);
    const isSel=t.id===selectedTableId;
    const shapeClass=t.shape==='round'?'round':t.shape==='large'?'large':'';
    // Edit mode: absolute px. Normal mode: percentage-based positioning
    let posStyle;
    if(editMode){
      posStyle=`left:${t.x}px;top:${t.y}px`;
    } else {
      if(!renderFloor._refW){
        var maxX=0,maxY=0;
        TABLES.forEach(function(tb){if(tb.x>maxX)maxX=tb.x;if(tb.y>maxY)maxY=tb.y});
        renderFloor._refW=Math.max(maxX+170,600);
        renderFloor._refH=Math.max(maxY+130,400);
      }
      const pctX=((t.x/renderFloor._refW)*100).toFixed(1);
      const pctY=((t.y/renderFloor._refH)*100).toFixed(1);
      posStyle=`left:${pctX}%;top:${pctY}%`;
    }

    // Accessibility label
    const ariaParts=[escHtml(t.name),sl[t.status]||t.status,t.seats+' miest'];
    if(t.status==='occupied'&&total>0)ariaParts.push(fmt(total));
    if(t.status==='reserved'&&t.time)ariaParts.push(t.time);
    const ariaLabel=ariaParts.join(', ');

    // Build chip interior — hierarchy: name > badge > guests > amount
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
    var itemPreview = o.items ? o.items.slice(0, 4).map(function(i) { return i.emoji; }).join(' ') : '';
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
    `<button class="cat-btn ${key===activeCategory?'active':''}" onclick="setCategory('${key}')"><span class="cat-icon">${cat.icon}</span>${cat.label}<span class="cat-key">${cat.key}</span></button>`
  ).join('');
}
function setCategory(key){activeCategory=key;searchQuery='';document.getElementById('searchInput').value='';renderCategories();renderProducts()}

(function(){var searchTimer=null;document.getElementById('searchInput').addEventListener('input',function(e){searchQuery=e.target.value.toLowerCase().trim();clearTimeout(searchTimer);searchTimer=setTimeout(function(){renderProducts()},200)})})();

function renderProducts(){
  const grid=document.getElementById('productsGrid');
  let items;let itemCats={};
  if(searchQuery){
    items=[];
    Object.entries(MENU).forEach(([cat,c])=>{c.items.forEach(i=>{
      if(i.name.toLowerCase().includes(searchQuery)||i.desc.toLowerCase().includes(searchQuery)){items.push(i);itemCats[i.name]=cat}
    })});
  } else {
    if (!activeCategory || !MENU[activeCategory]) { grid.innerHTML=''; return; }
    items=MENU[activeCategory].items;
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
    return `<div class="product-card" data-name="${escHtml(item.name)}" tabindex="0" role="button" style="--cat-color:${cc}" onclick="addToOrder('${item.name.replace(/'/g,"\\'")}','${item.emoji}',${item.price})" onpointerdown="ripple(event)">
      ${qtyBadge}<span class="product-emoji">${escHtml(item.emoji)}</span><div class="product-name">${escHtml(item.name)}</div><div class="product-desc">${escHtml(item.desc)}</div><div class="product-price">${fmt(item.price)}</div></div>`;
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

function renderOrder(){
  const order=getOrder(),c=document.getElementById('orderItems');
  const countEl=document.getElementById('orderCount');
  const newCount=order.reduce((s,o)=>s+o.qty,0);
  const oldCount=parseInt(countEl.textContent)||0;
  countEl.textContent=newCount;
  countEl.classList.toggle('zero',newCount===0);
  if(newCount!==oldCount&&newCount>0){countEl.classList.add('bump');setTimeout(()=>countEl.classList.remove('bump'),250)}
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
    const esc=o.name.replace(/'/g,"\\'");
    const _isSent=o.sent;
    const _moveSelected=moveMode&&moveSelectedItems.indexOf(o.id)>=0;
    if(moveMode){
      return `<div class="order-item-wrap${_moveSelected?' move-selected':''}" data-item-id="${o.id}" onclick="toggleMoveSelection(${o.id})">
  <div class="order-item-inner${_isSent?' sent':''}"><div class="move-sel">${_moveSelected?'&#10003;':''}</div><span class="order-item-emoji">${escHtml(o.emoji)}</span>
  <div class="order-item-info"><div class="order-item-name">${escHtml(o.name)}</div>${o.note?`<div class="order-item-note">${escHtml(o.note)}</div>`:''}</div>
  <span class="order-item-total">${o.qty}x &middot; ${fmt(o.price*o.qty)}</span></div>
</div>`;
    }
    return `<div class="order-item-wrap" data-item-id="${o.id}" ontouchstart="swipeStart(event,this)" ontouchmove="swipeMove(event,this)" ontouchend="swipeEnd(event,this)" onmousedown="swipeStart(event,this)" onmousemove="swipeMove(event,this)" onmouseup="swipeEnd(event,this)">
  <div class="order-item-inner${_isSent?' sent':''}"><span class="order-item-emoji">${escHtml(o.emoji)}</span>
  <div class="order-item-info order-item-info--note" role="button" tabindex="0" onclick="openNoteModal('${esc}', ${o.id})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openNoteModal('${esc}', ${o.id});}"><div class="order-item-name">${escHtml(o.name)}</div>${o.note?`<div class="order-item-note">${escHtml(o.note)}</div>`:'<div class="order-item-note order-item-note-placeholder">+ poznamka</div>'}</div>
  <button class="order-item-move" onclick="enterMoveMode(${o.id})" aria-label="Presunut">&#8599;</button>
  <div class="order-item-qty"><button class="qty-btn" onclick="changeQty('${esc}', -1, ${o.id})" onpointerdown="startQtyHold('${esc}', -1, ${o.id})">&minus;</button><span class="qty-val">${o.qty}</span><button class="qty-btn" onclick="changeQty('${esc}', 1, ${o.id})" onpointerdown="startQtyHold('${esc}', 1, ${o.id})">+</button></div>
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
    document.getElementById('discountLabel').innerHTML=lbl+' <button class="discount-remove" onclick="removeDiscount()" title="Odstranit zlavu" aria-label="Odstranit zlavu">&times;</button>';
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
      return '<div class="discount-item" data-id="'+d.id+'" onclick="selectDiscount('+d.id+',this)"><span class="discount-item-name">'+d.name+'</span><span class="discount-item-value">'+valLabel+'</span></div>';
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
