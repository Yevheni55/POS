package sk.surfspirit.pos.ui.admin.pages

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
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
import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.PATCH
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Query
import sk.surfspirit.pos.core.errorMessage
import sk.surfspirit.pos.core.fmtCost
import sk.surfspirit.pos.core.httpCode
import sk.surfspirit.pos.net.Api
import sk.surfspirit.pos.ui.admin.*
import sk.surfspirit.pos.ui.theme.*
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlin.math.roundToInt

/* =====================================================================
   Cashflow — manuálne vklady / výbery / výdavky + auto POS/shisha príjmy.
   Webová parita: admin/pages/cashflow.js + server/routes/cashflow.js.
   ===================================================================== */

/* ---------- DTOs (Cf prefix; numerické DB stĺpce v entries sú STRING) ---------- */

@Serializable private data class CfPeriod(val from: String = "", val to: String = "")

@Serializable private data class CfManual(
    val income: Double = 0.0,
    val expense: Double = 0.0,
    val incomeCount: Int = 0,
    val expenseCount: Int = 0,
)

@Serializable private data class CfCatRow(
    val category: String = "",
    val total: Double = 0.0,
    val count: Int = 0,
)

@Serializable private data class CfByCategory(
    val income: List<CfCatRow> = emptyList(),
    val expense: List<CfCatRow> = emptyList(),
)

// Summary: server Number()-uje agregáty → všetko sú JSON čísla.
@Serializable private data class CfSummaryDto(
    val period: CfPeriod = CfPeriod(),
    val manual: CfManual = CfManual(),
    val posRevenue: Double = 0.0,
    val shishaRevenue: Double = 0.0,
    val totalIncome: Double = 0.0,
    val totalExpense: Double = 0.0,
    val netCashflow: Double = 0.0,
    val byCategory: CfByCategory = CfByCategory(),
)

// POZOR: amount je STRING (Drizzle numeric stĺpec — nekonvertuje sa tu).
@Serializable private data class CfEntryDto(
    val id: Int = 0,
    val type: String = "expense",
    val category: String = "",
    val amount: String = "0",
    val occurredAt: String? = null,
    val method: String = "cash",
    val note: String = "",
    val staffId: Int? = null,
    val supplierId: Int? = null,
    val supplierName: String? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null,
)

@Serializable private data class CfListDto(
    val period: CfPeriod = CfPeriod(),
    val count: Int = 0,
    val entries: List<CfEntryDto> = emptyList(),
)

@Serializable private data class CfSupplierDto(
    val id: Int = 0,
    val name: String = "",
    val active: Boolean = true,
)

// Telo create/update — note bez defaultu (encodeDefaults pošle "" pri create,
// to je v poriadku); supplierId nullable (null = bez väzby / vyčisti väzbu).
@Serializable private data class CfEntryReq(
    val type: String,
    val category: String,
    val amount: Double,
    val occurredAt: String,
    val method: String,
    val note: String = "",
    val supplierId: Int? = null,
)

private interface CfApi {
    @GET("api/cashflow/summary")
    suspend fun summary(@Query("from") from: String, @Query("to") to: String): CfSummaryDto

    @GET("api/cashflow")
    suspend fun list(
        @Query("from") from: String,
        @Query("to") to: String,
        @Query("type") type: String? = null,
    ): CfListDto

    @GET("api/inventory/suppliers")
    suspend fun suppliers(@Query("active") active: String = "true"): List<CfSupplierDto>

    @POST("api/cashflow")
    suspend fun create(@Body body: CfEntryReq): JsonElement

    @PATCH("api/cashflow/{id}")
    suspend fun update(@Path("id") id: Int, @Body body: CfEntryReq): JsonElement

    @DELETE("api/cashflow/{id}")
    suspend fun delete(@Path("id") id: Int): retrofit2.Response<Unit>   // server vracia 204 bez tela
}

private val cfApi: CfApi by lazy { Api.create(CfApi::class.java) }

/* ---------- Kategórie + labely (čisto klientske, web parita) ---------- */

private val CF_INCOME_CATS = listOf(
    "shisha_cash" to "Shisha (hotovosť)",
    "tip" to "Tringelt",
    "deposit" to "Vklad do pokladne",
    "event" to "Akcia / event",
    "sponsorship" to "Sponzorstvo",
    "refund" to "Vrátenie od dodávateľa",
    "other_income" to "Iný príjem",
)
private val CF_EXPENSE_CATS = listOf(
    "withdrawal_uzavierka" to "Výber z pokladne (uzávierka)",
    "rent" to "Nájom",
    "utilities" to "Energie / voda / internet",
    "salary" to "Mzdy / odmeny",
    "supplier" to "Dodávatelia",
    "maintenance" to "Údržba / opravy",
    "marketing" to "Marketing / reklama",
    "taxes" to "Dane a odvody",
    "fees" to "Bankové poplatky",
    "equipment" to "Vybavenie",
    "cleaning" to "Čistenie / hygiena",
    "other_expense" to "Iný výdavok",
)
private val CF_CAT_LABEL: Map<String, String> =
    (CF_INCOME_CATS + CF_EXPENSE_CATS).toMap()

private val CF_METHOD_LABEL = linkedMapOf(
    "cash" to "Hotovosť",
    "card" to "Karta",
    "transfer" to "Prevod",
    "other" to "Iné",
)

/* ---------- Formátovanie (web parita) ---------- */

private val BRATISLAVA: ZoneId = ZoneId.of("Europe/Bratislava")

/** fmtEur(n) = fmtCost(n) + " €" — sub-cent adaptívny, sk-SK čiarka. */
private fun cfEur(v: Double): String = fmtCost(v) + " €"

/** entries[].amount je STRING → Number() ekvivalent. */
private fun cfAmount(s: String): Double = s.toDoubleOrNull() ?: 0.0

/** occurredAt ISO → "dd.MM.yyyy HH:mm" v Europe/Bratislava. */
private val CF_LIST_FMT: DateTimeFormatter =
    DateTimeFormatter.ofPattern("dd.MM.yyyy HH:mm")

private fun cfFmtDateTime(iso: String?): String {
    if (iso.isNullOrBlank()) return "—"
    return try {
        Instant.parse(iso).atZone(BRATISLAVA).format(CF_LIST_FMT)
    } catch (_: Exception) {
        iso.take(16).replace('T', ' ')
    }
}

/** Dnešný UTC dátum YYYY-MM-DD (web todayIso = toISOString().slice(0,10)). */
private fun cfTodayIso(): String =
    Instant.now().toString().take(10)

/** today - n dní v UTC (web todayMinusDaysIso: setUTCDate/toISOString). */
private fun cfTodayMinusDays(n: Int): String =
    Instant.now().minusSeconds(n.toLong() * 86_400L).toString().take(10)

/* datetime modal: lokálny Bratislava čas "yyyy-MM-dd HH:mm" ↔ ISO (UTC). */
private val CF_MODAL_FMT: DateTimeFormatter =
    DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")

private fun cfNowForModal(): String =
    LocalDateTime.now(BRATISLAVA).format(CF_MODAL_FMT)

private fun cfIsoToModal(iso: String?): String {
    if (iso.isNullOrBlank()) return cfNowForModal()
    return try {
        Instant.parse(iso).atZone(BRATISLAVA).format(CF_MODAL_FMT)
    } catch (_: Exception) {
        cfNowForModal()
    }
}

/** "yyyy-MM-dd HH:mm" (Bratislava) → ISO8601 UTC; null ak nečitateľné. */
private fun cfModalToIso(local: String): String? {
    val v = local.trim().replace('T', ' ')
    return try {
        LocalDateTime.parse(v, CF_MODAL_FMT)
            .atZone(BRATISLAVA)
            .toInstant()
            .toString()
    } catch (_: Exception) {
        null
    }
}

/* ===================================================================== */

@Composable
fun CashflowScreen() {
    val toast = rememberAdminToast()
    val scope = rememberCoroutineScope()

    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }

    var from by remember { mutableStateOf(cfTodayMinusDays(7)) }
    var to by remember { mutableStateOf(cfTodayIso()) }
    var typeFilter by remember { mutableStateOf("") }   // "" | income | expense

    var summary by remember { mutableStateOf<CfSummaryDto?>(null) }
    var entries by remember { mutableStateOf<List<CfEntryDto>>(emptyList()) }
    var suppliers by remember { mutableStateOf<List<CfSupplierDto>>(emptyList()) }

    // Modal stav (create / edit).
    var modalOpen by remember { mutableStateOf(false) }
    var modalEntry by remember { mutableStateOf<CfEntryDto?>(null) }  // null = create
    var modalPresetType by remember { mutableStateOf("expense") }

    // Soft-delete undo stav — optimistický remove + okno na vrátenie.
    var pendingDelete by remember { mutableStateOf<CfEntryDto?>(null) }

    fun load() {
        scope.launch {
            loading = true
            try {
                val s: CfSummaryDto
                val l: CfListDto
                withContext(Dispatchers.IO) {
                    val ty = typeFilter.ifBlank { null }
                    s = cfApi.summary(from, to)
                    l = cfApi.list(from, to, ty)
                }
                summary = s
                entries = l.entries
                error = null
            } catch (e: Exception) {
                if (e.httpCode() == 401) { /* sesia rieši shell */ }
                error = errorMessage(e)
            } finally {
                loading = false
            }
        }
    }

    fun reloadOnly() {
        // Tiché obnovenie po akcii (bez celoplošného loadera).
        scope.launch {
            try {
                val s: CfSummaryDto
                val l: CfListDto
                withContext(Dispatchers.IO) {
                    val ty = typeFilter.ifBlank { null }
                    s = cfApi.summary(from, to)
                    l = cfApi.list(from, to, ty)
                }
                summary = s
                entries = l.entries
                error = null
            } catch (e: Exception) {
                toast.show(errorMessage(e), error = true)
            }
        }
    }

    LaunchedEffect(Unit) {
        load()
        // Dodávatelia raz na init — paralelne, stale-tolerant.
        scope.launch {
            try {
                val sup = withContext(Dispatchers.IO) { cfApi.suppliers() }
                suppliers = sup.filter { it.active }
            } catch (_: Exception) {
                suppliers = emptyList()
            }
        }
    }

    AdminScreenBox(toast) {
        AdminSectionTitle("Cashflow")

        // Toolbar: dátumy + typ + presety + add tlačidlá.
        CfToolbar(
            from = from, to = to, typeFilter = typeFilter,
            onFrom = { from = it; load() },
            onTo = { to = it; load() },
            onType = { typeFilter = it; load() },
            onPreset = { n -> to = cfTodayIso(); from = cfTodayMinusDays(n); load() },
            onAddIncome = { modalEntry = null; modalPresetType = "income"; modalOpen = true },
            onAddExpense = { modalEntry = null; modalPresetType = "expense"; modalOpen = true },
        )
        Spacer(Modifier.height(14.dp))

        when {
            loading -> LoadingBox()
            error != null -> ErrorBox(error!!) { load() }
            else -> {
                val s = summary
                if (s != null) {
                    CfStatGrid(s, from, to)
                    Spacer(Modifier.height(18.dp))
                }

                // Panel: manuálne záznamy.
                AdminCard {
                    Text(
                        "Manuálne záznamy (${entries.size})",
                        style = MaterialTheme.typography.titleSmall,
                    )
                    Spacer(Modifier.height(8.dp))
                    CfEntriesTable(
                        entries = entries,
                        onEdit = { e -> modalEntry = e; modalPresetType = e.type; modalOpen = true },
                        onDelete = { e ->
                            // Optimistický remove + undo okno.
                            entries = entries.filterNot { it.id == e.id }
                            pendingDelete = e
                        },
                    )
                }

                Spacer(Modifier.height(18.dp))

                // Panel: rozpis kategórií.
                if (s != null) {
                    AdminCard {
                        Text("Rozpis kategórií", style = MaterialTheme.typography.titleSmall)
                        Spacer(Modifier.height(10.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(18.dp)) {
                            CfBreakdownBlock(
                                title = "Príjmy",
                                rows = s.byCategory.income,
                                barColor = Sage,
                                modifier = Modifier.weight(1f),
                            )
                            CfBreakdownBlock(
                                title = "Výdavky",
                                rows = s.byCategory.expense,
                                barColor = Danger,
                                modifier = Modifier.weight(1f),
                            )
                        }
                    }
                }
            }
        }
    }

    // Undo snackbar — DELETE sa commitne až po uplynutí okna (4 s), inak undo.
    pendingDelete?.let { snapshot ->
        LaunchedEffect(snapshot.id) {
            delay(4000)
            // Okno uplynulo → reálne zmaž a obnov totals.
            val committed = try {
                withContext(Dispatchers.IO) { cfApi.delete(snapshot.id) }
                true
            } catch (e: Exception) {
                // Zlyhanie → vráť riadok späť.
                entries = (entries + snapshot).sortedWith(
                    compareByDescending<CfEntryDto> { it.occurredAt ?: "" }.thenByDescending { it.id }
                )
                toast.show(errorMessage(e), error = true)
                false
            }
            pendingDelete = null
            if (committed) reloadOnly()
        }
        CfUndoSnackbar(
            label = "${CF_CAT_LABEL[snapshot.category] ?: snapshot.category} za ${cfEur(cfAmount(snapshot.amount))} zmazané",
            onUndo = {
                entries = (entries + snapshot).sortedWith(
                    compareByDescending<CfEntryDto> { it.occurredAt ?: "" }.thenByDescending { it.id }
                )
                pendingDelete = null
                toast.show("Vrátené", error = true)
            },
        )
    }

    if (modalOpen) {
        CfEntryModal(
            existing = modalEntry,
            presetType = modalPresetType,
            suppliers = suppliers,
            onDismiss = { modalOpen = false },
            onSave = { req ->
                val editing = modalEntry
                scope.launch {
                    try {
                        withContext(Dispatchers.IO) {
                            if (editing != null) cfApi.update(editing.id, req)
                            else cfApi.create(req)
                        }
                        modalOpen = false
                        toast.show(if (editing != null) "Záznam upravený" else "Záznam pridaný")
                        reloadOnly()
                    } catch (e: Exception) {
                        toast.show(errorMessage(e), error = true)
                    }
                }
            },
            onError = { msg -> toast.show(msg, error = true) },
        )
    }
}

/* ---------- Toolbar ---------- */

@Composable
private fun CfToolbar(
    from: String,
    to: String,
    typeFilter: String,
    onFrom: (String) -> Unit,
    onTo: (String) -> Unit,
    onType: (String) -> Unit,
    onPreset: (Int) -> Unit,
    onAddIncome: () -> Unit,
    onAddExpense: () -> Unit,
) {
    AdminCard {
        // Dátumy + typ.
        FlowRowCompat(spacing = 10.dp) {
            FormField(
                label = "Od", value = from, onChange = onFrom,
                placeholder = "RRRR-MM-DD",
                modifier = Modifier.width(150.dp),
            )
            FormField(
                label = "Do", value = to, onChange = onTo,
                placeholder = "RRRR-MM-DD",
                modifier = Modifier.width(150.dp),
            )
            Column {
                Text(
                    "Typ", style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(4.dp))
                val typeTabs = listOf("" to "Všetko", "income" to "Len príjmy", "expense" to "Len výdavky")
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    typeTabs.forEach { (value, lbl) ->
                        val active = typeFilter == value
                        Surface(
                            onClick = { onType(value) },
                            shape = RoundedCornerShape(999.dp),
                            color = if (active) Terra else MaterialTheme.colorScheme.surface,
                            border = BorderStroke(1.dp, if (active) Terra else BorderSoft),
                        ) {
                            Text(
                                lbl, Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                                color = if (active) Cream else MaterialTheme.colorScheme.onSurface,
                                style = MaterialTheme.typography.labelMedium,
                            )
                        }
                    }
                }
            }
        }

        Spacer(Modifier.height(12.dp))

        // Presety + add tlačidlá.
        FlowRowCompat(spacing = 8.dp) {
            OutlinedButton(onClick = { onPreset(0) }) { Text("Dnes") }
            OutlinedButton(onClick = { onPreset(7) }) { Text("7 dní") }
            OutlinedButton(onClick = { onPreset(30) }) { Text("30 dní") }
            Spacer(Modifier.width(4.dp))
            Button(
                onClick = onAddIncome,
                colors = ButtonDefaults.buttonColors(containerColor = Sage, contentColor = Cream),
            ) { Text("+ Príjem") }
            Button(
                onClick = onAddExpense,
                colors = ButtonDefaults.buttonColors(containerColor = Danger, contentColor = Cream),
            ) { Text("+ Výdavok") }
        }
    }
}

/* ---------- Stat grid (3 karty) ---------- */

@Composable
private fun CfStatGrid(s: CfSummaryDto, from: String, to: String) {
    val incomeSub = buildString {
        append("POS "); append(cfEur(s.posRevenue))
        append(" + manuál "); append(cfEur(s.manual.income))
        if (s.shishaRevenue > 0) { append(" + shisha "); append(cfEur(s.shishaRevenue)) }
    }
    val netColor = if (s.netCashflow >= 0) Sage else Danger
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        StatCard(
            label = "Príjmy spolu",
            value = cfEur(s.totalIncome),
            accent = Sage,
            sub = incomeSub,
            modifier = Modifier.weight(1f),
        )
        StatCard(
            label = "Výdavky spolu",
            value = cfEur(s.totalExpense),
            accent = Danger,
            sub = "${s.manual.expenseCount} záznamov",
            modifier = Modifier.weight(1f),
        )
        StatCard(
            label = "Čistý zisk",
            value = cfEur(s.netCashflow),
            accent = netColor,
            sub = "$from → $to",
            modifier = Modifier.weight(1f),
        )
    }
}

/* ---------- Tabuľka záznamov ---------- */

@Composable
private fun CfEntriesTable(
    entries: List<CfEntryDto>,
    onEdit: (CfEntryDto) -> Unit,
    onDelete: (CfEntryDto) -> Unit,
) {
    // Stĺpce: Dátum, Typ, Kategória, Dodávateľ, Suma, Spôsob, Poznámka, Akcie.
    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        cfHeaderCell("Dátum", 2.4f)
        cfHeaderCell("Typ", 1.3f)
        cfHeaderCell("Kategória", 2.2f)
        cfHeaderCell("Dodávateľ", 1.8f)
        cfHeaderCell("Suma", 1.4f)
        cfHeaderCell("Spôsob", 1.4f)
        cfHeaderCell("Poznámka", 2.2f)
        cfHeaderCell("", 1.4f)
    }
    HorizontalDivider(color = BorderSoft)

    if (entries.isEmpty()) {
        EmptyHint("Žiadne manuálne záznamy v tomto období.")
        return
    }

    entries.forEach { e ->
        Row(
            Modifier.fillMaxWidth().padding(vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                cfFmtDateTime(e.occurredAt), Modifier.weight(2.4f),
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            Box(Modifier.weight(1.3f)) {
                if (e.type == "income") StatusBadge("Príjem", Sage)
                else StatusBadge("Výdavok", Danger)
            }
            Text(
                CF_CAT_LABEL[e.category] ?: e.category, Modifier.weight(2.2f),
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 2, overflow = TextOverflow.Ellipsis,
            )
            Text(
                e.supplierName ?: "—", Modifier.weight(1.8f),
                style = MaterialTheme.typography.bodyMedium,
                color = if (e.supplierName == null) EspressoDim else MaterialTheme.colorScheme.onSurface,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            Text(
                cfEur(cfAmount(e.amount)), Modifier.weight(1.4f),
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Bold,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            Text(
                CF_METHOD_LABEL[e.method] ?: e.method, Modifier.weight(1.4f),
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            Text(
                e.note.ifBlank { "—" }, Modifier.weight(2.2f),
                style = MaterialTheme.typography.bodyMedium,
                color = if (e.note.isBlank()) EspressoDim else MaterialTheme.colorScheme.onSurface,
                maxLines = 2, overflow = TextOverflow.Ellipsis,
            )
            Row(
                Modifier.weight(1.4f),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                CfIconButton("✎", "Upraviť", Navy) { onEdit(e) }
                CfIconButton("✕", "Vymazať", Danger) { onDelete(e) }
            }
        }
        HorizontalDivider(color = BorderSoft.copy(alpha = 0.5f))
    }
}

@Composable
private fun RowScope.cfHeaderCell(label: String, weight: Float) {
    Text(
        label.uppercase(), Modifier.weight(weight),
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1,
    )
}

@Composable
private fun CfIconButton(glyph: String, desc: String, color: Color, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(8.dp),
        color = color.copy(alpha = 0.10f),
        border = BorderStroke(1.dp, color.copy(alpha = 0.30f)),
        modifier = Modifier.sizeIn(minWidth = 44.dp, minHeight = 44.dp),
    ) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text(glyph, color = color, style = MaterialTheme.typography.bodyLarge)
        }
    }
}

/* ---------- Rozpis kategórií (percentuálne bary) ---------- */

@Composable
private fun CfBreakdownBlock(
    title: String,
    rows: List<CfCatRow>,
    barColor: Color,
    modifier: Modifier = Modifier,
) {
    Column(modifier) {
        if (rows.isEmpty()) {
            Text(title, style = MaterialTheme.typography.titleSmall, color = EspressoSoft)
            Spacer(Modifier.height(6.dp))
            Text(
                "Žiadne záznamy.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            return@Column
        }
        val total = rows.sumOf { it.total }
        Text(
            "$title — spolu ${cfEur(total)}",
            style = MaterialTheme.typography.titleSmall, color = EspressoSoft,
        )
        Spacer(Modifier.height(8.dp))
        rows.forEach { r ->
            val pct = if (total > 0) ((r.total / total) * 100).roundToInt() else 0
            Column(Modifier.padding(bottom = 8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        "${CF_CAT_LABEL[r.category] ?: r.category} (${r.count})",
                        Modifier.weight(1f),
                        style = MaterialTheme.typography.bodyMedium,
                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        cfEur(r.total),
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Bold,
                    )
                    Spacer(Modifier.width(6.dp))
                    Text(
                        "$pct%",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Spacer(Modifier.height(4.dp))
                Box(
                    Modifier.fillMaxWidth().height(6.dp)
                        .clip(RoundedCornerShape(3.dp))
                        .background(CreamSunken),
                ) {
                    Box(
                        Modifier.fillMaxHeight()
                            .fillMaxWidth((pct / 100f).coerceIn(0f, 1f))
                            .background(barColor),
                    )
                }
            }
        }
    }
}

/* ---------- Undo snackbar (soft-delete okno) ---------- */

@Composable
private fun CfUndoSnackbar(label: String, onUndo: () -> Unit) {
    Box(Modifier.fillMaxSize()) {
        Surface(
            Modifier.align(Alignment.BottomCenter).padding(16.dp)
                .paperShadow(6.dp, RoundedCornerShape(12.dp)),
            shape = RoundedCornerShape(12.dp),
            color = Espresso, contentColor = Cream,
        ) {
            Row(
                Modifier.padding(start = 14.dp, end = 6.dp, top = 4.dp, bottom = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    label, style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.padding(vertical = 8.dp),
                )
                Spacer(Modifier.width(8.dp))
                TextButton(onClick = onUndo) { Text("Vrátiť", color = Amber) }
            }
        }
    }
}

/* ---------- Modal (create / edit) ---------- */

@Composable
private fun CfEntryModal(
    existing: CfEntryDto?,
    presetType: String,
    suppliers: List<CfSupplierDto>,
    onDismiss: () -> Unit,
    onSave: (CfEntryReq) -> Unit,
    onError: (String) -> Unit,
) {
    val isEdit = existing != null
    var type by remember { mutableStateOf(existing?.type ?: presetType.ifBlank { "expense" }) }
    var category by remember {
        mutableStateOf(
            existing?.category
                ?: (if ((existing?.type ?: presetType) == "income") CF_INCOME_CATS.first().first
                else CF_EXPENSE_CATS.first().first)
        )
    }
    var amount by remember {
        mutableStateOf(if (isEdit) String.format("%.2f", cfAmount(existing!!.amount)) else "")
    }
    var occurredLocal by remember { mutableStateOf(cfIsoToModal(existing?.occurredAt)) }
    var method by remember { mutableStateOf(existing?.method ?: "cash") }
    var note by remember { mutableStateOf(existing?.note ?: "") }
    var supplierId by remember { mutableStateOf(existing?.supplierId) }

    val cats = if (type == "income") CF_INCOME_CATS else CF_EXPENSE_CATS
    // Pri zmene typu drž platnú kategóriu (web refillCategories).
    LaunchedEffect(type) {
        if (cats.none { it.first == category }) category = cats.first().first
    }

    val showSupplier = suppliers.isNotEmpty() &&
        ((type == "expense" && category == "supplier") || (type == "income" && category == "refund"))
    // Skry väzbu keď picker nie je viditeľný (web: clear linked supplier).
    LaunchedEffect(showSupplier) { if (!showSupplier) supplierId = null }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                if (isEdit) "Upraviť záznam"
                else if (type == "income") "Nový príjem" else "Nový výdavok"
            )
        },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                // Typ.
                CfSelectField(
                    label = "Typ",
                    options = listOf("income" to "Príjem", "expense" to "Výdavok"),
                    selected = type,
                    onSelect = { type = it },
                )
                // Kategória.
                CfSelectField(
                    label = "Kategória",
                    options = cats,
                    selected = category,
                    onSelect = { category = it },
                )
                // Dodávateľ (podmienečne).
                if (showSupplier) {
                    CfSelectField(
                        label = "Dodávateľ",
                        options = listOf((-1) to "— žiadny —") + suppliers.map { it.id to it.name },
                        selected = supplierId ?: -1,
                        onSelect = { supplierId = if (it == -1) null else it },
                    )
                }
                // Suma.
                FormField(
                    label = "Suma", value = amount,
                    onChange = { amount = it.replace(',', '.') },
                    placeholder = "0.00",
                    keyboard = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                    suffix = "€",
                )
                // Dátum (Bratislava lokálny čas).
                FormField(
                    label = "Dátum", value = occurredLocal,
                    onChange = { occurredLocal = it },
                    placeholder = "RRRR-MM-DD HH:MM",
                )
                // Spôsob.
                CfSelectField(
                    label = "Spôsob",
                    options = CF_METHOD_LABEL.toList(),
                    selected = method,
                    onSelect = { method = it },
                )
                // Poznámka.
                FormField(
                    label = "Poznámka", value = note,
                    onChange = { if (it.length <= 500) note = it },
                    placeholder = "",
                )
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    val amt = amount.replace(',', '.').toDoubleOrNull()
                    if (amt == null || !amt.isFinite() || amt <= 0) {
                        onError("Suma musí byť väčšia ako 0")
                        return@Button
                    }
                    val iso = cfModalToIso(occurredLocal)
                    if (iso == null) {
                        onError("Neplatný dátum")
                        return@Button
                    }
                    onSave(
                        CfEntryReq(
                            type = type,
                            category = category,
                            amount = amt,
                            occurredAt = iso,
                            method = method,
                            note = note.trim(),
                            supplierId = supplierId,
                        )
                    )
                },
                colors = ButtonDefaults.buttonColors(containerColor = Terra, contentColor = Cream),
            ) { Text(if (isEdit) "Uložiť" else "Pridať") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Zrušiť") } },
    )
}

/** Jednoduchý select cez DropdownMenu — generický kľúč (String alebo Int). */
@Composable
private fun <K> CfSelectField(
    label: String,
    options: List<Pair<K, String>>,
    selected: K,
    onSelect: (K) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    val selectedLabel = options.firstOrNull { it.first == selected }?.second ?: ""
    Column {
        Text(
            label, style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(4.dp))
        Box {
            Surface(
                onClick = { expanded = true },
                shape = RoundedCornerShape(8.dp),
                color = MaterialTheme.colorScheme.surface,
                border = BorderStroke(1.dp, BorderMid),
                modifier = Modifier.fillMaxWidth().heightIn(min = 44.dp),
            ) {
                Row(
                    Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        selectedLabel, Modifier.weight(1f),
                        style = MaterialTheme.typography.bodyMedium,
                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                    Text("▾", color = EspressoDim)
                }
            }
            DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                options.forEach { (key, lbl) ->
                    DropdownMenuItem(
                        text = { Text(lbl) },
                        onClick = { onSelect(key); expanded = false },
                    )
                }
            }
        }
    }
}

/* ---------- Jednoduchý wrap-row bez experimentálneho FlowRow ---------- */

/**
 * Minimalistický náhradník FlowRow — drží prvky vedľa seba s medzerou;
 * pri úzkej šírke sa spoľahne na to, že obsah je krátky (toolbar). Použité
 * aby sme sa vyhli @OptIn(ExperimentalLayoutApi). Pre tablet je jeden riadok
 * dostatočne široký.
 */
@Composable
private fun FlowRowCompat(spacing: androidx.compose.ui.unit.Dp, content: @Composable RowScope.() -> Unit) {
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(spacing),
        verticalAlignment = Alignment.Bottom,
        content = content,
    )
}
