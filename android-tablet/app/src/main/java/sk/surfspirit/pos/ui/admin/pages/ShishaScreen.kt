package sk.surfspirit.pos.ui.admin.pages

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path
import sk.surfspirit.pos.core.errorMessage
import sk.surfspirit.pos.core.fmtCost
import sk.surfspirit.pos.core.httpCode
import sk.surfspirit.pos.core.isManager
import sk.surfspirit.pos.net.Api
import sk.surfspirit.pos.ui.admin.*
import sk.surfspirit.pos.ui.components.LocalToast
import sk.surfspirit.pos.ui.theme.*

/* =====================================================================
   Shisha — interný counter mimo fiškálneho obehu (admin/pages/shisha.js).
   Veľké tlačidlo +1 (default cena 17 €), tri počítadlá (Dnes / Mesiac /
   Celkovo), tabuľka predajov po dňoch (60 dní) a posledných 20 záznamov.
   Mazanie záznamu len pre manažér/admin (server vynucuje requireRole).

   POZN.: server zabaľuje každé count/revenue do Number(), takže — na rozdiel
   od väčšiny Drizzle stĺpcov — sú to reálne JSON čísla, nie stringy.
   ===================================================================== */

private const val SH_DEFAULT_PRICE = 17

/* ---------- DTOs (prefix Sh) ---------- */

@Serializable private data class ShBucketDto(
    val count: Int = 0,
    val revenue: Double = 0.0,
)

@Serializable private data class ShSummaryDto(
    val today: ShBucketDto = ShBucketDto(),
    val month: ShBucketDto = ShBucketDto(),
    val total: ShBucketDto = ShBucketDto(),
)

@Serializable private data class ShDayDto(
    val day: String = "",          // "YYYY-MM-DD" (Europe/Bratislava)
    val count: Int = 0,
    val revenue: Double = 0.0,
)

@Serializable private data class ShRecentDto(
    val id: Int,
    val soldAt: String? = null,    // ISO tz
    val price: Double = 0.0,
    val staffId: Int? = null,
    val staffName: String = "",    // "" keď null (server normalizuje)
)

@Serializable private data class ShSummaryResp(
    val summary: ShSummaryDto = ShSummaryDto(),
    val byDay: List<ShDayDto> = emptyList(),
    val recent: List<ShRecentDto> = emptyList(),
)

@Serializable private data class ShAddResp(
    val id: Int = 0,
    val soldAt: String? = null,
    val price: Double = 0.0,
    val staffId: Int = 0,
)

private interface ShApi {
    @GET("api/shisha/summary") suspend fun summary(): ShSummaryResp
    @POST("api/shisha") suspend fun record(): ShAddResp
    @DELETE("api/shisha/{id}") suspend fun delete(@Path("id") id: Int): kotlinx.serialization.json.JsonElement
}

private val shApi: ShApi by lazy { Api.create(ShApi::class.java) }

/* ---------- Formátovanie ---------- */

/** fmtCost + " €" (sub-cent adaptívny) — web parita fmtMoney(). */
private fun shMoney(v: Double): String = fmtCost(v) + " €"

private val SH_WEEKDAYS = arrayOf("Ne", "Po", "Ut", "St", "Št", "Pi", "So")

/**
 * byDay deň → "Po 07.06." — web parita fmtDate(): zostaví lokálny dátum
 * z "YYYY-MM-DD" a prefixuje slovenský deň v týždni.
 */
private fun shDayLabel(iso: String?): String {
    if (iso.isNullOrBlank()) return ""
    val parts = iso.split('-')
    if (parts.size != 3) return iso
    return try {
        val y = parts[0].toInt(); val m = parts[1].toInt(); val d = parts[2].toInt()
        val date = java.time.LocalDate.of(y, m, d)
        // LocalDate.dayOfWeek: MONDAY=1..SUNDAY=7 → index do SH_WEEKDAYS (Ne=0..So=6)
        val idx = date.dayOfWeek.value % 7
        "${SH_WEEKDAYS[idx]} ${parts[2]}.${parts[1]}."
    } catch (_: Exception) {
        iso
    }
}

/**
 * recent.soldAt → "07.06. 21:30". Web používa toLocaleString bez explicitnej
 * zóny (device tz) — natívne držíme Europe/Bratislava, aby časy sedeli so
 * serverom (DESIGN-CODE TZ pravidlo).
 */
private fun shTimeLabel(iso: String?): String = sk.surfspirit.pos.core.fmtBratislava(iso, "dd.MM. HH:mm")

/* ---------- Top-level obrazovka ---------- */

@Composable
fun ShishaScreen() {
    val toast = LocalToast.current
    val scope = rememberCoroutineScope()
    val canDelete = isManager      // manažér | admin (server navyše vynucuje)

    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }      // status line pod tlačidlom
    var data by remember { mutableStateOf<ShSummaryResp?>(null) }

    var adding by remember { mutableStateOf(false) }             // _refreshing guard (anti double-tap)
    var confirmDelete by remember { mutableStateOf<ShRecentDto?>(null) }

    fun load() {
        scope.launch {
            loading = true
            try {
                val resp = withContext(Dispatchers.IO) { shApi.summary() }
                data = resp
                error = null
            } catch (e: Exception) {
                // Web parita: chyba ide do status riadku, nie do toastu.
                error = "Chyba načítania: ${errorMessage(e)}"
            } finally {
                loading = false
            }
        }
    }
    LaunchedEffect(Unit) { load() }

    fun record() {
        if (adding) return
        adding = true
        scope.launch {
            try {
                withContext(Dispatchers.IO) { shApi.record() }
                toast.show("+1 shisha zaznamenaná")
                val resp = withContext(Dispatchers.IO) { shApi.summary() }
                data = resp
                error = null
            } catch (e: Exception) {
                toast.show("Chyba: ${errorMessage(e)}", error = true)
            } finally {
                adding = false
            }
        }
    }

    fun delete(rec: ShRecentDto) {
        scope.launch {
            try {
                withContext(Dispatchers.IO) { shApi.delete(rec.id) }
                toast.show("Záznam zmazaný")
                val resp = withContext(Dispatchers.IO) { shApi.summary() }
                data = resp
                error = null
            } catch (e: Exception) {
                toast.show("Chyba: ${errorMessage(e)}", error = true)
            }
        }
    }

    AdminScreenBox {
        AdminSectionTitle("Shisha")

        // Veľká karta s +1 tlačidlom + status riadkom (vždy viditeľná).
        ShAddCard(adding = adding, status = error, onAdd = { record() })

        Spacer(Modifier.height(16.dp))

        when {
            loading && data == null -> LoadingBox()
            data == null && error != null -> ErrorBox(error!!) { load() }
            else -> {
                val d = data ?: ShSummaryResp()
                ShCounters(d.summary)
                Spacer(Modifier.height(16.dp))
                ShByDayCard(d.byDay)
                Spacer(Modifier.height(16.dp))
                ShRecentCard(d.recent, canDelete, onDelete = { confirmDelete = it })
            }
        }
    }

    confirmDelete?.let { rec ->
        AdminConfirm(
            title = "Zmazať záznam",
            text = "Naozaj zmazať tento záznam?",
            confirmLabel = "Zmazať",
            danger = true,
            onConfirm = {
                confirmDelete = null
                delete(rec)
            },
            onDismiss = { confirmDelete = null },
        )
    }
}

/* ---------- +1 karta ---------- */

@Composable
private fun ShAddCard(adding: Boolean, status: String?, onAdd: () -> Unit) {
    AdminCard {
        Column(
            Modifier.fillMaxWidth(),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                "Predaná shisha".uppercase(),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(12.dp))
            Button(
                onClick = onAdd,
                enabled = !adding,
                shape = RoundedCornerShape(Radius.md),
                colors = ButtonDefaults.buttonColors(containerColor = Terra, contentColor = Cream),
                contentPadding = PaddingValues(horizontal = 24.dp, vertical = 12.dp),
                modifier = Modifier.fillMaxWidth().widthIn(max = 420.dp).heightIn(min = 80.dp),
            ) {
                if (adding) {
                    CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp, color = Cream)
                } else {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("+1", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                        Spacer(Modifier.width(12.dp))
                        Text("Predaná shisha ($SH_DEFAULT_PRICE €)", style = MaterialTheme.typography.titleMedium)
                    }
                }
            }
            // Status riadok — chyby načítania (web parita #shishaStatus).
            if (!status.isNullOrBlank()) {
                Spacer(Modifier.height(12.dp))
                Text(
                    status,
                    style = MaterialTheme.typography.bodySmall,
                    color = Danger,
                    textAlign = TextAlign.Center,
                )
            }
        }
    }
}

/* ---------- Počítadlá (3 karty; na telefóne 2 v riadku) ---------- */

@Composable
private fun ShCounters(summary: ShSummaryDto) {
    val cards = listOf(
        "Dnes" to summary.today,
        "Tento mesiac" to summary.month,
        "Celkovo" to summary.total,
    )
    StatGrid(cards) { (label, bucket) ->
        ShCounterCard(label, bucket, Modifier.weight(1f))
    }
}

@Composable
private fun ShCounterCard(label: String, bucket: ShBucketDto, modifier: Modifier = Modifier) {
    Surface(
        modifier.paperShadow(Elev.rest, RoundedCornerShape(Radius.md)),
        shape = RoundedCornerShape(Radius.md),
        color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, BorderSoft),
    ) {
        Column(Modifier.padding(horizontal = 14.dp, vertical = 12.dp)) {
            Text(
                label.uppercase(),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
            )
            Spacer(Modifier.height(6.dp))
            Row(verticalAlignment = Alignment.Bottom) {
                Text(
                    bucket.count.toString(),
                    style = MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 1,
                )
                Spacer(Modifier.width(4.dp))
                Text(
                    "ks",
                    style = MaterialTheme.typography.titleSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(bottom = 2.dp),
                )
            }
            Spacer(Modifier.height(4.dp))
            Text(
                shMoney(bucket.revenue),
                style = MaterialTheme.typography.bodyMedium,
                color = Terra,
                maxLines = 1,
            )
        }
    }
}

/* ---------- Predaje po dňoch (60 dní) ---------- */

@Composable
private fun ShByDayCard(byDay: List<ShDayDto>) {
    AdminCard {
        Text("Predaje po dňoch (60 dní)", style = MaterialTheme.typography.titleSmall)
        Spacer(Modifier.height(8.dp))
        TableHeader("Dátum" to 2f, "Počet" to 1f, "Tržba" to 1.4f)
        if (byDay.isEmpty()) {
            EmptyHint("Žiadne predaje za posledných 60 dní.")
        } else {
            byDay.forEach { d ->
                TableRow(
                    cells = listOf(
                        shDayLabel(d.day) to 2f,
                        "${d.count} ks" to 1f,
                        shMoney(d.revenue) to 1.4f,
                    ),
                    cellColors = listOf(null, null, EspressoSoft),
                )
            }
        }
    }
}

/* ---------- Posledných 20 záznamov ---------- */

@Composable
private fun ShRecentCard(
    recent: List<ShRecentDto>,
    canDelete: Boolean,
    onDelete: (ShRecentDto) -> Unit,
) {
    AdminCard {
        Text("Posledných 20 záznamov", style = MaterialTheme.typography.titleSmall)
        Spacer(Modifier.height(8.dp))

        // Hlavička — 4. stĺpec „Akcie" len pre manažér/admin (počet sa adaptuje).
        if (canDelete) {
            TableHeader("Čas" to 1.6f, "Predal" to 1.6f, "Cena" to 1.2f, "Akcie" to 0.8f)
        } else {
            TableHeader("Čas" to 1.6f, "Predal" to 1.6f, "Cena" to 1.2f)
        }

        if (recent.isEmpty()) {
            EmptyHint("—")
        } else {
            recent.forEach { r ->
                ShRecentRow(r, canDelete, onDelete)
            }
        }
    }
}

@Composable
private fun ShRecentRow(
    rec: ShRecentDto,
    canDelete: Boolean,
    onDelete: (ShRecentDto) -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            shTimeLabel(rec.soldAt),
            Modifier.weight(1.6f),
            style = MaterialTheme.typography.bodyMedium,
            maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
        Text(
            rec.staffName.ifBlank { "—" },
            Modifier.weight(1.6f),
            style = MaterialTheme.typography.bodyMedium,
            maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
        Text(
            shMoney(rec.price),
            Modifier.weight(1.2f),
            style = MaterialTheme.typography.bodyMedium,
            color = EspressoSoft,
            maxLines = 1,
        )
        if (canDelete) {
            Box(Modifier.weight(0.8f), contentAlignment = Alignment.CenterEnd) {
                OutlinedButton(
                    onClick = { onDelete(rec) },
                    contentPadding = PaddingValues(horizontal = 14.dp),
                    border = BorderStroke(1.dp, Danger.copy(alpha = 0.5f)),
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = Danger),
                    modifier = Modifier.heightIn(min = 44.dp),
                ) { Text("×", style = MaterialTheme.typography.titleMedium) }
            }
        }
    }
    HorizontalDivider(color = BorderSoft.copy(alpha = 0.5f))
}
