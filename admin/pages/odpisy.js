// admin/pages/odpisy.js
//
// Historia -> Odpisy. Zoznam uctov uzavretych ako manazersky odpis
// (closure_type='odpis', mimo fiskal — bez payment a bez fiskalneho dokladu).
// Ak bol ucet dany na odpis OMYLOM, admin ho moze "Preklopit na fiskal":
// system znova otvori ucet, vystavi fiskalny doklad (eKasa) cez standardny
// platobny pipeline a ucet sa stane normalnym predajom. Po preklopeni zmizne
// z tohto zoznamu (closure_type='paid').
//
// Cita /api/orders/odpis (manazer/admin); preklopenie /api/orders/:id/
// convert-odpis-to-fiscal je admin-only (server to overuje). Pattern strany
// zhodny s payments.js (event-delegation, api.get/api.post, showConfirm/showToast).

import { fmtCost } from '../../components/fmt.js';

let _container = null;
let items = [];
let loading = false;

function byId(id) { return _container.querySelector('#' + id); }

// Jediná implementácia escapovania v projekte je /js/pos-escape.js
// (escHtml pre textový obsah, escAttr pre atribút, escJsAttr pre inline
// handler). Predtým mala takmer každá admin stránka vlastnú kópiu a boli
// medzi nimi ŠTYRI rôzne správania — časť neescapovala apostrof ani
// úvodzovku, čo je práve to, na čom záleží pri interpolácii do atribútu.
// Lokálne meno ostáva, nech sa neprepisujú stovky volaní.
function escapeHtml(v) {
  // window.* zamerne: v moduloch, kde sa lokalna funkcia vola tiez escHtml,
  // by holy identifikator ukazoval sam na seba (nekonecna rekurzia).
  if (typeof window !== 'undefined' && typeof window.escHtml === 'function') return window.escHtml(v);
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtEur(value) {
  var n = Number(value);
  if (!Number.isFinite(n)) return '-';
  return fmtCost(n) + ' €';
}

function fmtDate(value) {
  if (!value) return '-';
  var d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('sk-SK', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function isAdmin() {
  try { var u = api.getUser(); return !!(u && u.role === 'admin'); } catch (_) { return false; }
}

// Preklopenie na fiškál — len admin; tónované tlačidlá v riadku pod údajmi.
function actionsRow(it) {
  if (!isAdmin()) return '';
  return '<div class="rp-row-act">'
    + '<button type="button" class="btn-secondary" data-convert="' + it.id + '" data-method="hotovost" title="Vystaví fiškálny doklad (hotovosť) a účet sa stane predajom">Na fiškál ako hotovosť</button>'
    + '<button type="button" class="btn-secondary" data-convert="' + it.id + '" data-method="karta" title="Vystaví fiškálny doklad (karta) a účet sa stane predajom">Na fiškál ako kartu</button>'
    + '</div>';
}

function itemsWord(n) {
  if (n === 1) return 'položka';
  if (n >= 2 && n <= 4) return 'položky';
  return 'položiek';
}

function renderTable() {
  var el = byId('odpisyTable');
  if (!el) return;

  if (loading) {
    el.innerHTML = '<div class="loading-hint">Načítavam odpísané účty…</div>';
    return;
  }
  if (!items.length) {
    el.innerHTML = '<div class="empty-hint">Žiadne odpísané účty. Odpis vzniká na kase zatvorením účtu „na účet podniku".</div>';
    return;
  }

  var admin = isAdmin();
  var html = '<div class="rp-list">';
  items.forEach(function (it) {
    var n = Number(it.itemCount) || 0;
    html += '<div class="rp-row' + (admin ? ' has-act' : '') + '">'
      + '<div class="rp-row-main">'
        + '<div class="rp-row-t">Účet #' + it.id + (it.label ? ' <small>' + escapeHtml(it.label) + '</small>' : '') + '</div>'
        + '<div class="rp-row-s">' + escapeHtml(fmtDate(it.closedAt)) + (it.tableName ? ' · ' + escapeHtml(it.tableName) : '') + ' · ' + n + ' ' + itemsWord(n) + '</div>'
      + '</div>'
      + '<div class="rp-row-side"><span class="rp-row-v">' + escapeHtml(fmtEur(it.amount)) + '</span></div>'
      + actionsRow(it)
      + '</div>';
  });
  html += '</div>';
  el.innerHTML = html;
}

async function loadList() {
  loading = true;
  renderTable();
  try {
    var res = await api.get('/orders/odpis');
    items = (res && res.items) || [];
  } catch (e) {
    items = [];
    showToast((e && e.message) || 'Chyba načítania odpisov', 'error');
  } finally {
    loading = false;
    renderTable();
  }
}

function confirmConvert(orderId, method) {
  var it = items.find(function (x) { return Number(x.id) === orderId; }) || {};
  var label = method === 'karta' ? 'Karta' : 'Hotovosť';
  showConfirm(
    'Preklopiť odpis na fiškál',
    'Účet #' + orderId + ' (suma ' + fmtEur(it.amount) + ') sa vyberie cez eKasa ako ' + label + ' a stane sa normálnym fiškálnym predajom. '
    + 'Pôvodný odpis sa prestane počítať a doklad bude vystavený s aktuálnym časom. Pokračovať?',
    async function () {
      try {
        var r = await api.post('/orders/' + orderId + '/convert-odpis-to-fiscal', { method: method });
        var st = (r && r.fiscal && r.fiscal.status) || 'ok';
        showToast('Odpis #' + orderId + ' preklopený na fiškál (' + st + ')', true);
        await loadList();
      } catch (e) {
        var msg = (e && e.data && (e.data.error || (e.data.fiscal && e.data.fiscal.errorDetail)))
          || (e && e.message) || 'Preklopenie zlyhalo';
        showToast(msg, 'error');
        await loadList();
      }
    },
    { type: 'danger', confirmText: 'Preklopiť na ' + label },
  );
}

function onClick(event) {
  var convertBtn = event.target.closest('[data-convert]');
  if (convertBtn) {
    confirmConvert(Number(convertBtn.dataset.convert), convertBtn.dataset.method);
    return;
  }
  if (event.target.id === 'btnOdpisyRefresh' || event.target.closest('#btnOdpisyRefresh')) {
    loadList();
  }
}

function getTemplate() {
  return `
    <div class="rp-sub">
      Účty uzavreté ako odpis — mimo fiškál, bez platby a bez dokladu eKasa. Ak bol účet odpísaný omylom, admin ho preklopí na fiškál: vystaví sa doklad cez eKasa a účet sa stane normálnym predajom.
    </div>
    <div id="odpisyTable"></div>
  `;
}

export async function init(container) {
  _container = container;
  container.innerHTML = getTemplate();
  container.addEventListener('click', onClick);
  await loadList();
}

export function destroy() {
  if (_container) {
    _container.removeEventListener('click', onClick);
  }
  _container = null;
  items = [];
  loading = false;
}
