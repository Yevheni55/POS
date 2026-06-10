package sk.surfspirit.pos.ui.admin.pages

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import retrofit2.http.GET
import retrofit2.http.Query
import sk.surfspirit.pos.core.errorMessage
import sk.surfspirit.pos.core.httpCode
import sk.surfspirit.pos.core.money
import sk.surfspirit.pos.net.Api
import sk.surfspirit.pos.ui.admin.*
import sk.surfspirit.pos.ui.theme.*
import java.time.DayOfWeek
import java.time.LocalDate
import java.util.Locale

/* =====================================================================
   Reporty / Trendy — natívna obrazovka so záložkami Týždeň | Sezóna.
   Zrkadlí admin/pages/weekly.js + season.js. Všetky čísla zo servera
   sú JS numbers (roundMoney) → DTO polia sú Double.
   ===================================================================== */

/* ---------- DTOs (prefix Rt = ReportsTrends) ---------- */

@Serializable private data class RtPeriod(val from: String = "", val to: String = "")

@Serializable private data class RtHour(
    val hour: Int = 0,
    val kitchenRevenue: Double = 0.0,
    val kitchenCogs: Double = 0.0,
    val kitchenWage: Double = 0.0,
    val kitchenProfit: Double = 0.0,
    val kitchenNetProfit: Double = 0.0,
    val barRevenue: Double = 0.0,
    val totalRevenue: Double = 0.0,
    val kitchenItems: Int = 0,
    val barItems: Int = 0,
    val orders: Int = 0,
    val cookMinutes: Double = 0.0,
    val cookHours: Double = 0.0,
)

@Serializable private data class RtCook(
    val staffId: Int = 0,
    val name: String = "",
    val position: String = "",
    val hourlyRate: Double = 0.0,
    val minutes: Double = 0.0,
    val hours: Double = 0.0,
    val kitchenRevenue: Double = 0.0,
    val kitchenCogs: Double = 0.0,
    val kitchenProfit: Double = 0.0,
    val wage: Double = 0.0,
    val netProfit: Double = 0.0,
    val netMarginPct: Double = 0.0,
)

@Serializable private data class RtDailyHours(
    val date: String = "",
    val weekday: Int = 0,
    val kitchenRevenue: Double = 0.0,
    val kitchenCogs: Double = 0.0,
    val kitchenProfit: Double = 0.0,
    val barRevenue: Double = 0.0,
    val totalRevenue: Double = 0.0,
    val orders: Int = 0,
    val hours: List<RtHour> = emptyList(),
)

@Serializable private data class RtTotals(
    val kitchenRevenue: Double = 0.0,
    val kitchenCogs: Double = 0.0,
    val kitchenProfit: Double = 0.0,
    val kitchenWage: Double = 0.0,
    val kitchenNetProfit: Double = 0.0,
    val kitchenNetMarginPct: Double = 0.0,
    val barRevenue: Double = 0.0,
    val cookHours: Double = 0.0,
)

@Serializable private data class RtWeeklyResp(
    val period: RtPeriod = RtPeriod(),
    val byHour: List<RtHour> = emptyList(),
    val cooks: List<RtCook> = emptyList(),
    val dailyHours: List<RtDailyHours> = emptyList(),
    val noKitchenStaff: Boolean = false,
    val totals: RtTotals = RtTotals(),
)

@Serializable private data class RtDaily(
    val date: String = "",
    val revenue: Double = 0.0,
    val orders: Int = 0,
    val avgCheck: Double = 0.0,
    val cogs: Double = 0.0,
    val labor: Double = 0.0,
    val profit: Double = 0.0,
)

@Serializable private data class RtProduct(
    val name: String = "",
    val emoji: String = "",
    val category: String = "",
    val qty: Int = 0,
    val revenue: Double = 0.0,
    val cogs: Double = 0.0,
    val profit: Double = 0.0,
)

@Serializable private data class RtRevenueByDest(
    val bar: Double = 0.0,
    val kuchyna: Double = 0.0,
    val itemsBar: Int = 0,
    val itemsKuchyna: Int = 0,
)

@Serializable private data class RtSummaryResp(
    val totalRevenue: Double = 0.0,
    val totalCogs: Double = 0.0,
    val totalLabor: Double = 0.0,
    val totalProfit: Double = 0.0,
    val totalOrders: Int = 0,
    val daily: List<RtDaily> = emptyList(),
    val products: List<RtProduct> = emptyList(),
    val revenueByDest: RtRevenueByDest = RtRevenueByDest(),
)

/* ---------- Retrofit interface ---------- */

private interface RtApi {
    @GET("api/reports/weekly")
    suspend fun weekly(@Query("from") from: String, @Query("to") to: String): RtWeeklyResp

    @GET("api/reports/summary")
    suspend fun summary(@Query("from") from: String, @Query("to") to: String): RtSummaryResp
}

private val rtApi: RtApi by lazy { Api.create(RtApi::class.java) }

/* ---------- Konštanty / helpers ---------- */

private const val RT_SEASON_START = "2026-04-25"   // sezóna od otvorenia (web SEASON_START)

private val RT_DOW_FULL = mapOf(
    1 to "Pondelok", 2 to "Utorok", 3 to "Streda", 4 to "Štvrtok",
    5 to "Piatok", 6 to "Sobota", 7 to "Nedeľa",
)
private val RT_DOW_SHORT = mapOf(
    1 to "Po", 2 to "Ut", 3 to "St", 4 to "Št", 5 to "Pi", 6 to "So", 7 to "Ne",
)
private val RT_MONTH_FULL = listOf(
    "januára", "februára", "marca", "apríla", "mája", "júna",
    "júla", "augusta", "septembra", "októbra", "novembra", "decembra",
)

/** "+12,50 €" / "-3,20 €" so znamienkom (zhoda s web profit zápisom). */
private fun rtSigned(v: Double): String = (if (v >= 0) "+" else "") + money(v)

private fun rtProfitColor(v: Double): Color = if (v >= 0) Sage else Danger

/** Minúty → "Xh MMm" (web fmtHours). Zaokrúhli RAZ na celé minúty hneď na
 *  vstupe — zaokrúhlenie až po delení dávalo „1h 60m" (napr. 119,6 min). */
private fun rtHours(minutes: Double): String {
    val total = Math.round(minutes.coerceAtLeast(0.0))
    val h = total / 60
    val m = total % 60
    return "${h}h ${m.toString().padStart(2, '0')}m"
}

/** "12,3 %" — 1 desatinné. */
private fun rtPct1(v: Double): String = String.format(Locale.US, "%.1f", v).replace('.', ',') + " %"

/** "12 %" — 0 desatinných (kategória/produkt marža). */
private fun rtPct0(v: Double): String = "${Math.round(v)} %"

/** "1 234" — celé číslo so sk-SK oddeľovačom tisícov. */
private fun rtInt(v: Int): String = String.format(Locale("sk", "SK"), "%,d", v)

/** Bez meny, 0 desatín — pre os hodnoty grafu (web fmtNumNoEur). */
private fun rtNoEur0(v: Double): String = rtInt(Math.round(v).toInt())

/** ISO dátum z LocalDate. */
private fun LocalDate.iso(): String = this.toString()

/** "dd.mm." z ISO. */
private fun rtDateDM(iso: String): String {
    val p = iso.split("-")
    return if (p.size == 3) "${p[2].trimStart('0').ifEmpty { "0" }}.${p[1].trimStart('0').ifEmpty { "0" }}." else iso
}

/** "dd.mm.yyyy" z ISO (web formatDateSk). */
private fun rtDateDMY(iso: String): String {
    val p = iso.split("-")
    return if (p.size == 3) "${p[2]}.${p[1]}.${p[0]}" else iso
}

/** Plný SK dátum: "25. apríla 2026". */
private fun rtFullDate(iso: String): String = try {
    val d = LocalDate.parse(iso)
    "${d.dayOfMonth}. ${RT_MONTH_FULL[d.monthValue - 1]} ${d.year}"
} catch (_: Exception) { iso }

/** ISO weekday (Po=1..Ne=7) z ISO dátumu. */
private fun rtWeekday(iso: String): Int = try {
    LocalDate.parse(iso).dayOfWeek.value
} catch (_: Exception) { 1 }

/* =====================================================================
   Top-level composable
   ===================================================================== */

@Composable
fun ReportsTrendsScreen() {
    var tab by remember { mutableStateOf(0) }   // 0 = Týždeň, 1 = Sezóna

    AdminScreenBox {
        AdminSectionTitle("Reporty / Trendy")
        PillTabs(listOf("Týždeň", "Sezóna"), tab) { tab = it }
        Spacer(Modifier.height(14.dp))
        when (tab) {
            0 -> RtWeeklyTab()
            else -> RtSeasonTab()
        }
    }
}

/* =====================================================================
   TÝŽDEŇ
   ===================================================================== */

@Composable
private fun RtWeeklyTab() {
    val scope = rememberCoroutineScope()
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var data by remember { mutableStateOf<RtWeeklyResp?>(null) }

    // ISO týždeň: pondelok–nedeľa relatívne k dnešku, posúvaný o ±7 dní.
    fun thisMonday(): LocalDate = LocalDate.now().with(DayOfWeek.MONDAY)
    var from by remember { mutableStateOf(thisMonday()) }
    var to by remember { mutableStateOf(thisMonday().plusDays(6)) }
    var selectedDay by remember { mutableStateOf<String?>(null) }

    // Monotónne ID requestu — rýchle ‹/› klikanie nesmie nechať vyhrať
    // pomalšiu staršiu odpoveď nad výsledkom posledného týždňa.
    val loadSeq = remember { java.util.concurrent.atomic.AtomicInteger(0) }

    fun load() {
        val seq = loadSeq.incrementAndGet()
        scope.launch {
            loading = true
            try {
                val resp = withContext(Dispatchers.IO) { rtApi.weekly(from.iso(), to.iso()) }
                if (seq != loadSeq.get()) return@launch   // medzitým odišiel novší request
                data = resp
                // Auto-select dnešok, inak posledný deň s dátami (web parita).
                val days = resp.dailyHours
                val todayIso = LocalDate.now().iso()
                selectedDay = days.firstOrNull { it.date == todayIso }?.date
                    ?: days.lastOrNull()?.date
                error = null
            } catch (e: Exception) {
                if (seq != loadSeq.get()) return@launch
                if (e.httpCode() == 401) { /* auth shell rieši inde */ }
                error = errorMessage(e)
            } finally {
                if (seq == loadSeq.get()) loading = false
            }
        }
    }

    LaunchedEffect(from) { load() }

    // Filter bar — week navigácia
    DateNav(
        label = "${rtDateDM(from.iso())} – ${rtDateDM(to.iso())}",
        onPrev = { from = from.minusDays(7); to = to.minusDays(7) },
        onNext = { from = from.plusDays(7); to = to.plusDays(7) },
        onToday = { from = thisMonday(); to = thisMonday().plusDays(6) },
    )
    Spacer(Modifier.height(14.dp))

    when {
        loading -> LoadingBox()
        error != null -> ErrorBox(error!!) { load() }
        else -> {
            val d = data ?: return
            RtWeeklyContent(d, selectedDay) { selectedDay = it }
        }
    }
}

@Composable
private fun RtWeeklyContent(d: RtWeeklyResp, selectedDay: String?, onSelectDay: (String) -> Unit) {
    val t = d.totals
    val totalRev = t.kitchenRevenue + t.barRevenue
    val kitchenPct = if (totalRev > 0) t.kitchenRevenue / totalRev * 100 else 0.0
    val peakKitchen = d.byHour.maxByOrNull { it.kitchenRevenue }
    val cookCount = d.cooks.size

    // 4 stat karty (web tier)
    RtStatGrid(
        StatSpec("Tržby týždňa", money(totalRev), Terra, "${rtPct1(kitchenPct)} z kuchyne"),
        StatSpec(
            "Tržby kuchyne", money(t.kitchenRevenue), Sage,
            if (peakKitchen != null && peakKitchen.kitchenRevenue > 0)
                "peak ${peakKitchen.hour.toString().padStart(2, '0')}:00" else "—",
        ),
        StatSpec(
            "Hodiny v kuchyni", rtHours(t.cookHours * 60), Navy,
            "$cookCount ${if (cookCount == 1) "osoba" else "os."}",
        ),
        StatSpec(
            "Zisk kuchyne", rtSigned(t.kitchenNetProfit), rtProfitColor(t.kitchenNetProfit),
            "tržby ${money(t.kitchenRevenue)} − suroviny ${money(t.kitchenCogs)} − mzdy ${money(t.kitchenWage)} · marža ${rtPct1(t.kitchenNetMarginPct)}",
        ),
    )

    if (d.noKitchenStaff) {
        Spacer(Modifier.height(12.dp))
        RtWarningPanel(
            title = "Žiadny zamestnanec s pozíciou „kuchár\"",
            text = "Pre presnú efektivitu kuchára nastav v admin → Zamestnanci → pozícia text obsahujúci „kuchár\"/„cook\"/„chef\". Teraz počítam s celým personálom.",
        )
    }

    // Predaj podľa hodín — stĺpcový graf (zjednodušený stacked → totalRevenue)
    Spacer(Modifier.height(16.dp))
    AdminCard {
        Text("Predaj podľa hodín", style = MaterialTheme.typography.titleSmall)
        Text("stĺpce ukazujú tržby bar + kuchyňa za hodinu dňa",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(10.dp))
        if (d.byHour.isEmpty()) {
            EmptyHint("Žiadne dáta")
        } else {
            BarChart(
                values = d.byHour.map { it.totalRevenue },
                labels = d.byHour.map { it.hour.toString().padStart(2, '0') },
                barColor = Terra,
                height = 160,
            )
        }
    }

    // Zaťaženosť kuchyne — heatmap zjednodušený na priemer kuchynských tržieb / hodinu
    Spacer(Modifier.height(16.dp))
    AdminCard {
        Text("Zaťaženosť kuchyne", style = MaterialTheme.typography.titleSmall)
        Text("priemerné kuchynské tržby podľa hodiny dňa (cez všetky dni)",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(10.dp))
        // Priemer per hour = súčet kuchynských tržieb v danej hodine / počet dní s aktivitou v tom istom slote.
        val activeDays = d.dailyHours.count { it.totalRevenue > 0 }.coerceAtLeast(1)
        val hoursWithKitchen = d.byHour.filter { it.kitchenRevenue > 0 }
        if (hoursWithKitchen.isEmpty()) {
            EmptyHint("Žiadne kuchynské tržby v období")
        } else {
            BarChart(
                values = hoursWithKitchen.map { it.kitchenRevenue / activeDays },
                labels = hoursWithKitchen.map { it.hour.toString().padStart(2, '0') },
                barColor = Sage,
                height = 140,
            )
        }
    }

    // Zisk kuchyne podľa kuchára — tabuľka
    Spacer(Modifier.height(16.dp))
    AdminCard {
        Text("Zisk kuchyne podľa kuchára", style = MaterialTheme.typography.titleSmall)
        Text("tržby − suroviny − mzda = čistý zisk z kuchyne pripočítaný kuchárovi",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(8.dp))
        if (d.cooks.isEmpty()) {
            EmptyHint("Žiadne smeny v týždni")
        } else {
            TableHeader(
                "Meno" to 2.2f, "Hodiny" to 1.3f, "Tržby" to 1.5f,
                "Mzda" to 1.3f, "Čistý zisk" to 1.6f, "Marža" to 1f,
            )
            d.cooks.forEach { c ->
                TableRow(
                    cells = listOf(
                        c.name to 2.2f,
                        rtHours(c.minutes) to 1.3f,
                        money(c.kitchenRevenue) to 1.5f,
                        money(c.wage) to 1.3f,
                        rtSigned(c.netProfit) to 1.6f,
                        rtPct1(c.netMarginPct) to 1f,
                    ),
                    cellColors = listOf(
                        null, null, null, EspressoSoft,
                        rtProfitColor(c.netProfit), rtProfitColor(c.netProfit),
                    ),
                )
            }
        }
    }

    // Detail dňa — chips + per-day detail
    Spacer(Modifier.height(16.dp))
    AdminCard {
        Text("Detail dňa", style = MaterialTheme.typography.titleSmall)
        Text("vyber deň → hodinová štatistika tržieb a zisku kuchyne",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(10.dp))
        if (d.dailyHours.isEmpty()) {
            EmptyHint("Žiadne dni s dátami v tomto týždni")
        } else {
            RtDayTabs(d.dailyHours, selectedDay, onSelectDay)
            Spacer(Modifier.height(14.dp))
            val day = d.dailyHours.firstOrNull { it.date == selectedDay }
            if (day != null) RtDayDetail(day)
        }
    }
}

/** Day chip row — DOW, dátum, tržby (alebo — ak prázdny). */
@Composable
private fun RtDayTabs(days: List<RtDailyHours>, selected: String?, onSelect: (String) -> Unit) {
    Row(Modifier.horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        days.forEach { day ->
            val active = day.date == selected
            val hasData = day.totalRevenue > 0
            Surface(
                onClick = { onSelect(day.date) },
                shape = RoundedCornerShape(Radius.sm),
                color = if (active) Terra.copy(alpha = 0.10f) else MaterialTheme.colorScheme.surface,
                border = BorderStroke(1.dp, if (active) Terra else BorderSoft),
            ) {
                Column(Modifier.padding(horizontal = 14.dp, vertical = 10.dp).widthIn(min = 78.dp)) {
                    Text((RT_DOW_SHORT[day.weekday] ?: "?").uppercase(),
                        style = MaterialTheme.typography.labelSmall,
                        color = if (active) Terra else MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(rtDateDM(day.date), style = MaterialTheme.typography.titleSmall,
                        color = if (active) Terra else MaterialTheme.colorScheme.onSurface)
                    Spacer(Modifier.height(4.dp))
                    Text(
                        if (hasData) money(day.totalRevenue) else "—",
                        style = MaterialTheme.typography.bodySmall,
                        color = if (hasData) MaterialTheme.colorScheme.onSurface else EspressoDim,
                    )
                }
            }
        }
    }
}

@Composable
private fun RtDayDetail(day: RtDailyHours) {
    val filtered = day.hours.filter { it.totalRevenue > 0 || it.cookMinutes > 0 }
    Column {
        Text(RT_DOW_FULL[day.weekday] ?: "", style = MaterialTheme.typography.titleSmall)
        Text(rtFullDate(day.date), style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(12.dp))

        if (filtered.isEmpty()) {
            EmptyHint("V tento deň nebola žiadna aktivita.")
            return@Column
        }

        val dayCookMinutes = filtered.sumOf { it.cookMinutes }
        val dayKitchenWage = filtered.sumOf { it.kitchenWage }
        val dayNetProfit = filtered.sumOf { it.kitchenNetProfit }
        val dayOrders = filtered.sumOf { it.orders }
        val dayItemsKitchen = filtered.sumOf { it.kitchenItems }
        val dayMargin = if (day.kitchenRevenue > 0) dayNetProfit / day.kitchenRevenue * 100 else 0.0
        val peakHour = filtered.maxByOrNull { it.totalRevenue }

        RtStatGrid(
            StatSpec(
                "Tržby dňa", money(day.totalRevenue), Terra,
                "${rtInt(dayOrders)} obj." + (peakHour?.let { " · peak ${it.hour.toString().padStart(2, '0')}:00" } ?: ""),
            ),
            StatSpec(
                "Tržby kuchyne", money(day.kitchenRevenue), Sage,
                "${rtInt(dayItemsKitchen)} ks · suroviny ${money(day.kitchenCogs)}",
            ),
            StatSpec("Hodiny v kuchyni", rtHours(dayCookMinutes), Navy, "mzda ${money(dayKitchenWage)}"),
            StatSpec("Zisk kuchyne", rtSigned(dayNetProfit), rtProfitColor(dayNetProfit),
                "marža ${rtPct1(dayMargin)}"),
        )

        Spacer(Modifier.height(14.dp))
        TableHeader(
            "Hodina" to 1.1f, "Obj." to 0.7f, "Bar" to 1.2f, "Kuch." to 1.3f,
            "Suroviny" to 1.2f, "Mzdy" to 1.1f, "Zisk kuch." to 1.5f,
        )
        filtered.forEach { h ->
            val np = h.kitchenNetProfit
            TableRow(
                cells = listOf(
                    "${h.hour.toString().padStart(2, '0')}:00" to 1.1f,
                    rtInt(h.orders) to 0.7f,
                    (if (h.barRevenue > 0) money(h.barRevenue) else "—") to 1.2f,
                    (if (h.kitchenRevenue > 0) money(h.kitchenRevenue) else "—") to 1.3f,
                    (if (h.kitchenCogs > 0) money(h.kitchenCogs) else "—") to 1.2f,
                    (if (h.kitchenWage > 0) money(h.kitchenWage) else "—") to 1.1f,
                    (if (h.kitchenRevenue > 0) rtSigned(np) else "—") to 1.5f,
                ),
                cellColors = listOf(
                    null, null, null, null, EspressoSoft, EspressoSoft,
                    if (h.kitchenRevenue > 0) rtProfitColor(np) else EspressoDim,
                ),
            )
        }
        // Spolu footer
        RtFooterRow(
            cells = listOf(
                "Spolu" to 1.1f,
                rtInt(dayOrders) to 0.7f,
                money(day.barRevenue) to 1.2f,
                money(day.kitchenRevenue) to 1.3f,
                money(day.kitchenCogs) to 1.2f,
                money(dayKitchenWage) to 1.1f,
                rtSigned(dayNetProfit) to 1.5f,
            ),
            cellColors = listOf(
                null, null, null, null, EspressoSoft, EspressoSoft, rtProfitColor(dayNetProfit),
            ),
        )
    }
}

/* =====================================================================
   SEZÓNA
   ===================================================================== */

@Composable
private fun RtSeasonTab() {
    val scope = rememberCoroutineScope()
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var data by remember { mutableStateOf<RtSummaryResp?>(null) }
    val today = remember { LocalDate.now().iso() }

    fun load() {
        scope.launch {
            loading = true
            try {
                data = withContext(Dispatchers.IO) { rtApi.summary(RT_SEASON_START, today) }
                error = null
            } catch (e: Exception) {
                if (e.httpCode() == 401) { /* auth shell rieši inde */ }
                error = errorMessage(e)
            } finally {
                loading = false
            }
        }
    }

    LaunchedEffect(Unit) { load() }

    when {
        loading -> LoadingBox()
        error != null -> ErrorBox(error!!) { load() }
        else -> RtSeasonContent(data ?: return, today)
    }
}

@Composable
private fun RtSeasonContent(d: RtSummaryResp, today: String) {
    val trzba = d.totalRevenue
    val cogs = d.totalCogs
    val mzdy = d.totalLabor
    val vysledok = d.totalProfit
    val vysledokPct = if (trzba > 0) vysledok / trzba * 100 else 0.0
    val daysActual = d.daily.count { it.revenue > 0 }
    val days = run {
        val start = try { LocalDate.parse(RT_SEASON_START) } catch (_: Exception) { LocalDate.now() }
        val end = try { LocalDate.parse(today) } catch (_: Exception) { LocalDate.now() }
        (java.time.temporal.ChronoUnit.DAYS.between(start, end) + 1).coerceAtLeast(1)
    }
    val avgDaily = if (daysActual > 0) trzba / daysActual else 0.0

    // Filter bar — statická perióda info
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        StatusBadge("Sezóna", Terra)
        Spacer(Modifier.weight(1f))
        Text(
            "${rtDateDMY(RT_SEASON_START)} – ${rtDateDMY(today)} · $daysActual/$days aktívnych dní",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.End,
        )
    }
    Spacer(Modifier.height(14.dp))

    // 4 stat karty
    RtStatGrid(
        StatSpec("Celkové tržby", money(trzba), Terra,
            "${money(avgDaily)} priemer/deň · ${rtInt(d.totalOrders)} obj."),
        StatSpec("Náklady na výrobu", money(cogs), Amber,
            if (trzba > 0) "${rtPct1(cogs / trzba * 100)} z tržieb" else "—"),
        StatSpec("Mzdy", money(mzdy), Navy,
            if (trzba > 0) "${rtPct1(mzdy / trzba * 100)} z tržieb" else "—"),
        StatSpec("Výsledok", rtSigned(vysledok), rtProfitColor(vysledok),
            "${rtPct1(vysledokPct)} marža"),
    )

    // Predaj podľa kategórie — klientská agregácia products[] po category
    Spacer(Modifier.height(16.dp))
    AdminCard {
        Text("Predaj podľa kategórie", style = MaterialTheme.typography.titleSmall)
        Text("koľko kusov a koľko tržieb dostal každý druh tovaru za sezónu",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(8.dp))
        RtCategoryBreakdown(d.products, trzba)
    }

    // Tržby po dňoch — denný stĺpcový graf
    Spacer(Modifier.height(16.dp))
    AdminCard {
        Text("Tržby po dňoch", style = MaterialTheme.typography.titleSmall)
        Spacer(Modifier.height(10.dp))
        if (d.daily.isEmpty()) {
            EmptyHint("Žiadne dni")
        } else {
            // Labels = deň v mesiaci (každý N-tý ak je veľa dní — graf labely sa delia rovnomerne).
            val step = (d.daily.size / 12).coerceAtLeast(1)
            BarChart(
                values = d.daily.map { it.revenue },
                labels = d.daily.mapIndexed { i, day ->
                    if (i % step == 0) rtDateDM(day.date).trimEnd('.') else ""
                },
                barColor = Terra,
                height = 170,
            )
        }
    }

    // Najlepší / najslabší deň
    val sorted = d.daily.sortedByDescending { it.revenue }
    val best = sorted.firstOrNull()
    val worst = d.daily.filter { it.revenue > 0 }.minByOrNull { it.revenue }
    if (best != null) {
        Spacer(Modifier.height(16.dp))
        RtDayCard(best, "Najlepší deň", Sage)
    }
    if (worst != null && worst.date != best?.date) {
        Spacer(Modifier.height(12.dp))
        RtDayCard(worst, "Najslabší deň", Danger)
    }

    // Top 10 produktov
    Spacer(Modifier.height(16.dp))
    AdminCard {
        Text("Top 10 produktov", style = MaterialTheme.typography.titleSmall)
        Text("podľa tržieb za sezónu", style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(8.dp))
        val top = d.products.take(10)
        if (top.isEmpty()) {
            EmptyHint("Žiadne produkty")
        } else {
            TableHeader("#" to 0.5f, "Produkt" to 3f, "Ks" to 1f, "Tržby" to 1.5f, "Marža" to 1f)
            top.forEachIndexed { i, p ->
                val margin = if (p.revenue > 0) p.profit / p.revenue * 100 else 0.0
                val rankColor = when (i) {
                    0 -> Terra
                    1 -> EspressoSoft
                    2 -> Color(0xB3CD7F32)   // bronz (rgba(205,127,50,.7))
                    else -> null
                }
                TableRow(
                    cells = listOf(
                        "${i + 1}" to 0.5f,
                        ("${p.emoji} ${p.name}".trim()) to 3f,
                        rtInt(p.qty) to 1f,
                        money(p.revenue) to 1.5f,
                        (if (p.cogs > 0) rtPct0(margin) else "—") to 1f,
                    ),
                    cellColors = listOf(rankColor, null, null, null, EspressoDim),
                )
            }
        }
    }

    // Bar vs Kuchyňa
    Spacer(Modifier.height(16.dp))
    AdminCard {
        Text("Bar vs Kuchyňa", style = MaterialTheme.typography.titleSmall)
        Text("distribúcia tržieb", style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(10.dp))
        RtDestSplit(d.revenueByDest)
    }

    // Deň v týždni — priemer tržieb (zjednodušený heatmap → karty/bar)
    Spacer(Modifier.height(16.dp))
    AdminCard {
        Text("Deň v týždni", style = MaterialTheme.typography.titleSmall)
        Text("priemerná tržba podľa dňa v týždni", style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(10.dp))
        RtDowChart(d.daily)
    }
}

@Composable
private fun RtCategoryBreakdown(products: List<RtProduct>, totalRev: Double) {
    if (products.isEmpty()) { EmptyHint("Žiadne dáta"); return }
    data class Agg(var qty: Int = 0, var revenue: Double = 0.0, var cogs: Double = 0.0, var profit: Double = 0.0)
    val map = LinkedHashMap<String, Agg>()
    products.forEach { p ->
        val cat = p.category.ifBlank { "Bez kategórie" }
        val a = map.getOrPut(cat) { Agg() }
        a.qty += p.qty; a.revenue += p.revenue; a.cogs += p.cogs; a.profit += p.profit
    }
    val rows = map.entries.sortedByDescending { it.value.revenue }

    TableHeader(
        "Kategória" to 2.2f, "Predané" to 1.2f, "Tržby" to 1.5f,
        "Suroviny" to 1.2f, "Zisk" to 1.4f, "Marža" to 0.9f,
    )
    var tQty = 0; var tRev = 0.0; var tCogs = 0.0; var tProfit = 0.0
    rows.forEach { (name, a) ->
        tQty += a.qty; tRev += a.revenue; tCogs += a.cogs; tProfit += a.profit
        val pct = if (totalRev > 0) a.revenue / totalRev * 100 else 0.0
        val margin = if (a.revenue > 0) a.profit / a.revenue * 100 else 0.0
        TableRow(
            cells = listOf(
                name to 2.2f,
                "${rtInt(a.qty)} ks" to 1.2f,
                "${money(a.revenue)}  (${rtPct1(pct)})" to 1.5f,
                money(a.cogs) to 1.2f,
                rtSigned(a.profit) to 1.4f,
                rtPct0(margin) to 0.9f,
            ),
            cellColors = listOf(null, null, null, EspressoSoft,
                rtProfitColor(a.profit), rtProfitColor(a.profit)),
        )
    }
    val totalMargin = if (tRev > 0) tProfit / tRev * 100 else 0.0
    RtFooterRow(
        cells = listOf(
            "Spolu" to 2.2f,
            "${rtInt(tQty)} ks" to 1.2f,
            money(tRev) to 1.5f,
            money(tCogs) to 1.2f,
            rtSigned(tProfit) to 1.4f,
            rtPct0(totalMargin) to 0.9f,
        ),
        cellColors = listOf(null, null, null, EspressoSoft,
            rtProfitColor(tProfit), rtProfitColor(totalMargin)),
    )
}

@Composable
private fun RtDayCard(day: RtDaily, title: String, accent: Color) {
    Surface(
        Modifier.fillMaxWidth().paperShadow(Elev.rest, RoundedCornerShape(Radius.md)),
        shape = RoundedCornerShape(Radius.md),
        color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, BorderSoft),
    ) {
        Row(Modifier.height(IntrinsicSize.Min)) {
            Box(Modifier.width(3.dp).fillMaxHeight().background(accent))
            Column(Modifier.padding(14.dp)) {
                Text(title, style = MaterialTheme.typography.titleSmall)
                val wd = rtWeekday(day.date)
                Text("${RT_DOW_FULL[wd] ?: ""} · ${rtFullDate(day.date)}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.height(10.dp))
                RtKv("Tržby", money(day.revenue))
                RtKv("Objednávky", rtInt(day.orders))
                RtKv("Priemerný účet", money(day.avgCheck))
                RtKv("Výroba", money(day.cogs))
                RtKv("Mzdy", money(day.labor))
                HorizontalDivider(color = BorderSoft, modifier = Modifier.padding(vertical = 6.dp))
                RtKv("Výsledok", rtSigned(day.profit), rtProfitColor(day.profit), bold = true)
            }
        }
    }
}

@Composable
private fun RtKv(label: String, value: String, valueColor: Color? = null, bold: Boolean = false) {
    Row(Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
        Text(label, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.bodyMedium,
            color = valueColor ?: MaterialTheme.colorScheme.onSurface,
            fontWeight = if (bold) FontWeight.Bold else FontWeight.Normal)
    }
}

@Composable
private fun RtDestSplit(rev: RtRevenueByDest) {
    val bar = rev.bar
    val kuch = rev.kuchyna
    val total = bar + kuch
    val barPct = if (total > 0) bar / total * 100 else 0.0
    val kuchPct = if (total > 0) kuch / total * 100 else 0.0
    // Split bar
    Row(Modifier.fillMaxWidth().height(12.dp).clip(RoundedCornerShape(Radius.sm))) {
        if (barPct > 0) Box(Modifier.weight(barPct.toFloat()).fillMaxHeight().background(Terra))
        if (kuchPct > 0) Box(Modifier.weight(kuchPct.toFloat()).fillMaxHeight().background(Sage))
        if (total <= 0) Box(Modifier.weight(1f).fillMaxHeight().background(CreamSunken))
    }
    Spacer(Modifier.height(14.dp))
    TableHeader("" to 1.6f, "%" to 0.8f, "Tržby" to 1.4f, "Ks" to 1f)
    RtDestRow("Bar", Terra, barPct, bar, rev.itemsBar)
    RtDestRow("Kuchyňa", Sage, kuchPct, kuch, rev.itemsKuchyna)
}

@Composable
private fun RtDestRow(label: String, dot: Color, pct: Double, eur: Double, ks: Int) {
    Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Row(Modifier.weight(1.6f), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(10.dp).clip(RoundedCornerShape(Radius.xs)).background(dot))
            Spacer(Modifier.width(8.dp))
            Text(label, style = MaterialTheme.typography.bodyMedium)
        }
        Text(rtPct1(pct), Modifier.weight(0.8f), style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(money(eur), Modifier.weight(1.4f), style = MaterialTheme.typography.bodyMedium)
        Text("${rtInt(ks)} ks", Modifier.weight(1f), style = MaterialTheme.typography.bodySmall,
            color = EspressoDim)
    }
    HorizontalDivider(color = BorderSoft.copy(alpha = 0.5f))
}

/** Priemer tržieb podľa dňa v týždni (Po..Ne) → BarChart. */
@Composable
private fun RtDowChart(daily: List<RtDaily>) {
    if (daily.isEmpty()) { EmptyHint("Žiadne dni"); return }
    // bucket per ISO weekday 1..7
    val rev = DoubleArray(8)
    val cnt = IntArray(8)
    daily.forEach { d ->
        val wd = rtWeekday(d.date)
        rev[wd] += d.revenue
        cnt[wd] += 1
    }
    val order = listOf(1, 2, 3, 4, 5, 6, 7)
    val avgs = order.map { wd -> if (cnt[wd] > 0) rev[wd] / cnt[wd] else 0.0 }
    BarChart(
        values = avgs,
        labels = order.map { RT_DOW_SHORT[it] ?: "" },
        barColor = Navy,
        height = 140,
    )
    Spacer(Modifier.height(8.dp))
    // Pod grafom riadok s priemernými hodnotami + počtom dní
    Row(Modifier.fillMaxWidth()) {
        order.forEach { wd ->
            Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(if (cnt[wd] > 0) rtNoEur0(rev[wd] / cnt[wd]) else "—",
                    style = MaterialTheme.typography.labelSmall.copy(fontSize = 10.sp), // token-exempt: velkost mimo skaly
                    color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 1, overflow = TextOverflow.Clip)
                Text("${cnt[wd]} dní",
                    style = MaterialTheme.typography.labelSmall.copy(fontSize = 9.sp), // token-exempt: velkost mimo skaly
                    color = EspressoDim, maxLines = 1)
            }
        }
    }
}

/* =====================================================================
   Spoločné malé bloky
   ===================================================================== */

private data class StatSpec(val label: String, val value: String, val accent: Color, val sub: String)

/** 2-stĺpcový grid stat kariet (tablet density). */
@Composable
private fun RtStatGrid(vararg specs: StatSpec) {
    val rows = specs.toList().chunked(2)
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        rows.forEach { row ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                row.forEach { s ->
                    StatCard(s.label, s.value, Modifier.weight(1f), accent = s.accent, sub = s.sub)
                }
                if (row.size == 1) Spacer(Modifier.weight(1f))
            }
        }
    }
}

/** Žltý upozorňovací panel (noKitchenStaff). */
@Composable
private fun RtWarningPanel(title: String, text: String) {
    Surface(
        Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(Radius.md),
        color = Amber.copy(alpha = 0.08f),
        border = BorderStroke(1.dp, Amber.copy(alpha = 0.35f)),
    ) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.Top) {
            Text("⚠️", style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.width(12.dp))
            Column {
                Text(title, style = MaterialTheme.typography.titleSmall)
                Spacer(Modifier.height(2.dp))
                Text(text, style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

/** „Spolu" footer riadok — bold, s vrchnou hranicou. */
@Composable
private fun RtFooterRow(cells: List<Pair<String, Float>>, cellColors: List<Color?>? = null) {
    HorizontalDivider(color = BorderMid)
    Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        cells.forEachIndexed { i, (text, w) ->
            Text(text, Modifier.weight(w), style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Bold,
                color = cellColors?.getOrNull(i) ?: MaterialTheme.colorScheme.onSurface,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}
