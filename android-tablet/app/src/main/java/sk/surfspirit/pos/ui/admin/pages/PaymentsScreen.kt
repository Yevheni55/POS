package sk.surfspirit.pos.ui.admin.pages

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Query
import sk.surfspirit.pos.core.errorBody
import sk.surfspirit.pos.core.errorMessage
import sk.surfspirit.pos.core.fmtCost
import sk.surfspirit.pos.core.isManager
import sk.surfspirit.pos.core.parseErrorJson
import sk.surfspirit.pos.core.str
import sk.surfspirit.pos.net.Api
import sk.surfspirit.pos.ui.admin.AdminCard
import sk.surfspirit.pos.ui.admin.AdminConfirm
import sk.surfspirit.pos.ui.admin.AdminScreenBox
import sk.surfspirit.pos.ui.admin.AdminSectionTitle
import sk.surfspirit.pos.ui.admin.EmptyHint
import sk.surfspirit.pos.ui.admin.ErrorBox
import sk.surfspirit.pos.ui.admin.LoadingBox
import sk.surfspirit.pos.ui.admin.PillTabs
import sk.surfspirit.pos.ui.admin.StatusBadge
import sk.surfspirit.pos.ui.components.LocalToast
import sk.surfspirit.pos.ui.theme.Amber
import sk.surfspirit.pos.ui.theme.BorderSoft
import sk.surfspirit.pos.ui.theme.Cream
import sk.surfspirit.pos.ui.theme.Danger
import sk.surfspirit.pos.ui.theme.EspressoDim
import sk.surfspirit.pos.ui.theme.Navy
import sk.surfspirit.pos.ui.theme.Sage

/* =====================================================================
   PaymentsScreen — natívna parita admin/pages/payments.js
   „História platieb" — prvý tab historia.js shellu (#historia/platby).
   Zoznam platieb s fiškálnym stavom + manager-only akcie:
   kópia bločku · re-fiškalizácia · zmena metódy · fiškálne STORNO.
   ===================================================================== */

/* ---- DTOs (prefix Pmt; amount je JSON number — server ho predkonvertuje) ---- */

@Serializable
private data class PmtFiscalDoc(
    val externalId: String = "",
    val status: String = "",
    val receiptId: String? = null,
    val receiptNumber: Long? = null,
    val okp: String? = null,
    val cashRegisterCode: String = "",
    val processDate: String? = null,
)

@Serializable
private data class PmtStornoDoc(
    val externalId: String = "",
    val status: String = "",
    val receiptId: String? = null,
    val receiptNumber: Long? = null,
    val okp: String? = null,
    val processDate: String? = null,
)

@Serializable
private data class PmtItem(
    val id: Int = 0,
    val orderId: Int? = null,
    val orderLabel: String? = null,
    val orderStatus: String? = null,
    val tableId: Int? = null,
    val tableName: String? = null,
    val method: String = "",
    val amount: Double? = null,
    val createdAt: String? = null,
    val fiscal: PmtFiscalDoc? = null,
    val storno: PmtStornoDoc? = null,
    val stornoEligible: Boolean = false,
    val copyAvailable: Boolean = false,
)

@Serializable
private data class PmtHistoryResp(
    val items: List<PmtItem> = emptyList(),
    val totalOrders: Int = 0,
    val scope: String = "current",
    val activeCashRegisterCode: String = "",
    val hiddenByScope: Int = 0,
)

@Serializable
private data class PmtChangeMethodReq(val newMethod: String)

private interface PmtApi {
    @GET("api/payments/history")
    suspend fun history(
        @Query("method") method: String?,
        @Query("q") q: String?,
        @Query("scope") scope: String,
        @Query("limit") limit: Int = 200,
    ): PmtHistoryResp

    @POST("api/payments/{id}/receipt-copy")
    suspend fun receiptCopy(@Path("id") id: Int, @Body body: Map<String, String> = emptyMap()): JsonElement

    @POST("api/payments/{id}/refiscalize")
    suspend fun refiscalize(@Path("id") id: Int, @Body body: Map<String, String> = emptyMap()): JsonElement

    @POST("api/payments/{id}/change-method")
    suspend fun changeMethod(@Path("id") id: Int, @Body body: PmtChangeMethodReq): JsonElement

    @POST("api/payments/{id}/fiscal-storno")
    suspend fun fiscalStorno(@Path("id") id: Int, @Body body: Map<String, String> = emptyMap()): JsonElement
}

private val pmtApi: PmtApi by lazy { Api.create(PmtApi::class.java) }

/* ---- Helpery ---- */

/** Web parita fmtEur: fmtCost(amount) + ' €' (sk-SK čiarka, sub-cent adaptívne). */
private fun pmtEur(amount: Double?): String {
    if (amount == null || !amount.isFinite()) return "—"
    return fmtCost(amount) + " €"
}

private fun pmtMethodLabel(method: String): String = when (method) {
    "hotovost" -> "Hotovosť"
    "karta" -> "Karta"
    else -> method.ifBlank { "—" }
}

/** Web parita actionsCell tone: green=success, amber=accepted, red=ambig/error/…, inak grey. */
private fun pmtFiscalTone(status: String): Color {
    val s = status.lowercase()
    return when {
        s.contains("success") -> Sage
        s.contains("accepted") -> Amber
        Regex("ambig|error|reject|block|valid").containsMatchIn(s) -> Danger
        else -> EspressoDim
    }
}

/** Re-fiškalizovať tlačidlo má byť zvýraznené pre mismatch/ambiguous/rejected. */
private fun pmtNeedsRefiscalize(status: String): Boolean =
    status == "mismatch_rejected" || status == "ambiguous" || status == "rejected"

/**
 * Web parita extrakcie: e.data?.error || e.data?.detail || e.message.
 * Native errorMessage() už ťahá {error} z tela; tu doplníme aj {detail}.
 */
private fun pmtErrorMessage(e: Throwable, fallback: String): String {
    val body = parseErrorJson(e.errorBody())
    val msg = body?.str("error") ?: body?.str("detail")
    if (!msg.isNullOrBlank()) return msg
    val generic = errorMessage(e)
    return generic.ifBlank { fallback }
}

/* ---- Detail / akcie modal ---- */

private sealed interface PmtConfirm {
    val id: Int
    data class Refiscalize(override val id: Int) : PmtConfirm
    data class ChangeMethod(override val id: Int, val newMethod: String, val newLabel: String) : PmtConfirm
    data class Storno(override val id: Int) : PmtConfirm
}

@Composable
fun PaymentsScreen() {
    val toast = LocalToast.current
    val scope = rememberCoroutineScope()

    var loading by remember { mutableStateOf(true) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    var items by remember { mutableStateOf<List<PmtItem>>(emptyList()) }
    var hiddenByScope by remember { mutableStateOf(0) }
    var activeCashRegisterCode by remember { mutableStateOf("") }

    // filter (modul-level v webe; tu remember) — žiadny localStorage.
    var scopeAll by remember { mutableStateOf(false) }            // false=current, true=all
    var methodTab by remember { mutableStateOf(0) }               // 0 Všetky · 1 Hotovosť · 2 Karta
    var query by remember { mutableStateOf("") }
    val methodValues = listOf("", "hotovost", "karta")

    var confirm by remember { mutableStateOf<PmtConfirm?>(null) }

    fun load() {
        scope.launch {
            loading = true
            try {
                val res = withContext(Dispatchers.IO) {
                    pmtApi.history(
                        method = methodValues[methodTab].ifBlank { null },
                        q = query.ifBlank { null },
                        scope = if (scopeAll) "all" else "current",
                        limit = 200,
                    )
                }
                items = res.items
                hiddenByScope = res.hiddenByScope
                activeCashRegisterCode = res.activeCashRegisterCode
                error = null
            } catch (e: Exception) {
                items = emptyList()
                hiddenByScope = 0
                activeCashRegisterCode = ""
                error = errorMessage(e)
            } finally {
                loading = false
            }
        }
    }

    // Akcie — po úspechu reload histórie (web parita).
    fun runAction(
        successMsg: (JsonElement) -> String,
        fallbackErr: String,
        call: suspend () -> JsonElement,
    ) {
        scope.launch {
            busy = true
            try {
                val res = withContext(Dispatchers.IO) { call() }
                toast.show(successMsg(res))
                load()
            } catch (e: Exception) {
                toast.show(pmtErrorMessage(e, fallbackErr), error = true)
            } finally {
                busy = false
            }
        }
    }

    // Jediný keyed effect: mount + zmena filtra. Debounce 250 ms zladí
    // písanie do hľadania (web parita) a zároveň „skolapsuje" rýchle prepínanie
    // scope/metódy do jedného requestu.
    LaunchedEffect(scopeAll, methodTab, query) {
        delay(250)
        load()
    }

    AdminScreenBox(scrollable = false) {
        // Jeden zdieľaný horizontálny scroll stav pre hlavičku aj všetky riadky
        // tabuľky — stĺpce ostávajú zarovnané a alokuje sa jediný ScrollState.
        // Riadky sú v LazyColumn (až 200 platieb sa nekomponuje naraz).
        val tableScroll = rememberScrollState()
        LazyColumn(Modifier.weight(1f).fillMaxWidth()) {
            item {
                AdminSectionTitle("História platieb")
                Text(
                    "Zoznam platieb s fiškálnym stavom. Pri úspešne zaevidovanom doklade sa dá " +
                        "vytlačiť kópia alebo odoslať STORNO. STORNO je dostupné iba pre platby " +
                        "registrované v Portos (online/offline/reconciled) a pokiaľ ešte nebolo odoslané.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(12.dp))
            }

            item {
                // Filter — Rozsah (eKasa) + Spôsob platby + Hľadať.
                AdminCard {
                    Text("Rozsah", style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.height(6.dp))
                    PillTabs(
                        tabs = listOf("Iba aktuálna eKasa", "Všetky (vrátane starej firmy)"),
                        selected = if (scopeAll) 1 else 0,
                        onSelect = { scopeAll = it == 1 },
                    )
                    Spacer(Modifier.height(12.dp))
                    Text("Spôsob platby", style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.height(6.dp))
                    PillTabs(
                        tabs = listOf("Všetky", "Hotovosť", "Karta"),
                        selected = methodTab,
                        onSelect = { methodTab = it },
                    )
                    Spacer(Modifier.height(12.dp))
                    OutlinedTextField(
                        value = query,
                        onValueChange = { query = it },
                        placeholder = { Text("ID platby, stôl, objednávka…") },
                        singleLine = true,
                        label = { Text("Hľadať") },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(10.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        OutlinedButton(onClick = { load() }, enabled = !busy) { Text("Obnoviť") }
                    }
                }
                Spacer(Modifier.height(8.dp))
            }

            item {
                // Scope hint (web parita renderScopeHint).
                val hint = when {
                    scopeAll ->
                        "Zobrazené sú všetky platby (vrátane platieb zo starej eKasy / inej firmy)."
                    hiddenByScope > 0 ->
                        "Zobrazené sú iba platby aktuálnej eKasy (" +
                            (activeCashRegisterCode.ifBlank { "—" }) + "). Skrytých: " +
                            hiddenByScope + " zo starej eKasy. Prepni na „Všetky“ pre celú históriu."
                    else ->
                        "Zobrazené sú iba platby aktuálnej eKasy (" +
                            (activeCashRegisterCode.ifBlank { "—" }) + ")."
                }
                Text(hint, style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.height(12.dp))
            }

            when {
                loading -> item { LoadingBox() }
                error != null -> item { ErrorBox(error!!) { load() } }
                items.isEmpty() -> item { EmptyHint("Žiadne platby podľa filtra.") }
                else -> {
                    item {
                        Box(Modifier.fillMaxWidth().horizontalScroll(tableScroll)) {
                            Column(Modifier.width(TABLE_MIN_WIDTH.dp)) { PmtTableHeader() }
                        }
                    }
                    items(items, key = { it.id }) { item ->
                        Box(Modifier.fillMaxWidth().horizontalScroll(tableScroll)) {
                            Column(Modifier.width(TABLE_MIN_WIDTH.dp)) {
                                PmtRow(
                                    item = item,
                                    busy = busy,
                                    onCopy = {
                                        runAction(
                                            successMsg = { res ->
                                                val printed = (res as? kotlinx.serialization.json.JsonObject)
                                                    ?.get("printed")?.let {
                                                        (it as? kotlinx.serialization.json.JsonPrimitive)?.content == "true"
                                                    } ?: false
                                                if (printed) "Kópia odoslaná na CHDU"
                                                else "Požiadavka na kópiu prijatá"
                                            },
                                            fallbackErr = "Kópiu sa nepodarilo vytlačiť",
                                            call = { pmtApi.receiptCopy(item.id) },
                                        )
                                    },
                                    onRefiscalize = { confirm = PmtConfirm.Refiscalize(item.id) },
                                    onChangeMethod = { newMethod, newLabel ->
                                        confirm = PmtConfirm.ChangeMethod(item.id, newMethod, newLabel)
                                    },
                                    onStorno = { confirm = PmtConfirm.Storno(item.id) },
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    // ---- Potvrdzovacie dialógy ----
    when (val c = confirm) {
        is PmtConfirm.Refiscalize -> AdminConfirm(
            title = "Re-fiškalizovať platbu",
            text = "Pošle nový fiškálny request pre platbu #${c.id} s reálnymi položkami " +
                "pod novým externalId. Pôvodný fiškálny záznam bude nahradený a kópia bonu " +
                "sa hneď vytlačí na CHDU. Použiť keď blok nevyšiel alebo vyšiel cudzí.",
            confirmLabel = "Re-fiškalizovať",
            danger = true,
            onDismiss = { confirm = null },
            onConfirm = {
                confirm = null
                runAction(
                    successMsg = { res ->
                        val obj = res as? kotlinx.serialization.json.JsonObject
                        val st = (obj?.get("fiscal") as? kotlinx.serialization.json.JsonObject)
                            ?.get("status")?.let {
                                (it as? kotlinx.serialization.json.JsonPrimitive)?.content
                            }?.takeIf { it != "null" } ?: "ok"
                        val printed = (obj?.get("print") as? kotlinx.serialization.json.JsonObject)
                            ?.get("printed")?.let {
                                (it as? kotlinx.serialization.json.JsonPrimitive)?.content == "true"
                            } ?: false
                        "Re-fiškalizácia OK ($st)" + (if (printed) " · blok vytlačený" else " · blok v queue")
                    },
                    fallbackErr = "Re-fiškalizácia zlyhala",
                    call = { pmtApi.refiscalize(c.id) },
                )
            },
        )
        is PmtConfirm.ChangeMethod -> AdminConfirm(
            title = "Zmena spôsobu platby",
            text = "Zmeniť platbu #${c.id} na ${c.newLabel}?\n\n" +
                "Operácia: stornuje pôvodný fiškálny doklad cez Portos a vystaví nový s novým " +
                "spôsobom platby. Vytlačia sa 2 doklady na CHDU (storno + nový).",
            confirmLabel = "Zmeniť na ${c.newLabel}",
            danger = true,
            onDismiss = { confirm = null },
            onConfirm = {
                confirm = null
                runAction(
                    successMsg = { res ->
                        val st = (res as? kotlinx.serialization.json.JsonObject)
                            ?.let { obj ->
                                (obj["newSaleFiscal"] as? kotlinx.serialization.json.JsonObject)
                                    ?.get("status")?.let {
                                        (it as? kotlinx.serialization.json.JsonPrimitive)?.content
                                    }?.takeIf { it != "null" }
                            } ?: "ok"
                        "Spôsob zmenený na ${c.newLabel} ($st)"
                    },
                    fallbackErr = "Chyba pri zmene spôsobu",
                    call = { pmtApi.changeMethod(c.id, PmtChangeMethodReq(c.newMethod)) },
                )
            },
        )
        is PmtConfirm.Storno -> AdminConfirm(
            title = "Fiškálne STORNO",
            text = "Naozaj odoslať STORNO pre platbu #${c.id}? Operácia odošle opravný doklad " +
                "do eKasy cez Portos a vytlačí blok na CHDU.",
            confirmLabel = "Odoslať STORNO",
            danger = true,
            onDismiss = { confirm = null },
            onConfirm = {
                confirm = null
                runAction(
                    successMsg = { res ->
                        val st = (res as? kotlinx.serialization.json.JsonObject)
                            ?.let { obj ->
                                (obj["fiscal"] as? kotlinx.serialization.json.JsonObject)
                                    ?.get("status")?.let {
                                        (it as? kotlinx.serialization.json.JsonPrimitive)?.content
                                    }?.takeIf { it != "null" }
                            } ?: "ok"
                        "STORNO odoslané ($st)"
                    },
                    fallbackErr = "Chyba STORNO",
                    call = { pmtApi.fiscalStorno(c.id) },
                )
            },
        )
        null -> {}
    }
}

/* ---- Tabuľka: hlavička + riadok (vlastná kvôli viacriadkovým bunkám + badge + akcie) ---- */

// Šírky stĺpcov (váhy) — zdieľané hlavičkou aj riadkom.
private const val W_ID = 1.4f
private const val W_WHEN = 1.6f
private const val W_TABLE = 1.8f
private const val W_METHOD = 1.1f
private const val W_SUM = 1.2f
private const val W_FISCAL = 2.0f
private const val W_ACTIONS = 3.2f
private const val TABLE_MIN_WIDTH = 1040

@Composable
private fun PmtTableHeader() {
    // Šírku drží volajúci (Column s TABLE_MIN_WIDTH v zdieľanom horizontálnom scrolle).
    Row(
        Modifier.fillMaxWidth().padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        @Composable
        fun th(label: String, w: Float) = Text(
            label.uppercase(), Modifier.weight(w),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1,
        )
        th("ID", W_ID); th("Kedy", W_WHEN); th("Stôl / Účet", W_TABLE)
        th("Spôsob", W_METHOD); th("Suma", W_SUM); th("Fiškalizácia", W_FISCAL)
        th("Akcie", W_ACTIONS)
    }
    HorizontalDivider(color = BorderSoft)
}

@Composable
private fun PmtRow(
    item: PmtItem,
    busy: Boolean,
    onCopy: () -> Unit,
    onRefiscalize: () -> Unit,
    onChangeMethod: (String, String) -> Unit,
    onStorno: () -> Unit,
) {
    // Horizontálny scroll rieši volajúci (jeden zdieľaný stav pre celú tabuľku) —
    // riadok len vyplní šírku rodičovského Column(TABLE_MIN_WIDTH).
    Row(Modifier.fillMaxWidth().padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically) {

        // ID + obj. #
        Column(Modifier.weight(W_ID)) {
            Text("#${item.id}", style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Bold, maxLines = 1)
            Text("obj. #${item.orderId ?: "—"}",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
        }
        // Kedy — Europe/Bratislava (web používal browser TZ; tu pinneme na bony).
        Text(
            pmtWhen(item.createdAt), Modifier.weight(W_WHEN),
            style = MaterialTheme.typography.bodyMedium, maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        // Stôl / Účet
        Column(Modifier.weight(W_TABLE)) {
            Text(item.tableName ?: "—", style = MaterialTheme.typography.bodyMedium,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (!item.orderLabel.isNullOrBlank()) {
                Text(item.orderLabel, style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        // Spôsob
        Text(pmtMethodLabel(item.method), Modifier.weight(W_METHOD),
            style = MaterialTheme.typography.bodyMedium, maxLines = 1)
        // Suma
        Text(pmtEur(item.amount), Modifier.weight(W_SUM),
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.SemiBold, maxLines = 1)
        // Fiškalizácia
        Box(Modifier.weight(W_FISCAL)) { PmtFiscalCell(item) }
        // Akcie
        Box(Modifier.weight(W_ACTIONS)) {
            PmtActionsCell(item, busy, onCopy, onRefiscalize, onChangeMethod, onStorno)
        }
    }
    HorizontalDivider(color = BorderSoft.copy(alpha = 0.5f))
}

/** Kedy formátované dd.MM.yyyy HH:mm v Europe/Bratislava (pinned — match bony). */
private fun pmtWhen(iso: String?): String {
    if (iso.isNullOrBlank()) return "—"
    return try {
        java.time.Instant.parse(iso)
            .atZone(java.time.ZoneId.of("Europe/Bratislava"))
            .format(java.time.format.DateTimeFormatter.ofPattern("dd.MM.yyyy HH:mm"))
    } catch (_: Exception) {
        iso.take(16).replace('T', ' ')
    }
}

@Composable
private fun PmtFiscalCell(item: PmtItem) {
    when {
        item.storno != null -> {
            Column {
                StatusBadge("Stornované", Amber)
                if (item.storno.externalId.isNotBlank()) {
                    Spacer(Modifier.height(2.dp))
                    Text(item.storno.externalId, style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
        item.fiscal == null -> StatusBadge("bez eKasa", EspressoDim)
        else -> {
            val f = item.fiscal
            val meta = buildList {
                f.receiptNumber?.let { add("č. $it") }
                if (!f.okp.isNullOrBlank()) add(f.okp)
            }.joinToString(" · ")
            Column {
                StatusBadge(f.status.ifBlank { "—" }, pmtFiscalTone(f.status))
                if (meta.isNotBlank()) {
                    Spacer(Modifier.height(2.dp))
                    Text(meta, style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}

@Composable
private fun PmtActionsCell(
    item: PmtItem,
    busy: Boolean,
    onCopy: () -> Unit,
    onRefiscalize: () -> Unit,
    onChangeMethod: (String, String) -> Unit,
    onStorno: () -> Unit,
) {
    // Kópia dokladu nevyžaduje manazer rolu (route bez requireRole). Ostatné akcie
    // (re-fiškalizácia / zmena metódy / STORNO) sú manager-only → skryjeme keď !isManager.
    val mgr = isManager
    FlowRowCompat {
        if (item.copyAvailable) {
            PmtActionButton("Kópia dokladu", Sage, busy, onCopy)
        }
        if (mgr && item.fiscal != null) {
            val accent = if (pmtNeedsRefiscalize(item.fiscal.status)) Amber else Navy
            PmtActionButton("Re-fiškalizovať", accent, busy, onRefiscalize)
        }
        if (mgr && item.stornoEligible) {
            val swapTo = if (item.method == "hotovost") "karta" else "hotovost"
            val swapLabel = if (item.method == "hotovost") "Karta" else "Hotovosť"
            PmtActionButton("→ $swapLabel", Navy, busy) { onChangeMethod(swapTo, swapLabel) }
            PmtActionButton("STORNO", Danger, busy, onStorno)
        } else if (item.storno != null) {
            PmtMutedNote("Už stornované")
        } else if (item.fiscal == null) {
            PmtMutedNote("—")
        } else if (!mgr) {
            // manager-only akcie skryté; ak nie je dostupná ani kópia, ukáž pomlčku.
            if (!item.copyAvailable) PmtMutedNote("—")
        } else {
            PmtMutedNote("Nedostupné")
        }
    }
}

@Composable
private fun PmtActionButton(label: String, color: Color, busy: Boolean, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        enabled = !busy,
        colors = ButtonDefaults.buttonColors(containerColor = color, contentColor = Cream),
        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
        modifier = Modifier.heightIn(min = 44.dp),
    ) {
        Text(label, style = MaterialTheme.typography.labelMedium, maxLines = 1)
    }
}

@Composable
private fun PmtMutedNote(text: String) {
    Text(text, style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(vertical = 10.dp), maxLines = 1)
}

/** Wrap riadok pre akčné tlačidlá bez závislosti na experimental FlowRow API. */
@Composable
private fun FlowRowCompat(content: @Composable () -> Unit) {
    Row(
        Modifier.horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) { content() }
}
