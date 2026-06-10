package sk.surfspirit.pos.ui.admin.pages

import android.graphics.BitmapFactory
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
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
import sk.surfspirit.pos.core.errorMessage
import sk.surfspirit.pos.core.fmtCost
import sk.surfspirit.pos.core.isManager
import sk.surfspirit.pos.net.Api
import sk.surfspirit.pos.ui.admin.*
import sk.surfspirit.pos.ui.theme.*

/* =====================================================================
   Správa menu — natívna parita s admin/pages/menu.js.
   Dvoj-panel master/detail: kategórie (vľavo) + položky (vpravo).
   Prefix DTO/API: "Mn".
   POZN.: drag-reorder kategórií/položiek je vo webe LOKÁLNY (žiadny
   reorder endpoint) → tu sa nerobí; poradie drží server (sortKey).
   ===================================================================== */

/* ---------- DTOs (zhoda s /api/menu shape) ---------- */

@Serializable
private data class MnItemDto(
    val id: Int,
    val categoryId: Int = 0,
    val name: String = "",
    val emoji: String = "",
    val price: Double = 0.0,          // /menu vracia price ako NUMBER (normalizované)
    val desc: String = "",
    val active: Boolean = true,
    val available: Boolean = true,
    val vatRate: Double = 23.0,       // /menu vracia number
    val companionMenuItemId: Int? = null,
    val imageUrl: String? = null,
    val destOverride: String? = null, // "bar" | "kuchyna" | null
)

@Serializable
private data class MnCategoryDto(
    val id: Int,
    val slug: String = "",
    val label: String = "",
    val icon: String = "",
    val sortKey: String = "",
    val dest: String = "bar",         // "bar" | "kuchyna" | "all"
    val items: List<MnItemDto> = emptyList(),
)

@Serializable
private data class MnCategoryReq(
    val slug: String? = null,
    val label: String? = null,
    val icon: String? = null,
    val sortKey: String? = null,
    val dest: String? = null,
)

@Serializable
private data class MnItemReq(
    val categoryId: Int? = null,
    val name: String? = null,
    val emoji: String? = null,
    val price: Double? = null,
    val desc: String? = null,
    val available: Boolean? = null,
    val vatRate: Double? = null,
    val companionMenuItemId: Int? = null,
    val destOverride: String? = null,
)

@Serializable
private data class MnAvailReq(val available: Boolean)

@Serializable
private data class MnImageReq(val image: String)

private interface MnApi {
    @GET("api/menu") suspend fun menu(): List<MnCategoryDto>

    @POST("api/menu/categories") suspend fun createCategory(@Body body: MnCategoryReq): MnCategoryDto
    @PUT("api/menu/categories/{id}") suspend fun updateCategory(@Path("id") id: Int, @Body body: MnCategoryReq): MnCategoryDto
    @DELETE("api/menu/categories/{id}") suspend fun deleteCategory(@Path("id") id: Int): JsonElement

    @POST("api/menu/items") suspend fun createItem(@Body body: MnItemReq): MnItemDto
    @PUT("api/menu/items/{id}") suspend fun updateItem(@Path("id") id: Int, @Body body: MnItemReq): MnItemDto
    @PUT("api/menu/items/{id}") suspend fun toggleItem(@Path("id") id: Int, @Body body: MnAvailReq): MnItemDto
    @DELETE("api/menu/items/{id}") suspend fun deleteItem(@Path("id") id: Int): JsonElement

    @POST("api/menu/items/{id}/image") suspend fun uploadImage(@Path("id") id: Int, @Body body: MnImageReq): MnItemDto
    @DELETE("api/menu/items/{id}/image") suspend fun deleteImage(@Path("id") id: Int): JsonElement
}

private val mnApi: MnApi by lazy { Api.create(MnApi::class.java) }

/* ---------- VAT helpers (zrkadlo servera + js menu.js) ---------- */

private val MN_SUPPORTED_VAT = setOf(5, 19, 23)
private val MN_CATEGORY_VAT_DEFAULTS = mapOf(
    "kava" to 19, "caj" to 19, "koktaily" to 23, "pivo" to 23, "vino" to 23, "jedlo" to 5,
)

private fun mnInferVat(slug: String, name: String): Int {
    val s = slug.trim().lowercase()
    val n = name.trim().lowercase()
    if (s == "pivo" && Regex("nealko|nealkohol|0[,.]0|alkohol\\s*free").containsMatchIn(n)) return 19
    return MN_CATEGORY_VAT_DEFAULTS[s] ?: 23
}

/** Celé číslo bez desatín, inak orezané desatiny (web formatVatRate). */
private fun mnFmtVat(v: Double): String =
    if (v == v.toLong().toDouble()) v.toLong().toString()
    else v.toString().trimEnd('0').trimEnd('.')

private fun mnFmtPrice(v: Double): String = fmtCost(v) + " €"

/** Cena input filter — len číslice + maximálne JEDEN desatinný oddeľovač
 *  (druhá čiarka/bodka sa zahodí; „1,5,0" by sa inak parsla na null → 0). */
private fun mnCleanPrice(input: String): String {
    val s = input.replace(',', '.').filter { it.isDigit() || it == '.' }
    val i = s.indexOf('.')
    val single = if (i >= 0) s.substring(0, i + 1) + s.substring(i + 1).replace(".", "") else s
    return single.replace('.', ',')
}

/* ---------- Emoji palety (zhoda s menu.js) ---------- */

private val MN_CATEGORY_EMOJIS = listOf(
    "☕", "🍵", "🍹", "🍺", "🍷", "🥂", "🍾",
    "🥃", "🥛", "🧃", "🍼", "🍶", "🥤", "🥚",
    "🍔", "🍕", "🌮", "🌯", "🥪", "🌭", "🍗",
    "🍟", "🥗", "🧀", "🥩", "🍳", "🥘", "🍲",
    "🍛", "🍙", "🍱", "🍜", "🍝", "🍚", "🍡",
    "🍰", "🍮", "🍭", "🍪", "🍫", "🍦", "🍨", "🍧",
    "🍎", "🍊", "🍋", "🍉", "🍇", "🍓", "🍒",
    "🥫", "🍽", "🧁", "🧂", "🍸",
)

private data class MnEmoji(val e: String, val k: String)

private val MN_PRODUCT_EMOJIS = listOf(
    MnEmoji("☕", "kava espresso coffee hot"),
    MnEmoji("🍵", "caj tea"),
    MnEmoji("🧉", "mate yerba"),
    MnEmoji("🥤", "kokktail smoothie"),
    MnEmoji("🍹", "koktail koktejl cocktail tropical"),
    MnEmoji("🍸", "koktail martini cocktail"),
    MnEmoji("🥃", "whisky tumbler rum bourbon alkohol"),
    MnEmoji("🍾", "sekt champagne prosecco sampan"),
    MnEmoji("🍷", "vino cervene vino wine"),
    MnEmoji("🥂", "vino biele sparkling wine"),
    MnEmoji("🍺", "pivo beer"),
    MnEmoji("🍻", "pivo cheers tost"),
    MnEmoji("🥫", "radler pivo mix"),
    MnEmoji("🥛", "mlieko milk"),
    MnEmoji("🧃", "dzus juice pomaranc orange"),
    MnEmoji("🍶", "sake liquor"),
    MnEmoji("🍔", "burger hamburger"),
    MnEmoji("🍕", "pizza"),
    MnEmoji("🌭", "hotdog parky"),
    MnEmoji("🌮", "taco"),
    MnEmoji("🌯", "burrito quesadilla tortilla"),
    MnEmoji("🥪", "sendvic sandwich bageta"),
    MnEmoji("🧇", "waffle"),
    MnEmoji("🍗", "kurca chicken"),
    MnEmoji("🍖", "maso meat"),
    MnEmoji("🍟", "hranolky fries potato"),
    MnEmoji("🥗", "salat salad zdrave"),
    MnEmoji("🧀", "syr cheese"),
    MnEmoji("🥩", "steak"),
    MnEmoji("🥘", "polievka soup"),
    MnEmoji("🍲", "polievka pot hot"),
    MnEmoji("🍳", "vajce egg fried"),
    MnEmoji("🥚", "vajce egg chocolate"),
    MnEmoji("🍛", "ryza rice bowl"),
    MnEmoji("🍜", "polievka ramen noodles"),
    MnEmoji("🍝", "spaghetti cestoviny pasta"),
    MnEmoji("🍚", "ryza rice"),
    MnEmoji("🍙", "sushi rice"),
    MnEmoji("🍱", "bento"),
    MnEmoji("🍡", "onigiri rice ball"),
    MnEmoji("🍰", "dort tortu cake strawberry"),
    MnEmoji("🎂", "torta narodeniny birthday"),
    MnEmoji("🍮", "flan pudding creme brulee"),
    MnEmoji("🍭", "cukor candy lollipop"),
    MnEmoji("🍪", "cookie susienka"),
    MnEmoji("🍩", "donut"),
    MnEmoji("🍫", "cokolada chocolate"),
    MnEmoji("🍦", "zmrzlina ice cream vanilla"),
    MnEmoji("🍨", "zmrzlina ice cream cup"),
    MnEmoji("🍧", "shaved ice"),
    MnEmoji("🥧", "pie kolac"),
    MnEmoji("🍎", "jablko apple ovocie fruit"),
    MnEmoji("🍊", "pomaranc orange citrus"),
    MnEmoji("🍋", "citron lemon citrus"),
    MnEmoji("🍉", "melon watermelon"),
    MnEmoji("🍇", "hrozno grapes"),
    MnEmoji("🍓", "jahoda strawberry"),
    MnEmoji("🍒", "cheresne cherry"),
    MnEmoji("🍌", "banan banana"),
    MnEmoji("🥭", "mango"),
    MnEmoji("🍍", "ananas pineapple"),
    MnEmoji("🥝", "kivi kiwi"),
    MnEmoji("🥥", "kokos coconut"),
    MnEmoji("🥐", "chlieb croissant"),
    MnEmoji("🍞", "chlieb bread baguette"),
    MnEmoji("🥖", "bageta baguette"),
    MnEmoji("🥨", "precle pretzel"),
    MnEmoji("🧈", "maslo butter"),
    MnEmoji("🧂", "sol salt pepper korenie"),
    MnEmoji("🌶", "paprika chili korenie spicy"),
    MnEmoji("🧄", "cesnak garlic"),
    MnEmoji("🧅", "cibula onion"),
    MnEmoji("🍅", "paradajky tomato bruschetta"),
    MnEmoji("🍆", "baklazan eggplant"),
    MnEmoji("🥬", "salat lettuce"),
    MnEmoji("🍼", "pitie baby milk"),
    MnEmoji("🧋", "bubble tea"),
    MnEmoji("🍽", "tanier plate"),
    MnEmoji("🧁", "cupcake muffin"),
    MnEmoji("📦", "balik box supply tovar"),
)

private const val MN_DEFAULT_EMOJI = "🍽"  // 🍽

/* ===================================================================== */

@Composable
fun MenuAdminScreen() {
    val toast = rememberAdminToast()
    val scope = rememberCoroutineScope()
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }

    var menu by remember { mutableStateOf<List<MnCategoryDto>>(emptyList()) }
    var activeCatId by remember { mutableStateOf<Int?>(null) }
    var query by remember { mutableStateOf("") }

    // Dialóg stavy
    var catDialog by remember { mutableStateOf<MnCategoryDto?>(null) } // edit
    var catDialogOpen by remember { mutableStateOf(false) }            // add/edit flag
    var catDialogMode by remember { mutableStateOf("add") }
    var prodDialogOpen by remember { mutableStateOf(false) }
    var prodEditing by remember { mutableStateOf<MnItemDto?>(null) }
    var confirmCatDelete by remember { mutableStateOf<MnCategoryDto?>(null) }
    var confirmProdDelete by remember { mutableStateOf<MnItemDto?>(null) }

    fun load() {
        scope.launch {
            try {
                val data = withContext(Dispatchers.IO) { mnApi.menu() }
                menu = data
                if (data.isNotEmpty() && (activeCatId == null || data.none { it.id == activeCatId })) {
                    activeCatId = data.first().id
                }
                error = null
            } catch (e: Exception) {
                error = errorMessage(e)
            } finally {
                loading = false
            }
        }
    }
    LaunchedEffect(Unit) { load() }

    val activeCat = menu.firstOrNull { it.id == activeCatId }

    // Vyhľadávanie: filtruje položky aktívnej kategórie; ak je dopyt prázdny → všetky.
    val filteredItems = remember(activeCat, query) {
        val q = query.trim().lowercase()
        val all = activeCat?.items ?: emptyList()
        if (q.isBlank()) all
        else all.filter { it.name.lowercase().contains(q) || it.desc.lowercase().contains(q) }
    }

    // ---- akcie ----
    fun toggleAvail(item: MnItemDto) {
        scope.launch {
            val next = !(item.available)
            try {
                withContext(Dispatchers.IO) { mnApi.toggleItem(item.id, MnAvailReq(next)) }
                // update in place
                menu = menu.map { c ->
                    c.copy(items = c.items.map { if (it.id == item.id) it.copy(available = next, active = next) else it })
                }
            } catch (e: Exception) {
                toast.show("Chyba: ${errorMessage(e)}", error = true)
            }
        }
    }

    fun deleteCategory(cat: MnCategoryDto) {
        if (cat.items.isNotEmpty()) {
            toast.show(
                "Kategória „${cat.label}“ obsahuje ${cat.items.size} produktov. Najprv ich zmaž alebo presuň.",
                error = true,
            )
            activeCatId = cat.id
            return
        }
        confirmCatDelete = cat
    }

    AdminScreenBox(toast, scrollable = false) {
        AdminSectionTitle("Menu")
        when {
            loading -> LoadingBox()
            error != null -> ErrorBox(error!!) { loading = true; load() }
            else -> {
                Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    // ---------- ĽAVÝ PANEL — kategórie ----------
                    Column(Modifier.weight(0.36f).fillMaxHeight()) {
                        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(bottom = 8.dp)) {
                            Text(
                                "Kategórie",
                                style = MaterialTheme.typography.titleSmall,
                                modifier = Modifier.weight(1f),
                            )
                            Text(
                                "${menu.size}",
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        if (menu.isEmpty()) {
                            MnEmptyState(
                                icon = "📂",
                                title = "Žiadne kategórie",
                                text = "Vytvorte prvú kategóriu",
                                cta = if (isManager) "Pridať kategóriu" else null,
                                onCta = { catDialogMode = "add"; catDialog = null; catDialogOpen = true },
                            )
                        } else {
                            LazyColumn(
                                Modifier.weight(1f),
                                verticalArrangement = Arrangement.spacedBy(6.dp),
                            ) {
                                items(menu, key = { it.id }) { cat ->
                                    MnCategoryCard(
                                        cat = cat,
                                        active = cat.id == activeCatId,
                                        onSelect = { activeCatId = cat.id },
                                        onEdit = { catDialogMode = "edit"; catDialog = cat; catDialogOpen = true },
                                        onDelete = { deleteCategory(cat) },
                                    )
                                }
                            }
                        }
                        if (isManager) {
                            Spacer(Modifier.height(8.dp))
                            OutlinedButton(
                                onClick = { catDialogMode = "add"; catDialog = null; catDialogOpen = true },
                                modifier = Modifier.fillMaxWidth().heightIn(min = 44.dp),
                            ) { Text("+ Pridať kategóriu") }
                        }
                    }

                    // ---------- PRAVÝ PANEL — položky ----------
                    Column(Modifier.weight(0.64f).fillMaxHeight()) {
                        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(bottom = 8.dp)) {
                            Text(
                                activeCat?.let { "${it.icon} ${it.label}" } ?: "Položky",
                                style = MaterialTheme.typography.titleSmall,
                                modifier = Modifier.weight(1f),
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            if (isManager && activeCat != null) {
                                Button(
                                    onClick = { prodEditing = null; prodDialogOpen = true },
                                    contentPadding = PaddingValues(horizontal = 14.dp, vertical = 8.dp),
                                ) {
                                    Icon(Icons.Filled.Add, null, Modifier.size(18.dp))
                                    Spacer(Modifier.width(6.dp))
                                    Text("Pridať")
                                }
                            }
                        }
                        // Vyhľadávanie
                        if (activeCat != null && activeCat.items.isNotEmpty()) {
                            OutlinedTextField(
                                value = query,
                                onValueChange = { query = it },
                                placeholder = { Text("Hľadať produkt…") },
                                leadingIcon = { Icon(Icons.Filled.Search, null, tint = MaterialTheme.colorScheme.outline) },
                                singleLine = true,
                                shape = RoundedCornerShape(999.dp),
                                colors = OutlinedTextFieldDefaults.colors(
                                    focusedContainerColor = Cream,
                                    unfocusedContainerColor = Cream,
                                    focusedBorderColor = Terra,
                                    unfocusedBorderColor = BorderMid,
                                ),
                                modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp),
                            )
                        }

                        when {
                            activeCat == null -> EmptyHint("Vyberte kategóriu")
                            activeCat.items.isEmpty() -> MnEmptyState(
                                icon = "📦",
                                title = "Žiadne produkty",
                                text = "Pridajte prvý produkt",
                                cta = if (isManager) "Pridať produkt" else null,
                                onCta = { prodEditing = null; prodDialogOpen = true },
                            )
                            filteredItems.isEmpty() -> EmptyHint("Nič sa nenašlo")
                            else -> LazyColumn(
                                Modifier.weight(1f),
                                verticalArrangement = Arrangement.spacedBy(6.dp),
                            ) {
                                items(filteredItems, key = { it.id }) { item ->
                                    MnProductRow(
                                        item = item,
                                        manager = isManager,
                                        onToggle = { toggleAvail(item) },
                                        onEdit = { prodEditing = item; prodDialogOpen = true },
                                        onDelete = { confirmProdDelete = item },
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // ---------- Kategória dialóg ----------
    if (catDialogOpen) {
        MnCategoryDialog(
            mode = catDialogMode,
            initial = catDialog,
            onDismiss = { catDialogOpen = false },
            onSave = { label, icon, dest ->
                scope.launch {
                    try {
                        withContext(Dispatchers.IO) {
                            if (catDialogMode == "edit" && catDialog != null) {
                                mnApi.updateCategory(catDialog!!.id, MnCategoryReq(label = label, icon = icon, dest = dest))
                            } else {
                                val created = mnApi.createCategory(
                                    MnCategoryReq(
                                        slug = "cat_" + System.currentTimeMillis(),
                                        label = label, icon = icon,
                                        sortKey = menu.size.toString(), dest = dest,
                                    ),
                                )
                                activeCatId = created.id
                            }
                        }
                        toast.show(if (catDialogMode == "edit") "Kategória upravená" else "Kategória pridaná")
                        catDialogOpen = false
                        load()
                    } catch (e: Exception) {
                        toast.show(errorMessage(e), error = true)
                    }
                }
            },
        )
    }

    // ---------- Produkt dialóg ----------
    if (prodDialogOpen && activeCat != null) {
        MnProductDialog(
            editing = prodEditing,
            activeCat = activeCat,
            categories = menu,
            onDismiss = { prodDialogOpen = false },
            onSave = { req, pendingImage, clearImage ->
                scope.launch {
                    try {
                        withContext(Dispatchers.IO) {
                            val saved = if (prodEditing != null) {
                                mnApi.updateItem(prodEditing!!.id, req)
                            } else {
                                mnApi.createItem(req)
                            }
                            // Foto: rieš až keď riadok existuje
                            if (clearImage && pendingImage == null) {
                                try { mnApi.deleteImage(saved.id) }
                                catch (e: Exception) { throw ImageOpException("Fotku sa nepodarilo zmazať: ${errorMessage(e)}") }
                            }
                            if (pendingImage != null) {
                                try { mnApi.uploadImage(saved.id, MnImageReq(pendingImage)) }
                                catch (e: Exception) { throw ImageOpException("Fotku sa nepodarilo nahrať: ${errorMessage(e)}") }
                            }
                        }
                        toast.show(if (prodEditing != null) "Produkt upravený" else "Produkt pridaný")
                        prodDialogOpen = false
                        activeCatId = req.categoryId ?: activeCatId
                        load()
                    } catch (e: ImageOpException) {
                        // Položka sa uložila, foto zlyhalo — zatvor a refreshni, ukáž foto chybu
                        toast.show(e.message ?: "Chyba fotky", error = true)
                        prodDialogOpen = false
                        activeCatId = req.categoryId ?: activeCatId
                        load()
                    } catch (e: Exception) {
                        toast.show(errorMessage(e), error = true)
                    }
                }
            },
        )
    }

    // ---------- Potvrdenia mazania ----------
    confirmCatDelete?.let { cat ->
        AdminConfirm(
            title = "Zmazať kategóriu?",
            text = "Kategória „${cat.label}“ bude zmazaná.",
            confirmLabel = "Zmazať",
            danger = true,
            onConfirm = {
                confirmCatDelete = null
                scope.launch {
                    try {
                        withContext(Dispatchers.IO) { mnApi.deleteCategory(cat.id) }
                        toast.show("Kategória „${cat.label}“ zmazaná")
                        if (activeCatId == cat.id) activeCatId = null
                        load()
                    } catch (e: Exception) {
                        toast.show(errorMessage(e), error = true)
                    }
                }
            },
            onDismiss = { confirmCatDelete = null },
        )
    }
    confirmProdDelete?.let { item ->
        AdminConfirm(
            title = "Odstrániť produkt?",
            text = "„${item.name}“ bude odstránené z menu.",
            confirmLabel = "Odstrániť",
            danger = true,
            onConfirm = {
                confirmProdDelete = null
                scope.launch {
                    try {
                        withContext(Dispatchers.IO) { mnApi.deleteItem(item.id) }
                        toast.show("„${item.name}“ odstránené")
                        load()
                    } catch (e: Exception) {
                        toast.show(errorMessage(e), error = true)
                    }
                }
            },
            onDismiss = { confirmProdDelete = null },
        )
    }
}

private class ImageOpException(message: String) : Exception(message)

/** Validačná chyba výberu fotky (veľkosť/typ) — nesie slovenskú hlášku. */
private class MnImageError(message: String) : Exception(message)

/** Bitmap downscale na max [maxDim] px (dlhšia strana), inak vráti original. */
private fun mnScaleDown(src: android.graphics.Bitmap, maxDim: Int): android.graphics.Bitmap {
    val d = maxOf(src.width, src.height)
    if (d <= maxDim) return src
    val scale = maxDim.toFloat() / d
    return android.graphics.Bitmap.createScaledBitmap(
        src,
        (src.width * scale).toInt().coerceAtLeast(1),
        (src.height * scale).toInt().coerceAtLeast(1),
        true,
    )
}

/* ---------- Kategória karta ---------- */

@Composable
private fun MnCategoryCard(
    cat: MnCategoryDto,
    active: Boolean,
    onSelect: () -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    Surface(
        onClick = onSelect,
        shape = RoundedCornerShape(12.dp),
        color = if (active) Terra.copy(alpha = 0.12f) else MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, if (active) Terra else BorderSoft),
    ) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(cat.icon, fontSize = 22.sp)
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    cat.label,
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                Text(
                    "${cat.items.size} položiek",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (isManager) {
                IconButton(onClick = onEdit, modifier = Modifier.size(36.dp)) {
                    Icon(Icons.Filled.Edit, "Upraviť", Modifier.size(18.dp), tint = EspressoSoft)
                }
                IconButton(onClick = onDelete, modifier = Modifier.size(36.dp)) {
                    Icon(Icons.Filled.Delete, "Zmazať", Modifier.size(18.dp), tint = Danger)
                }
            }
        }
    }
}

/* ---------- Produkt riadok ---------- */

@Composable
private fun MnProductRow(
    item: MnItemDto,
    manager: Boolean,
    onToggle: () -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    Surface(
        shape = RoundedCornerShape(12.dp),
        color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, BorderSoft),
    ) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(item.emoji.ifBlank { MN_DEFAULT_EMOJI }, fontSize = 24.sp)
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    item.name,
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                if (item.desc.isNotBlank()) {
                    Text(
                        item.desc,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        "DPH ${mnFmtVat(item.vatRate)}%",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    item.destOverride?.let {
                        StatusBadge(if (it == "kuchyna") "🍳 Kuchyňa" else "🍹 Bar", Navy)
                    }
                }
            }
            Text(
                mnFmtPrice(item.price),
                style = MaterialTheme.typography.titleSmall,
                color = Terra,
                modifier = Modifier.padding(horizontal = 10.dp),
            )
            // Toggle dostupnosti
            Switch(
                checked = item.available,
                onCheckedChange = if (manager) ({ onToggle() }) else null,
                enabled = manager,
                colors = SwitchDefaults.colors(checkedThumbColor = Cream, checkedTrackColor = Sage),
            )
            if (manager) {
                IconButton(onClick = onEdit, modifier = Modifier.size(36.dp)) {
                    Icon(Icons.Filled.Edit, "Upraviť", Modifier.size(18.dp), tint = EspressoSoft)
                }
                IconButton(onClick = onDelete, modifier = Modifier.size(36.dp)) {
                    Icon(Icons.Filled.Delete, "Odstrániť", Modifier.size(18.dp), tint = Danger)
                }
            }
        }
    }
}

/* ---------- Empty state ---------- */

@Composable
private fun MnEmptyState(icon: String, title: String, text: String, cta: String?, onCta: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(icon, fontSize = 40.sp)
        Spacer(Modifier.height(8.dp))
        Text(title, style = MaterialTheme.typography.titleSmall)
        Spacer(Modifier.height(4.dp))
        Text(
            text,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (cta != null) {
            Spacer(Modifier.height(12.dp))
            OutlinedButton(onClick = onCta) { Text(cta) }
        }
    }
}

/* ---------- Emoji picker grid ---------- */

@Composable
private fun MnEmojiGrid(
    cols: Int,
    emojis: List<String>,
    selected: String,
    onPick: (String) -> Unit,
) {
    Surface(
        shape = RoundedCornerShape(14.dp),
        color = MaterialTheme.colorScheme.surfaceVariant,
        border = BorderStroke(1.dp, BorderSoft),
    ) {
        Column(Modifier.padding(8.dp).heightIn(max = 200.dp).verticalScroll(rememberScrollState())) {
            emojis.chunked(cols).forEach { row ->
                Row(Modifier.fillMaxWidth()) {
                    row.forEach { e ->
                        val isSel = e == selected
                        Box(
                            Modifier.weight(1f).aspectRatio(1f)
                                .padding(2.dp)
                                .clip(RoundedCornerShape(8.dp))
                                .background(if (isSel) Terra.copy(alpha = 0.18f) else androidx.compose.ui.graphics.Color.Transparent)
                                .border(
                                    BorderStroke(1.dp, if (isSel) Terra else androidx.compose.ui.graphics.Color.Transparent),
                                    RoundedCornerShape(8.dp),
                                )
                                .clickable { onPick(e) },
                            contentAlignment = Alignment.Center,
                        ) { Text(e, fontSize = 20.sp) }
                    }
                    // dorovnaj poslednú nekompletnú radu
                    repeat(cols - row.size) { Spacer(Modifier.weight(1f)) }
                }
            }
        }
    }
}

/* ---------- Kategória dialóg ---------- */

@Composable
private fun MnCategoryDialog(
    mode: String,
    initial: MnCategoryDto?,
    onDismiss: () -> Unit,
    onSave: (label: String, icon: String, dest: String) -> Unit,
) {
    var label by remember { mutableStateOf(initial?.label ?: "") }
    var icon by remember { mutableStateOf(initial?.icon?.ifBlank { MN_DEFAULT_EMOJI } ?: MN_DEFAULT_EMOJI) }
    var dest by remember { mutableStateOf(initial?.dest ?: "bar") }
    var formError by remember { mutableStateOf<String?>(null) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (mode == "edit") "Upraviť kategóriu" else "Nová kategória") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                FormField("Názov *", label, { label = it }, placeholder = "napr. Dezerty")
                Column {
                    Text(
                        "Emoji ikona",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(4.dp))
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Surface(
                            shape = RoundedCornerShape(8.dp),
                            color = MaterialTheme.colorScheme.surfaceVariant,
                            border = BorderStroke(1.dp, BorderSoft),
                        ) {
                            Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) {
                                Text(icon.ifBlank { MN_DEFAULT_EMOJI }, fontSize = 28.sp)
                            }
                        }
                        OutlinedTextField(
                            value = icon,
                            onValueChange = { if (it.length <= 4) icon = it },
                            singleLine = true,
                            modifier = Modifier.width(120.dp),
                        )
                    }
                    Spacer(Modifier.height(8.dp))
                    MnEmojiGrid(8, MN_CATEGORY_EMOJIS, icon) { icon = it }
                }
                Column {
                    Text(
                        "Kam sa tlačia položky",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(4.dp))
                    MnSegmented(
                        options = listOf("bar" to "Bar", "kuchyna" to "Kuchyňa", "all" to "Všetko"),
                        selected = dest,
                        onSelect = { dest = it },
                    )
                }
                // Inline validačná chyba — Uložiť nesmie „nič nerobiť" potichu.
                formError?.let {
                    Text(it, color = Danger, style = MaterialTheme.typography.bodySmall)
                }
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    val l = label.trim()
                    if (l.isBlank()) { formError = "Zadaj názov"; return@Button }
                    formError = null
                    onSave(l, icon.trim().ifBlank { MN_DEFAULT_EMOJI }, dest)
                },
                colors = ButtonDefaults.buttonColors(containerColor = Terra, contentColor = Cream),
            ) { Text(if (mode == "edit") "Uložiť" else "Pridať") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Zrušiť") } },
    )
}

/* ---------- Produkt dialóg ---------- */

@Composable
private fun MnProductDialog(
    editing: MnItemDto?,
    activeCat: MnCategoryDto,
    categories: List<MnCategoryDto>,
    onDismiss: () -> Unit,
    onSave: (req: MnItemReq, pendingImage: String?, clearImage: Boolean) -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var emoji by remember { mutableStateOf(editing?.emoji ?: "") }
    var name by remember { mutableStateOf(editing?.name ?: "") }
    var desc by remember { mutableStateOf(editing?.desc ?: "") }
    var priceText by remember { mutableStateOf(if (editing != null) editing.price.toString().replace('.', ',') else "") }
    var catId by remember { mutableStateOf(editing?.categoryId ?: activeCat.id) }
    var vatRate by remember { mutableStateOf(if (editing != null) editing.vatRate.toInt() else mnInferVat(activeCat.slug, "")) }
    var vatTouched by remember { mutableStateOf(editing != null) }
    var destOverride by remember { mutableStateOf(editing?.destOverride ?: "") }
    var companionId by remember { mutableStateOf(editing?.companionMenuItemId) }
    var available by remember { mutableStateOf(editing?.available ?: true) }
    var showEmojiGrid by remember { mutableStateOf(false) }
    var emojiSearch by remember { mutableStateOf("") }
    var formError by remember { mutableStateOf<String?>(null) }

    // Foto stav
    var pendingImage by remember { mutableStateOf<String?>(null) }
    var clearImage by remember { mutableStateOf(false) }
    val currentImage = editing?.imageUrl
    var pendingBitmap by remember { mutableStateOf<androidx.compose.ui.graphics.ImageBitmap?>(null) }
    var imageError by remember { mutableStateOf<String?>(null) }

    val pickImage = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        // Čítanie + dekódovanie + re-kompresia na Dispatchers.IO — full-res
        // decode 4 MB fotky je ~48 MB bitmap a base64-in-JSON upload zbytočne
        // ťahá megabajty; menu thumbnail nikdy nepotrebuje viac ako ~1280 px.
        scope.launch {
            try {
                val result = withContext(Dispatchers.IO) {
                    val bytes = context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
                        ?: throw MnImageError("Fotku sa nepodarilo načítať")
                    if (bytes.size > 4 * 1024 * 1024) throw MnImageError("Fotka je príliš veľká (max 4 MB)")
                    val mime = context.contentResolver.getType(uri) ?: "image/jpeg"
                    val ok = mime == "image/jpeg" || mime == "image/jpg" || mime == "image/png" || mime == "image/webp"
                    if (!ok) throw MnImageError("Podporované: JPEG, PNG, WebP")
                    // inSampleSize decode — cieľ max ~1280 px (mocniny 2)
                    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                    var sample = 1
                    while (bounds.outWidth / (sample * 2) >= 1280 || bounds.outHeight / (sample * 2) >= 1280) sample *= 2
                    val opts = BitmapFactory.Options().apply { inSampleSize = sample }
                    val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
                        ?: throw MnImageError("Fotku sa nepodarilo načítať")
                    // Dorovnaj presne pod 1280 px a re-komprimuj JPEG q80.
                    val upload = mnScaleDown(decoded, 1280)
                    val out = java.io.ByteArrayOutputStream()
                    upload.compress(android.graphics.Bitmap.CompressFormat.JPEG, 80, out)
                    val b64 = android.util.Base64.encodeToString(out.toByteArray(), android.util.Base64.NO_WRAP)
                    // Mini preview ~320 px pre 80 dp box (nedrž veľký bitmap v state)
                    val preview = mnScaleDown(upload, 320)
                    "data:image/jpeg;base64,$b64" to preview
                }
                pendingImage = result.first
                pendingBitmap = result.second.asImageBitmap()
                clearImage = false
                imageError = null
            } catch (e: MnImageError) {
                imageError = e.message
            } catch (e: Exception) {
                imageError = "Fotku sa nepodarilo načítať"
            }
        }
    }

    // VAT auto-suggest (kým user manuálne nezmenil)
    fun maybeSuggestVat() {
        if (vatTouched) return
        val slug = categories.firstOrNull { it.id == catId }?.slug ?: ""
        vatRate = mnInferVat(slug, name)
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (editing != null) "Upraviť produkt" else "Pridať produkt") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                // Emoji + Názov
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Bottom) {
                    Column(Modifier.width(96.dp)) {
                        Text("Emoji", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Spacer(Modifier.height(4.dp))
                        OutlinedTextField(
                            value = emoji,
                            onValueChange = { if (it.length <= 4) emoji = it },
                            singleLine = true,
                            placeholder = { Text("☕") },
                            trailingIcon = {
                                TextButton(onClick = { showEmojiGrid = !showEmojiGrid }) { Text("🙂") }
                            },
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                    Column(Modifier.weight(1f)) {
                        FormField("Názov *", name, { name = it; maybeSuggestVat() }, placeholder = "Názov produktu")
                    }
                }
                if (showEmojiGrid) {
                    OutlinedTextField(
                        value = emojiSearch,
                        onValueChange = { emojiSearch = it },
                        placeholder = { Text("Hľadaj (kava, pivo, jedlo…)") },
                        leadingIcon = { Icon(Icons.Filled.Search, null) },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    val q = emojiSearch.trim().lowercase()
                    val list = if (q.isBlank()) MN_PRODUCT_EMOJIS else MN_PRODUCT_EMOJIS.filter { it.k.contains(q) }
                    MnEmojiGrid(10, list.map { it.e }, emoji) { emoji = it; showEmojiGrid = false }
                }

                FormField("Popis", desc, { desc = it }, placeholder = "Krátky popis")

                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FormField(
                        "Cena (EUR) *", priceText, { priceText = mnCleanPrice(it) },
                        modifier = Modifier.weight(1f),
                        placeholder = "0,00",
                        keyboard = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                        suffix = "€",
                    )
                    Column(Modifier.weight(1f)) {
                        Text("Kategória", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Spacer(Modifier.height(4.dp))
                        MnDropdown(
                            options = categories.map { it.id to "${it.icon} ${it.label}" },
                            selected = catId,
                            onSelect = { catId = it; maybeSuggestVat() },
                        )
                    }
                }

                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Column(Modifier.weight(1f)) {
                        Text("DPH sadzba (%)", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Spacer(Modifier.height(4.dp))
                        MnDropdown(
                            options = listOf(5 to "5 % - jedlo", 19 to "19 % - nealko napoje", 23 to "23 % - alkohol"),
                            selected = vatRate,
                            onSelect = { vatRate = it; vatTouched = true },
                        )
                    }
                    Column(Modifier.weight(1f)) {
                        Text("Tlač do (stanica)", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Spacer(Modifier.height(4.dp))
                        MnDropdown(
                            options = listOf("" to "Default (podľa kategórie)", "kuchyna" to "🍳 Kuchyňa", "bar" to "🍹 Bar"),
                            selected = destOverride,
                            onSelect = { destOverride = it },
                        )
                    }
                }
                Text(
                    "Default = kuchyňa pre jedlo, bar pre nápoje. Override použi keď chceš tlačiť inde.",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                Column {
                    Text("Automaticky priložená položka", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.height(4.dp))
                    val companionOpts = buildList {
                        add(0 to "— žiadna —")
                        categories.forEach { c ->
                            c.items.forEach { it2 ->
                                if (it2.id == editing?.id) return@forEach
                                if (editing != null && it2.companionMenuItemId == editing.id) return@forEach
                                add(it2.id to ((it2.emoji.ifBlank { "" }).let { e -> if (e.isBlank()) it2.name else "$e ${it2.name}" }))
                            }
                        }
                    }
                    MnDropdown(
                        options = companionOpts,
                        selected = companionId ?: 0,
                        onSelect = { companionId = if (it == 0) null else it },
                    )
                    Text(
                        "Napr. „Záloha fľaša\" k flaške Coly.",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                // Foto
                Column {
                    Text("Fotka (max 4 MB; JPEG / PNG / WebP)", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.height(4.dp))
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Surface(
                            shape = RoundedCornerShape(8.dp),
                            color = MaterialTheme.colorScheme.surfaceVariant,
                            border = BorderStroke(1.dp, BorderSoft),
                        ) {
                            Box(Modifier.size(80.dp), contentAlignment = Alignment.Center) {
                                val bmp = pendingBitmap
                                when {
                                    bmp != null -> androidx.compose.foundation.Image(
                                        bitmap = bmp,
                                        contentDescription = null,
                                        modifier = Modifier.fillMaxSize().clip(RoundedCornerShape(8.dp)),
                                        contentScale = androidx.compose.ui.layout.ContentScale.Crop,
                                    )
                                    !clearImage && currentImage != null -> Text("🖼", fontSize = 30.sp)
                                    else -> Text("—", fontSize = 28.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            }
                        }
                        Column {
                            OutlinedButton(onClick = { pickImage.launch("image/*") }) { Text("Vybrať fotku") }
                            val hasPhoto = pendingImage != null || (!clearImage && currentImage != null)
                            if (hasPhoto) {
                                Spacer(Modifier.height(4.dp))
                                TextButton(onClick = {
                                    pendingImage = null; pendingBitmap = null; clearImage = true
                                }) { Text("Zmazať", color = Danger) }
                            }
                            imageError?.let {
                                Text(it, style = MaterialTheme.typography.labelSmall, color = Danger)
                            }
                            Text(
                                "Po výbere fotky stlač Uložiť.",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }

                // Dostupnosť
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Dostupnosť", style = MaterialTheme.typography.labelMedium, modifier = Modifier.weight(1f), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Switch(
                        checked = available,
                        onCheckedChange = { available = it },
                        colors = SwitchDefaults.colors(checkedThumbColor = Cream, checkedTrackColor = Sage),
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(if (available) "Dostupný" else "Nedostupný", style = MaterialTheme.typography.bodyMedium)
                }

                // Inline validačná chyba — Uložiť nesmie „nič nerobiť" potichu.
                formError?.let {
                    Text(it, color = Danger, style = MaterialTheme.typography.bodySmall)
                }
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    val n = name.trim()
                    val price = priceText.replace(',', '.').toDoubleOrNull() ?: 0.0
                    if (n.isBlank()) { formError = "Zadaj názov"; return@Button }
                    if (price <= 0.0) { formError = "Cena musí byť > 0"; return@Button }
                    if (vatRate !in MN_SUPPORTED_VAT) { formError = "Neplatná DPH sadzba (povolené 5, 19, 23 %)"; return@Button }
                    formError = null
                    val dov = if (destOverride == "bar" || destOverride == "kuchyna") destOverride else null
                    val req = MnItemReq(
                        categoryId = catId,
                        name = n,
                        emoji = emoji.trim().ifBlank { MN_DEFAULT_EMOJI },
                        price = price,
                        desc = desc.trim(),
                        available = available,
                        vatRate = vatRate.toDouble(),
                        companionMenuItemId = companionId,
                        destOverride = dov,
                    )
                    onSave(req, pendingImage, clearImage)
                },
                colors = ButtonDefaults.buttonColors(containerColor = Terra, contentColor = Cream),
            ) { Text("Uložiť") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Zrušiť") } },
    )
}

/* ---------- Segmented control (kategória dest) ---------- */

@Composable
private fun MnSegmented(options: List<Pair<String, String>>, selected: String, onSelect: (String) -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        options.forEach { (value, label) ->
            val active = value == selected
            Surface(
                onClick = { onSelect(value) },
                shape = RoundedCornerShape(999.dp),
                color = if (active) Terra else MaterialTheme.colorScheme.surface,
                border = BorderStroke(1.dp, if (active) Terra else BorderSoft),
                modifier = Modifier.weight(1f).heightIn(min = 44.dp),
            ) {
                Box(Modifier.fillMaxWidth().padding(vertical = 10.dp), contentAlignment = Alignment.Center) {
                    Text(
                        label,
                        color = if (active) Cream else MaterialTheme.colorScheme.onSurface,
                        style = MaterialTheme.typography.labelMedium,
                        maxLines = 1,
                    )
                }
            }
        }
    }
}

/* ---------- Dropdown (select) ---------- */

@Composable
private fun <T> MnDropdown(
    options: List<Pair<T, String>>,
    selected: T,
    onSelect: (T) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    val current = options.firstOrNull { it.first == selected }?.second ?: ""
    Box {
        Surface(
            onClick = { expanded = true },
            shape = RoundedCornerShape(12.dp),
            color = MaterialTheme.colorScheme.surface,
            border = BorderStroke(1.dp, BorderMid),
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
        ) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(current, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium)
                Text("▾", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            options.forEach { (value, label) ->
                DropdownMenuItem(
                    text = { Text(label) },
                    onClick = { onSelect(value); expanded = false },
                )
            }
        }
    }
}
