// Online objednávky s doručením (Wolt Drive).
//
// Obsluha tu robí jednu vec: novú objednávku z webu POTVRDÍ (vznikne POS účet
// na stole „Rozvoz", kuchyňa dostane bon, objedná sa kuriér) alebo ODMIETNE.
// Ostatné je čítanie stavu: kde je kuriér, čo bolo doručené.
import { fmtCost } from '../../components/fmt.js';

let _container = null;
let _rows = [];
let _counts = { new: 0, running: 0 };
let _filter = 'active';
let _cfg = null;
let _timer = null;
let _lastNewCount = null;

const STATUS = {
  new:        { label: 'Nová',            cls: 'is-new' },
  confirmed:  { label: 'Potvrdená',       cls: 'is-confirmed' },
  dispatched: { label: 'Kuriér na ceste', cls: 'is-dispatched' },
  delivered:  { label: 'Doručená',        cls: 'is-delivered' },
  rejected:   { label: 'Odmietnutá',      cls: 'is-muted' },
  cancelled:  { label: 'Zrušená',         cls: 'is-muted' },
};
const WOLT_STATUS = {
  received: 'Wolt prijal', pickup_eta_updated: 'čas vyzdvihnutia upravený', pickup_started: 'kuriér ide k nám',
  pickup_arrival: 'kuriér je u nás', picked_up: 'vyzdvihnuté', dropoff_started: 'kuriér ide k zákazníkovi',
  dropoff_arrival: 'kuriér je u zákazníka', dropoff_completed: 'odovzdané', delivered: 'doručené',
  rejected: 'Wolt odmietol', customer_no_show: 'zákazník neprevzal', error: 'chyba pri objednaní kuriéra',
  cancelled: 'kuriér zrušený', INFO_RECEIVED: 'Wolt prijal',
};
const PAY = { cash: 'hotovosť kuriérovi', transfer: 'platba vopred (prevod / QR)', wolt: 'zaplatené cez Wolt' };
const isWolt = (o) => o.source === 'wolt';
const inHouse = (o) => isWolt(o) && (o.deliveryType === 'takeaway' || o.deliveryType === 'eatin');
const DELIVERY_TYPE = { homedelivery: 'kuriér Wolt', takeaway: 'zákazník si vyzdvihne', eatin: 'zje v podniku' };

const $ = (sel) => _container.querySelector(sel);
const eur = (n) => fmtCost(Number(n) || 0) + ' €';

function ago(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60000);
  if (m < 1) return 'práve teraz';
  if (m < 60) return 'pred ' + m + ' min';
  const h = Math.floor(m / 60);
  if (h < 24) return 'pred ' + h + ' h ' + (m % 60) + ' min';
  return new Intl.DateTimeFormat('sk-SK', { timeZone: 'Europe/Bratislava', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}
function timeSk(iso) {
  return new Intl.DateTimeFormat('sk-SK', { timeZone: 'Europe/Bratislava', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}
function itemsWord(n) { return n === 1 ? 'položka' : (n >= 2 && n <= 4 ? 'položky' : 'položiek'); }

async function load({ silent } = {}) {
  const list = $('#ooList');
  if (!silent && list) showLoading(list, 'Načítavam objednávky…');
  try {
    const [res, cfg] = await Promise.all([api.get('/online-orders?status=' + _filter), _cfg ? Promise.resolve(_cfg) : api.get('/online-orders/config')]);
    _cfg = cfg;
    _rows = res.rows || [];
    _counts = res.counts || { new: 0, running: 0 };
    if (_lastNewCount != null && _counts.new > _lastNewCount) {
      showToast('Nová online objednávka', true);
    }
    _lastNewCount = _counts.new;
    if (list) hideLoading(list);
    render();
  } catch (err) {
    if (list) hideLoading(list);
    if (list) list.innerHTML = '<div class="error-hint">' + escapeHtml(err.message || 'Chyba načítania') + '</div>';
  }
}

function render() {
  const head = $('#ooHead');
  const mode = _cfg && _cfg.mode;
  const modeNote = !_cfg ? '' : !_cfg.enabled
    ? '<span class="oo-mode is-off">Doručenie vypnuté</span>'
    : mode === 'mock' ? '<span class="oo-mode is-mock">Skúšobný režim — kuriér sa neobjednáva</span>'
    : mode === 'development' ? '<span class="oo-mode is-mock">Wolt staging</span>' : '';
  // Skúšobná objednávka „z aplikácie Wolt" — len keď je WOLT_ORDER_MODE=mock.
  const mockWolt = _cfg && _cfg.woltOrders && _cfg.woltOrders.mode === 'mock'
    ? '<button type="button" class="doch-chip oo-mock-btn" id="ooMockWolt">+ Skúšobná objednávka z Woltu</button>' : '';
  head.innerHTML =
    '<div class="doch-chips" role="group" aria-label="Filter">' +
      chip('new', 'Nové' + (_counts.new ? ' ' + _counts.new : '')) +
      chip('active', 'Aktívne') +
      chip('done', 'Hotové') +
      chip('all', 'Všetky') +
    '</div>' +
    '<div class="doch-sum">' +
      '<span class="doch-sum-i"><strong>' + _counts.new + '</strong> ' + (_counts.new === 1 ? 'nová' : (_counts.new >= 2 && _counts.new <= 4 ? 'nové' : 'nových')) + '</span>' +
      '<span class="doch-sum-i"><strong>' + _counts.running + '</strong> v príprave alebo na ceste</span>' +
      modeNote + mockWolt +
    '</div>';
  head.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => { _filter = b.dataset.filter; load(); }));
  const mockBtn = head.querySelector('#ooMockWolt');
  if (mockBtn) mockBtn.addEventListener('click', async () => {
    mockBtn.disabled = true;
    try {
      const r = await api.post('/online-orders/wolt/mock-order', {});
      showToast('Skúšobná objednávka ' + r.order.publicCode + ' z Woltu vytvorená — pozri kasu / KDS', true);
      _filter = 'new'; load({ silent: true });
    } catch (e) { showToast(e.message || 'Chyba', 'error'); }
    mockBtn.disabled = false;
  });

  const list = $('#ooList');
  if (!_rows.length) {
    list.innerHTML = '<div class="empty-hint">' + (_filter === 'new'
      ? 'Žiadne nové objednávky. Nové sa tu objavia samy, obnovuje sa každých 15 sekúnd.'
      : 'Žiadne objednávky v tomto výbere.') + '</div>';
    return;
  }
  list.innerHTML = _rows.map(rowHtml).join('');
}

function chip(key, label) {
  return '<button type="button" class="doch-chip' + (_filter === key ? ' is-on' : '') + '" data-filter="' + key + '" aria-pressed="' + (_filter === key) + '">' + label + '</button>';
}

function statusPill(o) {
  let s = STATUS[o.status] || { label: o.status, cls: 'is-muted' };
  if (o.readyAt && (o.status === 'confirmed' || o.status === 'dispatched')) s = { label: inHouse(o) ? 'Hotové · čaká na zákazníka' : 'Hotové · čaká na kuriéra', cls: 'is-delivered' };
  else if (isWolt(o) && o.status === 'confirmed') s = { label: 'Prijatá vo Wolte', cls: 'is-confirmed' };
  const wolt = o.woltStatus && (o.status === 'dispatched' || o.woltStatus === 'error' || o.woltStatus === 'rejected')
    ? ' <span class="oo-wolt">' + escapeHtml(WOLT_STATUS[o.woltStatus] || o.woltStatus) + '</span>' : '';
  return '<span class="oo-pill ' + s.cls + '">' + s.label + '</span>' + wolt;
}

function rowHtml(o) {
  const n = (o.items || []).reduce((s, i) => s + (Number(i.qty) || 0), 0);
  return '<button type="button" class="oo-row' + (o.status === 'new' ? ' is-new' : '') + '" data-id="' + o.id + '">' +
    '<span class="oo-main">' +
      '<span class="oo-title"><b>' + escapeHtml(o.publicCode) + '</b>' + (isWolt(o) ? ' <span class="oo-src">Wolt</span>' : '') + ' · ' + escapeHtml(o.customerName) + '</span>' +
      '<span class="oo-sub">' + escapeHtml(o.dropoffStreet) + ', ' + escapeHtml(o.dropoffCity) + ' · ' + n + ' ' + itemsWord(n) + ' · ' + escapeHtml(ago(o.createdAt)) +
        (o.scheduledFor ? ' · <b>doručiť ' + escapeHtml(new Intl.DateTimeFormat('sk-SK', { timeZone: 'Europe/Bratislava', weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(o.scheduledFor))) + '</b>' : '') + '</span>' +
      '<span class="oo-status">' + statusPill(o) + '</span>' +
    '</span>' +
    '<span class="oo-side"><span class="oo-total">' + eur(o.total) + '</span>' +
      (o.paymentMethod === 'cash' ? '<span class="oo-pay">hotovosť</span>' : o.paymentMethod === 'wolt' ? '<span class="oo-pay">cez Wolt</span>' : '<span class="oo-pay">zaplatené vopred</span>') +
    '</span>' +
  '</button>';
}

// ── Detail ako panel (na telefóne zdola) ─────────────────────────────────────
async function openDetail(id) {
  const o = _rows.find((r) => r.id === id);
  if (!o) return;
  let events = [];
  try { events = await api.get('/online-orders/' + id + '/events'); } catch { /* detail bez časovej osi je stále použiteľný */ }

  const existing = document.getElementById('ooModal');
  if (existing) existing.remove();
  const ov = document.createElement('div');
  ov.className = 'u-overlay';
  ov.id = 'ooModal';
  const items = (o.items || []).map((i) =>
    '<div class="oo-item"><span class="oo-item-q">' + i.qty + '×</span><span class="oo-item-n">' + escapeHtml(i.name) +
    (i.note ? '<em>' + escapeHtml(i.note) + '</em>' : '') + '</span><span class="oo-item-p">' + eur(i.unitPrice * i.qty) + '</span></div>').join('');
  const timeline = events.map((e) => '<div class="oo-ev"><span>' + escapeHtml(timeSk(e.createdAt)) + '</span><span>' + escapeHtml(evLabel(e)) + '</span></div>').join('');

  let actions = '';
  if (o.status === 'new') {
    // Minúty na prípravu idú kuriérovi (Wolt adjusted_pickup_time / Drive prep) — predvolené 15.
    actions = '<div class="oo-prep-row"><span class="oo-prep-label">Hotové o</span>' +
              [10, 15, 20, 30].map((m) => '<button type="button" class="doch-chip oo-prep' + (m === 15 ? ' is-on' : '') + '" data-prep="' + m + '" aria-pressed="' + (m === 15) + '">' + m + ' min</button>').join('') + '</div>' +
              '<button class="u-btn u-btn-ghost" id="ooReject">Odmietnuť</button>' +
              '<button class="u-btn u-btn-ice" id="ooConfirm">' + (isWolt(o) ? 'Prijať vo Wolte' : 'Potvrdiť a objednať kuriéra') + '</button>';
  } else if (o.status === 'confirmed' && !o.firedAt && !o.posOrderId) {
    // Prijaté v aplikácii Wolt (bez bonu) alebo predobjednávka pred časom.
    actions = '<button class="u-btn u-btn-ghost" id="ooClose">Zavrieť</button>' +
              '<button class="u-btn u-btn-ice" id="ooFire">' + (o.fireAt ? 'Začať variť teraz' : 'Vytvoriť účet a bon') + '</button>';
  } else if (o.status === 'confirmed' && isWolt(o)) {
    // Kuriéra rieši Wolt — tu len hotové a (pri vyzdvihnutí) odovzdanie zákazníkovi.
    // V mock režime sa dá doručenie kuriérom Woltu odsimulovať.
    const mock = _cfg && _cfg.woltOrders && _cfg.woltOrders.mode === 'mock' && !inHouse(o)
      ? '<button class="u-btn u-btn-ghost" id="ooMockDeliver">Simulovať doručenie (Wolt)</button>' : '';
    actions = '<button class="u-btn u-btn-ghost" id="ooClose">Zavrieť</button>' + mock +
              (!o.readyAt ? '<button class="u-btn u-btn-ice" id="ooReady">Hotové</button>'
                : inHouse(o) ? '<button class="u-btn u-btn-ice" id="ooHandover">Odovzdané zákazníkovi</button>' : '');
  } else if (o.status === 'confirmed') {
    actions = (o.readyAt ? '<button class="u-btn u-btn-ghost" id="ooClose">Zavrieť</button>'
                         : '<button class="u-btn u-btn-ghost" id="ooReady">Hotové</button>') +
              '<button class="u-btn u-btn-ice" id="ooDispatch">Objednať kuriéra' + (o.woltStatus === 'error' ? ' znova' : '') + '</button>';
  } else if (o.status === 'dispatched') {
    actions = '<button class="u-btn u-btn-ghost" id="ooCancelDelivery">Zrušiť kuriéra</button>' +
              (o.readyAt ? '<button class="u-btn u-btn-ice" id="ooClose">Zavrieť</button>'
                         : '<button class="u-btn u-btn-ice" id="ooReady">Hotové — čaká na kuriéra</button>');
  } else {
    actions = '<button class="u-btn u-btn-ice" id="ooClose">Zavrieť</button>';
  }

  ov.innerHTML = '<div class="u-modal oo-modal" style="text-align:left;max-width:560px">' +
    '<div class="u-modal-title" style="text-align:center">' + escapeHtml(o.publicCode) + '</div>' +
    '<div class="u-modal-body">' +
      '<div class="oo-d-status">' + statusPill(o) + (o.woltTrackingUrl ? ' <a class="oo-track" href="' + escapeHtml(o.woltTrackingUrl) + '" target="_blank" rel="noopener">Sledovať kuriéra ↗</a>' : '') + '</div>' +
      '<div class="oo-group">' + items +
        '<div class="oo-tot"><span>Jedlo a nápoje</span><span>' + eur(o.subtotal) + '</span></div>' +
        '<div class="oo-tot"><span>Doručenie (Wolt)</span><span>' + eur(o.deliveryFee) + '</span></div>' +
        '<div class="oo-tot is-total"><span>Spolu</span><span>' + eur(o.total) + '</span></div>' +
      '</div>' +
      '<div class="oo-group">' +
        kv('Zákazník', escapeHtml(o.customerName) + ' · <a href="tel:' + escapeHtml(o.customerPhone) + '">' + escapeHtml(o.customerPhone) + '</a>') +
        kv('Adresa', escapeHtml(o.dropoffStreet) + ', ' + escapeHtml(o.dropoffPostCode) + ' ' + escapeHtml(o.dropoffCity) + (o.dropoffComment ? '<br><em>' + escapeHtml(o.dropoffComment) + '</em>' : '')) +
        kv('Platba', escapeHtml(PAY[o.paymentMethod] || o.paymentMethod)) +
        (o.scheduledFor ? kv('Doručiť', escapeHtml(new Intl.DateTimeFormat('sk-SK', { timeZone: 'Europe/Bratislava', dateStyle: 'short', timeStyle: 'short' }).format(new Date(o.scheduledFor)))) : isWolt(o) ? kv('Doručenie', escapeHtml(DELIVERY_TYPE[o.deliveryType] || o.deliveryType || 'kuriér Wolt') + (o.woltPickupEta ? ' · kuriér príde ' + escapeHtml(timeSk(o.woltPickupEta)) : '')) : kv('Doručiť', 'čo najskôr')) +
        (o.readyAt ? kv('Hotové', escapeHtml(new Intl.DateTimeFormat('sk-SK', { timeZone: 'Europe/Bratislava', hour: '2-digit', minute: '2-digit' }).format(new Date(o.readyAt))) + ' · čaká na kuriéra') : '') +
        (o.prepMinutes ? kv('Príprava', o.prepMinutes + ' min' + (o.promisedReadyAt ? ' · hotové ' + escapeHtml(timeSk(o.promisedReadyAt)) : '')) : '') +
        (o.fireAt && !o.firedAt ? kv('Plán', 'predobjednávka · bon pôjde ' + escapeHtml(timeSk(o.fireAt))) : '') +
        (o.status !== 'new' && o.bonStatus ? kv('Bon', (o.bonStatus === 'ok' ? 'vytlačený' : o.bonStatus === 'none' ? 'bez položiek z kasy' : '<b style="color:var(--color-danger)">nevytlačený</b>') + ' · <button type="button" class="doch-chip" id="ooReprint">Vytlačiť znova</button>') : '') +
        (o.claimedAt && o.claimedName && Date.now() - new Date(o.claimedAt).getTime() < 30000 ? kv('Rieši', escapeHtml(o.claimedName)) : '') +
        (o.note ? kv('Poznámka', escapeHtml(o.note)) : '') +
        (o.posOrderId ? kv('POS účet', '#' + o.posOrderId + ' (Rozvoz)') : '') +
        (o.rejectedReason ? kv('Dôvod odmietnutia', escapeHtml(o.rejectedReason)) : '') +
      '</div>' +
      (timeline ? '<div class="oo-group oo-timeline">' + timeline + '</div>' : '') +
      '<div class="oo-reject" id="ooRejectBox" hidden>' +
        '<label for="ooReason">Dôvod pre zákazníka (voliteľné)</label>' +
        '<input id="ooReason" type="text" maxlength="300" placeholder="napr. Dnes už nevaríme">' +
        '<button class="u-btn u-btn-rose" id="ooRejectGo">Odmietnuť objednávku</button>' +
      '</div>' +
    '</div>' +
    '<div class="u-modal-btns">' + actions + '</div>' +
  '</div>';
  document.body.appendChild(ov);
  requestAnimationFrame(() => ov.classList.add('show'));

  const close = () => { ov.classList.remove('show'); setTimeout(() => ov.remove(), 250); };
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
  const on = (sel, fn) => { const b = ov.querySelector(sel); if (b) b.addEventListener('click', fn); };
  on('#ooClose', close);
  on('#ooReject', () => { ov.querySelector('#ooRejectBox').hidden = false; ov.querySelector('#ooReason').focus(); });
  on('#ooRejectGo', async () => {
    const btn = ov.querySelector('#ooRejectGo'); btnLoading(btn);
    try {
      await api.post('/online-orders/' + id + '/reject', { reason: ov.querySelector('#ooReason').value.trim() });
      showToast('Objednávka odmietnutá', true); close(); load({ silent: true });
    } catch (e) { showToast(e.message || 'Nepodarilo sa odmietnuť', 'error'); btnReset(btn); }
  });
  ov.querySelectorAll('.oo-prep').forEach((c) => c.addEventListener('click', () => {
    ov.querySelectorAll('.oo-prep').forEach((x) => { x.classList.toggle('is-on', x === c); x.setAttribute('aria-pressed', String(x === c)); });
  }));
  on('#ooConfirm', async () => {
    const btn = ov.querySelector('#ooConfirm'); btnLoading(btn);
    try {
      const prep = Number((ov.querySelector('.oo-prep.is-on') || {}).dataset?.prep) || 15;
      const r = await api.post('/online-orders/' + id + '/confirm', { prepMinutes: prep }, 'oo:' + id + ':confirm');
      if (r.ok) showToast('Potvrdené — bon v kuchyni, kuriér objednaný', true);
      else showToast(r.error || 'Potvrdené, ale kuriéra sa nepodarilo objednať — skúste znova z detailu', 'error');
      close(); load({ silent: true });
    } catch (e) { showToast(e.message || 'Nepodarilo sa potvrdiť', 'error'); btnReset(btn); }
  });
  on('#ooMockDeliver', async () => {
    const btn = ov.querySelector('#ooMockDeliver'); btnLoading(btn);
    try { await api.post('/online-orders/' + id + '/wolt-mock-status', { status: 'DELIVERED' }); showToast('Wolt: doručené (simulácia)', true); close(); load({ silent: true }); }
    catch (e) { showToast(e.message || 'Chyba', 'error'); btnReset(btn); }
  });
  on('#ooFire', async () => {
    const btn = ov.querySelector('#ooFire'); btnLoading(btn);
    try {
      const r = await api.post('/online-orders/' + id + '/fire', {}, 'oo:' + id + ':fire');
      if (r && r.error) showToast(r.error, 'error'); else showToast('Účet založený, bon ide do kuchyne', true);
      close(); load({ silent: true });
    }
    catch (e) { showToast(e.message || 'Chyba', 'error'); btnReset(btn); }
  });
  on('#ooReprint', async () => {
    try { const r = await api.post('/online-orders/' + id + '/reprint', {}); showToast(r.bon === 'ok' ? 'Bon vytlačený (kópia)' : 'Bon je vo fronte — tlačiareň neodpovedá', r.bon === 'ok'); load({ silent: true }); }
    catch (e) { showToast(e.message || 'Chyba', 'error'); }
  });
  on('#ooHandover', async () => {
    const btn = ov.querySelector('#ooHandover'); btnLoading(btn);
    try { await api.post('/online-orders/' + id + '/handed-over', {}); showToast('Odovzdané zákazníkovi', true); close(); load({ silent: true }); }
    catch (e) { showToast(e.message || 'Chyba', 'error'); btnReset(btn); }
  });
  on('#ooReady', async () => {
    const btn = ov.querySelector('#ooReady'); btnLoading(btn);
    try { await api.post('/online-orders/' + id + '/ready', {}); showToast('Označené ako hotové', true); close(); load({ silent: true }); }
    catch (e) { showToast(e.message || 'Chyba', 'error'); btnReset(btn); }
  });
  on('#ooDispatch', async () => {
    const btn = ov.querySelector('#ooDispatch'); btnLoading(btn);
    try {
      const r = await api.post('/online-orders/' + id + '/dispatch', {});
      showToast(r.ok ? 'Kuriér objednaný' : (r.error || 'Kuriéra sa nepodarilo objednať'), r.ok ? true : 'error');
      close(); load({ silent: true });
    } catch (e) { showToast(e.message || 'Chyba', 'error'); btnReset(btn); }
  });
  on('#ooCancelDelivery', () => {
    showConfirm('Zrušiť kuriéra?', 'Wolt zruší doručenie, ak ho kuriér ešte neprevzal. POS účet ostáva otvorený.', async () => {
      try { await api.post('/online-orders/' + id + '/cancel-delivery', {}); showToast('Kuriér zrušený', true); close(); load({ silent: true }); }
      catch (e) { showToast(e.message || 'Nepodarilo sa zrušiť', 'error'); }
    }, { type: 'danger', confirmText: 'Zrušiť kuriéra' });
  });
}

function kv(k, v) { return '<div class="oo-kv"><span class="oo-k">' + k + '</span><span class="oo-v">' + v + '</span></div>'; }
function evLabel(e) {
  const t = String(e.type || '');
  if (t === 'created') return (e.payload && e.payload.source === 'wolt') ? 'objednávka prišla z aplikácie Wolt' : 'objednávka prijatá z webu';
  if (t === 'confirmed') return 'potvrdená obsluhou';
  if (t === 'dispatched') return 'kuriér objednaný';
  if (t === 'ready') return 'kuchyňa: hotové';
  if (t === 'handed-over') return 'odovzdané zákazníkovi';
  if (t === 'escalated') return 'strážca: nikto nereaguje (úroveň ' + ((e.payload && e.payload.level) || '?') + ')';
  if (t === 'bon') return 'bon: ' + ((e.payload && e.payload.status) || '');
  if (t === 'reprint') return 'bon znova (kópia)';
  if (t === 'fired') return 'účet a bon založené ručne';
  if (t === 'rejected' && e.payload && e.payload.auto) return 'strážca: automaticky odmietnuté pred termínom Woltu';
  if (t === 'error') return 'chyba: ' + ((e.payload && e.payload.message) || '');
  if (t === 'rejected') return 'odmietnutá' + (e.payload && e.payload.reason ? ' — ' + e.payload.reason : '');
  if (t === 'wolt:error') return 'Wolt: chyba — ' + ((e.payload && e.payload.message) || '');
  if (t === 'wolt:cancelled') return 'kuriér zrušený obsluhou';
  if (t.startsWith('wolt:')) return 'Wolt: ' + (WOLT_STATUS[t.slice(5).replace(/^order\./, '')] || t.slice(5));
  return t;
}

export function init(container) {
  _container = container;
  container.innerHTML =
    '<div class="oo-page">' +
      '<div id="ooHead"></div>' +
      '<div class="oo-list" id="ooList"></div>' +
      '<p class="oo-foot">Potvrdením vznikne účet na stole „Rozvoz", kuchyňa dostane bon a Wolt pošle kuriéra. Účet sa zatvára v POS ako každý iný — vtedy sa vytlačí doklad do balíka.</p>' +
    '</div>';
  container.querySelector('#ooList').addEventListener('click', (e) => {
    const row = e.target.closest('[data-id]');
    if (row) openDetail(Number(row.dataset.id));
  });
  load();
  // Nové objednávky prichádzajú bez zásahu obsluhy — obnovuj sám.
  _timer = setInterval(() => { if (!document.hidden) load({ silent: true }); }, 15000);
}

export function destroy() {
  clearInterval(_timer); _timer = null;
  const m = document.getElementById('ooModal'); if (m) m.remove();
  _container = null; _rows = []; _cfg = null; _lastNewCount = null; _filter = 'active';
}
