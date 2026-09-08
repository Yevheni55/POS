import { fmtCost } from '../../components/fmt.js';

let _container = null;
let items = [];
let filter = { method: '', q: '', scope: 'current' };
let loading = false;
let lastMeta = { hiddenByScope: 0, activeCashRegisterCode: '' };
// Rozkliknuté detaily dokladov: paymentId -> { loading, error, data } —
// fetch raz, potom cache; prežíva re-render tabuľky (nie reload filtra).
let expanded = {};

function byId(id) {
  return _container.querySelector('#' + id);
}

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

function methodLabel(method) {
  if (method === 'hotovost') return 'Hotovosť';
  if (method === 'karta') return 'Karta';
  return method || '-';
}

// Stav fiškalizácie ako pilulka (tokeny v ios-reporty.css, nie inline hex).
function statusPill(status, tone) {
  var cls = { success: 'is-ok', warning: 'is-warn', error: 'is-bad', muted: 'is-muted' }[tone] || 'is-muted';
  return '<span class="rp-pill ' + cls + '">' + escapeHtml(status) + '</span>';
}

function fiscalTone(s) {
  return /success/.test(s) ? 'success' : (/accepted/.test(s) ? 'warning' : (/ambig|error|reject|block|valid/.test(s) ? 'error' : 'muted'));
}

// Stav dokladu po slovensky; neznámy stav ostáva surový (nič sa neskryje).
var FISCAL_LABELS = {
  online_success: 'eKasa online',
  offline_success: 'eKasa offline',
  offline_accepted: 'offline, čaká',
  reconciled: 'eKasa',
  mismatch_rejected: 'nesúlad položiek',
  ambiguous: 'nejasný stav',
  rejected: 'zamietnuté',
  blocked: 'blokované',
  invalid: 'neplatné',
};
function fiscalLabel(s) {
  return FISCAL_LABELS[s] || s;
}

// Pilulka do riadku zoznamu: stornované / bez eKasa / stav dokladu.
function fiscalPill(item) {
  if (item.storno) return statusPill('Stornované', 'warning');
  if (!item.fiscal) return statusPill('bez eKasa', 'muted');
  var s = String(item.fiscal.status || '');
  return statusPill(fiscalLabel(s), fiscalTone(s));
}

// Číslo dokladu / OKP — druhý riadok pod stavom v detaile.
function fiscalMeta(item) {
  var meta = '';
  if (item.storno && item.storno.externalId) meta += escapeHtml(item.storno.externalId);
  if (item.fiscal && item.fiscal.receiptNumber) meta += (meta ? ' · ' : '') + 'č. ' + escapeHtml(item.fiscal.receiptNumber);
  if (item.fiscal && item.fiscal.okp) meta += (meta ? ' · ' : '') + escapeHtml(item.fiscal.okp);
  // Surový stav z Portosu — pre reklamácie a ladenie musí ostať čitateľný.
  if (item.fiscal && item.fiscal.status && FISCAL_LABELS[item.fiscal.status]) meta += (meta ? ' · ' : '') + escapeHtml(item.fiscal.status);
  return meta;
}

// Doklad vystavený pod iným kódom pokladnice (predchádzajúca firma / stará
// eKasa) — Portos preň už nemá certifikát, takže storno ani dotlač neprejdú.
// Server to hlási cez `stornoBlockedReason`; fallback porovnáva kód dokladu
// s aktívnym kódom, aby to fungovalo aj v scope=all pohľade.
function foreignCashRegisterCode(item) {
  if (item.stornoBlockedReason && item.stornoBlockedReason !== 'foreign_cash_register') return '';
  var docCode = String((item.fiscal && item.fiscal.cashRegisterCode) || '').trim();
  if (!docCode) return '';
  if (item.stornoBlockedReason === 'foreign_cash_register') return docCode;
  var activeCode = String(lastMeta.activeCashRegisterCode || '').trim();
  if (!activeCode) return '';
  return docCode === activeCode ? '' : docCode;
}

// Akcie dokladu — v detaile, nie na každom riadku. Jedna plná (kópia, keď je
// k dispozícii), ostatné tónované; STORNO ako posledné a červené.
function actionsBlock(item) {
  var html = '';
  var foreignCode = foreignCashRegisterCode(item);
  if (item.copyAvailable) {
    var copyTitle = foreignCode
      ? 'Doklad patrí predchádzajúcej firme (kód ' + foreignCode + ') — dotlač prejde iba ak Portos ešte má certifikát pre starý alias.'
      : 'Vytlačí kópiu dokladu na CHDU';
    html += '<button type="button" class="btn-add" data-payment-copy="' + item.id + '" title="' + escapeHtml(copyTitle) + '">Vytlačiť kópiu dokladu</button>';
  }
  // Re-fiškalizácia: iba keď to doklad naozaj potrebuje (mismatch / ambiguous /
  // rejected) — pre platne zaevidovaný doklad server vracia 409, správna cesta
  // je STORNO.
  if (item.fiscal) {
    var fiscalStatus = String(item.fiscal.status || '');
    var needsRefiscalize = fiscalStatus === 'mismatch_rejected' || fiscalStatus === 'ambiguous' || fiscalStatus === 'rejected';
    if (needsRefiscalize) {
      html += '<button type="button" class="btn-secondary rp-btn-warn" data-payment-refiscalize="' + item.id + '" title="Pošle nový fiškálny request a vytlačí blok">Re-fiškalizovať</button>';
    }
  }
  // Zmena spôsobu platby — iba ak je platba storno-eligible. Backend urobí
  // storno pôvodného + nový doklad s novým spôsobom.
  if (item.stornoEligible) {
    var swapTo = item.method === 'hotovost' ? 'karta' : 'hotovost';
    var swapLabel = item.method === 'hotovost' ? 'kartu' : 'hotovosť';
    html += '<button type="button" class="btn-secondary" data-payment-change-method="' + item.id + '" data-new-method="' + swapTo + '" title="Storno pôvodného dokladu + nový doklad s novým spôsobom">Zmeniť spôsob na ' + swapLabel + '</button>';
    html += '<button type="button" class="btn-secondary rp-btn-danger" data-payment-storno="' + item.id + '">Odoslať STORNO</button>';
  } else if (foreignCode && !item.storno) {
    // Storno by v Portose skončilo na „certifikát s aliasom … nebol nájdený".
    html += '<button type="button" class="btn-secondary rp-btn-danger" disabled aria-disabled="true" title="Storno treba vystaviť v eKase pôvodnej firmy">Odoslať STORNO</button>'
          + '<div class="rp-foot">Doklad patrí predchádzajúcej firme (kód ' + escapeHtml(foreignCode) + ') — storno treba vystaviť v jej eKase.</div>';
  } else if (item.storno) {
    html += '<div class="rp-foot">Doklad je už stornovaný.</div>';
  } else if (item.fiscal) {
    html += '<div class="rp-foot">Storno nie je dostupné — doklad nie je v stave, ktorý sa dá stornovať.</div>';
  }
  return html ? '<div class="rp-sheet-actions">' + html + '</div>' : '';
}

function rowTitle(item) {
  var t = item.tableName ? escapeHtml(item.tableName) : 'Platba #' + item.id;
  if (item.orderLabel) t += ' <small>' + escapeHtml(item.orderLabel) + '</small>';
  return t;
}

function renderTable() {
  var el = byId('paymentsTable');
  if (!el) return;

  if (loading) {
    el.innerHTML = '<div class="loading-hint">Načítavam históriu platieb…</div>';
    return;
  }
  if (!items.length) {
    el.innerHTML = '<div class="empty-hint">Žiadne platby podľa filtra. Skús iný spôsob platby, rozsah „Všetky" alebo vymaž hľadanie.</div>';
    return;
  }

  // Zoznam riadkov: stôl/účet + čas a spôsob, suma vpravo, stav ako pilulka.
  // Celý riadok je tap target — otvorí detail (položky + akcie).
  var html = '<div class="rp-list">';
  items.forEach(function (item) {
    var isOpen = !!expanded[item.id];
    html += '<button type="button" class="rp-row has-chev' + (isOpen ? ' is-on' : '') + '" data-payment-items="' + item.id + '" aria-expanded="' + (isOpen ? 'true' : 'false') + '">'
      + '<span class="rp-row-main">'
        + '<span class="rp-row-t">' + rowTitle(item) + '</span>'
        + '<span class="rp-row-s">' + escapeHtml(fmtDate(item.createdAt)) + ' · ' + escapeHtml(methodLabel(item.method)) + ' · #' + item.id + (item.orderId ? ' / obj. #' + item.orderId : '') + '</span>'
      + '</span>'
      + '<span class="rp-row-side">'
        + '<span class="rp-row-v">' + escapeHtml(fmtEur(item.amount)) + '</span>'
        + fiscalPill(item)
      + '</span>'
      + '<svg class="rp-row-chev" aria-hidden="true" viewBox="0 0 16 16"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      + '</button>';
  });
  html += '</div>';

  // Detail otvorenej platby — panel zdola (telefón) / modál (desktop).
  Object.keys(expanded).forEach(function (id) {
    var item = items.find(function (x) { return String(x.id) === String(id); });
    if (item) html += detailSheet(item, expanded[id]);
  });
  el.innerHTML = html;
}

function detailSheet(item, d) {
  var meta = fiscalMeta(item);
  return '<div class="u-overlay show" role="dialog" aria-modal="true" aria-labelledby="payDetailTitle' + item.id + '">'
    + '<button type="button" class="rp-scrim" data-payment-items="' + item.id + '" aria-label="Zavrieť"></button>'
    + '<div class="u-modal rp-sheet">'
      + '<div class="rp-sheet-head"><div>'
        + '<h3 class="rp-sheet-title" id="payDetailTitle' + item.id + '">' + rowTitle(item) + '</h3>'
        + '<div class="rp-sheet-sub">' + escapeHtml(fmtDate(item.createdAt)) + ' · platba #' + item.id + (item.orderId ? ' · obj. #' + item.orderId : '') + '</div>'
      + '</div><button type="button" class="rp-sheet-close" data-payment-items="' + item.id + '" aria-label="Zavrieť">×</button></div>'
      + '<div class="rp-sheet-body">'
        + '<dl class="rp-kv">'
          + '<dt>Suma</dt><dd>' + escapeHtml(fmtEur(item.amount)) + '</dd>'
          + '<dt>Spôsob</dt><dd>' + escapeHtml(methodLabel(item.method)) + '</dd>'
          + '<dt>Fiškalizácia</dt><dd>' + fiscalPill(item) + (meta ? '<small>' + meta + '</small>' : '') + '</dd>'
        + '</dl>'
        + detailCell(d)
      + '</div>'
      + actionsBlock(item)
    + '</div></div>';
}

// Detail dokladu — položky objednávky. Ceny sú z AKTUÁLNEHO menu
// (order_items nemá cenový snapshot), preto sa pri rozdiele voči sume
// dokladu rozdiel priznáva namiesto tichého dopočítavania.
function detailCell(d) {
  if (d.loading) {
    return '<div class="loading-hint">Načítavam položky…</div>';
  }
  if (d.error) {
    return '<div class="error-hint">' + escapeHtml(d.error) + '</div>';
  }
  var data = d.data || {};
  var list = data.items || [];
  if (!list.length) {
    return '<div class="empty-hint">Objednávka nemá položky (zmazané alebo presunuté).</div>';
  }
  var html = '<div class="rp-items">';
  list.forEach(function (it) {
    html += '<div class="rp-item">'
      + '<span class="rp-item-q">' + it.qty + '×</span>'
      + '<span class="rp-item-n">' + escapeHtml((it.emoji ? it.emoji + ' ' : '') + it.name)
        + (it.note ? '<small>+ ' + escapeHtml(it.note) + '</small>' : '') + '</span>'
      + '<span class="rp-item-p">' + (it.lineTotal == null ? '—' : escapeHtml(fmtEur(it.lineTotal)))
        + (it.price == null ? '' : '<small>' + escapeHtml(fmtEur(it.price)) + ' / ks</small>') + '</span>'
      + '</div>';
  });
  html += '</div>';

  var amount = Number(data.amount);
  var itemsTotal = Number(data.itemsTotal);
  html += '<div class="rp-item-sum">';
  if (data.discountAmount > 0) {
    html += '<span>Zľava −' + escapeHtml(fmtEur(data.discountAmount)) + '</span>';
  }
  html += '<span>Súčet položiek ' + escapeHtml(fmtEur(itemsTotal)) + '</span>';
  html += '<strong>Suma dokladu ' + escapeHtml(fmtEur(amount)) + '</strong>';
  html += '</div>';

  var diff = Math.abs((itemsTotal - (data.discountAmount > 0 ? data.discountAmount : 0)) - amount);
  if (data.priceMissing || (Number.isFinite(diff) && diff > 0.01)) {
    html += '<div class="rp-foot">'
          + 'Ceny položiek sú z aktuálneho menu — pri zmene cien po platbe sa súčet môže líšiť od sumy dokladu.'
          + (data.priceMissing ? ' Niektoré položky už nie sú v menu.' : '')
          + '</div>';
  }
  return html;
}

async function toggleItems(id) {
  if (expanded[id]) {
    delete expanded[id];
    renderTable();
    return;
  }
  expanded[id] = { loading: true, error: null, data: null };
  renderTable();
  try {
    var data = await api.getPaymentItems(id);
    if (!expanded[id]) return;   // medzitým zavreté
    expanded[id] = { loading: false, error: null, data: data };
  } catch (e) {
    if (!expanded[id]) return;
    expanded[id] = { loading: false, error: e.message || 'Položky sa nepodarilo načítať', data: null };
  }
  renderTable();
}

async function loadHistory() {
  loading = true;
  renderTable();
  try {
    var res = await api.getPaymentsHistory({
      method: filter.method || undefined,
      q: filter.q || undefined,
      scope: filter.scope,
      limit: 200,
    });
    items = (res && res.items) || [];
    lastMeta = {
      hiddenByScope: res && Number(res.hiddenByScope) || 0,
      activeCashRegisterCode: (res && res.activeCashRegisterCode) || '',
    };
  } catch (e) {
    items = [];
    lastMeta = { hiddenByScope: 0, activeCashRegisterCode: '' };
    showToast(e.message || 'Chyba načítania histórie', 'error');
  } finally {
    loading = false;
    renderTable();
    renderScopeHint();
  }
}

function renderScopeHint() {
  var el = byId('paymentsScopeHint');
  if (!el) return;
  if (filter.scope === 'all') {
    el.innerHTML = 'Zobrazené sú všetky platby vrátane starej eKasy / inej firmy.';
    return;
  }
  if (lastMeta.hiddenByScope > 0) {
    el.innerHTML = 'Iba aktuálna eKasa (' + escapeHtml(lastMeta.activeCashRegisterCode || '-') + ') · skrytých ' + lastMeta.hiddenByScope + ' zo starej eKasy — prepni na „Všetky".';
    return;
  }
  el.innerHTML = 'Iba aktuálna eKasa (' + escapeHtml(lastMeta.activeCashRegisterCode || '-') + ').';
}

async function printCopy(id) {
  try {
    var r = await api.printReceiptCopy(id);
    showToast(r && r.printed ? 'Kópia dokladu odoslaná na CHDU' : 'Požiadavka na kópiu prijatá', true);
  } catch (e) {
    var msg = (e && e.data && (e.data.error || e.data.detail)) || e.message || 'Kópiu sa nepodarilo vytlačiť';
    showToast(msg, 'error');
  }
}

function confirmRefiscalize(id) {
  showConfirm(
    'Re-fiškalizovať platbu',
    'Pošle nový fiškálny request pre platbu #' + id + ' s reálnymi položkami pod novým externalId. Pôvodný fiškálny záznam bude nahradený a kópia bonu sa hneď vytlačí na CHDU. Použiť keď blok nevyšiel alebo vyšiel cudzí.',
    async function () {
      try {
        var r = await api.refiscalizePayment(id);
        var st = (r && r.fiscal && r.fiscal.status) || 'ok';
        var printed = r && r.print && r.print.printed;
        showToast('Re-fiškalizácia OK (' + st + ')' + (printed ? ' · blok vytlačený' : ' · blok v queue'), true);
        await loadHistory();
      } catch (e) {
        var msg = (e && e.data && (e.data.error || e.data.detail)) || e.message || 'Re-fiškalizácia zlyhala';
        showToast(msg, 'error');
      }
    },
    { type: 'danger', confirmText: 'Re-fiškalizovať' },
  );
}

// Zmena sposobu platby na uz vytlacenom doklade. Ukaze potvrdzovaci modal
// (volaca operacia stornuje povodny doklad cez Portos a vytlaci novy s
// novym sposobom — preto manazerske confirm-uje).
function confirmChangeMethod(id, newMethod) {
  var newLabel = newMethod === 'karta' ? 'Karta' : 'Hotovosť';
  showConfirm(
    'Zmena spôsobu platby',
    'Zmeniť platbu #' + id + ' na <strong>' + newLabel + '</strong>?<br><br>'
    + 'Operácia: stornuje pôvodný fiškálny doklad cez Portos a vystaví nový s novým spôsobom platby. Vytlačia sa <strong>2 doklady</strong> na CHDU (storno + nový).',
    async function () {
      try {
        var r = await api.changePaymentMethod(id, newMethod);
        var st = (r && r.fiscal && r.fiscal.status) || 'ok';
        showToast('Spôsob zmenený na ' + newLabel + ' (' + st + ')', true);
        await loadHistory();
      } catch (e) {
        var msg = (e && e.data && (e.data.error || e.data.detail)) || e.message || 'Chyba pri zmene spôsobu';
        showToast(msg, 'error');
      }
    },
    { type: 'danger', confirmText: 'Zmeniť na ' + newLabel },
  );
}

function confirmStorno(id) {
  showConfirm(
    'Fiškálne STORNO',
    'Naozaj odoslať STORNO pre platbu #' + id + '? Operácia odošle opravný doklad do eKasy cez Portos a vytlačí blok na CHDU.',
    async function () {
      try {
        var r = await api.stornoPayment(id);
        var st = (r && r.fiscal && r.fiscal.status) || 'ok';
        showToast('STORNO odoslané (' + st + ')', true);
        await loadHistory();
      } catch (e) {
        var msg = (e && e.data && (e.data.error || e.data.detail)) || e.message || 'Chyba STORNO';
        showToast(msg, 'error');
      }
    },
    { type: 'danger', confirmText: 'Odoslať STORNO' },
  );
}

function setSegActive(groupId, attr, value) {
  var group = byId(groupId);
  if (!group) return;
  Array.prototype.forEach.call(group.querySelectorAll('[' + attr + ']'), function (b) {
    var on = b.getAttribute(attr) === value;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

function onClick(event) {
  var scopeBtn = event.target.closest('[data-pay-scope]');
  if (scopeBtn) {
    filter.scope = scopeBtn.dataset.payScope || 'current';
    setSegActive('paymentsScope', 'data-pay-scope', filter.scope);
    loadHistory();
    return;
  }
  var methodBtn = event.target.closest('[data-pay-method]');
  if (methodBtn) {
    filter.method = methodBtn.dataset.payMethod || '';
    setSegActive('paymentsMethod', 'data-pay-method', filter.method);
    loadHistory();
    return;
  }
  var itemsBtn = event.target.closest('[data-payment-items]');
  if (itemsBtn) {
    toggleItems(Number(itemsBtn.dataset.paymentItems));
    return;
  }
  var changeMethod = event.target.closest('[data-payment-change-method]');
  if (changeMethod) {
    confirmChangeMethod(
      Number(changeMethod.dataset.paymentChangeMethod),
      changeMethod.dataset.newMethod,
    );
    return;
  }
  var storno = event.target.closest('[data-payment-storno]');
  if (storno) {
    confirmStorno(Number(storno.dataset.paymentStorno));
    return;
  }
  var copy = event.target.closest('[data-payment-copy]');
  if (copy) {
    printCopy(Number(copy.dataset.paymentCopy));
    return;
  }
  var refisc = event.target.closest('[data-payment-refiscalize]');
  if (refisc) {
    confirmRefiscalize(Number(refisc.dataset.paymentRefiscalize));
    return;
  }
  if (event.target.id === 'btnPaymentsRefresh' || event.target.closest('#btnPaymentsRefresh')) {
    loadHistory();
  }
}

function onChange(event) {
  if (event.target.id === 'paymentsMethod') {
    filter.method = event.target.value;
    loadHistory();
    return;
  }
  if (event.target.id === 'paymentsScope') {
    filter.scope = event.target.value;
    loadHistory();
  }
}

function onInput(event) {
  if (event.target.id === 'paymentsQuery') {
    filter.q = event.target.value;
    clearTimeout(onInput._timer);
    onInput._timer = setTimeout(loadHistory, 250);
  }
}

function getTemplate() {
  return `
    <div class="doch-head rp-head">
      <div class="rp-seg" id="paymentsScope" role="group" aria-label="Rozsah">
        <button type="button" class="active" data-pay-scope="current" aria-pressed="true">Táto eKasa</button>
        <button type="button" data-pay-scope="all" aria-pressed="false">Všetky</button>
      </div>
      <div class="rp-seg" id="paymentsMethod" role="group" aria-label="Spôsob platby">
        <button type="button" class="active" data-pay-method="" aria-pressed="true">Všetky</button>
        <button type="button" data-pay-method="hotovost" aria-pressed="false">Hotovosť</button>
        <button type="button" data-pay-method="karta" aria-pressed="false">Karta</button>
      </div>
      <input class="search-input" id="paymentsQuery" type="search" placeholder="Hľadať číslo platby, stôl alebo objednávku" aria-label="Hľadať">
      <div id="paymentsScopeHint" class="doch-range"></div>
    </div>
    <div class="rp-sub">Klepnutím na platbu otvoríš položky a akcie: kópia dokladu, zmena spôsobu platby, storno.</div>
    <div id="paymentsTable"></div>
  `;
}

export async function init(container) {
  _container = container;
  container.innerHTML = getTemplate();
  container.addEventListener('click', onClick);
  container.addEventListener('change', onChange);
  container.addEventListener('input', onInput);
  await loadHistory();
}

export function destroy() {
  if (_container) {
    _container.removeEventListener('click', onClick);
    _container.removeEventListener('change', onChange);
    _container.removeEventListener('input', onInput);
  }
  _container = null;
  items = [];
  filter = { method: '', q: '' };
  loading = false;
  expanded = {};
}
