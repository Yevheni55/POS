/**
 * Google Apps Script webhook pre denný export sezónneho P&L z POS servera.
 * Párový kód: server/lib/sheets-export.js (POST { token, values }).
 *
 * Inštalácia (raz):
 *   1. Otvor cieľový Google Sheet → Rozšírenia (Extensions) → Apps Script.
 *   2. Vymaž predvolený obsah, vlož tento súbor.
 *   3. TOKEN nahraď hodnotou SHEETS_EXPORT_TOKEN zo server/.env na kase.
 *   4. Nasadiť (Deploy) → Nové nasadenie (New deployment) → typ Web app:
 *        Execute as: Me · Who has access: Anyone
 *      → autorizuj svoj účet → skopíruj Web app URL.
 *   5. URL zapíš do server/.env ako SHEETS_EXPORT_URL a reštartuj server.
 *
 * Prečo webhook: zápis do Sheets vyžaduje Google OAuth; Web App beží pod
 * účtom vlastníka tabuľky, takže server nepotrebuje žiadne Google kľúče —
 * stačí zdieľaný token. Script prepíše celý prvý list (full rewrite je
 * idempotentný a spätné opravy sa zahoja samé).
 *
 * FORMÁTOVANIE sa aplikuje PROGRAMOVO po každom zápise, nie ručne v tabuľke.
 * Dôvod: sezóna rastie o riadok denne, takže ručný formát nastavený na pevné
 * riadky by sa už zajtra rozišiel s obsahom. Sekcie sa hľadajú podľa textu
 * v stĺpci A, takže formát drží aj keď pribudne mesiac či celý nový blok.
 */

var TOKEN = 'REPLACE_WITH_SHEETS_EXPORT_TOKEN';

// Cieľový list podľa gid z URL (…#gid=NNN). 0 = prvý list v poradí.
// Nastav na konkrétne gid ak sezónny P&L NIE je prvá záložka — inak by
// full-rewrite prepísal nesprávnu záložku.
var SHEET_GID = 0;

// --- paleta ---------------------------------------------------------------
var C_INK = '#1e1812';   // espresso — základný text
var C_HEAD = '#1f3a5c';  // tmavá modrá — pásy sekcií
var C_CREAM = '#ece4d2'; // krém — súčtové riadky
var C_MUTED = '#7a6450'; // tlmená hnedá — vysvetlivky
var C_BAND = '#faf7f1';  // veľmi jemný pruh pre čitateľnosť denných riadkov
var C_LINE = '#d9cfc0';
var C_GOOD = '#1f6b4d';
var C_BAD = '#b03830';

// Účtovnícky formát: záporné číslo červené v zátvorke, nula ako pomlčka —
// v dennom rozpade je hneď vidno stratový deň.
var F_EUR = '#,##0.00 "€";[RED](#,##0.00 "€");"–"';
var F_INT = '#,##0;[RED](#,##0);"–"';

function targetSheet(ss) {
  if (SHEET_GID) {
    var all = ss.getSheets();
    for (var s = 0; s < all.length; s++) {
      if (all[s].getSheetId() === SHEET_GID) return all[s];
    }
  }
  return ss.getSheets()[0];
}

function doPost(e) {
  var out = ContentService.createTextOutput().setMimeType(ContentService.MimeType.JSON);
  try {
    var body = JSON.parse(e.postData.contents);
    if (!TOKEN || body.token !== TOKEN) {
      return out.setContent(JSON.stringify({ ok: false, error: 'bad token' }));
    }
    var values = body.values;
    if (!values || !values.length) {
      return out.setContent(JSON.stringify({ ok: false, error: 'no values' }));
    }
    var cols = 0;
    for (var i = 0; i < values.length; i++) cols = Math.max(cols, values[i].length);
    var padded = values.map(function (r) {
      return r.concat(new Array(cols - r.length).fill(''));
    });
    var sheet = targetSheet(SpreadsheetApp.getActiveSpreadsheet());

    // clear() (nie clearContents) — formát sa nižšie nastavuje nanovo, takže
    // pozostatok po dlhšom včerajšom behu by inak visel pod novými dátami.
    sheet.clear();
    var bands = sheet.getBandings();
    for (var b = 0; b < bands.length; b++) bands[b].remove();
    // clear() zlúčenie buniek NEZRUŠÍ. Bez tohto by sa zlúčený podtitulok
    // z včerajška po pár behoch navrstvil a setValues by padlo na
    // "cannot write to merged cell".
    sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).breakApart();

    sheet.getRange(1, 1, padded.length, cols).setValues(padded);

    // Formátovanie NESMIE zhodiť zápis dát. Keby Apps Script na niečom spadol,
    // čísla už v tabuľke sú a odpoveď to prizná — radšej škaredá tabuľka
    // so správnymi číslami než chybová hláška a prázdny list.
    var styled = null;
    try {
      styled = styleSheet(sheet, padded, cols);
    } catch (styleErr) {
      styled = 'style failed: ' + String(styleErr);
    }

    return out.setContent(JSON.stringify({
      ok: true, rows: padded.length, sheet: sheet.getName(), styled: styled,
    }));
  } catch (err) {
    return out.setContent(JSON.stringify({ ok: false, error: String(err) }));
  }
}

/** Prvý stĺpec ako text, kvôli hľadaniu sekcií. */
function labelAt(rows, i) {
  return (rows[i] && rows[i][0] != null) ? String(rows[i][0]).trim() : '';
}

function styleSheet(sheet, rows, cols) {
  var n = rows.length;
  var applied = [];

  // --- základ ---
  sheet.getRange(1, 1, n, cols)
    .setFontFamily('Arial').setFontSize(10).setFontColor(C_INK)
    .setVerticalAlignment('middle');

  // --- titulok a podtitulok ---
  sheet.getRange(1, 1).setFontSize(16).setFontWeight('bold').setFontColor(C_HEAD);
  sheet.setRowHeight(1, 34);
  sheet.getRange(2, 1, 1, cols).merge()
    .setFontSize(9).setFontColor(C_MUTED).setWrap(true)
    .setVerticalAlignment('top');
  sheet.setRowHeight(2, 46);
  applied.push('title');

  // --- sekcie, súčty, dátové bloky ---
  var dayHeaderRow = 0;
  var firstDayRow = 0;
  var lastDayRow = 0;

  for (var i = 0; i < n; i++) {
    var label = labelAt(rows, i);
    var r = i + 1;
    if (!label) continue;

    var isSection = /^(SÚHRN|PO FIRMÁCH|PO MESIACOCH|PO DŇOCH)/.test(label);
    var isHeader = label === 'Dátum';           // hlavička denného bloku
    var isTotal = /^SPOLU/.test(label);
    var isResult = /^VÝSLEDOK/.test(label);

    if (isSection || isHeader) {
      sheet.getRange(r, 1, 1, cols)
        .setBackground(C_HEAD).setFontColor('#ffffff').setFontWeight('bold');
      sheet.setRowHeight(r, 26);
      if (isHeader) {
        dayHeaderRow = r;
        firstDayRow = r + 1;
      }
    } else if (isTotal) {
      sheet.getRange(r, 1, 1, cols)
        .setBackground(C_CREAM).setFontWeight('bold')
        .setBorder(true, null, true, null, null, null, C_LINE,
                   SpreadsheetApp.BorderStyle.SOLID);
      if (dayHeaderRow && r > dayHeaderRow) lastDayRow = r - 1;
    } else if (isResult) {
      sheet.getRange(r, 1, 1, cols).setBackground(C_CREAM).setFontWeight('bold');
      sheet.getRange(r, 1).setFontSize(12);
      var v = rows[i][1];
      sheet.getRange(r, 2).setFontSize(12)
        .setFontColor(typeof v === 'number' && v < 0 ? C_BAD : C_GOOD);
    }
  }
  applied.push('sections');

  // --- čísla ---
  // Stĺpec B je vždy peňažný (súhrn aj mesiace aj dni). Ďalšie stĺpce sú
  // peňažné len tam, kde blok má viac číselných stĺpcov.
  sheet.getRange(3, 2, n - 2, Math.max(cols - 1, 1)).setHorizontalAlignment('right');
  sheet.getRange(3, 2, n - 2, 1).setNumberFormat(F_EUR);
  if (cols >= 6) sheet.getRange(3, 3, n - 2, 4).setNumberFormat(F_EUR);
  if (cols >= 7) sheet.getRange(3, 7, n - 2, 1).setNumberFormat(F_INT);
  applied.push('numbers');

  // Denný blok: Účty su kusy, nie eurá; dátum a deň vľavo.
  if (firstDayRow) {
    var endDay = lastDayRow || n;
    var cntDay = Math.max(endDay - firstDayRow + 1, 1);
    sheet.getRange(firstDayRow, 1, cntDay, 2).setHorizontalAlignment('left');
    sheet.getRange(firstDayRow, 3, cntDay, 1).setNumberFormat(F_INT);
    sheet.getRange(firstDayRow, 4, cntDay, Math.max(cols - 3, 1)).setNumberFormat(F_EUR);

    // Jemné pruhovanie — 93 riadkov sa bez neho číta ťažko.
    if (cntDay > 3) {
      var band = sheet.getRange(firstDayRow, 1, cntDay, cols)
        .applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, false, false);
      band.setHeaderRowColor(null).setFirstRowColor('#ffffff')
        .setSecondRowColor(C_BAND).setFooterRowColor(null);
      applied.push('banding');
    }
    sheet.setFrozenRows(dayHeaderRow);
    applied.push('freeze');
  }

  // --- vysvetlivky v stĺpci D súhrnu ---
  for (var j = 0; j < n; j++) {
    if (rows[j][3] && !/^(SÚHRN|PO |Dátum|SPOLU)/.test(labelAt(rows, j))) {
      sheet.getRange(j + 1, 4).setFontColor(C_MUTED).setFontSize(9);
    }
  }

  // --- šírky ---
  sheet.setColumnWidth(1, 260);
  for (var c = 2; c <= cols; c++) sheet.setColumnWidth(c, c === 4 ? 230 : 110);
  applied.push('widths');

  return applied.join(',');
}
