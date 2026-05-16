// Formatting primitives shared across print handlers + ticket builders:
//   - sk-SK Bratislava-tz date/time helpers (server runs UTC in Docker)
//   - Latin diacritic → ASCII transliteration for CP437 thermal printers
//   - ESC/POS command constants
//   - Money + padded-line helpers used by ticket builders

export const PRINTER_IP = process.env.PRINTER_IP || '192.168.0.106';
export const PRINTER_PORT = parseInt(process.env.PRINTER_PORT || '9100');

// Lokálny čas v formáte "HH:MM" v Bratislava timezone. Server v Dockeri
// beží v UTC, takže new Date().getHours() vracia UTC hodinu — letný čas
// (CEST) bol potom na bonoch o 2h pozadu, zimný čas (CET) o 1h. Intl
// helper rieši DST automaticky podľa IANA timezone db.
export function localTimeHHMM(date) {
  return new Intl.DateTimeFormat('sk-SK', {
    timeZone: 'Europe/Bratislava',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date || new Date());
}

export function localDateTime(date) {
  return new Intl.DateTimeFormat('sk-SK', {
    timeZone: 'Europe/Bratislava',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date || new Date());
}

// Strip Latin diacritics down to ASCII so thermal printers (default code page
// CP437) don't render garbage when menu/table/staff names contain Slovak
// characters (č, š, ť, ý, á, ô, ľ, ž, ä, …). The wire-write path uses
// Buffer.from(data, 'binary'), which truncates codepoints > 255 — without this
// normalize step receipts come out with Omß / Tat8rka / Surfersk8 etc.
// Full CP852/CP1250 support (with ESC t n) is a follow-up; transliteration is
// the pragmatic fix that keeps tickets readable for kitchen/bar.
const _NON_DECOMPOSING = { 'đ': 'd', 'Đ': 'D', 'ł': 'l', 'Ł': 'L' };
export function s(text) {
  return String(text == null ? '' : text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐłŁ]/g, function (c) { return _NON_DECOMPOSING[c]; });
}

// ESC/POS commands
const ESC = '\x1B';
const GS = '\x1D';
export const CMD = {
  INIT: ESC + '@',
  BOLD_ON: ESC + 'E\x01',
  BOLD_OFF: ESC + 'E\x00',
  ALIGN_CENTER: ESC + 'a\x01',
  ALIGN_LEFT: ESC + 'a\x00',
  DOUBLE_SIZE: GS + '!\x11',
  NORMAL_SIZE: GS + '!\x00',
  LARGE_SIZE: GS + '!\x01',
  CUT: GS + 'V\x00',
  FEED: ESC + 'd\x03',
  LINE: '--------------------------------\n',
  DASHED: '- - - - - - - - - - - - - - - -\n',
};

export function formatEur(num) {
  return num.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

export function padLine(left, right, width) {
  width = width || 32;
  const pad = width - left.length - right.length;
  return left + (pad > 0 ? ' '.repeat(pad) : '  ') + right;
}
