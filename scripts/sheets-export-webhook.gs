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
 */

var TOKEN = 'REPLACE_WITH_SHEETS_EXPORT_TOKEN';

// Cieľový list podľa gid z URL (…#gid=NNN). 0 = prvý list v poradí.
// Nastav na konkrétne gid ak sezónny P&L NIE je prvá záložka — inak by
// full-rewrite prepísal nesprávnu záložku.
var SHEET_GID = 0;

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
    sheet.clearContents(); // obsah áno, formátovanie (šírky, farby) ostáva
    sheet.getRange(1, 1, padded.length, cols).setValues(padded);
    return out.setContent(JSON.stringify({ ok: true, rows: padded.length, sheet: sheet.getName() }));
  } catch (err) {
    return out.setContent(JSON.stringify({ ok: false, error: String(err) }));
  }
}
