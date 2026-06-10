package sk.surfspirit.pos.ui.admin.pages

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
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
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.PUT
import retrofit2.http.Path
import sk.surfspirit.pos.core.errorMessage
import sk.surfspirit.pos.core.fmtCost
import sk.surfspirit.pos.core.httpCode
import sk.surfspirit.pos.core.isManager
import sk.surfspirit.pos.net.Api
import sk.surfspirit.pos.ui.admin.*
import sk.surfspirit.pos.ui.components.LocalToast
import sk.surfspirit.pos.ui.components.PosToastState
import sk.surfspirit.pos.ui.theme.*

/* =====================================================================
   Receptúry — natívna parita s admin/pages/recipes.js.
   Dvojpanelový master/detail editor receptúr: vľavo zoznam menu položiek
   (zoskupený podľa kategórie, filtre + hľadanie + food-cost badge), vpravo
   editor receptu (track-mode, simple form, recipe riadky + add ingredient).
   ===================================================================== */

/* ---------- DTOs (Rc prefix; numerické DB stĺpce sú už NUMBER) ---------- */

@Serializable
private data class RcMenuItem(
    val id: Int,
    val name: String = "",
    val emoji: String = "",
    val price: Double = 0.0,
    val trackMode: String = "none",        // none | simple | recipe
    val stockQty: Double = 0.0,
    val minStockQty: Double = 0.0,
    val categoryId: Int = 0,
    val categoryLabel: String = "",
    val categorySlug: String = "",
)

@Serializable
private data class RcSummary(
    val menuItemId: Int,
    val count: Int = 0,
    val cost: Double = 0.0,                 // €/porcia food cost
)

@Serializable
private data class RcSales(
    val menuItemId: Int,
    val soldQty: Int = 0,
    val lastSoldAt: String? = null,
)

@Serializable
private data class RcIngredient(
    val id: Int,
    val name: String = "",
    val unit: String = "",                  // ks | kg | g | l | ml
    val type: String = "",
    val currentQty: Double = 0.0,
    val minQty: Double = 0.0,
    val costPerUnit: Double = 0.0,
    val active: Boolean = true,
)

@Serializable
private data class RcRecipeLine(
    val id: Int = 0,
    val ingredientId: Int,
    val qtyPerUnit: Double = 0.0,
    val ingredientName: String = "",
    val ingredientUnit: String = "",
)

@Serializable private data class RcLineReq(val ingredientId: Int, val qtyPerUnit: Double)
@Serializable private data class RcSetRecipeReq(val lines: List<RcLineReq>)
@Serializable private data class RcStockConfigReq(
    val trackMode: String,
    val stockQty: Double? = null,
    val minStockQty: Double? = null,
)

private interface RcApi {
    @GET("api/inventory/menu-items") suspend fun menuItems(): List<RcMenuItem>
    @GET("api/inventory/recipes/summary") suspend fun summary(): List<RcSummary>
    @GET("api/inventory/menu-items/sales") suspend fun sales(): List<RcSales>
    @GET("api/inventory/ingredients") suspend fun ingredients(): List<RcIngredient>
    @GET("api/inventory/recipes/{id}") suspend fun recipe(@Path("id") menuItemId: Int): List<RcRecipeLine>
    @PUT("api/inventory/recipes/{id}") suspend fun setRecipe(@Path("id") menuItemId: Int, @Body body: RcSetRecipeReq): List<RcRecipeLine>
    @DELETE("api/inventory/recipes/{id}") suspend fun delRecipe(@Path("id") menuItemId: Int): JsonElement
    @PUT("api/inventory/menu-items/{id}/stock-config") suspend fun stockConfig(@Path("id") id: Int, @Body body: RcStockConfigReq): JsonElement
}

private val rcApi: RcApi by lazy { Api.create(RcApi::class.java) }

/* ---------- Pomocné funkcie ---------- */

/** Slovak diacritic-fold — 'cesnak' nájde 'česnak', 'maso' nájde 'mäso'. */
private fun foldDia(s: String): String =
    java.text.Normalizer.normalize(s.lowercase(), java.text.Normalizer.Form.NFD)
        .replace(Regex("\\p{Mn}+"), "")

/** Food-cost farba podľa % z predajnej ceny (HoReCa pravidlo). */
private fun foodCostColor(pct: Double): Color = when {
    pct <= 0.0 -> EspressoDim
    pct < 30.0 -> Sage          // < 30 % dobré (zelená)
    pct < 35.0 -> Amber         // 30-35 % OK (amber)
    else -> Danger              // > 35 % zle (červená)
}

/* ---------- Top-level screen ---------- */

@Composable
fun RecipesScreen() {
    val toast = LocalToast.current
    val scope = rememberCoroutineScope()
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }

    var menuItems by remember { mutableStateOf<List<RcMenuItem>>(emptyList()) }
    var ingredients by remember { mutableStateOf<List<RcIngredient>>(emptyList()) }
    var summary by remember { mutableStateOf<Map<Int, RcSummary>>(emptyMap()) }
    var sales by remember { mutableStateOf<Map<Int, Int>>(emptyMap()) }

    var selectedId by remember { mutableStateOf<Int?>(null) }
    var currentRecipe by remember { mutableStateOf<List<RcRecipeLine>>(emptyList()) }
    var recipeLoading by remember { mutableStateOf(false) }

    // Serializácia autosave-ov — dve rýchle úpravy (pridaj + oprav qty) by sa
    // inak prekrývali a starší response by mohol prepísať novší optimistický stav.
    val saveMutex = remember { Mutex() }

    var search by remember { mutableStateOf("") }
    var activeFilter by remember { mutableStateOf("all") }  // all|recipe|simple|none|sold-no-recipe

    fun trackModeOf(id: Int): String = menuItems.firstOrNull { it.id == id }?.trackMode ?: "none"

    // Filter + hľadanie spolu (diacritic-insensitive). 'sold-no-recipe' = predáva
    // sa od začiatku sezóny ale nemá recept; zoradené zostupne podľa predaja.
    fun filteredItems(): List<RcMenuItem> {
        val q = foldDia(search.trim())
        var out = menuItems.filter { m ->
            when {
                activeFilter == "sold-no-recipe" -> {
                    val sold = sales[m.id] ?: 0
                    if (sold <= 0) return@filter false
                    val hasRecipe = m.trackMode == "recipe" && (summary[m.id]?.count ?: 0) > 0
                    if (hasRecipe) return@filter false
                }
                activeFilter != "all" && m.trackMode != activeFilter -> return@filter false
            }
            if (q.isEmpty()) true
            else (foldDia(m.name) + " " + foldDia(m.categoryLabel)).contains(q)
        }
        if (activeFilter == "sold-no-recipe") {
            out = out.sortedByDescending { sales[it.id] ?: 0 }
        }
        return out
    }

    // Načítaj recept vybranej položky (len pri trackMode=recipe).
    fun loadRecipe(id: Int) {
        if (trackModeOf(id) != "recipe") { currentRecipe = emptyList(); return }
        scope.launch {
            recipeLoading = true
            try {
                val r = withContext(Dispatchers.IO) { rcApi.recipe(id) }
                currentRecipe = r
            } catch (_: Exception) {
                currentRecipe = emptyList()
            } finally {
                recipeLoading = false
            }
        }
    }

    fun selectItem(id: Int) {
        selectedId = id
        currentRecipe = emptyList()
        loadRecipe(id)
    }

    fun load() {
        scope.launch {
            loading = true
            try {
                val loaded = withContext(Dispatchers.IO) {
                    val a = async { rcApi.menuItems() }
                    val b = async { runCatching { rcApi.summary() }.getOrDefault(emptyList()) }
                    val c = async { runCatching { rcApi.sales() }.getOrDefault(emptyList()) }
                    val d = async { runCatching { rcApi.ingredients() }.getOrDefault(emptyList()) }
                    RcLoaded(a.await(), b.await(), c.await(), d.await())
                }
                val items = loaded.items
                val summaryList = loaded.summary
                val salesList = loaded.sales
                val ingList = loaded.ingredients
                menuItems = items
                summary = summaryList.associateBy { it.menuItemId }
                sales = salesList.associate { it.menuItemId to it.soldQty }
                ingredients = ingList
                error = null
                // Re-select existujúcu položku alebo prvú vo filtri.
                val still = selectedId?.let { sid -> items.any { it.id == sid } } ?: false
                if (!still) selectedId = null
                if (selectedId == null) {
                    val q = foldDia(search.trim())
                    val first = items.firstOrNull { m ->
                        (activeFilter == "all" || m.trackMode == activeFilter) &&
                            (q.isEmpty() || (foldDia(m.name) + " " + foldDia(m.categoryLabel)).contains(q))
                    }
                    if (first != null) selectItem(first.id)
                } else {
                    loadRecipe(selectedId!!)
                }
            } catch (e: Exception) {
                if (e.httpCode() == 401) { /* session handler rieši app-level */ }
                error = errorMessage(e)
            } finally {
                loading = false
            }
        }
    }

    LaunchedEffect(Unit) { load() }

    // Live food cost z currentRecipe × ingredient.costPerUnit, inak zo summary cache.
    fun liveFoodCost(item: RcMenuItem): Double {
        if (currentRecipe.isNotEmpty()) {
            return currentRecipe.sumOf { line ->
                val cpu = ingredients.firstOrNull { it.id == line.ingredientId }?.costPerUnit ?: 0.0
                line.qtyPerUnit * cpu
            }
        }
        return summary[item.id]?.cost ?: 0.0
    }

    // Ulož recept (prázdny → DELETE, inak PUT). Pri non-empty server flipne
    // trackMode→recipe; lokálne to premietneme. silent = autosave bez toastu.
    // Mutex: prekrývajúce sa save-y sa radia za seba; každý číta currentRecipe
    // až vo vnútri zámku, takže PUT vždy nesie najnovší lokálny stav.
    suspend fun saveRecipe(itemId: Int, silent: Boolean) = saveMutex.withLock {
        if (currentRecipe.isEmpty()) {
            withContext(Dispatchers.IO) { rcApi.delRecipe(itemId) }
        } else {
            val lines = currentRecipe.map { RcLineReq(it.ingredientId, it.qtyPerUnit) }
            val saved = withContext(Dispatchers.IO) { rcApi.setRecipe(itemId, RcSetRecipeReq(lines)) }
            currentRecipe = saved
            menuItems = menuItems.map { if (it.id == itemId) it.copy(trackMode = "recipe") else it }
        }
        // Obnov summary cache (food-cost badge v zozname).
        val fresh = runCatching { withContext(Dispatchers.IO) { rcApi.summary() } }.getOrNull()
        if (fresh != null) summary = fresh.associateBy { it.menuItemId }
        if (!silent) toast.show("Recept uložený")
    }

    // Po zlyhanom save NEvracaj stale snapshot (zmazal by novšiu súbežnú
    // úpravu) — obnov recept zo servera; ak aj reload zlyhá, nechaj aktuálny
    // lokálny stav (operátor zopakuje „Uložiť recept").
    suspend fun reloadRecipeAfterFailure(itemId: Int) {
        val r = runCatching { withContext(Dispatchers.IO) { rcApi.recipe(itemId) } }.getOrNull()
        if (r != null && selectedId == itemId) currentRecipe = r
    }

    AdminScreenBox(scrollable = false) {
        AdminSectionTitle("Receptúry")
        when {
            loading -> LoadingBox()
            error != null -> ErrorBox(error!!) { load() }
            else -> {
                Row(
                    Modifier.fillMaxSize(),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    // ----- ĽAVÝ PANEL: zoznam položiek -----
                    Column(Modifier.weight(1f).fillMaxHeight()) {
                        RcLeftPanel(
                            menuItems = menuItems,
                            summary = summary,
                            sales = sales,
                            search = search,
                            onSearch = { search = it },
                            activeFilter = activeFilter,
                            onFilter = { f ->
                                activeFilter = f
                                selectedId = null
                                currentRecipe = emptyList()
                                val first = filteredItems().firstOrNull()
                                if (first != null) selectItem(first.id)
                            },
                            filtered = filteredItems(),
                            selectedId = selectedId,
                            onSelect = { selectItem(it) },
                        )
                    }
                    // ----- PRAVÝ PANEL: editor -----
                    Column(Modifier.weight(1.4f).fillMaxHeight().verticalScroll(rememberScrollState())) {
                        val item = menuItems.firstOrNull { it.id == selectedId }
                        if (item == null) {
                            RcEmptyEditor()
                        } else {
                            RcEditor(
                                item = item,
                                recipe = currentRecipe,
                                recipeLoading = recipeLoading,
                                ingredients = ingredients,
                                foodCost = liveFoodCost(item),
                                toast = toast,
                                onChangeMode = { mode ->
                                    if (mode == item.trackMode) return@RcEditor
                                    scope.launch {
                                        try {
                                            val body = if (mode == "simple")
                                                RcStockConfigReq(mode, item.stockQty, item.minStockQty)
                                            else RcStockConfigReq(mode)
                                            withContext(Dispatchers.IO) { rcApi.stockConfig(item.id, body) }
                                            menuItems = menuItems.map { if (it.id == item.id) it.copy(trackMode = mode) else it }
                                            currentRecipe = emptyList()
                                            if (mode == "recipe") loadRecipe(item.id)
                                            toast.show("Režim sledovania zmenený")
                                        } catch (e: Exception) {
                                            toast.show(errorMessage(e), error = true)
                                        }
                                    }
                                },
                                onSaveSimple = { stock, min ->
                                    scope.launch {
                                        try {
                                            withContext(Dispatchers.IO) {
                                                rcApi.stockConfig(item.id, RcStockConfigReq("simple", stock, min))
                                            }
                                            menuItems = menuItems.map {
                                                if (it.id == item.id) it.copy(stockQty = stock, minStockQty = min) else it
                                            }
                                            toast.show("Konfigurácia uložená")
                                        } catch (e: Exception) {
                                            toast.show(errorMessage(e), error = true)
                                        }
                                    }
                                },
                                onAddLine = { ingId, qty ->
                                    val ing = ingredients.firstOrNull { it.id == ingId } ?: return@RcEditor
                                    currentRecipe = currentRecipe + RcRecipeLine(
                                        ingredientId = ingId, qtyPerUnit = qty,
                                        ingredientName = ing.name, ingredientUnit = ing.unit,
                                    )
                                    scope.launch {
                                        try {
                                            saveRecipe(item.id, silent = true)
                                            toast.show("Surovina pridaná a recept uložený")
                                        } catch (e: Exception) {
                                            toast.show(errorMessage(e), error = true)
                                            reloadRecipeAfterFailure(item.id)
                                        }
                                    }
                                },
                                onEditQty = { idx, newQty ->
                                    if (idx !in currentRecipe.indices) return@RcEditor
                                    val prev = currentRecipe[idx].qtyPerUnit
                                    if (newQty == prev) return@RcEditor
                                    currentRecipe = currentRecipe.mapIndexed { i, l ->
                                        if (i == idx) l.copy(qtyPerUnit = newQty) else l
                                    }
                                    scope.launch {
                                        try {
                                            saveRecipe(item.id, silent = true)
                                            toast.show("Množstvo upravené a recept uložený")
                                        } catch (e: Exception) {
                                            toast.show(errorMessage(e), error = true)
                                            reloadRecipeAfterFailure(item.id)
                                        }
                                    }
                                },
                                onRemoveLine = { idx ->
                                    if (idx !in currentRecipe.indices) return@RcEditor
                                    currentRecipe = currentRecipe.filterIndexed { i, _ -> i != idx }
                                    scope.launch {
                                        try {
                                            saveRecipe(item.id, silent = true)
                                            toast.show("Surovina odstránená")
                                        } catch (e: Exception) {
                                            toast.show(errorMessage(e), error = true)
                                            reloadRecipeAfterFailure(item.id)
                                        }
                                    }
                                },
                                onSaveRecipe = {
                                    scope.launch {
                                        try {
                                            saveRecipe(item.id, silent = false)
                                        } catch (e: Exception) {
                                            toast.show(errorMessage(e), error = true)
                                        }
                                    }
                                },
                            )
                        }
                    }
                }
            }
        }
    }
}

/* ---------- ĽAVÝ PANEL ---------- */

@Composable
private fun RcLeftPanel(
    menuItems: List<RcMenuItem>,
    summary: Map<Int, RcSummary>,
    sales: Map<Int, Int>,
    search: String,
    onSearch: (String) -> Unit,
    activeFilter: String,
    onFilter: (String) -> Unit,
    filtered: List<RcMenuItem>,
    selectedId: Int?,
    onSelect: (Int) -> Unit,
) {
    // Počty pre filter chipy.
    val cAll = menuItems.size
    val cRecipe = menuItems.count { it.trackMode == "recipe" }
    val cSimple = menuItems.count { it.trackMode == "simple" }
    val cNone = menuItems.count { it.trackMode == "none" }
    val cSold = menuItems.count { m ->
        val sold = sales[m.id] ?: 0
        val hasRecipe = m.trackMode == "recipe" && (summary[m.id]?.count ?: 0) > 0
        sold > 0 && !hasRecipe
    }

    AdminCard(Modifier.fillMaxHeight()) {
        Text("Položky menu", style = MaterialTheme.typography.titleSmall)
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(
            value = search,
            onValueChange = onSearch,
            placeholder = { Text("Hľadať surovinu, jedlo, kategóriu…") },
            singleLine = true,
            leadingIcon = { Text("🔍") },
            trailingIcon = {
                if (search.isNotEmpty()) {
                    TextButton(onClick = { onSearch("") }, contentPadding = PaddingValues(8.dp)) {
                        Text("✕", color = EspressoSoft)
                    }
                }
            },
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(8.dp))

        // Filter chipy s počtami.
        val tabs = listOf(
            "all" to "Všetky $cAll",
            "recipe" to "Recept $cRecipe",
            "simple" to "Simple $cSimple",
            "none" to "Bez $cNone",
            "sold-no-recipe" to "⚠ Bez receptu (predáva sa) $cSold",
        )
        FlowRowChips(tabs, activeFilter, onFilter)

        Spacer(Modifier.height(6.dp))
        val countLine = if (search.isNotBlank())
            "${filtered.size} / ${menuItems.size} (vyhľadávanie)"
        else "${filtered.size} položiek"
        Text(
            countLine.uppercase(),
            style = MaterialTheme.typography.labelSmall,
            color = EspressoDim,
        )
        Spacer(Modifier.height(4.dp))
        HorizontalDivider(color = BorderSoft)

        if (filtered.isEmpty()) {
            val msg = when {
                search.isNotBlank() -> "Žiadne výsledky pre „$search\""
                activeFilter == "all" -> "Žiadne položky v menu"
                else -> "Žiadne položky s módom „$activeFilter\""
            }
            EmptyHint(msg)
            return@AdminCard
        }

        // Zoskupené podľa kategórie (poradie zachované zo servera).
        val groups = LinkedHashMap<String, MutableList<RcMenuItem>>()
        filtered.forEach { item ->
            val key = item.categorySlug.ifBlank { item.categoryId.toString() }
            groups.getOrPut(key) { mutableListOf() }.add(item)
        }

        LazyColumn(Modifier.fillMaxWidth()) {
            groups.forEach { (_, catItems) ->
                item {
                    Text(
                        (catItems.first().categoryLabel.ifBlank { "Ostatné" }).uppercase(),
                        style = MaterialTheme.typography.labelSmall,
                        color = EspressoDim,
                        modifier = Modifier.padding(top = 10.dp, bottom = 2.dp),
                    )
                }
                items(catItems, key = { it.id }) { mi ->
                    RcItemRow(
                        item = mi,
                        summary = summary[mi.id],
                        sold = sales[mi.id] ?: 0,
                        selected = mi.id == selectedId,
                        onClick = { onSelect(mi.id) },
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FlowRowChips(tabs: List<Pair<String, String>>, selected: String, onSelect: (String) -> Unit) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        tabs.forEach { (f, label) ->
            val active = f == selected
            Surface(
                onClick = { onSelect(f) },
                shape = RoundedCornerShape(Radius.full),
                color = if (active) Terra else MaterialTheme.colorScheme.surface,
                border = BorderStroke(1.dp, if (active) Terra else BorderSoft),
            ) {
                Text(
                    label,
                    Modifier.padding(horizontal = 12.dp, vertical = 7.dp),
                    color = if (active) Cream else MaterialTheme.colorScheme.onSurface,
                    style = MaterialTheme.typography.labelMedium,
                    maxLines = 1,
                )
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun RcItemRow(
    item: RcMenuItem,
    summary: RcSummary?,
    sold: Int,
    selected: Boolean,
    onClick: () -> Unit,
) {
    val count = summary?.count ?: 0
    val foodCost = summary?.cost ?: 0.0
    val interaction = remember { MutableInteractionSource() }
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(Radius.sm),
        color = if (selected) Terra.copy(alpha = 0.10f) else Color.Transparent,
        border = if (selected) BorderStroke(1.dp, Terra.copy(alpha = 0.4f)) else null,
        modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp).pressScale(interaction),
        interactionSource = interaction,
    ) {
        Row(
            Modifier.padding(horizontal = 8.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(item.emoji.ifBlank { "🍽" }, style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.width(8.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    item.name,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Spacer(Modifier.height(3.dp))
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(5.dp),
                    verticalArrangement = Arrangement.spacedBy(3.dp),
                ) {
                    // Track-mode badge.
                    val (modeLabel, modeColor) = when (item.trackMode) {
                        "recipe" -> "recept" to Navy
                        "simple" -> "simple" to Sage
                        else -> "none" to EspressoDim
                    }
                    StatusBadge(modeLabel, modeColor)
                    if (count > 0) {
                        Text(
                            "$count surov.",
                            style = MaterialTheme.typography.labelSmall,
                            color = EspressoDim,
                        )
                    }
                    // Food-cost badge €/porcia + % z ceny.
                    if (count > 0 && foodCost > 0) {
                        val pct = if (item.price > 0) foodCost / item.price * 100 else 0.0
                        val fc = foodCostColor(pct)
                        val pctLabel = if (item.price > 0) " · ${pct.toInt()}%" else ""
                        RcMiniBadge("${fmtCost(foodCost)} €$pctLabel", fc, bold = true)
                    }
                    // Sold badge — amber+bold ak bez receptu, šedý ak recept existuje.
                    if (sold > 0) {
                        val hasRecipe = item.trackMode == "recipe" && count > 0
                        if (hasRecipe) RcMiniBadge("${sold}x", EspressoDim, bold = false)
                        else RcMiniBadge("${sold}x", Amber, bold = true)
                    }
                }
            }
        }
    }
}

@Composable
private fun RcMiniBadge(text: String, color: Color, bold: Boolean) {
    Surface(
        shape = RoundedCornerShape(Radius.xs),
        color = color.copy(alpha = 0.14f),
    ) {
        Text(
            text,
            Modifier.padding(horizontal = 6.dp, vertical = 1.dp),
            style = MaterialTheme.typography.labelSmall,
            color = color,
            fontWeight = if (bold) FontWeight.Bold else FontWeight.Normal,
            maxLines = 1,
        )
    }
}

/* ---------- PRAVÝ PANEL ---------- */

@Composable
private fun RcEmptyEditor() {
    AdminCard(Modifier.fillMaxWidth()) {
        Box(Modifier.fillMaxWidth().padding(vertical = 60.dp), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text("👈", fontSize = 32.sp) // token-exempt: velkost mimo skaly
                Spacer(Modifier.height(8.dp))
                Text("Vyberte položku", style = MaterialTheme.typography.titleSmall)
                Spacer(Modifier.height(4.dp))
                Text(
                    "Vyberte položku z ľavého panelu pre úpravu receptúry",
                    style = MaterialTheme.typography.bodySmall,
                    color = EspressoDim,
                )
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun RcEditor(
    item: RcMenuItem,
    recipe: List<RcRecipeLine>,
    recipeLoading: Boolean,
    ingredients: List<RcIngredient>,
    foodCost: Double,
    toast: PosToastState,
    onChangeMode: (String) -> Unit,
    onSaveSimple: (Double, Double) -> Unit,
    onAddLine: (Int, Double) -> Unit,
    onEditQty: (Int, Double) -> Unit,
    onRemoveLine: (Int) -> Unit,
    onSaveRecipe: () -> Unit,
) {
    AdminCard(Modifier.fillMaxWidth()) {
        // --- HLAVIČKA ---
        Text(
            "${item.emoji} ${item.name}".trim(),
            style = MaterialTheme.typography.titleMedium,
        )
        Spacer(Modifier.height(8.dp))
        val pct = if (item.price > 0 && foodCost > 0) foodCost / item.price * 100 else 0.0
        val fcColor = foodCostColor(pct)
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(14.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            RcStatChip("Cena", "${fmtCost(item.price)} €", Espresso)
            if (foodCost > 0) {
                RcStatChip("Food cost", "${fmtCost(foodCost)} €", fcColor)
                if (pct > 0) {
                    RcMiniBadge("${String.format("%.1f", pct).replace('.', ',')} % z ceny", fcColor, bold = true)
                }
                if (item.price > 0) {
                    RcStatChip("Marža", "+${fmtCost(item.price - foodCost)} €", Espresso)
                }
            } else {
                Text(
                    "Food cost: nie je recept",
                    style = MaterialTheme.typography.bodyMedium,
                    color = EspressoDim,
                    fontStyle = FontStyle.Italic,
                )
            }
        }

        Spacer(Modifier.height(14.dp))
        HorizontalDivider(color = BorderSoft)
        Spacer(Modifier.height(14.dp))

        // --- TRACK-MODE SELECTOR ---
        Text(
            "Režim sledovania skladu",
            style = MaterialTheme.typography.labelMedium,
            color = EspressoSoft,
        )
        Spacer(Modifier.height(8.dp))
        val gated = isManager
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            RcModeButton("Žiadne", item.trackMode == "none", gated) { onChangeMode("none") }
            RcModeButton("Jednoduché", item.trackMode == "simple", gated) { onChangeMode("simple") }
            RcModeButton("Recept", item.trackMode == "recipe", gated) { onChangeMode("recipe") }
        }

        Spacer(Modifier.height(16.dp))

        // --- TELO podľa módu ---
        when (item.trackMode) {
            "none" -> {
                Box(Modifier.fillMaxWidth().padding(vertical = 36.dp), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("🚫", fontSize = 28.sp) // token-exempt: velkost mimo skaly
                        Spacer(Modifier.height(6.dp))
                        Text("Sledovanie skladu vypnuté", style = MaterialTheme.typography.titleSmall)
                        Spacer(Modifier.height(4.dp))
                        Text(
                            "Zvoľte režim „Jednoduché\" alebo „Recept\" pre sledovanie tejto položky",
                            style = MaterialTheme.typography.bodySmall,
                            color = EspressoDim,
                        )
                    }
                }
            }
            "simple" -> RcSimpleForm(item, onSaveSimple)
            "recipe" -> RcRecipeForm(item, recipe, recipeLoading, ingredients, toast, onAddLine, onEditQty, onRemoveLine, onSaveRecipe)
        }
    }
}

@Composable
private fun RcStatChip(label: String, value: String, color: Color) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("$label: ", style = MaterialTheme.typography.bodyMedium, color = EspressoSoft)
        Text(value, style = MaterialTheme.typography.bodyMedium, color = color, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun RcModeButton(label: String, active: Boolean, enabled: Boolean, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        enabled = enabled,
        shape = RoundedCornerShape(Radius.sm),
        color = if (active) Terra else MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, if (active) Terra else BorderSoft),
        modifier = Modifier.heightIn(min = 44.dp),
    ) {
        Box(Modifier.padding(horizontal = 16.dp, vertical = 11.dp), contentAlignment = Alignment.Center) {
            Text(
                label,
                color = if (active) Cream else MaterialTheme.colorScheme.onSurface,
                style = MaterialTheme.typography.labelLarge,
            )
        }
    }
}

@Composable
private fun RcSimpleForm(item: RcMenuItem, onSave: (Double, Double) -> Unit) {
    var stock by remember(item.id) { mutableStateOf(rcNumStr(item.stockQty)) }
    var min by remember(item.id) { mutableStateOf(rcNumStr(item.minStockQty)) }
    Column {
        FormField(
            "Aktuálne množstvo na sklade", stock, { stock = it },
            keyboard = KeyboardOptions(keyboardType = KeyboardType.Decimal),
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(12.dp))
        FormField(
            "Minimálne množstvo (upozornenie)", min, { min = it },
            keyboard = KeyboardOptions(keyboardType = KeyboardType.Decimal),
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(16.dp))
        Button(
            onClick = { onSave(stock.replace(',', '.').toDoubleOrNull() ?: 0.0, min.replace(',', '.').toDoubleOrNull() ?: 0.0) },
            colors = ButtonDefaults.buttonColors(containerColor = Terra, contentColor = Cream),
            modifier = Modifier.heightIn(min = 44.dp),
        ) { Text("Uložiť") }
    }
}

@Composable
private fun RcRecipeForm(
    item: RcMenuItem,
    recipe: List<RcRecipeLine>,
    recipeLoading: Boolean,
    ingredients: List<RcIngredient>,
    toast: PosToastState,
    onAddLine: (Int, Double) -> Unit,
    onEditQty: (Int, Double) -> Unit,
    onRemoveLine: (Int) -> Unit,
    onSaveRecipe: () -> Unit,
) {
    Column {
        when {
            recipeLoading -> LoadingBox()
            recipe.isEmpty() -> {
                Box(
                    Modifier.fillMaxWidth()
                        .border(1.5.dp, BorderMid, RoundedCornerShape(Radius.md))
                        .padding(vertical = 28.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("🧪", style = MaterialTheme.typography.titleLarge)
                        Spacer(Modifier.height(6.dp))
                        Text("Prázdny recept", style = MaterialTheme.typography.titleSmall, color = EspressoSoft)
                        Spacer(Modifier.height(2.dp))
                        Text("Pridajte suroviny nižšie", style = MaterialTheme.typography.bodySmall, color = EspressoDim)
                    }
                }
            }
            else -> {
                recipe.forEachIndexed { idx, line ->
                    RcRecipeCard(
                        line = line,
                        toast = toast,
                        onCommitQty = { v -> onEditQty(idx, v) },
                        onRemove = { onRemoveLine(idx) },
                    )
                    Spacer(Modifier.height(6.dp))
                }
            }
        }

        Spacer(Modifier.height(16.dp))

        // --- ADD INGREDIENT ---
        RcAddIngredient(
            ingredients = ingredients,
            usedIds = recipe.map { it.ingredientId }.toSet(),
            toast = toast,
            onAdd = onAddLine,
        )

        Spacer(Modifier.height(18.dp))
        Button(
            onClick = onSaveRecipe,
            colors = ButtonDefaults.buttonColors(containerColor = Terra, contentColor = Cream),
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
        ) { Text("Uložiť recept") }
    }
}

/** Farebné ladenie podľa jednotky: ks=Navy, kg/g=Sage, l/ml=Amber. */
private fun rcUnitColor(unit: String): Color = when (unit.lowercase()) {
    "ks" -> Navy
    "kg", "g" -> Sage
    "l", "ml" -> Amber
    else -> Navy
}

@Composable
private fun RcRecipeCard(line: RcRecipeLine, toast: PosToastState, onCommitQty: (Double) -> Unit, onRemove: () -> Unit) {
    val uc = rcUnitColor(line.ingredientUnit)
    var qtyText by remember(line.id, line.ingredientId, line.qtyPerUnit) { mutableStateOf(rcNumStr(line.qtyPerUnit)) }
    Surface(
        shape = RoundedCornerShape(Radius.sm),
        color = uc.copy(alpha = 0.05f),
        border = BorderStroke(1.dp, uc.copy(alpha = 0.18f)),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Box(Modifier.width(3.dp).heightIn(min = 36.dp).background(uc.copy(alpha = 0.5f)))
            Text(
                line.ingredientName,
                Modifier.weight(1f),
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.Bold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            OutlinedTextField(
                value = qtyText,
                onValueChange = { qtyText = it },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                modifier = Modifier.width(110.dp),
            )
            // Commit tlačidlo — uloží zmenenú qty (validácia > 0, inak revert).
            Surface(
                onClick = {
                    val v = qtyText.replace(',', '.').toDoubleOrNull()
                    if (v == null || v <= 0.0) {
                        qtyText = rcNumStr(line.qtyPerUnit)  // revert na poslednú platnú hodnotu
                        toast.show("Množstvo musí byť > 0", error = true)
                    } else {
                        onCommitQty(v)
                    }
                },
                shape = RoundedCornerShape(Radius.sm),
                color = uc.copy(alpha = 0.12f),
                modifier = Modifier.size(40.dp),
            ) {
                Box(contentAlignment = Alignment.Center) { Text("✓", color = uc, fontWeight = FontWeight.Bold) }
            }
            StatusBadge(line.ingredientUnit.uppercase(), uc)
            Surface(
                onClick = onRemove,
                shape = RoundedCornerShape(Radius.sm),
                color = Color.Transparent,
                modifier = Modifier.size(40.dp),
            ) {
                Box(contentAlignment = Alignment.Center) { Text("✕", color = Danger) }
            }
        }
    }
}

@Composable
private fun RcAddIngredient(
    ingredients: List<RcIngredient>,
    usedIds: Set<Int>,
    toast: PosToastState,
    onAdd: (Int, Double) -> Unit,
) {
    var query by remember { mutableStateOf("") }
    var selectedIng by remember { mutableStateOf<RcIngredient?>(null) }
    var qty by remember { mutableStateOf("") }
    var expanded by remember { mutableStateOf(false) }

    // Diacritic-insensitive filter, exclude already-used, top 25.
    val matches by remember(query, ingredients, usedIds) {
        derivedStateOf {
            val q = foldDia(query.trim())
            ingredients.asSequence()
                .filter { it.id !in usedIds }
                .filter { q.isEmpty() || foldDia(it.name).contains(q) }
                .take(25)
                .toList()
        }
    }

    Surface(
        shape = RoundedCornerShape(Radius.md),
        color = CreamSunken.copy(alpha = 0.5f),
        border = BorderStroke(1.dp, BorderSoft),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(14.dp)) {
            Text("Pridať surovinu", style = MaterialTheme.typography.labelMedium, color = EspressoSoft)
            Spacer(Modifier.height(6.dp))
            Box {
                OutlinedTextField(
                    value = query,
                    onValueChange = {
                        query = it
                        selectedIng = null   // reset výber kým operátor píše
                        expanded = true
                    },
                    placeholder = { Text("Píš názov suroviny… (napr. cibu, kač, hov)") },
                    singleLine = true,
                    trailingIcon = {
                        TextButton(onClick = { expanded = !expanded }) { Text(if (expanded) "▲" else "▼") }
                    },
                    modifier = Modifier.fillMaxWidth(),
                )
                DropdownMenu(
                    expanded = expanded && matches.isNotEmpty(),
                    onDismissRequest = { expanded = false },
                    modifier = Modifier.heightIn(max = 280.dp),
                ) {
                    matches.forEach { ing ->
                        DropdownMenuItem(
                            text = {
                                Row {
                                    Text(ing.name, fontWeight = FontWeight.SemiBold)
                                    Text(" (${ing.unit})", color = EspressoDim, style = MaterialTheme.typography.bodySmall)
                                }
                            },
                            onClick = {
                                selectedIng = ing
                                query = "${ing.name} (${ing.unit})"
                                expanded = false
                            },
                        )
                    }
                }
            }
            Spacer(Modifier.height(10.dp))
            Row(
                verticalAlignment = Alignment.Bottom,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                FormField(
                    "Množstvo na 1ks", qty, { qty = it },
                    placeholder = "0,000",
                    keyboard = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                    suffix = selectedIng?.unit,
                    modifier = Modifier.weight(1f),
                )
                Button(
                    onClick = {
                        val ing = selectedIng
                        val v = qty.replace(',', '.').toDoubleOrNull()
                        when {
                            ing == null -> toast.show("Vyberte surovinu")
                            v == null || v <= 0.0 -> toast.show("Zadajte platné množstvo")
                            else -> {
                                onAdd(ing.id, v)
                                query = ""; selectedIng = null; qty = ""
                            }
                        }
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = Sage, contentColor = Cream),
                    modifier = Modifier.heightIn(min = 56.dp),
                ) { Text("+ Pridať surovinu") }
            }
        }
    }
}

/* ---------- helpers ---------- */

/** Číslo → editovateľný reťazec bez zbytočných núl, sk-SK čiarka pre zobrazenie
 *  necháva bodku v input fielde (parsovanie zvláda obe). */
private fun rcNumStr(v: Double): String {
    if (v == 0.0) return "0"
    val s = if (v == v.toLong().toDouble()) v.toLong().toString()
    else java.math.BigDecimal(v).stripTrailingZeros().toPlainString()
    return s
}

private data class RcLoaded(
    val items: List<RcMenuItem>,
    val summary: List<RcSummary>,
    val sales: List<RcSales>,
    val ingredients: List<RcIngredient>,
)
