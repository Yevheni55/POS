package sk.surfspirit.pos.ui.admin.pages

import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import retrofit2.http.GET
import sk.surfspirit.pos.core.errorMessage
import sk.surfspirit.pos.core.httpCode
import sk.surfspirit.pos.net.Api
import sk.surfspirit.pos.ui.admin.*
import sk.surfspirit.pos.ui.components.LocalToast
import sk.surfspirit.pos.ui.theme.*

/* =====================================================================
   InventoryScreen — Prehľad skladu (#inventory-dashboard)
   Read-only dashboard: 3 stat karty, „Nízky stav zásob" tabuľka,
   „Posledné pohyby" tabuľka, rýchle akcie. Poll každých 60 s.
   Parita s admin/pages/inventory-dashboard.js.
   ===================================================================== */

/* ---- DTOs (prefix `Inv`) — server shapes z .claude/admin-specs/inventory-dashboard.json ----
   POZOR na asymetriu: lowStock* polia majú qty ako NUMBER (getLowStockAlerts),
   ale recentMovements qty/previousQty/newQty sú STRING (Drizzle numeric). */

@Serializable private data class InvLowIngredientDto(
    val id: Int = 0,
    val name: String = "",
    val unit: String = "",
    val currentQty: Double = 0.0,
    val minQty: Double = 0.0,
)

@Serializable private data class InvLowMenuItemDto(
    val id: Int = 0,
    val name: String = "",
    val currentQty: Double = 0.0,
    val minQty: Double = 0.0,
)

@Serializable private data class InvMovementDto(
    val id: Int = 0,
    val type: String = "",
    val quantity: String = "0",       // STRING
    val previousQty: String = "0",    // STRING
    val newQty: String = "0",         // STRING
    val note: String = "",
    val createdAt: String? = null,
)

@Serializable private data class InvStatsDto(
    val totalIngredients: Int = 0,
    val totalLowStock: Int = 0,
    val todayMovements: Int = 0,
)

@Serializable private data class InvDashboardDto(
    val lowStockIngredients: List<InvLowIngredientDto> = emptyList(),
    val lowStockMenuItems: List<InvLowMenuItemDto> = emptyList(),
    val recentMovements: List<InvMovementDto> = emptyList(),
    val stats: InvStatsDto = InvStatsDto(),
)

private interface InvApi {
    @GET("api/inventory/dashboard") suspend fun dashboard(): InvDashboardDto
}

private val invApi: InvApi by lazy { Api.create(InvApi::class.java) }

/* ---- Pomocné riadky pre zlúčenú low-stock tabuľku ---- */
private data class InvLowRow(
    val name: String,
    val unit: String,
    val currentQty: Double,
    val minQty: Double,
)

/* ---- sk-SK formátovanie čísel (maxFractionDigits 2, čiarka) — web fmtQty ---- */
private fun invFmtQty(n: Double, unit: String? = null): String {
    val rounded = Math.round(n * 100.0) / 100.0
    var s = if (rounded == Math.rint(rounded)) {
        rounded.toLong().toString()
    } else {
        String.format("%.2f", rounded).trimEnd('0').trimEnd('.')
    }
    s = s.replace('.', ',')
    return if (!unit.isNullOrBlank()) "$s $unit" else s
}

/** Celé číslo v sk-SK (stat karty, Number.toLocaleString). */
private fun invFmtInt(n: Int): String = n.toString()

/* ---- Lokálne sémantické farby badge-ov (web parita) ---- */
private val InvPurple = Color(0xFF6B4FA0)   // sale → badge-purple

private data class InvBadge(val label: String, val color: Color)

private fun invMovementBadge(type: String): InvBadge = when (type) {
    "purchase"   -> InvBadge("Prijem", Sage)
    "sale"       -> InvBadge("Predaj", InvPurple)
    "adjustment" -> InvBadge("Uprava", Navy)
    "waste"      -> InvBadge("Odpad", Danger)
    "inventory"  -> InvBadge("Inventura", Amber)
    else         -> InvBadge(if (type.isBlank()) "—" else type, EspressoDim)
}

private fun invStockBadge(currentQty: Double): InvBadge =
    if (currentQty <= 0.0) InvBadge("Prazdny", Danger) else InvBadge("Nizky", Amber)

@Composable
fun InventoryScreen() {
    val toast = LocalToast.current
    val scope = rememberCoroutineScope()

    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var data by remember { mutableStateOf<InvDashboardDto?>(null) }
    var query by remember { mutableStateOf("") }
    // Tichý 60 s poll: toast len pri PRVOM zlyhaní v sérii (nie každú minútu).
    var pollFailing by remember { mutableStateOf(false) }

    fun load(silent: Boolean = false) {
        scope.launch {
            if (!silent) loading = true
            try {
                val res = withContext(Dispatchers.IO) { invApi.dashboard() }
                data = res
                error = null
                pollFailing = false
            } catch (e: Exception) {
                if (e.httpCode() == 401) { /* relogin rieši shell */ }
                if (silent) {
                    // Tiché poll zlyhanie — necháme starý obsah; toast len raz za sériu.
                    if (!pollFailing) {
                        pollFailing = true
                        toast.show(errorMessage(e).ifBlank { "Chyba nacitania inventara" }, error = true)
                    }
                } else {
                    error = errorMessage(e)
                }
            } finally {
                if (!silent) loading = false
            }
        }
    }

    LaunchedEffect(Unit) { load() }

    // POLLING: refresh každých 60 s (web setInterval(loadDashboard, 60000)).
    LaunchedEffect(Unit) {
        while (isActive) {
            delay(60_000)
            load(silent = true)
        }
    }

    AdminScreenBox {
        AdminSectionTitle("Prehľad skladu")

        when {
            loading && data == null -> LoadingBox()
            error != null && data == null -> ErrorBox(error!!) { load() }
            else -> {
                val d = data ?: InvDashboardDto()

                // --- 3 stat karty (na telefóne 2 v riadku) ---
                val statCards = listOf(
                    Triple("Suroviny", invFmtInt(d.stats.totalIngredients), Sage),
                    Triple("Nízky stav", invFmtInt(d.stats.totalLowStock), Danger),
                    Triple("Pohyby dnes", invFmtInt(d.stats.todayMovements), Navy),
                )
                StatGrid(statCards) { (label, value, accent) ->
                    StatCard(label, value, Modifier.weight(1f), accent = accent)
                }

                Spacer(Modifier.height(18.dp))

                // --- 2-stĺpcový panel: Nízky stav (60) + Posledné pohyby (40) ---
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Column(Modifier.weight(0.6f)) {
                        InvLowStockPanel(d, query) { query = it }
                    }
                    Column(Modifier.weight(0.4f)) {
                        InvMovementsPanel(d.recentMovements)
                    }
                }

                Spacer(Modifier.height(18.dp))

                // --- Rýchle akcie ---
                InvQuickActions { dest -> toast.show("$dest otvoríš v sklade na manažérskom paneli.") }
            }
        }
    }
}

/* ---------- Panel: Nízky stav zásob ---------- */
@Composable
private fun InvLowStockPanel(
    d: InvDashboardDto,
    query: String,
    onQuery: (String) -> Unit,
) {
    AdminCard {
        Text("Nízky stav zásob", style = MaterialTheme.typography.titleSmall)
        Spacer(Modifier.height(8.dp))

        FormField(
            label = "Hľadať surovinu",
            value = query,
            onChange = onQuery,
            placeholder = "Názov…",
        )
        Spacer(Modifier.height(10.dp))

        // Zlúčené riadky: suroviny (s vlastnou jednotkou) + menu položky (jednotka „ks").
        val allRows = buildList {
            d.lowStockIngredients.forEach {
                add(InvLowRow(it.name, it.unit.ifBlank { "—" }, it.currentQty, it.minQty))
            }
            d.lowStockMenuItems.forEach {
                add(InvLowRow(it.name, "ks", it.currentQty, it.minQty))
            }
        }
        val q = query.trim().lowercase()
        val rows = if (q.isBlank()) allRows else allRows.filter { it.name.lowercase().contains(q) }

        TableHeader(
            "Názov" to 2.4f,
            "Jednotka" to 1f,
            "Aktuálne" to 1.2f,
            "Minimum" to 1.2f,
            "Stav" to 1.1f,
        )

        when {
            allRows.isEmpty() -> EmptyHint("Vsetky zasoby su v poriadku")
            rows.isEmpty() -> EmptyHint("Žiadna zhoda")
            else -> rows.forEach { r ->
                val badge = invStockBadge(r.currentQty)
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        r.name,
                        Modifier.weight(2.4f).padding(vertical = 10.dp),
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Medium,
                    )
                    Text(
                        r.unit,
                        Modifier.weight(1f),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(
                        invFmtQty(r.currentQty, r.unit.takeIf { it != "—" }),
                        Modifier.weight(1.2f),
                        style = MaterialTheme.typography.bodyMedium,
                        color = badge.color,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Text(
                        invFmtQty(r.minQty, r.unit.takeIf { it != "—" }),
                        Modifier.weight(1.2f),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Box(Modifier.weight(1.1f)) { StatusBadge(badge.label, badge.color) }
                }
                androidx.compose.material3.HorizontalDivider(color = BorderSoft.copy(alpha = 0.5f))
            }
        }
    }
}

/* ---------- Panel: Posledné pohyby ---------- */
@Composable
private fun InvMovementsPanel(movements: List<InvMovementDto>) {
    AdminCard {
        Text("Posledné pohyby", style = MaterialTheme.typography.titleSmall)
        Spacer(Modifier.height(10.dp))

        TableHeader(
            "Čas" to 1.1f,
            "Typ" to 1.2f,
            "Množstvo" to 1f,
            "Pred → Po" to 1.8f,
        )

        if (movements.isEmpty()) {
            EmptyHint("Ziadne pohyby dnes")
        } else {
            movements.forEach { m ->
                val badge = invMovementBadge(m.type)
                val prev = m.previousQty.toDoubleOrNull() ?: 0.0
                val next = m.newQty.toDoubleOrNull() ?: 0.0
                val diff = next - prev
                val sign = if (diff > 0) "+" else ""
                val qtyDisplay = sign + invFmtQty(diff)
                val diffColor = when {
                    diff > 0 -> Sage
                    diff < 0 -> Danger
                    else -> MaterialTheme.colorScheme.onSurface
                }

                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        invMovementTime(m.createdAt),
                        Modifier.weight(1.1f).padding(vertical = 10.dp),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Box(Modifier.weight(1.2f)) { StatusBadge(badge.label, badge.color) }
                    Text(
                        qtyDisplay,
                        Modifier.weight(1f),
                        style = MaterialTheme.typography.bodyMedium,
                        color = diffColor,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Text(
                        invFmtQty(prev) + " → " + invFmtQty(next),
                        Modifier.weight(1.8f),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                androidx.compose.material3.HorizontalDivider(color = BorderSoft.copy(alpha = 0.5f))
            }
        }
    }
}

/** Čas pohybu — HH:mm v Europe/Bratislava (presnejšie než web device-locale). */
private fun invMovementTime(iso: String?): String {
    if (iso.isNullOrBlank()) return "--"
    return try {
        java.time.Instant.parse(iso)
            .atZone(java.time.ZoneId.of("Europe/Bratislava"))
            .format(java.time.format.DateTimeFormatter.ofPattern("HH:mm"))
    } catch (_: Exception) {
        // Server môže poslať "YYYY-MM-DD HH:mm:ss" bez zóny
        val t = iso.replace('T', ' ')
        if (t.length >= 16) t.substring(11, 16) else "--"
    }
}

/* ---------- Rýchle akcie ---------- */
@Composable
private fun InvQuickActions(onClick: (String) -> Unit) {
    AdminCard {
        Text("Rýchle akcie", style = MaterialTheme.typography.titleSmall)
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
            InvActionButton("Suroviny", Modifier.weight(1f)) { onClick("Suroviny") }
            InvActionButton("Dodávatelia", Modifier.weight(1f)) { onClick("Dodávatelia") }
            InvActionButton("Objednávky", Modifier.weight(1f)) { onClick("Objednávky") }
            InvActionButton("Inventúra", Modifier.weight(1f)) { onClick("Inventúra") }
        }
    }
}

@Composable
private fun InvActionButton(label: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    androidx.compose.material3.OutlinedButton(
        onClick = onClick,
        modifier = modifier.heightIn(min = 48.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, Terra),
        colors = androidx.compose.material3.ButtonDefaults.outlinedButtonColors(contentColor = Terra),
    ) {
        Text(label, maxLines = 1, style = MaterialTheme.typography.labelLarge)
    }
}
