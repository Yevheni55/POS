package sk.surfspirit.pos.ui.admin.pages

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Autorenew
import androidx.compose.material.icons.outlined.LocalFireDepartment
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path
import sk.surfspirit.pos.core.errorMessage
import sk.surfspirit.pos.core.fmtBratislava
import sk.surfspirit.pos.core.fmtCost
import sk.surfspirit.pos.core.httpCode
import sk.surfspirit.pos.core.isManager
import sk.surfspirit.pos.net.Api
import sk.surfspirit.pos.ui.admin.AdminCard
import sk.surfspirit.pos.ui.admin.AdminConfirm
import sk.surfspirit.pos.ui.admin.AdminScreenBox
import sk.surfspirit.pos.ui.admin.AdminSectionTitle
import sk.surfspirit.pos.ui.admin.ErrorBox
import sk.surfspirit.pos.ui.admin.LoadingBox
import sk.surfspirit.pos.ui.admin.StatCard
import sk.surfspirit.pos.ui.components.LocalToast
import sk.surfspirit.pos.ui.theme.Amber
import sk.surfspirit.pos.ui.theme.BorderSoft
import sk.surfspirit.pos.ui.theme.Cream
import sk.surfspirit.pos.ui.theme.Danger
import sk.surfspirit.pos.ui.theme.IconSize
import sk.surfspirit.pos.ui.theme.Navy
import sk.surfspirit.pos.ui.theme.Sage

/* =====================================================================
   Storno koš — manažér rozhoduje "vrátiť na sklad vs odpísať" pre
   stornované poslané položky. Web parita: admin/pages/storno.js.
     GET    /api/storno-basket
     POST   /api/storno-basket/:id/resolve  { override:{ wasPrepared } }
     DELETE /api/storno-basket/:id
   ===================================================================== */

/* ---- DTOs (prefix St) — unitPrice je tu REÁLNE číslo (server robí Number()) ---- */
@Serializable private data class StSummaryDto(
    val pendingCount: Int = 0,
    val pendingValue: Double = 0.0,
    val rowCount: Int = 0,
)

@Serializable private data class StItemDto(
    val id: Int,
    val menuItemId: Int = 0,
    val qty: Int = 0,
    val itemName: String = "",
    val unitPrice: Double = 0.0,        // server vracia number, nie string
    val note: String = "",
    val reason: String = "",
    val wasPrepared: Boolean = false,
    val orderId: Int? = null,
    val staffId: Int? = null,
    val staffName: String = "",
    val createdAt: String = "",
)

@Serializable private data class StBasketDto(
    val summary: StSummaryDto = StSummaryDto(),
    val items: List<StItemDto> = emptyList(),
)

@Serializable private data class StOverride(val wasPrepared: Boolean)
@Serializable private data class StResolveReq(val override: StOverride)

private interface StApi {
    @GET("api/storno-basket")
    suspend fun basket(): StBasketDto

    @POST("api/storno-basket/{id}/resolve")
    suspend fun resolve(@Path("id") id: Int, @Body body: StResolveReq): JsonElement

    @DELETE("api/storno-basket/{id}")
    suspend fun delete(@Path("id") id: Int): JsonElement
}

private val stApi: StApi by lazy { Api.create(StApi::class.java) }

private val ST_REASON_LABELS = mapOf(
    "order_error" to "Chyba obj.",
    "complaint" to "Reklamácia",
    "breakage" to "Rozbité",
    "staff_meal" to "Zam. spotreba",
    "other" to "Iné",
)

private fun stEur(n: Double): String = fmtCost(n) + " €"

@Composable
fun StornoScreen() {
    val toast = LocalToast.current
    val scope = rememberCoroutineScope()
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var data by remember { mutableStateOf(StBasketDto()) }
    var busy by remember { mutableStateOf(false) }
    var confirmDeleteId by remember { mutableStateOf<Int?>(null) }
    // Potvrdenie resolve akcie (id, wasPrepared) — obe okamžite menia sklad.
    var confirmResolve by remember { mutableStateOf<Pair<Int, Boolean>?>(null) }

    fun load() {
        scope.launch {
            try {
                val res = withContext(Dispatchers.IO) { stApi.basket() }
                data = res
                error = null
            } catch (e: Exception) {
                // Web parita: pri zlyhaní vyprázdni súhrn + error toast.
                data = StBasketDto()
                if (e.httpCode() == 401) { /* session expiry rieši shell */ }
                error = errorMessage(e)
                toast.show("Chyba načítania storno koša", error = true)
            } finally {
                loading = false
            }
        }
    }

    fun resolveItem(id: Int, wasPrepared: Boolean) {
        if (busy) return
        busy = true
        scope.launch {
            try {
                withContext(Dispatchers.IO) {
                    stApi.resolve(id, StResolveReq(StOverride(wasPrepared)))
                }
                toast.show(if (wasPrepared) "Odpísané ako strata" else "Vrátené na sklad")
                load()
            } catch (e: Exception) {
                toast.show(errorMessage(e), error = true)
            } finally {
                busy = false
            }
        }
    }

    fun deleteItem(id: Int) {
        if (busy) return
        busy = true
        scope.launch {
            try {
                withContext(Dispatchers.IO) { stApi.delete(id) }
                toast.show("Záznam zmazaný")
                load()
            } catch (e: Exception) {
                toast.show(errorMessage(e), error = true)
            } finally {
                busy = false
            }
        }
    }

    LaunchedEffect(Unit) { load() }

    AdminScreenBox {
        AdminSectionTitle("Storno koš")
        when {
            loading -> LoadingBox()
            error != null && data.items.isEmpty() && data.summary.rowCount == 0 ->
                ErrorBox(error!!) { loading = true; load() }
            else -> {
                val s = data.summary
                // Súhrnné karty: počet čakajúcich (amber keď > 0) + hodnota.
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    StatCard(
                        label = "Čakajúce storná",
                        value = s.pendingCount.toString(),
                        accent = if (s.pendingCount > 0) Amber else Sage,
                        sub = if (s.pendingCount > 0) "${s.rowCount} záznamov" else "Všetko spracované",
                        subColor = if (s.pendingCount > 0) Amber else Sage,
                        modifier = Modifier.weight(1f),
                    )
                    StatCard(
                        label = "Hodnota",
                        value = stEur(s.pendingValue),
                        accent = Navy,
                        sub = "v cenách menu",
                        modifier = Modifier.weight(1f),
                    )
                }
                Spacer(Modifier.height(16.dp))

                AdminCard {
                    Row(
                        Modifier.fillMaxWidth().padding(bottom = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            "Storno — čaká na spracovanie",
                            style = MaterialTheme.typography.titleMedium,
                            modifier = Modifier.weight(1f),
                        )
                        OutlinedButton(
                            onClick = { if (!busy) load() },
                            enabled = !busy,
                        ) { Text("Obnoviť") }
                    }
                    // Vysvetľujúci riadok pre tri akcie.
                    Text(
                        buildString {
                            append("Vrátiť = suroviny späť na sklad (jedlo nebolo urobené). ")
                            append("Odpísať = jedlo už bolo urobené, ide ako strata. ")
                            append("× = záznam bol omyl, žiadna akcia skladu.")
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(bottom = 12.dp),
                    )

                    if (data.items.isEmpty()) {
                        Box(
                            Modifier.fillMaxWidth().padding(vertical = 32.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                "Žiadne čakajúce storná",
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    } else {
                        data.items.forEachIndexed { i, it ->
                            StStornoRow(
                                item = it,
                                enabled = !busy && isManager,
                                onReturn = { confirmResolve = it.id to false },
                                onWriteOff = { confirmResolve = it.id to true },
                                onDelete = { confirmDeleteId = it.id },
                            )
                            if (i < data.items.lastIndex) HorizontalDivider(color = BorderSoft.copy(alpha = 0.5f))
                        }
                    }
                }
            }
        }
    }

    confirmDeleteId?.let { id ->
        AdminConfirm(
            title = "Zmazať storno záznam?",
            text = "Záznam sa odstráni bez akcie skladu (storno bolo omyl). " +
                "Suroviny sa nevrátia ani neodpíšu.",
            confirmLabel = "Zmazať",
            danger = true,
            onConfirm = { confirmDeleteId = null; deleteItem(id) },
            onDismiss = { confirmDeleteId = null },
        )
    }

    // Resolve potvrdenie — obe akcie okamžite a nevratne menia stav skladu.
    confirmResolve?.let { (id, wasPrepared) ->
        AdminConfirm(
            title = if (wasPrepared) "Odpísať ako stratu?" else "Vrátiť na sklad?",
            text = if (wasPrepared)
                "Suroviny sa odpíšu zo skladu ako strata (jedlo už bolo pripravené). " +
                    "Akcia sa nedá vrátiť späť."
            else
                "Suroviny sa vrátia na sklad (jedlo nebolo pripravené). " +
                    "Akcia sa nedá vrátiť späť.",
            confirmLabel = if (wasPrepared) "Odpísať" else "Vrátiť",
            danger = wasPrepared,
            onConfirm = { confirmResolve = null; resolveItem(id, wasPrepared) },
            onDismiss = { confirmResolve = null },
        )
    }
}

/** Jeden záznam storno koša — viacriadková ľavá časť + 3 akčné tlačidlá vpravo. */
@Composable
private fun StStornoRow(
    item: StItemDto,
    enabled: Boolean,
    onReturn: () -> Unit,
    onWriteOff: () -> Unit,
    onDelete: () -> Unit,
) {
    val pricedQty = item.unitPrice * item.qty
    val reasonLabel = ST_REASON_LABELS[item.reason] ?: item.reason
    Row(
        Modifier.fillMaxWidth().padding(vertical = 10.dp),
        verticalAlignment = Alignment.Top,
    ) {
        // Ľavý blok — položka, dôvod, čašník, čas, poznámka, suma.
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    item.itemName,
                    style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Bold),
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                Text(
                    " ×${item.qty}",
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Spacer(Modifier.height(2.dp))
            // Pôvodný úsudok čašníka (amber = pripravené, indigo = nepripravené).
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    if (item.wasPrepared) Icons.Outlined.LocalFireDepartment else Icons.Outlined.Autorenew,
                    contentDescription = null,
                    tint = if (item.wasPrepared) Amber else INDIGO,
                    modifier = Modifier.size(IconSize.sm),
                )
                Spacer(Modifier.width(4.dp))
                Text(
                    if (item.wasPrepared) "Čašník: pripravené" else "Čašník: nepripravené",
                    style = MaterialTheme.typography.labelSmall,
                    color = if (item.wasPrepared) Amber else INDIGO,
                )
            }
            Spacer(Modifier.height(6.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                StMeta("Dôvod", reasonLabel.ifBlank { "—" })
                StMeta("Čašník", item.staffName.ifBlank { "—" })
                StMeta("Čas", fmtBratislava(item.createdAt))
            }
            Spacer(Modifier.height(4.dp))
            StMeta("Poznámka", item.note.ifBlank { "—" })
            Spacer(Modifier.height(4.dp))
            Text(
                stEur(pricedQty),
                style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.Bold),
            )
        }

        Spacer(Modifier.width(10.dp))

        // Akčné tlačidlá — vertikálne, tap target ≥ 44dp; 12dp medzera, aby
        // „Vrátiť" a „Odpísať" neboli tesne susediace rovnaké ciele.
        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Button(
                onClick = onReturn,
                enabled = enabled,
                colors = ButtonDefaults.buttonColors(containerColor = Sage, contentColor = Cream),
                contentPadding = PaddingValues(horizontal = 14.dp, vertical = 10.dp),
                modifier = Modifier.heightIn(min = 44.dp),
            ) {
                Icon(Icons.Outlined.Autorenew, contentDescription = null, modifier = Modifier.size(IconSize.md))
                Spacer(Modifier.width(6.dp))
                Text("Vrátiť")
            }
            Button(
                onClick = onWriteOff,
                enabled = enabled,
                colors = ButtonDefaults.buttonColors(containerColor = Danger, contentColor = Cream),
                contentPadding = PaddingValues(horizontal = 14.dp, vertical = 10.dp),
                modifier = Modifier.heightIn(min = 44.dp),
            ) {
                Icon(Icons.Outlined.LocalFireDepartment, contentDescription = null, modifier = Modifier.size(IconSize.md))
                Spacer(Modifier.width(6.dp))
                Text("Odpísať")
            }
            OutlinedButton(
                onClick = onDelete,
                enabled = enabled,
                border = BorderStroke(1.dp, BorderSoft),
                contentPadding = PaddingValues(horizontal = 18.dp, vertical = 10.dp),
                modifier = Modifier.heightIn(min = 44.dp),
            ) { Text("×", color = MaterialTheme.colorScheme.onSurface) }
        }
    }
}

@Composable
private fun StMeta(label: String, value: String) {
    Column {
        Text(
            label.uppercase(),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            value,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurface,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

// Indigo pre "nepripravené" úsudok čašníka — web #4338ca (mimo palety, lokálne).
private val INDIGO = Color(0xFF4338CA)
