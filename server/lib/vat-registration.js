import { desc } from 'drizzle-orm';

import { db } from '../db/index.js';
import { companyProfiles } from '../db/schema.js';
import { isPortosEnabled } from './portos.js';
import { getPortosProfileSyncStats, runPortosProfileSync } from './portos-sync-job.js';

/**
 * Firma bez IČ DPH je neplatiteľ DPH. Portos pre takú firmu akceptuje iba riadky s `vatRate = 0`.
 * Profil sa synchronizuje z Portos identity (`icdph`), preto je tu source of truth.
 *
 * POZOR — `company_profiles` plní VÝHRADNE `runPortosProfileSync`. Kým sa sync ani raz
 * nepodaril, riadok v DB môže patriť inej firme / inému režimu DPH. Preto `getVatMode()`
 * vracia okrem `vatRegistered` aj `trusted` a volajúci na fiškálnych cestách si môžu
 * vypýtať `assertVatModeTrusted()` (fail-closed 503 namiesto tichého 0 % DPH).
 */

/** Očistí hodnotu zo .env — BOM aj úvodzovky by inak z „true" spravili niečo iné. */
function readEnvValue(name) {
  return String(process.env[name] ?? '')
    .trim()
    .replace(/^\uFEFF/, '')
    .replace(/^["']|["']$/g, '');
}

/** Očakávaný režim zo .env — chráni migračné okno (prepnutie na platiteľa DPH). */
function readExpectedVatRegistered() {
  const raw = readEnvValue('POS_VAT_REGISTERED');
  if (!raw) return null;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  return null;
}

// Aby WARN nespamoval log pri každej platbe — logujeme len pri zmene stavu.
let lastMismatchSignature = null;

/**
 * @returns {Promise<{
 *   vatRegistered: boolean,
 *   trusted: boolean,
 *   icDph: string,
 *   cashRegisterCode: string,
 *   mismatch: boolean,
 *   expectedVatRegistered: boolean|null,
 * }>}
 */
export async function getVatMode() {
  // ZÁMERNE bez try/catch: chyba DB sa už NEprehltáva (predtým `catch { return true }`
  // ticho vyhlásilo firmu za platiteľa). Fail-closed — nech chyba vybuble k volajúcemu.
  const [row] = await db
    .select()
    .from(companyProfiles)
    .orderBy(desc(companyProfiles.id))
    .limit(1);

  const icDph = String(row?.icDph || '').trim();
  const cashRegisterCode = String(row?.cashRegisterCode || '').trim();
  const vatRegistered = icDph.length > 0;

  const stats = getPortosProfileSyncStats();
  const trusted = stats.lastSyncAt !== null && !stats.lastError;

  const expectedVatRegistered = readExpectedVatRegistered();
  const mismatch = expectedVatRegistered !== null && expectedVatRegistered !== vatRegistered;

  const signature = `${expectedVatRegistered}|${vatRegistered}|${mismatch}`;
  if (mismatch && signature !== lastMismatchSignature) {
    console.warn(
      `[VAT] Rozpor režimu DPH: .env POS_VAT_REGISTERED=${expectedVatRegistered} ` +
      `ale company_profiles.ic_dph="${icDph}" → vatRegistered=${vatRegistered}. ` +
      'Skontroluj identitu v Portose alebo .env pred ďalšou fiškalizáciou.',
    );
  }
  if (signature !== lastMismatchSignature) lastMismatchSignature = signature;

  return { vatRegistered, trusted, icDph, cashRegisterCode, mismatch, expectedVatRegistered };
}

/** Spätne kompatibilný wrapper — pôvodná signatúra ostáva zachovaná. */
export async function isVatRegisteredBusiness() {
  const { vatRegistered } = await getVatMode();
  return vatRegistered;
}

/**
 * Režim je „potvrdený", keď ho okrem DB profilu tvrdí aj DRUHÝ nezávislý zdroj — `.env`.
 * Toto je zároveň poistka pre PRODUKČNÚ kasu (neplatiteľ DPH): s `POS_VAT_REGISTERED=false`
 * sa jej správanie NEZMENÍ ani vtedy, keď Portos profile sync zlyhá — 0 % je aj tak správne.
 * Bez `.env` hodnoty (alebo pri rozpore) ostáva gate fail-closed.
 */
function isEnvConfirmed(mode) {
  return mode.expectedVatRegistered !== null && !mode.mismatch;
}

/**
 * Slabšie, ale pre NÁHRADNÝ DOKLAD (§ 10) postačujúce potvrdenie režimu DPH.
 *
 * `assertVatModeTrusted()` je fail-closed: kým profil-sync v tomto behu ani raz
 * nedobehol, čaká na inline sync (5 s) a potom hodí 503. Pri paragóne je to
 * naopak, ako to má byť — paragón vzniká práve vtedy, keď Portos/eKasa nejde,
 * a čašník ho MUSÍ vedieť vystaviť.
 *
 * Dôvod, prečo je profil bez syncu podozrivý, je jediný: po zmene firmy alebo
 * pokladne môže riadok v `company_profiles` patriť NIEKOMU INÉMU. Presne to sa
 * dá vylúčiť aj bez Portosu — keď sa `cash_register_code` z profilu zhoduje
 * s `PORTOS_CASH_REGISTER_CODE` zo `.env`, profil patrí tejto pokladni, takže
 * jeho `ic_dph` (a teda režim DPH) je použiteľné okamžite.
 *
 * Rozpor s `POS_VAT_REGISTERED` skratku ruší — vtedy si dva zdroje odporujú
 * a stav je naozaj neoveriteľný (503 ostáva).
 *
 * ZÁMERNE sa číta holé `process.env.PORTOS_CASH_REGISTER_CODE`, nie
 * `getPortosConfig().cashRegisterCode` — ten pri chýbajúcom `.env` dopĺňa
 * zabudovaný default, ktorý by tu nebol druhým nezávislým zdrojom.
 */
export function isProfilePinnedToConfiguredCashRegister(mode) {
  if (!mode || mode.mismatch) return false;
  const envCode = readEnvValue('PORTOS_CASH_REGISTER_CODE');
  if (!envCode || !mode.cashRegisterCode) return false;
  return mode.cashRegisterCode === envCode;
}

/**
 * Fiškálny gate: režim DPH smie rozhodovať iba profil, ktorý bol v TOMTO behu naozaj
 * potvrdený z Portosu. Ak `trusted === false`, skúsi jeden inline sync (je dedupnutý
 * cez `syncInFlight`, takže je lacný) a profil prečíta znova.
 *
 * Neblokuje, keď:
 *   • `PORTOS_ENABLED=false` — nefiškalizuje sa, nie je čo overovať;
 *   • `.env POS_VAT_REGISTERED` sa zhoduje s DB profilom — režim potvrdil druhý zdroj.
 *
 * @throws {Error & { status: 503, code: 'VAT_MODE_UNTRUSTED', body: { error: string } }}
 * @returns {Promise<Awaited<ReturnType<typeof getVatMode>>>}
 */
export async function assertVatModeTrusted({ inlineSyncTimeoutMs = 5000 } = {}) {
  let mode = await getVatMode();

  // Bez Portosu sa nefiškalizuje — nemáme čo overovať a nesmieme nič blokovať.
  if (!isPortosEnabled()) return mode;
  if (mode.trusted) return mode;
  // Skratka PRED inline syncom, aby env-potvrdenej kase nepribudla ani latencia.
  if (isEnvConfirmed(mode)) return mode;

  try {
    await runPortosProfileSync({ timeoutMs: Number(inlineSyncTimeoutMs) || 5000 });
  } catch {
    /* dôvod je už zachytený v getPortosProfileSyncStats().lastError */
  }

  mode = await getVatMode();
  if (mode.trusted || isEnvConfirmed(mode)) return mode;

  const message = 'Nepodarilo sa overiť režim DPH z Portos — platbu nefiškalizujem';
  const error = new Error(message);
  error.status = 503;
  error.code = 'VAT_MODE_UNTRUSTED';
  error.body = { error: message };
  throw error;
}
