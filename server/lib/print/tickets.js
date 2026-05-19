// ESC/POS ticket builders. Each function returns a string of ESC/POS bytes
// ready to send to a thermal printer via sendToPrinter().

import { needsSaucePicker, SAUCE_ANNOTATION_NAME } from '../menu-helpers.js';
import { CMD, formatEur, localDateTime, padLine, s } from './format.js';

export function buildKitchenTicket({ dest, tableName, staffName, items, orderNum, time }) {
  let ticket = '';
  ticket += CMD.INIT;

  // Header
  ticket += CMD.ALIGN_CENTER;
  ticket += CMD.DOUBLE_SIZE;
  ticket += s(dest) + '\n';
  ticket += CMD.NORMAL_SIZE;
  ticket += CMD.DASHED;

  // Table + Time
  ticket += CMD.LARGE_SIZE;
  ticket += CMD.BOLD_ON;
  ticket += s(tableName) + '\n';
  ticket += CMD.BOLD_OFF;
  ticket += CMD.NORMAL_SIZE;
  ticket += time + '  |  ' + s(staffName) + '\n';
  if (orderNum) ticket += '#' + orderNum + '\n';
  ticket += CMD.DASHED;

  // Items
  // Combos absorb their "Omáčka (combo)" companion row inline so the kitchen
  // sees combo + sauce on the same logical line at the same LARGE+BOLD size.
  // (At LARGE size the line will wrap on a 32-char printer — that's fine,
  // it's still all combo info; cashier requested same font/size as the burger.)
  ticket += CMD.ALIGN_LEFT;
  items.forEach((item, idx) => {
    // Match against the raw DB string (still UTF-8 inside Node) — DON'T compare
    // against transliterated form, the combo-companion row is "Omáčka (combo)".
    if (item.name === 'Omáčka (combo)') return;

    ticket += CMD.BOLD_ON;
    // qty > 1 → DOUBLE_SIZE (height + width) prefix so the cook can't miss
    // multi-portion lines on a busy ticket. qty == 1 stays at LARGE.
    // Effective text width on a 32-column thermal printer:
    //   - LARGE_SIZE = single-width  → 32 columns
    //   - DOUBLE_SIZE = double-width → 16 columns
    // qty=1 spends ~6 chars on " 1x  ", leaving ~26 for the name.
    // qty>1 spends ~4 large chars on " 2x " = 8 visible columns,
    // leaving ~24 for the LARGE name (the qty itself prints in DOUBLE).
    const nameAscii = s(item.name);
    const sauceAscii = (() => {
      if (!needsSaucePicker(item.name)) return '';
      const next = items[idx + 1];
      if (next && next.name === SAUCE_ANNOTATION_NAME && next.note) return s(next.note);
      return '';
    })();
    const nameBudget = item.qty > 1 ? 24 : 26;
    const inlineSauce = sauceAscii && (nameAscii.length + 3 + sauceAscii.length) <= nameBudget;

    if (item.qty > 1) {
      ticket += CMD.DOUBLE_SIZE;
      ticket += ' ' + item.qty + 'x ';
      ticket += CMD.LARGE_SIZE;
      ticket += ' ' + nameAscii;
    } else {
      ticket += CMD.LARGE_SIZE;
      ticket += ' ' + item.qty + 'x  ' + nameAscii;
    }
    if (inlineSauce) ticket += '  |  ' + sauceAscii;
    ticket += '\n';
    // If the sauce did NOT fit inline, drop it on its own line right under
    // the combo at the same LARGE+BOLD size so the cook can still see it.
    // Looks like:
    //    2x  Combo BBQ Smash
    //       » Big Mac domaca
    if (sauceAscii && !inlineSauce) {
      // Pure-ASCII '+' prefix — '»' (0xBB) renders as random glyphs on the
      // CP437 default code page of generic ESC/POS thermals (saw '¶' on the
      // bar printer). Stick to <128 bytes for safety.
      ticket += '   + ' + sauceAscii + '\n';
    }
    // Note (kitchen instruction) — same LARGE+BOLD size as the item itself,
    // prefixed with "!! " so the cook can't miss it. Was a tiny "  >> ..."
    // line in NORMAL+regular weight that disappeared on a busy ticket.
    if (item.note) {
      ticket += '   !! ' + s(item.note) + '\n';
    }
    ticket += CMD.NORMAL_SIZE;
    ticket += CMD.BOLD_OFF;
  });

  // Footer
  ticket += CMD.DASHED;
  ticket += CMD.ALIGN_CENTER;
  ticket += CMD.NORMAL_SIZE;
  ticket += 'NOVE POLOZKY\n';
  ticket += CMD.FEED;
  ticket += CMD.CUT;

  return ticket;
}

// Predúčet — informatívny doklad pre zákazníka pred fiškálnou platbou.
// Restauracny štandard v SR/CZ: čašník donesie zákazníkovi tento doklad
// aby si overil sumu, prípadne sa rozhodol pre platobnú metódu. NIE JE to
// daňový doklad — § 3 ods. 1 zákona o ERP požaduje aby bol jasne odlíšený.
export function buildPreBillTicket({ tableName, staffName, items, total, subtotal, discount, time, orderNum }) {
  let ticket = '';
  ticket += CMD.INIT;

  // Header — výrazne odlíšené od UCTENKA aby si čašník nepomýlil bony
  ticket += CMD.ALIGN_CENTER;
  ticket += CMD.DOUBLE_SIZE;
  ticket += 'PREDBEZNY\n';
  ticket += 'UCET\n';
  ticket += CMD.NORMAL_SIZE;
  ticket += CMD.BOLD_ON;
  ticket += 'NIE JE DANOVY DOKLAD\n';
  ticket += CMD.BOLD_OFF;
  ticket += CMD.LINE;

  // Meta — stôl, čašník, čas, číslo objednávky
  ticket += CMD.ALIGN_LEFT;
  ticket += s(tableName) + '  |  ' + time + '\n';
  ticket += 'Cisnik: ' + s(staffName) + '\n';
  if (orderNum) ticket += 'Obj. #' + orderNum + '\n';
  ticket += CMD.LINE;

  // Items — rovnaký pattern ako fiskal receipt (qty x meno  cena)
  items.forEach(item => {
    // Skip sauce companion rows — sú už zahrnuté v cene comba
    if (item.name === 'Omáčka (combo)') return;

    const price = (item.price * item.qty).toFixed(2).replace('.', ',') + ' E';
    const line = ' ' + item.qty + 'x ' + s(item.name);
    const pad = 32 - line.length - price.length;
    ticket += line + (pad > 0 ? ' '.repeat(pad) : '  ') + price + '\n';
  });

  ticket += CMD.LINE;

  // Subtotal + zľava (ak je nejaká) — pred SPOLU
  if (discount && discount > 0.005) {
    ticket += CMD.ALIGN_LEFT;
    ticket += padLine('Medzisucet:', subtotal.toFixed(2).replace('.', ',') + ' EUR') + '\n';
    ticket += padLine('Zlava:', '-' + discount.toFixed(2).replace('.', ',') + ' EUR') + '\n';
    ticket += CMD.LINE;
  }

  // Total — bold + double size, ako fiskal aby bolo jasne čitateľné na 32-char termali
  ticket += CMD.ALIGN_CENTER;
  ticket += CMD.BOLD_ON;
  ticket += CMD.DOUBLE_SIZE;
  ticket += 'SPOLU: ' + total.toFixed(2).replace('.', ',') + ' EUR\n';
  ticket += CMD.NORMAL_SIZE;
  ticket += CMD.BOLD_OFF;
  ticket += CMD.DASHED;

  // Footer — druhý disclaimer (právne dôležité)
  ticket += CMD.BOLD_ON;
  ticket += 'Toto NIE JE danovy doklad\n';
  ticket += CMD.BOLD_OFF;
  ticket += 'Fiskalny blocek dostanete\n';
  ticket += 'pri platbe.\n';
  ticket += '\n';
  ticket += 'Dakujeme za navstevu!\n';
  ticket += CMD.FEED;
  ticket += CMD.CUT;

  return ticket;
}

export function buildReceiptTicket({ tableName, staffName, items, total, method, time, orderNum }) {
  let ticket = '';
  ticket += CMD.INIT;

  // Header
  ticket += CMD.ALIGN_CENTER;
  ticket += CMD.DOUBLE_SIZE;
  ticket += 'UCTENKA\n';
  ticket += CMD.NORMAL_SIZE;
  ticket += CMD.LINE;
  ticket += s(tableName) + '  |  ' + time + '\n';
  ticket += 'Cisnik: ' + s(staffName) + '\n';
  if (orderNum) ticket += 'Obj. #' + orderNum + '\n';
  ticket += CMD.LINE;

  // Items
  ticket += CMD.ALIGN_LEFT;
  items.forEach(item => {
    const price = (item.price * item.qty).toFixed(2).replace('.', ',') + ' E';
    const line = ' ' + item.qty + 'x ' + s(item.name);
    const pad = 32 - line.length - price.length;
    ticket += line + (pad > 0 ? ' '.repeat(pad) : '  ') + price + '\n';
  });

  // Total
  ticket += CMD.LINE;
  ticket += CMD.ALIGN_CENTER;
  ticket += CMD.BOLD_ON;
  ticket += CMD.DOUBLE_SIZE;
  ticket += 'CELKOM: ' + total.toFixed(2).replace('.', ',') + ' EUR\n';
  ticket += CMD.NORMAL_SIZE;
  ticket += CMD.BOLD_OFF;
  ticket += 'Platba: ' + s(method).toUpperCase() + '\n';
  ticket += CMD.DASHED;
  ticket += 'Dakujeme za navstevu!\n';
  ticket += CMD.FEED;
  ticket += CMD.CUT;

  return ticket;
}

// Paragón ticket — manuálny náhradný doklad pri výpadku ERP / Portos.
// § 10 z. 289/2008: musí obsahovať slovo "PARAGÓN" + povinné náležitosti
// + poznámku že doklad bude dodatočne zaregistrovaný v eKasa systéme.
export function buildParagonTicket({ paragonNumber, tableName, staffName, items, total, vatRate, method, time, dateStr, companyName }) {
  let ticket = '';
  ticket += CMD.INIT;

  // Header — výrazne odlíšené "PARAGÓN" tak aby kontrolór hneď videl
  ticket += CMD.ALIGN_CENTER;
  ticket += CMD.DOUBLE_SIZE;
  ticket += 'PARAGON\n';
  ticket += CMD.NORMAL_SIZE;
  ticket += CMD.BOLD_ON;
  ticket += 'Nahradny doklad pri vypadku ERP\n';
  ticket += CMD.BOLD_OFF;
  ticket += CMD.LINE;

  if (companyName) {
    ticket += s(companyName) + '\n';
  }

  // Meta — paragón číslo, dátum, čas, stôl, čašník
  ticket += CMD.ALIGN_LEFT;
  ticket += CMD.BOLD_ON;
  ticket += 'Cislo paragonu: ' + paragonNumber + '\n';
  ticket += CMD.BOLD_OFF;
  ticket += 'Datum: ' + (dateStr || localDateTime()) + '\n';
  if (tableName) ticket += s(tableName) + '\n';
  if (staffName) ticket += 'Cisnik: ' + s(staffName) + '\n';
  ticket += CMD.LINE;

  // Items
  items.forEach((item) => {
    if (item.name === 'Omáčka (combo)') return;
    const lineTotal = item.price * item.qty;
    const price = lineTotal.toFixed(2).replace('.', ',') + ' E';
    const line = ' ' + item.qty + 'x ' + s(item.name);
    const pad = 32 - line.length - price.length;
    ticket += line + (pad > 0 ? ' '.repeat(pad) : '  ') + price + '\n';
  });

  ticket += CMD.LINE;

  // Total + VAT note
  ticket += CMD.ALIGN_CENTER;
  ticket += CMD.BOLD_ON;
  ticket += CMD.DOUBLE_SIZE;
  ticket += 'SPOLU: ' + total.toFixed(2).replace('.', ',') + ' EUR\n';
  ticket += CMD.NORMAL_SIZE;
  ticket += CMD.BOLD_OFF;

  if (typeof vatRate === 'number') {
    ticket += 'DPH ' + vatRate.toFixed(0) + '% zapocitana v cene\n';
  }
  ticket += 'Sposob platby: ' + s(method).toUpperCase() + '\n';
  ticket += CMD.DASHED;

  // Mandatory disclaimer per § 10
  ticket += CMD.ALIGN_LEFT;
  ticket += CMD.BOLD_ON;
  ticket += 'Doklad vystaveny manualne pri\n';
  ticket += 'vypadku elektronickej pokladnice.\n';
  ticket += CMD.BOLD_OFF;
  ticket += 'Po obnoveni funkcnosti bude\n';
  ticket += 'doklad dodatocne zaregistrovany\n';
  ticket += 'v systeme eKasa cez Portos.\n';
  ticket += 'Zakaznik si moze vyziadat\n';
  ticket += 'kopiu fiskalneho dokladu po\n';
  ticket += 'registracii.\n';
  ticket += CMD.DASHED;

  ticket += CMD.ALIGN_CENTER;
  ticket += 'Dakujeme za pochopenie!\n';
  ticket += CMD.FEED;
  ticket += CMD.CUT;

  return ticket;
}

export function buildZReportTicket(data) {
  let t = '';
  t += CMD.INIT;

  // Header
  t += CMD.ALIGN_CENTER;
  t += CMD.BOLD_ON;
  t += '================================\n';
  t += CMD.DOUBLE_SIZE;
  t += 'DENNA UZAVIERKA\n';
  t += 'Z-REPORT\n';
  t += CMD.NORMAL_SIZE;
  t += CMD.BOLD_OFF;
  t += '================================\n';

  // Date
  const parts = data.date.split('-');
  const dateFormatted = parts[2] + '.' + parts[1] + '.' + parts[0];
  t += 'Datum: ' + dateFormatted + '\n';
  t += '\n';

  // TRZBA section — FISKÁLNA tržba (z payments). Shisha je samostatne nižšie.
  t += CMD.BOLD_ON;
  t += 'TRZBA (FISKAL)\n';
  t += CMD.BOLD_OFF;
  t += CMD.LINE;
  t += CMD.ALIGN_LEFT;
  t += padLine('Celkom:', formatEur(data.fiscalRevenue !== undefined ? data.fiscalRevenue : data.totalRevenue) + ' EUR') + '\n';
  (data.paymentMethods || []).forEach(pm => {
    const m = s(pm.method);
    const label = m.charAt(0).toUpperCase() + m.slice(1) + ':';
    t += padLine(label, formatEur(pm.total) + ' EUR') + '\n';
  });
  t += CMD.LINE;

  // SHISHA section — samostatne, off-fiscal. Cash zo shisha sa zúčtuje
  // mimo Portos uzávierky, operátor podľa tejto sekcie spočíta drawer.
  if (data.shisha && data.shisha.count > 0) {
    t += '\n';
    t += CMD.BOLD_ON;
    t += 'SHISHA (mimo fiskal)\n';
    t += CMD.BOLD_OFF;
    t += CMD.LINE;
    t += padLine('Predaje:', data.shisha.count + 'x') + '\n';
    t += padLine('Hotovost:', formatEur(data.shisha.revenue) + ' EUR') + '\n';
    t += CMD.LINE;
    t += '\n';
    t += CMD.BOLD_ON;
    t += padLine('SPOLU V ZASUVKE:',
      formatEur(
        ((data.paymentMethods || []).find(pm => {
          const m = String(pm.method || '').toLowerCase();
          return m === 'hotovost' || m === 'cash';
        })?.total || 0) + (Number(data.shisha.revenue) || 0)
      ) + ' EUR'
    ) + '\n';
    t += CMD.BOLD_OFF;
    t += CMD.LINE;
  }

  // OBJEDNAVKY section
  t += '\n';
  t += CMD.BOLD_ON;
  t += 'OBJEDNAVKY\n';
  t += CMD.BOLD_OFF;
  t += padLine('Pocet:', String(data.totalOrders)) + '\n';
  t += padLine('Poloziek:', String(data.totalItems)) + '\n';
  t += padLine('Priemerna obj.:', formatEur(data.averageOrder) + ' EUR') + '\n';
  if (data.cancelledItems > 0) {
    t += padLine('Storna:', data.cancelledItems + ' (-' + formatEur(data.cancelledTotal) + ' EUR)') + '\n';
  } else {
    t += padLine('Storna:', '0') + '\n';
  }

  // KATEGORIE section
  t += '\n';
  t += CMD.BOLD_ON;
  t += 'KATEGORIE\n';
  t += CMD.BOLD_OFF;
  t += CMD.LINE;
  (data.categoryBreakdown || []).forEach(cat => {
    const right = formatEur(cat.total) + ' EUR ' + cat.count + 'x';
    t += padLine(s(cat.category), right) + '\n';
  });

  // TOP POLOZKY section
  t += '\n';
  t += CMD.BOLD_ON;
  t += 'TOP POLOZKY\n';
  t += CMD.BOLD_OFF;
  t += CMD.LINE;
  (data.topItems || []).forEach((item, i) => {
    const rank = (i + 1) + '. ';
    t += padLine(rank + s(item.name), item.qty + 'x') + '\n';
  });

  // Footer
  t += '\n';
  t += CMD.ALIGN_CENTER;
  t += CMD.BOLD_ON;
  t += '================================\n';
  t += 'UZAVIERKA DOKONCENA\n';
  const now = new Date();
  const time = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  t += time + '\n';
  t += '================================\n';
  t += CMD.BOLD_OFF;
  t += CMD.FEED;
  t += CMD.CUT;

  return t;
}

export function buildLockCodeTicket({ code, validUntil, staffName, time }) {
  let t = '';
  t += CMD.INIT;

  // Top border
  t += CMD.ALIGN_CENTER;
  t += CMD.BOLD_ON;
  t += '================================\n';
  t += CMD.DOUBLE_SIZE;
  t += 'KOD ZAMKU\n';
  t += CMD.NORMAL_SIZE;
  t += '================================\n';
  t += CMD.BOLD_OFF;
  t += '\n';

  // Wake-up instruction — most customers don't realize the keypad has to be
  // tapped first to light up before they can enter the code.
  t += CMD.BOLD_ON;
  t += CMD.DOUBLE_SIZE;
  t += 'NAJPRV RAZNE\n';
  t += 'TUKNITE\n';
  t += 'NA DISPLEJ\n';
  t += 'ZAMKU !\n';
  t += CMD.NORMAL_SIZE;
  t += CMD.BOLD_OFF;
  t += '(displej sa rozsvieti,\n';
  t += ' az potom zadajte kod)\n';
  t += '\n';

  // Big code display — # appended as the WC keypad confirm key, so the customer
  // types the digits + # to unlock. Spaced for readability.
  t += CMD.BOLD_ON;
  t += CMD.DOUBLE_SIZE;
  const spaced = (code + '#').split('').join('  ');
  t += spaced + '\n';
  t += CMD.NORMAL_SIZE;
  t += CMD.BOLD_OFF;
  t += '\n';

  // Validity
  t += CMD.LINE;
  t += CMD.BOLD_ON;
  t += 'Platny do:\n';
  t += CMD.BOLD_OFF;
  t += s(validUntil) + '\n';
  t += CMD.LINE;

  // Footer info
  t += '\n';
  t += time + '  |  ' + s(staffName) + '\n';
  t += '\n';
  t += CMD.BOLD_ON;
  t += '================================\n';
  t += CMD.BOLD_OFF;

  // Closing-the-door reminder — many customers leave the door ajar after WC,
  // the auto-lock then doesn't engage and the next customer walks in on them.
  t += '\n';
  t += CMD.BOLD_ON;
  t += CMD.DOUBLE_SIZE;
  t += 'PROSIME\n';
  t += 'ZABUCHNUT\n';
  t += 'DVERE\n';
  t += CMD.NORMAL_SIZE;
  t += CMD.BOLD_OFF;
  t += '(aby sa zamok\n';
  t += ' automaticky zamkol)\n';

  t += CMD.FEED;
  t += CMD.CUT;

  return t;
}
