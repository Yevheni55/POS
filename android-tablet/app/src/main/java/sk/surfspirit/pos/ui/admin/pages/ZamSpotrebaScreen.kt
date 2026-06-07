package sk.surfspirit.pos.ui.admin.pages

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
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
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import retrofit2.http.GET
import retrofit2.http.Query
import sk.surfspirit.pos.core.errorMessage
import sk.surfspirit.pos.core.fmtCost
import sk.surfspirit.pos.core.httpCode
import sk.surfspirit.pos.net.Api
import sk.surfspirit.pos.ui.admin.*
import sk.surfspirit.pos.ui.theme.*
import java.time.LocalDate

/* =====================================================================
   Zamestnanecká spotreba — manager analytics/benefit view.
   Read-only: GET /api/reports/summary?from&to → staffMealByPerson + daily.
   Web parita: admin/pages/zam-spotreba.js
   Pozn.: tieto čísla sú plain JS NUMBERS (server ::float/::int casts) — NIE
   Drizzle stringy ako väčšina numeric stĺpcov, preto DTO používa Double/Int.
   ===================================================================== */

@Serializable
private data class ZsPersonDto(
    val name: String = "",
    val meals: Int = 0,
    val foodCost: Double = 0.0,
    val drinkCost: Double = 0.0,
    val cost: Double = 0.0,
    val menuValue: Double = 0.0,
)

@Serializable
private data class ZsDailyDto(
    val date: String = "",
    val staffMeal: Double = 0.0,
)

// Summary je veľký objekt; konzumujeme len tieto dve polia, zvyšok ignoreUnknownKeys pohltí.
@Serializable
private data class ZsSummaryDto(
    val staffMealByPerson: List<ZsPersonDto> = emptyList(),
    val daily: List<ZsDailyDto> = emptyList(),
)

private interface ZsApi {
    @GET("api/reports/summary")
    suspend fun summary(@Query("from") from: String, @Query("to") to: String): ZsSummaryDto
}

private val zsApi: ZsApi by lazy { Api.create(ZsApi::class.java) }

private fun zsFmtEur(n: Double): String = fmtCost(n) + " €"

/** "YYYY-MM-DD" → "DD.MM." pre chart os (web parita). */
private fun zsDayLabel(iso: String): String {
    val p = iso.split("-")
    return if (p.size >= 3) "${p[2]}.${p[1]}." else iso
}

@Composable
fun ZamSpotrebaScreen() {
    val toast = rememberAdminToast()
    val scope = rememberCoroutineScope()

    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var data by remember { mutableStateOf<ZsSummaryDto?>(null) }

    // Default rozsah = tento mesiac (prvý deň .. dnes).
    var from by remember { mutableStateOf(LocalDate.now().withDayOfMonth(1).toString()) }
    var to by remember { mutableStateOf(LocalDate.now().toString()) }
    // 0 = Tento mesiac, 1 = 7 dní, 2 = 30 dní, 3 = 60 dní
    var preset by remember { mutableStateOf(0) }

    fun load() {
        scope.launch {
            loading = true
            try {
                val d = withContext(Dispatchers.IO) { zsApi.summary(from, to) }
                data = d
                error = null
            } catch (e: Exception) {
                if (e.httpCode() == 401) { /* session handler rieši logout globálne */ }
                error = "Chyba načítania: " + errorMessage(e)
            } finally {
                loading = false
            }
        }
    }

    fun applyPreset(idx: Int) {
        preset = idx
        val today = LocalDate.now()
        when (idx) {
            0 -> { from = today.withDayOfMonth(1).toString(); to = today.toString() }
            1 -> { from = today.minusDays(7).toString(); to = today.toString() }
            2 -> { from = today.minusDays(30).toString(); to = today.toString() }
            3 -> { from = today.minusDays(60).toString(); to = today.toString() }
        }
        load()
    }

    // „Mesiac navigácia" — funguje len v móde Tento mesiac: posunie celý kalendárny mesiac.
    fun shiftMonth(delta: Long) {
        val anchor = (LocalDate.parse(from)).plusMonths(delta).withDayOfMonth(1)
        from = anchor.toString()
        val today = LocalDate.now()
        val monthEnd = anchor.plusMonths(1).minusDays(1)
        // Aktuálny mesiac končí dnes; minulé mesiace celé.
        to = if (monthEnd.isAfter(today)) today.toString() else monthEnd.toString()
        load()
    }

    LaunchedEffect(Unit) { load() }

    AdminScreenBox(toast) {
        AdminSectionTitle("Zamestnanecká spotreba")

        // --- Top bar: rozsah + presety ---
        AdminCard {
            Text("OBDOBIE", style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(6.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (preset == 0) {
                    OutlinedButton(onClick = { shiftMonth(-1) },
                        contentPadding = PaddingValues(horizontal = 12.dp)) { Text("‹") }
                    Spacer(Modifier.width(8.dp))
                }
                Text("$from — $to", style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.weight(1f))
                if (preset == 0) {
                    val nextMonthStart = LocalDate.parse(from).plusMonths(1)
                    val canForward = !nextMonthStart.isAfter(LocalDate.now())
                    if (canForward) {
                        OutlinedButton(onClick = { shiftMonth(1) },
                            contentPadding = PaddingValues(horizontal = 12.dp)) { Text("›") }
                    }
                }
            }
            Spacer(Modifier.height(10.dp))
            val presets = listOf("Tento mesiac", "7 dní", "30 dní", "60 dní")
            PillTabs(presets, preset) { applyPreset(it) }
        }

        Spacer(Modifier.height(16.dp))

        when {
            loading -> LoadingBox()
            error != null -> ErrorBox(error!!) { load() }
            else -> ZsContent(data)
        }
    }
}

@Composable
private fun ZsContent(data: ZsSummaryDto?) {
    if (data == null) { EmptyHint("Žiadne dáta v období"); return }

    // Filter prázdnych/nulových riadkov client-side (web parita).
    val rows = data.staffMealByPerson.filter { it.cost > 0 || it.menuValue > 0 }
    val daily = data.daily.filter { it.staffMeal > 0 }

    var totalMeals = 0
    var totalCost = 0.0
    var totalFood = 0.0
    var totalDrink = 0.0
    var totalMenuValue = 0.0
    rows.forEach {
        totalMeals += it.meals
        totalCost += it.cost
        totalFood += it.foodCost
        totalDrink += it.drinkCost
        totalMenuValue += it.menuValue
    }
    val lostMargin = totalMenuValue - totalCost

    // --- 1) Stat cards (3-col) ---
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        StatCard(
            "Počet jedál", totalMeals.toString(),
            modifier = Modifier.weight(1f), accent = Sage,
            sub = if (totalMeals == 1) "meal" else "meals",
        )
        StatCard(
            "Náklad firmy", zsFmtEur(totalCost),
            modifier = Modifier.weight(1f), accent = Navy,
            sub = "reálne suroviny + bar",
        )
        StatCard(
            "Hodnota benefitu", zsFmtEur(totalMenuValue),
            modifier = Modifier.weight(1f), accent = Terra,
            sub = "koľko by zaplatil zákazník",
        )
    }

    // --- 2) Split bar kuchyňa vs bar (len keď je náklad) ---
    if (totalCost > 0) {
        Spacer(Modifier.height(16.dp))
        ZsSplitBar(totalFood, totalDrink)
    }

    // --- 3) Denný náklad chart ---
    Spacer(Modifier.height(16.dp))
    AdminCard {
        Text("Denný náklad firmy (suroviny)", style = MaterialTheme.typography.titleSmall)
        Spacer(Modifier.height(12.dp))
        if (daily.isEmpty()) {
            EmptyHint("Žiadne dáta v období")
        } else {
            ZsDailyChart(daily.sortedBy { it.date })
        }
    }

    // --- 4) Per-person tabuľka ---
    Spacer(Modifier.height(16.dp))
    AdminCard {
        Text("Podrobnosti podľa osoby", style = MaterialTheme.typography.titleSmall)
        Spacer(Modifier.height(8.dp))
        if (rows.isEmpty()) {
            Column(Modifier.fillMaxWidth().padding(vertical = 24.dp),
                horizontalAlignment = Alignment.CenterHorizontally) {
                Text(
                    "V tomto období nebola zaznamenaná žiadna zamestnanecká spotreba.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(6.dp))
                Text(
                    "Staff meal sa registruje pri zatvorení účtu cez tlačidlo \"Uzavrieť ako staff meal\" v POS.",
                    style = MaterialTheme.typography.bodySmall,
                    color = EspressoDim,
                    textAlign = TextAlign.Center,
                )
            }
        } else {
            ZsPersonTable(rows, totalMeals, totalFood, totalDrink, totalCost, totalMenuValue, lostMargin)
        }
    }
}

/** Horizontálny stacked bar: kuchyňa (Sage) vs bar (Terra) + legenda. */
@Composable
private fun ZsSplitBar(food: Double, drink: Double) {
    val total = food + drink
    if (total <= 0) return
    val foodPct = (food / total) * 100.0
    val drinkPct = (drink / total) * 100.0
    AdminCard {
        Text("Rozdelenie kuchyňa vs bar", style = MaterialTheme.typography.titleSmall)
        Spacer(Modifier.height(12.dp))
        Row(
            Modifier.fillMaxWidth().height(14.dp)
                .background(CreamSunken, RoundedCornerShape(7.dp))
                .clip(RoundedCornerShape(7.dp))
        ) {
            if (foodPct > 0) Box(Modifier.weight(foodPct.toFloat()).fillMaxHeight().background(Sage))
            if (drinkPct > 0) Box(Modifier.weight(drinkPct.toFloat()).fillMaxHeight().background(Terra))
        }
        Spacer(Modifier.height(12.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(24.dp)) {
            ZsLegend(Sage, "Kuchyňa", zsFmtEur(food), foodPct)
            ZsLegend(Terra, "Bar", zsFmtEur(drink), drinkPct)
        }
    }
}

@Composable
private fun ZsLegend(color: Color, label: String, amount: String, pct: Double) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(Modifier.size(12.dp).background(color, RoundedCornerShape(3.dp)))
        Text(label, style = MaterialTheme.typography.bodySmall)
        Text(amount, style = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.Bold), color = Espresso)
        Text("(${String.format("%.1f", pct).replace('.', ',')} %)",
            style = MaterialTheme.typography.labelSmall, color = EspressoDim)
    }
}

/** Vertikálne stĺpce, jeden na deň; 80dp track, DD.MM. label, horizontálny scroll. */
@Composable
private fun ZsDailyChart(daily: List<ZsDailyDto>) {
    val max = (daily.maxOfOrNull { it.staffMeal } ?: 0.0).coerceAtLeast(0.0001)
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.Bottom,
    ) {
        daily.forEach { d ->
            val pct = (d.staffMeal / max).toFloat().coerceIn(0f, 1f)
            Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.width(34.dp)) {
                Text(zsFmtEur(d.staffMeal),
                    style = MaterialTheme.typography.labelSmall.copy(fontSize = 8.sp),
                    color = EspressoDim, maxLines = 1, overflow = TextOverflow.Clip)
                Spacer(Modifier.height(2.dp))
                Box(
                    Modifier.width(24.dp).height(80.dp)
                        .background(CreamSunken, RoundedCornerShape(4.dp)),
                    contentAlignment = Alignment.BottomCenter,
                ) {
                    Box(
                        Modifier.fillMaxWidth()
                            .fillMaxHeight(pct)
                            .background(Terra, RoundedCornerShape(4.dp))
                    )
                }
                Spacer(Modifier.height(4.dp))
                Text(zsDayLabel(d.date), style = MaterialTheme.typography.labelSmall,
                    color = EspressoDim, maxLines = 1)
            }
        }
    }
}

/** Per-osoba tabuľka + tfoot Spolu. Bunky 0 jedlo/nápoj zobrazia „—". */
@Composable
private fun ZsPersonTable(
    rows: List<ZsPersonDto>,
    totalMeals: Int,
    totalFood: Double,
    totalDrink: Double,
    totalCost: Double,
    totalMenuValue: Double,
    lostMargin: Double,
) {
    // Váhy stĺpcov: Meno | Počet | Jedlo | Nápoje | Náklad | Cena na predaj | Stratená marža
    val wName = 2.2f; val wCount = 1f; val wFood = 1.4f; val wDrink = 1.4f
    val wCost = 1.5f; val wSell = 1.5f; val wLost = 1.5f

    TableHeader(
        "Meno" to wName, "Počet" to wCount, "Jedlo (kuch.)" to wFood,
        "Nápoje (bar)" to wDrink, "Náklad spolu" to wCost,
        "Cena na predaj" to wSell, "Stratená marža" to wLost,
    )

    rows.forEach { r ->
        val lost = r.menuValue - r.cost
        TableRow(
            cells = listOf(
                r.name.ifBlank { "—" } to wName,
                r.meals.toString() to wCount,
                (if (r.foodCost > 0) zsFmtEur(r.foodCost) else "—") to wFood,
                (if (r.drinkCost > 0) zsFmtEur(r.drinkCost) else "—") to wDrink,
                zsFmtEur(r.cost) to wCost,
                zsFmtEur(r.menuValue) to wSell,
                zsFmtEur(lost) to wLost,
            ),
            cellColors = listOf(
                Espresso, EspressoSoft, EspressoSoft, EspressoSoft,
                Espresso, EspressoSoft, EspressoSoft,
            ),
        )
    }

    // tfoot — Spolu (náklad amber, web parita)
    Spacer(Modifier.height(4.dp))
    Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        ZsFootCell("Spolu", wName, Espresso, bold = true)
        ZsFootCell(totalMeals.toString(), wCount, Espresso)
        ZsFootCell(zsFmtEur(totalFood), wFood, EspressoSoft)
        ZsFootCell(zsFmtEur(totalDrink), wDrink, EspressoSoft)
        ZsFootCell(zsFmtEur(totalCost), wCost, Amber, bold = true)
        ZsFootCell(zsFmtEur(totalMenuValue), wSell, Espresso, bold = true)
        ZsFootCell(zsFmtEur(lostMargin), wLost, EspressoSoft)
    }
}

@Composable
private fun RowScope.ZsFootCell(text: String, weight: Float, color: Color, bold: Boolean = false) {
    Text(
        text, Modifier.weight(weight),
        style = if (bold) MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Bold)
        else MaterialTheme.typography.bodyMedium,
        color = color, maxLines = 1, overflow = TextOverflow.Ellipsis,
    )
}
