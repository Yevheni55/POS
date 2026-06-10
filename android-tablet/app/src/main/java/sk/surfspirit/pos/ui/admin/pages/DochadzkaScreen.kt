package sk.surfspirit.pos.ui.admin.pages

import android.content.ContentValues
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Query
import sk.surfspirit.pos.core.BRATISLAVA
import sk.surfspirit.pos.core.errorMessage
import sk.surfspirit.pos.core.fmtCost
import sk.surfspirit.pos.net.Api
import sk.surfspirit.pos.ui.admin.*
import sk.surfspirit.pos.ui.theme.*
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.temporal.TemporalAdjusters

/* =====================================================================
   Admin → Dochádzka — natívna parita web admin/pages/dochadzka.js.
   Toolbar (od/do/zamestnanec/presety/CSV/obnoviť), all-time dlžoba panel,
   6 KPI kariet (Otv. smeny clickable filter), tabuľka per zamestnanec,
   expand detail (smeny + audit + manuálna úprava), unified payout modal.
   ===================================================================== */

/* ---------------- DTOs (Doch prefix) ---------------- */

@Serializable
private data class DochOverlapInfo(val withStaffId: Int = 0, val minutes: Int = 0, val rate: Double = 0.0)

@Serializable
private data class DochSummaryRow(
    val staffId: Int,
    val name: String = "",
    val position: String = "",
    val hourlyRate: String? = null,          // Drizzle numeric STRING | null
    val minutes: Int = 0,
    val openShifts: Int = 0,
    val wage: Double = 0.0,                   // server Number()s + rounds
    val overlapInfo: DochOverlapInfo? = null,
    val paidTotal: Double = 0.0,
    val paidCount: Int = 0,
    val lastPaidAt: String? = null,
    val outstanding: Double = 0.0,
)

@Serializable
private data class DochSummaryResp(val from: String = "", val to: String = "", val rows: List<DochSummaryRow> = emptyList())

@Serializable
private data class DochBalanceRow(
    val staffId: Int,
    val name: String = "",
    val position: String = "",
    val active: Boolean = true,
    val totalWage: Double = 0.0,
    val totalPaid: Double = 0.0,
    val balance: Double = 0.0,
    val lastPaidAt: String? = null,
)

@Serializable
private data class DochBalanceResp(
    val totalOwed: Double = 0.0,
    val totalPrepaid: Double = 0.0,
    val rows: List<DochBalanceRow> = emptyList(),
)

@Serializable
private data class DochStaffMeta(val id: Int = 0, val name: String = "", val position: String = "", val hourlyRate: String? = null)

@Serializable
private data class DochPaid(
    val id: Int = 0,
    val amount: Double = 0.0,
    val paidAt: String = "",
    val paidByStaffId: Int = 0,
    val cashflowEntryId: Int = 0,
    val note: String = "",
)

@Serializable
private data class DochEvent(
    val id: Int = 0,
    val staffId: Int = 0,
    val type: String = "",                   // clock_in | clock_out
    val at: String = "",                     // ISO
    val source: String = "",                 // pin | manual | auto_close
    val note: String = "",
    val reason: String? = null,
    val editedBy: Int? = null,
    val paid: DochPaid? = null,              // only on clock_out
)

@Serializable
private data class DochHistorySummary(val minutes: Int = 0, val openShifts: Int = 0, val wage: Double = 0.0)

@Serializable
private data class DochHistoryResp(
    val staff: DochStaffMeta? = null,
    val events: List<DochEvent> = emptyList(),
    val summary: DochHistorySummary = DochHistorySummary(),
)

@Serializable private data class DochShiftPayoutReq(val clockOutEventId: Int, val amount: Double, val note: String = "")
@Serializable private data class DochLumpReq(val staffId: Int, val amount: Double, val note: String = "")
@Serializable private data class DochLumpResp(
    val totalPaid: Double = 0.0,
    val shiftsCovered: Int = 0,
    val partialShifts: Int = 0,
    val remainder: Double = 0.0,
    val cashflowEntryId: Int = 0,
)
@Serializable private data class DochShiftPayoutResp(val id: Int = 0, val amount: Double = 0.0)
@Serializable private data class DochEventReq(
    val staffId: Int,
    val type: String,
    val at: String,
    val reason: String,
    val note: String = "",
)

private interface DochApi {
    @GET("api/attendance/summary")
    suspend fun summary(@Query("from") from: String, @Query("to") to: String): DochSummaryResp

    @GET("api/attendance/balance")
    suspend fun balance(): DochBalanceResp

    @GET("api/attendance/history/{staffId}")
    suspend fun history(@Path("staffId") staffId: Int, @Query("from") from: String, @Query("to") to: String): DochHistoryResp

    @POST("api/attendance/payouts")
    suspend fun payShift(@Body body: DochShiftPayoutReq): DochShiftPayoutResp

    @POST("api/attendance/payouts/lump-sum")
    suspend fun payLump(@Body body: DochLumpReq): DochLumpResp

    @DELETE("api/attendance/payouts/{id}")
    suspend fun unpay(@Path("id") id: Int): retrofit2.Response<Unit>

    @POST("api/attendance/events")
    suspend fun addEvent(@Body body: DochEventReq): kotlinx.serialization.json.JsonElement

    @DELETE("api/attendance/events/{id}")
    suspend fun deleteEvent(@Path("id") id: Int): kotlinx.serialization.json.JsonElement
}

private val dochApi: DochApi by lazy { Api.create(DochApi::class.java) }

/* ---------------- Formátovanie + helpers (web parita) ---------------- */

private fun dochTodayIso(): String = LocalDate.now(BRATISLAVA).toString()
private fun dochTodayMinus(n: Long): String = LocalDate.now(BRATISLAVA).minusDays(n).toString()

private fun dochFmtMinutes(m: Int): String {
    if (m <= 0) return "0h 0m"
    return "${m / 60}h ${m % 60}m"
}

private fun dochFmtEur(n: Double): String = fmtCost(n) + " €"

private val DOCH_DATETIME = DateTimeFormatter.ofPattern("dd.MM.yyyy HH:mm")
private val DOCH_DATE = DateTimeFormatter.ofPattern("dd.MM.yyyy")
private val DOCH_TIME = DateTimeFormatter.ofPattern("HH:mm")

private fun dochZoned(iso: String?): java.time.ZonedDateTime? {
    if (iso.isNullOrBlank()) return null
    return try {
        java.time.Instant.parse(iso).atZone(BRATISLAVA)
    } catch (_: Exception) {
        try { java.time.LocalDateTime.parse(iso.take(19).replace(' ', 'T')).atZone(BRATISLAVA) }
        catch (_: Exception) { null }
    }
}

private fun dochFmtDateTime(iso: String?): String = dochZoned(iso)?.format(DOCH_DATETIME) ?: ""
private fun dochFmtDate(iso: String?): String = dochZoned(iso)?.format(DOCH_DATE) ?: ""
private fun dochFmtTime(iso: String?): String = dochZoned(iso)?.format(DOCH_TIME) ?: ""

private val DOCH_REASONS = listOf(
    "forgot" to "Zabudol kliknúť",
    "wrong_time" to "Nesprávny čas",
    "shift_change" to "Zmena zmeny",
    "pin_failed" to "PIN zlyhal",
    "other" to "Iné",
)
private fun dochReasonLabel(r: String?): String =
    DOCH_REASONS.firstOrNull { it.first == r }?.second ?: (r ?: "—")

private fun DochSummaryRow.rateOrNull(): Double? = hourlyRate?.toDoubleOrNull()

/* Smeny párované klient-side z eventov (asc) — web buildShifts(). */
private data class DochShift(val start: DochEvent?, val end: DochEvent?, val minutes: Int?)

private fun dochBuildShifts(eventsAsc: List<DochEvent>): List<DochShift> {
    val raw = ArrayList<Pair<DochEvent?, DochEvent?>>()
    var pending: DochEvent? = null
    for (e in eventsAsc) {
        when (e.type) {
            "clock_in" -> {
                if (pending != null) raw.add(pending to null)
                pending = e
            }
            "clock_out" -> {
                if (pending != null) { raw.add(pending to e); pending = null }
                else raw.add(null to e)
            }
        }
    }
    if (pending != null) raw.add(pending to null)
    return raw.map { (s, en) ->
        val mins = if (s != null && en != null) {
            val a = dochZoned(s.at)?.toInstant()?.toEpochMilli()
            val b = dochZoned(en.at)?.toInstant()?.toEpochMilli()
            if (a != null && b != null && b > a) ((b - a) / 60000L).toInt() else 0
        } else null
        DochShift(s, en, mins)
    }
}

/* Klient-side preset rozsahy (LOCAL-time, Europe/Bratislava). */
private fun dochPresetRange(preset: String): Pair<String, String> {
    val today = LocalDate.now(BRATISLAVA)
    return when (preset) {
        "week" -> {
            val mon = today.with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY))
            val sun = today.with(TemporalAdjusters.nextOrSame(DayOfWeek.SUNDAY))
            mon.toString() to sun.toString()
        }
        "last-week" -> {
            val mon = today.with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY)).minusWeeks(1)
            val sun = mon.plusDays(6)
            mon.toString() to sun.toString()
        }
        "month" -> today.withDayOfMonth(1).toString() to today.toString()
        "last-month" -> {
            val firstPrev = today.withDayOfMonth(1).minusMonths(1)
            val lastPrev = today.withDayOfMonth(1).minusDays(1)
            firstPrev.toString() to lastPrev.toString()
        }
        else -> {
            val days = preset.toLongOrNull() ?: 7
            today.minusDays(days).toString() to today.toString()
        }
    }
}

/* Klient-side KPI súčty nad viditeľnými riadkami — web totalsFor(). */
private data class DochTotals(
    val totalMinutes: Int, val totalWage: Double, val openShifts: Int,
    val totalStaff: Int, val withRate: Int,
    val totalPaid: Double, val totalOutstanding: Double, val outstandingPositive: Int,
)

private fun dochTotalsFor(rows: List<DochSummaryRow>): DochTotals {
    var minutes = 0; var wage = 0.0; var open = 0; var withRate = 0
    var paid = 0.0; var outstanding = 0.0; var outPos = 0
    for (r in rows) {
        minutes += r.minutes
        wage += r.wage
        open += r.openShifts
        paid += r.paidTotal
        outstanding += r.outstanding
        if (r.hourlyRate != null) withRate += 1
        if (r.outstanding > 0.01) outPos += 1
    }
    return DochTotals(minutes, wage, open, rows.size, withRate, paid, outstanding, outPos)
}

/* Slovenská gramatika (web inline). */
private fun dochStaffWord(n: Int) = if (n == 1) "zamestnanec" else "zamestnancov"
private fun dochPersonWord(n: Int) = if (n == 1) "osoba" else "osôb"
private fun dochShiftWord(n: Int) = when {
    n == 1 -> "smena"
    n in 2..4 -> "smeny"
    else -> "smien"
}

/* CSV (semicolon, čiarka desatinná, UTF-8 BOM) — web buildAttendanceCsv(). */
private fun dochCsvCell(s: String): String =
    if (s.any { it == ';' || it == '"' || it == '\n' || it == '\r' }) "\"" + s.replace("\"", "\"\"") + "\"" else s

private fun dochBuildCsv(rows: List<DochSummaryRow>, from: String, to: String): String {
    val sb = StringBuilder()
    sb.append("# Dochadzka export ").append(from).append(" .. ").append(to).append('\n')
    sb.append("Meno;Pozicia;Sadzba/h;Hodin;Mzda;Vyplatene;Zostava\n")
    for (r in rows) {
        val h = r.minutes / 60
        val m = r.minutes % 60
        val hrs = "${h}h ${m.toString().padStart(2, '0')}m"
        fun num(v: Double) = String.format("%.2f", v).replace('.', ',')
        val cells = listOf(
            r.name,
            r.position,
            r.rateOrNull()?.let { num(it) } ?: "",
            hrs,
            num(r.wage),
            num(r.paidTotal),
            num(r.outstanding),
        ).map { dochCsvCell(it) }
        sb.append(cells.joinToString(";")).append('\n')
    }
    sb.append('\n')
    return sb.toString()
}

/* ---------------- Screen ---------------- */

@Composable
fun DochadzkaScreen() {
    val toast = rememberAdminToast()
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current

    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }

    var from by remember { mutableStateOf(dochTodayMinus(7)) }
    var to by remember { mutableStateOf(dochTodayIso()) }
    var summary by remember { mutableStateOf(DochSummaryResp()) }
    var balance by remember { mutableStateOf<DochBalanceResp?>(null) }
    var staffFilter by remember { mutableStateOf("all") }   // "all" | staffId
    var openOnly by remember { mutableStateOf(false) }
    var expanded by remember { mutableStateOf<Int?>(null) }

    // Detail state
    var detailLoading by remember { mutableStateOf(false) }
    var detailError by remember { mutableStateOf<String?>(null) }
    var detailData by remember { mutableStateOf<DochHistoryResp?>(null) }

    // Dialógy
    var confirm by remember { mutableStateOf<DochConfirmReq?>(null) }
    var payoutDialog by remember { mutableStateOf<DochPayoutReq?>(null) }

    fun loadBalance() {
        scope.launch {
            try { balance = withContext(Dispatchers.IO) { dochApi.balance() } }
            catch (_: Exception) { balance = null }   // ticho — panel sa proste skryje
        }
    }

    fun loadHistory(staffId: Int) {
        detailLoading = true; detailError = null; detailData = null
        scope.launch {
            try {
                detailData = withContext(Dispatchers.IO) { dochApi.history(staffId, from, to) }
                detailError = null
            } catch (e: Exception) {
                detailError = errorMessage(e)
            } finally { detailLoading = false }
        }
    }

    fun loadSummary() {
        loading = true
        scope.launch {
            try {
                val res = withContext(Dispatchers.IO) { dochApi.summary(from, to) }
                summary = res
                // Filter padá späť na 'all' ak osoba zmizla z výsledku.
                if (staffFilter != "all" && res.rows.none { it.staffId.toString() == staffFilter }) {
                    staffFilter = "all"
                }
                error = null
            } catch (e: Exception) {
                // Nezmaž zobrazenú tabuľku pri zlyhanom refreshi — nechaj
                // stale riadky a chybu ukáž toastom (Dashboard pattern);
                // ErrorBox len keď nie je čo ukázať.
                if (summary.rows.isEmpty()) error = errorMessage(e)
                else toast.show(errorMessage(e), error = true)
            } finally {
                loading = false
                loadBalance()
                expanded?.let { loadHistory(it) }   // refresh otvoreného detailu po mutácii
            }
        }
    }

    LaunchedEffect(Unit) { loadSummary() }

    // Viditeľné riadky (staffFilter + openOnly) — zhodné pre KPI aj tabuľku.
    val allRows = summary.rows
    val visibleRows = remember(allRows, staffFilter, openOnly) {
        var rows = if (staffFilter == "all") allRows else allRows.filter { it.staffId.toString() == staffFilter }
        if (openOnly) rows = rows.filter { it.openShifts > 0 }
        rows
    }
    val totals = remember(visibleRows) { dochTotalsFor(visibleRows) }

    AdminScreenBox(toast, scrollable = false) {
        AdminSectionTitle("Dochádzka")

        when {
            loading && allRows.isEmpty() -> LoadingBox()
            error != null && allRows.isEmpty() -> ErrorBox(error!!) { loadSummary() }
            else -> {
                LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    // Toolbar
                    item {
                        DochToolbar(
                            from = from, to = to,
                            onFrom = { from = it }, onTo = { to = it },
                            staffOptions = allRows,
                            staffFilter = staffFilter,
                            onStaff = { staffFilter = it; expanded = null; detailData = null },
                            onPreset = { preset ->
                                val (f, t) = dochPresetRange(preset)
                                from = f; to = t; openOnly = false; expanded = null
                                loadSummary()
                            },
                            onRefresh = { openOnly = false; expanded = null; detailData = null; loadSummary() },
                            onExport = {
                                val rows = allRows.filter { staffFilter == "all" || it.staffId.toString() == staffFilter }
                                if (rows.isEmpty()) { toast.show("Žiadne dáta na export", error = true); return@DochToolbar }
                                val saved = dochSaveCsv(ctx, dochBuildCsv(rows, from, to), "dochadzka_${from}_$to.csv")
                                toast.show(if (saved != null) "CSV uložené: $saved" else "Export zlyhal", error = saved == null)
                            },
                        )
                    }

                    // All-time dlžoba panel
                    balance?.let { b ->
                        item { DochBalancePanel(b) }
                    }

                    // KPI grid (6 kariet)
                    item {
                        DochKpiGrid(
                            totals = totals, from = from, to = to, openOnly = openOnly,
                            onToggleOpen = {
                                val checkRows = if (staffFilter == "all") allRows
                                else allRows.filter { it.staffId.toString() == staffFilter }
                                val hasOpen = checkRows.any { it.openShifts > 0 }
                                if (!openOnly && !hasOpen) return@DochKpiGrid
                                openOnly = !openOnly; expanded = null
                            },
                        )
                    }

                    // Hlavná tabuľka
                    item {
                        AdminCard {
                            Text("Prehľad za obdobie", style = MaterialTheme.typography.titleSmall)
                            Spacer(Modifier.height(8.dp))
                            DochTableHeader()
                            if (visibleRows.isEmpty()) {
                                EmptyHint(
                                    when {
                                        openOnly -> "Žiadni ľudia s otvorenými smenami. Klikom na „Otvorené smeny\" vypneš filter."
                                        staffFilter == "all" -> "Žiadne dáta za toto obdobie. Zamestnanci sa objavia po prvom Príchode."
                                        else -> "Vybraný zamestnanec nemá v tomto období žiadne záznamy."
                                    }
                                )
                            }
                        }
                    }

                    items(visibleRows, key = { it.staffId }) { r ->
                        DochRow(
                            row = r,
                            allRows = allRows,
                            isOpen = expanded == r.staffId,
                            onPayout = {
                                payoutDialog = DochPayoutReq(
                                    staffId = r.staffId, staffName = r.name,
                                    hourlyRate = r.rateOrNull() ?: 0.0, mode = "lump",
                                )
                            },
                            onToggle = {
                                if (expanded == r.staffId) { expanded = null; detailData = null }
                                else { expanded = r.staffId; loadHistory(r.staffId) }
                            },
                        )
                        if (expanded == r.staffId) {
                            DochDetail(
                                staffId = r.staffId,
                                parentRow = r,
                                loading = detailLoading,
                                error = detailError,
                                data = detailData,
                                onRetry = { loadHistory(r.staffId) },
                                onPayShift = { eventId, wage ->
                                    payoutDialog = DochPayoutReq(
                                        staffId = r.staffId, staffName = r.name,
                                        hourlyRate = r.rateOrNull() ?: 0.0, mode = "shift",
                                        shiftWage = wage, clockOutEventId = eventId,
                                    )
                                },
                                onUnpay = { payoutId ->
                                    confirm = DochConfirmReq(
                                        title = "Zrušiť výplatu tejto smeny?",
                                        text = "Súčasne sa odstráni aj zodpovedajúci záznam v Cashflow.",
                                        confirmLabel = "Zrušiť",
                                    ) {
                                        scope.launch {
                                            try {
                                                withContext(Dispatchers.IO) { dochApi.unpay(payoutId) }
                                                toast.show("Výplata zrušená")
                                                loadSummary()
                                            } catch (e: Exception) { toast.show(errorMessage(e), error = true) }
                                        }
                                    }
                                },
                                onDeleteEvent = { eventId ->
                                    confirm = DochConfirmReq(
                                        title = "Vymazať záznam?",
                                        text = "Toto natrvalo odstráni záznam dochádzky. Mzdový prepočet sa obnoví.",
                                        confirmLabel = "Vymazať",
                                    ) {
                                        scope.launch {
                                            try {
                                                withContext(Dispatchers.IO) { dochApi.deleteEvent(eventId) }
                                                toast.show("Záznam vymazaný")
                                                loadSummary()
                                            } catch (e: Exception) { toast.show(errorMessage(e), error = true) }
                                        }
                                    }
                                },
                                onAddEvent = { type, reason, atIso, note ->
                                    scope.launch {
                                        try {
                                            withContext(Dispatchers.IO) {
                                                dochApi.addEvent(DochEventReq(r.staffId, type, atIso, reason, note))
                                            }
                                            toast.show("Záznam pridaný")
                                            loadSummary()
                                        } catch (e: Exception) { toast.show(errorMessage(e), error = true) }
                                    }
                                },
                            )
                        }
                    }

                    item { Spacer(Modifier.height(24.dp)) }
                }
            }
        }
    }

    // Confirm dialóg
    confirm?.let { c ->
        AdminConfirm(
            title = c.title, text = c.text, confirmLabel = c.confirmLabel, danger = true,
            onConfirm = { c.onConfirm(); confirm = null },
            onDismiss = { confirm = null },
        )
    }

    // Unified payout dialóg
    payoutDialog?.let { p ->
        DochPayoutDialog(
            req = p,
            onDismiss = { payoutDialog = null },
            onSubmitLump = { amount, note ->
                scope.launch {
                    try {
                        val res = withContext(Dispatchers.IO) { dochApi.payLump(DochLumpReq(p.staffId, amount, note)) }
                        payoutDialog = null
                        val parts = if (res.partialShifts > 0) " (${res.partialShifts} čiastočne)" else ""
                        val rem = if (res.remainder > 0) " Zostáva ${dochFmtEur(res.remainder)} (nepoužité)" else ""
                        toast.show("Vyplatené ${dochFmtEur(res.totalPaid)} — pokrytých ${res.shiftsCovered} ${dochShiftWord(res.shiftsCovered)}$parts.$rem")
                        loadSummary()
                    } catch (e: Exception) { toast.show(errorMessage(e), error = true) }
                }
            },
            onSubmitShift = { eventId, amount, note ->
                scope.launch {
                    try {
                        val res = withContext(Dispatchers.IO) { dochApi.payShift(DochShiftPayoutReq(eventId, amount, note)) }
                        payoutDialog = null
                        toast.show("Smena označená ako vyplatená (${dochFmtEur(if (res.amount > 0) res.amount else amount)})")
                        loadSummary()
                    } catch (e: Exception) { toast.show(errorMessage(e), error = true) }
                }
            },
        )
    }
}

/* ---------------- Toolbar ---------------- */

@Composable
private fun DochToolbar(
    from: String, to: String,
    onFrom: (String) -> Unit, onTo: (String) -> Unit,
    staffOptions: List<DochSummaryRow>,
    staffFilter: String, onStaff: (String) -> Unit,
    onPreset: (String) -> Unit,
    onRefresh: () -> Unit,
    onExport: () -> Unit,
) {
    AdminCard {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Bottom) {
            FormField("Od", from, onFrom, Modifier.weight(1f), placeholder = "RRRR-MM-DD")
            FormField("Do", to, onTo, Modifier.weight(1f), placeholder = "RRRR-MM-DD")
        }
        Spacer(Modifier.height(10.dp))
        // Zamestnanec filter
        Text("Zamestnanec", style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(4.dp))
        DochStaffSelect(staffOptions, staffFilter, onStaff)

        Spacer(Modifier.height(12.dp))
        // Presety
        val presets = listOf(
            "week" to "Tento týždeň", "last-week" to "Minulý týždeň",
            "month" to "Tento mesiac", "last-month" to "Minulý mesiac",
            "7" to "7 dní", "30" to "30 dní",
        )
        FlowRowPresets(presets) { onPreset(it) }

        Spacer(Modifier.height(12.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = onExport, modifier = Modifier.weight(1f).heightIn(min = 44.dp)) {
                Text("Export CSV")
            }
            Button(
                onClick = onRefresh,
                modifier = Modifier.weight(1f).heightIn(min = 44.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Terra, contentColor = Cream),
            ) { Text("Obnoviť") }
        }
    }
}

@Composable
private fun FlowRowPresets(presets: List<Pair<String, String>>, onClick: (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        presets.chunked(2).forEach { pair ->
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                pair.forEach { (key, label) ->
                    OutlinedButton(
                        onClick = { onClick(key) },
                        modifier = Modifier.weight(1f).heightIn(min = 44.dp),
                        contentPadding = PaddingValues(horizontal = 8.dp),
                    ) { Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.labelMedium) }
                }
                if (pair.size == 1) Spacer(Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun DochStaffSelect(options: List<DochSummaryRow>, selected: String, onSelect: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val label = if (selected == "all") "Všetci zamestnanci"
    else options.firstOrNull { it.staffId.toString() == selected }?.name ?: "Všetci zamestnanci"
    Box {
        OutlinedButton(
            onClick = { open = true },
            modifier = Modifier.fillMaxWidth().heightIn(min = 44.dp),
        ) {
            Text(label, modifier = Modifier.weight(1f), textAlign = TextAlign.Start, maxLines = 1,
                overflow = TextOverflow.Ellipsis)
            Text("▾")
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            DropdownMenuItem(text = { Text("Všetci zamestnanci") },
                onClick = { onSelect("all"); open = false })
            options.forEach { r ->
                DropdownMenuItem(text = { Text(r.name.ifBlank { "?" }) },
                    onClick = { onSelect(r.staffId.toString()); open = false })
            }
        }
    }
}

/* ---------------- All-time dlžoba panel ---------------- */

@Composable
private fun DochBalancePanel(b: DochBalanceResp) {
    val owed = b.totalOwed
    val prepaid = b.totalPrepaid
    val debtors = b.rows.filter { it.balance > 0.01 }.sortedByDescending { it.balance }
    val accent = if (owed > 0.01) Amber else Sage

    Surface(
        Modifier.fillMaxWidth().paperShadow(2.dp, RoundedCornerShape(14.dp)),
        shape = RoundedCornerShape(14.dp),
        color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, BorderSoft),
    ) {
        Row(Modifier.height(IntrinsicSize.Min)) {
            Box(Modifier.width(4.dp).fillMaxHeight().background(accent))
            Column(Modifier.padding(14.dp).fillMaxWidth()) {
                Row(verticalAlignment = Alignment.Top) {
                    Column(Modifier.weight(1f)) {
                        Text("💰 Celkovo dlhujem na výplatách", style = MaterialTheme.typography.titleSmall)
                        Text("za celé obdobie — odpracované hodiny mínus všetko vyplatené",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Text(dochFmtEur(owed), style = MaterialTheme.typography.titleLarge, color = accent)
                }
                Spacer(Modifier.height(10.dp))
                if (debtors.isEmpty()) {
                    Text("✓ Všetko vyplatené — nikomu nedlhuješ",
                        color = Sage, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                } else {
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        debtors.forEach { d ->
                            Surface(
                                Modifier.fillMaxWidth(), shape = RoundedCornerShape(8.dp),
                                color = MaterialTheme.colorScheme.surfaceVariant,
                                border = BorderStroke(1.dp, BorderSoft),
                            ) {
                                Row(Modifier.padding(horizontal = 12.dp, vertical = 7.dp),
                                    verticalAlignment = Alignment.CenterVertically) {
                                    Text(buildString {
                                        append(d.name.ifBlank { "?" })
                                        if (!d.active) append("  (neaktívny)")
                                    }, Modifier.weight(1f), fontWeight = FontWeight.SemiBold,
                                        style = MaterialTheme.typography.bodyMedium, maxLines = 1,
                                        overflow = TextOverflow.Ellipsis)
                                    Text(dochFmtEur(d.balance), color = Amber, fontWeight = FontWeight.Bold,
                                        style = MaterialTheme.typography.bodyMedium)
                                }
                            }
                        }
                    }
                }
                if (prepaid > 0.01) {
                    Spacer(Modifier.height(8.dp))
                    Text("ℹ️ Navyše máš predplatené (zálohy) ${dochFmtEur(prepaid)} — odrátajú sa z budúcich miezd.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

/* ---------------- KPI grid ---------------- */

@Composable
private fun DochKpiGrid(totals: DochTotals, from: String, to: String, openOnly: Boolean, onToggleOpen: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            StatCard("Spolu hodín", dochFmtMinutes(totals.totalMinutes), Modifier.weight(1f),
                accent = Navy, sub = "${totals.totalStaff} ${dochStaffWord(totals.totalStaff)}")
            StatCard("Mzda spolu", dochFmtEur(totals.totalWage), Modifier.weight(1f),
                accent = Terra, sub = "${totals.withRate} so sadzbou")
            StatCard("Aktívni", totals.totalStaff.toString(), Modifier.weight(1f),
                accent = Sage, sub = if (from == to) "dnes" else "$from → $to")
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            // Otvorené smeny — clickable filter toggle
            Surface(
                onClick = onToggleOpen,
                modifier = Modifier.weight(1f).paperShadow(2.dp, RoundedCornerShape(14.dp)),
                shape = RoundedCornerShape(14.dp),
                color = MaterialTheme.colorScheme.surface,
                border = BorderStroke(if (openOnly) 2.dp else 1.dp, if (openOnly) Amber else BorderSoft),
            ) {
                Column(Modifier.padding(horizontal = 14.dp, vertical = 12.dp)) {
                    Text(("Otvorené smeny" + if (openOnly) " (filter ON)" else "").uppercase(),
                        style = MaterialTheme.typography.labelSmall,
                        color = if (openOnly) Amber else MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.height(4.dp))
                    Text(totals.openShifts.toString(), style = MaterialTheme.typography.titleLarge,
                        color = if (totals.openShifts > 0) Amber else Sage, maxLines = 1)
                    Spacer(Modifier.height(2.dp))
                    Text(
                        when {
                            openOnly -> "Klik = vypnúť filter"
                            totals.openShifts > 0 -> "Klik = ukáž len týchto"
                            else -> "Všetko v poriadku"
                        },
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1,
                    )
                }
            }
            StatCard("Vyplatené", dochFmtEur(totals.totalPaid), Modifier.weight(1f),
                accent = if (totals.totalPaid > 0) Sage else EspressoDim,
                sub = if (totals.totalPaid > 0) "V tomto období" else "Nič nevyplatené")
            StatCard("Zostáva vyplatiť", dochFmtEur(maxOf(0.0, totals.totalOutstanding)), Modifier.weight(1f),
                accent = if (totals.totalOutstanding > 0.01) Amber else Sage,
                sub = if (totals.totalOutstanding > 0.01)
                    "${totals.outstandingPositive} ${dochPersonWord(totals.outstandingPositive)}"
                else "Všetko vyplatené ✓")
        }
    }
}

/* ---------------- Hlavná tabuľka ---------------- */

private val DOCH_COLS = listOf(
    "Meno" to 2.4f, "Pozícia" to 1.6f, "Sadzba" to 1.3f, "Hodín" to 1.2f,
    "Otv." to 0.9f, "Mzda" to 1.4f, "Vyplatené" to 1.5f, "Zostáva" to 1.7f, "" to 1.8f,
)

@Composable
private fun DochTableHeader() {
    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        DOCH_COLS.forEach { (label, w) ->
            Text(label.uppercase(), Modifier.weight(w),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
        }
    }
    HorizontalDivider(color = BorderSoft)
}

@Composable
private fun DochRow(
    row: DochSummaryRow,
    allRows: List<DochSummaryRow>,
    isOpen: Boolean,
    onPayout: () -> Unit,
    onToggle: () -> Unit,
) {
    AdminCard {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(row.name, Modifier.weight(DOCH_COLS[0].second), fontWeight = FontWeight.SemiBold,
                style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(row.position.ifBlank { "—" }, Modifier.weight(DOCH_COLS[1].second),
                style = MaterialTheme.typography.bodyMedium,
                color = if (row.position.isBlank()) EspressoDim else MaterialTheme.colorScheme.onSurface,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
            val rate = row.rateOrNull()
            Text(if (rate != null) "${dochFmtEur(rate)}/h" else "nie je", Modifier.weight(DOCH_COLS[2].second),
                style = MaterialTheme.typography.bodyMedium,
                color = if (rate != null) MaterialTheme.colorScheme.onSurface else EspressoDim, maxLines = 1)
            Text(dochFmtMinutes(row.minutes), Modifier.weight(DOCH_COLS[3].second),
                fontWeight = FontWeight.Bold, style = MaterialTheme.typography.bodyMedium, maxLines = 1)
            // Otvorené smeny
            Box(Modifier.weight(DOCH_COLS[4].second)) {
                if (row.openShifts > 0) StatusBadge(row.openShifts.toString(), Amber)
                else Text("0", color = EspressoDim, style = MaterialTheme.typography.bodyMedium)
            }
            // Mzda + overlap sub-note
            Column(Modifier.weight(DOCH_COLS[5].second)) {
                if (rate != null) {
                    Text(dochFmtEur(row.wage), style = MaterialTheme.typography.bodyMedium, maxLines = 1)
                    row.overlapInfo?.takeIf { it.minutes > 0 }?.let { ov ->
                        val partner = allRows.firstOrNull { it.staffId == ov.withStaffId }?.name ?: "partner"
                        Text("z toho ${dochFmtMinutes(ov.minutes)} @ ${dochFmtEur(ov.rate)} s $partner",
                            style = MaterialTheme.typography.labelSmall, color = EspressoDim, maxLines = 2)
                    }
                } else Text("—", color = EspressoDim, style = MaterialTheme.typography.bodyMedium)
            }
            // Vyplatené
            Column(Modifier.weight(DOCH_COLS[6].second)) {
                if (row.paidTotal > 0) {
                    Text(dochFmtEur(row.paidTotal), color = Sage, fontWeight = FontWeight.Bold,
                        style = MaterialTheme.typography.bodyMedium, maxLines = 1)
                    if (row.paidCount > 0) Text("${row.paidCount}x",
                        style = MaterialTheme.typography.labelSmall, color = EspressoDim)
                } else Text("—", color = EspressoDim, style = MaterialTheme.typography.bodyMedium)
            }
            // Zostáva
            Column(Modifier.weight(DOCH_COLS[7].second)) {
                val o = row.outstanding
                when {
                    kotlin.math.abs(o) < 0.01 -> Text("✓ Vyplatené", color = Sage,
                        fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.bodyMedium, maxLines = 1)
                    o > 0 -> {
                        Text(dochFmtEur(o), color = Amber, fontWeight = FontWeight.Bold,
                            style = MaterialTheme.typography.bodyMedium, maxLines = 1)
                        Text("⚠ treba vyplatiť", style = MaterialTheme.typography.labelSmall, color = EspressoDim)
                    }
                    else -> {
                        Text(dochFmtEur(kotlin.math.abs(o)), color = Navy, fontWeight = FontWeight.Bold,
                            style = MaterialTheme.typography.bodyMedium, maxLines = 1)
                        Text("ℹ️ záloha navyše", style = MaterialTheme.typography.labelSmall, color = EspressoDim)
                    }
                }
            }
            // Akcie
            Column(Modifier.weight(DOCH_COLS[8].second), horizontalAlignment = Alignment.End,
                verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Surface(onClick = onPayout, shape = RoundedCornerShape(8.dp),
                    color = Sage.copy(alpha = 0.10f), border = BorderStroke(1.dp, Sage.copy(alpha = 0.35f))) {
                    Text("Vyplatiť", Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                        color = Sage, style = MaterialTheme.typography.labelMedium)
                }
                Surface(onClick = onToggle, shape = RoundedCornerShape(8.dp),
                    color = MaterialTheme.colorScheme.surfaceVariant, border = BorderStroke(1.dp, BorderSoft)) {
                    Text(if (isOpen) "Skryť" else "Detail", Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                        style = MaterialTheme.typography.labelMedium)
                }
            }
        }
    }
}

/* ---------------- Detail (smeny + audit + manuálna úprava) ---------------- */

@Composable
private fun DochDetail(
    staffId: Int,
    parentRow: DochSummaryRow,
    loading: Boolean,
    error: String?,
    data: DochHistoryResp?,
    onRetry: () -> Unit,
    onPayShift: (eventId: Int, wage: Double) -> Unit,
    onUnpay: (payoutId: Int) -> Unit,
    onDeleteEvent: (eventId: Int) -> Unit,
    onAddEvent: (type: String, reason: String, atIso: String, note: String) -> Unit,
) {
    Surface(
        Modifier.fillMaxWidth().paperShadow(2.dp, RoundedCornerShape(14.dp)),
        shape = RoundedCornerShape(14.dp),
        color = MaterialTheme.colorScheme.surfaceVariant,
        border = BorderStroke(1.dp, BorderMid),
    ) {
        Column(Modifier.padding(14.dp)) {
            Text("Detail — ${data?.staff?.name ?: parentRow.name}", style = MaterialTheme.typography.titleSmall)
            Spacer(Modifier.height(8.dp))
            when {
                loading -> LoadingBox()
                error != null -> ErrorBox(error) { onRetry() }
                data == null -> EmptyHint("Bez dát.")
                else -> {
                    val summary = data.summary
                    val rate = parentRow.rateOrNull()
                    val eventsAsc = data.events
                    val shifts = dochBuildShifts(eventsAsc)
                    val completed = shifts.count { it.start != null && it.end != null }
                    val open = shifts.count { it.start != null && it.end == null }
                    val autoCount = data.events.count { it.source == "auto_close" }

                    // Súhrn riadok
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            if (summary.openShifts > 0) StatusBadge("${summary.openShifts} otvorená smena", Amber)
                            if (autoCount > 0) StatusBadge("$autoCount auto-zatvorené", Amber)
                        }
                        Text(buildString {
                            append("Hodín: ${dochFmtMinutes(summary.minutes)}  ·  ")
                            append("Mzda: ${dochFmtEur(summary.wage)}")
                            data.staff?.position?.takeIf { it.isNotBlank() }?.let { append("  ·  Pozícia: $it") }
                        }, style = MaterialTheme.typography.bodyMedium)
                    }

                    Spacer(Modifier.height(12.dp))
                    // Smeny
                    val shiftCountLabel = if (completed > 0 || open > 0)
                        " ($completed ${dochShiftWord(completed)}${if (open > 0) ", $open otvorená" else ""})" else ""
                    Text("Smeny$shiftCountLabel", style = MaterialTheme.typography.titleSmall)
                    Spacer(Modifier.height(6.dp))
                    DochShiftTableHeader()
                    if (shifts.isEmpty()) EmptyHint("Žiadne smeny v tomto období.")
                    shifts.asReversed().forEach { s ->
                        DochShiftRow(s, rate, onPayShift, onUnpay)
                    }

                    Spacer(Modifier.height(14.dp))
                    // Manuálna úprava záznamu
                    DochManualForm(onAddEvent)

                    Spacer(Modifier.height(14.dp))
                    // Audit
                    Text("Záznamy (audit)", style = MaterialTheme.typography.titleSmall)
                    Spacer(Modifier.height(6.dp))
                    DochAuditHeader()
                    val auditEvents = data.events.asReversed()  // newest first
                    if (auditEvents.isEmpty()) EmptyHint("Bez záznamov za toto obdobie.")
                    auditEvents.forEach { e -> DochAuditRow(e, onDeleteEvent) }
                }
            }
        }
    }
}

private val DOCH_SHIFT_COLS = listOf(
    "Dátum" to 1.5f, "Príchod" to 1f, "Odchod" to 1.2f, "Trvanie" to 1.1f,
    "Mzda" to 1.1f, "Vyplatené" to 2.2f, "Pozn." to 1.6f,
)

@Composable
private fun DochShiftTableHeader() {
    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        DOCH_SHIFT_COLS.forEach { (l, w) ->
            Text(l.uppercase(), Modifier.weight(w), style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
        }
    }
    HorizontalDivider(color = BorderSoft)
}

@Composable
private fun DochShiftRow(
    s: DochShift, rate: Double?,
    onPayShift: (eventId: Int, wage: Double) -> Unit,
    onUnpay: (payoutId: Int) -> Unit,
) {
    val refIso = s.start?.at ?: s.end?.at ?: ""
    val wage: Double? = if (s.minutes != null && rate != null && rate > 0) (s.minutes / 60.0) * rate else null
    Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(dochFmtDate(refIso), Modifier.weight(DOCH_SHIFT_COLS[0].second),
            style = MaterialTheme.typography.bodyMedium, maxLines = 1)
        Text(s.start?.let { dochFmtTime(it.at) } ?: "—", Modifier.weight(DOCH_SHIFT_COLS[1].second),
            style = MaterialTheme.typography.bodyMedium,
            color = if (s.start == null) EspressoDim else MaterialTheme.colorScheme.onSurface, maxLines = 1)
        Box(Modifier.weight(DOCH_SHIFT_COLS[2].second)) {
            if (s.end != null) Text(dochFmtTime(s.end.at), style = MaterialTheme.typography.bodyMedium, maxLines = 1)
            else StatusBadge("otvorená", Amber)
        }
        Text(s.minutes?.let { dochFmtMinutes(it) } ?: "—", Modifier.weight(DOCH_SHIFT_COLS[3].second),
            fontWeight = FontWeight.Bold, style = MaterialTheme.typography.bodyMedium,
            color = if (s.minutes == null) EspressoDim else MaterialTheme.colorScheme.onSurface, maxLines = 1)
        Text(wage?.let { dochFmtEur(it) } ?: "—", Modifier.weight(DOCH_SHIFT_COLS[4].second),
            style = MaterialTheme.typography.bodyMedium,
            color = if (wage == null) EspressoDim else MaterialTheme.colorScheme.onSurface, maxLines = 1)
        // Vyplatené pill/tlačidlo
        Box(Modifier.weight(DOCH_SHIFT_COLS[5].second)) {
            val end = s.end
            when {
                end?.id != null && end.id != 0 && end.paid != null -> {
                    Surface(onClick = { onUnpay(end.paid.id) }, shape = RoundedCornerShape(8.dp),
                        color = Sage.copy(alpha = 0.12f), border = BorderStroke(1.dp, Sage.copy(alpha = 0.35f))) {
                        Text("✓ Vyplatené ${dochFmtDate(end.paid.paidAt)}",
                            Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
                            color = Sage, style = MaterialTheme.typography.labelSmall, maxLines = 1)
                    }
                }
                end?.id != null && end.id != 0 && wage != null -> {
                    Surface(onClick = { onPayShift(end.id, wage) }, shape = RoundedCornerShape(8.dp),
                        color = MaterialTheme.colorScheme.surface, border = BorderStroke(1.dp, BorderMid)) {
                        Text("Označiť ako vyplatené", Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
                            style = MaterialTheme.typography.labelSmall, maxLines = 1)
                    }
                }
                end?.id != null && end.id != 0 -> Text("— (bez sadzby)", color = EspressoDim,
                    style = MaterialTheme.typography.labelSmall)
                else -> Text("—", color = EspressoDim, style = MaterialTheme.typography.bodyMedium)
            }
        }
        // Poznámkové flagy
        Column(Modifier.weight(DOCH_SHIFT_COLS[6].second), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            val flags = buildList {
                if (s.start?.source == "manual") add("manuál (in)")
                if (s.end?.source == "auto_close") add("auto-zatv")
                if (s.end?.source == "manual") add("manuál (out)")
            }
            if (flags.isEmpty()) Text("—", color = EspressoDim, style = MaterialTheme.typography.bodyMedium)
            else flags.forEach { StatusBadge(it, Amber) }
        }
    }
    HorizontalDivider(color = BorderSoft.copy(alpha = 0.5f))
}

private val DOCH_AUDIT_COLS = listOf(
    "Čas" to 2f, "Typ" to 1.2f, "Zdroj" to 1.6f, "Dôvod" to 1.6f, "Poznámka" to 2f, "" to 0.7f,
)

@Composable
private fun DochAuditHeader() {
    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        DOCH_AUDIT_COLS.forEach { (l, w) ->
            Text(l.uppercase(), Modifier.weight(w), style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
        }
    }
    HorizontalDivider(color = BorderSoft)
}

@Composable
private fun DochAuditRow(e: DochEvent, onDelete: (Int) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(dochFmtDateTime(e.at), Modifier.weight(DOCH_AUDIT_COLS[0].second),
            style = MaterialTheme.typography.bodyMedium, maxLines = 1)
        Box(Modifier.weight(DOCH_AUDIT_COLS[1].second)) {
            if (e.type == "clock_in") StatusBadge("Príchod", Sage) else StatusBadge("Odchod", Navy)
        }
        Box(Modifier.weight(DOCH_AUDIT_COLS[2].second)) {
            when (e.source) {
                "auto_close" -> StatusBadge("auto-zatvorené", Amber)
                "manual" -> StatusBadge("manuálne", Amber)
                else -> Text("PIN", color = EspressoDim, style = MaterialTheme.typography.bodyMedium)
            }
        }
        Text(if (e.reason != null) dochReasonLabel(e.reason) else "—", Modifier.weight(DOCH_AUDIT_COLS[3].second),
            color = EspressoDim, style = MaterialTheme.typography.bodyMedium, maxLines = 1)
        Text(e.note.ifBlank { "—" }, Modifier.weight(DOCH_AUDIT_COLS[4].second),
            color = if (e.note.isBlank()) EspressoDim else MaterialTheme.colorScheme.onSurface,
            style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Box(Modifier.weight(DOCH_AUDIT_COLS[5].second), contentAlignment = Alignment.CenterEnd) {
            Surface(onClick = { onDelete(e.id) }, shape = RoundedCornerShape(8.dp),
                color = Danger.copy(alpha = 0.08f), border = BorderStroke(1.dp, Danger.copy(alpha = 0.3f))) {
                Text("✕", Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
                    color = Danger, style = MaterialTheme.typography.labelMedium)
            }
        }
    }
    HorizontalDivider(color = BorderSoft.copy(alpha = 0.5f))
}

/* ---------------- Manuálna úprava záznamu (form) ---------------- */

@Composable
private fun DochManualForm(onAddEvent: (type: String, reason: String, atIso: String, note: String) -> Unit) {
    var show by remember { mutableStateOf(false) }
    var type by remember { mutableStateOf("clock_in") }
    var reason by remember { mutableStateOf("") }
    var dateStr by remember { mutableStateOf(LocalDate.now(BRATISLAVA).toString()) }
    var timeStr by remember { mutableStateOf(java.time.LocalTime.now(BRATISLAVA).format(DOCH_TIME)) }
    var note by remember { mutableStateOf("") }
    var localError by remember { mutableStateOf<String?>(null) }

    Surface(onClick = { show = !show }, color = Color_Transparent, shape = RoundedCornerShape(8.dp)) {
        Text((if (show) "− " else "+ ") + "Manuálna úprava záznamu",
            Modifier.padding(vertical = 6.dp),
            style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    if (!show) return

    Spacer(Modifier.height(8.dp))
    // Typ
    Text("Typ", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    Spacer(Modifier.height(4.dp))
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        DochSegment("Príchod", type == "clock_in", Modifier.weight(1f)) { type = "clock_in" }
        DochSegment("Odchod", type == "clock_out", Modifier.weight(1f)) { type = "clock_out" }
    }
    Spacer(Modifier.height(10.dp))
    // Dôvod
    Text("Dôvod", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    Spacer(Modifier.height(4.dp))
    DochReasonSelect(reason) { reason = it }
    Spacer(Modifier.height(10.dp))
    // Čas — dátum + čas vstupy
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        FormField("Dátum", dateStr, { dateStr = it }, Modifier.weight(1.4f), placeholder = "RRRR-MM-DD")
        FormField("Čas", timeStr, { timeStr = it }, Modifier.weight(1f), placeholder = "HH:MM",
            // Text klávesnica — numerická nemá dvojbodku, „HH:MM" by sa nedalo
            // dopísať po vymazaní poľa.
            keyboard = KeyboardOptions(keyboardType = KeyboardType.Text))
    }
    Spacer(Modifier.height(10.dp))
    FormField("Poznámka", note, { if (it.length <= 200) note = it }, placeholder = "napr. zabudol kliknúť")
    localError?.let {
        Spacer(Modifier.height(6.dp))
        Text(it, color = Danger, style = MaterialTheme.typography.bodySmall)
    }
    Spacer(Modifier.height(10.dp))
    Button(
        onClick = {
            val iso = dochToIso(dateStr, timeStr)
            when {
                iso == null -> localError = "Neplatný dátum alebo čas (RRRR-MM-DD a HH:MM)"
                reason.isBlank() -> localError = "Vyber dôvod úpravy"
                else -> {
                    localError = null
                    onAddEvent(type, reason, iso, note.trim())
                }
            }
        },
        colors = ButtonDefaults.buttonColors(containerColor = Terra, contentColor = Cream),
        modifier = Modifier.heightIn(min = 44.dp),
    ) { Text("Pridať záznam") }
}

@Composable
private fun DochSegment(label: String, active: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Surface(
        onClick = onClick, modifier = modifier.heightIn(min = 44.dp),
        shape = RoundedCornerShape(10.dp),
        color = if (active) Terra else MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, if (active) Terra else BorderSoft),
    ) {
        Box(Modifier.fillMaxWidth().padding(vertical = 10.dp), contentAlignment = Alignment.Center) {
            Text(label, color = if (active) Cream else MaterialTheme.colorScheme.onSurface,
                style = MaterialTheme.typography.labelMedium)
        }
    }
}

@Composable
private fun DochReasonSelect(selected: String, onSelect: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val label = if (selected.isBlank()) "— vyber —" else dochReasonLabel(selected)
    Box {
        OutlinedButton(onClick = { open = true }, modifier = Modifier.fillMaxWidth().heightIn(min = 44.dp)) {
            Text(label, Modifier.weight(1f), textAlign = TextAlign.Start,
                color = if (selected.isBlank()) EspressoDim else MaterialTheme.colorScheme.onSurface, maxLines = 1)
            Text("▾")
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            DOCH_REASONS.forEach { (key, lbl) ->
                DropdownMenuItem(text = { Text(lbl) }, onClick = { onSelect(key); open = false })
            }
        }
    }
}

/* ---------------- Unified payout dialóg ---------------- */

private data class DochPayoutReq(
    val staffId: Int,
    val staffName: String,
    val hourlyRate: Double,
    val mode: String,                  // "lump" | "shift"
    val shiftWage: Double = 0.0,
    val clockOutEventId: Int? = null,
)

@Composable
private fun DochPayoutDialog(
    req: DochPayoutReq,
    onDismiss: () -> Unit,
    onSubmitLump: (amount: Double, note: String) -> Unit,
    onSubmitShift: (eventId: Int, amount: Double, note: String) -> Unit,
) {
    val canShift = req.clockOutEventId != null
    var mode by remember { mutableStateOf(if (req.mode == "shift" && canShift) "shift" else "lump") }
    var amount by remember { mutableStateOf(if (req.mode == "shift") String.format("%.2f", req.shiftWage) else "") }
    var note by remember { mutableStateOf("") }
    var errorMsg by remember { mutableStateOf<String?>(null) }

    val amtVal = amount.replace(',', '.').toDoubleOrNull()
    val preview = if (amtVal != null && amtVal > 0 && req.hourlyRate > 0)
        "≈ ${String.format("%.1f", amtVal / req.hourlyRate)} hod pri sadzbe ${dochFmtEur(req.hourlyRate)}/h" else ""

    Dialog(onDismissRequest = onDismiss) {
        Surface(shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surface,
            modifier = Modifier.fillMaxWidth().paperShadow(14.dp, RoundedCornerShape(16.dp))) {
            Column(Modifier.padding(20.dp).verticalScroll(rememberScrollState())) {
                Text("💸 Vyplatiť ${req.staffName}", style = MaterialTheme.typography.titleMedium)
                Spacer(Modifier.height(14.dp))

                // Mode toggle
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    DochSegment("Rozhoď FIFO", mode == "lump", Modifier.weight(1f)) { mode = "lump" }
                    if (canShift) DochSegment("Konkrétna smena", mode == "shift", Modifier.weight(1f)) { mode = "shift" }
                }
                Spacer(Modifier.height(10.dp))
                Text(
                    if (mode == "lump") "Suma sa rozhodí cez najstaršie nezaplatené smeny FIFO. Posledná smena môže byť čiastočne pokrytá."
                    else "Pripočíta sa k tejto jednej smene. Default = celá mzda smeny.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                Spacer(Modifier.height(12.dp))
                // Quick chips
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (mode == "lump") {
                        listOf(50, 100, 200, 500).forEach { v ->
                            DochChip("$v €", Modifier.weight(1f)) { amount = v.toString(); errorMsg = null }
                        }
                    } else {
                        DochChip("Celé (${dochFmtEur(req.shiftWage)})", Modifier.weight(1.4f)) {
                            amount = String.format("%.2f", req.shiftWage); errorMsg = null
                        }
                        DochChip("Polovica", Modifier.weight(1f)) {
                            amount = String.format("%.2f", req.shiftWage / 2); errorMsg = null
                        }
                        DochChip("Iné", Modifier.weight(1f)) { amount = ""; errorMsg = null }
                    }
                }

                Spacer(Modifier.height(12.dp))
                FormField("Suma", amount, { amount = it; errorMsg = null }, suffix = "€",
                    placeholder = "0,00",
                    keyboard = KeyboardOptions(keyboardType = KeyboardType.Decimal))
                Spacer(Modifier.height(10.dp))
                FormField("Poznámka (voliteľné)", note, { if (it.length <= 200) note = it },
                    placeholder = "napr. záloha za máj, bonus…")

                if (preview.isNotBlank()) {
                    Spacer(Modifier.height(6.dp))
                    Text(preview, style = MaterialTheme.typography.labelSmall, color = EspressoDim)
                }
                errorMsg?.let {
                    Spacer(Modifier.height(6.dp))
                    Text(it, color = Danger, style = MaterialTheme.typography.bodySmall)
                }

                Spacer(Modifier.height(18.dp))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = onDismiss, Modifier.weight(1f)) { Text("Zrušiť") }
                    Button(
                        onClick = {
                            val v = amount.replace(',', '.').toDoubleOrNull()
                            when {
                                v == null || v <= 0 -> errorMsg = "Suma musí byť kladná"
                                v > 10000 -> errorMsg = "Suma > 10 000 €, over zadanie"
                                else -> {
                                    val rounded = Math.round(v * 100) / 100.0
                                    if (mode == "lump") onSubmitLump(rounded, note)
                                    else req.clockOutEventId?.let { onSubmitShift(it, rounded, note) }
                                }
                            }
                        },
                        modifier = Modifier.weight(1f),
                        colors = ButtonDefaults.buttonColors(containerColor = Sage, contentColor = Cream),
                    ) { Text("Vyplatiť") }
                }
            }
        }
    }
}

@Composable
private fun DochChip(label: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Surface(onClick = onClick, modifier = modifier.heightIn(min = 40.dp), shape = RoundedCornerShape(8.dp),
        color = MaterialTheme.colorScheme.surfaceVariant, border = BorderStroke(1.dp, BorderSoft)) {
        Box(Modifier.fillMaxWidth().padding(vertical = 8.dp), contentAlignment = Alignment.Center) {
            Text(label, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/* ---------------- Confirm req ---------------- */

private data class DochConfirmReq(
    val title: String,
    val text: String,
    val confirmLabel: String,
    val onConfirm: () -> Unit,
)

/* ---------------- Util: dátum/čas → ISO, CSV uloženie ---------------- */

/** "2026-06-07" + "14:30" (lokálny Europe/Bratislava) → ISO UTC instant. */
private fun dochToIso(dateStr: String, timeStr: String): String? {
    return try {
        val d = LocalDate.parse(dateStr.trim())
        val tParts = timeStr.trim().split(":")
        if (tParts.size < 2) return null
        val h = tParts[0].toInt(); val m = tParts[1].toInt()
        if (h !in 0..23 || m !in 0..59) return null
        d.atTime(h, m).atZone(BRATISLAVA).toInstant().toString()
    } catch (_: Exception) { null }
}

/** Uloží CSV do Downloads (UTF-8 BOM). Vráti čitateľnú cestu, alebo null. */
private fun dochSaveCsv(ctx: android.content.Context, csv: String, fileName: String): String? {
    val bytes = ("﻿$csv").toByteArray(Charsets.UTF_8)
    return try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, fileName)
                put(MediaStore.Downloads.MIME_TYPE, "text/csv")
                put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
            }
            val uri = ctx.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return null
            ctx.contentResolver.openOutputStream(uri)?.use { it.write(bytes) } ?: return null
            "Stiahnuté/$fileName"
        } else {
            val dir = ctx.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: ctx.filesDir
            val f = java.io.File(dir, fileName)
            f.writeBytes(bytes)
            f.absolutePath
        }
    } catch (_: Exception) { null }
}

private val Color_Transparent = androidx.compose.ui.graphics.Color.Transparent
