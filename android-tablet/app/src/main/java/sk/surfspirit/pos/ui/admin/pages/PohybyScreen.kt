package sk.surfspirit.pos.ui.admin.pages

import androidx.compose.foundation.BorderStroke
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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Query
import sk.surfspirit.pos.core.errorMessage
import sk.surfspirit.pos.core.fmtBratislava
import sk.surfspirit.pos.core.httpCode
import sk.surfspirit.pos.core.isManager
import sk.surfspirit.pos.net.Api
import sk.surfspirit.pos.ui.admin.*
import sk.surfspirit.pos.ui.components.LocalToast
import sk.surfspirit.pos.ui.components.PosToastState
import sk.surfspirit.pos.ui.theme.*

/* =====================================================================
   PohybyScreen — Sklad: pohyby + odpisy (#sklad-pohyby)
   Tab „Pohyby"  = log skladových pohybov s filtrami + ručná úprava
                   (parita admin/pages/stock-movements.js)
   Tab „Odpisy"  = zoznam/prehľad odpisov + schválenie/zamietnutie/nový
                   (parita admin/pages/write-offs.js)

   POZOR (Drizzle): stockMovements quantity/previousQty/newQty sú STRING.
   Suroviny (currentQty/minQty/costPerUnit) a write-offs sumy server
   parseFloat'uje → NUMBER. Item-name pre pohyby server NEjoinuje → tu
   joinujeme client-side z ingredients (fallback „ID: N" ako web).
   ===================================================================== */

/* ---------------- DTOs (prefix `Po`) ---------------- */

@Serializable private data class PoIngredientDto(
    val id: Int = 0,
    val name: String = "",
    val unit: String = "",
    val type: String = "",
    val currentQty: Double = 0.0,
    val minQty: Double = 0.0,
    val costPerUnit: Double = 0.0,
    val active: Boolean = true,
)

// RAW stockMovements riadok — numeric stĺpce sú STRING.
@Serializable private data class PoMovementDto(
    val id: Int = 0,
    val type: String = "",
    val ingredientId: Int? = null,
    val menuItemId: Int? = null,
    val quantity: String = "0",
    val previousQty: String = "0",
    val newQty: String = "0",
    val referenceType: String? = null,
    val referenceId: Int? = null,
    val note: String = "",
    val staffId: Int = 0,
    val createdAt: String? = null,
)

@Serializable private data class PoMovementsResp(
    val data: List<PoMovementDto> = emptyList(),
    val total: Int = 0,
)

@Serializable private data class PoAdjustReq(
    val ingredientId: Int,
    val quantity: Double,
    val type: String,         // adjustment | waste
    val note: String? = null,
)

// Write-off riadok — sumy NUMBER server-side.
@Serializable private data class PoWriteOffItemDto(
    val id: Int = 0,
    val writeOffId: Int = 0,
    val ingredientId: Int = 0,
    val quantity: Double = 0.0,
    val unitCost: Double = 0.0,
    val totalCost: Double = 0.0,
    val ingredientName: String = "",
    val ingredientUnit: String = "",
)

@Serializable private data class PoWriteOffDto(
    val id: Int = 0,
    val status: String = "",       // pending | approved | rejected
    val reason: String = "",       // expiration | damage | theft | staff_meal | other
    val note: String = "",
    val totalCost: Double = 0.0,
    val orderId: Int? = null,
    val createdBy: Int = 0,
    val approvedBy: Int? = null,
    val createdAt: String? = null,
    val approvedAt: String? = null,
    val createdByName: String = "—",
    val approvedByName: String? = null,
    val items: List<PoWriteOffItemDto> = emptyList(),
)

@Serializable private data class PoWriteOffSummaryDto(
    val total: Double = 0.0,
    val count: Int = 0,
    val byReason: Map<String, Double> = emptyMap(),
    val from: String = "",
    val to: String = "",
)

@Serializable private data class PoNewWriteOffItem(val ingredientId: Int, val quantity: Double)
@Serializable private data class PoCreateWriteOffReq(
    val reason: String,
    val note: String? = null,
    val items: List<PoNewWriteOffItem>,
)

// Lite shape /api/menu — len id+name pre join menuItemId-keyed pohybov.
@Serializable private data class PoMenuItemLite(val id: Int = 0, val name: String = "")
@Serializable private data class PoMenuCategoryLite(val items: List<PoMenuItemLite> = emptyList())

private interface PoApi {
    // POZOR: server vracia VŠETKY riadky len pri doslovnom active="false"
    // (chýbajúci param = len aktívne) — name-join historických pohybov
    // potrebuje aj deaktivované suroviny.
    @GET("api/inventory/ingredients")
    suspend fun ingredients(@Query("active") active: String = "true"): List<PoIngredientDto>

    @GET("api/menu")
    suspend fun menuLite(): List<PoMenuCategoryLite>

    @GET("api/inventory/movements")
    suspend fun movements(
        @Query("type") type: String? = null,
        @Query("ingredientId") ingredientId: Int? = null,
        @Query("from") from: String? = null,
        @Query("to") to: String? = null,
        @Query("limit") limit: Int = 50,
        @Query("offset") offset: Int = 0,
    ): PoMovementsResp

    @POST("api/inventory/movements/adjust")
    suspend fun adjust(@Body body: PoAdjustReq): JsonElement

    @GET("api/inventory/write-offs")
    suspend fun writeOffs(
        @Query("status") status: String? = null,
        @Query("reason") reason: String? = null,
    ): List<PoWriteOffDto>

    @GET("api/inventory/write-offs-summary")
    suspend fun writeOffsSummary(
        @Query("from") from: String,
        @Query("to") to: String,
    ): PoWriteOffSummaryDto

    @POST("api/inventory/write-offs")
    suspend fun createWriteOff(@Body body: PoCreateWriteOffReq): JsonElement

    @POST("api/inventory/write-offs/{id}/approve")
    suspend fun approveWriteOff(@Path("id") id: Int): JsonElement

    @POST("api/inventory/write-offs/{id}/reject")
    suspend fun rejectWriteOff(@Path("id") id: Int): JsonElement
}

private val poApi: PoApi by lazy { Api.create(PoApi::class.java) }

private const val PO_PAGE_SIZE = 50

/* ---------------- Formátovanie (sk-SK, web parita) ---------------- */

/** sk-SK s vynútenými 2 desatinami (web fmtNum). */
private fun poFmtNum(n: Double): String =
    String.format("%.2f", n).replace('.', ',')

/** Suma v EUR — vždy 2 desatiny + „ €" (web fmtEur). */
private fun poFmtEur(n: Double): String = poFmtNum(n) + " €"

/** Diff množstvo so znamienkom „+" pri raste (web fmtQty). */
private fun poFmtQtyDiff(diff: Double): String {
    val sign = if (diff > 0) "+" else ""
    return sign + poFmtNum(diff)
}

/** Server timestamp → „dd.MM.yyyy HH:mm" v Europe/Bratislava. */
private fun poFmtDate(iso: String?): String = fmtBratislava(iso, "dd.MM.yyyy HH:mm")

/* ---------------- Badge mapy (web parita) ---------------- */

private val PoPurple = Color(0xFF6B4FA0)   // sale / theft

private data class PoBadge(val label: String, val color: Color)

/** Typ pohybu → badge (zhoda s dashboard / inventory mapou). */
private fun poMovementBadge(type: String): PoBadge = when (type) {
    "purchase"   -> PoBadge("Prijem", Sage)
    "sale"       -> PoBadge("Predaj", PoPurple)
    "adjustment" -> PoBadge("Uprava", Navy)
    "waste"      -> PoBadge("Odpad", Danger)
    "inventory"  -> PoBadge("Inventura", Amber)
    else         -> PoBadge(if (type.isBlank()) "—" else type, EspressoDim)
}

private fun poReasonBadge(reason: String): PoBadge = when (reason) {
    "expiration" -> PoBadge("Expiracia", Amber)
    "damage"     -> PoBadge("Poskodenie", Danger)
    "theft"      -> PoBadge("Kradez", PoPurple)
    "staff_meal" -> PoBadge("Zamestnanecka spotreba", Amber)
    "other"      -> PoBadge("Ine", EspressoDim)
    else         -> PoBadge(if (reason.isBlank()) "—" else reason, EspressoDim)
}

private fun poStatusBadge(status: String): PoBadge = when (status) {
    "pending"  -> PoBadge("Caka", Amber)
    "approved" -> PoBadge("Schvaleny", Sage)
    "rejected" -> PoBadge("Zamietnuty", Danger)
    else       -> PoBadge(if (status.isBlank()) "—" else status, EspressoDim)
}

/* ===================================================================== */

@Composable
fun PohybyScreen() {
    val toast = LocalToast.current
    var tab by remember { mutableStateOf(0) }   // 0 = Pohyby, 1 = Odpisy

    AdminScreenBox(scrollable = false) {
        AdminSectionTitle("Sklad — pohyby a odpisy")
        PillTabs(listOf("Pohyby", "Odpisy"), tab) { tab = it }
        Spacer(Modifier.height(14.dp))
        when (tab) {
            0 -> PoMovementsTab(toast)
            else -> PoWriteOffsTab(toast)
        }
    }
}

/* ===================================================================== */
/*  TAB 1 — POHYBY                                                        */
/* ===================================================================== */

@Composable
private fun ColumnScope.PoMovementsTab(toast: PosToastState) {
    val scope = rememberCoroutineScope()

    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var movements by remember { mutableStateOf<List<PoMovementDto>>(emptyList()) }
    var total by remember { mutableStateOf(0) }
    var offset by remember { mutableStateOf(0) }

    // Ingredients: `ingredients` (len aktívne) pre filter dropdown + adjust
    // modal; `allIngredients` (vrátane deaktivovaných) pre name-join — inak
    // by historické pohyby ukazovali „ID: N". Menu lookup pre menuItemId.
    var ingredients by remember { mutableStateOf<List<PoIngredientDto>>(emptyList()) }
    var allIngredients by remember { mutableStateOf<List<PoIngredientDto>>(emptyList()) }
    var menuNameById by remember { mutableStateOf<Map<Int, String>>(emptyMap()) }
    val ingredientById = remember(allIngredients) { allIngredients.associateBy { it.id } }

    // Filtre (committed — aktívne pri loade).
    var fType by remember { mutableStateOf("") }            // ''/purchase/sale/adjustment/waste/inventory
    var fIngredientId by remember { mutableStateOf<Int?>(null) }
    var fFrom by remember { mutableStateOf("") }
    var fTo by remember { mutableStateOf("") }

    var showAdjust by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }

    fun loadMovements() {
        scope.launch {
            loading = true
            try {
                val res = withContext(Dispatchers.IO) {
                    poApi.movements(
                        type = fType.ifBlank { null },
                        ingredientId = fIngredientId,
                        from = fFrom.ifBlank { null },
                        to = fTo.ifBlank { null },
                        limit = PO_PAGE_SIZE,
                        offset = offset,
                    )
                }
                movements = res.data
                total = res.total
                error = null
            } catch (e: Exception) {
                if (e.httpCode() == 401) { /* relogin rieši shell */ }
                error = errorMessage(e)
            } finally {
                loading = false
            }
        }
    }

    fun applyFilters() {
        offset = 0
        loadMovements()
    }

    fun submitAdjust(ingredientId: Int, quantity: Double, type: String, note: String) {
        if (busy) return
        busy = true
        scope.launch {
            try {
                withContext(Dispatchers.IO) {
                    poApi.adjust(PoAdjustReq(ingredientId, quantity, type, note.ifBlank { null }))
                }
                toast.show("Uprava ulozena")
                showAdjust = false
                offset = 0
                loadMovements()
            } catch (e: Exception) {
                toast.show(errorMessage(e).ifBlank { "Chyba pri ukladani upravy" }, error = true)
            } finally {
                busy = false
            }
        }
    }

    LaunchedEffect(Unit) {
        // Ingredients (best-effort) + prvý load pohybov. Jeden request s
        // active="false" → všetky riadky; aktívne pre pickery filtrujeme lokálne.
        try {
            val all = withContext(Dispatchers.IO) { poApi.ingredients(active = "false") }
            allIngredients = all
            ingredients = all.filter { it.active }
        } catch (_: Exception) { /* filter zostane „Vsetky"; name-join padne na ID */ }
        // Druhý lookup: menuItemId-keyed pohyby (simple-tracked položky) —
        // najprv Mem cache, inak lite fetch /api/menu.
        menuNameById = sk.surfspirit.pos.core.Mem.categories
            ?.flatMap { it.items }?.associate { it.id to it.name }
            ?: runCatching {
                withContext(Dispatchers.IO) { poApi.menuLite() }
                    .flatMap { it.items }.associate { it.id to it.name }
            }.getOrDefault(emptyMap())
        loadMovements()
    }

    // --- Top bar: Ručná úprava ---
    if (isManager) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            Button(
                onClick = { showAdjust = true },
                modifier = Modifier.heightIn(min = 44.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Terra, contentColor = Cream),
            ) { Text("+ Ručná úprava") }
        }
        Spacer(Modifier.height(12.dp))
    }

    // --- Filter bar ---
    AdminCard {
        val typeLabels = listOf(
            "" to "Všetky",
            "purchase" to "Príjem",
            "sale" to "Predaj",
            "adjustment" to "Úprava",
            "waste" to "Odpad",
            "inventory" to "Inventúra",
        )
        FlowRowFilters {
            // Fixné šírky — vo FlowRow by interný fillMaxWidth inak roztiahol
            // každý prvok na celý riadok; takto sa na tablete zmestia vedľa
            // seba a na telefóne sa zalomia.
            PoSelect(
                label = "Typ",
                value = typeLabels.firstOrNull { it.first == fType }?.second ?: "Všetky",
                options = typeLabels.map { it.second },
                onSelect = { idx -> fType = typeLabels[idx].first },
                modifier = Modifier.width(150.dp),
            )
            val ingOptions = buildList {
                add("Všetky suroviny")
                ingredients.forEach { add(it.name) }
            }
            PoSelect(
                label = "Surovina",
                value = fIngredientId?.let { id -> ingredientById[id]?.name } ?: "Všetky suroviny",
                options = ingOptions,
                onSelect = { idx -> fIngredientId = if (idx == 0) null else ingredients[idx - 1].id },
                modifier = Modifier.width(180.dp),
            )
            FormField(
                label = "Od (YYYY-MM-DD)",
                value = fFrom,
                onChange = { fFrom = it },
                placeholder = "2026-01-01",
                modifier = Modifier.width(150.dp),
            )
            FormField(
                label = "Do (YYYY-MM-DD)",
                value = fTo,
                onChange = { fTo = it },
                placeholder = "2026-12-31",
                modifier = Modifier.width(150.dp),
            )
            Column {
                Spacer(Modifier.height(18.dp))   // zarovnaj k inputom (label výška)
                Button(
                    onClick = { applyFilters() },
                    modifier = Modifier.heightIn(min = 44.dp),
                ) { Text("Filtrovať") }
            }
        }
    }

    Spacer(Modifier.height(14.dp))

    // --- Tabuľka pohybov ---
    when {
        loading -> LoadingBox()
        error != null -> ErrorBox(error!!) { loadMovements() }
        movements.isEmpty() -> EmptyHint("Žiadne pohyby — pre zvolené filtre neboli nájdené žiadne skladové pohyby.")
        else -> {
            // Tabuľka v LazyColumn vlastnom — ale obrazovka nescrolluje, takže
            // vložíme do AdminCard s vnútorným verticalScroll (krátke stránky 50).
            AdminCard(Modifier.weight(1f, fill = false)) {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    TableHeader(
                        "Dátum" to 2.2f,
                        "Typ" to 1.4f,
                        "Surovina / Položka" to 2.4f,
                        "Množstvo" to 1.3f,
                        "Pred" to 1.2f,
                        "Po" to 1.2f,
                        "Poznámka" to 2.2f,
                    )
                    movements.forEach { m ->
                        PoMovementRow(m, ingredientById, menuNameById)
                    }
                }
            }
            Spacer(Modifier.height(10.dp))
            PoPaginationFooter(total, offset) { newOffset ->
                offset = newOffset
                loadMovements()
            }
        }
    }

    if (showAdjust) {
        PoAdjustModal(
            ingredients = ingredients,
            busy = busy,
            onDismiss = { if (!busy) showAdjust = false },
            onSave = { ingId, qty, type, note ->
                when {
                    ingId == null -> toast.show("Vyberte surovinu", error = true)
                    qty == null || qty == 0.0 -> toast.show("Zadajte nenulove mnozstvo", error = true)
                    else -> submitAdjust(ingId, qty, type, note)
                }
            },
        )
    }
}

@Composable
private fun PoMovementRow(
    m: PoMovementDto,
    ingredientById: Map<Int, PoIngredientDto>,
    menuNameById: Map<Int, String>,
) {
    val badge = poMovementBadge(m.type)
    val prev = m.previousQty.toDoubleOrNull() ?: 0.0
    val next = m.newQty.toDoubleOrNull() ?: 0.0
    val diff = next - prev
    val diffColor = when {
        diff >= 0 -> Sage
        else -> Danger
    }
    // Item-name resolution — server nejoinuje názvy: najprv ingredients
    // (vrátane deaktivovaných), potom menu (menuItemId), fallback „ID: N".
    val itemName = m.ingredientId?.let { ingredientById[it]?.name }
        ?: m.menuItemId?.let { menuNameById[it] }
        ?: ("ID: " + (m.ingredientId ?: m.menuItemId)?.toString().orEmpty().ifBlank { "--" })

    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(
            poFmtDate(m.createdAt),
            Modifier.weight(2.2f).padding(vertical = 10.dp),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
        Box(Modifier.weight(1.4f)) { StatusBadge(badge.label, badge.color) }
        Text(
            itemName,
            Modifier.weight(2.4f),
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.Medium,
            maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
        Text(
            poFmtQtyDiff(diff),
            Modifier.weight(1.3f),
            style = MaterialTheme.typography.bodyMedium,
            color = diffColor,
            fontWeight = FontWeight.SemiBold,
        )
        Text(
            poFmtNum(prev),
            Modifier.weight(1.2f),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            poFmtNum(next),
            Modifier.weight(1.2f),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            m.note.ifBlank { "—" },
            Modifier.weight(2.2f),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
    }
    HorizontalDivider(color = BorderSoft.copy(alpha = 0.5f))
}

/** Pagination footer — web parita: ≤50 → počet záznamov, inak prev/next. */
@Composable
private fun PoPaginationFooter(total: Int, offset: Int, onOffset: (Int) -> Unit) {
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (total <= PO_PAGE_SIZE) {
            Text(
                "$total záznamov",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            val currentPage = offset / PO_PAGE_SIZE + 1
            val totalPages = ((total + PO_PAGE_SIZE - 1) / PO_PAGE_SIZE).coerceAtLeast(1)
            OutlinedButton(
                onClick = { onOffset((offset - PO_PAGE_SIZE).coerceAtLeast(0)) },
                enabled = offset > 0,
                contentPadding = PaddingValues(horizontal = 14.dp, vertical = 10.dp),
                modifier = Modifier.heightIn(min = 44.dp),
            ) { Text("Predchádzajúca") }
            Text(
                "$currentPage z $totalPages",
                Modifier.padding(horizontal = 16.dp),
                style = MaterialTheme.typography.bodyMedium,
            )
            OutlinedButton(
                onClick = { onOffset(offset + PO_PAGE_SIZE) },
                enabled = currentPage < totalPages,
                contentPadding = PaddingValues(horizontal = 14.dp, vertical = 10.dp),
                modifier = Modifier.heightIn(min = 44.dp),
            ) { Text("Ďalšia strana") }
        }
    }
}

/** Ručná úprava — modal (Surovina, Množstvo, Typ, Poznámka). */
@Composable
private fun PoAdjustModal(
    ingredients: List<PoIngredientDto>,
    busy: Boolean,
    onDismiss: () -> Unit,
    onSave: (ingredientId: Int?, quantity: Double?, type: String, note: String) -> Unit,
) {
    var ingredientId by remember { mutableStateOf<Int?>(null) }
    var quantity by remember { mutableStateOf("") }
    var direction by remember { mutableStateOf("add") }     // add | remove — znamienko ide programovo
    var type by remember { mutableStateOf("adjustment") }   // adjustment | waste
    var note by remember { mutableStateOf("") }

    val ingById = remember(ingredients) { ingredients.associateBy { it.id } }

    PoModalScaffold(title = "Ručná úprava", maxWidth = 480.dp, onDismiss = onDismiss) {
        val ingOptions = buildList {
            add("-- Vyberte surovinu --")
            ingredients.forEach { add(it.name + " (" + it.unit + ")") }
        }
        PoSelect(
            label = "Surovina *",
            value = ingredientId?.let { id -> ingById[id]?.let { it.name + " (" + it.unit + ")" } }
                ?: "-- Vyberte surovinu --",
            options = ingOptions,
            onSelect = { idx -> ingredientId = if (idx == 0) null else ingredients[idx - 1].id },
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(12.dp))
        // Smer úpravy — znamienko sa posiela programovo (numerická klávesnica
        // na mnohých IME nemá mínus), množstvo je vždy kladné číslo.
        Text("Smer *", style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(4.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PoSegment("+ Pridať", direction == "add", Modifier.weight(1f)) { direction = "add" }
            PoSegment("− Odobrať", direction == "remove", Modifier.weight(1f)) { direction = "remove" }
        }
        Spacer(Modifier.height(12.dp))
        FormField(
            label = "Množstvo *",
            value = quantity,
            onChange = { quantity = it.replace(',', '.').filter { c -> c.isDigit() || c == '.' } },
            placeholder = "napr. 5 alebo 2,5",
            keyboard = KeyboardOptions(keyboardType = KeyboardType.Decimal),
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(12.dp))
        val typeLabels = listOf("adjustment" to "Úprava", "waste" to "Odpad")
        PoSelect(
            label = "Typ",
            value = typeLabels.firstOrNull { it.first == type }?.second ?: "Úprava",
            options = typeLabels.map { it.second },
            onSelect = { idx -> type = typeLabels[idx].first },
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(12.dp))
        FormField(
            label = "Poznámka",
            value = note,
            onChange = { note = it },
            placeholder = "Voliteľná poznámka…",
            singleLine = false,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(18.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            OutlinedButton(
                onClick = onDismiss,
                enabled = !busy,
                modifier = Modifier.weight(1f).heightIn(min = 44.dp),
            ) { Text("Zrušiť") }
            Button(
                onClick = {
                    // Znamienko podľa Pridať/Odobrať — vstup je vždy kladný.
                    val q = quantity.trim().toDoubleOrNull()?.let { v ->
                        if (direction == "remove") -kotlin.math.abs(v) else kotlin.math.abs(v)
                    }
                    onSave(ingredientId, q, type, note.trim())
                },
                enabled = !busy,
                modifier = Modifier.weight(1f).heightIn(min = 44.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Terra, contentColor = Cream),
            ) { Text("Uložiť") }
        }
    }
}

/* ===================================================================== */
/*  TAB 2 — ODPISY                                                        */
/* ===================================================================== */

@Composable
private fun ColumnScope.PoWriteOffsTab(toast: PosToastState) {
    val scope = rememberCoroutineScope()

    var view by remember { mutableStateOf(0) }              // 0 = Zoznam, 1 = Prehľad
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var writeOffs by remember { mutableStateOf<List<PoWriteOffDto>>(emptyList()) }
    var ingredients by remember { mutableStateOf<List<PoIngredientDto>>(emptyList()) }

    var activeStatus by remember { mutableStateOf("") }     // ''/pending/approved/rejected
    var summary by remember { mutableStateOf<PoWriteOffSummaryDto?>(null) }
    var summaryLoading by remember { mutableStateOf(false) }
    var summaryError by remember { mutableStateOf<String?>(null) }

    var busy by remember { mutableStateOf(false) }
    var detailFor by remember { mutableStateOf<PoWriteOffDto?>(null) }
    var showNew by remember { mutableStateOf(false) }
    var confirmApprove by remember { mutableStateOf<Int?>(null) }
    var confirmReject by remember { mutableStateOf<Int?>(null) }

    fun loadList() {
        scope.launch {
            loading = true
            try {
                val res = withContext(Dispatchers.IO) {
                    poApi.writeOffs(status = activeStatus.ifBlank { null })
                }
                writeOffs = res
                error = null
            } catch (e: Exception) {
                if (e.httpCode() == 401) { /* relogin */ }
                error = errorMessage(e)
            } finally {
                loading = false
            }
        }
    }

    fun loadSummary() {
        scope.launch {
            summaryLoading = true
            try {
                val now = java.time.LocalDate.now()
                val from = now.withDayOfMonth(1).toString()
                val to = now.toString()
                summary = withContext(Dispatchers.IO) { poApi.writeOffsSummary(from, to) }
                summaryError = null
            } catch (e: Exception) {
                summaryError = errorMessage(e)
            } finally {
                summaryLoading = false
            }
        }
    }

    fun approve(id: Int) {
        if (busy) return
        busy = true
        scope.launch {
            try {
                withContext(Dispatchers.IO) { poApi.approveWriteOff(id) }
                toast.show("Odpis #$id schvaleny")
                detailFor = null
                loadList()
            } catch (e: Exception) {
                toast.show(errorMessage(e).ifBlank { "Chyba pri schvalovani odpisu" }, error = true)
            } finally {
                busy = false
            }
        }
    }

    fun reject(id: Int) {
        if (busy) return
        busy = true
        scope.launch {
            try {
                withContext(Dispatchers.IO) { poApi.rejectWriteOff(id) }
                toast.show("Odpis #$id zamietnuty")
                detailFor = null
                loadList()
            } catch (e: Exception) {
                toast.show(errorMessage(e).ifBlank { "Chyba pri zamietani odpisu" }, error = true)
            } finally {
                busy = false
            }
        }
    }

    fun createWriteOff(reason: String, note: String, items: List<PoNewWriteOffItem>) {
        if (busy) return
        busy = true
        scope.launch {
            try {
                withContext(Dispatchers.IO) {
                    poApi.createWriteOff(PoCreateWriteOffReq(reason, note.ifBlank { null }, items))
                }
                toast.show("Odpis vytvoreny")
                showNew = false
                loadList()
            } catch (e: Exception) {
                toast.show(errorMessage(e).ifBlank { "Chyba pri vytvarani odpisu" }, error = true)
            } finally {
                busy = false
            }
        }
    }

    LaunchedEffect(Unit) {
        try {
            ingredients = withContext(Dispatchers.IO) { poApi.ingredients() }
        } catch (_: Exception) { }
        loadList()
    }

    // View toggle: Zoznam / Prehľad (summary sa načíta lazy pri 1. prepnutí).
    PillTabs(listOf("Zoznam", "Prehľad"), view) { idx ->
        view = idx
        if (idx == 1 && summary == null && !summaryLoading) loadSummary()
    }
    Spacer(Modifier.height(12.dp))

    if (view == 1) {
        PoSummaryView(summary, summaryLoading, summaryError, writeOffs, onRetry = { loadSummary() })
        return
    }

    // --- LIST VIEW ---
    if (isManager) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            Button(
                onClick = { showNew = true },
                modifier = Modifier.heightIn(min = 44.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Terra, contentColor = Cream),
            ) { Text("+ Nový odpis") }
        }
        Spacer(Modifier.height(12.dp))
    }

    // Status filter tabs.
    val statusTabs = listOf("" to "Všetky", "pending" to "Čakajúce", "approved" to "Schválené", "rejected" to "Zamietnuté")
    PillTabs(statusTabs.map { it.second }, statusTabs.indexOfFirst { it.first == activeStatus }.coerceAtLeast(0)) { idx ->
        activeStatus = statusTabs[idx].first
        loadList()
    }
    Spacer(Modifier.height(12.dp))

    when {
        loading -> LoadingBox()
        error != null -> ErrorBox(error!!) { loadList() }
        writeOffs.isEmpty() && activeStatus.isBlank() ->
            PoEmptyCta("Žiadne odpisy", "Vytvor prvý odpis pre záznam strát.", "Nový odpis".takeIf { isManager }) { showNew = true }
        writeOffs.isEmpty() ->
            PoEmptyCta("Žiadne výsledky", "Pre zvolený filter sa nenašli žiadne odpisy.", "Zrušiť filter") {
                activeStatus = ""; loadList()
            }
        else -> {
            // LazyColumn — zoznam je nepaginovaný (server nemá limit/offset),
            // za sezónu narastie na stovky riadkov; lazy kompozícia drží
            // prvý paint aj pamäť na uzde. Hlavička ako item, vizuál nezmenený.
            AdminCard(Modifier.weight(1f, fill = false)) {
                LazyColumn {
                    item {
                        TableHeader(
                            "ID" to 0.9f,
                            "Dátum" to 2.0f,
                            "Dôvod" to 1.8f,
                            "Položky" to 1.0f,
                            "Cena" to 1.4f,
                            "Stav" to 1.4f,
                            "Vytvoril" to 1.6f,
                            "Akcie" to 1.8f,
                        )
                    }
                    items(writeOffs, key = { it.id }) { wo ->
                        PoWriteOffRow(
                            wo = wo,
                            enabled = !busy && isManager,
                            onDetail = { detailFor = wo },
                            onApprove = { confirmApprove = wo.id },
                            onReject = { confirmReject = wo.id },
                        )
                    }
                }
            }
        }
    }

    detailFor?.let { wo ->
        PoDetailModal(
            wo = wo,
            enabled = !busy && isManager,
            onApprove = { confirmApprove = wo.id },
            onReject = { confirmReject = wo.id },
            onDismiss = { detailFor = null },
        )
    }

    if (showNew) {
        PoNewWriteOffModal(
            ingredients = ingredients,
            busy = busy,
            onDismiss = { if (!busy) showNew = false },
            onSave = { reason, note, items ->
                when {
                    reason.isBlank() -> toast.show("Vyberte dovod odpisu", error = true)
                    items.isEmpty() -> toast.show("Pridajte aspon jednu polozku s platnym mnozstvom", error = true)
                    else -> createWriteOff(reason, note, items)
                }
            },
        )
    }

    confirmApprove?.let { id ->
        AdminConfirm(
            title = "Schváliť odpis",
            text = "Naozaj chcete schváliť odpis #$id? Zásoby sa odpočítajú zo skladu.",
            confirmLabel = "Schváliť",
            onConfirm = { confirmApprove = null; approve(id) },
            onDismiss = { confirmApprove = null },
        )
    }
    confirmReject?.let { id ->
        AdminConfirm(
            title = "Zamietnuť odpis",
            text = "Naozaj chcete zamietnuť odpis #$id? Zásoby sa neodpočítajú.",
            confirmLabel = "Zamietnuť",
            danger = true,
            onConfirm = { confirmReject = null; reject(id) },
            onDismiss = { confirmReject = null },
        )
    }
}

@Composable
private fun PoWriteOffRow(
    wo: PoWriteOffDto,
    enabled: Boolean,
    onDetail: () -> Unit,
    onApprove: () -> Unit,
    onReject: () -> Unit,
) {
    val reason = poReasonBadge(wo.reason)
    val status = poStatusBadge(wo.status)
    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("#${wo.id}", Modifier.weight(0.9f),
            style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
        Text(poFmtDate(wo.createdAt), Modifier.weight(2.0f),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1, overflow = TextOverflow.Ellipsis)
        Box(Modifier.weight(1.8f)) { StatusBadge(reason.label, reason.color) }
        Text(wo.items.size.toString(), Modifier.weight(1.0f),
            style = MaterialTheme.typography.bodyMedium)
        Text(poFmtEur(wo.totalCost), Modifier.weight(1.4f),
            style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
        Box(Modifier.weight(1.4f)) { StatusBadge(status.label, status.color) }
        Text(wo.createdByName.ifBlank { "—" }, Modifier.weight(1.6f),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1, overflow = TextOverflow.Ellipsis)
        Row(Modifier.weight(1.8f), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            TextButton(onClick = onDetail, contentPadding = PaddingValues(horizontal = 8.dp)) {
                Text("Detail", color = Navy, style = MaterialTheme.typography.labelMedium)
            }
            if (wo.status == "pending" && enabled) {
                TextButton(onClick = onApprove, contentPadding = PaddingValues(horizontal = 6.dp)) {
                    Text("✓", color = Sage)
                }
                TextButton(onClick = onReject, contentPadding = PaddingValues(horizontal = 6.dp)) {
                    Text("✕", color = Danger)
                }
            }
        }
    }
    HorizontalDivider(color = BorderSoft.copy(alpha = 0.5f))
}

/* ---- Prehľad (summary) ---- */
@Composable
private fun ColumnScope.PoSummaryView(
    summary: PoWriteOffSummaryDto?,
    loading: Boolean,
    error: String?,
    writeOffs: List<PoWriteOffDto>,
    onRetry: () -> Unit,
) {
    when {
        loading && summary == null -> { LoadingBox(); return }
        error != null && summary == null -> { ErrorBox(error) { onRetry() }; return }
    }
    val s = summary ?: PoWriteOffSummaryDto()
    val byReason = s.byReason

    // Stat karty — 5 (web auto-fit). Tablet: 2 riadky po 3 / 2.
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        StatCard("Celkom odpisy", poFmtEur(s.total), accent = Terra, modifier = Modifier.weight(1f))
        StatCard("Expirácia", poFmtEur(byReason["expiration"] ?: 0.0), accent = Amber, modifier = Modifier.weight(1f))
        StatCard("Poškodenie", poFmtEur(byReason["damage"] ?: 0.0), accent = Danger, modifier = Modifier.weight(1f))
    }
    Spacer(Modifier.height(12.dp))
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        StatCard("Krádež", poFmtEur(byReason["theft"] ?: 0.0), accent = PoPurple, modifier = Modifier.weight(1f))
        StatCard("Iné (storno, spotreba)", poFmtEur(byReason["other"] ?: 0.0), accent = EspressoDim, modifier = Modifier.weight(1f))
        Spacer(Modifier.weight(1f))
    }

    Spacer(Modifier.height(16.dp))

    // Top 10 podľa nákladov (z aktuálne načítaného zoznamu — web parita).
    val top10 = writeOffs.sortedByDescending { it.totalCost }.take(10)
    AdminCard(Modifier.weight(1f, fill = false)) {
        Text("Najvyššie odpisy podľa nákladov", style = MaterialTheme.typography.titleSmall)
        Spacer(Modifier.height(8.dp))
        if (top10.isEmpty()) {
            EmptyHint("Žiadne dáta")
        } else {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                TableHeader(
                    "ID" to 0.9f,
                    "Dátum" to 2.0f,
                    "Dôvod" to 1.8f,
                    "Cena" to 1.4f,
                    "Stav" to 1.4f,
                    "Vytvoril" to 1.6f,
                )
                top10.forEach { wo ->
                    val reason = poReasonBadge(wo.reason)
                    val status = poStatusBadge(wo.status)
                    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text("#${wo.id}", Modifier.weight(0.9f),
                            style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                        Text(poFmtDate(wo.createdAt), Modifier.weight(2.0f),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Box(Modifier.weight(1.8f)) { StatusBadge(reason.label, reason.color) }
                        Text(poFmtEur(wo.totalCost), Modifier.weight(1.4f),
                            style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                        Box(Modifier.weight(1.4f)) { StatusBadge(status.label, status.color) }
                        Text(wo.createdByName.ifBlank { "—" }, Modifier.weight(1.6f),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    HorizontalDivider(color = BorderSoft.copy(alpha = 0.5f))
                }
            }
        }
    }
}

/* ---- Detail modal ---- */
@Composable
private fun PoDetailModal(
    wo: PoWriteOffDto,
    enabled: Boolean,
    onApprove: () -> Unit,
    onReject: () -> Unit,
    onDismiss: () -> Unit,
) {
    val reason = poReasonBadge(wo.reason)
    val status = poStatusBadge(wo.status)
    PoModalScaffold(title = "Odpis #${wo.id}", maxWidth = 640.dp, onDismiss = onDismiss) {
        // Meta grid — Dôvod / Dátum / Stav.
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Column(Modifier.weight(1f)) {
                PoMetaLabel("Dôvod"); StatusBadge(reason.label, reason.color)
            }
            Column(Modifier.weight(1f)) {
                PoMetaLabel("Dátum")
                Text(poFmtDate(wo.createdAt),
                    style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
            }
            Column(Modifier.weight(1f)) {
                PoMetaLabel("Stav"); StatusBadge(status.label, status.color)
            }
        }
        Spacer(Modifier.height(12.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Column(Modifier.weight(1f)) {
                PoMetaLabel("Vytvoril")
                Text(wo.createdByName.ifBlank { "—" },
                    style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
            }
            if (!wo.approvedByName.isNullOrBlank()) {
                Column(Modifier.weight(1f)) {
                    PoMetaLabel("Schválil")
                    Text(wo.approvedByName,
                        style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                }
            } else {
                Spacer(Modifier.weight(1f))
            }
        }
        if (wo.note.isNotBlank()) {
            Spacer(Modifier.height(12.dp))
            PoMetaLabel("Poznámka")
            Text(wo.note, style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }

        Spacer(Modifier.height(14.dp))
        PoMetaLabel("Položky")
        Spacer(Modifier.height(4.dp))
        if (wo.items.isEmpty()) {
            EmptyHint("Žiadne položky")
        } else {
            TableHeader(
                "Surovina" to 2.0f,
                "Jednotka" to 1.0f,
                "Množstvo" to 1.2f,
                "Jedn. cena" to 1.4f,
                "Spolu" to 1.4f,
            )
            wo.items.forEach { it ->
                Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(it.ingredientName.ifBlank { "—" }, Modifier.weight(2.0f),
                        style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(it.ingredientUnit.ifBlank { "—" }, Modifier.weight(1.0f),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(poFmtNum(it.quantity), Modifier.weight(1.2f),
                        style = MaterialTheme.typography.bodyMedium)
                    Text(poFmtEur(it.unitCost), Modifier.weight(1.4f),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(poFmtEur(it.totalCost), Modifier.weight(1.4f),
                        style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                }
                HorizontalDivider(color = BorderSoft.copy(alpha = 0.5f))
            }
        }

        Spacer(Modifier.height(12.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            Text("Celková cena: ", style = MaterialTheme.typography.bodyMedium)
            Text(poFmtEur(wo.totalCost),
                style = MaterialTheme.typography.titleSmall, color = Terra)
        }

        Spacer(Modifier.height(16.dp))
        if (wo.status == "pending" && enabled) {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Button(
                    onClick = onApprove,
                    modifier = Modifier.weight(1f).heightIn(min = 44.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = Sage, contentColor = Cream),
                ) { Text("Schváliť") }
                Button(
                    onClick = onReject,
                    modifier = Modifier.weight(1f).heightIn(min = 44.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = Danger, contentColor = Cream),
                ) { Text("Zamietnuť") }
            }
            Spacer(Modifier.height(10.dp))
        }
        OutlinedButton(
            onClick = onDismiss,
            modifier = Modifier.fillMaxWidth().heightIn(min = 44.dp),
        ) { Text("Zavrieť") }
    }
}

@Composable
private fun PoMetaLabel(text: String) {
    Text(text.uppercase(), style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant)
}

/* ---- Nový odpis modal ---- */
private data class PoNewRow(val key: Int, var ingredientId: Int?, var qty: String)

@Composable
private fun PoNewWriteOffModal(
    ingredients: List<PoIngredientDto>,
    busy: Boolean,
    onDismiss: () -> Unit,
    onSave: (reason: String, note: String, items: List<PoNewWriteOffItem>) -> Unit,
) {
    var reason by remember { mutableStateOf("") }          // ''/expiration/damage/theft/other
    var note by remember { mutableStateOf("") }
    var counter by remember { mutableStateOf(1) }
    val rows = remember { mutableStateListOf(PoNewRow(0, null, "")) }

    val ingById = remember(ingredients) { ingredients.associateBy { it.id } }

    fun costPerUnit(id: Int?): Double = id?.let { ingById[it]?.costPerUnit } ?: 0.0
    fun lineCost(r: PoNewRow): Double = (r.qty.replace(',', '.').toDoubleOrNull() ?: 0.0) * costPerUnit(r.ingredientId)
    val grandTotal = rows.sumOf { lineCost(it) }

    PoModalScaffold(title = "Nový odpis", maxWidth = 720.dp, onDismiss = onDismiss) {
        val reasonLabels = listOf(
            "" to "-- Vyberte dôvod --",
            "expiration" to "Expirácia",
            "damage" to "Poškodenie",
            "theft" to "Krádež",
            "other" to "Iné",
        )
        PoSelect(
            label = "Dôvod *",
            value = reasonLabels.firstOrNull { it.first == reason }?.second ?: "-- Vyberte dôvod --",
            options = reasonLabels.map { it.second },
            onSelect = { idx -> reason = reasonLabels[idx].first },
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(12.dp))
        FormField(
            label = "Poznámka",
            value = note,
            onChange = { note = it },
            placeholder = "Doplňujúce informácie…",
            singleLine = false,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(14.dp))
        Text("POLOŽKY *", style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(8.dp))

        val ingOptions = buildList {
            add("-- Surovina --")
            ingredients.forEach { add(it.name + " (" + it.unit + ")") }
        }
        rows.forEachIndexed { i, row ->
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Bottom,
                horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PoSelect(
                    label = "",
                    value = row.ingredientId?.let { id -> ingById[id]?.let { it.name + " (" + it.unit + ")" } }
                        ?: "-- Surovina --",
                    options = ingOptions,
                    onSelect = { idx ->
                        rows[i] = row.copy(ingredientId = if (idx == 0) null else ingredients[idx - 1].id)
                    },
                    modifier = Modifier.weight(2f),
                )
                FormField(
                    label = "",
                    value = row.qty,
                    onChange = { rows[i] = row.copy(qty = it.replace(',', '.')) },
                    placeholder = "Množstvo",
                    keyboard = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                    modifier = Modifier.weight(1f),
                )
                Text(
                    poFmtEur(lineCost(row)),
                    Modifier.widthIn(min = 86.dp).padding(bottom = 14.dp),
                    style = MaterialTheme.typography.bodyMedium,
                    color = EspressoSoft, textAlign = TextAlign.End,
                )
                TextButton(
                    onClick = { if (rows.size > 1) rows.removeAt(i) },
                    contentPadding = PaddingValues(horizontal = 6.dp),
                    modifier = Modifier.padding(bottom = 6.dp),
                ) { Text("✕", color = Danger) }
            }
            Spacer(Modifier.height(6.dp))
        }
        OutlinedButton(
            onClick = { counter++; rows.add(PoNewRow(counter, null, "")) },
            border = BorderStroke(1.dp, Terra),
            colors = ButtonDefaults.outlinedButtonColors(contentColor = Terra),
            modifier = Modifier.heightIn(min = 44.dp),
        ) { Text("+ Pridať položku") }

        Spacer(Modifier.height(14.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            Text("Celková cena: ", style = MaterialTheme.typography.bodyMedium)
            Text(poFmtEur(grandTotal), style = MaterialTheme.typography.titleSmall, color = Terra)
        }

        Spacer(Modifier.height(18.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            OutlinedButton(
                onClick = onDismiss,
                enabled = !busy,
                modifier = Modifier.weight(1f).heightIn(min = 44.dp),
            ) { Text("Zrušiť") }
            Button(
                onClick = {
                    val items = rows.mapNotNull { r ->
                        val q = r.qty.replace(',', '.').toDoubleOrNull() ?: 0.0
                        val id = r.ingredientId
                        if (id != null && q > 0) PoNewWriteOffItem(id, q) else null
                    }
                    onSave(reason, note.trim(), items)
                },
                enabled = !busy,
                modifier = Modifier.weight(1f).heightIn(min = 44.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Terra, contentColor = Cream),
            ) { Text("Vytvoriť odpis") }
        }
    }
}

/* ===================================================================== */
/*  Zdieľané drobnosti tohto súboru                                       */
/* ===================================================================== */

/** Empty-state karta s voliteľným CTA tlačidlom. */
@Composable
private fun ColumnScope.PoEmptyCta(title: String, text: String, cta: String?, onCta: () -> Unit) {
    AdminCard {
        Column(Modifier.fillMaxWidth().padding(vertical = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally) {
            Text(title, style = MaterialTheme.typography.titleSmall, textAlign = TextAlign.Center)
            Spacer(Modifier.height(6.dp))
            Text(text, style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
            if (cta != null) {
                Spacer(Modifier.height(12.dp))
                Button(
                    onClick = onCta,
                    modifier = Modifier.heightIn(min = 44.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = Terra, contentColor = Cream),
                ) { Text(cta) }
            }
        }
    }
}

/** Segment pill (Pridať/Odobrať) — Terra aktívny, rovnaká identita ako
 *  ostatné segmenty adminu. */
@Composable
private fun PoSegment(label: String, active: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Surface(
        onClick = onClick, modifier = modifier.heightIn(min = 44.dp),
        shape = RoundedCornerShape(Radius.sm),
        color = if (active) Terra else MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, if (active) Terra else BorderSoft),
    ) {
        Box(Modifier.fillMaxWidth().padding(vertical = 10.dp), contentAlignment = Alignment.Center) {
            Text(label, color = if (active) Cream else MaterialTheme.colorScheme.onSurface,
                style = MaterialTheme.typography.labelMedium)
        }
    }
}

/**
 * Jednoduchý select (dropdown) — label + klikateľné pole + DropdownMenu.
 * Žiadny experimentálny API, plný náhrada za <select>.
 */
@Composable
private fun PoSelect(
    label: String,
    value: String,
    options: List<String>,
    onSelect: (Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    var expanded by remember { mutableStateOf(false) }
    Column(modifier) {
        if (label.isNotBlank()) {
            Text(label, style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(4.dp))
        }
        Box {
            OutlinedButton(
                onClick = { expanded = true },
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                border = BorderStroke(1.dp, BorderMid),
                colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.onSurface),
                contentPadding = PaddingValues(horizontal = 12.dp),
            ) {
                Text(value, Modifier.weight(1f),
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                    textAlign = TextAlign.Start)
                Text("▾", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                options.forEachIndexed { idx, opt ->
                    DropdownMenuItem(
                        text = { Text(opt, style = MaterialTheme.typography.bodyMedium) },
                        onClick = { expanded = false; onSelect(idx) },
                    )
                }
            }
        }
    }
}

/** Modal obal — scrollovateľná karta v Dialog-u (cream paper, sk identita). */
@Composable
private fun PoModalScaffold(
    title: String,
    maxWidth: androidx.compose.ui.unit.Dp,
    onDismiss: () -> Unit,
    content: @Composable ColumnScope.() -> Unit,
) {
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(
            Modifier.fillMaxWidth(0.94f).widthIn(max = maxWidth)
                .heightIn(max = 640.dp)
                .paperShadow(Elev.float, RoundedCornerShape(Radius.md)),
            shape = RoundedCornerShape(Radius.md),
            color = MaterialTheme.colorScheme.surface,
            border = BorderStroke(1.dp, BorderSoft),
        ) {
            Column(Modifier.padding(20.dp).verticalScroll(rememberScrollState())) {
                Text(title, style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.fillMaxWidth(), textAlign = TextAlign.Center)
                Spacer(Modifier.height(16.dp))
                content()
            }
        }
    }
}

/** flex-wrap riadok filtrov — skutočný FlowRow, na telefóne / portrait
 *  tablete sa filtre zalomia do viacerých riadkov (rovnaký @OptIn pattern
 *  ako FlowRowChips v RecipesScreen). */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FlowRowFilters(content: @Composable () -> Unit) {
    FlowRow(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) { content() }
}
