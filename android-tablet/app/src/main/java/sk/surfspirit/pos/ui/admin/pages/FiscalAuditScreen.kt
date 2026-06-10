package sk.surfspirit.pos.ui.admin.pages

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.jsonObject
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.Path
import retrofit2.http.Query
import sk.surfspirit.pos.core.BRATISLAVA
import sk.surfspirit.pos.core.errorMessage
import sk.surfspirit.pos.core.fmtBratislava
import sk.surfspirit.pos.core.httpCode
import sk.surfspirit.pos.core.todayIso
import sk.surfspirit.pos.net.Api
import sk.surfspirit.pos.ui.admin.*
import sk.surfspirit.pos.ui.theme.*
import java.time.LocalDate

/* =====================================================================
   FiscalAuditScreen — dve záložky:
     • Fiškálne doklady  (#historia/fiskalne)  — hľadanie dokladu + detail
       + akcie (kópia / STORNO / zmena spôsobu platby)
     • Audit objednávok  (#audit)              — read-only order_events log
   DTO prefix: Fa
   ===================================================================== */

/* ---------- Fiškál DTOs ---------- */

@Serializable
private data class FaFiscalRow(
    val id: Int = 0,
    val sourceType: String = "",
    val orderId: Int? = null,
    val paymentId: Int? = null,
    val externalId: String = "",
    val cashRegisterCode: String = "",
    val requestType: String = "",
    val httpStatus: Int? = null,
    val resultMode: String = "",
    val isSuccessful: Boolean? = null,
    val receiptId: String? = null,
    val receiptNumber: Int? = null,
    val okp: String? = null,
    val processDate: String? = null,
    val printerName: String? = null,
    val errorCode: Int? = null,
    val errorDetail: String = "",
    val paymentMethod: String? = null,
    val paymentAmount: Double? = null,
    val paymentCreatedAt: String? = null,
    val orderStatus: String? = null,
    val orderLabel: String? = null,
    val tableId: Int? = null,
    val tableName: String? = null,
    // detail-only meta (z GET /:id)
    val stornoEligible: Boolean = false,
    val stornoDone: Boolean = false,
    val stornoExternalId: String? = null,
)

@Serializable private data class FaSearchResp(val items: List<FaFiscalRow> = emptyList())
@Serializable private data class FaChangeMethodReq(val newMethod: String)

/* ---------- Audit DTOs ---------- */

@Serializable
private data class FaAuditEvent(
    val id: Int = 0,
    val orderId: Int? = null,
    val type: String = "",
    val payload: JsonElement? = null,
    val createdAt: String? = null,
    val staffId: Int? = null,
    val staffName: String? = null,
    val tableId: Int? = null,
    val tableName: String? = null,
    val orderStatus: String? = null,
    val orderLabel: String? = null,
)

@Serializable
private data class FaAuditResp(
    val count: Int = 0,
    val truncated: Boolean = false,
    val events: List<FaAuditEvent> = emptyList(),
)

@Serializable
private data class FaStaff(
    val id: Int = 0,
    val name: String = "",
    val role: String = "",
)

/* ---------- Retrofit ---------- */

private interface FaApi {
    @GET("api/fiscal-documents/search")
    suspend fun search(
        @Query("receiptId") receiptId: String? = null,
        @Query("externalId") externalId: String? = null,
        @Query("okp") okp: String? = null,
        @Query("cashRegisterCode") cashRegisterCode: String? = null,
        @Query("receiptNumber") receiptNumber: String? = null,
        @Query("year") year: String? = null,
        @Query("month") month: String? = null,
    ): FaSearchResp

    @GET("api/fiscal-documents/{id}")
    suspend fun detail(@Path("id") id: Int): FaFiscalRow

    @retrofit2.http.POST("api/fiscal-documents/{id}/storno")
    suspend fun storno(@Path("id") id: Int, @Body body: JsonObject = JsonObject(emptyMap())): JsonElement

    @retrofit2.http.POST("api/payments/{id}/receipt-copy")
    suspend fun receiptCopy(@Path("id") id: Int, @Body body: JsonObject = JsonObject(emptyMap())): JsonElement

    @retrofit2.http.POST("api/payments/{id}/change-method")
    suspend fun changeMethod(@Path("id") id: Int, @Body body: FaChangeMethodReq): JsonElement

    @GET("api/audit/order-events")
    suspend fun events(
        @Query("from") from: String,
        @Query("to") to: String,
        @Query("staffId") staffId: Int? = null,
        @Query("type") type: String? = null,
        @Query("orderId") orderId: Int? = null,
    ): FaAuditResp

    @GET("api/audit/order-events/types")
    suspend fun types(): List<String>

    @GET("api/staff")
    suspend fun staff(): List<FaStaff>
}

private val faApi: FaApi by lazy { Api.create(FaApi::class.java) }

/* ---------- Slovak helpers ---------- */

private val FA_TYPE_LABELS = mapOf(
    "order_created" to "Objednávka vytvorená",
    "item_added" to "Pridaná položka",
    "item_qty_changed" to "Zmena množstva",
    "item_removed" to "Odstránená položka",
    "batch_update" to "Hromadná úprava",
    "order_sent" to "Odoslané do kuchyne/baru",
    "order_closed" to "Uzatvorená",
    "order_cancelled" to "Stornovaná",
    "order_split" to "Rozdelená",
    "order_paid" to "Zaplatená",
    "payment_added" to "Pridaná platba",
    "payment_voided" to "Zrušená platba",
    "discount_applied" to "Pridaná zľava",
    "discount_removed" to "Odstránená zľava",
    "storno_requested" to "Storno žiadosť",
    "storno_approved" to "Storno schválené",
    "storno_rejected" to "Storno zamietnuté",
)

private fun faTypeLabel(type: String): String = FA_TYPE_LABELS[type] ?: type

private fun faTypeColor(type: String): Color = when (type) {
    "order_cancelled", "storno_rejected", "item_removed" -> Danger
    "order_sent", "order_paid", "storno_approved" -> Sage
    "order_created", "item_added" -> Navy
    else -> Amber
}

/** ISO timestamp → "dd.MM.yyyy HH:mm:ss" v Europe/Bratislava (native štandardizuje TZ). */
private fun faDateTime(iso: String?): String =
    if (iso.isNullOrBlank()) "—" else fmtBratislava(iso, "dd.MM.yyyy HH:mm:ss")

/** 1-riadkový popis payloadu — zhoda s admin describePayload. */
private fun faDescribePayload(type: String, payload: JsonElement?): String {
    val obj = (payload as? JsonObject) ?: return ""
    fun s(k: String): String? = (obj[k] as? JsonPrimitive)?.contentOrNullSafe()
    fun arrLen(k: String): Int? = (obj[k] as? JsonArray)?.size
    return when (type) {
        "order_created" -> {
            val label = s("label")
            (if (!label.isNullOrBlank()) "\"$label\" · " else "") + (s("itemCount") ?: "0") + " položiek"
        }
        "item_added" -> arrLen("items")?.let { "$it položiek" } ?: ""
        "item_qty_changed" -> {
            val from = s("from"); val to = s("to")
            "menuItemId=" + (s("menuItemId") ?: "?") + ", qty " +
                (if (from != null) "$from→${to ?: ""}" else (s("qty") ?: ""))
        }
        "item_removed" -> "itemId=" + (s("itemId") ?: "?")
        "order_sent" -> (s("itemCount") ?: "0") + " nových položiek"
        "discount_applied" -> (s("discountAmount") ?: "0") + " € zľava"
        "discount_removed" -> "odstránená zľava"
        "order_split" -> "rozdelená na " + (arrLen("newOrderIds")?.toString() ?: "?") + " obj."
        "order_cancelled" -> "stôl " + (s("tableId") ?: "?")
        else -> obj.entries.take(2).joinToString(", ") { (k, v) -> "$k=$v" }
    }
}

private fun JsonPrimitive.contentOrNullSafe(): String? =
    try { if (this.content == "null" && !this.isString) null else this.content } catch (_: Exception) { null }

// „Dnes" v Europe/Bratislava (zdieľané core helpery) — device TZ by po
// UTC polnoci posunul denné filtre na včerajšok.
private fun faTodayMinusIso(n: Int): String =
    LocalDate.now(BRATISLAVA).minusDays(n.toLong()).toString()

/* ===================================================================== */

@Composable
fun FiscalAuditScreen() {
    val toast = rememberAdminToast()
    var tab by remember { mutableStateOf(0) }

    AdminScreenBox(toast, scrollable = false) {
        PillTabs(listOf("Fiškálne doklady", "Audit objednávok"), tab) { tab = it }
        Spacer(Modifier.height(14.dp))
        when (tab) {
            // Fiškálny tab — bežný vertical scroll (obsah je krátky/bounded).
            0 -> Column(
                Modifier.weight(1f).fillMaxWidth()
                    .verticalScroll(rememberScrollState()),
            ) {
                FaFiscalTab(toast)
            }
            // Audit tab — vlastný LazyColumn (event log môže mať stovky riadkov).
            else -> FaAuditTab()
        }
    }
}

/* ===================== TAB 1 — Fiškálne doklady ===================== */

private enum class FaSearchMode(val label: String) {
    RECEIPT_ID("Identifikátor dokladu"),
    EXTERNAL_ID("External ID"),
    TRIPLET("Kód pokladnice + rok + mesiac + číslo dokladu"),
}

@Composable
private fun ColumnScope.FaFiscalTab(toast: AdminToastState) {
    val scope = rememberCoroutineScope()

    var mode by remember { mutableStateOf(FaSearchMode.RECEIPT_ID) }
    var modeMenu by remember { mutableStateOf(false) }
    var receiptIdF by remember { mutableStateOf("") }
    var externalIdF by remember { mutableStateOf("") }
    var crCode by remember { mutableStateOf("") }
    var yearF by remember { mutableStateOf(LocalDate.now(BRATISLAVA).year.toString()) }
    var monthF by remember { mutableStateOf(LocalDate.now(BRATISLAVA).monthValue.toString()) }
    var receiptNumberF by remember { mutableStateOf("") }

    var results by remember { mutableStateOf<List<FaFiscalRow>>(emptyList()) }
    var selected by remember { mutableStateOf<FaFiscalRow?>(null) }
    var searching by remember { mutableStateOf(false) }

    var confirm by remember { mutableStateOf<FaConfirm?>(null) }

    fun loadDetail(id: Int) {
        scope.launch {
            try {
                val d = withContext(Dispatchers.IO) { faApi.detail(id) }
                selected = d
            } catch (e: Exception) {
                if (e.httpCode() != 401) toast.show(errorMessage(e), error = true)
            }
        }
    }

    fun runSearch() {
        if (searching) return
        searching = true
        scope.launch {
            try {
                val resp = withContext(Dispatchers.IO) {
                    when (mode) {
                        FaSearchMode.RECEIPT_ID -> faApi.search(receiptId = receiptIdF.trim().ifBlank { null })
                        FaSearchMode.EXTERNAL_ID -> faApi.search(externalId = externalIdF.trim().ifBlank { null })
                        FaSearchMode.TRIPLET -> faApi.search(
                            cashRegisterCode = crCode.trim().ifBlank { null },
                            year = yearF.trim().ifBlank { null },
                            month = monthF.trim().ifBlank { null },
                            receiptNumber = receiptNumberF.trim().ifBlank { null },
                        )
                    }
                }
                results = resp.items
                selected = null
                if (resp.items.isEmpty()) toast.show("Doklad sa nenašiel", error = true)
            } catch (e: Exception) {
                results = emptyList()
                selected = null
                if (e.httpCode() != 401) toast.show(errorMessage(e), error = true)
            } finally {
                searching = false
            }
        }
    }

    // ---- (1) Vyhľadávacia karta ----
    AdminCard {
        AdminSectionTitle("Fiškálne doklady")
        // Spôsob hľadania (dropdown)
        Text("Spôsob hľadania", style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(4.dp))
        Box {
            OutlinedButton(
                onClick = { modeMenu = true },
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(10.dp),
            ) {
                Text(mode.label, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text("▾")
            }
            DropdownMenu(expanded = modeMenu, onDismissRequest = { modeMenu = false }) {
                FaSearchMode.values().forEach { m ->
                    DropdownMenuItem(text = { Text(m.label) }, onClick = { mode = m; modeMenu = false })
                }
            }
        }
        Spacer(Modifier.height(12.dp))

        when (mode) {
            FaSearchMode.RECEIPT_ID -> FormField(
                "Identifikátor dokladu", receiptIdF, { receiptIdF = it },
                placeholder = "napr. O-123456789",
            )
            FaSearchMode.EXTERNAL_ID -> FormField(
                "External ID", externalIdF, { externalIdF = it },
                placeholder = "napr. order-42-payment",
            )
            FaSearchMode.TRIPLET -> {
                FormField("Kód pokladnice", crCode, { crCode = it }, placeholder = "88812345678900001")
                Spacer(Modifier.height(10.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    FormField("Rok", yearF, { yearF = it.filter(Char::isDigit) },
                        modifier = Modifier.weight(1f),
                        keyboard = KeyboardOptions(keyboardType = KeyboardType.Number))
                    FormField("Mesiac", monthF, { monthF = it.filter(Char::isDigit) },
                        modifier = Modifier.weight(1f),
                        keyboard = KeyboardOptions(keyboardType = KeyboardType.Number))
                }
                Spacer(Modifier.height(10.dp))
                FormField("Číslo dokladu", receiptNumberF, { receiptNumberF = it.filter(Char::isDigit) },
                    placeholder = "napr. 152",
                    keyboard = KeyboardOptions(keyboardType = KeyboardType.Number))
            }
        }
        Spacer(Modifier.height(14.dp))
        Button(
            onClick = { runSearch() },
            enabled = !searching,
            colors = ButtonDefaults.buttonColors(containerColor = Terra, contentColor = Cream),
        ) {
            if (searching) {
                CircularProgressIndicator(Modifier.size(18.dp), color = Cream, strokeWidth = 2.dp)
                Spacer(Modifier.width(8.dp))
            }
            Text("Vyhľadať doklad")
        }
    }

    Spacer(Modifier.height(14.dp))

    // ---- (2) Výsledky ----
    AdminCard {
        AdminSectionTitle("Výsledky")
        when {
            results.isEmpty() ->
                EmptyHint("Zatiaľ žiadne výsledky. Vyhľadaj doklad podľa údajov z bločku.")
            else -> {
                TableHeader(
                    "Doklad" to 2.4f, "Typ" to 1f, "Objednávka" to 1.6f,
                    "Stôl" to 1f, "Dátum" to 1.8f, "Stav" to 1.4f,
                )
                results.forEach { row ->
                    val active = selected?.id == row.id
                    val rowMod = if (active)
                        Modifier.background(Navy.copy(alpha = 0.08f), RoundedCornerShape(6.dp))
                    else Modifier
                    FaResultRow(row, rowMod) { loadDetail(row.id) }
                }
            }
        }
    }

    Spacer(Modifier.height(14.dp))

    // ---- (3) Detail ----
    AdminCard {
        val sel = selected
        if (sel == null) {
            EmptyHint("Vyber doklad zo zoznamu pre detail a storno.")
        } else {
            AdminSectionTitle("Detail dokladu")
            FaDetailGrid(sel)
            Spacer(Modifier.height(14.dp))
            FlowActionRow {
                if (sel.paymentId != null) {
                    Button(
                        onClick = {
                            scope.launch {
                                try {
                                    val res = withContext(Dispatchers.IO) { faApi.receiptCopy(sel.paymentId) }
                                    val printed = (res as? JsonObject)?.get("printed")
                                        ?.let { (it as? JsonPrimitive)?.contentOrNullSafe() } == "true"
                                    toast.show(if (printed) "Kópia dokladu vytlačená" else "Požiadavka na kópiu odoslaná")
                                } catch (e: Exception) {
                                    if (e.httpCode() != 401) toast.show(errorMessage(e), error = true)
                                }
                            }
                        },
                        colors = ButtonDefaults.buttonColors(containerColor = Terra, contentColor = Cream),
                    ) { Text("Vytlačiť kópiu") }
                }
                if (sel.stornoEligible) {
                    Button(
                        onClick = { confirm = FaConfirm.Storno(sel) },
                        colors = ButtonDefaults.buttonColors(containerColor = Danger, contentColor = Cream),
                    ) { Text("Odoslať STORNO") }
                }
                if (sel.stornoEligible && sel.paymentId != null && !sel.paymentMethod.isNullOrBlank()) {
                    Button(
                        onClick = { confirm = FaConfirm.ChangeMethod(sel) },
                        colors = ButtonDefaults.buttonColors(containerColor = Amber, contentColor = Cream),
                    ) { Text("Zmeniť spôsob platby") }
                }
            }
        }
    }

    // ---- Potvrdenia ----
    when (val c = confirm) {
        is FaConfirm.Storno -> AdminConfirm(
            title = "Fiškálne STORNO",
            text = "Naozaj odoslať STORNO pre vybraný doklad? Táto operácia odošle opravný doklad do eKasa cez Portos.",
            confirmLabel = "Odoslať STORNO",
            danger = true,
            onDismiss = { confirm = null },
            onConfirm = {
                confirm = null
                scope.launch {
                    try {
                        val res = withContext(Dispatchers.IO) { faApi.storno(c.doc.id) }
                        val status = (res as? JsonObject)?.get("fiscal")
                            ?.let { runCatching { it.jsonObject }.getOrNull() }
                            ?.get("status")?.let { (it as? JsonPrimitive)?.contentOrNullSafe() } ?: "ok"
                        toast.show("STORNO odoslané ($status)")
                        loadDetail(c.doc.id)
                    } catch (e: Exception) {
                        if (e.httpCode() != 401) toast.show(errorMessage(e), error = true)
                    }
                }
            },
        )
        is FaConfirm.ChangeMethod -> {
            val current = (c.doc.paymentMethod ?: "").lowercase()
            val target = if (current == "hotovost" || current == "cash") "karta" else "hotovost"
            val labelMap = mapOf("hotovost" to "Hotovosť", "cash" to "Hotovosť", "karta" to "Karta")
            val oldLabel = labelMap[current] ?: current
            val newLabel = labelMap[target] ?: target
            AdminConfirm(
                title = "Zmena spôsobu platby",
                text = "Pôvodný doklad ($oldLabel) sa vystorno na Portos a vytlačí sa nový doklad s metódou $newLabel. Pokračovať?",
                confirmLabel = "Storno + nový doklad",
                danger = false,
                onDismiss = { confirm = null },
                onConfirm = {
                    confirm = null
                    val pid = c.doc.paymentId ?: return@AdminConfirm
                    scope.launch {
                        try {
                            val res = withContext(Dispatchers.IO) {
                                faApi.changeMethod(pid, FaChangeMethodReq(newMethod = target))
                            }
                            val newReceipt = (res as? JsonObject)?.get("newSaleFiscal")
                                ?.let { runCatching { it.jsonObject }.getOrNull() }
                                ?.get("receiptId")?.let { (it as? JsonPrimitive)?.contentOrNullSafe() }
                            val suffix = if (!newReceipt.isNullOrBlank()) " ($newReceipt)" else ""
                            toast.show("Metóda zmenená: $oldLabel → $newLabel$suffix")
                            loadDetail(c.doc.id)
                        } catch (e: Exception) {
                            if (e.httpCode() != 401) toast.show(errorMessage(e), error = true)
                        }
                    }
                },
            )
        }
        null -> {}
    }
}

private sealed class FaConfirm {
    data class Storno(val doc: FaFiscalRow) : FaConfirm()
    data class ChangeMethod(val doc: FaFiscalRow) : FaConfirm()
}

@Composable
private fun FaResultRow(row: FaFiscalRow, modifier: Modifier, onClick: () -> Unit) {
    val docLabel = row.receiptId?.takeIf { it.isNotBlank() }
        ?: row.externalId.takeIf { it.isNotBlank() }
        ?: "#${row.id}"
    val orderCell = "#${row.orderId ?: "-"} / payment #${row.paymentId ?: "-"}"
    Surface(color = Color.Transparent, onClick = onClick) {
        Column(modifier.fillMaxWidth().padding(vertical = 8.dp, horizontal = 4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(2.4f)) {
                    Text(docLabel, style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (!row.okp.isNullOrBlank()) {
                        Text(row.okp, style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
                FaCell(row.sourceType, 1f)
                FaCell(orderCell, 1.6f)
                FaCell(row.tableName?.takeIf { it.isNotBlank() } ?: "-", 1f)
                FaCell(faDateTime(row.processDate), 1.8f)
                FaCell(row.resultMode.takeIf { it.isNotBlank() } ?: "-", 1.4f)
            }
        }
    }
    HorizontalDivider(color = BorderSoft.copy(alpha = 0.5f))
}

@Composable
private fun RowScope.FaCell(text: String, weight: Float) {
    Text(text, Modifier.weight(weight), style = MaterialTheme.typography.bodyMedium,
        maxLines = 1, overflow = TextOverflow.Ellipsis)
}

@Composable
private fun FaDetailGrid(d: FaFiscalRow) {
    val stornoState = when {
        d.stornoDone -> "Už odoslané"
        d.stornoEligible -> "Možné"
        else -> "Nie"
    }
    val pairs = listOf(
        "Receipt ID" to (d.receiptId?.takeIf { it.isNotBlank() } ?: "-"),
        "External ID" to (d.externalId.takeIf { it.isNotBlank() } ?: "-"),
        "OKP" to (d.okp?.takeIf { it.isNotBlank() } ?: "-"),
        "Číslo dokladu" to (d.receiptNumber?.toString() ?: "-"),
        "Kód pokladnice" to (d.cashRegisterCode.takeIf { it.isNotBlank() } ?: "-"),
        "Dátum" to faDateTime(d.processDate),
        "Platba" to ("#" + (d.paymentId?.toString() ?: "-")),
        "Objednávka" to ("#" + (d.orderId?.toString() ?: "-")),
        "Typ" to (d.sourceType.takeIf { it.isNotBlank() } ?: "-"),
        "Stav" to (d.resultMode.takeIf { it.isNotBlank() } ?: "-"),
        "Storno" to stornoState,
    )
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        pairs.chunked(2).forEach { rowPairs ->
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                rowPairs.forEach { (label, value) ->
                    Column(Modifier.weight(1f)) {
                        Text(label, style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Spacer(Modifier.height(2.dp))
                        Text(value, style = MaterialTheme.typography.bodyMedium,
                            maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                }
                if (rowPairs.size == 1) Spacer(Modifier.weight(1f))
            }
        }
    }
}

/** Akčný rad — jednoduchý wrap (vyhneme sa ExperimentalLayoutApi). */
@Composable
private fun FlowActionRow(content: @Composable RowScope.() -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), content = content)
}

/* ===================== TAB 2 — Audit objednávok ===================== */

@Composable
private fun ColumnScope.FaAuditTab() {
    val scope = rememberCoroutineScope()

    var from by remember { mutableStateOf(todayIso()) }
    var to by remember { mutableStateOf(todayIso()) }
    var staffId by remember { mutableStateOf<Int?>(null) }
    var typeFilter by remember { mutableStateOf<String?>(null) }
    var orderFilter by remember { mutableStateOf("") }

    var staffList by remember { mutableStateOf<List<FaStaff>>(emptyList()) }
    var typeList by remember { mutableStateOf<List<String>>(emptyList()) }

    var events by remember { mutableStateOf<List<FaAuditEvent>>(emptyList()) }
    var count by remember { mutableStateOf(0) }
    var truncated by remember { mutableStateOf(false) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }

    var staffMenu by remember { mutableStateOf(false) }
    var typeMenu by remember { mutableStateOf(false) }

    fun load() {
        loading = true
        scope.launch {
            try {
                val resp = withContext(Dispatchers.IO) {
                    faApi.events(
                        from = from, to = to,
                        staffId = staffId,
                        type = typeFilter,
                        orderId = orderFilter.trim().toIntOrNull(),
                    )
                }
                events = resp.events
                count = resp.count
                truncated = resp.truncated
                error = null
            } catch (e: Exception) {
                if (e.httpCode() != 401) error = errorMessage(e)
            } finally {
                loading = false
            }
        }
    }

    LaunchedEffect(Unit) {
        try {
            val (s, t) = withContext(Dispatchers.IO) {
                Pair(
                    runCatching { faApi.staff() }.getOrDefault(emptyList()),
                    runCatching { faApi.types() }.getOrDefault(emptyList()),
                )
            }
            staffList = s
            typeList = t
        } catch (_: Exception) { }
        load()
    }

    // Debounce pre Č. objednávky — aj vyprázdnenie filtra reloadne (zruší
    // filter); preskočí sa len úvodná kompozícia (mount load() je vyššie).
    var orderFilterArmed by remember { mutableStateOf(false) }
    LaunchedEffect(orderFilter) {
        if (!orderFilterArmed) { orderFilterArmed = true; return@LaunchedEffect }
        delay(350)
        load()
    }

    // Tab ako LazyColumn — riadky event logu sa komponujú lenivo (toolbar a
    // hlavička sú itemy), namiesto eager forEach vo verticalScroll.
    LazyColumn(Modifier.weight(1f).fillMaxWidth()) {
        item {
            // ---- Toolbar ----
            AdminCard {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("História operácií nad objednávkami", Modifier.weight(1f),
                        style = MaterialTheme.typography.titleMedium)
                    val countText = "$count záznamov" + if (truncated) " (orezané — sprísni filter)" else ""
                    Text(countText, style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.width(12.dp))
                    Button(onClick = { load() },
                        colors = ButtonDefaults.buttonColors(containerColor = Terra, contentColor = Cream)) {
                        Text("Obnoviť")
                    }
                }
                Spacer(Modifier.height(12.dp))

                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    FormField("Od", from, { from = it }, modifier = Modifier.weight(1f),
                        placeholder = "RRRR-MM-DD")
                    FormField("Do", to, { to = it }, modifier = Modifier.weight(1f),
                        placeholder = "RRRR-MM-DD")
                }
                Spacer(Modifier.height(10.dp))

                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    // Čašník
                    Column(Modifier.weight(1f)) {
                        Text("Čašník", style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Spacer(Modifier.height(4.dp))
                        Box {
                            OutlinedButton(onClick = { staffMenu = true }, modifier = Modifier.fillMaxWidth(),
                                shape = RoundedCornerShape(10.dp)) {
                                val name = staffList.firstOrNull { it.id == staffId }?.name ?: "Všetci čašníci"
                                Text(name, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text("▾")
                            }
                            DropdownMenu(expanded = staffMenu, onDismissRequest = { staffMenu = false }) {
                                DropdownMenuItem(text = { Text("Všetci čašníci") },
                                    onClick = { staffId = null; staffMenu = false; load() })
                                staffList.forEach { s ->
                                    DropdownMenuItem(text = { Text(s.name) },
                                        onClick = { staffId = s.id; staffMenu = false; load() })
                                }
                            }
                        }
                    }
                    // Typ akcie
                    Column(Modifier.weight(1f)) {
                        Text("Typ akcie", style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Spacer(Modifier.height(4.dp))
                        Box {
                            OutlinedButton(onClick = { typeMenu = true }, modifier = Modifier.fillMaxWidth(),
                                shape = RoundedCornerShape(10.dp)) {
                                val lbl = typeFilter?.let { faTypeLabel(it) } ?: "Všetky akcie"
                                Text(lbl, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text("▾")
                            }
                            DropdownMenu(expanded = typeMenu, onDismissRequest = { typeMenu = false }) {
                                DropdownMenuItem(text = { Text("Všetky akcie") },
                                    onClick = { typeFilter = null; typeMenu = false; load() })
                                typeList.forEach { t ->
                                    DropdownMenuItem(text = { Text(faTypeLabel(t)) },
                                        onClick = { typeFilter = t; typeMenu = false; load() })
                                }
                            }
                        }
                    }
                    // Č. objednávky
                    FormField("Č. objednávky", orderFilter, { orderFilter = it.filter(Char::isDigit) },
                        modifier = Modifier.weight(1f), placeholder = "napr. 123",
                        keyboard = KeyboardOptions(keyboardType = KeyboardType.Number))
                }
                Spacer(Modifier.height(12.dp))

                // Presety
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FaPreset("Dnes") { to = todayIso(); from = faTodayMinusIso(0); load() }
                    FaPreset("Včera") { to = todayIso(); from = faTodayMinusIso(1); load() }
                    FaPreset("7 dní") { to = todayIso(); from = faTodayMinusIso(7); load() }
                    FaPreset("30 dní") { to = todayIso(); from = faTodayMinusIso(30); load() }
                }
            }
            Spacer(Modifier.height(14.dp))
        }

        item {
            // ---- Tabuľka ----
            AdminSectionTitle("História operácií nad objednávkami")
            TableHeader(
                "Čas" to 1.9f, "Čašník" to 1.2f, "Akcia" to 1.6f,
                "Objednávka" to 1.4f, "Stôl" to 1f, "Detail" to 2.2f,
            )
        }
        when {
            loading -> item { EmptyHint("Načítavam…") }
            error != null -> item {
                Text("Chyba: $error", Modifier.padding(16.dp), color = Danger,
                    style = MaterialTheme.typography.bodyMedium)
            }
            events.isEmpty() -> item { EmptyHint("Žiadne záznamy pre toto obdobie.") }
            else -> items(events, key = { it.id }) { ev -> FaEventRow(ev) }
        }
    }
}

@Composable
private fun FaPreset(label: String, onClick: () -> Unit) {
    OutlinedButton(onClick = onClick, contentPadding = PaddingValues(horizontal = 14.dp, vertical = 8.dp),
        shape = RoundedCornerShape(999.dp)) {
        Text(label, style = MaterialTheme.typography.labelMedium)
    }
}

@Composable
private fun FaEventRow(ev: FaAuditEvent) {
    val color = faTypeColor(ev.type)
    val orderLabel = ev.orderLabel?.takeIf { it.isNotBlank() }
    val tableCell = ev.tableName?.takeIf { it.isNotBlank() }
        ?: ev.tableId?.let { "#$it" } ?: "—"
    val desc = faDescribePayload(ev.type, ev.payload)
    Row(Modifier.fillMaxWidth().padding(vertical = 8.dp, horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Text(faDateTime(ev.createdAt), Modifier.weight(1.9f),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(ev.staffName?.takeIf { it.isNotBlank() } ?: "?", Modifier.weight(1.2f),
            style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Bold,
            maxLines = 1, overflow = TextOverflow.Ellipsis)
        Box(Modifier.weight(1.6f)) { StatusBadge(faTypeLabel(ev.type), color) }
        Box(Modifier.weight(1.4f)) {
            if (ev.orderId != null) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("#${ev.orderId}", style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Bold, maxLines = 1)
                    if (orderLabel != null) {
                        Spacer(Modifier.width(4.dp))
                        Text(orderLabel, style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            } else {
                Text("—", style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Text(tableCell, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium,
            maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(desc, Modifier.weight(2.2f), style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
    HorizontalDivider(color = BorderSoft.copy(alpha = 0.5f))
}
