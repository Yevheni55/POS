package sk.surfspirit.pos.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import sk.surfspirit.pos.core.*
import sk.surfspirit.pos.net.*
import sk.surfspirit.pos.ui.components.*
import sk.surfspirit.pos.ui.theme.*

/** Web _needsSaucePicker: combá + Kuracie hranolky majú omáčku v cene. */
private val COMBO_NAME_RE = Regex("^combo\\s", RegexOption.IGNORE_CASE)
private val HRANOLKY_RE = Regex("kuracie\\s+hranolky", RegexOption.IGNORE_CASE)
private fun needsSaucePicker(name: String): Boolean =
    COMBO_NAME_RE.containsMatchIn(name) || HRANOLKY_RE.containsMatchIn(name)

private const val SAUCE_ANNOTATION = "Omáčka (combo)"

/** Per-kategória akcent (web CAT_COLORS) — farebné zóny pre rýchly scan. */
private val CAT_COLORS = mapOf(
    "capovane" to Color(0xFFC68626), "cisla" to Color(0xFF926CB4),
    "nealko" to Color(0xFF409696), "limonady" to Color(0xFFAAA83A),
    "smoothies" to Color(0xFFC66096), "alko" to Color(0xFF966034),
    "drinky" to Color(0xFFD06860), "kava-caj" to Color(0xFF7A563A),
    "pochutiny" to Color(0xFFB88E36), "croissanty" to Color(0xFFC69A60),
    "burgre" to Color(0xFFBA4830), "prilohy" to Color(0xFFD0802C),
    "salaty" to Color(0xFF609848), "extra-prilohy" to Color(0xFFA05C54),
)

/** Čakajúci storno-reason prompt (kumuluje rýchle '−' na tej istej položke). */
private data class StornoPrompt(
    val menuItemId: Int,
    val name: String,
    val qty: Int,
    val unitPrice: Double,
    val orderId: Int?,
)

private var cartUidSeq = 1L
private fun nextCartUid(): Long = cartUidSeq++

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun OrderScreen(
    tableId: Int,
    onBack: () -> Unit,
    onLogout: () -> Unit = onBack,
    onSessionExpired: () -> Unit = onBack,
) {
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    val haptics = LocalHapticFeedback.current

    var categories by remember { mutableStateOf<List<CategoryDto>>(emptyList()) }
    var discountsList by remember { mutableStateOf<List<DiscountDto>>(emptyList()) }
    var tables by remember { mutableStateOf<List<TableDto>>(emptyList()) }
    var accounts by remember { mutableStateOf<List<OrderDto>>(emptyList()) }
    var current by remember { mutableStateOf<OrderDto?>(null) }
    val newItems = remember { mutableStateListOf<CartLine>() }

    var selectedCat by remember { mutableStateOf(Store.lastCategory()) }
    var search by remember { mutableStateOf("") }
    var loading by remember { mutableStateOf(true) }
    var busy by remember { mutableStateOf(false) }          // globálny „prebieha akcia"
    var error by remember { mutableStateOf<String?>(null) }
    var toast by remember { mutableStateOf<String?>(null) }

    // Dialógy
    var showPay by remember { mutableStateOf(false) }
    var payInitMethod by remember { mutableStateOf("hotovost") }
    var payError by remember { mutableStateOf<String?>(null) }
    var payFiscal by remember { mutableStateOf<String?>(null) }
    var showDiscount by remember { mutableStateOf(false) }
    var discountError by remember { mutableStateOf<String?>(null) }
    var showSplit by remember { mutableStateOf(false) }
    var splitError by remember { mutableStateOf<String?>(null) }
    var showMovePicker by remember { mutableStateOf(false) }   // presun CELÉHO účtu
    var showCancel by remember { mutableStateOf(false) }
    var showMerge by remember { mutableStateOf(false) }
    var showStaffMeal by remember { mutableStateOf(false) }
    var saucePending by remember { mutableStateOf<MenuItemDto?>(null) }
    var noteCartUid by remember { mutableStateOf<Long?>(null) }
    var noteServerItem by remember { mutableStateOf<OrderItemDto?>(null) }
    var qtyPopupFor by remember { mutableStateOf<MenuItemDto?>(null) }
    var confirmRemove by remember { mutableStateOf<OrderItemDto?>(null) }
    var underpayConfirm by remember { mutableStateOf<Pair<String, Double>?>(null) }  // method to given
    var showAccountPicker by remember { mutableStateOf(false) }
    // Paragón fallback
    var paragonOffer by remember { mutableStateOf<String?>(null) }   // reason alebo null
    // Storno dôvod
    val stornoPrompts = remember { mutableStateListOf<StornoPrompt>() }
    // Uzávierka pri odhlásení z objednávky (web parita: logout vždy cez uzávierku)
    var showCloseShift by remember { mutableStateOf(false) }
    var closeSummary by remember { mutableStateOf<ShiftSummaryDto?>(null) }
    var closeBusy by remember { mutableStateOf(false) }
    var closeError by remember { mutableStateOf<String?>(null) }
    // Move mode — presun vybraných položiek (itemId -> qty alebo null=celé)
    var moveMode by remember { mutableStateOf(false) }
    val moveSelection = remember { mutableStateMapOf<Long, Int?>() }
    var moveQtyPickFor by remember { mutableStateOf<OrderItemDto?>(null) }
    var showMoveTablePicker by remember { mutableStateOf(false) }
    // Manager PIN brána
    var gateLabel by remember { mutableStateOf<String?>(null) }
    var gateAction by remember { mutableStateOf<(() -> Unit)?>(null) }

    val itemById = remember(categories) {
        categories.flatMap { it.items }.associateBy { it.id }
    }
    val sauceAnnotationItem = remember(categories) {
        categories.flatMap { it.items }.firstOrNull { it.name == SAUCE_ANNOTATION }
    }

    fun gate(label: String, action: () -> Unit) {
        if (isManager) action() else { gateLabel = label; gateAction = action }
    }

    // Idempotency nonce pre cart-sync: nový pri KAŽDEJ zmene košíka, rovnaký
    // pri retry nezmeneného košíka → server (X-Idempotency-Key) pri retry po
    // výpadku vráti cached odpoveď namiesto duplicitného insertu položiek.
    var draftNonce by remember { mutableStateOf(java.util.UUID.randomUUID().toString()) }
    // Idempotency nonce pre platbu: nový pri otvorení payment dialógu.
    var payNonce by remember { mutableStateOf(java.util.UUID.randomUUID().toString()) }

    fun persistDraft() {
        draftNonce = java.util.UUID.randomUUID().toString()
        Store.saveDraft(tableId, newItems.toList())
    }

    // ---------- načítanie ----------
    fun reload(keepAccountId: Int? = current?.id, quiet: Boolean = false) {
        scope.launch {
            try {
                val (menu, top) = withContext(Dispatchers.IO) {
                    val m = Api.service.menu()
                    val t = try { Api.service.menuTop() } catch (_: Exception) { Store.cachedTop() ?: emptyList() }
                    m to t
                }
                Store.cacheMenu(menu)
                if (top.isNotEmpty()) Store.cacheTop(top)
                // Logické triedenie v kategórii (web compareByMenuLogic);
                // „Najčastejšie" drží sales-rank poradie, presne 12 (web parita).
                val withItems = menu.filter { it.items.isNotEmpty() }
                    .map { it.copy(items = it.items.sortedWith(menuLogicComparator)) }
                categories = if (top.isNotEmpty())
                    listOf(CategoryDto(id = -1, slug = "top", label = "Najčastejšie", icon = "🔥",
                        items = top.take(12))) + withItems
                else withItems
                val (ords, tbls, disc) = withContext(Dispatchers.IO) {
                    Triple(Api.service.tableOrders(tableId), Api.service.tables(),
                        try { Api.service.discounts() } catch (_: Exception) { emptyList() })
                }
                accounts = ords
                tables = tbls
                discountsList = disc
                current = ords.firstOrNull { it.id == keepAccountId } ?: ords.firstOrNull()
                Net.offline.value = false
                error = null
                withContext(Dispatchers.IO) { runCatching { Store.flushQueue() } }
                Store.refreshQueueCount()
                // Viac účtov na stole → account picker (web showAccountPicker parita)
                if (!quiet && ords.size > 1 && keepAccountId == null) showAccountPicker = true
            } catch (e: Exception) {
                if (e.httpCode() == 401) { AppPrefs.logout(); onSessionExpired(); return@launch }
                Net.offline.value = true
                // Offline fallback — menu z cache, objednávky posledné známe
                if (categories.isEmpty()) {
                    val cached = Store.cachedMenu()
                    if (cached != null) {
                        val withItems = cached.filter { it.items.isNotEmpty() }
                            .map { it.copy(items = it.items.sortedWith(menuLogicComparator)) }
                        val top = Store.cachedTop() ?: emptyList()
                        categories = if (top.isNotEmpty())
                            listOf(CategoryDto(id = -1, slug = "top", label = "Najčastejšie", icon = "🔥",
                                items = top.take(12))) + withItems
                        else withItems
                        toast = "Offline — používam cache dáta"
                    } else if (!quiet) {
                        error = "Načítanie zlyhalo — skontroluj server."
                    }
                }
            } finally { loading = false }
        }
    }

    /** Tiché obnovenie iba objednávok/stolov (10 s poll) — košík sa nedotýka. */
    fun reloadOrdersQuiet() {
        scope.launch {
            try {
                val (ords, tbls) = withContext(Dispatchers.IO) {
                    Api.service.tableOrders(tableId) to Api.service.tables()
                }
                accounts = ords
                tables = tbls
                current = ords.firstOrNull { it.id == current?.id } ?: ords.firstOrNull()
                Net.offline.value = false
            } catch (e: Exception) {
                if (e.httpCode() == 401) { AppPrefs.logout(); onSessionExpired(); return@launch }
                Net.offline.value = true
            }
        }
    }

    LaunchedEffect(tableId) {
        // Draft restore — rozpísaný košík prežíva navigáciu aj reštart (web parita)
        newItems.clear()
        newItems.addAll(Store.loadDraft(tableId).map {
            if (it.uid == 0L) it.copy(uid = nextCartUid()) else { if (it.uid >= cartUidSeq) cartUidSeq = it.uid + 1; it }
        })
        Store.saveLastTable(tableId)
        reload(keepAccountId = null)
    }
    LaunchedEffect(toast) { toast?.let { snackbar.showSnackbar(it); toast = null } }
    LaunchedEffect(selectedCat) { Store.saveLastCategory(selectedCat) }
    // Fallback poll — web 30 s + WS; my bez WS, preto 10 s tichý refresh.
    // Pauzuje sa kým je otvorený hociktorý dialóg — poll nesmie potichu
    // prehodiť `current` na iný účet pod otvoreným payment/split dialógom.
    LaunchedEffect(Unit) {
        while (true) {
            delay(10_000)
            val dialogOpen = showPay || showDiscount || showSplit || showMovePicker ||
                showCancel || showMerge || showStaffMeal || showAccountPicker ||
                showCloseShift || showMoveTablePicker || saucePending != null ||
                qtyPopupFor != null || confirmRemove != null || underpayConfirm != null ||
                paragonOffer != null || stornoPrompts.isNotEmpty() || noteCartUid != null ||
                noteServerItem != null || gateLabel != null || moveQtyPickFor != null
            if (!busy && !moveMode && !dialogOpen) reloadOrdersQuiet()
        }
    }

    // ---------- košík ----------
    fun addCartLine(mi: MenuItemDto, note: String = "", forceNew: Boolean = false, addQty: Int = 1): CartLine {
        val idx = if (forceNew) -1 else newItems.indexOfFirst {
            it.menuItemId == mi.id && it.note == note && it.companionOfUid == null && !it.noMerge
        }
        val line: CartLine
        if (idx >= 0) {
            line = newItems[idx].copy(qty = newItems[idx].qty + addQty)
            newItems[idx] = line
        } else {
            line = CartLine(uid = nextCartUid(), menuItemId = mi.id, name = mi.name,
                emoji = mi.emoji, price = mi.price, qty = addQty, note = note, noMerge = forceNew)
            newItems.add(line)
        }
        // companion (napr. Záloha fľaša) — zrkadlí qty primárnej položky
        mi.companionMenuItemId?.let { cid ->
            itemById[cid]?.let { comp ->
                val ci = newItems.indexOfFirst { it.companionOfUid == line.uid }
                if (ci >= 0) newItems[ci] = newItems[ci].copy(qty = line.qty)
                else newItems.add(CartLine(uid = nextCartUid(), menuItemId = comp.id, name = comp.name,
                    emoji = comp.emoji, price = comp.price, qty = line.qty, companionOfUid = line.uid))
            }
        }
        persistDraft()
        return line
    }

    /** Combo + omáčka: nový riadok (noMerge) + 0 € annotation „Omáčka (combo)". */
    fun addComboWithSauce(mi: MenuItemDto, sauces: List<String>) {
        val combo = addCartLine(mi, forceNew = true)
        val sauceNote = if (sauces.isEmpty()) "bez omáčky" else sauces.joinToString(" + ")
        val ann = sauceAnnotationItem
        if (ann != null) {
            newItems.add(CartLine(uid = nextCartUid(), menuItemId = ann.id, name = ann.name,
                emoji = ann.emoji, price = 0.0, qty = combo.qty, note = sauceNote,
                companionOfUid = combo.uid))
        } else {
            // Fallback bez placeholder položky v menu — omáčka v note comba
            val i = newItems.indexOfFirst { it.uid == combo.uid }
            if (i >= 0) newItems[i] = newItems[i].copy(note = "Omáčka: $sauceNote")
        }
        persistDraft()
    }

    /** Posledná voľba omáčky pre rovnaké combo v účte (web _findLastSauceForItem). */
    fun lastSauceFor(name: String): List<String>? {
        val ann = newItems.lastOrNull { line ->
            line.name == SAUCE_ANNOTATION &&
                newItems.any { it.uid == line.companionOfUid && it.name == name }
        } ?: return null
        return if (ann.note.contains("bez omáčky", ignoreCase = true)) emptyList()
        else ann.note.split("+").map { it.trim() }.filter { it.isNotEmpty() }
    }

    fun productTap(mi: MenuItemDto, qty: Int = 1) {
        if (needsSaucePicker(mi.name)) saucePending = mi
        else { addCartLine(mi, addQty = qty) }
    }

    fun cartDelta(uid: Long, d: Int) {
        val index = newItems.indexOfFirst { it.uid == uid }
        val line = newItems.getOrNull(index) ?: return
        val nq = line.qty + d
        if (nq <= 0) {
            newItems.removeAt(index)
            newItems.removeAll { it.companionOfUid == uid }
        } else {
            newItems[index] = line.copy(qty = nq)
            val ci = newItems.indexOfFirst { it.companionOfUid == uid }
            if (ci >= 0) newItems[ci] = newItems[ci].copy(qty = nq)
        }
        persistDraft()
    }

    fun cartPayload() = newItems.map { NewItem(it.menuItemId, it.qty, it.note) }

    /**
     * Persist košík na server (vytvorí/aktualizuje objednávku), vráti čerstvý
     * OrderDto. Idempotentné: X-Idempotency-Key = draftNonce, takže retry toho
     * istého košíka po výpadku NEduplikuje položky. Košík sa čistí HNEĎ po
     * úspešnej mutácii — zlyhanie následného refreshu už nesmie viesť k re-addu.
     */
    suspend fun syncToServer(): OrderDto? {
        val oid: Int = when {
            newItems.isEmpty() -> current?.id ?: return current
            current == null -> Api.service.createOrder("sync-$draftNonce", CreateOrderReq(tableId, cartPayload(), null)).id
            else -> { Api.service.addItems(current!!.id, "sync-$draftNonce", AddItemsReq(cartPayload())); current!!.id }
        }
        // Košík je na serveri — vyčisti okamžite (draft prefs tiež).
        if (newItems.isNotEmpty()) { newItems.clear(); Store.saveDraft(tableId, emptyList()) }
        val fresh = runCatching { Api.service.tableOrders(tableId) }.getOrNull()
        if (fresh != null) accounts = fresh
        return fresh?.firstOrNull { it.id == oid } ?: fresh?.firstOrNull() ?: current
    }

    /**
     * Vytlačí položky (rozdelené kuchyňa/bar) a vráti web-style toast o reálnom
     * výsledku tlače: vytlačený / vo fronte (printer offline) / chyba per dest.
     */
    suspend fun printItems(items: List<MarkedItemDto>, orderNum: Int, storno: Boolean): String? {
        if (items.isEmpty()) return null
        val tableName = tables.firstOrNull { it.id == tableId }?.name ?: "Stôl $tableId"
        val staff = AppPrefs.userName ?: ""
        data class DestResult(val dest: String, val count: Int, val ok: Boolean, val queued: Boolean)
        val results = mutableListOf<DestResult>()
        splitForPrint(items, categories, storno).forEach { (dest, pis) ->
            val label = if (dest.contains("KUCHYNA")) "kuchyňa" else "bar"
            try {
                val r = Api.service.printKitchen(PrintKitchenReq(dest, tableName, staff, pis, orderNum))
                results.add(DestResult(label, pis.size, true, r.queued))
            } catch (_: Exception) {
                results.add(DestResult(label, pis.size, false, false))
            }
        }
        if (results.isEmpty()) return null
        fun fmtD(d: DestResult) = "${d.dest} ${d.count}"
        val failed = results.filter { !it.ok }
        val queued = results.filter { it.ok && it.queued }
        val printed = results.filter { it.ok && !it.queued }
        val prefix = if (storno) "Storno bon" else "Bon"
        return when {
            failed.isNotEmpty() && printed.isEmpty() && queued.isEmpty() ->
                "Chyba tlače: ${results.joinToString(" + ") { fmtD(it) }} — bon sa nevytlačil!"
            queued.size == results.size ->
                "⏳ $prefix vo fronte: ${results.joinToString(" + ") { fmtD(it) }} — vytlačí sa hneď ako tlačiareň odpovie"
            printed.size == results.size ->
                "✔ $prefix vytlačený: ${results.joinToString(" + ") { fmtD(it) }}"
            else -> "$prefix: " + results.joinToString(" + ") {
                fmtD(it) + when { !it.ok -> " chyba"; it.queued -> " do queue"; else -> " vytlačený" }
            }
        }
    }

    // ---------- akcie ----------
    /** Odoslanie do kuchyne/baru. onDone beží po úspechu (aj keď nebolo čo poslať). */
    fun doSend(overrideLimit: Boolean = false, onDone: (() -> Unit)? = null, onFail: ((Throwable) -> Unit)? = null) {
        if (busy) return
        busy = true; error = null
        scope.launch {
            try {
                val ord = withContext(Dispatchers.IO) { syncToServer() }
                if (ord == null) { busy = false; onDone?.invoke(); return@launch }
                val resp = withContext(Dispatchers.IO) { Api.service.sendAndPrint(ord.id, SendReq(overrideLimit)) }
                val printToast = withContext(Dispatchers.IO) { printItems(resp.items, ord.id, storno = false) }
                haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                toast = printToast ?: "Odoslané (${resp.items.sumOf { it.qty }} ks)"
                reload(ord.id, quiet = true)
                busy = false
                onDone?.invoke()
            } catch (e: Exception) {
                busy = false
                if (e.httpCode() == 422 && !overrideLimit) {
                    // Server error text nesie limit detail (osoba, dnešná útrata)
                    gate(errorMessage(e) + " Pokračovať s odoslaním?") { doSend(overrideLimit = true, onDone = onDone, onFail = onFail) }
                } else {
                    error = errorMessage(e)
                    // Sync mohol prebehnúť (košík už na serveri) — obnov UI nech
                    // položky „nezmiznú" a Poslať ostane aktívne.
                    reload(current?.id, quiet = true)
                    onFail?.invoke(e)
                }
            }
        }
    }

    val canSendNow = newItems.isNotEmpty() || current?.items?.any { !it.sent } == true

    /**
     * Auto-send pri odchode zo stola (web flushOrderBeforeTableLeave):
     * neodoslané položky sa NIKDY ticho nestratia — pošlú sa, a ak to zlyhá,
     * navigácia sa zablokuje + error toast. Výnimky:
     *  - prebieha akcia (busy) → nenaviguj (zrušil by sa coroutine s tlačou
     *    bonu uprostred — server by mal items sent, kuchyňa nič);
     *  - offline → draft sa odparkuje (prežíva v Store) a odísť SA DÁ —
     *    čašník nesmie byť uväznený na obrazovke počas výpadku.
     */
    fun flushAndLeave(then: () -> Unit) {
        if (busy) { toast = "Počkaj — prebieha odosielanie…"; return }
        if (!canSendNow) { Store.saveLastTable(null); then(); return }
        if (Net.offline.value) {
            toast = "Offline — rozpísaný účet ostáva v koncepte na stole"
            Store.saveLastTable(null); then(); return
        }
        doSend(
            onDone = { Store.saveLastTable(null); then() },
            onFail = { e ->
                if (e.isTransportError()) {
                    toast = "Offline — rozpísaný účet ostáva v koncepte na stole"
                    Store.saveLastTable(null); then()
                }
                // HTTP chyba (422 zrušený gate a pod.) → ostávame na stole
            },
        )
    }

    BackHandler(enabled = true) { flushAndLeave(onBack) }

    fun doPreBill() {
        if (busy) return
        busy = true; error = null
        scope.launch {
            try {
                // Pre-sync — orderNum + items konzistentné so serverom (web parita)
                val ord = withContext(Dispatchers.IO) { syncToServer() }
                if (ord != null) current = accounts.firstOrNull { it.id == ord.id } ?: ord
                val tableName = tables.firstOrNull { it.id == tableId }?.name ?: "Stôl $tableId"
                val staff = AppPrefs.userName ?: ""
                val src = current?.items.orEmpty()
                if (src.isEmpty()) { error = "Prázdna objednávka."; busy = false; return@launch }
                val pis = src.map { PrintItem(it.qty, it.name, it.note, it.price, it.emoji) }
                val sub = current?.subtotal ?: 0.0
                val disc = current?.discount ?: 0.0
                val r = withContext(Dispatchers.IO) {
                    Api.service.printPreBill(PreBillReq(tableName, staff, pis, (sub - disc).coerceAtLeast(0.0), sub, disc, current?.id))
                }
                haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                toast = if (r.queued) "Predúčet v queue — tlačiareň offline" else "✔ Predúčet vytlačený"
            } catch (e: Exception) { error = errorMessage(e) } finally { busy = false }
        }
    }

    /**
     * Paragón fallback — vystav + vytlač + uzavri UI (web offerParagonFallback).
     * Snapshot položiek = server items + prípadné NEsynchnuté cart riadky
     * (po transport-error platbe môže byť košík stále lokálny) — náhradný
     * doklad musí niesť VŠETKO čo zákazník dostal, v aktuálnej sume.
     */
    fun issueParagon(reason: String) {
        busy = true
        scope.launch {
            try {
                val ord = current
                val items = (ord?.items.orEmpty()
                    .filter { it.name != SAUCE_ANNOTATION }
                    .map { ParagonItem(id = it.id, name = it.name, qty = it.qty, price = it.price,
                        vatRate = itemById[it.menuItemId]?.vatRate ?: 0.0, note = it.note) }
                    + newItems.filter { it.name != SAUCE_ANNOTATION }
                        .map { ParagonItem(id = null, name = it.name, qty = it.qty, price = it.price,
                            vatRate = itemById[it.menuItemId]?.vatRate ?: 0.0, note = it.note) })
                if (items.isEmpty()) { toast = "Paragón sa nepodarilo vystaviť — prázdny účet"; return@launch }
                val disc = ord?.discount ?: 0.0
                val total = ((ord?.subtotal ?: 0.0) + newItems.sumOf { it.price * it.qty } - disc).coerceAtLeast(0.0)
                // payInitMethod drží metódu z POSLEDNÉHO pokusu o platbu (doPay ju
                // zapisuje) — paragón nesie skutočne zvolený spôsob, nie ten
                // s ktorým sa dialóg otvoril.
                val method = payInitMethod
                val res = withContext(Dispatchers.IO) {
                    Api.service.issueParagon(ParagonIssueReq(
                        orderId = ord?.id, items = items, paymentMethod = method,
                        totalAmount = total, discountAmount = disc, reason = reason))
                }
                if (res.paragonNumber.isBlank()) { toast = "Paragón sa nepodarilo vystaviť"; return@launch }
                // Tlač — best-effort (printQueue dohoní offline tlačiareň)
                val tableName = tables.firstOrNull { it.id == tableId }?.name
                val printFailed = withContext(Dispatchers.IO) {
                    runCatching {
                        Api.service.printParagon(ParagonPrintReq(
                            paragonNumber = res.paragonNumber, tableName = tableName,
                            staffName = AppPrefs.userName ?: "", items = items,
                            total = total, method = method, vatRate = null, companyName = null))
                    }.isFailure
                }
                toast = if (printFailed)
                    "Paragón ${res.paragonNumber} vystavený, ale tlač zlyhala — vytlač cez admin → História."
                else
                    "Paragón ${res.paragonNumber} vystavený. Po obnove eKasa sa automaticky zaregistruje."
                paragonOffer = null
                showPay = false
                newItems.clear(); Store.saveDraft(tableId, emptyList())
                Store.saveLastTable(null)
                onBack()
            } catch (e: Exception) {
                toast = "Vystavenie paragónu zlyhalo: ${errorMessage(e)}"
            } finally { busy = false }
        }
    }

    fun doPay(method: String, given: Double?, underpayConfirmed: Boolean = false) {
        if (busy) return
        // Zapamätaj SKUTOČNE zvolenú metódu — paragón fallback ju číta;
        // bez tohto by paragón niesol metódu s ktorou sa dialóg OTVORIL.
        payInitMethod = method
        // Underpayment guard (web parita): zadaná hotovosť < suma → confirm
        val dueNow = (current?.grandTotal ?: 0.0) + newItems.sumOf { it.price * it.qty }
        if (!underpayConfirmed && method == "hotovost" && given != null && given > 0 && given < dueNow - 0.005) {
            underpayConfirm = method to given
            return
        }
        busy = true; payError = null; payFiscal = null
        scope.launch {
            try {
                val ord = withContext(Dispatchers.IO) { syncToServer() } ?: run { busy = false; return@launch }
                // auto-send neodoslaných (kvôli odpočtu skladu) — s limit gate
                try {
                    val sresp = withContext(Dispatchers.IO) { Api.service.sendAndPrint(ord.id, SendReq(false)) }
                    withContext(Dispatchers.IO) { printItems(sresp.items, ord.id, storno = false) }
                } catch (se: Exception) {
                    if (se.httpCode() == 422) {
                        busy = false
                        gate(errorMessage(se) + " Pokračovať s odoslaním?") {
                            scope.launch {
                                try {
                                    busy = true
                                    val sr = withContext(Dispatchers.IO) { Api.service.sendAndPrint(ord.id, SendReq(true)) }
                                    withContext(Dispatchers.IO) { printItems(sr.items, ord.id, storno = false) }
                                    busy = false
                                    doPay(method, given, underpayConfirmed = true)
                                } catch (e2: Exception) { busy = false; payError = errorMessage(e2) }
                            }
                        }
                        return@launch
                    } else throw se
                }
                val fresh = withContext(Dispatchers.IO) { Api.service.tableOrders(tableId) }.firstOrNull { it.id == ord.id }
                current = fresh ?: current
                val amount = fresh?.grandTotal ?: ord.grandTotal
                if (amount <= 0.0) { payError = "Nulová suma."; busy = false; return@launch }

                // ---- Samotná platba: izolovaný error handling ----
                // X-Idempotency-Key → timeout retry s rovnakým kľúčom vráti
                // cached výsledok namiesto DRUHEJ platby. Timeout NIKDY
                // neponúka paragón (server mohol platbu dokončiť — hrozil by
                // dvojitý doklad); paragón len pri connect-level zlyhaní
                // (request preukázateľne neodišiel) alebo Portos blocked.
                val payKey = "pay-$payNonce"
                val payReq = PayReq(ord.id, method, amount)
                val resp: PayResp = try {
                    withContext(Dispatchers.IO) { Api.service.pay(payKey, payReq) }
                } catch (pe: Exception) {
                    if (pe.isTimeout()) {
                        // 1 retry s tým istým idempotency kľúčom — ak prvá
                        // požiadavka prešla, server vráti cached success.
                        try { withContext(Dispatchers.IO) { Api.service.pay(payKey, payReq) } }
                        catch (_: Exception) {
                            payError = "Stav platby je nejasný — server neodpovedal včas. NEPOSIELAJ znovu, over v admin → História."
                            payFiscal = "Platba čaká na overenie"
                            busy = false; return@launch
                        }
                    } else if (pe.isConnectFailure()) {
                        payError = "Pripojenie nie je dostupné — platbu nie je možné dokončiť offline."
                        paragonOffer = "no_connection"
                        busy = false; return@launch
                    } else if (pe.httpCode() != null) {
                        val outcome = normalizeFiscalOutcome(null, pe)
                        payError = outcome.message; payFiscal = outcome.title
                        when (outcome.kind) {
                            "conflict" -> reload(ord.id, quiet = true)
                            "blocked", "ambiguous" -> paragonOffer = "portos_blocked"
                        }
                        busy = false; return@launch
                    } else {
                        payError = errorMessage(pe)
                        busy = false; return@launch
                    }
                }
                val outcome = normalizeFiscalOutcome(resp, null)
                when (outcome.kind) {
                    "success", "offline_accepted", "no_fiscal" -> {
                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                        showPay = false
                        toast = if (outcome.kind == "success")
                            "Zaplatené ${money(amount)} (${if (method == "karta") "karta" else "hotovosť"})"
                        else outcome.message
                        Store.saveLastTable(null)
                        onBack()
                    }
                    "blocked", "ambiguous" -> {
                        payError = outcome.message; payFiscal = outcome.title
                        paragonOffer = "portos_blocked"
                    }
                    else -> { payError = outcome.message; reload(ord.id, quiet = true) }
                }
            } catch (e: Exception) {
                // Chyby z prípravných fáz (sync, auto-send, refresh) —
                // platba sa nepokúsila, žiadny paragón.
                payError = errorMessage(e)
                if (e.httpCode() == 409) reload(current?.id, quiet = true)
            } finally { busy = false }
        }
    }

    fun applyDiscountPreset(id: Int) {
        gate("Zľava na objednávku") {
            busy = true; discountError = null
            scope.launch {
                try {
                    val ord = withContext(Dispatchers.IO) { syncToServer() } ?: return@launch
                    // košík vyčistený v syncToServer
                    withContext(Dispatchers.IO) { Api.service.applyDiscount(ord.id, DiscountReq(discountId = id, version = ord.version)) }
                    showDiscount = false; toast = "Zľava použitá"; reload(ord.id, quiet = true)
                } catch (e: Exception) {
                    if (e.httpCode() == 409) { discountError = "Objednávka bola medzitým zmenená — skús znova."; reload(current?.id, quiet = true) }
                    else discountError = errorMessage(e)
                } finally { busy = false }
            }
        }
    }
    fun applyDiscountCustom(pct: Double) {
        gate("Zľava $pct %") {
            busy = true; discountError = null
            scope.launch {
                try {
                    val ord = withContext(Dispatchers.IO) { syncToServer() } ?: return@launch
                    // košík vyčistený v syncToServer
                    withContext(Dispatchers.IO) { Api.service.applyDiscount(ord.id, DiscountReq(customPercent = pct, version = ord.version)) }
                    showDiscount = false; toast = "Zľava $pct % použitá"; reload(ord.id, quiet = true)
                } catch (e: Exception) {
                    if (e.httpCode() == 409) { discountError = "Objednávka bola medzitým zmenená — skús znova."; reload(current?.id, quiet = true) }
                    else discountError = errorMessage(e)
                } finally { busy = false }
            }
        }
    }
    fun removeDiscount() {
        val ord = current ?: return
        gate("Odstrániť zľavu") {
            busy = true; discountError = null
            scope.launch {
                try {
                    withContext(Dispatchers.IO) { Api.service.removeDiscount(ord.id) }
                    showDiscount = false; toast = "Zľava odstránená"; reload(ord.id, quiet = true)
                } catch (e: Exception) { discountError = errorMessage(e) } finally { busy = false }
            }
        }
    }

    fun doSplitEqual(parts: Int) {
        busy = true; splitError = null
        scope.launch {
            try {
                val ord = withContext(Dispatchers.IO) { syncToServer() } ?: return@launch
                // košík vyčistený v syncToServer
                withContext(Dispatchers.IO) { Api.service.splitParts(ord.id, SplitPartsReq(parts)) }
                showSplit = false; toast = "Účet rozdelený na $parts časti"
                Store.saveLastTable(null); onBack()
            } catch (e: Exception) { splitError = errorMessage(e) } finally { busy = false }
        }
    }
    /** Split po položkách — web parita: nový účet + move-items s partial qty. */
    fun doSplitItems(itemQtys: List<MoveQty>) {
        busy = true; splitError = null
        scope.launch {
            try {
                val ord = withContext(Dispatchers.IO) { syncToServer() } ?: return@launch
                // košík vyčistený v syncToServer
                val label = "Ucet ${accounts.size + 1}"
                val newOrder = withContext(Dispatchers.IO) {
                    Api.service.createOrder(null, CreateOrderReq(tableId, emptyList(), label))
                }
                withContext(Dispatchers.IO) {
                    Api.service.moveItems(ord.id, MoveReq(itemQtys = itemQtys,
                        targetTableId = tableId, targetOrderId = newOrder.id))
                }
                showSplit = false
                val n = itemQtys.sumOf { it.qty ?: 0 }
                toast = "$n pol. presunutých na nový účet"
                reload(ord.id, quiet = true)
            } catch (e: Exception) { splitError = errorMessage(e) } finally { busy = false }
        }
    }

    /** Presun CELÉHO účtu na iný stôl. */
    fun doMove(targetTableId: Int) {
        busy = true; error = null
        scope.launch {
            try {
                val ord = withContext(Dispatchers.IO) { syncToServer() } ?: return@launch
                // košík vyčistený v syncToServer
                val ids = ord.items.map { it.id }
                if (ids.isEmpty()) { error = "Účet je prázdny."; busy = false; return@launch }
                withContext(Dispatchers.IO) { Api.service.moveItems(ord.id, MoveReq(itemIds = ids, targetTableId = targetTableId)) }
                showMovePicker = false
                toast = "Účet presunutý na ${tables.firstOrNull { it.id == targetTableId }?.name ?: "stôl"}"
                Store.saveLastTable(null); onBack()
            } catch (e: Exception) { error = errorMessage(e) } finally { busy = false }
        }
    }

    // ---------- move mode (presun vybraných položiek) ----------
    fun enterMoveMode(preselect: OrderItemDto? = null) {
        if (busy) return
        busy = true
        scope.launch {
            try {
                // Sync — lokálne riadky potrebujú server id, inak ich move preskočí
                val ord = withContext(Dispatchers.IO) { syncToServer() }
                if (ord != null) {
                    accounts = withContext(Dispatchers.IO) { Api.service.tableOrders(tableId) }
                    current = accounts.firstOrNull { it.id == ord.id } ?: accounts.firstOrNull()
                    // košík vyčistený v syncToServer
                }
                moveSelection.clear()
                moveMode = true
                preselect?.let { pre ->
                    val freshItem = current?.items?.firstOrNull { it.menuItemId == pre.menuItemId && it.note == pre.note }
                    if (freshItem != null) {
                        if (freshItem.qty > 1) moveQtyPickFor = freshItem
                        else moveSelection[freshItem.id] = null
                    }
                }
            } catch (e: Exception) { error = errorMessage(e) } finally { busy = false }
        }
    }
    fun exitMoveMode() { moveMode = false; moveSelection.clear(); showMoveTablePicker = false }

    fun moveSelectedTo(targetOrderId: Int?, targetTableId: Int?) {
        val src = current ?: return
        if (moveSelection.isEmpty()) { exitMoveMode(); return }
        busy = true
        scope.launch {
            try {
                val itemQtys = moveSelection.map { (id, q) -> MoveQty(id, q) }
                withContext(Dispatchers.IO) {
                    Api.service.moveItems(src.id, MoveReq(itemQtys = itemQtys,
                        targetTableId = targetTableId ?: tableId, targetOrderId = targetOrderId))
                }
                val n = moveSelection.size
                exitMoveMode()
                toast = "$n pol. presunutých"
                reload(targetOrderId ?: src.id, quiet = true)
            } catch (e: Exception) { error = errorMessage(e) } finally { busy = false }
        }
    }
    fun moveSelectedToNewAccount() {
        if (moveSelection.isEmpty()) { exitMoveMode(); return }
        busy = true
        scope.launch {
            try {
                val label = "Ucet ${accounts.size + 1}"
                val newOrder = withContext(Dispatchers.IO) {
                    Api.service.createOrder(null, CreateOrderReq(tableId, emptyList(), label))
                }
                busy = false
                moveSelectedTo(newOrder.id, tableId)
            } catch (e: Exception) { busy = false; error = errorMessage(e) }
        }
    }

    fun newAccount() {
        if (busy) return
        busy = true
        scope.launch {
            try {
                val o = withContext(Dispatchers.IO) { Api.service.createOrder(null, CreateOrderReq(tableId, emptyList(), null)) }
                reload(o.id, quiet = true)
            } catch (e: Exception) { error = errorMessage(e) } finally { busy = false }
        }
    }

    fun doCancel() {
        val ord = current
        val sent = ord?.items?.filter { it.sent }.orEmpty()
        val run = {
            busy = true; error = null
            scope.launch {
                try {
                    if (ord != null) {
                        if (sent.isNotEmpty()) {
                            val resp = withContext(Dispatchers.IO) {
                                Api.service.sendStornoAndPrint(ord.id, StornoSendReq(sent.map { NewItem(it.menuItemId, it.qty, it.note) }))
                            }
                            withContext(Dispatchers.IO) { printItems(resp.items, ord.id, storno = true) }
                        }
                        withContext(Dispatchers.IO) { Api.service.deleteOrder(ord.id) }
                    }
                    newItems.clear(); persistDraft()
                    showCancel = false; toast = "Objednávka zrušená"
                    Store.saveLastTable(null); onBack()
                } catch (e: Exception) {
                    if (e.httpCode() == 403) error = "Objednávku s platbou môže zrušiť len manažér."
                    else error = errorMessage(e)
                } finally { busy = false }
            }
        }
        if (sent.isNotEmpty() && !isManager) gate("Zrušiť účet s ${sent.sumOf { it.qty }} odoslanými položkami") { run() }
        else run()
    }

    fun doStaffMeal(overrideLimit: Boolean = false) {
        if (busy) return
        busy = true; error = null
        scope.launch {
            try {
                val ord = withContext(Dispatchers.IO) { syncToServer() } ?: run { busy = false; return@launch }
                // košík vyčistený v syncToServer
                // auto-send (odpočet skladu) pred uzávierkou
                val sresp = withContext(Dispatchers.IO) { Api.service.sendAndPrint(ord.id, SendReq(false)) }
                withContext(Dispatchers.IO) { printItems(sresp.items, ord.id, storno = false) }
                val resp = withContext(Dispatchers.IO) { Api.service.closeStaffMeal(ord.id, StaffMealReq(overrideLimit = overrideLimit)) }
                haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                showStaffMeal = false
                val cogs = resp.totalCogs?.toDoubleOrNull()
                toast = if (cogs != null) "Zamestnanecká spotreba zaznamenaná — náklad: ${money(cogs)}"
                        else "Zamestnanecká spotreba zaznamenaná"
                Store.saveLastTable(null); onBack()
            } catch (e: Exception) {
                if (e.httpCode() == 422 && !overrideLimit) {
                    showStaffMeal = false
                    gate(errorMessage(e) + " Pokračovať?") { doStaffMeal(overrideLimit = true) }
                } else error = errorMessage(e)
            } finally { busy = false }
        }
    }

    fun doMerge() {
        val target = current ?: return
        busy = true; error = null
        scope.launch {
            try {
                val others = accounts.filter { it.id != target.id }
                withContext(Dispatchers.IO) {
                    others.forEach { o ->
                        val ids = o.items.map { it.id }
                        if (ids.isNotEmpty())
                            Api.service.moveItems(o.id, MoveReq(itemIds = ids, targetTableId = tableId, targetOrderId = target.id))
                        else runCatching { Api.service.deleteOrder(o.id) }
                    }
                }
                showMerge = false; toast = "Účty spojené"; reload(target.id, quiet = true)
            } catch (e: Exception) { error = errorMessage(e) } finally { busy = false }
        }
    }

    /** Po odobratí poslednej položky uvoľni stôl — zmaž prázdnu objednávku (web parita). */
    suspend fun deleteOrderIfEmpty(orderId: Int) {
        val fresh = withContext(Dispatchers.IO) { Api.service.tableOrders(tableId) }
        // Kontrolujeme OPEROVANÚ objednávku (nie current — používateľ mohol
        // medzitým prepnúť na iný účet).
        val cur = fresh.firstOrNull { it.id == orderId }
        if (cur != null && cur.items.isEmpty() && newItems.isEmpty()) {
            try {
                withContext(Dispatchers.IO) { Api.service.deleteOrder(cur.id) }
            } catch (e: Exception) {
                if (e.httpCode() == 403) toast = "Objednávku s platbou môže zrušiť len manažér."
            }
        }
    }

    /** Zaeviduj storno dôvod (kumuluje rýchle '−' na tej istej položke). */
    fun promptStornoReason(it2: OrderItemDto, qty: Int) {
        val idx = stornoPrompts.indexOfFirst { it.menuItemId == it2.menuItemId }
        if (idx >= 0) stornoPrompts[idx] = stornoPrompts[idx].copy(qty = stornoPrompts[idx].qty + qty)
        else stornoPrompts.add(StornoPrompt(it2.menuItemId, it2.name, qty, it2.price, current?.id))
    }

    // Zmena qty server položky
    fun serverItemDelta(it2: OrderItemDto, d: Int) {
        val ord = current ?: return
        if (d < 0 && busy) return   // hold-repeat / spam guard — server ops sa neserializujú
        if (d > 0) {
            val mi = itemById[it2.menuItemId] ?: MenuItemDto(it2.menuItemId, it2.name, it2.emoji, it2.price)
            if (needsSaucePicker(mi.name)) saucePending = mi else addCartLine(mi, it2.note)
            return
        }
        // Znižovanie: najprv skonzumuj unsent dvojča v košíku — žiadne storno,
        // žiadny PIN (web parita: '−' na sent riadku najprv berie z twin-u).
        if (it2.sent) {
            val twinIdx = newItems.indexOfFirst { it.menuItemId == it2.menuItemId && it.note == it2.note && it.companionOfUid == null }
            if (twinIdx >= 0) { cartDelta(newItems[twinIdx].uid, -1); return }
        }
        val apply = {
            busy = true; error = null
            scope.launch {
                try {
                    // 1. server zmena NAJPRV (web parita: storno bon až keď DELETE prešiel)
                    withContext(Dispatchers.IO) {
                        if (it2.qty <= 1) Api.service.deleteItem(ord.id, it2.id)
                        else Api.service.updateItem(ord.id, it2.id, UpdateItemReq(qty = it2.qty - 1, version = ord.version))
                    }
                    // 2. storno bon do kuchyne/baru — položka už je odobratá;
                    // zlyhanie bonu (403 cisnik / offline) NESMIE zhodiť flow,
                    // ale čašník sa to musí dozvedieť.
                    if (it2.sent) {
                        try {
                            val resp = withContext(Dispatchers.IO) {
                                Api.service.sendStornoAndPrint(ord.id, StornoSendReq(listOf(NewItem(it2.menuItemId, 1, it2.note))))
                            }
                            val pt = withContext(Dispatchers.IO) { printItems(resp.items, ord.id, storno = true) }
                            pt?.let { toast = it }
                        } catch (pe: Exception) {
                            toast = "Položka odobratá, ale storno bon zlyhal: ${errorMessage(pe)}"
                        }
                        // 3. dôvod storna → /storno-basket
                        promptStornoReason(it2, 1)
                    }
                    if (it2.qty <= 1) deleteOrderIfEmpty(ord.id)
                    reload(ord.id, quiet = true)
                } catch (e: Exception) {
                    when {
                        e.httpCode() == 409 -> { reload(ord.id, quiet = true); toast = "Objednávka bola medzitým zmenená — skontroluj a zopakuj." }
                        e.isTransportError() && it2.qty <= 1 -> {
                            // Offline DELETE → retry queue (web _pendingRemovals parita)
                            Store.queueRemoval(ord.id, it2.id)
                            toast = "Offline — odobratie sa dokončí po obnove spojenia"
                        }
                        else -> error = errorMessage(e)
                    }
                } finally { busy = false }
            }
        }
        if (it2.sent && !isManager) gate("Storno: 1× ${it2.name}") { apply() } else apply()
    }

    fun removeServerItem(it2: OrderItemDto) {
        val ord = current ?: return
        if (busy) return
        val apply = {
            busy = true
            scope.launch {
                try {
                    withContext(Dispatchers.IO) { Api.service.deleteItem(ord.id, it2.id) }
                    if (it2.sent) {
                        try {
                            val resp = withContext(Dispatchers.IO) {
                                Api.service.sendStornoAndPrint(ord.id, StornoSendReq(listOf(NewItem(it2.menuItemId, it2.qty, it2.note))))
                            }
                            val pt = withContext(Dispatchers.IO) { printItems(resp.items, ord.id, storno = true) }
                            pt?.let { toast = it }
                        } catch (pe: Exception) {
                            toast = "Položka odobratá, ale storno bon zlyhal: ${errorMessage(pe)}"
                        }
                        promptStornoReason(it2, it2.qty)
                    }
                    deleteOrderIfEmpty(ord.id)
                    reload(ord.id, quiet = true)
                } catch (e: Exception) {
                    if (e.isTransportError()) {
                        Store.queueRemoval(ord.id, it2.id)
                        toast = "Offline — odobratie sa dokončí po obnove spojenia"
                    } else error = errorMessage(e)
                } finally { busy = false }
            }
        }
        if (it2.sent && !isManager) gate("Storno: ${it2.qty}× ${it2.name}") { apply() } else apply()
    }

    fun saveServerNote(it2: OrderItemDto, note: String) {
        val ord = current ?: return
        busy = true
        scope.launch {
            try {
                withContext(Dispatchers.IO) { Api.service.updateItem(ord.id, it2.id, UpdateItemReq(note = note, version = ord.version)) }
                reload(ord.id, quiet = true)
            } catch (e: Exception) {
                if (e.httpCode() == 409) { reload(ord.id, quiet = true); toast = "Objednávka bola medzitým zmenená — skontroluj." }
                else error = errorMessage(e)
            } finally { busy = false }
        }
    }

    // Uzávierka z objednávky (web: logout vždy cez uzávierku, z hociktorého view)
    fun startCloseFlow() {
        flushAndLeave {
            showCloseShift = true; closeSummary = null; closeError = null
            scope.launch {
                try { closeSummary = withContext(Dispatchers.IO) { Api.service.shiftSummary() } }
                catch (_: Exception) { showCloseShift = false; onLogout() }
            }
        }
    }
    fun confirmCloseShift(actual: Double) {
        closeBusy = true; closeError = null
        scope.launch {
            try {
                withContext(Dispatchers.IO) { Api.service.shiftClose(CloseShiftReq(actual)) }
                showCloseShift = false; onLogout()
            } catch (e: Exception) { closeError = "Uzávierka zlyhala. Skús znova alebo len odhlás." }
            finally { closeBusy = false }
        }
    }

    // ---------- odvodené ----------
    val cartSubtotal = newItems.sumOf { it.price * it.qty }
    val serverSubtotal = current?.subtotal ?: 0.0
    val discount = current?.discount ?: 0.0
    val grandTotal = (serverSubtotal + cartSubtotal - discount).coerceAtLeast(0.0)
    val hasItems = (current?.items?.isNotEmpty() == true) || newItems.isNotEmpty()
    val sentQty = current?.items?.filter { it.sent }?.sumOf { it.qty } ?: 0
    // Počet kusov v účte per menuItemId — qty badge na produktových kartách
    val inOrderQty = remember(current, newItems.size, newItems.toList()) {
        val m = mutableMapOf<Int, Int>()
        current?.items?.forEach { m[it.menuItemId] = (m[it.menuItemId] ?: 0) + it.qty }
        newItems.forEach { m[it.menuItemId] = (m[it.menuItemId] ?: 0) + it.qty }
        m
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            Column {
                PosHeader(activeTab = "objednavka", userName = AppPrefs.userName,
                    onStoly = { flushAndLeave(onBack) },
                    onLogout = { startCloseFlow() },
                    onRefresh = { reload() })
                OfflineBanner()
            }
        }
    ) { pad ->
        if (loading) {
            Box(Modifier.fillMaxSize().padding(pad)) { CircularProgressIndicator(Modifier.align(Alignment.Center)) }
            return@Scaffold
        }
        Row(Modifier.fillMaxSize().padding(pad)) {
            // ── Ľavá: hľadanie + kategórie + menu ──
            Column(Modifier.weight(1.7f).padding(12.dp)) {
                OutlinedTextField(
                    value = search, onValueChange = { search = it },
                    placeholder = { Text("Hľadať produkt alebo kategóriu…") },
                    leadingIcon = { Icon(Icons.Filled.Search, null) },
                    singleLine = true, modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    categories.forEachIndexed { i, c -> CatChip(c, i == selectedCat) { selectedCat = i; search = "" } }
                }
                Spacer(Modifier.height(10.dp))
                // Hľadanie zahŕňa aj desc (web parita) + logické triedenie
                val items = if (search.isBlank()) categories.getOrNull(selectedCat)?.items.orEmpty()
                            else categories.flatMap { it.items }.distinctBy { it.id }
                                .filter { it.name.contains(search, ignoreCase = true)
                                       || it.desc.contains(search, ignoreCase = true) }
                                .sortedWith(menuLogicComparator)
                val catColorById = remember(categories) {
                    buildMap {
                        categories.forEach { c ->
                            val col = CAT_COLORS[c.slug]
                            if (col != null) c.items.forEach { put(it.id, col) }
                        }
                    }
                }
                LazyVerticalGrid(
                    columns = GridCells.Adaptive(minSize = 132.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    items(items, key = { it.id }) { mi ->
                        ProductCard(mi, inOrderQty[mi.id] ?: 0, catColorById[mi.id],
                            onClick = { productTap(mi) },
                            onLongClick = { if (!needsSaucePicker(mi.name)) qtyPopupFor = mi })
                    }
                }
            }

            // ── Pravá: objednávka ──
            Surface(Modifier.weight(1f).fillMaxHeight(), color = MaterialTheme.colorScheme.surfaceVariant, tonalElevation = 1.dp) {
                Column(Modifier.fillMaxSize().padding(14.dp)) {
                    // hlavička + účty
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(tables.firstOrNull { it.id == tableId }?.name ?: "Stôl #$tableId",
                            style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                        if (sentQty > 0) Text("$sentQty ks v kuchyni", style = MaterialTheme.typography.labelMedium, color = Sage)
                    }
                    // účty (taby s meta: počet pol. + suma — web parita)
                    Row(Modifier.horizontalScroll(rememberScrollState()).padding(top = 6.dp),
                        horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                        accounts.forEach { acc ->
                            val cnt = acc.items.sumOf { it.qty }
                            AccountTab(acc.label.ifBlank { "Účet #${acc.id}" },
                                if (cnt > 0) "$cnt pol. · ${money(acc.grandTotal)}" else "prázdny",
                                acc.id == current?.id) {
                                if (moveMode) moveSelectedTo(acc.id, tableId) else current = acc
                            }
                        }
                        AccountTab("+", null, false) { if (!moveMode) newAccount() else moveSelectedToNewAccount() }
                        if (accounts.size >= 2 && !moveMode) AccountTab("⇄ spojiť", null, false) { showMerge = true }
                    }
                    if (moveMode) {
                        Spacer(Modifier.height(4.dp))
                        Text("Presun: vyber položky a cieľový účet / stôl",
                            style = MaterialTheme.typography.labelSmall, color = Navy)
                    }
                    Spacer(Modifier.height(8.dp))

                    // položky
                    Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        current?.items?.forEach { it2 ->
                            if (moveMode) {
                                // Annotation riadky (Omáčka) sa nepresúvajú samostatne
                                if (it2.name == SAUCE_ANNOTATION) return@forEach
                                MoveSelectRow(it2, moveSelection[it2.id],
                                    selected = moveSelection.containsKey(it2.id),
                                    onToggle = {
                                        if (moveSelection.containsKey(it2.id)) moveSelection.remove(it2.id)
                                        else if (it2.qty > 1) moveQtyPickFor = it2
                                        else moveSelection[it2.id] = null
                                    })
                            } else {
                                ServerItemRow(it2,
                                    onMinus = { serverItemDelta(it2, -1) },
                                    onPlus = { serverItemDelta(it2, +1) },
                                    onNote = { noteServerItem = it2 },
                                    onMove = { enterMoveMode(it2) },
                                    onRemove = { if (it2.qty > 1) confirmRemove = it2 else removeServerItem(it2) })
                            }
                        }
                        if (!moveMode) newItems.forEach { line ->
                            CartRow(line,
                                onMinus = { cartDelta(line.uid, -1) },
                                onPlus = { cartDelta(line.uid, +1) },
                                onNote = { noteCartUid = line.uid },
                                onRemove = { cartDelta(line.uid, -line.qty) })
                        }
                        if (!hasItems) Text("Prázdna objednávka — vyber položky vľavo.",
                            style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }

                    HorizontalDivider(Modifier.padding(vertical = 8.dp))
                    if (discount > 0) {
                        Row { Text("Medzisúčet", Modifier.weight(1f), color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Text(money(serverSubtotal + cartSubtotal)) }
                        Row { Text("Zľava", Modifier.weight(1f), color = Sage); Text("- ${money(discount)}", color = Sage) }
                    }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("CELKOM", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
                        Text(money(grandTotal), style = MaterialTheme.typography.titleLarge, color = Terra)
                    }
                    error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }

                    Spacer(Modifier.height(8.dp))
                    if (moveMode) {
                        // Move mode action bar
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Button(onClick = { showMoveTablePicker = true },
                                enabled = moveSelection.isNotEmpty() && !busy,
                                modifier = Modifier.weight(1f).height(48.dp),
                                colors = ButtonDefaults.buttonColors(containerColor = Sage, contentColor = Cream)) {
                                Text("Na iný stôl")
                            }
                            OutlinedButton(onClick = { exitMoveMode() }, modifier = Modifier.weight(1f).height(48.dp)) {
                                Text("Zrušiť presun")
                            }
                        }
                    } else {
                        // akčné tlačidlá (web parita)
                        Button(onClick = { doSend() }, enabled = canSendNow && !busy,
                            colors = ButtonDefaults.buttonColors(containerColor = Amber, contentColor = Espresso),
                            modifier = Modifier.fillMaxWidth().height(52.dp)) {
                            if (busy) CircularProgressIndicator(Modifier.size(20.dp), color = Espresso, strokeWidth = 2.dp)
                            else Text("Poslať objednávku", style = MaterialTheme.typography.labelLarge)
                        }
                        Spacer(Modifier.height(6.dp))
                        OutlinedButton(onClick = { doPreBill() }, enabled = hasItems && !busy,
                            modifier = Modifier.fillMaxWidth().height(46.dp),
                            border = BorderStroke(1.dp, Navy)) { Text("Predúčet", color = Navy) }
                        Spacer(Modifier.height(6.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Button(onClick = { payInitMethod = "hotovost"; payError = null; payFiscal = null
                                payNonce = java.util.UUID.randomUUID().toString(); showPay = true },
                                enabled = hasItems && !busy, modifier = Modifier.weight(1f).height(48.dp),
                                colors = ButtonDefaults.buttonColors(containerColor = Terra, contentColor = Cream)) { Text("Hotovosť") }
                            Button(onClick = { payInitMethod = "karta"; payError = null; payFiscal = null
                                payNonce = java.util.UUID.randomUUID().toString(); showPay = true },
                                enabled = hasItems && !busy, modifier = Modifier.weight(1f).height(48.dp),
                                colors = ButtonDefaults.buttonColors(containerColor = Terra, contentColor = Cream)) { Text("Karta") }
                        }
                        if (tables.firstOrNull { it.id == tableId }?.zone == "zamestanci") {
                            Spacer(Modifier.height(6.dp))
                            OutlinedButton(onClick = { showStaffMeal = true }, enabled = hasItems && !busy,
                                modifier = Modifier.fillMaxWidth().height(46.dp),
                                colors = ButtonDefaults.outlinedButtonColors(contentColor = Amber),
                                border = BorderStroke(1.dp, Amber.copy(alpha = 0.5f))) { Text("Zamestnanecká spotreba") }
                        }
                        Spacer(Modifier.height(6.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            ExtraBtn("Presun účet", Sage, Modifier.weight(1f), hasItems && !busy) { showMovePicker = true }
                            ExtraBtn("Rozdeliť", Terra, Modifier.weight(1f), hasItems && !busy) { splitError = null; showSplit = true }
                            ExtraBtn("Zľava", Amber, Modifier.weight(1f), hasItems && !busy) { discountError = null; showDiscount = true }
                        }
                        Spacer(Modifier.height(6.dp))
                        TextButton(onClick = { showCancel = true }, enabled = (hasItems || current != null) && !busy,
                            modifier = Modifier.fillMaxWidth()) { Text("Zrušiť objednávku", color = Danger) }
                    }
                }
            }
        }
    }

    // ---------- dialógy ----------
    saucePending?.let { mi ->
        SauceDialog(mi.name, previous = lastSauceFor(mi.name),
            onConfirm = { sauces -> addComboWithSauce(mi, sauces); saucePending = null },
            onDismiss = { saucePending = null })
    }
    qtyPopupFor?.let { mi ->
        QtyPopupDialog(mi.name, onPick = { n -> productTap(mi, n); qtyPopupFor = null },
            onDismiss = { qtyPopupFor = null })
    }
    noteCartUid?.let { uid ->
        val line = newItems.firstOrNull { it.uid == uid }
        if (line != null) NoteDialog(line.note, sent = false, onSave = { n ->
            val i = newItems.indexOfFirst { it.uid == uid }
            if (i >= 0) { newItems[i] = newItems[i].copy(note = n); persistDraft() }
            noteCartUid = null
        }, onDismiss = { noteCartUid = null })
        else noteCartUid = null
    }
    noteServerItem?.let { it2 ->
        NoteDialog(it2.note, sent = it2.sent, onSave = { saveServerNote(it2, it); noteServerItem = null },
            onDismiss = { noteServerItem = null })
    }
    if (showPay) {
        val previewItems = (current?.items.orEmpty().filter { it.name != SAUCE_ANNOTATION }
            .map { PrintItem(it.qty, it.name, it.note, it.price, it.emoji) } +
            newItems.filter { it.name != SAUCE_ANNOTATION }
                .map { PrintItem(it.qty, it.name, it.note, it.price, it.emoji) })
        PaymentDialog(
            total = grandTotal, items = previewItems,
            tableName = tables.firstOrNull { it.id == tableId }?.name ?: "Stôl $tableId",
            staffName = AppPrefs.userName ?: "",
            subtotal = serverSubtotal + cartSubtotal, discount = discount,
            busy = busy, error = payError, fiscalNote = payFiscal, initialMethod = payInitMethod,
            onPay = { method, given -> doPay(method, given) },
            onDismiss = { if (!busy) showPay = false })
    }
    underpayConfirm?.let { (method, given) ->
        ConfirmDialog("Zákazník dal menej",
            "Zadaná hotovosť ${money(given)} je menšia ako suma účtu ${money(grandTotal)}. Naozaj uzavrieť účet?",
            confirmLabel = "Uzavrieť účet", dismissLabel = "Späť", danger = true, busy = busy,
            onConfirm = { underpayConfirm = null; doPay(method, given, underpayConfirmed = true) },
            onDismiss = { underpayConfirm = null })
    }
    paragonOffer?.let { reason ->
        ConfirmDialog("eKasa nedostupná",
            "Portos / eKasa nereaguje. Môžete vystaviť PARAGÓN (náhradný doklad). Po obnove sa automaticky zaregistruje v eKasa systéme.",
            confirmLabel = "Vystaviť paragón", danger = true, busy = busy,
            onConfirm = { issueParagon(reason) },
            onDismiss = { paragonOffer = null })
    }
    stornoPrompts.firstOrNull()?.let { sp ->
        StornoReasonDialog(sp.name, sp.qty,
            onConfirm = { res ->
                stornoPrompts.removeAt(0)
                scope.launch {
                    val req = StornoBasketReq(menuItemId = sp.menuItemId, qty = sp.qty, name = sp.name,
                        unitPrice = sp.unitPrice, reason = res.reason, note = res.note,
                        wasPrepared = res.wasPrepared, orderId = sp.orderId)
                    try {
                        withContext(Dispatchers.IO) { Api.service.stornoBasket(req) }
                        toast = "✔ Storno zapísané"
                    } catch (e: Exception) {
                        val code = e.httpCode()
                        if (e.isTransportError() || (code ?: 0) >= 500) {
                            Store.queueStorno(req)
                            toast = "Storno zápis zlyhal — uložené, skúsim znova po obnove spojenia"
                        } else toast = "Storno zápis zlyhal (${code ?: "?"}) — zavolaj manažéra"
                    }
                }
            },
            onDismiss = { stornoPrompts.removeAt(0) })
    }
    if (showDiscount) DiscountDialog(discountsList, discount > 0, busy, discountError,
        onApplyPreset = { applyDiscountPreset(it) }, onApplyCustom = { applyDiscountCustom(it) },
        onRemove = { removeDiscount() }, onDismiss = { showDiscount = false })
    if (showSplit) SplitDialog(
        current?.items.orEmpty(), grandTotal, busy, splitError,
        onEqual = { doSplitEqual(it) }, onByItems = { doSplitItems(it) }, onDismiss = { showSplit = false })
    if (showMovePicker) TablePickerDialog(tables, tableId, busy, onPick = { doMove(it) }, onDismiss = { showMovePicker = false })
    if (showMoveTablePicker) TablePickerDialog(tables, tableId, busy,
        onPick = { moveSelectedTo(null, it) }, onDismiss = { showMoveTablePicker = false })
    moveQtyPickFor?.let { item ->
        MoveQtyPickerDialog(item.name, item.emoji, item.price, item.qty,
            onConfirm = { q -> moveSelection[item.id] = if (q >= item.qty) null else q; moveQtyPickFor = null },
            onDismiss = { moveQtyPickFor = null })
    }
    confirmRemove?.let { it2 ->
        ConfirmDialog("Odobrať položku?",
            "${it2.qty}× ${it2.name} (${money(it2.price * it2.qty)})" + if (it2.sent) " — odoslané položky budú stornované." else "",
            confirmLabel = "Odobrať", danger = true, busy = busy,
            onConfirm = { confirmRemove = null; removeServerItem(it2) },
            onDismiss = { confirmRemove = null })
    }
    if (showMerge) {
        val others = accounts.filter { it.id != current?.id }
        val othersTotal = others.sumOf { it.grandTotal }
        val targetLabel = current?.label?.ifBlank { "Účet #${current?.id}" } ?: ""
        ConfirmDialog("Spojiť účty?",
            "${others.size} ${if (others.size == 1) "účet" else if (others.size < 5) "účty" else "účtov"} (${money(othersTotal)}) sa spojí do účtu $targetLabel.",
            confirmLabel = "Spojiť", busy = busy, onConfirm = { doMerge() }, onDismiss = { showMerge = false })
    }
    if (showStaffMeal) ConfirmDialog("Zamestnanecká spotreba?",
        "Hodnota menu: ${money(grandTotal)}. ŽIADNA platba a ŽIADNY fiškál sa nevytvorí. Sklad sa odpíše normálne (cez recepty).",
        confirmLabel = "Potvrdiť", busy = busy, onConfirm = { doStaffMeal() }, onDismiss = { showStaffMeal = false })
    if (showCancel) ConfirmDialog("Zrušiť objednávku?",
        "Naozaj zrušiť celú objednávku na tomto stole?" + if (sentQty > 0) " Odoslané položky budú stornované." else "",
        confirmLabel = "Zrušiť objednávku", danger = true, busy = busy,
        onConfirm = { doCancel() }, onDismiss = { showCancel = false })
    if (showAccountPicker) AccountPickerDialog(accounts,
        onPick = { id -> current = accounts.firstOrNull { it.id == id }; showAccountPicker = false },
        onNew = { showAccountPicker = false; newAccount() },
        onDismiss = { showAccountPicker = false })
    if (showCloseShift) CloseShiftDialog(
        summary = closeSummary, busy = closeBusy, error = closeError,
        onClose = { confirmCloseShift(it) },
        onJustLogout = { showCloseShift = false; onLogout() },
        onDismiss = { if (!closeBusy) showCloseShift = false })
    gateLabel?.let { lbl ->
        ManagerPinDialog(lbl, onVerified = {
            val a = gateAction; gateLabel = null; gateAction = null; a?.invoke()
        }, onDismiss = { gateLabel = null; gateAction = null })
    }
}

/* ============================ Row composables ============================ */

@Composable
private fun AccountTab(label: String, meta: String?, active: Boolean, onClick: () -> Unit) {
    Surface(onClick = onClick, shape = RoundedCornerShape(999.dp),
        color = if (active) Terra else MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, if (active) Terra else MaterialTheme.colorScheme.outline)) {
        Column(Modifier.padding(horizontal = 14.dp, vertical = 5.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(label, color = if (active) Cream else MaterialTheme.colorScheme.onSurface,
                fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.labelMedium, maxLines = 1)
            meta?.let {
                Text(it, color = if (active) Cream.copy(alpha = 0.85f) else MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.labelSmall, maxLines = 1)
            }
        }
    }
}

@Composable
private fun ServerItemRow(
    it: OrderItemDto,
    onMinus: () -> Unit, onPlus: () -> Unit,
    onNote: () -> Unit, onMove: () -> Unit, onRemove: () -> Unit,
) {
    Column {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (it.sent) {
                Icon(Icons.Filled.Check, "odoslané", Modifier.size(15.dp), tint = Sage)
                Spacer(Modifier.width(3.dp))
            }
            Text("${it.emoji} ${it.name}", Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium,
                maxLines = 1, overflow = TextOverflow.Ellipsis, color = if (it.sent) Sage else MaterialTheme.colorScheme.onSurface)
            StepBtn("−", onMinus)
            Text("${it.qty}", Modifier.width(24.dp), style = MaterialTheme.typography.labelMedium,
                color = Terra, fontWeight = FontWeight.Bold)
            StepBtn("+", onPlus)
            Spacer(Modifier.width(4.dp))
            IconMini(Icons.AutoMirrored.Filled.ArrowForward, "presunúť", onMove, tint = Sage)
            IconMini(Icons.Filled.Edit, "poznámka", onNote)
            IconMini(Icons.Filled.Close, "odobrať", onRemove, tint = Danger)
            Spacer(Modifier.width(4.dp))
            Text(money(it.price * it.qty), style = MaterialTheme.typography.bodyMedium)
        }
        if (it.note.isNotBlank()) Text("• ${it.note}", style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 18.dp))
    }
}

@Composable
private fun MoveSelectRow(it: OrderItemDto, selQty: Int?, selected: Boolean, onToggle: () -> Unit) {
    Surface(onClick = onToggle, shape = RoundedCornerShape(8.dp),
        color = if (selected) Terra.copy(alpha = 0.10f) else MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, if (selected) Terra else MaterialTheme.colorScheme.outline),
        modifier = Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp)) {
            Icon(if (selected) Icons.Filled.Check else Icons.Filled.Close, null, Modifier.size(16.dp),
                tint = if (selected) Terra else MaterialTheme.colorScheme.outline)
            Spacer(Modifier.width(8.dp))
            Text("${it.emoji} ${it.name}", Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (it.qty > 1) {
                val badge = if (selected && selQty != null && selQty < it.qty) "$selQty/${it.qty}" else "${it.qty}×"
                Text(badge, style = MaterialTheme.typography.labelSmall,
                    color = if (selected) Terra else MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.width(6.dp))
            }
            Text(money(it.price * (selQty ?: it.qty)), style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Composable
private fun CartRow(line: CartLine, onMinus: () -> Unit, onPlus: () -> Unit, onNote: () -> Unit, onRemove: () -> Unit) {
    Column {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("${line.emoji} ${line.name}", Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
            StepBtn("−", onMinus)
            Text("${line.qty}", Modifier.width(24.dp), style = MaterialTheme.typography.labelMedium,
                color = Terra, fontWeight = FontWeight.Bold)
            StepBtn("+", onPlus)
            Spacer(Modifier.width(4.dp))
            IconMini(Icons.Filled.Edit, "poznámka", onNote)
            IconMini(Icons.Filled.Close, "odobrať", onRemove, tint = Danger)
            Spacer(Modifier.width(4.dp))
            Text(money(line.price * line.qty), style = MaterialTheme.typography.bodyMedium)
        }
        if (line.note.isNotBlank()) Text("• ${line.note}", style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 4.dp))
    }
}

@Composable
private fun IconMini(icon: androidx.compose.ui.graphics.vector.ImageVector, cd: String, onClick: () -> Unit, tint: Color = Terra) {
    IconButton(onClick = onClick, modifier = Modifier.size(30.dp)) {
        Icon(icon, cd, Modifier.size(17.dp), tint = tint)
    }
}

@Composable
private fun ExtraBtn(label: String, color: Color, modifier: Modifier, enabled: Boolean, onClick: () -> Unit) {
    OutlinedButton(onClick = onClick, enabled = enabled, modifier = modifier.height(44.dp),
        contentPadding = PaddingValues(horizontal = 4.dp),
        colors = ButtonDefaults.outlinedButtonColors(contentColor = color),
        border = BorderStroke(1.dp, color.copy(alpha = 0.5f))) {
        Text(label, style = MaterialTheme.typography.labelSmall, maxLines = 1)
    }
}

@Composable
private fun CatChip(c: CategoryDto, active: Boolean, onClick: () -> Unit) {
    Surface(onClick = onClick, shape = RoundedCornerShape(10.dp),
        color = if (active) Terra.copy(alpha = 0.12f) else MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, if (active) Terra.copy(alpha = 0.40f) else MaterialTheme.colorScheme.outline)) {
        Text("${c.icon} ${c.label}", Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
            color = if (active) Terra else MaterialTheme.colorScheme.onSurface,
            fontWeight = if (active) FontWeight.ExtraBold else FontWeight.SemiBold,
            style = MaterialTheme.typography.bodyMedium, maxLines = 1)
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ProductCard(
    mi: MenuItemDto,
    inOrderQty: Int,
    catColor: Color?,
    onClick: () -> Unit,
    onLongClick: () -> Unit,
) {
    Surface(shape = RoundedCornerShape(10.dp),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline), tonalElevation = 1.dp,
        modifier = Modifier.height(96.dp)) {
        Box(Modifier.fillMaxSize()
            .background(Brush.verticalGradient(listOf(Cream, CreamElev)))
            .combinedClickable(onClick = onClick, onLongClick = onLongClick)) {
            // Per-kategória akcent — farebná horná hrana (web --cat-color)
            catColor?.let {
                Box(Modifier.fillMaxWidth().height(3.dp).background(it.copy(alpha = 0.65f)).align(Alignment.TopCenter))
            }
            Column(Modifier.fillMaxSize().padding(10.dp)) {
                Surface(shape = RoundedCornerShape(8.dp),
                    color = (catColor ?: Terra).copy(alpha = 0.10f), modifier = Modifier.size(34.dp)) {
                    Box(contentAlignment = Alignment.Center) { Text(mi.emoji, fontSize = 18.sp) }
                }
                Spacer(Modifier.weight(1f))
                Text(mi.name, style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(money(mi.price), style = MaterialTheme.typography.labelLarge, color = Terra)
            }
            // Qty badge — koľko kusov je už v účte (web parita)
            if (inOrderQty > 0) {
                Surface(shape = RoundedCornerShape(999.dp), color = Terra,
                    modifier = Modifier.align(Alignment.TopEnd).padding(6.dp)) {
                    Text("$inOrderQty", Modifier.padding(horizontal = 7.dp, vertical = 2.dp),
                        color = Cream, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold)
                }
            }
        }
    }
}

/** Stepper s hold-to-repeat (web startQtyHold parita: 400 ms delay, 150 ms tick). */
@Composable
private fun StepBtn(label: String, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    // rememberUpdatedState — repeat loop musí volať NAJNOVŠÍ onClick (po
    // recompozícii s čerstvým OrderItemDto), nie lambdu z času stlačenia.
    val currentOnClick by rememberUpdatedState(onClick)
    LaunchedEffect(pressed) {
        if (pressed) {
            delay(400)
            while (true) { currentOnClick(); delay(150) }
        }
    }
    Surface(onClick = onClick, interactionSource = interaction,
        shape = RoundedCornerShape(7.dp), color = Terra.copy(alpha = 0.10f), modifier = Modifier.size(30.dp)) {
        Box(contentAlignment = Alignment.Center) { Text(label, color = Terra, fontWeight = FontWeight.Bold, fontSize = 17.sp) }
    }
}
