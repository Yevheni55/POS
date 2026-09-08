// admin/pages/storno.js
//
// Storno koš — manager spracúva stornované poslané položky. Presunuté z POS
// table-view (floating pill) sem do admin panelu, lebo rozhodnutie
// "vrátiť na sklad vs odpísať" je manažérska úloha, nie cashier flow.
//
// API (server/routes/storno-basket.js):
//   GET    /api/storno-basket            → { summary, items }
//   POST   /api/storno-basket/:id/resolve  body { override:{ wasPrepared } }
//   DELETE /api/storno-basket/:id

import { fmtCost } from '../../components/fmt.js';

let _container = null;
let _data = { summary: { pendingCount: 0, pendingValue: 0, rowCount: 0 }, items: [] };
let _socketHandler = null;

function $(sel) { return _container ? _container.querySelector(sel) : null; }
function fmtEur(n) { return fmtCost(n) + ' €'; }
// Jediná implementácia escapovania v projekte je /js/pos-escape.js
// (escHtml pre textový obsah, escAttr pre atribút, escJsAttr pre inline
// handler). Predtým mala takmer každá admin stránka vlastnú kópiu a boli
// medzi nimi ŠTYRI rôzne správania — časť neescapovala apostrof ani
// úvodzovku, čo je práve to, na čom záleží pri interpolácii do atribútu.
// Lokálne meno ostáva, nech sa neprepisujú stovky volaní.
function esc(v) {
  // window.* zamerne: v moduloch, kde sa lokalna funkcia vola tiez escHtml,
  // by holy identifikator ukazoval sam na seba (nekonecna rekurzia).
  if (typeof window !== 'undefined' && typeof window.escHtml === 'function') return window.escHtml(v);
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const REASON_LABELS = {
  order_error: 'Chyba objednávky',
  complaint: 'Reklamácia',
  breakage: 'Rozbité',
  staff_meal: 'Zamestnanecká spotreba',
  other: 'Iné',
};

const CHEVRON = '<svg class="set-chev" aria-hidden="true" viewBox="0 0 16 16"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

let _escHandler = null;

function itemsWord(n) {
  if (n === 1) return 'položka čaká na rozhodnutie';
  if (n >= 2 && n <= 4) return 'položky čakajú na rozhodnutie';
  return 'položiek čaká na rozhodnutie';
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('sk-SK', {
    timeZone: 'Europe/Bratislava',
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

async function load() {
  try {
    _data = await api.get('/storno-basket');
  } catch (err) {
    _data = { summary: { pendingCount: 0, pendingValue: 0, rowCount: 0 }, items: [] };
    if (typeof showToast === 'function') showToast(err.message || 'Chyba načítania storno koša', 'error');
  }
  render();
}

function rowHtml(it) {
  const pricedQty = Number(it.unitPrice || 0) * it.qty;
  const reason = REASON_LABELS[it.reason] || it.reason || '';
  // Čo hlási čašník rozhoduje o predvolenej akcii — preto je to prvé v riadku.
  const flag = it.wasPrepared
    ? '<span class="sto-flag is-prepared">už pripravené</span>'
    : '<span class="sto-flag">nepripravené</span>';
  const meta = [flag, esc(reason), esc(it.staffName || ''), esc(fmtTime(it.createdAt))].filter(Boolean).join(' · ');
  return '<div class="sto-row" data-id="' + it.id + '">' +
    '<button type="button" class="sto-main" data-open="' + it.id + '" title="Detail položky">' +
      '<span class="sto-main-txt">' +
        '<span class="sto-title">' + esc(it.itemName) + ' <span class="sto-qty">× ' + it.qty + '</span></span>' +
        '<span class="sto-sub">' + meta + (it.note ? '<br>„' + esc(it.note) + '“' : '') + '</span>' +
      '</span>' +
      CHEVRON +
    '</button>' +
    '<span class="sto-sum-v">' + fmtEur(pricedQty) + '</span>' +
    '<span class="sto-act">' +
      '<button type="button" class="btn-secondary is-return storno-return" data-id="' + it.id + '" title="Suroviny späť na sklad (jedlo nebolo urobené)">Vrátiť na sklad</button>' +
      '<button type="button" class="btn-secondary is-writeoff storno-writeoff" data-id="' + it.id + '" title="Jedlo bolo urobené, ide ako strata">Odpísať</button>' +
    '</span>' +
  '</div>';
}

function render() {
  if (!_container) return;
  const s = _data.summary || { pendingCount: 0, pendingValue: 0, rowCount: 0 };
  const items = _data.items || [];
  const n = Number(s.pendingCount) || 0;

  const listHtml = items.length
    ? items.map(rowHtml).join('')
    : '<p class="set-empty">Žiadne čakajúce storná. Keď čašník stornuje už poslanú položku, objaví sa tu a rozhodnete, či ide späť na sklad, alebo ako strata.</p>';

  _container.innerHTML =
    // Súčet v jednom riadku: koľko čaká a za koľko. Keď nič, len pilulka.
    '<div class="sto-sum">' +
      (n > 0
        ? '<span><strong>' + n + '</strong> ' + itemsWord(n) + '</span>' +
          '<span><strong>' + fmtEur(s.pendingValue || 0) + '</strong> v cenách menu</span>'
        : '<span class="set-pill is-success">Všetko spracované</span>') +
    '</div>' +
    '<div class="set-group sto-list">' + listHtml + '</div>' +
    '<p class="sto-help">Vrátiť na sklad = suroviny idú späť (jedlo sa nerobilo). Odpísať = jedlo už bolo urobené, ide ako strata. Ak bolo storno omyl, zmažte záznam v detaile položky.</p>' +

    // Detail položky ako panel zdola: fakty ako riadky, tri rozhodnutia pod
    // nimi. Zmazanie (storno bol omyl) je len tu — nie na každom riadku.
    '<div id="stornoDetail" class="set-sheet" style="display:none" role="dialog" aria-modal="true" aria-labelledby="stornoDetailTitle">' +
      '<div class="set-sheet-card">' +
        '<h3 class="set-sheet-title" id="stornoDetailTitle"></h3>' +
        '<div class="set-group sto-detail-list" id="stornoDetailRows"></div>' +
        '<div class="sto-detail-acts">' +
          '<button type="button" class="btn-secondary is-return storno-return" id="stornoDetailReturn" data-id="">Vrátiť na sklad</button>' +
          '<button type="button" class="btn-secondary is-writeoff storno-writeoff" id="stornoDetailWriteoff" data-id="">Odpísať ako stratu</button>' +
          '<button type="button" class="btn-secondary is-danger storno-delete" id="stornoDetailDelete" data-id="">Zmazať — storno bol omyl</button>' +
          '<button type="button" class="btn-secondary" id="stornoDetailClose">Zavrieť</button>' +
        '</div>' +
      '</div>' +
    '</div>';

  _container.querySelectorAll('[data-open]').forEach((b) => {
    b.addEventListener('click', () => openDetail(parseInt(b.getAttribute('data-open'), 10)));
  });
  _container.querySelectorAll('.storno-return').forEach((b) => {
    b.addEventListener('click', () => {
      const id = parseInt(b.getAttribute('data-id'), 10);
      if (!id) return;
      closeDetail();
      resolveItem(id, false);
    });
  });
  _container.querySelectorAll('.storno-writeoff').forEach((b) => {
    b.addEventListener('click', () => {
      const id = parseInt(b.getAttribute('data-id'), 10);
      if (!id) return;
      closeDetail();
      resolveItem(id, true);
    });
  });
  _container.querySelectorAll('.storno-delete').forEach((b) => {
    b.addEventListener('click', () => {
      const id = parseInt(b.getAttribute('data-id'), 10);
      if (!id) return;
      closeDetail();
      deleteItem(id);
    });
  });
  const sheet = $('#stornoDetail');
  if (sheet) sheet.addEventListener('click', (e) => { if (e.target === sheet) closeDetail(); });
  const closeBtn = $('#stornoDetailClose');
  if (closeBtn) closeBtn.addEventListener('click', closeDetail);
}

function detailRow(k, v) {
  return '<div class="set-row"><span class="set-k">' + k + '</span><span class="set-r"><span class="set-val">' + v + '</span></span></div>';
}

function openDetail(id) {
  const it = (_data.items || []).find((x) => x.id === id);
  if (!it) return;
  const sheet = $('#stornoDetail');
  if (!sheet) return;
  $('#stornoDetailTitle').textContent = it.itemName + ' × ' + it.qty;
  const rows = [
    detailRow('Suma', esc(fmtEur(Number(it.unitPrice || 0) * it.qty))),
    detailRow('Čašník hlási', it.wasPrepared
      ? '<span class="set-pill is-warning">už pripravené</span>'
      : '<span class="set-pill is-neutral">nepripravené</span>'),
    detailRow('Dôvod', esc(REASON_LABELS[it.reason] || it.reason || '—')),
    detailRow('Čašník', esc(it.staffName || '—')),
    detailRow('Čas', esc(fmtTime(it.createdAt) || '—')),
    it.orderId ? detailRow('Objednávka', '#' + esc(it.orderId)) : '',
    it.note ? detailRow('Poznámka', esc(it.note)) : '',
  ].join('');
  $('#stornoDetailRows').innerHTML = rows;
  ['#stornoDetailReturn', '#stornoDetailWriteoff', '#stornoDetailDelete'].forEach((sel) => {
    const b = $(sel);
    if (b) b.setAttribute('data-id', String(it.id));
  });
  sheet.style.display = 'block';
  const c = $('#stornoDetailClose');
  if (c) c.focus();
}

function closeDetail() {
  const sheet = $('#stornoDetail');
  if (sheet) sheet.style.display = 'none';
}

async function resolveItem(id, wasPrepared) {
  try {
    await api.post('/storno-basket/' + id + '/resolve', { override: { wasPrepared: !!wasPrepared } });
    if (typeof showToast === 'function') {
      showToast(wasPrepared ? 'Odpísané ako strata' : 'Vrátené na sklad', true);
    }
    await load();
  } catch (err) {
    if (typeof showToast === 'function') showToast(err.message || 'Spracovanie zlyhalo', 'error');
  }
}

function deleteItem(id) {
  const doDelete = async () => {
    try {
      await api.del('/storno-basket/' + id);
      if (typeof showToast === 'function') showToast('Záznam zmazaný', true);
      await load();
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.message || 'Zmazanie zlyhalo', 'error');
    }
  };
  if (typeof showConfirm === 'function') {
    showConfirm(
      'Zmazať záznam o storne?',
      'Záznam zmizne bez zásahu do skladu — suroviny sa nevrátia ani neodpíšu. Použite len vtedy, keď bolo storno omyl.',
      doDelete,
      { type: 'danger', confirmText: 'Zmazať záznam' },
    );
  } else {
    doDelete();
  }
}

export function init(container) {
  _container = container;
  _escHandler = (e) => { if (e.key === 'Escape') closeDetail(); };
  document.addEventListener('keydown', _escHandler);
  load();
  // Auto-refresh keď cashier zaznamená nové storno (ak admin má socket).
  if (typeof socket !== 'undefined' && socket && typeof socket.on === 'function') {
    _socketHandler = function () { load(); };
    socket.on('storno-basket:updated', _socketHandler);
  }
}

export function destroy() {
  if (_socketHandler && typeof socket !== 'undefined' && socket && typeof socket.off === 'function') {
    try { socket.off('storno-basket:updated', _socketHandler); } catch (_) {}
  }
  _socketHandler = null;
  if (_escHandler) document.removeEventListener('keydown', _escHandler);
  _escHandler = null;
  _container = null;
  _data = { summary: { pendingCount: 0, pendingValue: 0, rowCount: 0 }, items: [] };
}
