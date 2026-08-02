// server/routes/paragons.js
//
// Offline paragón flow — náhradný doklad pre eKasa (zákon § 10, č. 289/2008).
//
// Endpoints:
//   POST /api/paragons          → vystaviť paragón (Portos je nedostupný)
//   GET  /api/paragons          → list (default: pending; ?status=all|registered|failed)
//   POST /api/paragons/:id/retry → manuálny retry registrácie konkrétneho paragónu
//   POST /api/paragons/sync     → vynútený sync všetkých pending (admin button)
//
// Hookuje sa do payment-flow tak: keď POS detekuje že Portos je down,
// namiesto klasického fiškálneho payment-u vystaví paragón cez POST /api/paragons.
// Background worker (paragon-sync.js) potom registruje pending paragóny postupne.
//
// FIŠKÁLNE DÁTA SA NEBERÚ Z TELA REQUESTU. Prehliadač sadzbu DPH nepozná
// (položky vo web POS pole `vatRate` vôbec nemajú) a pri zľave neposiela ani
// `discountAmount` — kým bola firma neplatiteľ, `forceZeroVat` tú nulu aj tak
// vynútil a chyba bola neviditeľná. Zdroj pravdy je preto rovnaký ako pri
// bežnej platbe: objednávka v DB (`loadOrderPaymentContext`).

import { Router } from 'express';
import { eq, sql, and, desc, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { offlineParagons, fiscalDocuments, menuItems } from '../db/schema.js';
import { requireRole } from '../middleware/requireRole.js';
import {
  registerParagon,
  isPortosEnabled,
  PortosTransportError,
} from '../lib/portos.js';
import {
  buildParagonRequestContext,
  generatePaymentExternalIdSalt,
} from '../lib/fiscal-payment.js';
import {
  assertVatModeTrusted,
  getVatMode,
  isProfilePinnedToConfiguredCashRegister,
} from '../lib/vat-registration.js';
import { getPortosProfileSyncStats } from '../lib/portos-sync-job.js';
import { getActiveCashRegisterCode } from '../lib/active-cash-register.js';
import { assertSupportedVatRates, isZeroVatAllowed } from '../lib/menu-vat.js';
import { loadOrderPaymentContext } from '../lib/payments/context.js';
import { buildTransportFailure, resolveFiscalAttempt } from '../lib/payments/fiscal-resolve.js';
import { STORNO_ELIGIBLE_MODES, roundMoney } from '../lib/payments/shared.js';

const router = Router();
const mgr = requireRole('manazer', 'admin');
const anyStaff = requireRole('cisnik', 'manazer', 'admin');

const MAX_ATTEMPTS = 100; // ~ pri 60s intervale = 100 minút aktívneho retry
const MIN_RETRY_INTERVAL_MS = 30_000; // anti-thundering-herd

// Sumy porovnávame na cent s malou rezervou na float aritmetiku — rovnaká
// tolerancia akú používa validateReceiptMatchesRequest (fiscal-payment.js).
const AMOUNT_TOLERANCE = 0.011;

// Fiškálne ÚSPEŠNÉ režimy. HTTP 202 → `offline_accepted` je legitímne prijatie
// do CHDÚ (Portos beží, spojenie na finančnú správu je dole), NIE zlyhanie.
// Rovnaká množina, akú používa platba (server/lib/payments/create.js
// SUCCESS_MODES) — znovupoužívame ju zo shared.js, nech sa nemôžu rozísť.
const FISCAL_SUCCESS_MODES = STORNO_ELIGIBLE_MODES;

/** Chyba s HTTP statusom + telom odpovede (rovnaký pattern ako menu-vat.js). */
function httpError(status, body) {
  const payload = typeof body === 'string' ? { error: body } : body;
  const error = new Error(payload.error);
  error.status = status;
  error.body = payload;
  return error;
}

/**
 * Generate next monotonic paragón number "P-000001" pre celý systém.
 *
 * KRITICKÉ: musí byť strict-monotonic bez medzier (zákon § 10).
 * Použijeme `SELECT FOR UPDATE` lock na max() z existujúcich + insert
 * v jednej transakcii. Drizzle nemá natívne `FOR UPDATE`, takže
 * použijeme raw SQL pre tento jeden query.
 */
async function nextParagonNumber(tx) {
  const result = await tx.execute(sql`
    SELECT COALESCE(MAX(CAST(SUBSTRING(paragon_number FROM 3) AS INTEGER)), 0) + 1 AS next_num
    FROM offline_paragons
  `);
  const nextNum = Number(result.rows[0]?.next_num || 1);
  return 'P-' + String(nextNum).padStart(6, '0');
}

/**
 * Objednávka zo servera — preferovaný zdroj fiškálnych riadkov. Nesie
 * `menu_items.vat_rate`, per-item zľavy aj order-level zľavu, presne tak ako
 * ich číta bežná platba (server/lib/payments/create.js).
 *
 * Vracia `null`, keď sa objednávka na paragón použiť nedá (nemá položky, alebo
 * sa jej suma rozchádza so sumou z kasy — vtedy kasa drží riadky, ktoré na
 * serveri ešte nie sú; Android vystavuje paragón aj z NEodoslaného košíka).
 */
async function resolveParagonLinesFromOrder(orderId, bodyTotalAmount) {
  const orderContext = await loadOrderPaymentContext(orderId);
  if (!orderContext) throw httpError(404, 'Objednávka nenájdená');
  if (!orderContext.items.length) return null;

  // Telo requestu už slúži IBA ako cross-check.
  if (Math.abs(orderContext.expectedTotal - Number(bodyTotalAmount)) > AMOUNT_TOLERANCE) {
    console.warn(
      `[Paragon] order=${orderId}: suma zo servera ${orderContext.expectedTotal} € ` +
      `≠ suma z kasy ${Number(bodyTotalAmount)} € — účet nie je zosynchronizovaný.`,
    );
    return null;
  }

  return {
    items: orderContext.items,
    // Order-level zľava zvlášť — per-item zľavy idú ako vlastné fiškálne
    // riadky z items[].discountAmount (inak by sa zdvojili).
    orderDiscountAmount: orderContext.orderDiscountAmount,
    expectedTotal: orderContext.expectedTotal,
    source: 'order',
    resolvedBy: { order: orderContext.items.length },
  };
}

/** Zľava riadku nesmie nikdy prevýšiť samotný riadok — inak by šiel základ do mínusu. */
function capLineDiscount(line) {
  const lineGross = roundMoney(line.price * line.qty);
  return { ...line, discountAmount: Math.min(line.discountAmount, Math.max(0, lineGross)) };
}

/** Normalizácia riadkov z tela requestu (bez akéhokoľvek tichého `|| 0` na sadzbe). */
function normalizeBodyLines(bodyItems) {
  return bodyItems.map((item, index) => {
    const qty = Number(item?.qty);
    const price = Number(item?.price);
    const menuItemId = Number(item?.menuItemId);
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price)) {
      throw httpError(400, `Neplatná položka paragónu na pozícii ${index + 1} (${item?.name || 'bez názvu'})`);
    }
    // POZOR: `Number(null)` je 0. Klient posiela `vatRate: null`, keď sadzbu nevie —
    // nula by tu bola tichá lož presne toho druhu, ktorú nález [20] rieši.
    const rawVatRate = item?.vatRate == null ? NaN : Number(item.vatRate);
    return {
      name: item?.name || 'Polozka',
      qty,
      price,
      note: item?.note || '',
      menuItemId: Number.isFinite(menuItemId) ? menuItemId : null,
      // Per-item zľava z kasy. Bez nej by sa súčet riadkov rozišiel so sumou
      // platby o celú zľavu a paragón by sa nezaregistroval (nález [29]).
      // Clampuje sa až po prípadnom prepísaní ceny z menu.
      discountAmount: Math.max(0, roundMoney(Number(item?.discountAmount) || 0)),
      vatRate: Number.isFinite(rawVatRate) ? rawVatRate : null,
    };
  });
}

/** Voľnejšia zhoda názvu: TRIM + case-insensitive v slovenskom locale. */
function normalizeMenuName(value) {
  return String(value ?? '').trim().toLocaleLowerCase('sk-SK');
}

function pushToBucket(map, key, row) {
  const bucket = map.get(key);
  if (bucket) bucket.push(row);
  else map.set(key, [row]);
}

/**
 * Kandidáti z menu pre daný názov. PRESNÁ zhoda má prednosť — voľnejšia
 * (TRIM + case-insensitive) sa použije, až keď presná nič nenájde.
 *
 * Ak je kandidátov viac a aspoň jeden je aktívny, archivované sa ignorujú:
 * stará položka s rovnakým názvom nesmie zablokovať náhradný doklad.
 */
function pickMenuCandidatesByName(exactByName, looseByName, name) {
  const exact = exactByName.get(String(name ?? '')) || [];
  const pool = exact.length ? exact : (looseByName.get(normalizeMenuName(name)) || []);
  if (pool.length <= 1) return pool;
  const active = pool.filter((row) => row.active);
  return active.length ? active : pool;
}

const MENU_LOOKUP_COLUMNS = {
  id: menuItems.id,
  name: menuItems.name,
  price: menuItems.price,
  vatRate: menuItems.vatRate,
  active: menuItems.active,
};

/**
 * Priradí každému riadku z tela requestu sadzbu DPH z `menu_items`.
 *
 * Poradie rozlíšenia (vetva (a) — objednávka zo servera — beží o úroveň vyššie):
 *   b) `menuItemId` — jednoznačné, prepíše aj názov a cenu z menu (stav dodnes);
 *   c) zhoda podľa NÁZVU — presná, potom TRIM + case-insensitive.
 *
 * Vetva (c) je tu kvôli Androidu, ktorý na produkčnej kase reálne beží (v3.3.0):
 * jeho `ParagonItem` pole `menuItemId` VÔBEC nemá (posiela `id` order-itemu,
 * názov, množstvo, cenu). Bez name-fallbacku by sa pri výpadku eKasy náhradný
 * doklad podľa § 10 nevystavil vôbec — presne vtedy, keď je najviac potrebný.
 *
 * Sadzba sa VŽDY berie z DB — nikdy z tela requestu a nikdy tichým `|| 0`.
 * Pri name-fallbacku sa cena z menu ZÁMERNE neprepisuje: zhoda podľa názvu je
 * slabší dôkaz totožnosti než ID a doklad musí niesť to, čo hosť reálne zaplatil.
 *
 * @returns {Promise<{ items: object[], resolvedBy: { menuItemId: number, menuName: number } }>}
 */
async function resolveLinesAgainstMenu(lines) {
  const ids = Array.from(new Set(lines.map((line) => line.menuItemId).filter((id) => id !== null)));
  const idRows = ids.length
    ? await db.select(MENU_LOOKUP_COLUMNS).from(menuItems).where(inArray(menuItems.id, ids))
    : [];
  const menuById = new Map(idRows.map((row) => [Number(row.id), row]));

  // Aj riadok S `menuItemId`, ktorý sa v menu nenašiel (položka medzitým zmizla),
  // smie skúsiť zhodu podľa názvu — inak by paragón padol zbytočne.
  const needsNameLookup = lines.some(
    (line) => line.menuItemId === null || !menuById.has(line.menuItemId),
  );
  // Menu má rádovo stovky riadkov — načítať ho celé je lacnejšie aj spoľahlivejšie
  // než porovnávať názvy v SQL (locale-závislé `lower()` / kolácie).
  const allRows = needsNameLookup ? await db.select(MENU_LOOKUP_COLUMNS).from(menuItems) : [];
  const exactByName = new Map();
  const looseByName = new Map();
  for (const row of allRows) {
    pushToBucket(exactByName, String(row.name), row);
    pushToBucket(looseByName, normalizeMenuName(row.name), row);
  }

  const unresolved = [];
  const ambiguous = [];
  const resolvedBy = { menuItemId: 0, menuName: 0 };

  const items = lines.map((line) => {
    const byId = line.menuItemId === null ? null : menuById.get(line.menuItemId);
    const idVatRate = byId ? Number(byId.vatRate) : NaN;
    if (byId && Number.isFinite(idVatRate)) {
      resolvedBy.menuItemId += 1;
      return capLineDiscount({
        ...line,
        name: byId.name,
        price: Number(byId.price),
        vatRate: idVatRate,
      });
    }

    const candidates = pickMenuCandidatesByName(exactByName, looseByName, line.name);
    const rates = Array.from(new Set(
      candidates.map((row) => Number(row.vatRate)).filter((rate) => Number.isFinite(rate)),
    )).sort((a, b) => a - b);

    if (rates.length === 0) {
      unresolved.push(line.name);
      return line;
    }
    if (rates.length > 1) {
      // Ten istý názov s RÔZNOU sadzbou → priradenie je nejednoznačné a
      // hádať sa tu nesmie: išlo by o zlú daň na fiškálnom doklade.
      ambiguous.push(`${line.name} (${rates.map((rate) => `${rate} %`).join(', ')})`);
      return line;
    }

    resolvedBy.menuName += 1;
    return capLineDiscount({ ...line, vatRate: rates[0] });
  });

  if (ambiguous.length) {
    throw httpError(400,
      'Paragón sa nedá vystaviť: názov položky je v menu viackrát s RÔZNOU sadzbou DPH — '
      + `${ambiguous.join('; ')}. Položku sa nedá jednoznačne priradiť — odošli účet na server `
      + '(nesie menuItemId) a skús to znova.');
  }
  if (unresolved.length) {
    throw httpError(400,
      'Paragón sa nedá vystaviť: pre položky ' + unresolved.join(', ') + ' sa nepodarilo určiť sadzbu DPH z menu. '
      + 'Odošli účet na server a skús to znova.');
  }

  return { items, resolvedBy };
}

/**
 * Fallback, keď objednávka na serveri nestačí (nesynchnutý košík alebo paragón
 * bez `orderId`).
 *
 * NEPLATITEĽ DPH: `forceZeroVat` aj tak prepíše každú sadzbu na 0, takže na
 * zdroji sadzby fiškálne nezáleží — snapshot z kasy sa berie tak ako doteraz.
 * Je to zámerné: na produkčnej kase (neplatiteľ) sa správanie tejto cesty
 * NESMIE zmeniť a doklad musí niesť všetko, čo hosť reálne dostal. Jediný
 * rozdiel oproti pôvodnému stavu nastane, keď kasa pošle `discountAmount` —
 * to staršie klienty vôbec neposielali a bez neho sa súčet riadkov rozchádzal
 * so sumou platby (nález [29]).
 *
 * PLATITEĽ DPH: klientskej sadzbe sa veriť nedá (kasa ju nepozná), takže sa
 * dohľadá v `menu_items` podľa `menuItemId`, a keď ho klient neposiela (Android
 * v3.3.0), podľa NÁZVU — viď `resolveLinesAgainstMenu`. Riadok, ktorý sa nedá
 * rozložiť, končí 400 — radšej hlasná chyba než zmrazený nulový payload.
 */
async function resolveParagonLinesFromBody({ bodyItems, bodyDiscountAmount, bodyTotalAmount, vatRegistered }) {
  const lines = normalizeBodyLines(bodyItems);
  const discountAmount = Math.max(0, roundMoney(Number(bodyDiscountAmount) || 0));

  if (!vatRegistered) {
    return {
      items: lines.map((line) => capLineDiscount({ ...line, vatRate: 0 })),
      // ZÁMERNE bez clampu a bez kontroly súčtu — presne ako doteraz, nech sa
      // produkčnej kase neplatiteľa nezmení ani jeden zmrazený payload.
      orderDiscountAmount: discountAmount,
      expectedTotal: roundMoney(Number(bodyTotalAmount)),
      source: 'client',
      resolvedBy: { client: lines.length },
    };
  }

  const { items: resolvedLines, resolvedBy } = await resolveLinesAgainstMenu(lines);

  const subtotal = roundMoney(resolvedLines.reduce((sum, line) => sum + roundMoney(line.price * line.qty), 0));
  // Per-item zľavy idú ako vlastné riadky; zľava na účet sa smie rozpočítať iba
  // na to, čo po nich zostalo (rovnaký clamp ako payments/context.js).
  const itemDiscountTotal = roundMoney(resolvedLines.reduce((sum, line) => sum + line.discountAmount, 0));
  const clampedDiscount = Math.min(discountAmount, Math.max(0, roundMoney(subtotal - itemDiscountTotal)));
  const expectedTotal = roundMoney(subtotal - itemDiscountTotal - clampedDiscount);

  if (Math.abs(expectedTotal - Number(bodyTotalAmount)) > AMOUNT_TOLERANCE) {
    throw httpError(400,
      `Súčet položiek (${expectedTotal.toFixed(2)} €) sa nezhoduje so sumou paragónu `
      + `(${Number(bodyTotalAmount).toFixed(2)} €). Účet nie je zosynchronizovaný — odošli ho na server a skús to znova.`);
  }

  return {
    items: resolvedLines,
    orderDiscountAmount: clampedDiscount,
    expectedTotal,
    source: 'menu',
    resolvedBy,
  };
}

/**
 * Fiškálna brána na režim DPH — paragónová verzia.
 *
 * `assertVatModeTrusted()` je fail-closed a považuje profil za nedôveryhodný aj
 * vtedy, keď POSLEDNÝ Portos sync zlyhal (`lastError`). Lenže presne to je stav,
 * v ktorom paragón vzniká — eKasa je dole. Slepé 503 by znamenalo, že pri výpadku
 * Portosu hosť nedostane ani náhradný doklad, čo je horšie než čokoľvek, čo táto
 * brána chráni.
 *
 * Blokujeme preto len vtedy, keď sa profil v TOMTO behu procesu NIKDY nepotvrdil
 * z Portosu (`lastSyncAt === null`) — vtedy môže riadok v `company_profiles`
 * patriť inej firme aj inému režimu DPH a zmrazili by sme neoverený doklad.
 * Presne toto predpisuje nález [17] bod 1 auditu.
 *
 * Pred tým ešte lacná skratka BEZ čakania: keď riadok v `company_profiles` patrí
 * TEJTO pokladni (kód sedí s `PORTOS_CASH_REGISTER_CODE`) a neodporuje
 * `POS_VAT_REGISTERED`, režim je použiteľný okamžite. Bez nej by po reštarte kasy
 * počas výpadku Portosu KAŽDÝ paragón najprv 5 s čakal na inline sync a potom
 * skončil 503 — teda náhradný doklad by nevznikol práve vtedy, keď eKasa nejde.
 * 503 ostáva pre naozaj neoveriteľný stav: prázdny/cudzí profil alebo rozpor
 * medzi `company_profiles` a `POS_VAT_REGISTERED`.
 */
async function resolveVatModeForParagon() {
  const pinnedMode = await getVatMode();
  if (pinnedMode.trusted || isProfilePinnedToConfiguredCashRegister(pinnedMode)) return pinnedMode;

  try {
    return await assertVatModeTrusted();
  } catch (err) {
    if (!err || err.code !== 'VAT_MODE_UNTRUSTED') throw err;

    const stats = getPortosProfileSyncStats();
    if (stats.lastSyncAt === null) throw err;

    console.warn(
      `[Paragon] Portos profile sync práve zlyháva (${stats.lastError || 'neznáma chyba'}) — `
      + `použijem naposledy potvrdený profil z ${stats.lastSyncAt}.`,
    );
    return getVatMode();
  }
}

/** Guard pre platiteľa DPH — rovnaký ako pri bežnej platbe + zákaz sadzby 0 %. */
function assertVatRatesForVatPayer(items, vatRegistered) {
  assertSupportedVatRates(items);

  // 0 % ostáva v SUPPORTED_VAT_RATES kvôli neplatiteľovi — pre platiteľa je chyba.
  if (isZeroVatAllowed(vatRegistered)) return;
  const zeroVatItems = items.filter((item) => Number(item.vatRate) === 0);
  if (!zeroVatItems.length) return;

  const itemList = zeroVatItems.map((item) => item.name).join(', ');
  const detail = 'Firma je platiteľ DPH — položka so sadzbou 0 % nie je platná. '
    + `Skontroluj sadzby v Admin → Menu: ${itemList}`;
  throw httpError(400, {
    error: detail,
    fiscal: { status: 'validation_error', errorDetail: detail },
  });
}

/**
 * POST /api/paragons
 *
 * Body:
 *   { orderId, paymentId?, items, paymentMethod, totalAmount, discountAmount?, reason? }
 *
 * Returns: { paragonId, paragonNumber, totalAmount, vatRegistered, requestPayloadJson }
 *
 * Vystaví paragón LOKÁLNE (žiadne volanie Portos teraz — predpokladá sa že je
 * nedostupný). Status='pending'. Background sync ho dohne po obnove.
 */
router.post('/', anyStaff, async (req, res) => {
  try {
    const {
      orderId,
      paymentId,
      items,
      paymentMethod,
      totalAmount,
      discountAmount = 0,
      reason = 'portos_unavailable',
    } = req.body || {};

    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'Žiadne položky' });
    }
    if (!paymentMethod) {
      return res.status(400).json({ error: 'Chýba spôsob platby' });
    }
    if (totalAmount == null) {
      return res.status(400).json({ error: 'Chýba suma' });
    }
    if (!Number.isFinite(Number(totalAmount))) {
      return res.status(400).json({ error: 'Neplatná suma' });
    }

    // Režim DPH musí byť overený EŠTE PRED zmrazením payloadu — paragón sa
    // registruje až o hodiny neskôr a payload sa už neprepočítava. Bez tejto
    // brány by sa po reštarte kasy (Portos profile sync ešte nedobehol) zmrazil
    // starý kód pokladne aj 0 % DPH a doklad by ostal navždy neregistrovateľný.
    let vatMode;
    try {
      vatMode = await resolveVatModeForParagon();
    } catch (err) {
      if (err && err.code === 'VAT_MODE_UNTRUSTED') {
        return res.status(err.status).json({
          error: 'Nepodarilo sa overiť režim DPH z Portos — paragón nevystavujem, '
            + 'doklad by sa nedal zaregistrovať v eKase.',
        });
      }
      throw err;
    }

    const resolved = (orderId != null && await resolveParagonLinesFromOrder(orderId, totalAmount))
      || await resolveParagonLinesFromBody({
        bodyItems: items,
        bodyDiscountAmount: discountAmount,
        bodyTotalAmount: totalAmount,
        vatRegistered: vatMode.vatRegistered,
      });

    // V prevádzke musí byť VIDNO, ktorá vetva rozlíšenia položiek sa použila —
    // name-fallback znamená, že klient neposlal `menuItemId` (Android v3.3.0).
    if (resolved.resolvedBy?.menuName) {
      console.warn(
        `[Paragon] name-fallback: ${resolved.resolvedBy.menuName}/${resolved.items.length} položiek `
        + 'rozlíšených podľa NÁZVU z menu (klient neposlal menuItemId — typicky Android v3.3.0). '
        + 'Sadzby DPH sú z menu_items.',
      );
    }

    if (vatMode.vatRegistered) {
      assertVatRatesForVatPayer(resolved.items, vatMode.vatRegistered);
    }

    const cashRegisterCode = await getActiveCashRegisterCode();
    const externalIdSalt = generatePaymentExternalIdSalt();

    // Atomicky alokuj poradové číslo + vlož snapshot
    const inserted = await db.transaction(async (tx) => {
      const paragonNumber = await nextParagonNumber(tx);
      // issuedAt = TERAZ — moment kedy čašník vystavil náhradný doklad
      // pre zákazníka. Tento timestamp ide do Portos payloadu ako issueDate
      // a zostane konzistentný aj počas neskorších sync retries (Portos
      // tomu hovorí "spätná registrácia").
      const issuedAt = new Date();

      const ctx = buildParagonRequestContext({
        paragonNumber,
        issuedAt,
        items: resolved.items,
        discountAmount: resolved.orderDiscountAmount,
        method: paymentMethod,
        expectedTotal: resolved.expectedTotal,
        cashRegisterCode,
        forceZeroVat: !vatMode.vatRegistered,
        externalIdSalt,
      });

      const [row] = await tx
        .insert(offlineParagons)
        .values({
          orderId: orderId || null,
          paymentId: paymentId || null,
          paragonNumber,
          requestPayloadJson: JSON.stringify(ctx),
          totalAmount: String(resolved.expectedTotal.toFixed(2)),
          paymentMethod,
          status: 'pending',
          reason,
          staffId: req.user?.id || null,
        })
        .returning();
      return row;
    });

    return res.json({
      ok: true,
      paragonId: inserted.id,
      paragonNumber: inserted.paragonNumber,
      // Serverom vyriešená suma + režim DPH — klient z toho vie vytlačiť
      // doklad, ktorý sedí s tým, čo sa neskôr zaregistruje v eKase.
      totalAmount: resolved.expectedTotal,
      vatRegistered: vatMode.vatRegistered,
      // Diagnostika pre prevádzku: odkiaľ sa vzali fiškálne riadky a sadzby.
      // 'order' = z objednávky na serveri, 'menu' = z menu_items podľa
      // menuItemId/názvu, 'client' = snapshot z kasy (iba neplatiteľ DPH).
      itemSource: resolved.source,
      itemsResolvedBy: resolved.resolvedBy,
      requestPayloadJson: inserted.requestPayloadJson,
    });
  } catch (err) {
    if (err && err.status) {
      return res.status(err.status).json(err.body || { error: err.message });
    }
    console.error('POST /api/paragons error:', err);
    return res.status(500).json({ error: err.message || 'Vystavenie paragónu zlyhalo' });
  }
});

/**
 * GET /api/paragons?status=pending|registered|failed|all
 *
 * Vracia zoznam paragónov pre admin / kontrolu.
 */
router.get('/', anyStaff, async (req, res) => {
  try {
    const status = String(req.query.status || 'pending').toLowerCase();
    const baseQuery = db
      .select()
      .from(offlineParagons)
      .orderBy(desc(offlineParagons.issuedAt))
      .limit(200);

    const rows = status === 'all'
      ? await baseQuery
      : await db
          .select()
          .from(offlineParagons)
          .where(eq(offlineParagons.status, status))
          .orderBy(desc(offlineParagons.issuedAt))
          .limit(200);

    return res.json({ paragons: rows });
  } catch (err) {
    console.error('GET /api/paragons error:', err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/paragons/:id/retry
 *
 * Manuálny retry registrácie konkrétneho paragónu. Použiteľné pre admina
 * keď background sync hovori "failed" a treba forsírovať.
 */
router.post('/:id/retry', mgr, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Neplatné ID' });
  try {
    const result = await registerOneParagon(id);
    return res.json(result);
  } catch (err) {
    console.error('POST /api/paragons/:id/retry error:', err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/paragons/sync
 *
 * Vynútený sync všetkých pending paragónov. Manuálny trigger pre prípad
 * že background worker nestiha alebo bol vypnutý.
 */
router.post('/sync', mgr, async (req, res) => {
  try {
    const result = await syncPendingParagons();
    return res.json(result);
  } catch (err) {
    console.error('POST /api/paragons/sync error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ─── Sync helpers (used by background worker too) ──────────────────────────

/**
 * Vytiahne salt z paragónového externalId `paragon-<číslo>-<salt>`.
 * Legacy tvar bez saltu vracia null — `buildParagonExternalId` ho vtedy
 * zopakuje presne tak, ako bol zmrazený.
 */
function parseParagonExternalIdSalt(externalId, paragonNumber) {
  const prefix = `paragon-${paragonNumber}-`;
  const value = String(externalId || '');
  return value.startsWith(prefix) && value.length > prefix.length ? value.slice(prefix.length) : null;
}

/**
 * Záchrana už zmrazených paragónov.
 *
 * Payload sa zmrazí v momente vystavenia. Ak vtedy ešte nebol dobehnutý Portos
 * profile sync (reštart kasy) alebo firma medzitým prešla na platiteľa DPH,
 * nesie STARÝ kód pokladne, resp. STARÝ režim DPH — taký doklad eKasa nikdy
 * neprijme a paragón po 100 pokusoch skončí ako 'failed'. Pred registráciou
 * preto payload porovnáme s aktuálnym stavom a pri nezhode ho prebudujeme.
 * `paragonNumber`, `issuedAt` aj salt v externalId ostávajú — inak by vznikol
 * druhý doklad na to isté poradové číslo.
 *
 * Na kase NEPLATITEĽA je to no-op: kód pokladne sedí a zmrazené sadzby sú 0 %,
 * čo je pre neplatiteľa správne → funkcia vráti payload nezmenený.
 *
 * @returns {Promise<{ payload: object, changed: boolean, reason?: string }
 *   | { blocked: string, fail?: boolean, message: string }>}
 */
async function reconcileFrozenParagonPayload(paragon, requestPayload) {
  const data = requestPayload?.request?.data;
  const frozenItems = Array.isArray(data?.items) ? data.items : [];
  if (!data || !frozenItems.length) {
    return {
      blocked: 'invalid_payload',
      fail: true,
      message: 'Zmrazený payload nemá fiškálne položky — paragón sa nedá zaregistrovať, treba manuálny zásah.',
    };
  }

  const frozenCashRegisterCode = String(data.cashRegisterCode || '').trim();
  const frozenZeroVat = frozenItems.every((item) => Number(item?.vatRate || 0) === 0);

  // Lacná kontrola bez blokovania — na neplatiteľskej kase končí vždy tu.
  const mode = await getVatMode();
  const activeCashRegisterCode = await getActiveCashRegisterCode();
  const codeMismatch = Boolean(activeCashRegisterCode) && frozenCashRegisterCode !== activeCashRegisterCode;
  const vatMismatch = mode.vatRegistered === frozenZeroVat;
  if (!codeMismatch && !vatMismatch) return { payload: requestPayload, changed: false };

  // Prepisovať zmrazený fiškálny doklad smie iba OVERENÝ režim DPH — inak by
  // sme podľa nedôveryhodného profilu mohli pokaziť správny payload.
  let trustedMode;
  try {
    trustedMode = await resolveVatModeForParagon();
  } catch {
    return {
      blocked: 'vat_mode_untrusted',
      message: 'Zmrazený paragón nesedí s aktuálnou pokladňou/režimom DPH, '
        + 'ale režim DPH sa nedá overiť z Portos — registráciu odkladám.',
    };
  }

  // Po prípadnom inline synce sa stav mohol upresniť — vyhodnoť nezhodu znova.
  const codeNow = await getActiveCashRegisterCode();
  const codeMismatchNow = Boolean(codeNow) && frozenCashRegisterCode !== codeNow;
  const vatMismatchNow = trustedMode.vatRegistered === frozenZeroVat;
  if (!codeMismatchNow && !vatMismatchNow) return { payload: requestPayload, changed: false };

  const salt = parseParagonExternalIdSalt(requestPayload.request?.externalId, paragon.paragonNumber);
  const issuedAt = data.issueDate || paragon.issuedAt || new Date();
  const frozenTotal = Number(paragon.totalAmount);

  // a) Prebuduj z objednávky — jediný zdroj, ktorý pozná reálne sadzby DPH.
  //    Sumu porovnávame s tou, na ktorú bol paragón vystavený: ak sa účet
  //    medzitým zmenil, papier a eKasa doklad by sa rozišli.
  if (paragon.orderId != null) {
    const orderContext = await loadOrderPaymentContext(paragon.orderId);
    if (orderContext
      && orderContext.items.length
      && Math.abs(orderContext.expectedTotal - frozenTotal) <= AMOUNT_TOLERANCE) {
      const rebuilt = buildParagonRequestContext({
        paragonNumber: paragon.paragonNumber,
        issuedAt,
        items: orderContext.items,
        discountAmount: orderContext.orderDiscountAmount,
        method: paragon.paymentMethod,
        expectedTotal: orderContext.expectedTotal,
        cashRegisterCode: codeNow || frozenCashRegisterCode,
        forceZeroVat: !trustedMode.vatRegistered,
        externalIdSalt: salt || undefined,
      });
      rebuilt.print.printerName = rebuilt.print.printerName || requestPayload.print?.printerName || null;
      return {
        payload: rebuilt,
        changed: true,
        reason: `prebudované z objednávky #${paragon.orderId} (kód pokladne ${codeNow}, `
          + `DPH režim ${trustedMode.vatRegistered ? 'platiteľ' : 'neplatiteľ'})`,
      };
    }
  }

  // b) Nezhoda IBA v kóde pokladne — prepíš ho priamo, položky ostávajú.
  if (!vatMismatchNow) {
    return {
      payload: {
        ...requestPayload,
        request: {
          ...requestPayload.request,
          data: { ...data, cashRegisterCode: codeNow },
        },
      },
      changed: true,
      reason: `kód pokladne ${frozenCashRegisterCode || '(prázdny)'} → ${codeNow}`,
    };
  }

  // c) Nezhoda v režime DPH a objednávka nie je použiteľná. Smerom
  //    k NEPLATITEĽOVI sa to dá dorobiť deterministicky — 0 % na každý riadok.
  if (!trustedMode.vatRegistered) {
    return {
      payload: {
        ...requestPayload,
        request: {
          ...requestPayload.request,
          data: {
            ...data,
            cashRegisterCode: codeNow || frozenCashRegisterCode,
            items: frozenItems.map((item) => ({ ...item, vatRate: 0 })),
          },
        },
      },
      changed: true,
      reason: 'režim neplatiteľa DPH — sadzby prepísané na 0 %',
    };
  }

  // d) Platiteľ DPH + zmrazené nuly + nedohľadateľná objednávka. Radšej hlasné
  //    zlyhanie než zaregistrovať doklad s nulovou daňou.
  return {
    blocked: 'vat_unresolvable',
    fail: true,
    message: 'Paragón bol vystavený v režime neplatiteľa DPH (0 %), firma je teraz platiteľ DPH. '
      + 'Sadzby sa nedajú dohľadať (objednávka chýba alebo sa jej suma zmenila) — vyžaduje manuálny zásah.',
  };
}

/**
 * Pokúsi sa zaregistrovať konkrétny paragón cez Portos.
 * Pri úspechu: status='registered', vytvorí fiscal_documents záznam.
 * Pri zlyhaní: status zostáva 'pending', increment attempts + lastError.
 */
export async function registerOneParagon(paragonId) {
  if (!isPortosEnabled()) {
    return { ok: false, skipped: true, reason: 'portos_disabled' };
  }

  const [paragon] = await db
    .select()
    .from(offlineParagons)
    .where(eq(offlineParagons.id, paragonId))
    .limit(1);
  if (!paragon) return { ok: false, reason: 'not_found' };
  if (paragon.status === 'registered') {
    return { ok: true, alreadyRegistered: true };
  }

  let requestPayload;
  try {
    requestPayload = JSON.parse(paragon.requestPayloadJson);
  } catch (e) {
    await db
      .update(offlineParagons)
      .set({
        status: 'failed',
        lastError: 'Invalid request payload JSON: ' + e.message,
        lastAttemptAt: new Date(),
      })
      .where(eq(offlineParagons.id, paragonId));
    return { ok: false, reason: 'invalid_payload' };
  }

  // Zmrazený payload musí sedieť s aktuálnou pokladňou a režimom DPH — inak ho
  // prebuduj (alebo registráciu vôbec nespúšťaj). ZÁMERNE pred inkrementom
  // attempts, aby infraštruktúrny problém nespálil pokusy voči MAX_ATTEMPTS.
  let reconciled;
  try {
    reconciled = await reconcileFrozenParagonPayload(paragon, requestPayload);
  } catch (err) {
    await db
      .update(offlineParagons)
      .set({
        lastError: 'Kontrola zmrazeného payloadu zlyhala: ' + (err.message || ''),
        lastAttemptAt: new Date(),
      })
      .where(eq(offlineParagons.id, paragonId));
    return { ok: false, reason: 'payload_check_failed', message: err.message };
  }

  if (reconciled.blocked) {
    console.warn(`[Paragon] ${paragon.paragonNumber}: ${reconciled.message}`);
    await db
      .update(offlineParagons)
      .set({
        ...(reconciled.fail ? { status: 'failed' } : {}),
        lastError: reconciled.message,
        lastAttemptAt: new Date(),
      })
      .where(eq(offlineParagons.id, paragonId));
    return { ok: false, reason: reconciled.blocked, message: reconciled.message };
  }

  if (reconciled.changed) {
    requestPayload = reconciled.payload;
    await db
      .update(offlineParagons)
      .set({ requestPayloadJson: JSON.stringify(requestPayload) })
      .where(eq(offlineParagons.id, paragonId));
    console.warn(`[Paragon] ${paragon.paragonNumber}: zmrazený payload prestavený — ${reconciled.reason}`);
  }

  // Incrementuj attempts pred volaním (aj keď request zlyhá v transport vrstve)
  await db
    .update(offlineParagons)
    .set({
      attempts: sql`${offlineParagons.attempts} + 1`,
      lastAttemptAt: new Date(),
    })
    .where(eq(offlineParagons.id, paragonId));

  let portosResult;
  try {
    const initialOutcome = await registerParagon(requestPayload);
    // Rovnako ako platba (create.js) — ambiguous/5xx sa dohľadá cez externalId,
    // nech sa ten istý paragón neposiela naslepo 100×.
    portosResult = await resolveFiscalAttempt({ requestPayload, initialOutcome });
  } catch (err) {
    const transport = err instanceof PortosTransportError;
    if (!transport) console.error('[Paragon] Neočakávaná chyba pri registrácii:', err);

    // Transport chyba je AMBIGUÓZNA — doklad mohol v CHDÚ vzniknúť. Skús ho
    // dohľadať cez externalId; ak sa nenájde, ostáva pending ako doteraz.
    let recovered = null;
    try {
      recovered = await resolveFiscalAttempt({
        requestPayload,
        initialOutcome: buildTransportFailure(requestPayload, err instanceof Error ? err : new Error(String(err))),
      });
    } catch {
      recovered = null;
    }

    if (!recovered || !FISCAL_SUCCESS_MODES.has(recovered.resultMode)) {
      await db
        .update(offlineParagons)
        .set({
          lastError: (transport ? 'transport: ' : 'unexpected: ') + (err.message || ''),
        })
        .where(eq(offlineParagons.id, paragonId));
      return { ok: false, reason: 'transport_error', message: err.message };
    }
    portosResult = recovered;
  }

  if (!FISCAL_SUCCESS_MODES.has(portosResult.resultMode)) {
    // Portos neúspech: 4xx, 5xx, validation_error, blocked, ambiguous
    await db
      .update(offlineParagons)
      .set({
        lastError: `Portos: ${portosResult.resultMode} ${portosResult.errorCode || ''} ${portosResult.errorDetail || ''}`.trim(),
      })
      .where(eq(offlineParagons.id, paragonId));

    // Po MAX_ATTEMPTS označ ako 'failed' (manuálny review)
    if ((paragon.attempts || 0) + 1 >= MAX_ATTEMPTS) {
      await db
        .update(offlineParagons)
        .set({ status: 'failed' })
        .where(eq(offlineParagons.id, paragonId));
    }
    return { ok: false, reason: 'portos_error', portosResult };
  }

  // Úspech: zaznamenaj fiscal_document + linkni cez fiscalDocumentId.
  // Pri `offline_accepted` (HTTP 202) ostáva isSuccessful null a receiptId
  // môže chýbať — stĺpce to povoľujú, doklad je v CHDÚ a FS ho dostane neskôr.
  const [fd] = await db
    .insert(fiscalDocuments)
    .values({
      sourceType: 'paragon',
      sourceId: paragonId,
      orderId: paragon.orderId,
      paymentId: paragon.paymentId,
      externalId: requestPayload.request.externalId,
      cashRegisterCode: requestPayload.request.data.cashRegisterCode || '',
      requestType: 'paragon',
      httpStatus: portosResult.httpStatus,
      resultMode: portosResult.resultMode,
      isSuccessful: portosResult.isSuccessful,
      receiptId: portosResult.receiptId,
      receiptNumber: portosResult.receiptNumber,
      okp: portosResult.okp,
      portosRequestId: portosResult.portosRequestId,
      printerName: requestPayload.print?.printerName || null,
      processDate: portosResult.processDate ? new Date(portosResult.processDate) : null,
      requestJson: portosResult.requestJson,
      responseJson: portosResult.responseJson,
      errorCode: portosResult.errorCode,
      errorDetail: portosResult.errorDetail || '',
    })
    .returning({ id: fiscalDocuments.id });

  await db
    .update(offlineParagons)
    .set({
      status: 'registered',
      registeredAt: new Date(),
      fiscalDocumentId: fd.id,
      lastError: null,
    })
    .where(eq(offlineParagons.id, paragonId));

  return { ok: true, paragonId, fiscalDocumentId: fd.id, receiptId: portosResult.receiptId };
}

/**
 * Sync všetkých pending paragónov (s rate limit voči thundering herd
 * pri prvom obnovení Portos).
 */
export async function syncPendingParagons() {
  if (!isPortosEnabled()) return { ok: false, reason: 'portos_disabled' };

  // Iba paragóny ktoré sú aspoň MIN_RETRY_INTERVAL_MS staré (od posledného pokusu)
  // alebo nemali pokus.
  const cutoff = new Date(Date.now() - MIN_RETRY_INTERVAL_MS);
  const pending = await db
    .select({ id: offlineParagons.id })
    .from(offlineParagons)
    .where(
      and(
        eq(offlineParagons.status, 'pending'),
        sql`(${offlineParagons.lastAttemptAt} IS NULL OR ${offlineParagons.lastAttemptAt} < ${cutoff})`,
      ),
    )
    .orderBy(offlineParagons.issuedAt)
    .limit(50);

  const results = { total: pending.length, registered: 0, failed: 0, errors: [] };
  for (const p of pending) {
    try {
      const r = await registerOneParagon(p.id);
      if (r.ok) results.registered++;
      else { results.failed++; if (r.reason) results.errors.push({ id: p.id, reason: r.reason, message: r.message || r.portosResult?.errorDetail }); }
    } catch (err) {
      results.failed++;
      results.errors.push({ id: p.id, error: err.message });
    }
  }
  return results;
}

export default router;
