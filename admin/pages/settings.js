/* Settings page module */
import { fmtCost } from '../../components/fmt.js';

let _container = null;

const DEFAULTS = {
  sName: 'Kaviaren & Bar',
  sAddress: 'Hlavna 15, 811 01 Bratislava',
  sPhone: '+421 2 1234 5678',
  sEmail: 'info@kaviarenbar.sk',
  sIco: '12345678',
  sDic: 'SK2012345678',
  sIcDph: '',
  sBranchName: 'Hlavná prevádzka',
  sBranchAddress: 'Hlavna 15, 811 01 Bratislava',
  sCashRegisterCode: '88812345678900001',
  // sVat / sShowVat su prec: boli mrtve (nikto ich necital) a default 20 %
  // je sadzba, ktora v SR od 2025 neexistuje. Realne sadzby su per polozka
  // v menu_items.vat_rate (Admin -> Menu), rezim platitela urcuje IC DPH.
  sCurrency: 'EUR',
  sRounding: 'centy',
  sTipEnabled: true,
  sTipDefault: 10,
  sQrPaymentEnabled: true,
  sReceiptName: 'Kaviaren & Bar',
  sReceiptFooter: 'Ďakujeme za návštevu!',
  sReceiptFormat: '80mm',
  sAutoPrint: true,
  sPrimaryColor: '#b8542a',
  sSecondaryColor: '#1f3a5c',
  hours: [
    { day: 'Pondelok', open: true, from: '08:00', to: '22:00' },
    { day: 'Utorok',   open: true, from: '08:00', to: '22:00' },
    { day: 'Streda',   open: true, from: '08:00', to: '22:00' },
    { day: 'Štvrtok',  open: true, from: '08:00', to: '22:00' },
    { day: 'Piatok',   open: true, from: '08:00', to: '22:00' },
    { day: 'Sobota',   open: true, from: '09:00', to: '23:00' },
    { day: 'Nedeľa',   open: true, from: '10:00', to: '20:00' }
  ]
};

const DEST_LABELS = {
  all: 'Všetko',
  kuchyna: 'Kuchyňa',
  bar: 'Bar',
  uctenka: 'Účtenka'
};

let settings = {};
let adminPrinters = [];
let adminDiscounts = [];
let editingPrinterId = null;
let portosStatus = null;
let portosStatusError = '';
let portosStatusLoading = false;
let companyProfile = null;
let companyCompare = null;
let companyCompareError = '';

function qs(sel) { return _container.querySelector(sel); }
function byId(id) { return _container.querySelector('#' + id); }
function qsAll(sel) { return _container.querySelectorAll(sel); }

/* ─── TEMPLATE ─── */
function getTemplate() {
  return `
    <div class="set-page">

      <h2 class="set-head">Firma</h2>
      <p class="set-lead">Názov, IČO, DIČ, IČ DPH, prevádzka a kód pokladnice sa preberajú z Portos/eKasa a sú iba na čítanie — menia sa výhradne v Portose. Telefón a e-mail sa ukladajú tu, pre hlavičku účtenky.</p>
      <div class="set-group">
        <label class="set-row is-ro"><span class="set-k">Názov firmy</span><input class="set-v" id="sName" type="text" readonly tabindex="-1" aria-readonly="true"></label>
        <label class="set-row is-ro is-stack"><span class="set-k">Sídlo firmy</span><input class="set-v" id="sAddress" type="text" readonly tabindex="-1" aria-readonly="true"></label>
        <label class="set-row is-ro"><span class="set-k">IČO</span><input class="set-v set-mono" id="sIco" type="text" readonly tabindex="-1" aria-readonly="true" placeholder="—"></label>
        <label class="set-row is-ro"><span class="set-k">DIČ</span><input class="set-v set-mono" id="sDic" type="text" readonly tabindex="-1" aria-readonly="true" placeholder="—"></label>
        <label class="set-row is-ro"><span class="set-k">IČ DPH</span><input class="set-v set-mono" id="sIcDph" type="text" readonly tabindex="-1" aria-readonly="true" placeholder="—"></label>
        <label class="set-row is-ro"><span class="set-k">Prevádzka</span><input class="set-v" id="sBranchName" type="text" readonly tabindex="-1" aria-readonly="true" placeholder="Portos nevrátil názov"></label>
        <label class="set-row is-ro is-stack"><span class="set-k">Adresa prevádzky</span><input class="set-v" id="sBranchAddress" type="text" readonly tabindex="-1" aria-readonly="true"></label>
        <label class="set-row is-ro"><span class="set-k">Kód pokladnice</span><input class="set-v set-mono" id="sCashRegisterCode" type="text" readonly tabindex="-1" aria-readonly="true" placeholder="—"></label>
        <label class="set-row"><span class="set-k">Telefón</span><input class="set-v" id="sPhone" type="text" inputmode="tel" autocomplete="off" placeholder="+421 900 123 456"></label>
        <label class="set-row"><span class="set-k">E-mail</span><input class="set-v" id="sEmail" type="text" inputmode="email" autocomplete="off" data-validate="email" placeholder="info@…"></label>
      </div>

      <h2 class="set-head">DPH</h2>
      <div class="set-group" id="vatStatusBox">
        <div class="set-row"><span class="set-k">Režim DPH</span><span class="set-r"><span class="set-val">Načítavam…</span></span></div>
      </div>

      <h2 class="set-head">Predaj</h2>
      <div class="set-group">
        <label class="set-row"><span class="set-k">Mena</span><select class="set-v set-sel" id="sCurrency">
          <option value="EUR">EUR</option>
          <option value="CZK">CZK</option>
          <option value="USD">USD</option>
        </select></label>
        <label class="set-row"><span class="set-k">Zaokrúhľovanie</span><select class="set-v set-sel" id="sRounding">
          <option value="centy">Na centy</option>
          <option value="5centov">Na 5 centov</option>
          <option value="10centov">Na 10 centov</option>
        </select></label>
        <div class="set-row"><span class="set-k">Sprepitné</span><span class="set-r"><span class="set-sr" id="sTipLabel">Zapnuté</span><button type="button" class="set-sw on" id="sTipToggle" role="switch" aria-checked="true" aria-label="Sprepitné"></button></span></div>
        <div class="set-row is-seg" id="tipOptions"><span class="set-k">Predvolené sprepitné</span><span class="set-seg" role="group" aria-label="Predvolené sprepitné">
          <button type="button" class="tip-opt" data-val="5">5 %</button>
          <button type="button" class="tip-opt active" data-val="10">10 %</button>
          <button type="button" class="tip-opt" data-val="15">15 %</button>
        </span></div>
        <div class="set-row"><span class="set-k">QR platba (Portos PayMe)</span><span class="set-r"><span class="set-sr" id="sQrPaymentLabel">Zapnuté</span><button type="button" class="set-sw on" id="sQrPaymentEnabled" role="switch" aria-checked="true" aria-label="QR platba"></button></span></div>
        <p class="set-note">Po vypnutí QR platby zmizne tlačidlo „QR platba“ z pokladne po ďalšom prihlásení. Nastavenie je uložené v prehliadači — na každej kase zvlášť.</p>
      </div>

      <h2 class="set-head">Otváracie hodiny</h2>
      <div class="set-group" id="hoursBody"></div>

      <h2 class="set-head">Účtenka a tlač</h2>
      <div class="set-group">
        <label class="set-row"><span class="set-k">Názov na účtenke</span><input class="set-v" id="sReceiptName" type="text" autocomplete="off"></label>
        <label class="set-row"><span class="set-k">Formát</span><select class="set-v set-sel" id="sReceiptFormat">
          <option value="80mm">80 mm termálna</option>
          <option value="A4">A4</option>
          <option value="none">Bez tlače</option>
        </select></label>
        <label class="set-row is-stack"><span class="set-k">Päta účtenky</span><textarea class="set-v set-ta" id="sReceiptFooter" rows="2"></textarea></label>
        <div class="set-row"><span class="set-k">Tlačiť automaticky</span><span class="set-r"><button type="button" class="set-sw on" id="sAutoPrint" role="switch" aria-checked="true" aria-label="Tlačiť automaticky"></button></span></div>
        <p class="set-note">Názov a päta sa na fiškálny doklad zatiaľ netlačia — hlavičku aj pätu berie eKasa z profilu firmy v Portose.</p>
      </div>

      <h2 class="set-head">Tlačiarne</h2>
      <div class="set-group">
        <div id="printersTable"></div>
        <button type="button" class="set-add" id="btnAddPrinter">Pridať tlačiareň</button>
      </div>
      <div id="addPrinterForm" class="set-sheet" style="display:none" role="dialog" aria-modal="true" aria-labelledby="printerSheetTitle">
        <div class="set-sheet-card">
          <h3 class="set-sheet-title" id="printerSheetTitle">Nová tlačiareň</h3>
          <div class="set-field">
            <label for="newPrinterName">Názov</label>
            <input class="form-input" id="newPrinterName" type="text" autocomplete="off" placeholder="napr. Kuchynská tlačiareň">
          </div>
          <div class="set-field-row">
            <div class="set-field">
              <label for="newPrinterIp">IP adresa</label>
              <input class="form-input" id="newPrinterIp" type="text" inputmode="decimal" autocomplete="off" placeholder="192.168.0.107">
            </div>
            <div class="set-field set-field-sm">
              <label for="newPrinterPort">Port</label>
              <input class="form-input" id="newPrinterPort" type="number" inputmode="numeric" value="9100" min="1" max="65535">
            </div>
          </div>
          <div class="set-field">
            <label for="newPrinterDest">Čo sa na nej tlačí</label>
            <select class="form-select" id="newPrinterDest">
              <option value="all">Všetko</option>
              <option value="kuchyna">Kuchyňa</option>
              <option value="bar">Bar</option>
              <option value="uctenka">Účtenka</option>
            </select>
          </div>
          <div class="set-sheet-aux" id="printerSheetActions" hidden>
            <button type="button" class="btn-secondary" id="btnTestPrinter" data-printer-test="">Skúšobná tlač</button>
            <button type="button" class="btn-secondary is-danger" id="btnDeletePrinter" data-printer-delete="" data-printer-name="">Zmazať tlačiareň</button>
          </div>
          <div class="set-sheet-btns">
            <button type="button" class="btn-secondary" id="btnCancelPrinter">Zrušiť</button>
            <button type="button" class="btn-save" id="btnSavePrinter">Uložiť tlačiareň</button>
          </div>
        </div>
      </div>

      <h2 class="set-head">Zľavy</h2>
      <div class="set-group">
        <div id="discountsTable"></div>
        <button type="button" class="set-add" id="btnAddDiscount">Pridať zľavu</button>
      </div>
      <div id="addDiscountForm" class="set-sheet" style="display:none" role="dialog" aria-modal="true" aria-labelledby="discountSheetTitle">
        <div class="set-sheet-card">
          <h3 class="set-sheet-title" id="discountSheetTitle">Nová zľava</h3>
          <div class="set-field">
            <label for="newDiscName">Názov</label>
            <input class="form-input" id="newDiscName" type="text" autocomplete="off" placeholder="napr. Happy hour −20 %">
          </div>
          <div class="set-field-row">
            <div class="set-field">
              <label for="newDiscType">Typ</label>
              <select class="form-select" id="newDiscType">
                <option value="percent">Percento (%)</option>
                <option value="fixed">Pevná suma (€)</option>
              </select>
            </div>
            <div class="set-field set-field-sm">
              <label for="newDiscValue">Hodnota</label>
              <input class="form-input" id="newDiscValue" type="number" min="0" step="0.01" inputmode="decimal" placeholder="10">
            </div>
          </div>
          <div class="set-sheet-btns">
            <button type="button" class="btn-secondary" id="btnCancelDiscount">Zrušiť</button>
            <button type="button" class="btn-save" id="btnSaveDiscount">Uložiť zľavu</button>
          </div>
        </div>
      </div>
      <div id="discountDetail" class="set-sheet" style="display:none" role="dialog" aria-modal="true" aria-labelledby="discountDetailTitle">
        <div class="set-sheet-card">
          <h3 class="set-sheet-title" id="discountDetailTitle">Zľava</h3>
          <p class="set-sheet-text" id="discountDetailText"></p>
          <div class="set-sheet-btns">
            <button type="button" class="btn-secondary" id="btnCloseDiscountDetail">Zavrieť</button>
            <button type="button" class="btn-secondary is-danger" id="btnDeleteDiscount" data-disc-delete="" data-disc-name="">Zmazať zľavu</button>
          </div>
        </div>
      </div>

      <h2 class="set-head">Vzhľad</h2>
      <div class="set-group">
        <label class="set-row" for="sPrimaryColor"><span class="set-k">Primárna farba</span><span class="set-r color-input-wrap"><span class="color-hex" id="primaryHex">#b8542a</span><span class="color-swatch"><input type="color" id="sPrimaryColor" aria-label="Primárna farba"></span></span></label>
        <label class="set-row" for="sSecondaryColor"><span class="set-k">Sekundárna farba</span><span class="set-r color-input-wrap"><span class="color-hex" id="secondaryHex">#1f3a5c</span><span class="color-swatch"><input type="color" id="sSecondaryColor" aria-label="Sekundárna farba"></span></span></label>
      </div>

      <h2 class="set-head">Portos eKasa</h2>
      <div class="set-group" id="portosDiagnostics"></div>
      <div id="companyProfileCompare"></div>
      <div class="set-actions">
        <button type="button" class="btn-secondary" id="btnRefreshPortos">Obnoviť stav</button>
        <button type="button" class="btn-secondary" id="btnSyncProfileFromPortos">Prevziať údaje z Portos</button>
      </div>

      <div id="fiscalStornoPanel">
        <h2 class="set-head">Fiškálne storno</h2>
        <p class="set-lead">Ak bol doklad vytlačený omylom, do eKasy sa odošle opravný doklad a vytlačí sa podľa nastavenia Portosu. ID platby je v Histórii platieb (rovnaké ako pri kópii dokladu). Iba manažér alebo admin.</p>
        <div class="set-group">
          <label class="set-row"><span class="set-k">ID platby</span><input class="set-v" id="fiscalStornoPaymentId" type="number" min="1" step="1" inputmode="numeric" placeholder="napr. 42"></label>
        </div>
        <div class="set-actions">
          <button type="button" class="btn-secondary is-danger" id="btnFiscalStorno">Odoslať storno do eKasy</button>
        </div>
      </div>

      <div id="profileLoadWarning" class="error-hint set-warn" style="display:none"></div>
      <div class="settings-footer set-footer">
        <button type="button" class="btn-reset" id="resetBtn">Obnoviť pôvodné</button>
        <button type="button" class="btn-save" id="saveBtn">Uložiť zmeny</button>
      </div>
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

function syncCompanyProfileToLocalSettings(profile) {
  if (!profile) return;
  settings.sName = profile.businessName || settings.sName;
  settings.sAddress = profile.registeredAddress || settings.sAddress;
  settings.sPhone = profile.contactPhone || settings.sPhone;
  settings.sEmail = profile.contactEmail || settings.sEmail;
  settings.sIco = profile.ico || settings.sIco;
  settings.sDic = profile.dic || settings.sDic;
  settings.sIcDph = profile.icDph || settings.sIcDph;
  settings.sBranchName = profile.branchName || settings.sBranchName;
  settings.sBranchAddress = profile.branchAddress || settings.sBranchAddress;
  settings.sCashRegisterCode = profile.cashRegisterCode || settings.sCashRegisterCode;
}

function applyToForm() {
  var profile = companyProfile || {
    businessName: settings.sName,
    registeredAddress: settings.sAddress,
    contactPhone: settings.sPhone,
    contactEmail: settings.sEmail,
    ico: settings.sIco,
    dic: settings.sDic,
    icDph: settings.sIcDph || '',
    branchName: settings.sBranchName || '',
    branchAddress: settings.sBranchAddress || '',
    cashRegisterCode: settings.sCashRegisterCode || '',
  };

  byId('sName').value = profile.businessName || '';
  byId('sAddress').value = profile.registeredAddress || '';
  byId('sPhone').value = profile.contactPhone || '';
  byId('sEmail').value = profile.contactEmail || '';
  byId('sIco').value = profile.ico || '';
  byId('sDic').value = profile.dic || '';
  byId('sIcDph').value = profile.icDph || '';
  byId('sBranchName').value = profile.branchName || '';
  byId('sBranchAddress').value = profile.branchAddress || '';
  byId('sCashRegisterCode').value = profile.cashRegisterCode || '';
  renderVatStatus();
  byId('sCurrency').value = settings.sCurrency;
  byId('sRounding').value = settings.sRounding;

  var tipToggle = byId('sTipToggle');
  tipToggle.classList.toggle('on', settings.sTipEnabled);
  syncSwitch(tipToggle);
  byId('sTipLabel').textContent = settings.sTipEnabled ? 'Zapnuté' : 'Vypnuté';
  byId('tipOptions').style.opacity = settings.sTipEnabled ? '1' : '.3';
  byId('tipOptions').style.pointerEvents = settings.sTipEnabled ? 'all' : 'none';
  qsAll('.tip-opt').forEach(function (btn) {
    btn.classList.toggle('active', parseInt(btn.dataset.val) === settings.sTipDefault);
  });

  byId('sQrPaymentEnabled').classList.toggle('on', settings.sQrPaymentEnabled);
  syncSwitch(byId('sQrPaymentEnabled'));
  byId('sQrPaymentLabel').textContent = settings.sQrPaymentEnabled ? 'Zapnuté' : 'Vypnuté';

  byId('sReceiptName').value = settings.sReceiptName;
  byId('sReceiptFooter').value = settings.sReceiptFooter;
  byId('sReceiptFormat').value = settings.sReceiptFormat;
  byId('sAutoPrint').classList.toggle('on', settings.sAutoPrint);
  syncSwitch(byId('sAutoPrint'));

  byId('sPrimaryColor').value = settings.sPrimaryColor;
  byId('sSecondaryColor').value = settings.sSecondaryColor;
  byId('primaryHex').textContent = settings.sPrimaryColor;
  byId('secondaryHex').textContent = settings.sSecondaryColor;

  renderHours();
  renderSaveGuard();
}

// Read-only stav DPH — jediny zdroj pravdy je company_profiles.ic_dph
// (to iste cita isVatRegisteredBusiness() na serveri). Sadzby sa NEnastavuju
// tu, ale per polozka v Admin -> Menu.
function renderVatStatus() {
  var el = byId('vatStatusBox');
  if (!el) return;

  if (!companyProfile) {
    el.innerHTML = '<div class="set-row"><span class="set-k">Režim DPH</span>'
      + '<span class="set-r"><span class="set-pill is-danger">nenačítal sa</span></span></div>'
      + '<p class="set-note">Firemný profil sa nepodarilo načítať zo servera — použite „Prevziať údaje z Portos“.</p>';
    return;
  }

  var icDph = String(companyProfile.icDph || '').trim();
  var isPayer = icDph.length > 0;
  el.innerHTML = '<div class="set-row"><span class="set-k">Platiteľ DPH</span>'
      + '<span class="set-r"><span class="set-pill ' + (isPayer ? 'is-success' : 'is-neutral') + '">' + (isPayer ? 'áno' : 'nie') + '</span></span></div>'
    + (isPayer ? '<div class="set-row"><span class="set-k">IČ DPH</span><span class="set-r"><span class="set-val set-mono">' + escapeHtml(icDph) + '</span></span></div>' : '')
    + '<p class="set-note">Sadzby DPH sa nastavujú pri každej položke v <a href="#menu" class="settings-inline-link">Menu</a> (5 / 19 / 23 %). '
    + (isPayer
      ? 'Doklady sa fiškalizujú so sadzbou konkrétnej položky.'
      : 'Kým firma nie je platiteľ, každý doklad ide s 0 % DPH.')
    + '</p>';
}

// Identifikacne polia (ICO, DIC, IC DPH, kod pokladnice, nazov/adresa) su
// vlastnictvo Portosu — do PUT /company-profile posielame IBA kontakty.
// Readonly inputy sa plnia z fallbacku (localStorage/DEFAULTS), takze pri
// zlyhanom GET by inak prepisali ic_dph na '' a POS by ticho prepol na
// rezim neplatitela (0 % DPH na kazdom doklade).
function gatherCompanyProfile() {
  return {
    contactPhone: byId('sPhone').value.trim(),
    contactEmail: byId('sEmail').value.trim(),
  };
}

// Bez nacitanej identity sa uklada zo slepej fallback hodnoty — radsej
// zablokujeme tlacidlo, nez by sme poslali stale data na server.
function renderSaveGuard() {
  var btn = byId('saveBtn');
  var warn = byId('profileLoadWarning');
  var blocked = !companyProfile;
  if (btn) {
    btn.disabled = blocked;
    btn.style.opacity = blocked ? '.45' : '';
    btn.style.cursor = blocked ? 'not-allowed' : '';
    btn.setAttribute('aria-disabled', blocked ? 'true' : 'false');
  }
  if (warn) {
    warn.style.display = blocked ? '' : 'none';
    warn.textContent = blocked
      ? 'Firemné údaje sa nenačítali — ukladanie je zablokované, aby sa neprepísala identita firmy. Skúste „Prevziať údaje z Portos“.'
      : '';
  }
}

function gatherSettings() {
  settings.sName = byId('sName').value;
  settings.sAddress = byId('sAddress').value;
  settings.sPhone = byId('sPhone').value;
  settings.sEmail = byId('sEmail').value;
  settings.sIco = byId('sIco').value;
  settings.sDic = byId('sDic').value;
  settings.sIcDph = byId('sIcDph').value;
  settings.sBranchName = byId('sBranchName').value;
  settings.sBranchAddress = byId('sBranchAddress').value;
  settings.sCashRegisterCode = byId('sCashRegisterCode').value;
  settings.sQrPaymentEnabled = byId('sQrPaymentEnabled').classList.contains('on');
  settings.sCurrency = byId('sCurrency').value;
  settings.sRounding = byId('sRounding').value;
  settings.sReceiptName = byId('sReceiptName').value;
  settings.sReceiptFooter = byId('sReceiptFooter').value;
  settings.sReceiptFormat = byId('sReceiptFormat').value;
  settings.sAutoPrint = byId('sAutoPrint').classList.contains('on');
  settings.sPrimaryColor = byId('sPrimaryColor').value;
  settings.sSecondaryColor = byId('sSecondaryColor').value;
}

async function saveSettingsAction() {
  if (!companyProfile) {
    showToast('Firemné údaje sa nenačítali — uloženie by prepísalo identitu firmy', 'error');
    renderSaveGuard();
    return;
  }
  if (!validateForm(_container)) return;
  var btn = byId('saveBtn');
  if (btn) btnLoading(btn);
  try {
    companyProfile = await api.updateCompanyProfile(gatherCompanyProfile());
    syncCompanyProfileToLocalSettings(companyProfile);
    gatherSettings();
    localStorage.setItem('pos_settings', JSON.stringify(settings));
    await loadCompanyProfileCompare();
    showToast('Nastavenia uložené', true);
  } catch (e) {
    showToast(e.message || 'Chyba pri ukladaní nastavení', 'error');
  } finally {
    if (btn) btnReset(btn);
  }
}

function resetDefaults() {
  showConfirm('Obnoviť pôvodné nastavenia?', 'Všetky nastavenia sa vrátia na pôvodné hodnoty. Firemné údaje z Portosu to nemení.', function () {
    settings = JSON.parse(JSON.stringify(DEFAULTS));
    localStorage.removeItem('pos_settings');
    applyToForm();
    renderCompanyProfileCompare();
    showToast('Nastavenia obnovené na pôvodné', true);
  }, { type: 'warning', confirmText: 'Obnoviť pôvodné' });
}

/* ─── HOURS ─── */

// Ulozene nastavenia mozu niest nazvy dni este bez diakritiky (DEFAULTS
// pred opravou) — zobrazenie ich opravi, data sa nemenia.
var DAY_LABEL = { Stvrtok: 'Štvrtok', Nedela: 'Nedeľa' };

function renderHours() {
  var host = byId('hoursBody');
  host.innerHTML = settings.hours.map(function (h, i) {
    var day = DAY_LABEL[h.day] || h.day;
    return '<div class="set-row set-hours' + (h.open ? '' : ' is-closed') + '">' +
      '<span class="set-k">' + escapeHtml(day) + '</span>' +
      '<span class="set-r">' +
        (h.open
          ? '<input class="time-input set-time" type="time" value="' + h.from + '" data-hour-idx="' + i + '" data-hour-field="from" aria-label="' + escapeHtml(day) + ' — otvorené od">' +
            '<span class="set-dash" aria-hidden="true">–</span>' +
            '<input class="time-input set-time" type="time" value="' + h.to + '" data-hour-idx="' + i + '" data-hour-field="to" aria-label="' + escapeHtml(day) + ' — otvorené do">'
          : '<span class="set-closed">Zatvorené</span>') +
        '<button type="button" class="set-sw' + (h.open ? ' on' : '') + '" data-day-idx="' + i + '" role="switch" aria-checked="' + (h.open ? 'true' : 'false') + '" aria-label="' + escapeHtml(day) + ' — otvorené"></button>' +
      '</span>' +
    '</div>';
  }).join('');
}

/* ─── TIP ─── */

function syncSwitch(btn) {
  if (btn && btn.getAttribute('role') === 'switch') {
    btn.setAttribute('aria-checked', btn.classList.contains('on') ? 'true' : 'false');
  }
}

function toggleTip() {
  var toggle = byId('sTipToggle');
  toggle.classList.toggle('on');
  syncSwitch(toggle);
  var isOn = toggle.classList.contains('on');
  settings.sTipEnabled = isOn;
  byId('sTipLabel').textContent = isOn ? 'Zapnuté' : 'Vypnuté';
  byId('tipOptions').style.opacity = isOn ? '1' : '.3';
  byId('tipOptions').style.pointerEvents = isOn ? 'all' : 'none';
}

/* ─── QR PLATBA ─── */

function toggleQrPayment() {
  var toggle = byId('sQrPaymentEnabled');
  toggle.classList.toggle('on');
  syncSwitch(toggle);
  var isOn = toggle.classList.contains('on');
  settings.sQrPaymentEnabled = isOn;
  byId('sQrPaymentLabel').textContent = isOn ? 'Zapnuté' : 'Vypnuté';
}

/* ─── COLOR ─── */

function updateColorHex(inputId, hexId) {
  var val = byId(inputId).value;
  byId(hexId).textContent = val.toUpperCase();
}

/* ─── PRINTERS ─── */

async function loadPrinters() {
  var el = byId('printersTable');
  if (el) showLoading(el, 'Načítavam tlačiarne…');
  try {
    adminPrinters = await api.get('/printers');
    if (el) hideLoading(el);
    renderPrinters();
  } catch (e) {
    if (el) hideLoading(el);
    showToast(e.message || 'Chyba načítania tlačiarní', 'error');
    if (el) el.innerHTML = '<p class="set-note is-danger">Tlačiarne sa nepodarilo načítať. Skúste stránku obnoviť.</p>';
  }
}

// Chevron na konci riadka: hovori, ze klepnutie na text otvori panel s upravou.
var CHEVRON = '<svg class="set-chev" aria-hidden="true" viewBox="0 0 16 16"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function renderPrinters() {
  var el = byId('printersTable');
  if (!adminPrinters.length) {
    el.innerHTML = '<p class="set-empty">Zatiaľ žiadna tlačiareň. Bez nej sa bončeky do kuchyne ani na bar netlačia — pridajte prvú.</p>';
    return;
  }
  // XSS: nazov/IP/ucel su volny text z DB (POST /printers) — vzdy escapovat.
  el.innerHTML = adminPrinters.map(function (p) {
    var destLabel = DEST_LABELS[p.dest] || p.dest;
    return '<div class="set-row set-item' + (p.active ? '' : ' is-off') + '">' +
      '<button type="button" class="set-main" data-printer-edit="' + p.id + '">' +
        '<span class="set-main-txt">' +
          '<span class="set-title">' + escapeHtml(p.name) + (p.active ? '' : ' <span class="set-off">vypnutá</span>') + '</span>' +
          '<span class="set-sub"><span class="set-mono">' + escapeHtml(p.ip) + ':' + escapeHtml(p.port) + '</span> · ' + escapeHtml(destLabel) + '</span>' +
        '</span>' +
        CHEVRON +
      '</button>' +
      '<span class="set-r">' +
        '<span id="printerStatus_' + p.id + '" class="status-dot set-dot" aria-hidden="true"></span>' +
        '<button type="button" class="set-sw' + (p.active ? ' on' : '') + '" data-printer-toggle="' + p.id + '" data-printer-active="' + p.active + '"' +
          ' role="switch" aria-checked="' + (p.active ? 'true' : 'false') + '" aria-label="' + escapeHtml(p.name) + ' — aktívna"></button>' +
      '</span>' +
    '</div>';
  }).join('');
}

// Panel zdola je jeden pre pridanie aj upravu; pri uprave sa v nom odkryje
// skusobna tlac a zmazanie (destruktivna akcia nepatri na kazdy riadok).
function setPrinterSheet(title, p) {
  var t = byId('printerSheetTitle');
  if (t) t.textContent = title;
  var aux = byId('printerSheetActions');
  if (aux) aux.hidden = !p;
  var test = byId('btnTestPrinter');
  var del = byId('btnDeletePrinter');
  if (test) test.setAttribute('data-printer-test', p ? String(p.id) : '');
  if (del) {
    del.setAttribute('data-printer-delete', p ? String(p.id) : '');
    del.setAttribute('data-printer-name', p ? String(p.name) : '');
  }
}

function showAddPrinterForm() {
  editingPrinterId = null;
  setPrinterSheet('Nová tlačiareň', null);
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

  if (!name) { showToast('Zadajte názov tlačiarne'); return; }
  if (!ip) { showToast('Zadajte IP adresu'); return; }
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) { showToast('Neplatná IP adresa — očakáva sa tvar 192.168.0.107'); return; }
  if (port < 1 || port > 65535) { showToast('Port musí byť 1 – 65535'); return; }

  var btn = byId('btnSavePrinter');
  if (btn) btnLoading(btn);
  try {
    if (editingPrinterId) {
      await api.put('/printers/' + editingPrinterId, { name: name, ip: ip, port: port, dest: dest });
      showToast('Tlačiareň upravená', true);
    } else {
      await api.post('/printers', { name: name, ip: ip, port: port, dest: dest });
      showToast('Tlačiareň pridaná', true);
    }
    hideAddPrinterForm();
    await loadPrinters();
  } catch (e) {
    showToast(e.message || 'Tlačiareň sa nepodarilo uložiť', 'error');
  } finally {
    if (btn) btnReset(btn);
  }
}

function editPrinter(id) {
  var p = adminPrinters.find(function (pr) { return pr.id === id; });
  if (!p) return;
  editingPrinterId = id;
  setPrinterSheet('Upraviť tlačiareň', p);
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
    showToast(currentActive ? 'Tlačiareň vypnutá' : 'Tlačiareň zapnutá', true);
  } catch (e) {
    showToast('Chyba: ' + e.message);
  }
}

async function deletePrinter(id, name) {
  showConfirm('Zmazať tlačiareň?', 'Tlačiareň „' + name + '“ sa odstráni zo zoznamu. Bončeky, ktoré na ňu smerovali, sa prestanú tlačiť.', async function () {
    try {
      await api.del('/printers/' + id);
      showToast('Tlačiareň zmazaná', true);
      await loadPrinters();
    } catch (e) {
      showToast('Chyba: ' + e.message);
    }
  }, { type: 'danger', confirmText: 'Zmazať tlačiareň' });
}

async function testPrinter(id) {
  var statusEl = byId('printerStatus_' + id);
  var testBtn = _container.querySelector('[data-printer-test="' + id + '"]');
  if (statusEl) statusEl.style.background = 'var(--color-accent)';
  if (testBtn) btnLoading(testBtn);
  try {
    await api.post('/printers/' + id + '/test', {});
    if (statusEl) statusEl.style.background = 'var(--color-success)';
    showToast('Skúšobná tlač prešla', true);
  } catch (e) {
    if (statusEl) statusEl.style.background = 'var(--color-danger)';
    showToast('Skúšobná tlač zlyhala: ' + e.message, 'error');
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
  if (!value) return 'Neznámy';
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

function toneClass(tone) {
  return 'set-pill is-' + (tone || 'neutral');
}

// Jeden riadok diagnostiky: nazov vlavo, stav ako pilulka (alebo hodnota,
// ked to nie je stav) vpravo, detail drobnym pismom pod nazvom.
function renderPortosCard(title, value, details, plain) {
  var text = formatPortosValue(value) || 'Neznámy';
  var right = plain
    ? '<span class="set-val">' + escapeHtml(text) + '</span>'
    : '<span class="' + toneClass(statusTone(value)) + '">' + escapeHtml(text) + '</span>';
  return '<div class="set-row">' +
    '<span class="set-k">' + escapeHtml(title) +
      (details ? '<span class="set-sub">' + escapeHtml(details) + '</span>' : '') +
    '</span>' +
    '<span class="set-r">' + right + '</span>' +
  '</div>';
}

function mismatchWord(n) {
  if (n === 1) return '1 nezhoda';
  if (n >= 2 && n <= 4) return n + ' nezhody';
  return n + ' nezhôd';
}

function renderCompanyProfileCompare() {
  var el = byId('companyProfileCompare');
  if (!el) return;

  if (companyCompareError && !companyCompare) {
    el.innerHTML = '<div class="error-hint">' + escapeHtml(companyCompareError) + '</div>';
    return;
  }

  if (!companyCompare) {
    el.innerHTML = '<div class="empty-hint">Porovnanie identifikačných údajov zatiaľ nie je dostupné.</div>';
    return;
  }

  var summary = companyCompare.summary || {};
  var local = companyCompare.local || {};
  var portos = companyCompare.portos || {};
  var matches = summary.matches || {};
  var fields = [
    ['businessName', 'Názov firmy'],
    ['ico', 'IČO'],
    ['dic', 'DIČ'],
    ['icDph', 'IČ DPH'],
    ['registeredAddress', 'Sídlo firmy'],
    ['branchName', 'Prevádzka'],
    ['branchAddress', 'Adresa prevádzky'],
    ['cashRegisterCode', 'Kód pokladnice']
  ];

  var html = '<div class="set-group set-compare">';
  html += '<div class="set-row"><span class="set-k">Porovnanie s Portos'
    + (summary.lastComparedAt ? '<span class="set-sub">naposledy ' + escapeHtml(formatPortosDate(summary.lastComparedAt)) + '</span>' : '')
    + '</span><span class="set-r"><span class="set-pill ' + (summary.mismatchCount ? 'is-warning' : 'is-success') + '">'
    + (summary.mismatchCount ? mismatchWord(summary.mismatchCount) : 'údaje sa zhodujú')
    + '</span></span></div>';
  fields.forEach(function (field) {
    var key = field[0];
    var ok = matches[key];
    var ours = local[key] || '—';
    var theirs = portos[key] || '—';
    // Pri zhode staci hodnota raz; obe strany ukazujeme len tam, kde sa lisia.
    html += '<div class="set-row' + (ok ? '' : ' is-mismatch') + '">';
    html += '<span class="set-k">' + escapeHtml(field[1])
      + (ok ? '' : '<span class="set-sub">u nás: ' + escapeHtml(ours) + '<br>Portos: ' + escapeHtml(theirs) + '</span>')
      + '</span>';
    html += '<span class="set-r">' + (ok
      ? '<span class="set-val">' + escapeHtml(ours) + '</span>'
      : '<span class="set-pill is-warning">nezhoda</span>') + '</span>';
    html += '</div>';
  });
  html += '<p class="set-note">Pri prihlásení manažéra alebo admina sa údaje z Portosu uložia do databázy a do nastavení kasy. POS do Portosu nezapisuje — firma sa mení vždy v Portose. Ak po zmene vidíte nezhodu, obnovte stránku.</p>';
  html += '</div>';
  el.innerHTML = html;
}

function renderPortosDiagnostics() {
  var el = byId('portosDiagnostics');
  if (!el) return;

  if (portosStatusLoading) {
    el.innerHTML = '<div class="loading-hint">Načítavam stav Portosu…</div>';
    return;
  }

  if (portosStatusError && !portosStatus) {
    el.innerHTML = '<p class="set-note is-danger">' + escapeHtml(portosStatusError) + '</p>';
    return;
  }

  if (!portosStatus) {
    el.innerHTML = '<p class="set-note">Zatiaľ nie sú dostupné dáta z Portosu. Skúste „Obnoviť stav“.</p>';
    return;
  }

  var status = normalizePortosStatus(portosStatus);
  var connectivityValue = formatPortosValue(status.connectivity) || formatPortosValue(status.raw.state) || formatPortosValue(status.raw.status);
  // Objekt (state | serialNumber | …) do pilulky nepatri: stav ide do pilulky,
  // cely zaznam drobnym pismom pod nazov.
  var stateOf = function (v) {
    if (v && typeof v === 'object' && !Array.isArray(v)) return firstDefined(v.state, v.status, v.connected, v.name);
    return v;
  };
  var storageState = stateOf(status.storage);
  var storageDetails = formatPortosValue(status.storage);
  var printerState = stateOf(status.printer);
  var printerValue = formatPortosValue(printerState) || formatPortosValue(status.raw.printerState) || formatPortosValue(status.raw.printerStatus);
  var printerDetails = formatPortosValue(status.raw.printerMessage || status.raw.printerInfo || '')
    || (printerState !== status.printer ? formatPortosValue(status.printer) : '');
  var certExpiry = formatPortosDate(status.certExpiry);
  var certCount = Array.isArray(status.certificates) ? status.certificates.length : (status.certificates ? 1 : 0);

  var html = '';
  html += renderPortosCard('Pripojenie', connectivityValue || 'Neznámy', formatPortosValue(status.raw.connectivityInfo || status.raw.connectivityMessage || ''));
  html += renderPortosCard('CHDU / úložisko', formatPortosValue(storageState) || 'Neznámy', storageState !== status.storage ? storageDetails : '');
  html += renderPortosCard('Tlačiareň Portosu', printerValue || 'Neznámy', printerDetails);
  html += renderPortosCard('Kód pokladnice', status.cashRegisterCode || 'Neznámy', certCount ? (certCount === 1 ? '1 certifikát' : certCount + ' certifikáty') : '', true);
  html += renderPortosCard('Certifikát platný do', certExpiry, '', true);

  if (portosStatusError) {
    html += '<p class="set-note is-danger">' + escapeHtml(portosStatusError) + '</p>';
  }

  el.innerHTML = html;
}

async function loadCompanyProfile(options) {
  try {
    companyProfile = await api.getCompanyProfile({ refresh: options && options.refresh });
    syncCompanyProfileToLocalSettings(companyProfile);
    applyToForm();
  } catch (e) {
    // Identitu z localStorage NEpouzivame ako nahradu — fallback ('' IC DPH,
    // dummy kod pokladnice) by sa inak dal ulozit do DB a POS by prepol na
    // rezim neplatitela. Radsej zablokujeme ukladanie.
    companyProfile = null;
    renderVatStatus();
    renderSaveGuard();
    showToast(e.message || 'Firemné údaje sa nepodarilo načítať', 'error');
  }
}

async function syncProfileFromPortosAction() {
  var btn = byId('btnSyncProfileFromPortos');
  if (btn) {
    btn.disabled = true;
    btn.dataset.originalText = btn.textContent;
    btn.textContent = 'Preberám…';
  }
  try {
    var profile = await api.syncCompanyProfileFromPortos();
    if (profile) {
      companyProfile = profile;
      syncCompanyProfileToLocalSettings(companyProfile);
      if (typeof api.mergeCompanyProfileIntoPosSettingsCache === 'function') {
        api.mergeCompanyProfileIntoPosSettingsCache(profile);
      }
      applyToForm();
    }
    await loadCompanyProfileCompare();
    showToast('Údaje z Portosu prevzaté', true);
  } catch (e) {
    var msg = e && (e.data && e.data.detail || e.message) || 'Údaje z Portosu sa nepodarilo prevziať';
    showToast(msg, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = btn.dataset.originalText || 'Prevziať údaje z Portos';
    }
  }
}

async function loadCompanyProfileCompare() {
  companyCompareError = '';
  try {
    companyCompare = await api.getCompanyProfilePortosCompare();
  } catch (e) {
    companyCompare = null;
    companyCompareError = e && e.message ? e.message : 'Porovnanie s Portosom sa nepodarilo';
  } finally {
    renderCompanyProfileCompare();
  }
}

async function loadPortosStatus() {
  var btn = byId('btnRefreshPortos');
  portosStatusLoading = true;
  portosStatusError = '';
  if (btn) {
    btn.disabled = true;
    btn.dataset.originalText = btn.textContent;
    btn.textContent = 'Načítavam…';
  }
  renderPortosDiagnostics();
  try {
    portosStatus = await api.getPortosStatus();
  } catch (e) {
    portosStatus = null;
    portosStatusError = e && e.message ? e.message : 'Stav Portosu sa nepodarilo načítať';
  } finally {
    portosStatusLoading = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = btn.dataset.originalText || 'Obnoviť stav';
    }
    renderPortosDiagnostics();
    loadCompanyProfileCompare();
  }
}

function applyFiscalStornoPanelRole() {
  var panel = byId('fiscalStornoPanel');
  if (!panel) return;
  var u = typeof api.getUser === 'function' ? api.getUser() : null;
  var ok = u && (u.role === 'manazer' || u.role === 'admin');
  panel.style.display = ok ? '' : 'none';
}

function submitFiscalStorno() {
  var u = api.getUser();
  if (!u || (u.role !== 'manazer' && u.role !== 'admin')) {
    showToast('Iba manažér alebo admin.', 'error');
    return;
  }
  var input = byId('fiscalStornoPaymentId');
  var id = input ? parseInt(input.value, 10) : NaN;
  if (!id || id < 1) {
    showToast('Zadaj platné ID platby.', 'error');
    return;
  }
  showConfirm(
    'Odoslať fiškálne storno?',
    'Do eKasy sa odošle opravný doklad k platbe č. ' + id + ' a vytlačí sa cez Portos. Krok sa nedá vrátiť.',
    async function () {
      try {
        var r = await api.post('/payments/' + id + '/fiscal-storno', {});
        var st = r.fiscal && r.fiscal.status ? r.fiscal.status : 'ok';
        showToast('Storno odoslané (' + st + ')', true);
      } catch (e) {
        showToast(e.message || 'Storno sa nepodarilo odoslať', 'error');
      }
    },
    { type: 'danger', confirmText: 'Odoslať storno' }
  );
}

async function loadDiscounts() {
  var el = byId('discountsTable');
  if (el) showLoading(el, 'Načítavam zľavy…');
  try {
    adminDiscounts = await api.get('/discounts/all');
    if (el) hideLoading(el);
    renderDiscounts();
  } catch (e) {
    if (el) hideLoading(el);
    showToast(e.message || 'Chyba načítania zliav', 'error');
    if (el) el.innerHTML = '<p class="set-note is-danger">Zľavy sa nepodarilo načítať. Skúste stránku obnoviť.</p>';
  }
}

function discountTypeLabel(d) {
  return d.type === 'percent' ? 'Percento' : 'Pevná suma';
}
function discountValueLabel(d) {
  return d.type === 'percent'
    ? String(d.value).replace('.', ',') + ' %'
    : fmtCost(d.value) + ' €';
}

function renderDiscounts() {
  var el = byId('discountsTable');
  if (!adminDiscounts.length) {
    el.innerHTML = '<p class="set-empty">Zatiaľ žiadna zľava. Pridajte prvú — čašník si ju potom vyberie pri platbe.</p>';
    return;
  }
  el.innerHTML = adminDiscounts.map(function (d) {
    return '<div class="set-row set-item' + (d.active ? '' : ' is-off') + '">' +
      '<button type="button" class="set-main" data-disc-open="' + d.id + '">' +
        '<span class="set-main-txt">' +
          '<span class="set-title">' + escapeHtml(d.name) + (d.active ? '' : ' <span class="set-off">vypnutá</span>') + '</span>' +
          '<span class="set-sub">' + discountTypeLabel(d) + ' · ' + escapeHtml(discountValueLabel(d)) + '</span>' +
        '</span>' +
        CHEVRON +
      '</button>' +
      '<span class="set-r">' +
        '<button type="button" class="set-sw' + (d.active ? ' on' : '') + '" data-disc-toggle="' + d.id + '" data-disc-active="' + d.active + '"' +
          ' role="switch" aria-checked="' + (d.active ? 'true' : 'false') + '" aria-label="' + escapeHtml(d.name) + ' — aktívna"></button>' +
      '</span>' +
    '</div>';
  }).join('');
}

function openDiscountDetail(id) {
  var d = adminDiscounts.find(function (x) { return x.id === id; });
  if (!d) return;
  var t = byId('discountDetailTitle');
  var txt = byId('discountDetailText');
  var del = byId('btnDeleteDiscount');
  if (t) t.textContent = d.name;
  if (txt) txt.textContent = discountTypeLabel(d) + ' · ' + discountValueLabel(d) + ' · ' + (d.active ? 'aktívna' : 'vypnutá');
  if (del) {
    del.setAttribute('data-disc-delete', String(d.id));
    del.setAttribute('data-disc-name', String(d.name));
  }
  byId('discountDetail').style.display = 'block';
  var close = byId('btnCloseDiscountDetail');
  if (close) close.focus();
}

function hideDiscountDetail() {
  var el = byId('discountDetail');
  if (el) el.style.display = 'none';
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
  if (!name) { showToast('Zadajte názov zľavy'); return; }
  if (!value || value <= 0) { showToast('Zadajte platnú hodnotu'); return; }
  if (type === 'percent' && value > 100) { showToast('Percento nemôže byť viac ako 100'); return; }
  var btn = byId('btnSaveDiscount');
  if (btn) btnLoading(btn);
  try {
    await api.post('/discounts', { name: name, type: type, value: value });
    hideAddDiscountForm();
    showToast('Zľava pridaná', true);
    await loadDiscounts();
  } catch (e) {
    showToast(e.message || 'Zľavu sa nepodarilo pridať', 'error');
  } finally {
    if (btn) btnReset(btn);
  }
}

async function toggleDiscountActive(id, currentActive) {
  try {
    await api.put('/discounts/' + id, { active: !currentActive });
    await loadDiscounts();
    showToast(currentActive ? 'Zľava vypnutá' : 'Zľava zapnutá', true);
  } catch (e) {
    showToast('Chyba: ' + e.message);
  }
}

async function deleteDiscount(id, name) {
  showConfirm('Zmazať zľavu?', 'Zľava „' + name + '“ zmizne z pokladne. Už použité zľavy na dokladoch to nemení.', async function () {
    try {
      await api.del('/discounts/' + id);
      showToast('Zľava zmazaná', true);
      await loadDiscounts();
    } catch (e) {
      showToast('Chyba: ' + e.message);
    }
  }, { type: 'danger', confirmText: 'Zmazať zľavu' });
}

/* ─── EVENT DELEGATION ─── */

function onContainerClick(e) {
  var target = e.target;

  // Klepnutie mimo panel zdola (na scrim) ho zatvori.
  if (target.classList && target.classList.contains('set-sheet')) {
    if (target.id === 'addPrinterForm') hideAddPrinterForm();
    else if (target.id === 'addDiscountForm') hideAddDiscountForm();
    else if (target.id === 'discountDetail') hideDiscountDetail();
    return;
  }

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

  // Simple toggle (autoPrint)
  if (target.id === 'sAutoPrint') {
    target.classList.toggle('on');
    syncSwitch(target);
    return;
  }

  // QR payment toggle
  if (target.id === 'sQrPaymentEnabled' || target.closest('#sQrPaymentEnabled')) {
    toggleQrPayment();
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
    hideAddPrinterForm();
    deletePrinter(parseInt(printerDel.dataset.printerDelete), printerDel.dataset.printerName);
    return;
  }

  if (target.id === 'btnRefreshPortos' || target.closest('#btnRefreshPortos')) {
    loadPortosStatus();
    return;
  }

  if (target.id === 'btnSyncProfileFromPortos' || target.closest('#btnSyncProfileFromPortos')) {
    syncProfileFromPortosAction();
    return;
  }

  if (target.id === 'btnFiscalStorno' || target.closest('#btnFiscalStorno')) {
    submitFiscalStorno();
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

  // Discount list actions (delegated)
  var discToggle = target.closest('[data-disc-toggle]');
  if (discToggle) {
    toggleDiscountActive(parseInt(discToggle.dataset.discToggle), discToggle.dataset.discActive === 'true');
    return;
  }
  var discOpen = target.closest('[data-disc-open]');
  if (discOpen) {
    openDiscountDetail(parseInt(discOpen.dataset.discOpen));
    return;
  }
  if (target.id === 'btnCloseDiscountDetail' || target.closest('#btnCloseDiscountDetail')) {
    hideDiscountDetail();
    return;
  }
  var discDel = target.closest('[data-disc-delete]');
  if (discDel) {
    hideDiscountDetail();
    deleteDiscount(parseInt(discDel.dataset.discDelete), discDel.dataset.discName);
    return;
  }
}

// Escape zatvori otvoreny panel zdola (tlaciaren / zlava).
function onDocKeydown(e) {
  if (e.key !== 'Escape' || !_container) return;
  var open = _container.querySelector('.set-sheet[style*="block"]');
  if (!open) return;
  e.preventDefault();
  if (open.id === 'addPrinterForm') hideAddPrinterForm();
  else if (open.id === 'addDiscountForm') hideAddDiscountForm();
  else if (open.id === 'discountDetail') hideDiscountDetail();
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

export async function init(container) {
  _container = container;
  container.innerHTML = getTemplate();

  container.addEventListener('click', onContainerClick);
  container.addEventListener('change', onContainerChange);
  document.addEventListener('keydown', onDocKeydown);

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
  await loadCompanyProfile({ refresh: true });
  loadPrinters();
  applyFiscalStornoPanelRole();
  await loadPortosStatus();
  loadDiscounts();
}

export function destroy() {
  document.removeEventListener('keydown', onDocKeydown);
  if (_container) {
    _container.removeEventListener('click', onContainerClick);
    _container.removeEventListener('change', onContainerChange);
  }
  _container = null;
  settings = {};
  adminPrinters = [];
  adminDiscounts = [];
  editingPrinterId = null;
  portosStatus = null;
  portosStatusError = '';
  portosStatusLoading = false;
  companyProfile = null;
  companyCompare = null;
  companyCompareError = '';
}
