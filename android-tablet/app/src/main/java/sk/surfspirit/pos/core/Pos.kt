package sk.surfspirit.pos.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import retrofit2.HttpException
import sk.surfspirit.pos.net.CategoryDto
import sk.surfspirit.pos.net.MarkedItemDto
import sk.surfspirit.pos.net.MenuItemDto
import sk.surfspirit.pos.net.PayResp
import sk.surfspirit.pos.net.PrintItem
import java.time.LocalDate
import java.text.Collator
import java.util.Locale
import kotlin.math.pow
import kotlin.math.roundToInt

/** "12.5" → "12,50 €" (slovenský formát s čiarkou). */
fun money(v: Double): String = String.format("%.2f €", v).replace('.', ',')

/** Dnešný dátum YYYY-MM-DD pre z-report. */
fun todayIso(): String = LocalDate.now().toString()

/** Je prihlásený používateľ manažér/admin? (rozhoduje o manager-PIN bránach) */
val isManager: Boolean get() = AppPrefs.role == "manazer" || AppPrefs.role == "admin"

private val ERR_RE = Regex("\"error\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"")

private val lenientJson = Json { ignoreUnknownKeys = true; isLenient = true }

/** Surové telo HTTP error odpovede (alebo null). */
fun Throwable.errorBody(): String? =
    (this as? HttpException)?.let {
        try { it.response()?.errorBody()?.string() } catch (_: Exception) { null }
    }

/** Telo error odpovede ako JsonObject (alebo null ak sa nedá parsovať). */
fun parseErrorJson(raw: String?): JsonObject? {
    if (raw.isNullOrBlank()) return null
    return try { lenientJson.parseToJsonElement(raw).jsonObject } catch (_: Exception) { null }
}

/** Bezpečný string field z JsonObject (null pre objekt/pole/JSON null). */
fun JsonObject.str(key: String): String? =
    (this[key] as? JsonPrimitive)?.let { p ->
        try { if (p.isString || p.content != "null") p.content else null } catch (_: Exception) { null }
    }

/**
 * Ľudská hláška z výnimky. Pre HTTP chyby vytiahne `{error}` z tela odpovede,
 * inak vráti message výnimky. Rozozná typické HTTP kódy.
 */
fun errorMessage(e: Throwable): String {
    if (e is HttpException) {
        val code = e.code()
        val raw = e.errorBody()
        val parsed = raw?.let { ERR_RE.find(it)?.groupValues?.getOrNull(1)?.replace("\\\"", "\"") }
        if (!parsed.isNullOrBlank()) return parsed
        return when (code) {
            401 -> "Neoprávnený prístup."
            403 -> "Túto akciu môže vykonať len manažér."
            404 -> "Položka sa nenašla."
            409 -> "Objednávka bola medzitým zmenená."
            422 -> "Prekročený limit."
            429 -> "Príliš veľa pokusov, skús neskôr."
            else -> "Chyba servera ($code)."
        }
    }
    return e.message ?: "Neznáma chyba."
}

/** True ak HTTP výnimka má daný status kód. */
fun Throwable.httpCode(): Int? = (this as? HttpException)?.code()

/** Je to transport chyba (server nedostupný / offline)? — nie HTTP odpoveď. */
fun Throwable.isTransportError(): Boolean = this !is HttpException

/**
 * Timeout = request MOŽNO došiel a server ho MOŽNO dokončil (pomalý Portos) —
 * NIKDY naň neponúkaj paragón, hrozil by dvojitý doklad za jeden predaj.
 */
fun Throwable.isTimeout(): Boolean =
    this is java.net.SocketTimeoutException || cause is java.net.SocketTimeoutException

/** Connect-level zlyhanie — request preukázateľne NIKDY neodišiel na server. */
fun Throwable.isConnectFailure(): Boolean =
    this is java.net.ConnectException || this is java.net.UnknownHostException ||
    cause is java.net.ConnectException || cause is java.net.UnknownHostException

/* ===================== Fiškálny outcome (web parita) ===================== */

/**
 * Výsledok platby normalizovaný do cashier-facing stavov — zrkadlí
 * normalizeFiscalOutcome v js/pos-payments.js. kind:
 *   success | offline_accepted | no_fiscal | ambiguous | blocked | conflict
 * Pri blocked/ambiguous treba ponúknuť paragón fallback (žiadny retry!).
 */
data class FiscalOutcome(
    val kind: String,
    val tone: String,          // success | warning | error
    val message: String,
    val title: String? = null,
)

private val AMBIG_RE = Regex("ambiguous|reconcil|overit|overenie", RegexOption.IGNORE_CASE)
private val BLOCKED_RE = Regex("blocked|rejected|denied|invalid|zablok", RegexOption.IGNORE_CASE)

fun normalizeFiscalOutcome(resp: PayResp?, err: Throwable?): FiscalOutcome {
    // HTTP chyby — telo môže niesť fiscal payload (Portos detail).
    if (err != null) {
        val code = err.httpCode()
        if (err.isTransportError()) {
            return FiscalOutcome("blocked", "error",
                "Pripojenie nie je dostupné — platbu nie je možné dokončiť offline.")
        }
        if (code == 409) {
            return FiscalOutcome("conflict", "error", "Objednávka sa zmenila, skús to prosím znovu.")
        }
        val body = parseErrorJson(err.errorBody())
        val fiscal = body?.get("fiscal")?.let { runCatching { it.jsonObject }.getOrNull() }
        val fiscalDetail = fiscal?.str("errorDetail") ?: fiscal?.str("message")
        val errMsg = body?.str("error")
        val fStatus = fiscal?.str("status")?.lowercase() ?: ""
        if (fStatus == "ambiguous" || fStatus == "unknown" || fStatus == "needs_reconciliation"
            || AMBIG_RE.containsMatchIn(fiscalDetail ?: "")) {
            return FiscalOutcome("ambiguous", "warning",
                "Stav fiškalizácie je nejasný. Neposielaj to hneď znovu.", "Platba čaká na overenie")
        }
        if (code == 400 || code == 403) {
            return FiscalOutcome("blocked", "error",
                fiscalDetail ?: errMsg ?: "Portos zablokoval fiškalizáciu.", "Platba zablokovaná")
        }
        return FiscalOutcome("blocked", "error",
            fiscalDetail ?: errMsg ?: errorMessage(err), "Platba zablokovaná")
    }

    val fiscal = resp?.fiscal
    val status = fiscal?.status?.lowercase() ?: ""
    val message = fiscal?.errorDetail ?: ""

    if (fiscal?.isSuccessful == true) {
        return FiscalOutcome("success", "success", "Platba úspešná. Fiškalizácia prebehla v Portose.")
    }
    when (status) {
        "online_success", "reconciled_online_success", "success", "ok", "registered", "done" ->
            return FiscalOutcome("success", "success", "Platba úspešná. Doklad je v eKase.")
        "offline_accepted", "accepted_offline", "queued", "offline", "reconciled_offline_accepted" ->
            return FiscalOutcome("offline_accepted", "warning",
                "Platba úspešná. Portos ju prijal offline a dokončí ju neskôr.")
        "disabled" ->
            return FiscalOutcome("no_fiscal", "warning",
                "Účet je zatvorený, ale fiškalizácia (Portos) je na serveri vypnutá — doklad sa nevytvoril.",
                "Platba bez eKasy")
        "ambiguous", "unknown", "needs_reconciliation" ->
            return FiscalOutcome("ambiguous", "warning",
                "Stav fiškalizácie je nejasný. Neposielaj to hneď znovu.", "Platba čaká na overenie")
    }
    if (AMBIG_RE.containsMatchIn(message)) {
        return FiscalOutcome("ambiguous", "warning",
            "Stav fiškalizácie je nejasný. Neposielaj to hneď znovu.", "Platba čaká na overenie")
    }
    if (status == "blocked" || status == "blocked_by_portos" || status == "rejected" || status == "denied"
        || BLOCKED_RE.containsMatchIn(message)) {
        return FiscalOutcome("blocked", "error",
            message.ifBlank { "Portos zablokoval fiškalizáciu." }, "Platba zablokovaná")
    }
    if (resp != null && (resp.payment != null || resp.alreadyProcessed) && fiscal == null) {
        return FiscalOutcome("no_fiscal", "warning",
            "Platba bola prijatá, ale server neposlal stav fiškalizácie. Skontroluj admin / logy backendu.",
            "Chyba odpovede")
    }
    return FiscalOutcome("success", "success", "Platba úspešná.")
}

/* ===================== Tlačové smerovanie ===================== */

/**
 * Cieľová tlačiareň položky — zhoda s web getItemDest:
 * item.destOverride > kategória.dest; "lístkové" položky (🔢) idú do kuchyne.
 * KRITICKÉ: syntetická kategória „Najčastejšie" (id=-1) sa preskakuje — inak
 * by bestseller jedlo zdedilo jej default dest="bar" a bon skončil na bare.
 */
fun itemDest(menuItemId: Int, emoji: String, categories: List<CategoryDto>): String {
    if (emoji.contains("🔢")) return "kuchyna"
    val real = categories.filter { it.id >= 0 }
    val cat = real.firstOrNull { c -> c.items.any { it.id == menuItemId } }
    val item = cat?.items?.firstOrNull { it.id == menuItemId }
    val dest = item?.destOverride ?: cat?.dest ?: "bar"
    return if (dest == "kuchyna") "kuchyna" else "bar"
}

/**
 * Identifikátor zákazníka — položka z kategórie 'cisla' (🔢 1..16).
 * Web parita: číslo ide IBA na kuchynský bon, a IBA ak je tam aj jedlo.
 */
fun isTicketNumberItem(menuItemId: Int, categories: List<CategoryDto>): Boolean {
    val cat = categories.firstOrNull { it.id >= 0 && it.slug == "cisla" } ?: return false
    return cat.items.any { it.id == menuItemId }
}

/**
 * Rozdelí odoslané položky podľa cieľa (kuchyňa/bar) na tlačové dávky.
 * Web parita (printKitchenAndBarTickets):
 *  - 🔢 čísla idú IBA na kuchynský bon, prependnuté na začiatok, a IBA ak
 *    kuchyňa má aj reálne jedlo (inak by sa tlačil prázdny bon s číslom);
 *  - bar dostane iba skutočné nápoje;
 *  - `storno` = záporné qty + "STORNO " prefix v dest.
 */
fun splitForPrint(
    items: List<MarkedItemDto>,
    categories: List<CategoryDto>,
    storno: Boolean = false,
): Map<String, List<PrintItem>> {
    val numberItems = items.filter { isTicketNumberItem(it.menuItemId, categories) }
    val realItems = items.filter { !isTicketNumberItem(it.menuItemId, categories) }
    val food = realItems.filter { itemDest(it.menuItemId, it.emoji, categories) == "kuchyna" }
    val drinks = realItems.filter { itemDest(it.menuItemId, it.emoji, categories) != "kuchyna" }

    fun toPrint(list: List<MarkedItemDto>): List<PrintItem> = list.map {
        PrintItem(qty = if (storno) -kotlin.math.abs(it.qty) else it.qty,
            name = it.name, note = it.note, emoji = it.emoji)
    }

    val groups = LinkedHashMap<String, List<PrintItem>>()
    val prefix = if (storno) "STORNO " else ""
    if (food.isNotEmpty()) {
        val kitchen = if (numberItems.isNotEmpty()) numberItems + food else food
        groups[prefix + "KUCHYNA"] = toPrint(kitchen)
    }
    if (drinks.isNotEmpty()) groups[prefix + "BAR"] = toPrint(drinks)
    return groups
}

/* ===================== Logické triedenie menu (web parita) ===================== */

private val VOL_DEC_RE = Regex("(\\d+)[,.](\\d+)\\s*l\\b", RegexOption.IGNORE_CASE)
private val VOL_L_RE = Regex("\\b(\\d+)\\s*l\\b", RegexOption.IGNORE_CASE)
private val VOL_G_RE = Regex("\\b(\\d+)\\s*g\\b", RegexOption.IGNORE_CASE)
private val VOL_ML_RE = Regex("\\b(\\d+)\\s*ml\\b", RegexOption.IGNORE_CASE)
private val COMBO_RE = Regex("^\\s*combo\\s+", RegexOption.IGNORE_CASE)
private val BURGER_SUFFIX_RE = Regex("\\s+burger\\s*$", RegexOption.IGNORE_CASE)

/** "Pivo 0,5 l" → 500; "200 g" → 200; null ak bez objemu. */
fun parseVolumeMl(name: String): Int? {
    VOL_DEC_RE.find(name)?.let { m ->
        val whole = m.groupValues[1].toInt()
        val frac = m.groupValues[2]
        return ((whole + frac.toInt() / 10.0.pow(frac.length)) * 1000).roundToInt()
    }
    VOL_L_RE.find(name)?.let { return it.groupValues[1].toInt() * 1000 }
    VOL_G_RE.find(name)?.let { return it.groupValues[1].toInt() }
    VOL_ML_RE.find(name)?.let { return it.groupValues[1].toInt() }
    return null
}

/** Názov bez objemu/Combo/burger sufixu — rovnaká rodina vedľa seba. */
fun familyName(name: String): String = name
    .replace(Regex("\\d+[,.]?\\d*\\s*l\\b", RegexOption.IGNORE_CASE), "")
    .replace(Regex("\\d+\\s*ml\\b", RegexOption.IGNORE_CASE), "")
    .replace(Regex("\\d+\\s*g\\b", RegexOption.IGNORE_CASE), "")
    .replace(COMBO_RE, "")
    .replace(BURGER_SUFFIX_RE, "")
    .trim()
    .replace(Regex("\\s+"), " ")
    .lowercase()

private val skCollator: Collator = Collator.getInstance(Locale("sk", "SK"))

/**
 * Web compareByMenuLogic: rodina (sk alpha; čisto číselné názvy numericky),
 * v rodine plain pred Combo, potom objem vzostupne, id ako tiebreaker.
 */
val menuLogicComparator: Comparator<MenuItemDto> = Comparator { a, b ->
    val fa = familyName(a.name)
    val fb = familyName(b.name)
    val aNum = fa.toIntOrNull()
    val bNum = fb.toIntOrNull()
    if (aNum != null && bNum != null) return@Comparator aNum - bNum
    val cf = skCollator.compare(fa, fb)
    if (cf != 0) return@Comparator cf
    val aIsCombo = COMBO_RE.containsMatchIn(a.name)
    val bIsCombo = COMBO_RE.containsMatchIn(b.name)
    if (aIsCombo != bIsCombo) return@Comparator if (aIsCombo) 1 else -1
    val va = parseVolumeMl(a.name)
    val vb = parseVolumeMl(b.name)
    if (va != null && vb != null && va != vb) return@Comparator va - vb
    if (va != null && vb == null) return@Comparator -1
    if (va == null && vb != null) return@Comparator 1
    a.id - b.id
}
