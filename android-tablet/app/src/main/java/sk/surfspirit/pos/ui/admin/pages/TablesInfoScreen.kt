package sk.surfspirit.pos.ui.admin.pages

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.PATCH
import retrofit2.http.POST
import retrofit2.http.Path
import sk.surfspirit.pos.core.errorMessage
import sk.surfspirit.pos.core.isManager
import sk.surfspirit.pos.net.Api
import sk.surfspirit.pos.ui.admin.*
import sk.surfspirit.pos.ui.components.LocalToast
import sk.surfspirit.pos.ui.theme.*

/* =====================================================================
   Stoly (info) — natívny ekvivalent admin/pages/tables.js, ale len
   vysvetľujúca časť + správa zón.

   Plný floor-plan editor (drag / resize / uloženie pozícií) už existuje
   natívne v FloorScreen edit-móde, takže ho tu NEduplikujeme — namiesto
   toho ponúkame veľké tlačidlo „Otvoriť plán stolov" (callback) + natívnu
   správu zón (zoznam / pridať / premenovať), ktorá vo FloorScreen nie je.

   Endpointy zón (server/routes/zones.js):
     GET   /api/zones            → [{ slug, label, sortOrder }]  (.catch → [])
     POST  /api/zones            → upsert na slug (manazer|admin)
     PATCH /api/zones/:slug      → premenuje len label (manazer|admin)
   Mutácie sú role-gateované (server requireRole) — pre čašníka skryjeme akcie.
   ===================================================================== */

/* ---------- DTOs (prefix Tin) — sortOrder je reálny INTEGER (number) ---------- */

@Serializable private data class TinZoneDto(
    val slug: String = "",
    val label: String = "",
    val sortOrder: Int = 0,
)

@Serializable private data class TinZoneCreateReq(
    val slug: String,
    val label: String,
    val sortOrder: Int? = null,
)

@Serializable private data class TinZoneLabelReq(
    val label: String,
)

private interface TinApi {
    @GET("api/zones") suspend fun zones(): List<TinZoneDto>
    @POST("api/zones") suspend fun addZone(@Body body: TinZoneCreateReq): TinZoneDto
    @PATCH("api/zones/{slug}") suspend fun renameZone(@Path("slug") slug: String, @Body body: TinZoneLabelReq): TinZoneDto
}

private val tinApi: TinApi by lazy { Api.create(TinApi::class.java) }

/** Web parita: id = name.toLowerCase().replace(/[^a-z0-9]/g, '_'). */
private fun tinSlugify(name: String): String =
    name.lowercase().replace(Regex("[^a-z0-9]"), "_")

/* ---------- Top-level obrazovka ---------- */

@Composable
fun TablesInfoScreen(onOpenFloorEdit: () -> Unit) {
    val toast = LocalToast.current
    val scope = rememberCoroutineScope()
    val canManage = isManager   // server requireRole('manazer','admin') — čašník je read-only

    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var zones by remember { mutableStateOf<List<TinZoneDto>>(emptyList()) }

    var addOpen by remember { mutableStateOf(false) }
    var renaming by remember { mutableStateOf<TinZoneDto?>(null) }

    fun load() {
        scope.launch {
            loading = true
            try {
                val rows = withContext(Dispatchers.IO) { tinApi.zones() }
                // Web triedi podľa sortOrder asc, slug asc (server to už robí, ale
                // pri lokálnom append po POST chceme deterministické poradie).
                zones = rows.sortedWith(compareBy({ it.sortOrder }, { it.slug }))
                error = null
            } catch (e: Exception) {
                error = errorMessage(e)
            } finally {
                loading = false
            }
        }
    }
    LaunchedEffect(Unit) { load() }

    AdminScreenBox {
        AdminSectionTitle("Stoly")

        // ---- Vysvetľujúca karta + CTA na natívny floor editor ----
        TinFloorInfoCard(onOpenFloorEdit = onOpenFloorEdit)

        Spacer(Modifier.height(20.dp))

        // ---- Správa zón ----
        AdminSectionTitle(
            "Zóny",
            action = {
                if (canManage) {
                    Button(
                        onClick = { addOpen = true },
                        colors = ButtonDefaults.buttonColors(containerColor = Terra, contentColor = Cream),
                        modifier = Modifier.heightIn(min = 44.dp),
                    ) { Text("+ Pridať zónu") }
                }
            },
        )

        when {
            loading -> LoadingBox()
            error != null -> ErrorBox(error!!) { load() }
            zones.isEmpty() -> EmptyHint("🗺️  Žiadne zóny")
            else -> {
                AdminCard {
                    TableHeader("Zóna" to 2.4f, "Slug" to 1.6f, "" to 1f)
                    zones.forEach { z ->
                        TinZoneRow(
                            zone = z,
                            canManage = canManage,
                            onRename = { renaming = z },
                        )
                    }
                }
                Spacer(Modifier.height(8.dp))
                Text(
                    "Slug je trvalý identifikátor zóny (zapísaný na každom stole) — meniť sa dá len názov.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }

    /* ---- Pridať zónu ---- */
    if (addOpen) {
        TinAddZoneDialog(
            onDismiss = { addOpen = false },
            onValidate = { name ->
                // Lokálne odmietni duplicitný slug (web: showToast('Zona uz existuje')).
                val slug = tinSlugify(name)
                if (slug.isBlank()) "Neplatný názov zóny"
                else if (zones.any { it.slug == slug }) "Zóna už existuje"
                else null
            },
            onSubmit = { name ->
                // Persist-before-state (web): POST najprv, potom append do zoznamu.
                scope.launch {
                    val slug = tinSlugify(name)
                    try {
                        val created = withContext(Dispatchers.IO) {
                            tinApi.addZone(
                                TinZoneCreateReq(
                                    slug = slug,
                                    label = name,
                                    sortOrder = (zones.size + 1) * 100,
                                )
                            )
                        }
                        addOpen = false
                        zones = (zones + created).sortedWith(compareBy({ it.sortOrder }, { it.slug }))
                        toast.show("Zóna pridaná")
                    } catch (e: Exception) {
                        toast.show(errorMessage(e), error = true)
                    }
                }
            },
        )
    }

    /* ---- Premenovať zónu (PATCH /zones/:slug) ---- */
    renaming?.let { z ->
        TinRenameZoneDialog(
            zone = z,
            onDismiss = { renaming = null },
            onSubmit = { newLabel ->
                scope.launch {
                    try {
                        val updated = withContext(Dispatchers.IO) {
                            tinApi.renameZone(z.slug, TinZoneLabelReq(label = newLabel))
                        }
                        renaming = null
                        zones = zones.map { if (it.slug == z.slug) it.copy(label = updated.label) else it }
                        toast.show("Zóna premenovaná")
                    } catch (e: Exception) {
                        toast.show(errorMessage(e), error = true)
                    }
                }
            },
        )
    }
}

/* ---------- Floor info karta ---------- */

@Composable
private fun TinFloorInfoCard(onOpenFloorEdit: () -> Unit) {
    AdminCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier.size(48.dp).background(Terra.copy(alpha = 0.14f), CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Text("🪑", style = MaterialTheme.typography.titleLarge)
            }
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Text("Plán stolov", style = MaterialTheme.typography.titleSmall)
                Spacer(Modifier.height(2.dp))
                Text(
                    "Rozloženie stolov upravíš priamo na pláne — presúvanie, veľkosť aj pridanie či odstránenie stola.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        Spacer(Modifier.height(14.dp))

        Button(
            onClick = onOpenFloorEdit,
            colors = ButtonDefaults.buttonColors(containerColor = Terra, contentColor = Cream),
            modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp),
            shape = RoundedCornerShape(Radius.md),
        ) {
            Text("Otvoriť plán stolov", style = MaterialTheme.typography.titleSmall)
        }

        Spacer(Modifier.height(10.dp))

        Text(
            "Tip: na pláne stolov zapni úpravový režim, presuň stoly prstom a zmeny sa uložia automaticky.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/* ---------- Riadok zóny ---------- */

@Composable
private fun TinZoneRow(
    zone: TinZoneDto,
    canManage: Boolean,
    onRename: () -> Unit,
) {
    val rowMod = Modifier.fillMaxWidth().padding(vertical = 8.dp)
    Row(rowMod, verticalAlignment = Alignment.CenterVertically) {
        Text(
            zone.label.ifBlank { "—" },
            Modifier.weight(2.4f),
            style = MaterialTheme.typography.bodyMedium,
            maxLines = 1,
        )
        Text(
            zone.slug,
            Modifier.weight(1.6f),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            fontFamily = FontFamily.Monospace,
            maxLines = 1,
        )
        Box(Modifier.weight(1f), contentAlignment = Alignment.CenterEnd) {
            if (canManage) {
                TextButton(onClick = onRename, modifier = Modifier.heightIn(min = 44.dp)) {
                    Text("Premenovať", color = Navy)
                }
            }
        }
    }
    HorizontalDivider(color = BorderSoft.copy(alpha = 0.5f))
}

/* ---------- Pridať zónu (dialóg) ---------- */

@Composable
private fun TinAddZoneDialog(
    onDismiss: () -> Unit,
    onValidate: (String) -> String?,   // vráti chybu alebo null
    onSubmit: (String) -> Unit,
) {
    var name by remember { mutableStateOf("") }
    var localError by remember { mutableStateOf<String?>(null) }

    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(
            Modifier.fillMaxWidth(0.92f).widthIn(max = 480.dp),
            shape = RoundedCornerShape(Radius.md),
            color = MaterialTheme.colorScheme.surface,
            border = BorderStroke(1.dp, BorderSoft),
        ) {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Pridať zónu", style = MaterialTheme.typography.titleMedium)

                FormField(
                    "Názov zóny *",
                    name,
                    { name = it.take(50); localError = null },
                    placeholder = "napr. Terasa",
                )
                localError?.let {
                    Text(it, style = MaterialTheme.typography.bodySmall, color = Danger)
                }

                Spacer(Modifier.height(2.dp))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    TextButton(onClick = onDismiss) { Text("Zrušiť") }
                    Spacer(Modifier.width(8.dp))
                    Button(
                        onClick = {
                            val nm = name.trim()
                            if (nm.isBlank()) { localError = "Názov zóny je povinný"; return@Button }
                            val err = onValidate(nm)
                            if (err != null) { localError = err; return@Button }
                            onSubmit(nm)
                        },
                        colors = ButtonDefaults.buttonColors(containerColor = Terra, contentColor = Cream),
                    ) { Text("Uložiť") }
                }
            }
        }
    }
}

/* ---------- Premenovať zónu (dialóg) ---------- */

@Composable
private fun TinRenameZoneDialog(
    zone: TinZoneDto,
    onDismiss: () -> Unit,
    onSubmit: (String) -> Unit,
) {
    var label by remember { mutableStateOf(zone.label) }
    var localError by remember { mutableStateOf<String?>(null) }

    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(
            Modifier.fillMaxWidth(0.92f).widthIn(max = 480.dp),
            shape = RoundedCornerShape(Radius.md),
            color = MaterialTheme.colorScheme.surface,
            border = BorderStroke(1.dp, BorderSoft),
        ) {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Premenovať zónu", style = MaterialTheme.typography.titleMedium)
                Text(
                    "Slug ostáva: ${zone.slug}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                FormField(
                    "Nový názov *",
                    label,
                    { label = it.take(50); localError = null },   // server limituje label na 50 znakov
                    placeholder = "Názov zóny",
                )
                localError?.let {
                    Text(it, style = MaterialTheme.typography.bodySmall, color = Danger)
                }

                Spacer(Modifier.height(2.dp))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    TextButton(onClick = onDismiss) { Text("Zrušiť") }
                    Spacer(Modifier.width(8.dp))
                    Button(
                        onClick = {
                            val lbl = label.trim()
                            if (lbl.isBlank()) { localError = "Názov je povinný"; return@Button }
                            onSubmit(lbl)
                        },
                        colors = ButtonDefaults.buttonColors(containerColor = Terra, contentColor = Cream),
                    ) { Text("Uložiť") }
                }
            }
        }
    }
}
