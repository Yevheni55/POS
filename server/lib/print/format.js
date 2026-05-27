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
// Beep cez ESC B n1 n2 (Epson + clones). n1 = pocet beep-ov (1-9),
// n2 = trvanie kazdeho × 50ms (1-9). Aby kuchyna pocula ze prisiel novy bon
// aj v ruchu prevadzky. Send pred CUT — beep fyzicky zaznie kym pricitava
// papierove kolieso, takze coincidena s vyjdenim papiera.
// BEL (\x07) je starsi univerzalny single-beep ako fallback pre printery
// ktore ESC B nepodporuju (vzacny pripad, ale skor included).
const ESC_B = (n1, n2) => ESC + 'B' + String.fromCharCode(n1) + String.fromCharCode(n2);
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
  // 3 beepy × 250ms = 750ms celkom — jasne pocuteľné v ruchu kuchyne
  BEEP_KITCHEN: '\x07' + ESC_B(3, 5),
  // 5 kratkych beep-ov × 150ms = 750ms staccato — urgent pattern pre storno
  BEEP_STORNO: '\x07\x07' + ESC_B(5, 3),
};

export function formatEur(num) {
  return num.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

export function padLine(left, right, width) {
  width = width || 32;
  const pad = width - left.length - right.length;
  return left + (pad > 0 ? ' '.repeat(pad) : '  ') + right;
}
