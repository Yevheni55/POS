package sk.surfspirit.pos.ui.admin.pages

import androidx.compose.foundation.BorderStroke
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.Popup
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.PUT
import retrofit2.http.Path
import retrofit2.http.Query
import sk.surfspirit.pos.core.errorMessage
import sk.surfspirit.pos.core.fmtCost
import sk.surfspirit.pos.core.isManager
import sk.surfspirit.pos.net.Api
import sk.surfspirit.pos.ui.admin.*
import sk.surfspirit.pos.ui.components.LocalToast
import sk.surfspirit.pos.ui.components.PosToastState
import sk.surfspirit.pos.ui.theme.*

/* =====================================================================
   MaterialyScreen — natívny admin „Sklad / Materiály".
   Tri podstránky cez PillTabs: Suroviny | Tovar | Dodávatelia.
   Self-contained: vlastné DTO (prefix Mt) + Retrofit interface cez Api.create.
   ===================================================================== */

/* ----------------------------- DTOs ----------------------------- */

// GET /inventory/ingredients — server robí parseFloat → čísla sú Double.
@Serializable
private data class MtIngredientDto(
    val id: Int,
    val name: String = "",
    val unit: String = "ks",
    val type: String = "ingredient",
    val currentQty: Double = 0.0,
    val minQty: Double = 0.0,
    val costPerUnit: Double = 0.0,
    val active: Boolean = true,
    val createdAt: String? = null,
)

@Serializable
private data class MtIngredientReq(
    val name: String,
    val unit: String,
    val type: String,
    val currentQty: Double,
    val minQty: Double,
    val costPerUnit: Double,
)

// Tovar PUT posiela len name + minQty (qty rieši samostatný /movements/adjust).
@Serializable
private data class MtSupplyUpdateReq(
    val name: String,
    val minQty: Double,
)

@Serializable
private data class MtAdjustReq(
    val ingredientId: Int,
    val quantity: Double,   // DELTA (newQty - oldQty), môže byť záporné
    val type: String = "adjustment",
    val note: String = "Rucna uprava mnozstva",
)

@Serializable
private data class MtSupplierDto(
    val id: Int,
    val name: String = "",
    val contactPerson: String = "",
    val phone: String = "",
    val email: String = "",
    val notes: String = "",
    val active: Boolean = true,
    val createdAt: String? = null,
)

@Serializable
private data class MtSupplierReq(
    val name: String,
    val contactPerson: String = "",
    val phone: String = "",
    val email: String = "",
    val notes: String = "",
)

/* ----------------------------- API ----------------------------- */

private interface MtApi {
    @GET("api/inventory/ingredients")
    suspend fun ingredients(@Query("type") type: String): List<MtIngredientDto>

    // POST/PUT vracajú RAW Drizzle (numerá ako STRING) — telo nečítame, len reload.
    @POST("api/inventory/ingredients")
    suspend fun createIngredient(@Body body: MtIngredientReq): JsonElement

    @PUT("api/inventory/ingredients/{id}")
    suspend fun updateIngredient(@Path("id") id: Int, @Body body: MtIngredientReq): JsonElement

    // Tovar — PUT iba name+minQty.
    @PUT("api/inventory/ingredients/{id}")
    suspend fun updateSupply(@Path("id") id: Int, @Body body: MtSupplyUpdateReq): JsonElement

    @POST("api/inventory/movements/adjust")
    suspend fun adjust(@Body body: MtAdjustReq): JsonElement

    @DELETE("api/inventory/ingredients/{id}")
    suspend fun deleteIngredient(@Path("id") id: Int): JsonElement

    @GET("api/inventory/suppliers")
    suspend fun suppliers(): List<MtSupplierDto>

    @POST("api/inventory/suppliers")
    suspend fun createSupplier(@Body body: MtSupplierReq): JsonElement

    @PUT("api/inventory/suppliers/{id}")
    suspend fun updateSupplier(@Path("id") id: Int, @Body body: MtSupplierReq): JsonElement

    @DELETE("api/inventory/suppliers/{id}")
    suspend fun deleteSupplier(@Path("id") id: Int): JsonElement
}

private val mtApi: MtApi by lazy { Api.create(MtApi::class.java) }

/* --------------------------- Helpers --------------------------- */

/** sk-SK množstvo, 0–2 desatinné, čiarka. */
private fun mtFmtNum(v: Double): String {
    if (!v.isFinite()) return "0"
    val rounded = Math.round(v * 100.0) / 100.0
    val s = if (rounded == Math.floor(rounded)) {
        rounded.toLong().toString()
    } else {
        String.format("%.2f", rounded).trimEnd('0').trimEnd('.')
    }
    return s.replace('.', ',')
}

/** sk-SK input → Double (čiarka aj bodka), NaN/<0 → 0. */
private fun mtParseQty(raw: String): Double {
    val v = raw.replace(',', '.').trim().toDoubleOrNull() ?: 0.0
    return if (v.isFinite() && v >= 0) v else 0.0
}

private val MT_UNITS = listOf("ks", "kg", "g", "l", "ml")

/* ============================ SCREEN ============================ */

@Composable
fun MaterialyScreen() {
    val toast = LocalToast.current
    var tab by remember { mutableStateOf(0) }

    // scrollable=false → každý tab má tabuľku v LazyColumn (stovky SKU sa
    // nesmú komponovať naraz); toolbar + taby ostávajú fixné hore.
    AdminScreenBox(scrollable = false) {
        AdminSectionTitle("Sklad / Materiály")
        PillTabs(listOf("Suroviny", "Tovar", "Dodávatelia"), tab) { tab = it }
        Spacer(Modifier.height(12.dp))
        when (tab) {
            0 -> MtIngredientsTab(toast)
            1 -> MtSuppliesTab(toast)
            else -> MtSuppliersTab(toast)
        }
    }
}

/* ====================== TAB 1: Suroviny ====================== */

@Composable
private fun ColumnScope.MtIngredientsTab(toast: PosToastState) {
    val scope = rememberCoroutineScope()
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var items by remember { mutableStateOf<List<MtIngredientDto>>(emptyList()) }
    var search by remember { mutableStateOf("") }

    var editing by remember { mutableStateOf<MtIngredientDto?>(null) }
    var showForm by remember { mutableStateOf(false) }

    fun load() {
        scope.launch {
            loading = true
            try {
                val res = withContext(Dispatchers.IO) { mtApi.ingredients("ingredient") }
                items = res
                error = null
            } catch (e: Exception) {
                error = errorMessage(e)
            } finally {
                loading = false
            }
        }
    }
    LaunchedEffect(Unit) { load() }

    // Pending undo delete (id, pôvodný index, snapshot) — commit/flush/rollback
    // rieši zdieľaný controller (AdminUi), DELETE prežije odchod z tabu.
    val pendingDelete = rememberPendingDelete<Triple<Int, Int, MtIngredientDto>>(
        toast = toast,
        delete = { (id, _, _) -> mtApi.deleteIngredient(id) },
        rollback = { (_, idx, snap) ->
            val list = items.toMutableList()
            list.add(idx.coerceIn(0, list.size), snap)
            items = list
        },
        onCommitted = { load() },
    )

    val term = search.trim().lowercase()
    val filtered = if (term.isBlank()) items
    else items.filter { it.name.lowercase().contains(term) }

    MtSearchBar(
        addLabel = "Pridať surovinu",
        searchPlaceholder = "Hľadať surovinu…",
        search = search,
        onSearch = { search = it },
        onAdd = if (isManager) {
            { editing = null; showForm = true }
        } else null,
    )
    Spacer(Modifier.height(8.dp))

    when {
        loading -> LoadingBox()
        error != null -> ErrorBox(error!!) { load() }
        items.isEmpty() -> MtEmptyState(
            icon = "📦",
            title = "Žiadne suroviny",
            text = "Tu sa zobrazujú suroviny, ktoré nakupujete pre kuchyňu a bar. Začnite pridaním prvej.",
            ctaLabel = if (isManager) "Pridať prvú surovinu" else null,
            onCta = { editing = null; showForm = true },
        )
        filtered.isEmpty() -> MtEmptyState(
            icon = "🔍",
            title = "Žiadne výsledky",
            text = "Pre hľadaný výraz „$search\" sa nenašla žiadna surovina. Skúste iný výraz alebo zmažte filter.",
        )
        else -> AdminCard(Modifier.weight(1f, fill = false)) {
            TableHeader(
                "Názov" to 2.4f, "Jedn." to 0.9f, "Množstvo" to 1.4f,
                "Min." to 1.1f, "Cena/jedn." to 1.6f, "Stav" to 1.3f, "Akcie" to 1.3f,
            )
            // LazyColumn — riadky sa komponujú lenivo (stovky SKU za sezónu).
            LazyColumn(Modifier.weight(1f, fill = false)) {
                items(filtered, key = { it.id }) { item ->
                    MtIngredientRow(
                        item = item,
                        canEdit = isManager,
                        onEdit = { editing = item; showForm = true },
                        onDelete = {
                            val idx = items.indexOfFirst { it.id == item.id }
                            if (idx >= 0) {
                                // request() hneď commitne predošlý pending — jednoslotové
                                // undo ho nesmie potichu zahodiť.
                                pendingDelete.request(Triple(item.id, idx, item))
                                items = items.filterNot { it.id == item.id }
                            }
                        },
                    )
                }
            }
        }
    }

    // Optimistic undo delete — 5 s, potom commit DELETE + reload.
    pendingDelete.pending?.let { (id, idx, snap) ->
        MtUndoToast(
            itemId = id,
            label = "„${snap.name}\" zmazaná",
            onUndo = {
                val list = items.toMutableList()
                list.add(idx.coerceIn(0, list.size), snap)
                items = list
                pendingDelete.undo()
                toast.show("Vrátené")
            },
            onCommit = { pendingDelete.commit() },
        )
    }

    if (showForm) {
        MtIngredientDialog(
            editing = editing,
            onDismiss = { showForm = false },
            onSave = { name, unit, qty, minQty, cost ->
                scope.launch {
                    try {
                        val body = MtIngredientReq(name, unit, "ingredient", qty, minQty, cost)
                        withContext(Dispatchers.IO) {
                            val ed = editing
                            if (ed != null) mtApi.updateIngredient(ed.id, body)
                            else mtApi.createIngredient(body)
                        }
                        toast.show(if (editing != null) "Surovina upravená" else "Surovina pridaná")
                        showForm = false
                        load()
                    } catch (e: Exception) {
                        toast.show(errorMessage(e), error = true)
                    }
                }
            },
        )
    }
}

@Composable
private fun MtIngredientRow(
    item: MtIngredientDto,
    canEdit: Boolean,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    val (badgeText, badgeColor) = when {
        item.currentQty <= 0.0 -> "● Prázdny" to Danger
        item.currentQty <= item.minQty -> "▲ Nízky" to Amber
        else -> "✓ OK" to Sage
    }
    Row(
        Modifier.fillMaxWidth().padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(item.name, Modifier.weight(2.4f), style = MaterialTheme.typography.bodyMedium,
            maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(item.unit, Modifier.weight(0.9f), style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
        Text(mtFmtNum(item.currentQty), Modifier.weight(1.4f), style = MaterialTheme.typography.bodyMedium,
            textAlign = TextAlign.End, maxLines = 1)
        Text(mtFmtNum(item.minQty), Modifier.weight(1.1f), style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.End, maxLines = 1)
        Text("${fmtCost(item.costPerUnit)} €/${item.unit}", Modifier.weight(1.6f),
            style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.End,
            maxLines = 1, overflow = TextOverflow.Ellipsis)
        Box(Modifier.weight(1.3f), contentAlignment = Alignment.Center) {
            StatusBadge(badgeText, badgeColor)
        }
        Row(Modifier.weight(1.3f), horizontalArrangement = Arrangement.End,
            verticalAlignment = Alignment.CenterVertically) {
            if (canEdit) MtRowActions(onEdit = onEdit, onDelete = onDelete)
        }
    }
    HorizontalDivider(color = BorderSoft.copy(alpha = 0.5f))
}

@Composable
private fun MtIngredientDialog(
    editing: MtIngredientDto?,
    onDismiss: () -> Unit,
    onSave: (name: String, unit: String, qty: Double, minQty: Double, cost: Double) -> Unit,
) {
    var name by remember { mutableStateOf(editing?.name ?: "") }
    var unit by remember { mutableStateOf(editing?.unit ?: "ks") }
    var qty by remember { mutableStateOf(editing?.let { mtFmtNum(it.currentQty) } ?: "0") }
    var minQty by remember { mutableStateOf(editing?.let { mtFmtNum(it.minQty) } ?: "0") }
    var cost by remember { mutableStateOf(editing?.let { fmtCost(it.costPerUnit) } ?: "") }
    var nameError by remember { mutableStateOf(false) }

    MtFormDialog(
        title = if (editing != null) "Upraviť surovinu" else "Pridať surovinu",
        onDismiss = onDismiss,
        onSave = {
            if (name.isBlank()) { nameError = true; return@MtFormDialog }
            onSave(name.trim(), unit, mtParseQty(qty), mtParseQty(minQty), mtParseQty(cost))
        },
    ) {
        FormField("Názov *", name, { name = it; nameError = false }, placeholder = "napr. Múka hladká")
        if (nameError) MtFieldError("Zadajte názov suroviny")
        Spacer(Modifier.height(10.dp))
        MtUnitPicker(unit) { unit = it }
        Spacer(Modifier.height(10.dp))
        FormField("Aktuálne množstvo", qty, { qty = it },
            placeholder = "0", keyboard = KeyboardOptions(keyboardType = KeyboardType.Decimal))
        if (editing != null) {
            Spacer(Modifier.height(4.dp))
            Text("Zmena sa zaznamená do histórie skladu ako adjustment.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Spacer(Modifier.height(10.dp))
        FormField("Minimálne množstvo", minQty, { minQty = it },
            placeholder = "0", keyboard = KeyboardOptions(keyboardType = KeyboardType.Decimal))
        Spacer(Modifier.height(10.dp))
        FormField("Cena za jednotku (EUR)", cost, { cost = it },
            placeholder = "0,0000", keyboard = KeyboardOptions(keyboardType = KeyboardType.Decimal))
    }
}

/* ====================== TAB 2: Tovar ====================== */

@Composable
private fun ColumnScope.MtSuppliesTab(toast: PosToastState) {
    val scope = rememberCoroutineScope()
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var items by remember { mutableStateOf<List<MtIngredientDto>>(emptyList()) }
    var search by remember { mutableStateOf("") }

    var editing by remember { mutableStateOf<MtIngredientDto?>(null) }
    var showForm by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf<MtIngredientDto?>(null) }

    fun load() {
        scope.launch {
            loading = true
            try {
                val res = withContext(Dispatchers.IO) { mtApi.ingredients("supply") }
                items = res
                error = null
            } catch (e: Exception) {
                error = errorMessage(e)
            } finally {
                loading = false
            }
        }
    }
    LaunchedEffect(Unit) { load() }

    val term = search.trim().lowercase()
    val filtered = if (term.isBlank()) items
    else items.filter { it.name.lowercase().contains(term) }

    MtSearchBar(
        addLabel = "Pridať tovar",
        searchPlaceholder = "Hľadať tovar…",
        search = search,
        onSearch = { search = it },
        onAdd = if (isManager) {
            { editing = null; showForm = true }
        } else null,
    )
    Spacer(Modifier.height(8.dp))

    when {
        loading -> LoadingBox()
        error != null -> ErrorBox(error!!) { load() }
        items.isEmpty() -> MtEmptyState(
            icon = "🧴",
            title = "Žiadny tovar",
            text = "Pridajte hygienický tovar, čistiace prostriedky, obaly a pod.",
            ctaLabel = if (isManager) "Pridať tovar" else null,
            onCta = { editing = null; showForm = true },
        )
        filtered.isEmpty() -> MtEmptyState(
            icon = "🔍",
            title = "Žiadne výsledky",
            text = "Pre hľadaný výraz „$search\" sa nenašiel žiadny tovar.",
        )
        else -> AdminCard(Modifier.weight(1f, fill = false)) {
            TableHeader(
                "Názov" to 3f, "Množstvo" to 1.8f, "Minimum" to 1.5f,
                "Stav" to 1.4f, "Akcie" to 1.3f,
            )
            // LazyColumn — riadky sa komponujú lenivo.
            LazyColumn(Modifier.weight(1f, fill = false)) {
                items(filtered, key = { it.id }) { item ->
                    val (badgeText, badgeColor) = when {
                        item.currentQty <= 0.0 -> "Chýba" to Danger
                        item.currentQty <= item.minQty -> "Málo" to Amber
                        else -> "OK" to Sage
                    }
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(item.name, Modifier.weight(3f), style = MaterialTheme.typography.bodyMedium,
                            maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text("${mtFmtNum(item.currentQty)} ${item.unit}", Modifier.weight(1.8f),
                            style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.End, maxLines = 1)
                        Text(mtFmtNum(item.minQty), Modifier.weight(1.5f),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            textAlign = TextAlign.End, maxLines = 1)
                        Box(Modifier.weight(1.4f), contentAlignment = Alignment.Center) {
                            StatusBadge(badgeText, badgeColor)
                        }
                        Row(Modifier.weight(1.3f), horizontalArrangement = Arrangement.End,
                            verticalAlignment = Alignment.CenterVertically) {
                            if (isManager) MtRowActions(
                                onEdit = { editing = item; showForm = true },
                                onDelete = { confirmDelete = item },
                            )
                        }
                    }
                    HorizontalDivider(color = BorderSoft.copy(alpha = 0.5f))
                }
            }
        }
    }

    confirmDelete?.let { item ->
        AdminConfirm(
            title = "Vymazať tovar",
            text = "Naozaj chcete vymazať „${item.name}\"?",
            confirmLabel = "Vymazať",
            danger = true,
            onConfirm = {
                confirmDelete = null
                scope.launch {
                    try {
                        withContext(Dispatchers.IO) { mtApi.deleteIngredient(item.id) }
                        toast.show("Tovar odstránený")
                        load()
                    } catch (e: Exception) {
                        toast.show(errorMessage(e), error = true)
                    }
                }
            },
            onDismiss = { confirmDelete = null },
        )
    }

    if (showForm) {
        MtSupplyDialog(
            editing = editing,
            onDismiss = { showForm = false },
            onSave = { name, qty, minQty ->
                scope.launch {
                    try {
                        val ed = editing
                        withContext(Dispatchers.IO) {
                            if (ed != null) {
                                // 1) name + minQty; 2) ak sa qty zmenilo → samostatný adjust.
                                mtApi.updateSupply(ed.id, MtSupplyUpdateReq(name, minQty))
                                val delta = qty - ed.currentQty
                                if (kotlin.math.abs(delta) > 1e-9) {
                                    mtApi.adjust(MtAdjustReq(ingredientId = ed.id, quantity = delta))
                                }
                            } else {
                                mtApi.createIngredient(
                                    MtIngredientReq(name, "ks", "supply", qty, minQty, 0.0)
                                )
                            }
                            Unit   // withContext nevracia hodnotu — if/else je statement
                        }
                        toast.show(if (ed != null) "Tovar upravený" else "Tovar pridaný")
                        showForm = false
                        load()
                    } catch (e: Exception) {
                        toast.show(errorMessage(e), error = true)
                    }
                }
            },
        )
    }
}

@Composable
private fun MtSupplyDialog(
    editing: MtIngredientDto?,
    onDismiss: () -> Unit,
    onSave: (name: String, qty: Double, minQty: Double) -> Unit,
) {
    var name by remember { mutableStateOf(editing?.name ?: "") }
    var qty by remember { mutableStateOf(editing?.let { mtFmtNum(it.currentQty) } ?: "0") }
    var minQty by remember { mutableStateOf(editing?.let { mtFmtNum(it.minQty) } ?: "0") }
    var nameError by remember { mutableStateOf(false) }

    MtFormDialog(
        title = if (editing != null) "Upraviť tovar" else "Pridať tovar",
        onDismiss = onDismiss,
        onSave = {
            if (name.isBlank()) { nameError = true; return@MtFormDialog }
            onSave(name.trim(), mtParseQty(qty), mtParseQty(minQty))
        },
    ) {
        FormField("Názov *", name, { name = it; nameError = false }, placeholder = "napr. Saponát")
        if (nameError) MtFieldError("Zadajte názov tovaru")
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            FormField(
                if (editing != null) "Aktuálne množstvo" else "Počiatočné množstvo",
                qty, { qty = it }, modifier = Modifier.weight(1f),
                placeholder = "0", keyboard = KeyboardOptions(keyboardType = KeyboardType.Number),
            )
            FormField(
                "Minimum (upozornenie)", minQty, { minQty = it }, modifier = Modifier.weight(1f),
                placeholder = "0", keyboard = KeyboardOptions(keyboardType = KeyboardType.Number),
            )
        }
    }
}

/* ====================== TAB 3: Dodávatelia ====================== */

@Composable
private fun ColumnScope.MtSuppliersTab(toast: PosToastState) {
    val scope = rememberCoroutineScope()
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var items by remember { mutableStateOf<List<MtSupplierDto>>(emptyList()) }
    var search by remember { mutableStateOf("") }

    var editing by remember { mutableStateOf<MtSupplierDto?>(null) }
    var showForm by remember { mutableStateOf(false) }

    fun load() {
        scope.launch {
            loading = true
            try {
                val res = withContext(Dispatchers.IO) { mtApi.suppliers() }
                items = res
                error = null
            } catch (e: Exception) {
                error = errorMessage(e)
            } finally {
                loading = false
            }
        }
    }
    LaunchedEffect(Unit) { load() }

    // Pending undo delete (id, pôvodný index, snapshot) — zdieľaný controller;
    // zlyhanie DELETE = rollback + toast (zlyhaný delete sa nesmie stratiť ticho).
    val pendingDelete = rememberPendingDelete<Triple<Int, Int, MtSupplierDto>>(
        toast = toast,
        delete = { (id, _, _) -> mtApi.deleteSupplier(id) },
        rollback = { (_, idx, snap) ->
            val list = items.toMutableList()
            list.add(idx.coerceIn(0, list.size), snap)
            items = list
        },
        onCommitted = { load() },
    )

    val term = search.trim().lowercase()
    val filtered = if (term.isBlank()) items
    else items.filter {
        (it.name + " " + it.contactPerson + " " + it.email).lowercase().contains(term)
    }

    MtSearchBar(
        addLabel = "Pridať dodávateľa",
        searchPlaceholder = "Hľadať dodávateľa…",
        search = search,
        onSearch = { search = it },
        onAdd = if (isManager) {
            { editing = null; showForm = true }
        } else null,
    )
    Spacer(Modifier.height(8.dp))

    when {
        loading -> LoadingBox()
        error != null -> ErrorBox(error!!) { load() }
        items.isEmpty() -> EmptyHint("Žiadni dodávatelia. Pridajte prvého dodávateľa.")
        filtered.isEmpty() -> EmptyHint("Žiadne výsledky pre zadaný filter")
        else -> AdminCard(Modifier.weight(1f, fill = false)) {
            TableHeader(
                "Názov" to 2.2f, "Kontakt" to 1.8f, "Telefón" to 1.5f,
                "E-mail" to 2.2f, "Stav" to 1.2f, "Akcie" to 1.2f,
            )
            // LazyColumn — riadky sa komponujú lenivo.
            LazyColumn(Modifier.weight(1f, fill = false)) {
                items(filtered, key = { it.id }) { sup ->
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(sup.name, Modifier.weight(2.2f), style = MaterialTheme.typography.bodyMedium,
                            maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(sup.contactPerson.ifBlank { "—" }, Modifier.weight(1.8f),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(sup.phone.ifBlank { "—" }, Modifier.weight(1.5f),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(sup.email.ifBlank { "—" }, Modifier.weight(2.2f),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Box(Modifier.weight(1.2f), contentAlignment = Alignment.CenterStart) {
                            if (sup.active) StatusBadge("Aktívny", Sage)
                            else StatusBadge("Neaktívny", EspressoDim)
                        }
                        Row(Modifier.weight(1.2f), horizontalArrangement = Arrangement.End,
                            verticalAlignment = Alignment.CenterVertically) {
                            if (isManager) MtRowActions(
                                onEdit = { editing = sup; showForm = true },
                                onDelete = {
                                    val idx = items.indexOfFirst { it.id == sup.id }
                                    if (idx >= 0) {
                                        // request() hneď commitne predošlý pending — jednoslotové
                                        // undo ho nesmie potichu zahodiť.
                                        pendingDelete.request(Triple(sup.id, idx, sup))
                                        items = items.filterNot { it.id == sup.id }
                                    }
                                },
                            )
                        }
                    }
                    HorizontalDivider(color = BorderSoft.copy(alpha = 0.5f))
                }
            }
        }
    }

    pendingDelete.pending?.let { (id, idx, snap) ->
        MtUndoToast(
            itemId = id,
            label = "Dodávateľ „${snap.name}\" odstránený",
            onUndo = {
                val list = items.toMutableList()
                list.add(idx.coerceIn(0, list.size), snap)
                items = list
                pendingDelete.undo()
                toast.show("Vrátené")
            },
            onCommit = { pendingDelete.commit() },
        )
    }

    if (showForm) {
        MtSupplierDialog(
            editing = editing,
            onDismiss = { showForm = false },
            onSave = { req ->
                scope.launch {
                    try {
                        val ed = editing
                        withContext(Dispatchers.IO) {
                            if (ed != null) mtApi.updateSupplier(ed.id, req)
                            else mtApi.createSupplier(req)
                        }
                        toast.show(if (ed != null) "Dodávateľ upravený" else "Dodávateľ pridaný")
                        showForm = false
                        load()
                    } catch (e: Exception) {
                        toast.show(errorMessage(e), error = true)
                    }
                }
            },
        )
    }
}

@Composable
private fun MtSupplierDialog(
    editing: MtSupplierDto?,
    onDismiss: () -> Unit,
    onSave: (MtSupplierReq) -> Unit,
) {
    var name by remember { mutableStateOf(editing?.name ?: "") }
    var contact by remember { mutableStateOf(editing?.contactPerson ?: "") }
    var phone by remember { mutableStateOf(editing?.phone ?: "") }
    var email by remember { mutableStateOf(editing?.email ?: "") }
    var notes by remember { mutableStateOf(editing?.notes ?: "") }
    var nameError by remember { mutableStateOf(false) }

    MtFormDialog(
        title = if (editing != null) "Upraviť dodávateľa" else "Pridať dodávateľa",
        onDismiss = onDismiss,
        onSave = {
            if (name.isBlank()) { nameError = true; return@MtFormDialog }
            onSave(MtSupplierReq(name.trim(), contact.trim(), phone.trim(), email.trim(), notes.trim()))
        },
    ) {
        FormField("Názov *", name, { name = it; nameError = false }, placeholder = "Názov firmy")
        if (nameError) MtFieldError("Zadajte názov dodávateľa")
        Spacer(Modifier.height(10.dp))
        FormField("Kontaktná osoba", contact, { contact = it })
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            FormField("Telefón", phone, { phone = it }, modifier = Modifier.weight(1f),
                keyboard = KeyboardOptions(keyboardType = KeyboardType.Phone))
            FormField("E-mail", email, { email = it }, modifier = Modifier.weight(1f),
                keyboard = KeyboardOptions(keyboardType = KeyboardType.Email))
        }
        Spacer(Modifier.height(10.dp))
        FormField("Poznámky", notes, { notes = it }, singleLine = false)
    }
}

/* ====================== Shared building blocks ====================== */

/** Horný panel: „Pridať" tlačidlo + vyhľadávanie. */
@Composable
private fun MtSearchBar(
    addLabel: String,
    searchPlaceholder: String,
    search: String,
    onSearch: (String) -> Unit,
    onAdd: (() -> Unit)?,
) {
    Row(
        Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (onAdd != null) {
            Button(
                onClick = onAdd,
                colors = ButtonDefaults.buttonColors(containerColor = Terra, contentColor = Cream),
                modifier = Modifier.heightIn(min = 44.dp),
            ) { Text("+  $addLabel") }
        }
        OutlinedTextField(
            value = search,
            onValueChange = onSearch,
            placeholder = { Text(searchPlaceholder) },
            singleLine = true,
            modifier = Modifier.weight(1f),
        )
    }
}

/** Edit + delete textové akcie v riadku (≥44dp tap target). */
@Composable
private fun MtRowActions(onEdit: () -> Unit, onDelete: () -> Unit) {
    TextButton(onClick = onEdit, modifier = Modifier.sizeIn(minWidth = 44.dp, minHeight = 44.dp),
        contentPadding = PaddingValues(horizontal = 8.dp)) {
        Text("Upraviť", style = MaterialTheme.typography.labelMedium, color = Navy)
    }
    TextButton(onClick = onDelete, modifier = Modifier.sizeIn(minWidth = 44.dp, minHeight = 44.dp),
        contentPadding = PaddingValues(horizontal = 8.dp)) {
        Text("Zmazať", style = MaterialTheme.typography.labelMedium, color = Danger)
    }
}

/** Empty-state karta s ikonou + voliteľným CTA. */
@Composable
private fun MtEmptyState(
    icon: String,
    title: String,
    text: String,
    ctaLabel: String? = null,
    onCta: (() -> Unit)? = null,
) {
    AdminCard {
        Column(
            Modifier.fillMaxWidth().padding(vertical = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(icon, style = MaterialTheme.typography.displaySmall)
            Spacer(Modifier.height(8.dp))
            Text(title, style = MaterialTheme.typography.titleSmall)
            Spacer(Modifier.height(6.dp))
            Text(text, style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
            if (ctaLabel != null && onCta != null) {
                Spacer(Modifier.height(14.dp))
                Button(onClick = onCta,
                    colors = ButtonDefaults.buttonColors(containerColor = Terra, contentColor = Cream)) {
                    Text(ctaLabel)
                }
            }
        }
    }
}

@Composable
private fun MtFieldError(msg: String) {
    Spacer(Modifier.height(4.dp))
    Text(msg, style = MaterialTheme.typography.bodySmall, color = Danger)
}

/** Jednotka — segment row (web select náhrada). */
@Composable
private fun MtUnitPicker(selected: String, onSelect: (String) -> Unit) {
    Column {
        Text("Jednotka", style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(4.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            MT_UNITS.forEach { u ->
                val active = u == selected
                Surface(
                    onClick = { onSelect(u) },
                    shape = RoundedCornerShape(Radius.sm),
                    color = if (active) Terra else MaterialTheme.colorScheme.surface,
                    border = BorderStroke(1.dp, if (active) Terra else BorderSoft),
                ) {
                    Text(u, Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
                        color = if (active) Cream else MaterialTheme.colorScheme.onSurface,
                        style = MaterialTheme.typography.labelMedium)
                }
            }
        }
    }
}

/**
 * Generický form dialóg — Dialog + Surface (zhoda s ostatnými admin screenmi),
 * scrollovateľné telo, sticky Zrušiť / Uložiť dole.
 */
@Composable
private fun MtFormDialog(
    title: String,
    onDismiss: () -> Unit,
    onSave: () -> Unit,
    content: @Composable ColumnScope.() -> Unit,
) {
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(
            Modifier.fillMaxWidth(0.92f).widthIn(max = 520.dp)
                .paperShadow(Elev.float, RoundedCornerShape(Radius.md)),
            shape = RoundedCornerShape(Radius.md),
            color = MaterialTheme.colorScheme.surface,
            border = BorderStroke(1.dp, BorderSoft),
        ) {
            Column(Modifier.padding(18.dp)) {
                Text(title, style = MaterialTheme.typography.titleMedium)
                Spacer(Modifier.height(14.dp))
                Column(
                    Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()),
                ) { content() }
                Spacer(Modifier.height(16.dp))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    TextButton(onClick = onDismiss) { Text("Zrušiť") }
                    Spacer(Modifier.width(8.dp))
                    Button(onClick = onSave,
                        colors = ButtonDefaults.buttonColors(containerColor = Terra, contentColor = Cream)) {
                        Text("Uložiť")
                    }
                }
            }
        }
    }
}

/**
 * Undo toast pre optimistic delete — 5 s prúžok s „Vrátiť späť".
 * Po vypršaní spustí onCommit (server DELETE). onUndo vráti riadok.
 * Popup → pláva nad obsahom bez ohľadu na scope (ColumnScope tabu).
 */
@Composable
private fun MtUndoToast(
    itemId: Int,
    label: String,
    onUndo: () -> Unit,
    onCommit: () -> Unit,
) {
    val current by rememberUpdatedState(onCommit)
    // Časovač viazaný na ID položky — dve položky s rovnakým názvom (label)
    // nesmú zdieľať jedno undo okno.
    LaunchedEffect(itemId) {
        delay(5000)
        current()
    }
    Popup(alignment = Alignment.BottomCenter) {
        Surface(
            Modifier.padding(16.dp).paperShadow(Elev.float, RoundedCornerShape(Radius.md)),
            shape = RoundedCornerShape(Radius.md), color = Espresso, contentColor = Cream,
        ) {
            Row(Modifier.height(IntrinsicSize.Min), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.width(4.dp).fillMaxHeight().background(Amber))
                Text(label, Modifier.padding(start = 14.dp, top = 12.dp, bottom = 12.dp, end = 8.dp),
                    style = MaterialTheme.typography.bodyMedium)
                TextButton(onClick = onUndo, contentPadding = PaddingValues(horizontal = 12.dp)) {
                    Text("Vrátiť späť", color = Amber, style = MaterialTheme.typography.labelLarge)
                }
            }
        }
    }
}
