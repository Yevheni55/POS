package sk.surfspirit.pos.ui.admin.pages

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
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
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.Serializable
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Query
import sk.surfspirit.pos.core.BRATISLAVA
import sk.surfspirit.pos.core.errorMessage
import sk.surfspirit.pos.core.fmtBratislava
import sk.surfspirit.pos.core.httpCode
import sk.surfspirit.pos.net.Api
import sk.surfspirit.pos.ui.admin.*
import sk.surfspirit.pos.ui.theme.*
import java.time.LocalDate
import java.time.temporal.WeekFields

/* =====================================================================
   DashboardScreen — natívna parita s admin/pages/dashboard.js.
   (A) Kto je v práci, (B) Prehľad dňa: 4 stat karty,
   (C) Tržby za týždeň (7× /reports/summary paralelne), Top produkty dnes,
   (D) Platobné metódy dnes (horizontálne bary), (E) Dnešná uzávierka + tlač.
   ===================================================================== */

/* ---------- DTOs (prefix Db = Dashboard) — summary fields sú NUMBERS ---------- */

@Serializable private data class DbRevenue(
    val total: Double = 0.0,
    val fiscal: Double = 0.0,
    val payments: Int = 0,
)

@Serializable private data class DbShisha(
    val count: Int = 0,
    val revenue: Double = 0.0,
)

@Serializable private data class DbOrders(
    val total: Int = 0,
    val open: Int = 0,
    val closed: Int = 0,
)

@Serializable private data class DbMethod(
    val method: String = "",
    val total: Double = 0.0,
    val count: Int = 0,
)

@Serializable private data class DbTopItem(
    val name: String = "",
    val emoji: String = "",
    val category: String = "",
    val dest: String = "",
    val qty: Int = 0,
    val revenue: Double = 0.0,
)

@Serializable private data class DbSummary(
    val revenue: DbRevenue = DbRevenue(),
    val shisha: DbShisha = DbShisha(),
    val orders: DbOrders = DbOrders(),
    val methods: List<DbMethod> = emptyList(),
    val topItems: List<DbTopItem> = emptyList(),
)

@Serializable private data class DbZPayment(
    val method: String = "",
    val total: Double = 0.0,
    val count: Int = 0,
)

@Serializable private data class DbZReport(
    val date: String = "",
    val fiscalRevenue: Double = 0.0,
    val paymentMethods: List<DbZPayment> = emptyList(),
    val shisha: DbShisha = DbShisha(),
)

@Serializable private data class DbTable(val id: Int = 0)

@Serializable private data class DbOrder(val id: Int = 0, val tableId: Int = 0)

@Serializable private data class DbActiveStaff(
    val staffId: Int = 0,
    val name: String = "",
    val position: String = "",
    val clockedInAt: String = "",
    val minutes: Int = 0,
)

@Serializable private data class DbActiveResp(val active: List<DbActiveStaff> = emptyList())

@Serializable private data class DbPrintZReq(val date: String)

/* ---------- Retrofit interface (vlastný, cez zdieľanú factory) ---------- */

private interface DbApi {
    @GET("api/reports/summary")
    suspend fun summary(@Query("from") from: String, @Query("to") to: String): DbSummary

    @GET("api/reports/z-report")
    suspend fun zReport(@Query("date") date: String): DbZReport

    @GET("api/tables")
    suspend fun tables(): List<DbTable>

    @GET("api/orders")
    suspend fun orders(): List<DbOrder>

    @GET("api/attendance/active")
    suspend fun activeStaff(): DbActiveResp

    @POST("api/print/z-report")
    suspend fun printZReport(@Body body: DbPrintZReq): kotlinx.serialization.json.JsonElement
}

private val dbApi: DbApi by lazy { Api.create(DbApi::class.java) }

/* ---------- Palety pre platobné bary (fixné, web parita) ---------- */
private val DbPayColors = listOf(
    Color(0xFF8B7CF6), // lavender
    Color(0xFF5CC49E), // mint
    Color(0xFF60A5FA), // blue
    Color(0xFFD4A853), // gold
)

/** sk-SK 2-desatinné + " €" (čiarka) — fmtEur z webu. */
private fun fmtEur(v: Double): String = String.format("%.2f", v).replace('.', ',') + " €"

/** Slovenský plurál pre otvorené objednávky. */
private fun skOpenOrdersLabel(n: Int): String = when {
    n == 0 -> "žiadna otvorená"
    n == 1 -> "1 otvorená objednávka"
    n in 2..4 -> "$n otvorené objednávky"
    else -> "$n otvorených objednávok"
}

/** Pekný label metódy platby. */
private fun methodLabel(m: String): String = when (m.lowercase()) {
    "hotovost", "cash" -> "Hotovosť"
    "karta", "card" -> "Karta"
    else -> m.replaceFirstChar { it.uppercase() }
}

private fun ymdLocal(d: LocalDate): String = d.toString()

/* ===================================================================== */

@Composable
fun DashboardScreen() {
    val toast = rememberAdminToast()
    val scope = rememberCoroutineScope()

    // Hlavné štatistiky (summary + obsadenosť) + top + platby
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var summary by remember { mutableStateOf<DbSummary?>(null) }
    var occupied by remember { mutableStateOf(0) }
    var totalTables by remember { mutableStateOf(0) }

    // Týždenný graf — null = deň sa nepodarilo načítať (NIE nula!).
    var weekRev by remember { mutableStateOf<List<Double?>>(emptyList()) }
    var weekLoading by remember { mutableStateOf(true) }

    // Uzávierka
    var zReport by remember { mutableStateOf<DbZReport?>(null) }
    var uzLoading by remember { mutableStateOf(true) }
    var uzStuck by remember { mutableStateOf(false) }

    // Kto je v práci
    var activeStaff by remember { mutableStateOf<List<DbActiveStaff>?>(null) }

    var printing by remember { mutableStateOf(false) }
    var confirmPrint by remember { mutableStateOf(false) }

    suspend fun fetchStats() {
        val today = ymdLocal(LocalDate.now(BRATISLAVA))
        val s = withContext(Dispatchers.IO) { dbApi.summary(today, today) }
        summary = s
        // Obsadenosť: distinct tableId / tables.length
        val tables = withContext(Dispatchers.IO) { dbApi.tables() }
        val orders = withContext(Dispatchers.IO) { dbApi.orders() }
        totalTables = tables.size
        occupied = orders.map { it.tableId }.toSet().size
    }

    fun loadStats(initial: Boolean) {
        scope.launch {
            try {
                fetchStats()
                error = null
            } catch (e: Exception) {
                if (e.httpCode() == 401) { /* session handled globally */ }
                if (initial && summary == null) error = errorMessage(e)
                else toast.show(errorMessage(e), error = true)
            } finally {
                if (initial) loading = false
            }
        }
    }

    fun loadBarChart() {
        scope.launch {
            weekLoading = true
            try {
                // Monday-start ISO týždeň, 7 paralelných summary requestov.
                // POZN.: ranged GET /reports/summary?from&to má daily[] pole,
                // ale daily[].revenue je len z payments (BEZ shisha) — per-day
                // revenue.total zahŕňa aj shisha, preto ostávajú per-day cally.
                val today = LocalDate.now(BRATISLAVA)
                val monday = today.with(WeekFields.ISO.dayOfWeek(), 1)
                val revs: List<Double?> = withContext(Dispatchers.IO) {
                    (0..6).map { idx ->
                        async {
                            try {
                                val d = ymdLocal(monday.plusDays(idx.toLong()))
                                dbApi.summary(d, d).revenue.total
                            } catch (_: Exception) {
                                null   // zlyhaný deň — graf ho ukáže sivo s „?"
                            }
                        }
                    }.awaitAll()
                }
                weekRev = revs
            } catch (_: Exception) {
                weekRev = emptyList()
            } finally {
                weekLoading = false
            }
        }
    }

    fun loadUzavierka() {
        scope.launch {
            uzLoading = true
            uzStuck = false
            // Safety net 12 s — ak request visí, ukáž hint namiesto večného spinnera.
            val data = withTimeoutOrNull(12_000L) {
                try {
                    val today = ymdLocal(LocalDate.now(BRATISLAVA))
                    withContext(Dispatchers.IO) { dbApi.zReport(today) }
                } catch (e: Exception) {
                    toast.show(errorMessage(e), error = true)
                    null
                }
            }
            if (data != null) {
                zReport = data
            } else if (uzLoading) {
                uzStuck = true
            }
            uzLoading = false
        }
    }

    fun loadActiveStaff() {
        scope.launch {
            try {
                activeStaff = withContext(Dispatchers.IO) { dbApi.activeStaff().active }
            } catch (e: Exception) {
                if (activeStaff == null) activeStaff = emptyList()
                // ticho — panel sa obnoví pri ďalšom pingu
            }
        }
    }

    fun refreshAll(initial: Boolean) {
        loadStats(initial)
        loadBarChart()
        loadUzavierka()
        loadActiveStaff()
    }

    LaunchedEffect(Unit) { refreshAll(initial = true) }

    // Polling: stats + uzávierka každých 120 s.
    LaunchedEffect(Unit) {
        while (isActive) {
            delay(120_000L)
            loadStats(initial = false)
            loadUzavierka()
        }
    }
    // Polling: kto je v práci každých 30 s.
    LaunchedEffect(Unit) {
        while (isActive) {
            delay(30_000L)
            loadActiveStaff()
        }
    }

    fun doPrintZ() {
        scope.launch {
            printing = true
            try {
                val today = ymdLocal(LocalDate.now(BRATISLAVA))
                withContext(Dispatchers.IO) { dbApi.printZReport(DbPrintZReq(today)) }
                toast.show("Z-report odoslaný na tlačiareň")
                refreshAll(initial = false)
            } catch (e: Exception) {
                toast.show("Chyba tlače: ${errorMessage(e)}", error = true)
            } finally {
                printing = false
            }
        }
    }

    AdminScreenBox(toast) {
        // (A) Kto je v práci
        DbActiveStaffPanel(activeStaff)

        Spacer(Modifier.height(16.dp))
        AdminSectionTitle("Prehľad dňa")

        when {
            loading -> LoadingBox()
            error != null -> ErrorBox(error!!) { loadStats(initial = true) }
            else -> {
                val s = summary ?: DbSummary()
                // (C) 4 STAT KARTY — 2×2 grid
                val revSub = buildString {
                    append("${s.revenue.payments} platieb")
                    if (s.shisha.count > 0) append(" • shisha ${s.shisha.count}x (${fmtEur(s.shisha.revenue)})")
                }
                val avg = if (s.orders.total > 0) s.revenue.total / s.orders.total else 0.0
                val pct = if (totalTables > 0) Math.round((occupied.toDouble() / totalTables) * 100).toInt() else 0

                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    StatCard(
                        "Dnešné tržby", fmtEur(s.revenue.total),
                        Modifier.weight(1f), accent = Sage, sub = revSub,
                    )
                    StatCard(
                        "Objednávky dnes", s.orders.total.toString(),
                        Modifier.weight(1f), accent = Terra,
                        sub = skOpenOrdersLabel(s.orders.open),
                    )
                }
                Spacer(Modifier.height(12.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    StatCard(
                        "Priemerný účet", fmtEur(avg),
                        Modifier.weight(1f), accent = Navy, sub = "priemerný účet",
                    )
                    StatCard(
                        "Obsadenosť stolov", "$pct%",
                        Modifier.weight(1f), accent = Amber,
                        sub = "$occupied / $totalTables stolov",
                    )
                }

                // (D) Týždenný graf + Top produkty
                Spacer(Modifier.height(16.dp))
                DbWeeklyChartCard(weekRev, weekLoading, onRetry = { loadBarChart() })

                Spacer(Modifier.height(16.dp))
                DbTopProductsCard(s.topItems.take(10))

                // (E) Platobné metódy dnes
                Spacer(Modifier.height(16.dp))
                DbPaymentMethodsCard(s.methods)
            }
        }

        // (F) Uzávierka a tlač
        Spacer(Modifier.height(16.dp))
        AdminSectionTitle("Uzávierka a tlač")
        DbUzavierkaCard(
            z = zReport,
            loading = uzLoading,
            stuck = uzStuck,
            printing = printing,
            onPrint = { confirmPrint = true },
        )

        Spacer(Modifier.height(8.dp))
    }

    if (confirmPrint) {
        AdminConfirm(
            title = "Tlačiť uzávierku",
            text = "Vytlačí sa Z-report dňa a vykoná sa hotovostný výber do Portosu. Pokračovať?",
            confirmLabel = "Tlačiť",
            onConfirm = { confirmPrint = false; doPrintZ() },
            onDismiss = { confirmPrint = false },
        )
    }
}

/* ---------- (A) Kto je v práci ---------- */

@Composable
private fun DbActiveStaffPanel(staff: List<DbActiveStaff>?) {
    AdminCard {
        Text("Kto je v práci", style = MaterialTheme.typography.titleSmall, color = Terra)
        Spacer(Modifier.height(8.dp))
        when {
            staff == null -> Text(
                "Načítavam…", style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            staff.isEmpty() -> Text(
                "Nikto sa zatiaľ neoznačil.", style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            else -> Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                staff.forEach { r ->
                    val h = r.minutes / 60
                    val m = r.minutes % 60
                    val since = fmtBratislava(r.clockedInAt, "HH:mm")
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            r.name.ifBlank { "?" },
                            Modifier.weight(1.4f),
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = FontWeight.SemiBold,
                            maxLines = 1, overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            r.position,
                            Modifier.weight(1f),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1, overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            "od $since",
                            Modifier.weight(0.9f),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                        )
                        Text(
                            "${h}h ${m}m",
                            Modifier.weight(0.7f),
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = FontWeight.Bold,
                            color = Espresso,
                            maxLines = 1,
                        )
                    }
                    HorizontalDivider(color = BorderSoft.copy(alpha = 0.5f))
                }
            }
        }
    }
}

/* ---------- (D) Tržby za týždeň ---------- */

@Composable
private fun DbWeeklyChartCard(values: List<Double?>, loading: Boolean, onRetry: () -> Unit) {
    val labels = listOf("Po", "Ut", "St", "Št", "Pi", "So", "Ne")
    AdminCard {
        Text("Tržby za týždeň", style = MaterialTheme.typography.titleSmall)
        Spacer(Modifier.height(10.dp))
        val failed = values.count { it == null }
        val known = values.filterNotNull()
        when {
            loading -> LoadingBox()
            values.isEmpty() -> EmptyHint("Chyba pri načítaní")
            failed == 0 && known.sum() <= 0.0 -> {
                BarChart(values = known, labels = labels, barColor = Sage, height = 120)
                Spacer(Modifier.height(8.dp))
                Text(
                    "Za tento týždeň zatiaľ žiadne tržby.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            else -> {
                // Sumy nad stĺpcami (max highlight; „?" = deň sa nepodarilo načítať)
                val max = known.maxOrNull() ?: 0.0
                Row(Modifier.fillMaxWidth()) {
                    values.forEach { v ->
                        Text(
                            when { v == null -> "?"; v > 0 -> fmtEur(v); else -> "—" },
                            Modifier.weight(1f),
                            style = MaterialTheme.typography.labelSmall.copy(fontSize = 9.sp),
                            color = when {
                                v == null -> EspressoDim
                                v == max && v > 0 -> Terra
                                else -> MaterialTheme.colorScheme.onSurfaceVariant
                            },
                            fontWeight = if (v != null && v == max && v > 0) FontWeight.Bold else FontWeight.Normal,
                            maxLines = 1, overflow = TextOverflow.Clip,
                        )
                    }
                }
                Spacer(Modifier.height(4.dp))
                BarChart(values = values, labels = labels, barColor = Sage, height = 120)
                if (failed > 0) {
                    Spacer(Modifier.height(8.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            "Niektoré dni sa nepodarilo načítať.",
                            Modifier.weight(1f),
                            style = MaterialTheme.typography.bodySmall,
                            color = Danger,
                        )
                        TextButton(onClick = onRetry) { Text("Skúsiť znova") }
                    }
                }
            }
        }
    }
}

/* ---------- Top produkty dnes ---------- */

@Composable
private fun DbTopProductsCard(items: List<DbTopItem>) {
    AdminCard {
        Text("Top produkty dnes", style = MaterialTheme.typography.titleSmall)
        Spacer(Modifier.height(8.dp))
        if (items.isEmpty()) {
            EmptyHint("Žiadne produkty dnes")
            return@AdminCard
        }
        val maxQty = (items.firstOrNull()?.qty ?: 1).coerceAtLeast(1)
        items.forEachIndexed { i, p ->
            Row(
                Modifier.fillMaxWidth().padding(vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    "${i + 1}",
                    Modifier.width(22.dp),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    (if (p.emoji.isNotBlank()) p.emoji + " " else "") + p.name,
                    Modifier.weight(1.6f),
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                Text(
                    "${p.qty}",
                    Modifier.width(34.dp),
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                )
                // horizontálny fill bar
                Box(
                    Modifier.weight(1.4f).height(8.dp).padding(horizontal = 6.dp)
                        .clip(RoundedCornerShape(4.dp))
                        .background(CreamSunken),
                ) {
                    val frac = (p.qty.toFloat() / maxQty).coerceIn(0f, 1f)
                    Box(
                        Modifier.fillMaxHeight().fillMaxWidth(frac)
                            .clip(RoundedCornerShape(4.dp))
                            .background(Terra),
                    )
                }
                Text(
                    fmtEur(p.revenue),
                    Modifier.weight(1f),
                    style = MaterialTheme.typography.bodyMedium,
                    color = Sage,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                    textAlign = TextAlign.End,
                )
            }
            HorizontalDivider(color = BorderSoft.copy(alpha = 0.5f))
        }
    }
}

/* ---------- (E) Platobné metódy dnes — horizontálne bary ---------- */

@Composable
private fun DbPaymentMethodsCard(methods: List<DbMethod>) {
    AdminCard {
        Text("Platobné metódy dnes", style = MaterialTheme.typography.titleSmall)
        Spacer(Modifier.height(8.dp))
        val total = methods.sumOf { it.total }
        if (methods.isEmpty() || total <= 0.0) {
            EmptyHint("Žiadne platby")
            return@AdminCard
        }
        val maxTotal = (methods.maxOfOrNull { it.total } ?: 0.0).coerceAtLeast(0.0001)
        methods.forEachIndexed { i, m ->
            val color = DbPayColors[i % DbPayColors.size]
            val share = Math.round((m.total / total) * 100).toInt()
            Row(
                Modifier.fillMaxWidth().padding(vertical = 7.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    Modifier.size(12.dp).clip(RoundedCornerShape(6.dp)).background(color),
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    methodLabel(m.method),
                    Modifier.width(86.dp),
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                Box(
                    Modifier.weight(1f).height(10.dp).padding(end = 8.dp)
                        .clip(RoundedCornerShape(5.dp))
                        .background(CreamSunken),
                ) {
                    val frac = (m.total / maxTotal).toFloat().coerceIn(0f, 1f)
                    Box(
                        Modifier.fillMaxHeight().fillMaxWidth(frac)
                            .clip(RoundedCornerShape(5.dp))
                            .background(color),
                    )
                }
                Text(
                    "${fmtEur(m.total)} · $share% · ${m.count}×",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

/* ---------- (F) Dnešná uzávierka ---------- */

@Composable
private fun DbUzavierkaCard(
    z: DbZReport?,
    loading: Boolean,
    stuck: Boolean,
    printing: Boolean,
    onPrint: () -> Unit,
) {
    AdminCard {
        Text("Dnešná uzávierka", style = MaterialTheme.typography.titleSmall, color = Terra)
        Spacer(Modifier.height(6.dp))
        Text(
            "Rozpis platieb pre kontrolu a tlač Z-reportu (súčty sú zhodné s prehľadom vyššie).",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(12.dp))

        when {
            loading -> LoadingBox()
            stuck -> Text(
                "Uzávierka sa nepodarila načítať. Skús obnoviť stránku.",
                style = MaterialTheme.typography.bodyMedium, color = Danger,
            )
            else -> {
                val pms = z?.paymentMethods ?: emptyList()
                val line = if (pms.isEmpty()) "Žiadne platby"
                else pms.joinToString("  |  ") { "${methodLabel(it.method)}: ${fmtEur(it.total)} (${it.count}x)" }
                Text(line, style = MaterialTheme.typography.bodyMedium)

                if (z != null && z.shisha.count > 0) {
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "💨 Shisha: ${z.shisha.count}x  •  ${fmtEur(z.shisha.revenue)}  •  Fiskal: ${fmtEur(z.fiscalRevenue)}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }

        Spacer(Modifier.height(14.dp))
        Button(
            onClick = onPrint,
            enabled = !printing,
            colors = ButtonDefaults.buttonColors(containerColor = Terra, contentColor = Cream),
        ) {
            if (printing) {
                CircularProgressIndicator(Modifier.size(16.dp), color = Cream, strokeWidth = 2.dp)
                Spacer(Modifier.width(8.dp))
                Text("Tlačím…")
            } else {
                Text("Tlačiť uzávierku")
            }
        }
    }
}
