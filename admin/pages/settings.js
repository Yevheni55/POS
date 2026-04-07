/* Settings page module */
let _container = null;

const DEFAULTS = {
  sName: 'Kaviaren & Bar',
  sAddress: 'Hlavna 15, 811 01 Bratislava',
  sPhone: '+421 2 1234 5678',
  sEmail: 'info@kaviarenbar.sk',
  sIco: '12345678',
  sDic: 'SK2012345678',
  sIcDph: '',
  sVat: 20,
  sCurrency: 'EUR',
  sRounding: 'centy',
  sTipEnabled: true,
  sTipDefault: 10,
  sReceiptName: 'Kaviaren & Bar',
  sReceiptFooter: 'Dakujeme za navstevu!',
  sReceiptFormat: '80mm',
  sAutoPrint: true,
  sShowVat: true,
  sPrimaryColor: '#8B7CF6',
  sSecondaryColor: '#8B7CF6',
  hours: [
    { day: 'Pondelok', open: true, from: '08:00', to: '22:00' },
    { day: 'Utorok',   open: true, from: '08:00', to: '22:00' },
    { day: 'Streda',   open: true, from: '08:00', to: '22:00' },
    { day: 'Stvrtok',  open: true, from: '08:00', to: '22:00' },
    { day: 'Piatok',   open: true, from: '08:00', to: '22:00' },
    { day: 'Sobota',   open: true, from: '09:00', to: '23:00' },
    { day: 'Nedela',   open: true, from: '10:00', to: '20:00' }
  ]
};

const DEST_LABELS = {
  all: 'Vsetko',
  kuchyna: 'Kuchyna',
  bar: 'Bar',
  uctenka: 'Uctenka'
};

let settings = {};
let adminPrinters = [];
let adminDiscounts = [];
let editingPrinterId = null;
let portosStatus = null;
let portosStatusError = '';
let portosStatusLoading = false;

function qs(sel) { return _container.querySelector(sel); }
function byId(id) { return _container.querySelector('#' + id); }
function qsAll(sel) { return _container.querySelectorAll(sel); }

/* ─── TEMPLATE ─── */
function getTemplate() {
  return `
    <!-- SECTION 1: Zakladne udaje -->
    <div class="section">
      <div class="section-title">
        <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M4 4h12v12H4z" fill="none" stroke="currentColor" stroke-width="1.5" rx="2"/><path d="M7 8h6M7 11h4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
        Zakladne udaje
      </div>
      <div class="form-grid">
        <div class="form-group">
          <label for="sName">Nazov podniku<span class="required-mark" aria-hidden="true"> *</span></label>
          <input class="form-input" id="sName" type="text" aria-required="true" data-validate="required">
        </div>
        <div class="form-group">
          <label for="sAddress">Adresa</label>
          <input class="form-input" id="sAddress" type="text">
        </div>
        <div class="form-group">
          <label for="sPhone">Telefon</label>
          <input class="form-input" id="sPhone" type="text" placeholder="napr. +421 900 123 456">
        </div>
        <div class="form-group">
          <label for="sEmail">Email</label>
          <input class="form-input" id="sEmail" type="text" data-validate="email">
        </div>
        <div class="form-group">
          <label for="sIco">ICO</label>
          <input class="form-input" id="sIco" type="text" title="Identifikacne cislo organizacie (8-ciferny kod)" placeholder="napr. 12345678">
        </div>
        <div class="form-group">
          <label for="sDic">DIC</label>
          <input class="form-input" id="sDic" type="text" title="Danova identifikacne cislo" placeholder="napr. 2023456789">
        </div>
        <div class="form-group">
          <label for="sIcDph">IC DPH</label>
          <input class="form-input" id="sIcDph" type="text" title="Identifikacne cislo pre DPH (napr. SK2023456789)" placeholder="napr. SK2023456789">
        </div>
      </div>
    </div>

    <!-- SECTION 2: Financne nastavenia -->
    <div class="section">
      <div class="section-title">
        <svg aria-hidden="true" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10 5v10M7 7.5h4.5a2 2 0 010 4H7M8 11.5h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
        Financne nastavenia
      </div>
      <div class="form-grid">
        <div class="form-group">
          <label for="sVat">DPH sadzba</label>
          <div class="input-suffix">
            <input class="form-input" id="sVat" type="number" min="0" max="100" data-validate="number" title="Sadzba DPH v percentach">
            <span class="suffix">%</span>
          </div>
        </div>
        <div class="form-group">
          <label for="sCurrency">Mena</label>
          <select class="form-select" id="sCurrency">
            <option value="EUR">EUR</option>
            <option value="CZK">CZK</option>
            <option value="USD">USD</option>
          </select>
        </div>
        <div class="form-group">
          <label for="sRounding">Zaokruhlovanie</label>
          <select class="form-select" id="sRounding" title="Zaokruhlovanie na najblizsi cent">
            <option value="centy">Na centy</option>
            <option value="5centov">Na 5 centov</option>
            <option value="10centov">Na 10 centov</option>
          </select>
        </div>
        <div class="form-group">
          <label>Sprepitne</label>
          <div class="flex-row flex-wrap align-center gap-3 mt-1">
            <div class="toggle-row">
              <button class="toggle on" id="sTipToggle"></button>
              <span class="toggle-label" id="sTipLabel">Zapnute</span>
            </div>
            <div class="tip-options" id="tipOptions">
              <button class="tip-opt" data-val="5">5%</button>
              <button class="tip-opt active" data-val="10">10%</button>
              <button class="tip-opt" data-val="15">15%</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- SECTION 3: Otvaracie hodiny -->
    <div class="section">
      <div class="section-title">
        <svg aria-hidden="true" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10 5v5l3.5 2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Otvaracie hodiny
      </div>
      <table class="hours-table">
        <thead>
          <tr><th>Den</th><th>Stav</th><th>Od</th><th></th><th>Do</th></tr>
        </thead>
        <tbody id="hoursBody"></tbody>
      </table>
    </div>

    <!-- SECTION 4: Tlac a uctenky -->
    <div class="section">
      <div class="section-title">
        <svg aria-hidden="true" viewBox="0 0 20 20"><rect x="4" y="2" width="12" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="2" y="7" width="16" height="8" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M6 15v3h8v-3" fill="none" stroke="currentColor" stroke-width="1.3"/><line x1="7" y1="11" x2="13" y2="11" stroke="currentColor" stroke-width="1" stroke-linecap="round"/></svg>
        Tlac a uctenky
      </div>
      <div class="form-grid">
        <div class="form-group">
          <label for="sReceiptName">Nazov na uctenke</label>
          <input class="form-input" id="sReceiptName" type="text">
        </div>
        <div class="form-group">
          <label for="sReceiptFormat">Format uctenky</label>
          <select class="form-select" id="sReceiptFormat">
            <option value="80mm">80mm termalna</option>
            <option value="A4">A4</option>
            <option value="none">Bez tlace</option>
          </select>
        </div>
        <div class="form-group full">
          <label for="sReceiptFooter">Pata uctenky</label>
          <textarea class="form-input" id="sReceiptFooter" rows="2"></textarea>
        </div>
        <div class="form-group">
          <label>Tlacit automaticky</label>
          <div class="toggle-row mt-1">
            <button class="toggle on" id="sAutoPrint"></button>
            <span class="toggle-label">Zapnute</span>
          </div>
        </div>
        <div class="form-group">
          <label>Zobrazit DPH rozpis</label>
          <div class="toggle-row mt-1">
            <button class="toggle on" id="sShowVat"></button>
            <span class="toggle-label">Zapnute</span>
          </div>
        </div>
      </div>
    </div>

    <!-- SECTION: Tlaciarni -->
    <div class="section">
      <div class="section-title">
        <svg aria-hidden="true" viewBox="0 0 20 20"><rect x="4" y="2" width="12" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="2" y="7" width="16" height="8" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M6 15v3h8v-3" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="14" cy="10" r="1" fill="currentColor"/></svg>
        Tlaciarni
      </div>
      <div class="mb-3">
        <button class="btn-save btn-sm" id="btnAddPrinter">+ Pridat tlaciaren</button>
      </div>
      <div id="addPrinterForm" class="inline-form-panel" style="display:none">
        <div class="form-grid form-grid-printer">
          <div class="form-group">
            <label for="newPrinterName">Nazov</label>
            <input class="form-input" id="newPrinterName" type="text" placeholder="napr. Kuchynska tlaciaren">
          </div>
          <div class="form-group">
            <label for="newPrinterIp">IP adresa</label>
            <input class="form-input" id="newPrinterIp" type="text" placeholder="192.168.0.107">
          </div>
          <div class="form-group">
            <label for="newPrinterPort">Port</label>
            <input class="form-input" id="newPrinterPort" type="number" value="9100" min="1" max="65535">
          </div>
          <div class="form-group">
            <label for="newPrinterDest">Ucel</label>
            <select class="form-select" id="newPrinterDest">
              <option value="all">Vsetko</option>
              <option value="kuchyna">Kuchyna</option>
              <option value="bar">Bar</option>
              <option value="uctenka">Uctenka</option>
            </select>
          </div>
        </div>
        <div class="flex-row gap-2 mt-3">
          <button class="btn-save btn-sm" id="btnSavePrinter">Ulozit</button>
          <button class="btn-reset btn-sm" id="btnCancelPrinter">Zrusit</button>
        </div>
      </div>
      <div id="printersTable"></div>
    </div>

    <!-- SECTION 5: Portos diagnostika -->
    <div class="section">
      <div class="section-title">
        <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M10 2l7 4v8l-7 4-7-4V6l7-4z" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10 6v4l3 2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
        Portos eKasa diagnostika
      </div>
      <div id="portosDiagnostics"></div>
      <div class="flex-row gap-2 mt-3">
        <button class="btn-save btn-sm" id="btnRefreshPortos">Obnovit stav</button>
      </div>
    </div>

    <!-- SECTION 6: Vzhladove nastavenia -->
    <div class="section">
      <div class="section-title">
        <svg aria-hidden="true" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="7" cy="8" r="1.5" fill="currentColor"/><circle cx="13" cy="8" r="1.5" fill="currentColor"/><path d="M6.5 13c1 1.5 5.5 1.5 7 0" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
        Vzhladove nastavenia
      </div>
      <div class="form-grid">
        <div class="form-group">
          <label>Primarna farba</label>
          <div class="color-input-wrap">
            <div class="color-swatch">
              <input type="color" id="sPrimaryColor">
            </div>
            <span class="color-hex" id="primaryHex">#8B7CF6</span>
          </div>
        </div>
        <div class="form-group">
          <label>Sekundarna farba</label>
          <div class="color-input-wrap">
            <div class="color-swatch">
              <input type="color" id="sSecondaryColor">
            </div>
            <span class="color-hex" id="secondaryHex">#8B7CF6</span>
          </div>
        </div>
      </div>
    </div>

    <!-- SECTION 7: Zlavy -->
    <div class="section">
      <div class="section-title">
        <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M17.7 11.3l-6.4 6.4a2 2 0 01-2.8 0L2 11.2V2h9.2l6.5 6.5a2 2 0 010 2.8z" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="6.5" cy="6.5" r="1.5" fill="currentColor"/></svg>
        Zlavy
      </div>
      <div class="mb-3">
        <button class="btn-save btn-sm" id="btnAddDiscount">+ Pridat zlavu</button>
      </div>
      <div id="addDiscountForm" class="inline-form-panel" style="display:none">
        <div class="form-grid three-col">
          <div class="form-group">
            <label for="newDiscName">Nazov</label>
            <input class="form-input" id="newDiscName" type="text" placeholder="napr. Happy Hour -20%">
          </div>
          <div class="form-group">
            <label for="newDiscType">Typ</label>
            <select class="form-select" id="newDiscType">
              <option value="percent">Percento (%)</option>
              <option value="fixed">Pevna suma (EUR)</option>
            </select>
          </div>
          <div class="form-group">
            <label for="newDiscValue">Hodnota</label>
            <input class="form-input" id="newDiscValue" type="number" min="0" step="0.01" placeholder="10">
          </div>
        </div>
        <div class="flex-row gap-2 mt-3">
          <button class="btn-save btn-sm" id="btnSaveDiscount">Ulozit</button>
          <button class="btn-reset btn-sm" id="btnCancelDiscount">Zrusit</button>
        </div>
      </div>
      <div id="discountsTable"></div>
    </div>

    <!-- FOOTER -->
    <div class="settings-footer">
      <button class="btn-reset" id="resetBtn">Obnovit povodne</button>
      <button class="btn-save" id="saveBtn">Ulozit zmeny</button>
    </div>
  `;
}

/* ─── SETTINGS LOAD / SAVE ─── */

function loadSettings() {
  var saved = localStorage.getItem('pos_settings');
  if (saved) {
    try { settings = JSON.parse(saved); } catch (e) { settings = {}; }
  }
  Object.keys(DEFAULTS).forEach(function (k) {
    if (settings[k] === undefined) settings[k] = JSON.parse(JSON.stringify(DEFAULTS[k]));
  });
  applyToForm();
}

function applyToForm() {
  byId('sName').value = settings.sName;
  byId('sAddress').value = settings.sAddress;
  byId('sPhone').value = settings.sPhone;
  byId('sEmail').value = settings.sEmail;
  byId('sIco').value = settings.sIco;
  byId('sDic').value = settings.sDic;
  byId('sIcDph').value = settings.sIcDph || '';
  byId('sVat').value = settings.sVat;
  byId('sCurrency').value = settings.sCurrency;
  byId('sRounding').value = settings.sRounding;

  var tipToggle = byId('sTipToggle');
  tipToggle.classList.toggle('on', settings.sTipEnabled);
  byId('sTipLabel').textContent = settings.sTipEnabled ? 'Zapnute' : 'Vypnute';
  byId('tipOptions').style.opacity = settings.sTipEnabled ? '1' : '.3';
  byId('tipOptions').style.pointerEvents = settings.sTipEnabled ? 'all' : 'none';
  qsAll('.tip-opt').forEach(function (btn) {
    btn.classList.toggle('active', parseInt(btn.dataset.val) === settings.sTipDefault);
  });

  byId('sReceiptName').value = settings.sReceiptName;
  byId('sReceiptFooter').value = settings.sReceiptFooter;
  byId('sReceiptFormat').value = settings.sReceiptFormat;
  byId('sAutoPrint').classList.toggle('on', settings.sAutoPrint);
  byId('sShowVat').classList.toggle('on', settings.sShowVat);

  byId('sPrimaryColor').value = settings.sPrimaryColor;
  byId('sSecondaryColor').value = settings.sSecondaryColor;
  byId('primaryHex').textContent = settings.sPrimaryColor;
  byId('secondaryHex').textContent = settings.sSecondaryColor;

  renderHours();
}

function gatherSettings() {
  settings.sName = byId('sName').value;
  settings.sAddress = byId('sAddress').value;
  settings.sPhone = byId('sPhone').value;
  settings.sEmail = byId('sEmail').value;
  settings.sIco = byId('sIco').value;
  settings.sDic = byId('sDic').value;
  settings.sIcDph = byId('sIcDph').value;
  settings.sVat = parseInt(byId('sVat').value) || 0;
  settings.sCurrency = byId('sCurrency').value;
  settings.sRounding = byId('sRounding').value;
  settings.sReceiptName = byId('sReceiptName').value;
  settings.sReceiptFooter = byId('sReceiptFooter').value;
  settings.sReceiptFormat = byId('sReceiptFormat').value;
  settings.sAutoPrint = byId('sAutoPrint').classList.contains('on');
  settings.sShowVat = byId('sShowVat').classList.contains('on');
  settings.sPrimaryColor = byId('sPrimaryColor').value;
  settings.sSecondaryColor = byId('sSecondaryColor').value;
}

function saveSettingsAction() {
  if (!validateForm(_container)) return;
  var btn = byId('saveBtn');
  if (btn) btnLoading(btn);
  gatherSettings();
  localStorage.setItem('pos_settings', JSON.stringify(settings));
  showToast('Nastavenia ulozene', true);
  if (btn) btnReset(btn);
}

function resetDefaults() {
  showConfirm('Obnovit nastavenia', 'Vsetky nastavenia budu obnovene na povodne hodnoty.', function () {
    settings = JSON.parse(JSON.stringify(DEFAULTS));
    localStorage.removeItem('pos_settings');
    applyToForm();
    showToast('Nastavenia obnovene na povodne', true);
  }, { type: 'warning', icon: '\u{1F504}', confirmText: 'Obnovit' });
}

/* ─── HOURS ─── */

function renderHours() {
  var tbody = byId('hoursBody');
  tbody.innerHTML = settings.hours.map(function (h, i) {
    return '<tr>' +
      '<td class="day-name">' + h.day + '</td>' +
      '<td><button class="toggle ' + (h.open ? 'on' : '') + '" data-day-idx="' + i + '"></button></td>' +
      '<td>' + (h.open
        ? '<input class="time-input" type="time" value="' + h.from + '" data-hour-idx="' + i + '" data-hour-field="from">'
        : '<span class="closed-label">Zatvorene</span>') + '</td>' +
      '<td>' + (h.open ? '<span class="time-separator">\u2014</span>' : '') + '</td>' +
      '<td>' + (h.open
        ? '<input class="time-input" type="time" value="' + h.to + '" data-hour-idx="' + i + '" data-hour-field="to">'
        : '') + '</td>' +
    '</tr>';
  }).join('');
}

/* ─── TIP ─── */

function toggleTip() {
  var toggle = byId('sTipToggle');
  toggle.classList.toggle('on');
  var isOn = toggle.classList.contains('on');
  settings.sTipEnabled = isOn;
  byId('sTipLabel').textContent = isOn ? 'Zapnute' : 'Vypnute';
  byId('tipOptions').style.opacity = isOn ? '1' : '.3';
  byId('tipOptions').style.pointerEvents = isOn ? 'all' : 'none';
}

/* ─── COLOR ─── */

function updateColorHex(inputId, hexId) {
  var val = byId(inputId).value;
  byId(hexId).textContent = val.toUpperCase();
}

/* ─── PRINTERS ─── */

async function loadPrinters() {
  var el = byId('printersTable');
  if (el) showLoading(el, 'Nacitavam tlaciarni...');
  try {
    adminPrinters = await api.get('/printers');
    if (el) hideLoading(el);
    renderPrinters();
  } catch (e) {
    if (el) hideLoading(el);
    showToast(e.message || 'Chyba nacitania tlaciarni', 'error');
    if (el) el.innerHTML = '<div class="error-hint">Chyba nacitania tlaciarni</div>';
  }
}

function renderPrinters() {
  var el = byId('printersTable');
  if (!adminPrinters.length) {
    el.innerHTML = '<div class="empty-hint">Ziadne tlaciarni. Kliknite "+ Pridat tlaciaren" pre vytvorenie.</div>';
    return;
  }
  var html = '<div class="table-scroll-wrap"><table class="data-table">';
  html += '<thead><tr>';
  var ths = ['Názov', 'IP', 'Port', 'Účel', 'Aktívna', 'Stav', 'Akcie'];
  var alignClasses = ['', '', '', '', 'text-center', 'text-center', 'text-right'];
  ths.forEach(function (t, idx) {
    html += '<th class="data-th ' + alignClasses[idx] + '">' + t + '</th>';
  });
  html += '</tr></thead><tbody>';

  adminPrinters.forEach(function (p) {
    var destLabel = DEST_LABELS[p.dest] || p.dest;
    var activeClass = p.active ? 'on' : '';
    var statusId = 'printerStatus_' + p.id;

    html += '<tr class="data-row">';
    html += '<td class="data-td td-name">' + p.name + '</td>';
    html += '<td class="data-td td-mono td-sec">' + p.ip + '</td>';
    html += '<td class="data-td td-sec">' + p.port + '</td>';
    html += '<td class="data-td td-accent">' + destLabel + '</td>';
    html += '<td class="data-td text-center"><button class="toggle ' + activeClass + '" data-printer-toggle="' + p.id + '" data-printer-active="' + p.active + '"></button></td>';
    html += '<td class="data-td text-center"><span id="' + statusId + '" class="status-dot"></span></td>';
    html += '<td class="data-td text-right nowrap">';
    html += '<button class="action-btn action-btn-accent" data-printer-test="' + p.id + '">Test</button>';
    html += '<button class="action-btn action-btn-dim" data-printer-edit="' + p.id + '">Upravit</button>';
    html += '<button class="action-btn action-btn-danger" data-printer-delete="' + p.id + '" data-printer-name="' + p.name.replace(/"/g, '&quot;') + '">Zmazat</button>';
    html += '</td></tr>';
  });
  html += '</tbody></table></div>';
  el.innerHTML = html;
}

function showAddPrinterForm() {
  editingPrinterId = null;
  byId('addPrinterForm').style.display = 'block';
  byId('newPrinterName').value = '';
  byId('newPrinterIp').value = '';
  byId('newPrinterPort').value = '9100';
  byId('newPrinterDest').value = 'all';
  byId('newPrinterName').focus();
}

function hideAddPrinterForm() {
  byId('addPrinterForm').style.display = 'none';
  editingPrinterId = null;
}

async function saveNewPrinter() {
  var name = byId('newPrinterName').value.trim();
  var ip = byId('newPrinterIp').value.trim();
  var port = parseInt(byId('newPrinterPort').value) || 9100;
  var dest = byId('newPrinterDest').value;

  if (!name) { showToast('Zadajte nazov tlaciarni'); return; }
  if (!ip) { showToast('Zadajte IP adresu'); return; }
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) { showToast('Neplatna IP adresa'); return; }
  if (port < 1 || port > 65535) { showToast('Port musi byt 1-65535'); return; }

  var btn = byId('btnSavePrinter');
  if (btn) btnLoading(btn);
  try {
    if (editingPrinterId) {
      await api.put('/printers/' + editingPrinterId, { name: name, ip: ip, port: port, dest: dest });
      showToast('Tlaciaren aktualizovana', true);
    } else {
      await api.post('/printers', { name: name, ip: ip, port: port, dest: dest });
      showToast('Tlaciaren pridana', true);
    }
    hideAddPrinterForm();
    await loadPrinters();
  } catch (e) {
    showToast(e.message || 'Chyba ukladania tlaciarni', 'error');
  } finally {
    if (btn) btnReset(btn);
  }
}

function editPrinter(id) {
  var p = adminPrinters.find(function (pr) { return pr.id === id; });
  if (!p) return;
  editingPrinterId = id;
  byId('addPrinterForm').style.display = 'block';
  byId('newPrinterName').value = p.name;
  byId('newPrinterIp').value = p.ip;
  byId('newPrinterPort').value = p.port;
  byId('newPrinterDest').value = p.dest;
  byId('newPrinterName').focus();
}

async function togglePrinterActive(id, currentActive) {
  try {
    await api.put('/printers/' + id, { active: !currentActive });
    await loadPrinters();
    showToast(currentActive ? 'Tlaciaren deaktivovana' : 'Tlaciaren aktivovana', true);
  } catch (e) {
    showToast('Chyba: ' + e.message);
  }
}

async function deletePrinter(id, name) {
  showConfirm('Zmazat tlaciaren', 'Naozaj chcete zmazat tlaciaren "' + name + '"?', async function () {
    try {
      await api.del('/printers/' + id);
      showToast('Tlaciaren zmazana', true);
      await loadPrinters();
    } catch (e) {
      showToast('Chyba: ' + e.message);
    }
  }, { type: 'danger', icon: '\u26A0\uFE0F', confirmText: 'Zmazat' });
}

async function testPrinter(id) {
  var statusEl = byId('printerStatus_' + id);
  var testBtn = _container.querySelector('[data-printer-test="' + id + '"]');
  if (statusEl) statusEl.style.background = 'var(--color-accent)';
  if (testBtn) btnLoading(testBtn);
  try {
    await api.post('/printers/' + id + '/test', {});
    if (statusEl) statusEl.style.background = 'var(--color-success)';
    showToast('Test uspesny', true);
  } catch (e) {
    if (statusEl) statusEl.style.background = 'var(--color-danger)';
    showToast('Test zlyhal: ' + e.message, 'error');
  } finally {
    if (testBtn) btnReset(testBtn);
  }
}

/* ─── DISCOUNTS ─── */

/* â”€â”€â”€ PORTOS â”€â”€â”€ */

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function firstDefined() {
  for (var i = 0; i < arguments.length; i++) {
    var value = arguments[i];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function formatPortosValue(value) {
  if (value === undefined || value === null || value === '') return '';
  if (Array.isArray(value)) return value.length ? value.map(formatPortosValue).join(', ') : '';
  if (typeof value === 'object') {
    var keys = ['name', 'state', 'status', 'model', 'serialNumber', 'serial', 'version', 'port', 'connected', 'path', 'message'];
    var parts = [];
    keys.forEach(function (key) {
      if (value[key] !== undefined && value[key] !== null && value[key] !== '') {
        parts.push(key + ': ' + formatPortosValue(value[key]));
      }
    });
    return parts.length ? parts.join(' | ') : JSON.stringify(value);
  }
  return String(value);
}

function formatPortosDate(value) {
  if (!value) return 'Neznamy';
  var date = new Date(value);
  if (isNaN(date.getTime())) return String(value);
  return date.toLocaleString('sk-SK');
}

function normalizePortosStatus(payload) {
  var raw = payload && typeof payload === 'object' ? payload : {};
  if (raw.data && typeof raw.data === 'object') raw = raw.data;
  if (raw.result && typeof raw.result === 'object') raw = raw.result;

  var connectivity = firstDefined(raw.connectivity, raw.connectivityStatus, raw.connection, raw.connectionStatus, raw.network, raw.state);
  var storage = firstDefined(raw.storage, raw.storageInfo, raw.storageStatus, raw.chdu, raw.device, raw.deviceInfo);
  var printer = firstDefined(raw.printer, raw.printerStatus, raw.printers, raw.printersStatus);
  var certificates = firstDefined(raw.certificates, raw.certificate, raw.certs, raw.certificateStatus);
  var firstCert = null;
  if (Array.isArray(certificates)) firstCert = certificates[0] || null;
  else if (certificates && typeof certificates === 'object') firstCert = certificates;

  return {
    raw: raw,
    connectivity: connectivity,
    storage: storage,
    printer: printer,
    certificates: certificates,
    cashRegisterCode: firstDefined(raw.cashRegisterCode, raw.cash_register_code, raw.registerCode, raw.register_code, raw.cashRegister, firstCert && firstCert.cashRegisterCode, firstCert && firstCert.cashRegister),
    certExpiry: firstDefined(raw.certExpiry, raw.certificateExpiry, raw.certificateExpiresAt, firstCert && firstCert.validTo, firstCert && firstCert.expiresAt, firstCert && firstCert.expiry, firstCert && firstCert.valid_until)
  };
}

function statusTone(value) {
  var text = String(value == null ? '' : value).toLowerCase();
  if (/up|ready|ok|online|valid|connected|success/.test(text)) return 'success';
  if (/warn|pending|offline|degrad|expir|soon/.test(text)) return 'warning';
  if (/down|error|fail|invalid|blocked|disabled|missing/.test(text)) return 'danger';
  return 'neutral';
}

function toneStyle(tone) {
  if (tone === 'success') return 'background:rgba(0,229,185,.1);color:#00E5B9;border:1px solid rgba(0,229,185,.25);';
  if (tone === 'warning') return 'background:rgba(232,184,74,.1);color:#E8B84A;border:1px solid rgba(232,184,74,.25);';
  if (tone === 'danger') return 'background:rgba(224,112,112,.1);color:var(--color-danger);border:1px solid rgba(224,112,112,.25);';
  return 'background:rgba(255,255,255,.06);color:var(--color-text-sec);border:1px solid rgba(255,255,255,.1);';
}

function renderPortosCard(title, value, details) {
  var tone = statusTone(value);
  var html = '<div class="portos-card">';
  html += '<div class="portos-card-title">' + escapeHtml(title) + '</div>';
  html += '<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start;">';
  html += '<span style="display:inline-flex;align-items:center;padding:6px 10px;border-radius:999px;font-size:12px;font-weight:700;' + toneStyle(tone) + '">' + escapeHtml(formatPortosValue(value) || 'Neznamy') + '</span>';
  html += '</div>';
  if (details) {
    html += '<div style="font-size:12px;line-height:1.5;color:var(--color-text-sec);white-space:pre-wrap;">' + escapeHtml(details) + '</div>';
  }
  html += '</div>';
  return html;
}

function renderPortosDiagnostics() {
  var el = byId('portosDiagnostics');
  if (!el) return;

  if (portosStatusLoading) {
    el.innerHTML = '<div class="loading-hint">Nacitavam Portos stav...</div>';
    return;
  }

  if (portosStatusError && !portosStatus) {
    el.innerHTML = '<div class="error-hint">' + escapeHtml(portosStatusError) + '</div>';
    return;
  }

  if (!portosStatus) {
    el.innerHTML = '<div class="empty-hint">Zatial nie su dostupne Portos data.</div>';
    return;
  }

  var status = normalizePortosStatus(portosStatus);
  var connectivityValue = formatPortosValue(status.connectivity) || formatPortosValue(status.raw.state) || formatPortosValue(status.raw.status);
  var printerValue = formatPortosValue(status.printer) || formatPortosValue(status.raw.printerState) || formatPortosValue(status.raw.printerStatus);
  var storageDetails = formatPortosValue(status.storage);
  var certExpiry = formatPortosDate(status.certExpiry);
  var certCount = Array.isArray(status.certificates) ? status.certificates.length : (status.certificates ? 1 : 0);

  var html = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;">';
  html += renderPortosCard('Connectivity', connectivityValue || 'Neznamy', formatPortosValue(status.raw.connectivityInfo || status.raw.connectivityMessage || ''));
  html += renderPortosCard('CHDU / storage', formatPortosValue(status.storage) || 'Neznamy', storageDetails && storageDetails !== formatPortosValue(status.storage) ? storageDetails : '');
  html += renderPortosCard('Printer state', printerValue || 'Neznamy', formatPortosValue(status.raw.printerMessage || status.raw.printerInfo || ''));
  html += renderPortosCard('Cash register', status.cashRegisterCode || 'Neznamy', certCount ? 'Certificates: ' + certCount : '');
  html += renderPortosCard('Cert expiry', certExpiry, 'Raw: ' + (status.certExpiry ? String(status.certExpiry) : 'Neznamy'));
  html += '</div>';

  if (portosStatusError) {
    html += '<div class="error-hint" style="margin-top:12px;">' + escapeHtml(portosStatusError) + '</div>';
  }

  el.innerHTML = html;
}

async function loadPortosStatus() {
  var btn = byId('btnRefreshPortos');
  portosStatusLoading = true;
  portosStatusError = '';
  if (btn) {
    btn.disabled = true;
    btn.dataset.originalText = btn.textContent;
    btn.textContent = 'Nacitavam...';
  }
  renderPortosDiagnostics();
  try {
    portosStatus = await api.getPortosStatus();
  } catch (e) {
    portosStatus = null;
    portosStatusError = e && e.message ? e.message : 'Chyba nacitania Portos stavu';
  } finally {
    portosStatusLoading = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = btn.dataset.originalText || 'Obnovit stav';
    }
    renderPortosDiagnostics();
  }
}

async function loadDiscounts() {
  var el = byId('discountsTable');
  if (el) showLoading(el, 'Nacitavam zlavy...');
  try {
    adminDiscounts = await api.get('/discounts/all');
    if (el) hideLoading(el);
    renderDiscounts();
  } catch (e) {
    if (el) hideLoading(el);
    showToast(e.message || 'Chyba nacitania zlav', 'error');
    if (el) el.innerHTML = '<div class="error-hint">Chyba nacitania zlav</div>';
  }
}

function renderDiscounts() {
  var el = byId('discountsTable');
  if (!adminDiscounts.length) {
    el.innerHTML = '<div class="empty-hint">Ziadne zlavy. Kliknite "+ Pridat zlavu" pre vytvorenie.</div>';
    return;
  }
  var html = '<div class="table-scroll-wrap"><table class="data-table">';
  html += '<thead><tr>';
  var ths = ['Názov', 'Typ', 'Hodnota', 'Stav', 'Akcie'];
  var alignClasses = ['', '', '', 'text-center', 'text-right'];
  ths.forEach(function (t, idx) {
    html += '<th class="data-th ' + alignClasses[idx] + '">' + t + '</th>';
  });
  html += '</tr></thead><tbody>';

  adminDiscounts.forEach(function (d) {
    var valLabel = d.type === 'percent' ? d.value + '%' : d.value.toFixed(2) + ' EUR';
    var typeLabel = d.type === 'percent' ? 'Percento' : 'Pevna suma';
    var activeClass = d.active ? 'on' : '';
    html += '<tr class="data-row">';
    html += '<td class="data-td td-name">' + d.name + '</td>';
    html += '<td class="data-td td-sec">' + typeLabel + '</td>';
    html += '<td class="data-td td-value">' + valLabel + '</td>';
    html += '<td class="data-td text-center"><button class="toggle ' + activeClass + '" data-disc-toggle="' + d.id + '" data-disc-active="' + d.active + '"></button></td>';
    html += '<td class="data-td text-right"><button class="action-btn action-btn-danger" data-disc-delete="' + d.id + '" data-disc-name="' + d.name.replace(/"/g, '&quot;') + '">Zmazat</button></td>';
    html += '</tr>';
  });
  html += '</tbody></table></div>';
  el.innerHTML = html;
}

function showAddDiscountForm() {
  byId('addDiscountForm').style.display = 'block';
  byId('newDiscName').value = '';
  byId('newDiscType').value = 'percent';
  byId('newDiscValue').value = '';
  byId('newDiscName').focus();
}

function hideAddDiscountForm() {
  byId('addDiscountForm').style.display = 'none';
}

async function saveNewDiscount() {
  var name = byId('newDiscName').value.trim();
  var type = byId('newDiscType').value;
  var value = parseFloat(byId('newDiscValue').value);
  if (!name) { showToast('Zadajte nazov zlavy'); return; }
  if (!value || value <= 0) { showToast('Zadajte platnu hodnotu'); return; }
  if (type === 'percent' && value > 100) { showToast('Percento nemoze byt viac ako 100'); return; }
  var btn = byId('btnSaveDiscount');
  if (btn) btnLoading(btn);
  try {
    await api.post('/discounts', { name: name, type: type, value: value });
    hideAddDiscountForm();
    showToast('Zlava pridana', true);
    await loadDiscounts();
  } catch (e) {
    showToast(e.message || 'Chyba pridania zlavy', 'error');
  } finally {
    if (btn) btnReset(btn);
  }
}

async function toggleDiscountActive(id, currentActive) {
  try {
    await api.put('/discounts/' + id, { active: !currentActive });
    await loadDiscounts();
    showToast(currentActive ? 'Zlava deaktivovana' : 'Zlava aktivovana', true);
  } catch (e) {
    showToast('Chyba: ' + e.message);
  }
}

async function deleteDiscount(id, name) {
  showConfirm('Zmazat zlavu', 'Naozaj chcete zmazat zlavu "' + name + '"?', async function () {
    try {
      await api.del('/discounts/' + id);
      showToast('Zlava zmazana', true);
      await loadDiscounts();
    } catch (e) {
      showToast('Chyba: ' + e.message);
    }
  }, { type: 'danger', icon: '\u26A0\uFE0F', confirmText: 'Zmazat' });
}

/* ─── EVENT DELEGATION ─── */

function onContainerClick(e) {
  var target = e.target;

  // Tip toggle
  if (target.id === 'sTipToggle' || target.closest('#sTipToggle')) {
    toggleTip();
    return;
  }

  // Tip option
  if (target.classList.contains('tip-opt')) {
    qsAll('.tip-opt').forEach(function (b) { b.classList.remove('active'); });
    target.classList.add('active');
    settings.sTipDefault = parseInt(target.dataset.val);
    return;
  }

  // Simple toggle (autoPrint, showVat)
  if (target.id === 'sAutoPrint' || target.id === 'sShowVat') {
    target.classList.toggle('on');
    return;
  }

  // Day toggles in hours table
  if (target.dataset.dayIdx !== undefined) {
    var idx = parseInt(target.dataset.dayIdx);
    settings.hours[idx].open = !settings.hours[idx].open;
    renderHours();
    return;
  }

  // Save / Reset buttons
  if (target.id === 'saveBtn' || target.closest('#saveBtn')) {
    saveSettingsAction();
    return;
  }
  if (target.id === 'resetBtn' || target.closest('#resetBtn')) {
    resetDefaults();
    return;
  }

  // Printer buttons
  if (target.id === 'btnAddPrinter' || target.closest('#btnAddPrinter')) {
    showAddPrinterForm();
    return;
  }
  if (target.id === 'btnSavePrinter' || target.closest('#btnSavePrinter')) {
    saveNewPrinter();
    return;
  }
  if (target.id === 'btnCancelPrinter' || target.closest('#btnCancelPrinter')) {
    hideAddPrinterForm();
    return;
  }

  // Printer table actions (delegated)
  var printerToggle = target.closest('[data-printer-toggle]');
  if (printerToggle) {
    togglePrinterActive(parseInt(printerToggle.dataset.printerToggle), printerToggle.dataset.printerActive === 'true');
    return;
  }
  var printerTest = target.closest('[data-printer-test]');
  if (printerTest) {
    testPrinter(parseInt(printerTest.dataset.printerTest));
    return;
  }
  var printerEdit = target.closest('[data-printer-edit]');
  if (printerEdit) {
    editPrinter(parseInt(printerEdit.dataset.printerEdit));
    return;
  }
  var printerDel = target.closest('[data-printer-delete]');
  if (printerDel) {
    deletePrinter(parseInt(printerDel.dataset.printerDelete), printerDel.dataset.printerName);
    return;
  }

  if (target.id === 'btnRefreshPortos' || target.closest('#btnRefreshPortos')) {
    loadPortosStatus();
    return;
  }

  // Discount buttons
  if (target.id === 'btnAddDiscount' || target.closest('#btnAddDiscount')) {
    showAddDiscountForm();
    return;
  }
  if (target.id === 'btnSaveDiscount' || target.closest('#btnSaveDiscount')) {
    saveNewDiscount();
    return;
  }
  if (target.id === 'btnCancelDiscount' || target.closest('#btnCancelDiscount')) {
    hideAddDiscountForm();
    return;
  }

  // Discount table actions (delegated)
  var discToggle = target.closest('[data-disc-toggle]');
  if (discToggle) {
    toggleDiscountActive(parseInt(discToggle.dataset.discToggle), discToggle.dataset.discActive === 'true');
    return;
  }
  var discDel = target.closest('[data-disc-delete]');
  if (discDel) {
    deleteDiscount(parseInt(discDel.dataset.discDelete), discDel.dataset.discName);
    return;
  }
}

function onContainerChange(e) {
  var target = e.target;

  // Hour time inputs
  if (target.dataset.hourIdx !== undefined) {
    var idx = parseInt(target.dataset.hourIdx);
    var field = target.dataset.hourField;
    settings.hours[idx][field] = target.value;
    return;
  }

  // Color pickers
  if (target.id === 'sPrimaryColor') {
    updateColorHex('sPrimaryColor', 'primaryHex');
    return;
  }
  if (target.id === 'sSecondaryColor') {
    updateColorHex('sSecondaryColor', 'secondaryHex');
    return;
  }
}

/* ─── EXPORTS ─── */

export function init(container) {
  _container = container;
  container.innerHTML = getTemplate();

  container.addEventListener('click', onContainerClick);
  container.addEventListener('change', onContainerChange);

  // Inline validation listeners
  container.querySelectorAll('[data-validate]').forEach(function(input) {
    input.addEventListener('blur', function() {
      var rules = this.getAttribute('data-validate').split('|');
      var self = this;
      rules.forEach(function(rule) { validateField(self, rule); });
    });
    input.addEventListener('input', function() { clearFieldError(this); });
  });

  loadSettings();
  loadPrinters();
  loadPortosStatus();
  loadDiscounts();
}

export function destroy() {
  if (_container) {
    _container.removeEventListener('click', onContainerClick);
    _container.removeEventListener('change', onContainerChange);
  }
  _container = null;
  settings = {};
  adminPrinters = [];
  adminDiscounts = [];
  editingPrinterId = null;
}
