package sk.surfspirit.pos.ui.admin.pages

import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Query

import sk.surfspirit.pos.core.BRATISLAVA
import sk.surfspirit.pos.core.errorMessage
import sk.surfspirit.pos.core.fmtCost
import sk.surfspirit.pos.core.httpCode
import sk.surfspirit.pos.core.isManager
import sk.surfspirit.pos.core.money
import sk.surfspirit.pos.net.Api
import sk.surfspirit.pos.ui.admin.AdminCard
import sk.surfspirit.pos.ui.admin.AdminConfirm
import sk.surfspirit.pos.ui.admin.AdminScreenBox
import sk.surfspirit.pos.ui.admin.AdminSectionTitle
import sk.surfspirit.pos.ui.admin.BarChart
import sk.surfspirit.pos.ui.admin.DateNav
import sk.surfspirit.pos.ui.admin.EmptyHint
import sk.surfspirit.pos.ui.admin.ErrorBox
import sk.surfspirit.pos.ui.admin.LoadingBox
import sk.surfspirit.pos.ui.admin.StatCard
import sk.surfspirit.pos.ui.admin.StatGrid
import sk.surfspirit.pos.ui.admin.StatusBadge
import sk.surfspirit.pos.ui.admin.TableHeader
import sk.surfspirit.pos.ui.admin.TableRow
import sk.surfspirit.pos.ui.components.LocalToast
import sk.surfspirit.pos.ui.theme.BorderSoft
import sk.surfspirit.pos.ui.theme.Danger
import sk.surfspirit.pos.ui.theme.Navy
import sk.surfspirit.pos.ui.theme.Sage
import sk.surfspirit.pos.ui.theme.Terra
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale

/* =====================================================================
   ReportsDailyScreen — natívna „Reporty / Denné" obrazovka.
   DateNav (deň ‹ › + Dnes) + Z-report (uzávierka) pre zvolený deň:
   tržby / fiškál / hotovosť karty, platobné metódy, kategórie, top položky,
   hodinovka (BarChart zo summary.hourly), zamestnanecká spotreba, storná.
   Tlač uzávierky (Z-report / Digitálna uzávierka, s potvrdením) pre deň.
   ===================================================================== */

/* ---------- DTOs (prefix Rd = Reports Daily) ---------- */

@Serializable private data class RdPaymentMethod(
    val method: String = "",
    val total: Double = 0.0,
    val count: Int = 0,
)

@Serializable private data class RdCategory(
    val category: String = "",
    val total: Double = 0.0,
    val count: Int = 0,
)

@Serializable private data class RdTopItem(
    val name: String = "",
    val emoji: String = "",
    val qty: Int = 0,
    val revenue: Double = 0.0,
)

@Serializable private data class RdStaffMeal(
    val name: String = "",
    val meals: Int = 0,
    val foodCost: Double = 0.0,
    val drinkCost: Double = 0.0,
    val cost: Double = 0.0,
    val menuValue: Double = 0.0,
)

@Serializable private data class RdShisha(
    val count: Int = 0,
    val revenue: Double = 0.0,
)

@Serializable private data class RdZReport(
    val date: String = "",
    val totalRevenue: Double = 0.0,
    val fiscalRevenue: Double = 0.0,
    val cashFiscal: Double = 0.0,
    val totalOrders: Int = 0,
    val totalItems: Int = 0,
    val averageOrder: Double = 0.0,
    val paymentMethods: List<RdPaymentMethod> = emptyList(),
    val categoryBreakdown: List<RdCategory> = emptyList(),
    val topItems: List<RdTopItem> = emptyList(),
    val shisha: RdShisha = RdShisha(),
    val cancelledItems: Int = 0,
    val cancelledTotal: Double = 0.0,
    val staffMealByPerson: List<RdStaffMeal> = emptyList(),
)

@Serializable private data class RdHour(
    val hour: String = "",
    val orders: Int = 0,
    val revenue: Double = 0.0,
    val barRevenue: Double = 0.0,
    val kuchynaRevenue: Double = 0.0,
)

// summary endpoint je veľký objekt — z neho čítame LEN hourly[] pre BarChart.
@Serializable private data class RdSummary(
    val hourly: List<RdHour> = emptyList(),
)

@Serializable private data class RdPrintReq(
    val date: String,
    val digital: Boolean = false,
)

// /print/z-report odpoveď — withdrawal{} + portosWithdraw{} riadia toast vetvenie.
@Serializable private data class RdWithdrawal(
    val reason: String? = null,
    val created: Boolean = false,
    val alreadyExists: Boolean = false,
    val amount: Double? = null,
)

@Serializable private data class RdPortosWithdraw(
    val ok: Boolean = false,
    val skipped: Boolean = false,
    val error: String? = null,
    val receiptId: String? = null,
)

@Serializable private data class RdPrintResp(
    val ok: Boolean = false,
    val withdrawal: RdWithdrawal? = null,
    val portosWithdraw: RdPortosWithdraw? = null,
)

/* ---------- Retrofit interface ---------- */

private interface RdApi {
    @GET("api/reports/z-report")
    suspend fun zReport(@Query("date") date: String): RdZReport

    @GET("api/reports/summary")
    suspend fun summary(@Query("from") from: String, @Query("to") to: String): RdSummary

    @POST("api/print/z-report")
    suspend fun printZReport(@Body body: RdPrintReq): RdPrintResp
}

private val rdApi: RdApi by lazy { Api.create(RdApi::class.java) }

/* ---------- Date helpers ---------- */

// implNotes: web používa toISOString().split('T')[0] = UTC dátum. My držíme
// dátum ako jednoduchý YYYY-MM-DD reťazec (deň, ktorý operátor vyberá).
private val rdDayLabelFmt: DateTimeFormatter =
    DateTimeFormatter.ofPattern("EEE d. MMMM yyyy", Locale("sk", "SK"))

private fun rdLabelFor(date: LocalDate): String =
    date.format(rdDayLabelFmt).replaceFirstChar { it.uppercase() }

/* ---------- Screen ---------- */

@Composable
fun ReportsDailyScreen() {
    val toast = LocalToast.current
    val scope = rememberCoroutineScope()

    // „Dnes" = Europe/Bratislava — device TZ (UTC tablety) by po polnoci ukázal včerajšok.
    var date by remember { mutableStateOf(LocalDate.now(BRATISLAVA)) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var z by remember { mutableStateOf<RdZReport?>(null) }
    var hourly by remember { mutableStateOf<List<RdHour>>(emptyList()) }
    // null summary ≠ prázdne hourly — zlyhanie volania ukáže inline poznámku.
    var hourlyFailed by remember { mutableStateOf(false) }
    var printing by remember { mutableStateOf(false) }
    var confirmDigital by remember { mutableStateOf(false) }
    var confirmPrint by remember { mutableStateOf(false) }

    fun load() {
        scope.launch {
            loading = true
            val iso = date.toString()
            try {
                val (zr, sm) = withContext(Dispatchers.IO) {
                    val zr = rdApi.zReport(iso)
                    // hourly z summary pre ten istý deň (from == to)
                    val sm = runCatching { rdApi.summary(iso, iso) }.getOrNull()
                    zr to sm
                }
                z = zr
                hourly = sm?.hourly ?: emptyList()
                hourlyFailed = sm == null
                error = null
            } catch (e: Exception) {
                if (e.httpCode() == 401) { /* session handled globally */ }
                error = errorMessage(e)
            } finally {
                loading = false
            }
        }
    }

    fun doPrint(digital: Boolean) {
        scope.launch {
            printing = true
            val iso = date.toString()
            try {
                val res = withContext(Dispatchers.IO) {
                    rdApi.printZReport(RdPrintReq(date = iso, digital = digital))
                }
                val w = res.withdrawal
                val pw = res.portosWithdraw
                val amt = w?.amount?.let { fmtCost(it) + " €" } ?: ""
                val prefix = if (digital) "Digitálna uzávierka" else "Z-report vytlačený"
                // Vetvenie 1:1 podľa web doZReport() — operátor v jednom toaste
                // vidí, či sa Portos paragón výberu fakticky vytvoril.
                when {
                    w?.reason == "no_cash" ->
                        toast.show("$prefix. Žiadna hotovosť na výber.")
                    digital && w != null && (w.created || w.alreadyExists) ->
                        toast.show("$prefix. Cashflow výber $amt. Portos paragón výberu NEvytvorený (bez papiera).")
                    pw != null && pw.ok ->
                        toast.show("$prefix. Portos výber $amt" +
                            (pw.receiptId?.let { " ($it)" } ?: "") + " OK.")
                    pw != null && !pw.ok && pw.skipped ->
                        toast.show("$prefix. Cashflow výber $amt (Portos je vypnutý).")
                    pw != null && !pw.ok ->
                        toast.show("$prefix + cashflow $amt. ⚠ Portos paragón výberu zlyhal: " +
                            (pw.error ?: "unknown") + " — vytlač ručne.", error = true)
                    w != null && w.alreadyExists ->
                        toast.show("$prefix. Výber už evidovaný ($amt).")
                    w != null && w.created ->
                        toast.show("$prefix. Cashflow výber $amt.")
                    else ->
                        toast.show(if (digital) "Digitálna uzávierka zaznamenaná." else "Z-report odoslaný na tlačiareň.")
                }
            } catch (e: Exception) {
                toast.show("Chyba tlače: " + errorMessage(e), error = true)
            } finally {
                printing = false
            }
        }
    }

    LaunchedEffect(date) { load() }

    if (confirmDigital) {
        AdminConfirm(
            title = "Digitálna uzávierka",
            text = "Uzávierka sa zapíše do cashflow BEZ vytlačenia papiera. Portos paragón výberu " +
                "(fiškálny doklad) sa NEVYTVORÍ. Pre fiškálnu kompletnosť pokladne treba neskôr buď " +
                "vytlačiť uzávierku, alebo manuálne registrovať výber v Portos.",
            confirmLabel = "Pokračovať bez papiera",
            onConfirm = { confirmDigital = false; doPrint(true) },
            onDismiss = { confirmDigital = false },
        )
    }

    if (confirmPrint) {
        AdminConfirm(
            title = "Tlačiť Z-report",
            text = "Vytlačí sa papierová uzávierka dňa a zaeviduje sa výber hotovosti " +
                "(cashflow + Portos paragón výberu, ak je v pokladni hotovosť).",
            confirmLabel = "Tlačiť",
            onConfirm = { confirmPrint = false; doPrint(false) },
            onDismiss = { confirmPrint = false },
        )
    }

    AdminScreenBox {
        AdminSectionTitle("Reporty / Denné")

        DateNav(
            label = rdLabelFor(date),
            onPrev = { date = date.minusDays(1) },
            onNext = { date = date.plusDays(1) },
            onToday = { date = LocalDate.now(BRATISLAVA) },
        )
        Spacer(Modifier.height(12.dp))

        when {
            loading -> LoadingBox()
            error != null -> ErrorBox(error!!) { load() }
            z == null -> EmptyHint("Žiadne dáta")
            else -> RdContent(
                z = z!!,
                hourly = hourly,
                hourlyFailed = hourlyFailed,
                printing = printing,
                onPrint = { confirmPrint = true },
                onDigital = { confirmDigital = true },
            )
        }
    }
}

/* ---------- Content ---------- */

@Composable
private fun RdContent(
    z: RdZReport,
    hourly: List<RdHour>,
    hourlyFailed: Boolean,
    printing: Boolean,
    onPrint: () -> Unit,
    onDigital: () -> Unit,
) {
    // ===== KPI karty: tržby / fiškál / hotovosť (telefón = 2 v riadku) =====
    data class RdKpi(val label: String, val value: String, val accent: Color, val sub: String?)
    val kpis = listOf(
        RdKpi("Celkové tržby", money(z.totalRevenue), Terra,
            "Obj. ${z.totalOrders} · Pol. ${z.totalItems}"),
        RdKpi("Fiškálne tržby", money(z.fiscalRevenue), Navy,
            if (z.shisha.count > 0) "Shisha ${z.shisha.count}× · ${money(z.shisha.revenue)}" else null),
        RdKpi("Hotovosť (fiškál)", money(z.cashFiscal), Sage,
            "Priem. účet ${money(z.averageOrder)}"),
    )
    StatGrid(kpis, spacing = 10.dp) { k ->
        StatCard(k.label, k.value, Modifier.weight(1f), accent = k.accent, sub = k.sub)
    }
    Spacer(Modifier.height(16.dp))

    // ===== Tlač uzávierky =====
    AdminSectionTitle("Uzávierka dňa")
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedButton(onClick = onPrint, enabled = !printing) {
            Text(if (printing) "Tlačím…" else "Tlačiť Z-report")
        }
        if (isManager) {
            OutlinedButton(onClick = onDigital, enabled = !printing) {
                Text("Digitálna uzávierka")
            }
        }
    }
    Spacer(Modifier.height(16.dp))

    // ===== Platobné metódy =====
    AdminSectionTitle("Platobné metódy")
    AdminCard {
        if (z.paymentMethods.isEmpty()) {
            EmptyHint("Žiadne platby")
        } else {
            TableHeader("Spôsob" to 2f, "Počet" to 1f, "Tržby" to 1.4f)
            z.paymentMethods.forEach { pm ->
                val label = pm.method.replaceFirstChar { it.uppercase() }
                TableRow(
                    cells = listOf(label to 2f, "${pm.count}×" to 1f, money(pm.total) to 1.4f),
                    cellColors = listOf(null, null, Terra),
                )
            }
        }
    }
    Spacer(Modifier.height(16.dp))

    // ===== Storná =====
    AdminSectionTitle("Storná")
    AdminCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                z.cancelledItems.toString(),
                style = MaterialTheme.typography.titleLarge,
                color = if (z.cancelledItems > 0) Danger else MaterialTheme.colorScheme.onSurface,
            )
            Spacer(Modifier.width(12.dp))
            Text(
                if (z.cancelledTotal > 0) "Strata: ${money(z.cancelledTotal)}" else "Žiadne storná",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
    Spacer(Modifier.height(16.dp))

    // ===== Kategórie =====
    AdminSectionTitle("Kategórie")
    AdminCard {
        if (z.categoryBreakdown.isEmpty()) {
            EmptyHint("Žiadne dáta")
        } else {
            TableHeader("Kategória" to 2.4f, "Tržby" to 1.4f, "Počet" to 1f)
            z.categoryBreakdown.forEach { c ->
                TableRow(
                    cells = listOf(c.category to 2.4f, money(c.total) to 1.4f, "${c.count}×" to 1f),
                    cellColors = listOf(null, Terra, null),
                )
            }
        }
    }
    Spacer(Modifier.height(16.dp))

    // ===== Top 10 položky =====
    AdminSectionTitle("Top 10 položky")
    AdminCard {
        if (z.topItems.isEmpty()) {
            EmptyHint("Žiadne dáta")
        } else {
            TableHeader("#" to 0.5f, "Položka" to 2.6f, "Počet" to 1f, "Tržby" to 1.4f)
            z.topItems.forEachIndexed { i, item ->
                val rankColor: Color? = when {
                    i == 0 -> Terra
                    i < 3 -> MaterialTheme.colorScheme.onSurfaceVariant
                    else -> null
                }
                val name = (item.emoji.takeIf { it.isNotBlank() }?.let { "$it " } ?: "") + item.name
                TableRow(
                    cells = listOf(
                        "${i + 1}" to 0.5f,
                        name to 2.6f,
                        "${item.qty}×" to 1f,
                        money(item.revenue) to 1.4f,
                    ),
                    cellColors = listOf(rankColor, null, null, Terra),
                )
            }
        }
    }
    Spacer(Modifier.height(16.dp))

    // ===== Hodinovka (BarChart zo summary.hourly) =====
    AdminSectionTitle("Hodinovka")
    AdminCard {
        if (hourlyFailed) {
            // Zlyhanie summary volania ≠ deň bez tržieb — odlíš inline poznámkou.
            Text(
                "Hodinovku sa nepodarilo načítať.",
                style = MaterialTheme.typography.bodySmall,
                color = Danger,
                modifier = Modifier.padding(vertical = 8.dp),
            )
        } else if (hourly.isEmpty()) {
            EmptyHint("Žiadne tržby")
        } else {
            val maxOrders = hourly.maxOfOrNull { it.orders } ?: 0
            BarChart(
                values = hourly.map { it.revenue },
                labels = hourly.map { it.hour.take(2) },
                barColor = Terra,
            )
            Spacer(Modifier.height(8.dp))
            TableHeader("Hodina" to 1f, "Obj." to 0.8f, "Bar" to 1.2f, "Kuchyňa" to 1.2f, "Spolu" to 1.2f, "" to 0.8f)
            hourly.forEach { h ->
                val peak = maxOrders > 0 && h.orders >= maxOrders * 0.85
                Row(
                    Modifier.fillMaxWidth().padding(vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(h.hour, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                    Text("${h.orders}", Modifier.weight(0.8f), style = MaterialTheme.typography.bodyMedium)
                    Text(money(h.barRevenue), Modifier.weight(1.2f), style = MaterialTheme.typography.bodyMedium)
                    Text(money(h.kuchynaRevenue), Modifier.weight(1.2f), style = MaterialTheme.typography.bodyMedium)
                    Text(
                        money(h.revenue), Modifier.weight(1.2f),
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.SemiBold, color = Terra,
                    )
                    Box(Modifier.weight(0.8f)) {
                        if (peak) StatusBadge("PEAK", Terra)
                    }
                }
                androidx.compose.material3.HorizontalDivider(
                    color = BorderSoft.copy(alpha = 0.5f)
                )
            }
        }
    }
    Spacer(Modifier.height(16.dp))

    // ===== Zamestnanecká spotreba — skrytá keď prázdna (web parita) =====
    if (z.staffMealByPerson.isNotEmpty()) {
        AdminSectionTitle("Zamestnanecká spotreba")
        AdminCard {
            TableHeader(
                "Meno" to 1.6f, "Počet" to 0.8f, "Jedlo" to 1.1f,
                "Nápoje" to 1.1f, "Náklad" to 1.1f, "Cena" to 1.1f,
            )
            z.staffMealByPerson.forEach { m ->
                TableRow(
                    cells = listOf(
                        m.name to 1.6f,
                        "${m.meals}×" to 0.8f,
                        money(m.foodCost) to 1.1f,
                        money(m.drinkCost) to 1.1f,
                        money(m.cost) to 1.1f,
                        money(m.menuValue) to 1.1f,
                    ),
                )
            }
        }
        Spacer(Modifier.height(16.dp))
    }
}
