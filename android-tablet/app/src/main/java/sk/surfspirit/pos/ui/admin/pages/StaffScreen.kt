package sk.surfspirit.pos.ui.admin.pages

import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.PUT
import retrofit2.http.Path
import sk.surfspirit.pos.core.AppPrefs
import sk.surfspirit.pos.core.errorMessage
import sk.surfspirit.pos.core.fmtCost
import sk.surfspirit.pos.net.Api
import sk.surfspirit.pos.ui.admin.*
import sk.surfspirit.pos.ui.components.LocalToast
import sk.surfspirit.pos.ui.theme.*
import kotlin.random.Random

/* =====================================================================
   Zamestnanci (Ľudia > Zamestnanci) — natívny ekvivalent admin/pages/staff.js.
   Zoznam ľudí (meno, rola, stav, PIN cez pins-visible toggle pre admin/manažér),
   pridanie/úprava cez modal, deaktivácia/aktivácia s potvrdením.
   Mutácie (Pridať/Upraviť/Stav) sú gateované na rolu admin; manažér môže len
   prezerať + odhaliť PIN-y (server to navyše vynucuje requireRole).
   ===================================================================== */

/* ---------- DTOs (prefix Stf) — Drizzle numeric stĺpce sú STRING ---------- */

@Serializable private data class StfStaffDto(
    val id: Int,
    val name: String = "",
    val role: String = "cisnik",            // admin | manazer | cisnik
    val active: Boolean = true,
    val position: String = "",
    val hourlyRate: String? = null,         // Drizzle numeric → STRING (napr. "6.50") alebo null
    val hasPin: Boolean = true,
    val hasAttendancePin: Boolean = false,
    val createdAt: String? = null,
)

@Serializable private data class StfPinDto(
    val id: Int,
    val name: String = "",
    val pin: String? = null,                // plain POS PIN alebo null (pred migráciou)
    val attendancePin: String? = null,
)

// Mutačné telo — null-y vynechá explicitNulls=false (= "neposielaj / nechaj pôvodné").
@Serializable private data class StfStaffReq(
    val name: String? = null,
    val pin: String? = null,
    val role: String? = null,
    val active: Boolean? = null,
    val position: String? = null,
    val hourlyRate: String? = null,
    val attendancePin: String? = null,
)

private interface StfApi {
    @GET("api/staff") suspend fun list(): List<StfStaffDto>
    @GET("api/staff/pins-visible") suspend fun pinsVisible(): List<StfPinDto>
    @POST("api/staff") suspend fun add(@Body body: StfStaffReq): StfStaffDto
    @PUT("api/staff/{id}") suspend fun update(@Path("id") id: Int, @Body body: StfStaffReq): StfStaffDto
}

private val stfApi: StfApi by lazy { Api.create(StfApi::class.java) }

private fun stfRoleLabel(role: String): String = when (role) {
    "admin" -> "Admin"
    "manazer" -> "Manažér"
    "cisnik" -> "Čašník"
    else -> role
}

private fun stfRoleColor(role: String): Color = when (role) {
    "admin" -> Terra
    "manazer" -> Navy
    else -> Sage
}

private fun stfInitials(name: String): String {
    val parts = name.trim().split(Regex("\\s+")).filter { it.isNotBlank() }
    val first = parts.getOrNull(0)?.firstOrNull()?.uppercaseChar() ?: '?'
    val second = parts.getOrNull(1)?.firstOrNull()?.uppercaseChar()
    return if (second != null) "$first$second" else "$first"
}

private fun stfGenPin(): String = (1000 + Random.nextInt(9000)).toString()

/* ---------- Top-level obrazovka ---------- */

@Composable
fun StaffScreen() {
    val toast = LocalToast.current
    val scope = rememberCoroutineScope()
    val isAdmin = AppPrefs.role == "admin"
    val canRevealPins = AppPrefs.role == "admin" || AppPrefs.role == "manazer"

    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var staff by remember { mutableStateOf<List<StfStaffDto>>(emptyList()) }

    var search by remember { mutableStateOf("") }
    var roleFilter by remember { mutableStateOf("") }     // "" = všetky

    // PIN odhalenie: per-card set + master toggle; _pinMap lazy-loaded raz.
    var revealed by remember { mutableStateOf(setOf<Int>()) }
    var showAll by remember { mutableStateOf(false) }
    var pinMap by remember { mutableStateOf<Map<Int, String?>?>(null) }
    var pinsLoading by remember { mutableStateOf(false) }

    var editorOpen by remember { mutableStateOf(false) }
    var editing by remember { mutableStateOf<StfStaffDto?>(null) }   // null = pridanie
    var confirmFor by remember { mutableStateOf<StfStaffDto?>(null) }

    fun load() {
        scope.launch {
            loading = true
            try {
                val rows = withContext(Dispatchers.IO) { stfApi.list() }
                staff = rows
                error = null
            } catch (e: Exception) {
                error = errorMessage(e)
            } finally {
                loading = false
            }
        }
    }
    LaunchedEffect(Unit) { load() }

    // Lazy-load mapy plain PIN-ov (admin/manažér); vracia true pri úspechu.
    suspend fun ensurePinMap(): Boolean {
        if (pinMap != null) return true
        return try {
            val rows = withContext(Dispatchers.IO) { stfApi.pinsVisible() }
            pinMap = rows.associate { it.id to it.pin }
            true
        } catch (e: Exception) {
            toast.show(errorMessage(e), error = true)
            false
        }
    }

    fun togglePin(id: Int) {
        if (id in revealed) {
            revealed = revealed - id
            return
        }
        revealed = revealed + id
        if (pinMap == null) {
            scope.launch { if (!ensurePinMap()) revealed = revealed - id }
        }
    }

    fun toggleAllPins() {
        if (showAll) { showAll = false; return }
        scope.launch {
            pinsLoading = true
            try {
                if (ensurePinMap()) showAll = true
            } finally {
                pinsLoading = false
            }
        }
    }

    val filtered = remember(staff, search, roleFilter) {
        val q = search.trim().lowercase()
        staff.filter { e ->
            (q.isBlank() || e.name.lowercase().contains(q)) &&
                (roleFilter.isBlank() || e.role == roleFilter)
        }
    }

    AdminScreenBox(scrollable = false) {
        AdminSectionTitle("Zamestnanci")

        // Top bar: pridať (admin) + hľadanie + filter rolí + master PIN toggle.
        StfTopBar(
            isAdmin = isAdmin,
            canRevealPins = canRevealPins,
            search = search, onSearch = { search = it },
            roleFilter = roleFilter, onRoleFilter = { roleFilter = it },
            showAll = showAll, pinsLoading = pinsLoading,
            onAdd = { editing = null; editorOpen = true },
            onToggleAll = { toggleAllPins() },
        )
        Spacer(Modifier.height(12.dp))

        when {
            loading -> LoadingBox()
            error != null -> ErrorBox(error!!) { load() }
            staff.isEmpty() -> EmptyHint("Žiadni zamestnanci")
            filtered.isEmpty() -> EmptyHint("Žiadne výsledky")
            else -> {
                // LazyColumn — zoznam môže prerásť výšku obrazovky (scroll + lazy riadky).
                LazyColumn(
                    Modifier.weight(1f).fillMaxWidth(),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    items(filtered, key = { it.id }) { e ->
                        val isRevealed = showAll || e.id in revealed
                        StfStaffRow(
                            staff = e,
                            isAdmin = isAdmin,
                            canRevealPins = canRevealPins,
                            revealed = isRevealed,
                            pinMap = pinMap,
                            onTogglePin = { togglePin(e.id) },
                            onEdit = { editing = e; editorOpen = true },
                            onToggleStatus = { confirmFor = e },
                        )
                    }
                }
            }
        }
    }

    if (editorOpen) {
        StfStaffEditor(
            existing = editing,
            onDismiss = { editorOpen = false },
            onSaved = { isEdit ->
                editorOpen = false
                toast.show(if (isEdit) "Zamestnanec upravený" else "Zamestnanec pridaný")
                // Po zmene PIN-u môže byť mapa zastaraná — vynuluj, nech sa znovu načíta.
                pinMap = null; revealed = emptySet(); showAll = false
                load()
            },
            onError = { msg -> toast.show(msg, error = true) },
        )
    }

    confirmFor?.let { emp ->
        val deact = emp.active
        AdminConfirm(
            title = if (deact) "Deaktivovať zamestnanca" else "Aktivovať zamestnanca",
            text = "Naozaj chcete zmeniť stav zamestnanca ${emp.name}?",
            confirmLabel = if (deact) "Deaktivovať" else "Aktivovať",
            danger = deact,
            onConfirm = {
                confirmFor = null
                scope.launch {
                    try {
                        withContext(Dispatchers.IO) {
                            stfApi.update(emp.id, StfStaffReq(active = !emp.active))
                        }
                        staff = staff.map { if (it.id == emp.id) it.copy(active = !it.active) else it }
                        toast.show(emp.name + if (!emp.active) " aktivovaný" else " deaktivovaný")
                    } catch (e: Exception) {
                        toast.show("Chyba: ${errorMessage(e)}", error = true)
                    }
                }
            },
            onDismiss = { confirmFor = null },
        )
    }
}

/* ---------- Top bar ---------- */

@Composable
private fun StfTopBar(
    isAdmin: Boolean,
    canRevealPins: Boolean,
    search: String,
    onSearch: (String) -> Unit,
    roleFilter: String,
    onRoleFilter: (String) -> Unit,
    showAll: Boolean,
    pinsLoading: Boolean,
    onAdd: () -> Unit,
    onToggleAll: () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        FlowRowActions {
            if (isAdmin) {
                Button(
                    onClick = onAdd,
                    colors = ButtonDefaults.buttonColors(containerColor = Terra, contentColor = Cream),
                    modifier = Modifier.heightIn(min = 44.dp),
                ) { Text("+ Pridať zamestnanca") }
            } else {
                // Read-only režim — mutácie sú len pre admina (server requireRole).
                Text(
                    "Úpravy len pre admina",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (canRevealPins) {
                val active = showAll
                OutlinedButton(
                    onClick = onToggleAll,
                    enabled = !pinsLoading,
                    border = BorderStroke(1.dp, if (active) Terra else BorderMid),
                    colors = ButtonDefaults.outlinedButtonColors(
                        contentColor = if (active) Terra else MaterialTheme.colorScheme.onSurface,
                        containerColor = if (active) Terra.copy(alpha = 0.08f) else Color.Transparent,
                    ),
                    modifier = Modifier.heightIn(min = 44.dp),
                ) {
                    if (pinsLoading) {
                        CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = Terra)
                        Spacer(Modifier.width(8.dp))
                    }
                    Text(if (showAll) "Skryť PIN-y" else "Zobraziť PIN-y")
                }
            }
        }
        OutlinedTextField(
            value = search, onValueChange = onSearch,
            placeholder = { Text("Hľadať podľa mena...") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        // Role filter — pill riadok (Všetky / Admin / Manažér / Čašník).
        val roleOptions = listOf("" to "Všetky role", "admin" to "Admin", "manazer" to "Manažér", "cisnik" to "Čašník")
        FlowRowActions {
            roleOptions.forEach { (value, label) ->
                val sel = roleFilter == value
                Surface(
                    onClick = { onRoleFilter(value) },
                    shape = RoundedCornerShape(Radius.full),
                    color = if (sel) Terra else MaterialTheme.colorScheme.surface,
                    border = BorderStroke(1.dp, if (sel) Terra else BorderSoft),
                ) {
                    Text(
                        label, Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
                        color = if (sel) Cream else MaterialTheme.colorScheme.onSurface,
                        style = MaterialTheme.typography.labelMedium,
                    )
                }
            }
        }
    }
}

/** Jednoduchý wrap riadok akcií (bez experimentálneho FlowRow API). */
@Composable
private fun FlowRowActions(content: @Composable RowScope.() -> Unit) {
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
        content = content,
    )
}

/* ---------- Riadok zamestnanca (karta) ---------- */

@Composable
private fun StfStaffRow(
    staff: StfStaffDto,
    isAdmin: Boolean,
    canRevealPins: Boolean,
    revealed: Boolean,
    pinMap: Map<Int, String?>?,
    onTogglePin: () -> Unit,
    onEdit: () -> Unit,
    onToggleStatus: () -> Unit,
) {
    AdminCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            // Avatar s iniciálami, zafarbený podľa role.
            val rc = stfRoleColor(staff.role)
            Box(
                Modifier.size(44.dp).background(rc.copy(alpha = 0.15f), CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Text(stfInitials(staff.name), color = rc,
                    style = MaterialTheme.typography.titleSmall)
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(staff.name.ifBlank { "—" },
                    style = MaterialTheme.typography.titleSmall, maxLines = 1)
                Spacer(Modifier.height(4.dp))
                Row(verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    StatusBadge(stfRoleLabel(staff.role), rc)
                    val statusColor = if (staff.active) Sage else EspressoDim
                    Box(Modifier.size(8.dp).background(statusColor, CircleShape))
                    Text(if (staff.active) "Aktívny" else "Neaktívny",
                        style = MaterialTheme.typography.labelMedium, color = statusColor)
                    if (staff.hasAttendancePin) StatusBadge("Dochádzka PIN", Sage)
                }
            }
        }

        Spacer(Modifier.height(10.dp))

        // PIN riadok — masked / plain / reset-hint / placeholder + eye toggle.
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("PIN:", style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.width(8.dp))
            if (revealed && canRevealPins) {
                if (pinMap == null) {
                    Text("…", style = MaterialTheme.typography.bodyMedium,
                        color = EspressoDim, fontWeight = FontWeight.Normal)
                } else {
                    val plain = pinMap[staff.id]
                    if (plain != null) {
                        Text(plain, fontFamily = FontFamily.Monospace,
                            fontWeight = FontWeight.SemiBold, color = Terra,
                            style = MaterialTheme.typography.bodyLarge)
                    } else {
                        Text("PIN treba resetovať (klik Upraviť)",
                            style = MaterialTheme.typography.labelMedium, color = Amber)
                    }
                }
            } else {
                Text("●●●●", style = MaterialTheme.typography.bodyMedium)
            }
            if (canRevealPins) {
                Spacer(Modifier.weight(1f))
                TextButton(onClick = onTogglePin, modifier = Modifier.heightIn(min = 44.dp)) {
                    Text(if (revealed) "Skryť" else "Zobraziť", color = Navy)
                }
            }
        }

        // Pozícia + hodinovka (fmtCost adaptívny, sub-cent).
        val rate = staff.hourlyRate?.toDoubleOrNull()
        val ratePart = rate?.let { "${fmtCost(it)} €/h" }
        val posLine = when {
            staff.position.isNotBlank() && ratePart != null -> "${staff.position} · $ratePart"
            staff.position.isNotBlank() -> staff.position
            ratePart != null -> ratePart
            else -> null
        }
        posLine?.let {
            Spacer(Modifier.height(4.dp))
            Text(it, style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }

        // Akcie — len pre admin (server vynucuje requireRole('admin')).
        if (isAdmin) {
            Spacer(Modifier.height(12.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = onEdit, modifier = Modifier.heightIn(min = 44.dp)) {
                    Text("Upraviť")
                }
                if (staff.active) {
                    OutlinedButton(
                        onClick = onToggleStatus,
                        border = BorderStroke(1.dp, Danger.copy(alpha = 0.5f)),
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = Danger),
                        modifier = Modifier.heightIn(min = 44.dp),
                    ) { Text("Deaktivovať") }
                } else {
                    Button(
                        onClick = onToggleStatus,
                        colors = ButtonDefaults.buttonColors(containerColor = Sage, contentColor = Cream),
                        modifier = Modifier.heightIn(min = 44.dp),
                    ) { Text("Aktivovať") }
                }
            }
        }
    }
}

/* ---------- Editor (Pridať / Upraviť) ---------- */

@Composable
private fun StfStaffEditor(
    existing: StfStaffDto?,
    onDismiss: () -> Unit,
    onSaved: (isEdit: Boolean) -> Unit,
    onError: (String) -> Unit,
) {
    val scope = rememberCoroutineScope()
    val isEdit = existing != null

    var name by remember { mutableStateOf(existing?.name ?: "") }
    var role by remember { mutableStateOf(existing?.role ?: "cisnik") }
    var pin by remember { mutableStateOf("") }
    var position by remember { mutableStateOf(existing?.position ?: "") }
    var hourlyRate by remember { mutableStateOf(existing?.hourlyRate ?: "") }
    var attendancePin by remember { mutableStateOf("") }
    var active by remember { mutableStateOf(existing?.active ?: true) }
    var saving by remember { mutableStateOf(false) }

    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(
            Modifier.fillMaxWidth(0.92f).widthIn(max = 520.dp),
            shape = RoundedCornerShape(Radius.md),
            color = MaterialTheme.colorScheme.surface,
            border = BorderStroke(1.dp, BorderSoft),
        ) {
            Column(
                Modifier.padding(20.dp).verticalScrollSafe(),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Text(
                    if (isEdit) "Upraviť zamestnanca" else "Pridať zamestnanca",
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.fillMaxWidth(),
                )

                FormField("Meno *", name, { name = it },
                    placeholder = "Meno (alebo Meno Priezvisko)")

                // Rola — segmenty (admin / manazer / cisnik).
                Column {
                    Text("Rola", style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.height(4.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf("admin", "manazer", "cisnik").forEach { r ->
                            val sel = role == r
                            Surface(
                                onClick = { role = r },
                                shape = RoundedCornerShape(Radius.full),
                                color = if (sel) Terra else MaterialTheme.colorScheme.surface,
                                border = BorderStroke(1.dp, if (sel) Terra else BorderSoft),
                            ) {
                                Text(stfRoleLabel(r),
                                    Modifier.padding(horizontal = 14.dp, vertical = 9.dp),
                                    color = if (sel) Cream else MaterialTheme.colorScheme.onSurface,
                                    style = MaterialTheme.typography.labelMedium)
                            }
                        }
                    }
                }

                // PIN kód + Generovať.
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.Bottom) {
                    FormField(
                        if (isEdit) "PIN kód" else "PIN kód *",
                        pin, { v -> pin = v.filter { it.isDigit() }.take(6) },
                        placeholder = if (isEdit) "Vyplňte len pri zmene" else "4 číslice",
                        keyboard = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                        modifier = Modifier.weight(1f),
                    )
                    OutlinedButton(onClick = { pin = stfGenPin() },
                        modifier = Modifier.heightIn(min = 56.dp)) { Text("Generovať") }
                }

                FormField("Pozícia", position, { position = it.take(50) },
                    placeholder = "napr. Čašník")

                FormField("Hodinová sadzba (EUR)", hourlyRate,
                    { v -> hourlyRate = v.filter { it.isDigit() || it == '.' || it == ',' }.replace(',', '.') },
                    placeholder = "0.00",
                    keyboard = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                    suffix = "€/h")

                Column {
                    FormField("Dochádzka PIN (4-6 cifier)", attendancePin,
                        { v -> attendancePin = v.filter { it.isDigit() }.take(6) },
                        placeholder = "Nastaviť / zmeniť",
                        keyboard = KeyboardOptions(keyboardType = KeyboardType.NumberPassword))
                    val hint = when {
                        existing?.hasAttendancePin == true -> "PIN je nastavený — vyplňte len ak chcete zmeniť"
                        isEdit -> "PIN nie je nastavený"
                        else -> ""
                    }
                    if (hint.isNotBlank()) {
                        Spacer(Modifier.height(4.dp))
                        Text(hint, style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }

                // Stav toggle.
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Stav: ", style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.width(8.dp))
                    Switch(checked = active, onCheckedChange = { active = it },
                        colors = SwitchDefaults.colors(checkedThumbColor = Cream, checkedTrackColor = Sage))
                    Spacer(Modifier.width(8.dp))
                    Text(if (active) "Aktívny" else "Neaktívny",
                        style = MaterialTheme.typography.bodyMedium)
                }

                Spacer(Modifier.height(4.dp))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    TextButton(onClick = onDismiss, enabled = !saving) { Text("Zrušiť") }
                    Spacer(Modifier.width(8.dp))
                    Button(
                        onClick = onClick@{
                            // Klientská validácia (server zod tiež vynucuje).
                            val nm = name.trim()
                            if (nm.isBlank()) { onError("Meno je povinné"); return@onClick }
                            if (!isEdit && pin.length < 4) { onError("PIN musí mať 4-6 číslic"); return@onClick }
                            if (pin.isNotEmpty() && pin.length < 4) { onError("PIN musí mať 4-6 číslic"); return@onClick }
                            if (attendancePin.isNotEmpty() && attendancePin.length < 4) {
                                onError("Dochádzka PIN musí mať 4-6 číslic"); return@onClick
                            }
                            saving = true
                            scope.launch {
                                try {
                                    val body = StfStaffReq(
                                        name = nm,
                                        role = role,
                                        active = active,
                                        position = position.trim(),
                                        // posielame len ak vyplnené (explicitNulls=false vynechá null)
                                        pin = pin.ifBlank { null },
                                        hourlyRate = hourlyRate.trim().ifBlank { null },
                                        attendancePin = attendancePin.ifBlank { null },
                                    )
                                    withContext(Dispatchers.IO) {
                                        if (isEdit) stfApi.update(existing!!.id, body) else stfApi.add(body)
                                    }
                                    onSaved(isEdit)
                                } catch (e: Exception) {
                                    onError(errorMessage(e))
                                } finally {
                                    saving = false
                                }
                            }
                        },
                        enabled = !saving,
                        colors = ButtonDefaults.buttonColors(containerColor = Terra, contentColor = Cream),
                    ) {
                        if (saving) {
                            CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = Cream)
                            Spacer(Modifier.width(8.dp))
                        }
                        Text("Uložiť")
                    }
                }
            }
        }
    }
}

/** Vertikálny scroll v modale (dlhý formulár nesmie klipnúť na malej výške). */
@Composable
private fun Modifier.verticalScrollSafe(): Modifier =
    this.verticalScroll(rememberScrollState())
