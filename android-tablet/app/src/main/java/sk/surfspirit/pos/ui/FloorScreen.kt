package sk.surfspirit.pos.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LifecycleResumeEffect
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import sk.surfspirit.pos.core.*
import sk.surfspirit.pos.net.*
import sk.surfspirit.pos.ui.components.*
import sk.surfspirit.pos.ui.theme.*
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlin.math.roundToInt

/** Default rozmery chipu podľa shape (web .table-chip CSS, tablet breakpoint). */
private fun chipW(t: TableDto): Int = t.width ?: when (t.shape) { "large" -> 170; "round" -> 105; else -> 110 }
private fun chipH(t: TableDto): Int = t.height ?: when (t.shape) { "large" -> 120; "round" -> 105; else -> 95 }

@Composable
fun FloorScreen(
    onOpenTable: (Int) -> Unit,
    onLogout: () -> Unit,
    onSessionExpired: () -> Unit,
    onAdmin: (() -> Unit)? = null,
) {
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    var tables by remember { mutableStateOf<List<TableDto>>(emptyList()) }
    var zones by remember { mutableStateOf<List<ZoneDto>>(emptyList()) }
    var totals by remember { mutableStateOf<Map<Int, Double>>(emptyMap()) }
    var accountsPerTable by remember { mutableStateOf<Map<Int, Int>>(emptyMap()) }
    var oldestOrderAt by remember { mutableStateOf<Map<Int, Long>>(emptyMap()) }
    var revenueToday by remember { mutableStateOf<Double?>(null) }
    var activeZone by remember { mutableStateOf<String?>(null) }
    // Stoly s rozpísaným (offline odparkovaným) draftom — ukáž na chipe
    var draftIds by remember { mutableStateOf<Set<Int>>(emptySet()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var toast by remember { mutableStateOf<String?>(null) }

    // Edit mode (len manažér) — drag pozícií + resize, uložené cez PUT /tables/:id
    var editMode by remember { mutableStateOf(false) }
    val dirtyTables = remember { mutableStateListOf<Int>() }

    // TTLock
    var lockCode by remember { mutableStateOf<Pair<String, String>?>(null) }   // code to validUntil

    // Close-shift (uzávierka) na odhlásení
    var showCloseShift by remember { mutableStateOf(false) }
    var closeSummary by remember { mutableStateOf<ShiftSummaryDto?>(null) }
    var closeBusy by remember { mutableStateOf(false) }
    var closeError by remember { mutableStateOf<String?>(null) }

    /** Načítanie — quiet=true nepreklápa `loading` spinner (background poll). */
    fun load(quiet: Boolean = false) {
        if (!quiet) { loading = true; error = null }
        draftIds = Store.draftTableIds()
        scope.launch {
            try {
                val (tbls, ords) = withContext(Dispatchers.IO) { Api.service.tables() to Api.service.allOrders() }
                tables = tbls
                totals = ords.groupBy { it.tableId }.mapValues { (_, v) -> v.sumOf { o -> o.grandTotal } }
                accountsPerTable = ords.groupBy { it.tableId }.mapValues { it.value.size }
                oldestOrderAt = ords.groupBy { it.tableId }.mapValues { (_, v) ->
                    v.mapNotNull { o -> o.createdAt?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() } }
                        .minOrNull() ?: Long.MAX_VALUE
                }
                zones = try { withContext(Dispatchers.IO) { Api.service.zones() } } catch (_: Exception) { emptyList() }
                if (activeZone == null || tbls.none { it.zone == activeZone })
                    activeZone = zones.firstOrNull()?.slug ?: tbls.firstOrNull()?.zone
                revenueToday = try { withContext(Dispatchers.IO) { Api.service.zReport(todayIso()).totalRevenue } } catch (_: Exception) { revenueToday }
                // Online — cache + flush offline queue
                Store.cacheTables(tbls)
                if (zones.isNotEmpty()) Store.cacheZones(zones)
                Net.offline.value = false
                error = null
                withContext(Dispatchers.IO) { runCatching { Store.flushQueue() } }
                Store.refreshQueueCount()
            } catch (e: Exception) {
                if (e.httpCode() == 401) {
                    // Stale/expirovaný token → čisto na login (web requireAuth parita)
                    AppPrefs.logout(); onSessionExpired(); return@launch
                }
                Net.offline.value = true
                // Offline fallback — cache stolov/zón, objednávky ostávajú posledné známe
                val cachedT = Store.cachedTables()
                if (tables.isEmpty() && cachedT != null) {
                    tables = cachedT
                    zones = Store.cachedZones() ?: emptyList()
                    if (activeZone == null) activeZone = zones.firstOrNull()?.slug ?: cachedT.firstOrNull()?.zone
                    toast = "Offline — používam cache dáta"
                } else if (tables.isEmpty()) {
                    error = "Nepodarilo sa načítať stoly. Skontroluj pripojenie k serveru."
                }
            } finally { loading = false }
        }
    }
    LifecycleResumeEffect(Unit) { load(); onPauseOrDispose { } }

    // Fallback polling — web parita: 30s tick (WS nemáme, preto hustejšie 15 s).
    LaunchedEffect(Unit) {
        while (true) {
            delay(15_000)
            if (!editMode) load(quiet = true)
        }
    }

    LaunchedEffect(toast) { toast?.let { snackbar.showSnackbar(it); toast = null } }

    // Zabezpeč otvorenú zmenu (web parita: auto-open s 0 ak žiadna nie je).
    // Pozn.: nevoláme GET /shifts/current — vracia literál `null` (bez otvorenej
    // zmeny), čo kotlinx-serialization na top-level nedokáže deserializovať.
    // Priamy POST /shifts/open je idempotentný: 400 „Už máte otvorenú zmenu" = OK.
    LaunchedEffect(Unit) {
        try { withContext(Dispatchers.IO) { Api.service.shiftOpen(OpenShiftReq(0.0)) } }
        catch (e: Exception) {
            // 400 = už otvorená → OK ticho. Iné chyby web hlási a nebootstrapne —
            // kasa nesmie bežať deň bez zmeny bez vedomia obsluhy.
            if (e.httpCode() != 400) toast = "Nepodarilo sa otvoriť zmenu — uzávierka nebude sedieť."
        }
    }

    fun startCloseFlow() {
        showCloseShift = true; closeSummary = null; closeError = null
        scope.launch {
            try { closeSummary = withContext(Dispatchers.IO) { Api.service.shiftSummary() } }
            catch (_: Exception) {
                // žiadna otvorená zmena → rovno odhlás
                showCloseShift = false; onLogout()
            }
        }
    }
    fun confirmClose(actual: Double) {
        closeBusy = true; closeError = null
        scope.launch {
            try {
                withContext(Dispatchers.IO) { Api.service.shiftClose(CloseShiftReq(actual)) }
                showCloseShift = false; onLogout()
            } catch (e: Exception) { closeError = "Uzávierka zlyhala. Skús znova alebo len odhlás." }
            finally { closeBusy = false }
        }
    }

    // TTLock — vygeneruj + vytlač + ukáž (web generateLockCode parita)
    fun generateLockCode() {
        scope.launch {
            try {
                toast = "Generujem kód zámku…"
                val res = withContext(Dispatchers.IO) { Api.service.ttlockPasscode(Empty()) }
                // endDate môže byť ISO string ALEBO epoch millis (TTLock API)
                val instant = runCatching { Instant.parse(res.endDate) }.getOrNull()
                    ?: res.endDate.toLongOrNull()?.let { Instant.ofEpochMilli(it) }
                val validUntil = instant?.atZone(ZoneId.of("Europe/Bratislava"))
                    ?.format(DateTimeFormatter.ofPattern("dd.MM.yyyy HH:mm"))
                    ?: res.endDate
                // Tlač automaticky — best-effort
                withContext(Dispatchers.IO) {
                    runCatching { Api.service.printLockCode(LockCodePrintReq(res.passcode, validUntil, AppPrefs.userName ?: "")) }
                }
                lockCode = res.passcode to validUntil
                toast = "Kód ${res.passcode} odoslaný na tlač"
            } catch (e: Exception) {
                toast = "Chyba: ${errorMessage(e)}"
            }
        }
    }

    // Edit mode — uloženie pozícií pri „Hotovo" (web savePositions parita).
    // dirtyTables sa čistia až PO úspešnom PUT — failnuté ostávajú dirty,
    // takže ďalšie „Hotovo" ich skúsi znova (a poll ich medzitým neprepíše,
    // poll je v edit móde vypnutý).
    fun saveLayout() {
        val toSave = tables.filter { dirtyTables.contains(it.id) }
        if (toSave.isEmpty()) return
        scope.launch {
            val saved = mutableListOf<Int>()
            withContext(Dispatchers.IO) {
                toSave.forEach { t ->
                    runCatching {
                        Api.service.updateTable(t.id, TableUpdateReq(t.x, t.y, t.width, t.height))
                    }.onSuccess { saved.add(t.id) }
                }
            }
            dirtyTables.removeAll(saved)
            toast = if (saved.size == toSave.size) "Rozloženie uložené"
                    else "Časť pozícií sa nepodarilo uložiť — skús Upraviť → Hotovo znova"
        }
    }

    fun zoneLabel(slug: String) = zones.firstOrNull { it.slug == slug }?.label?.ifBlank { null }
        ?: slug.replaceFirstChar { it.uppercase() }

    val openCount = tables.count { it.status != "free" }
    val nowMs = System.currentTimeMillis()
    fun isForgotten(t: TableDto): Boolean {
        if (t.status != "occupied") return false
        val oldest = oldestOrderAt[t.id] ?: return false
        return oldest != Long.MAX_VALUE && nowMs - oldest > 20 * 60 * 1000
    }

    Scaffold(
        snackbarHost = { PosSnackbarHost(snackbar) },
        topBar = {
            Column {
                PosHeader(activeTab = "stoly", userName = AppPrefs.userName,
                    onStoly = { load() }, onLogout = { startCloseFlow() },
                    onRefresh = { load() }, onLockCode = { generateLockCode() },
                    // Admin len pre manažéra/admina (web goAdmin parita — cisnik nie)
                    onAdmin = if (isManager) onAdmin else null)
                OfflineBanner()
                ShiftStrip(openTables = openCount, totalTables = tables.size,
                    revenueToday = revenueToday?.takeIf { it > 0 })
            }
        }
    ) { pad ->
        Box(Modifier.fillMaxSize().padding(pad)) {
            when {
                loading -> CircularProgressIndicator(Modifier.align(Alignment.Center))
                error != null -> Column(Modifier.align(Alignment.Center).padding(24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(error!!, color = MaterialTheme.colorScheme.error)
                    Spacer(Modifier.height(12.dp))
                    Button(onClick = { load() }) { Text("Skúsiť znova") }
                }
                else -> Column(Modifier.fillMaxSize()) {
                    // ── Zónové pills + edit toggle (web parita: „terasa 8/12") ──
                    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically) {
                        Row(Modifier.weight(1f).horizontalScroll(rememberScrollState()),
                            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            val zoneSlugs = (zones.map { it.slug } + tables.map { it.zone }).distinct()
                            zoneSlugs.forEach { slug ->
                                val zt = tables.filter { it.zone == slug }
                                if (zt.isEmpty() && zones.none { it.slug == slug }) return@forEach
                                val occ = zt.count { it.status == "occupied" || it.status == "reserved" }
                                ZonePill(zoneLabel(slug), "${occ}/${zt.size}", slug == activeZone) {
                                    activeZone = slug
                                }
                            }
                        }
                        if (isManager) {
                            val editInk by animateColorAsState(if (editMode) Sage else Navy,
                                Motion.colorSpec, label = "editInk")
                            TextButton(onClick = {
                                if (editMode) saveLayout()
                                editMode = !editMode
                            }) { Text(if (editMode) "Hotovo" else "Upraviť", color = editInk) }
                        }
                    }

                    // ── Priestorový floor canvas — absolútne x/y ako admin/web ──
                    val zoneTables = tables.filter { it.zone == activeZone }
                    if (zoneTables.isEmpty()) {
                        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                Surface(shape = CircleShape, color = MaterialTheme.colorScheme.surfaceVariant,
                                    modifier = Modifier.size(56.dp)) {
                                    Box(contentAlignment = Alignment.Center) { Text("🪑", fontSize = 26.sp) }
                                }
                                Spacer(Modifier.height(12.dp))
                                Text("Žiadne stoly v tejto zóne", style = MaterialTheme.typography.titleMedium)
                                Spacer(Modifier.height(4.dp))
                                Text("Pridaj stoly cez admin → Stoly, alebo prepni zónu vyššie.",
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    } else {
                        val maxX = zoneTables.maxOf { it.x + chipW(it) } + 60
                        val maxY = zoneTables.maxOf { it.y + chipH(it) } + 60
                        // Animačný rozpočet: pulzujú max 3 zabudnuté stoly naraz
                        val pulsingIds = zoneTables.filter { isForgotten(it) }.take(3).map { it.id }.toSet()
                        Box(Modifier.fillMaxSize()
                            .horizontalScroll(rememberScrollState())
                            .verticalScroll(rememberScrollState())) {
                            Box(Modifier.size(maxOf(maxX, 600).dp, maxOf(maxY, 400).dp)) {
                                zoneTables.forEach { t ->
                                    key(t.id) {
                                        TableChip(
                                            t = t,
                                            total = totals[t.id] ?: 0.0,
                                            accounts = accountsPerTable[t.id] ?: 0,
                                            forgotten = isForgotten(t),
                                            pulse = pulsingIds.contains(t.id),
                                            hasDraft = draftIds.contains(t.id),
                                            editMode = editMode,
                                            onClick = { if (!editMode) onOpenTable(t.id) },
                                            onMoved = { nx, ny ->
                                                tables = tables.map { if (it.id == t.id) it.copy(x = nx, y = ny) else it }
                                                if (!dirtyTables.contains(t.id)) dirtyTables.add(t.id)
                                            },
                                            onResized = { nw, nh ->
                                                tables = tables.map { if (it.id == t.id) it.copy(width = nw, height = nh) else it }
                                                if (!dirtyTables.contains(t.id)) dirtyTables.add(t.id)
                                            },
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if (showCloseShift) {
        CloseShiftDialog(
            summary = closeSummary, busy = closeBusy, error = closeError,
            onClose = { confirmClose(it) },
            onJustLogout = { showCloseShift = false; onLogout() },
            onDismiss = { if (!closeBusy) showCloseShift = false },
        )
    }
    lockCode?.let { (code, until) ->
        LockCodeDialog(code, until) { lockCode = null }
    }
}

@Composable
private fun ZonePill(label: String, meta: String, active: Boolean, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val fill by animateColorAsState(if (active) Terra else MaterialTheme.colorScheme.surface,
        Motion.colorSpec, label = "zoneFill")
    val edge by animateColorAsState(if (active) Terra else BorderSoft, Motion.colorSpec, label = "zoneEdge")
    Surface(onClick = onClick, interactionSource = interaction, shape = RoundedCornerShape(999.dp),
        color = fill, border = BorderStroke(1.dp, edge),
        modifier = Modifier
            .then(if (active) Modifier.paperShadow(2.dp, RoundedCornerShape(999.dp)) else Modifier)
            .pressScale(interaction)) {
        Row(Modifier.padding(horizontal = 14.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(label, color = if (active) Cream else MaterialTheme.colorScheme.onSurface,
                style = MaterialTheme.typography.labelLarge)
            Spacer(Modifier.width(6.dp))
            Text(meta, color = if (active) Cream.copy(alpha = 0.8f) else MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.labelSmall)
        }
    }
}

/**
 * Stôl na priestorovom pláne — web .table-chip parita: status glyph + meno,
 * suma / rezervácia / stav label, počet miest; v edit-mode draggable
 * (snap 20 px grid) + resize handle v pravom dolnom rohu.
 */
@Composable
private fun TableChip(
    t: TableDto,
    total: Double,
    accounts: Int,
    forgotten: Boolean,
    pulse: Boolean = true,        // pulz max 3 chipov naraz (animačný rozpočet)
    hasDraft: Boolean = false,
    editMode: Boolean,
    onClick: () -> Unit,
    onMoved: (Int, Int) -> Unit,
    onResized: (Int, Int) -> Unit,
) {
    val sc = statusColor(t.status)
    val occupied = t.status == "occupied"
    val w = chipW(t)
    val h = chipH(t)
    val shape = if (t.shape == "round") CircleShape else RoundedCornerShape(14.dp)
    val interaction = remember { MutableInteractionSource() }
    // Lokálny drag offset počas gesta — commit (snap 20px) až na dragEnd.
    var dragX by remember(t.x) { mutableStateOf(t.x.toFloat()) }
    var dragY by remember(t.y) { mutableStateOf(t.y.toFloat()) }
    var resW by remember(w) { mutableStateOf(w.toFloat()) }
    var resH by remember(h) { mutableStateOf(h.toFloat()) }
    var isDragging by remember { mutableStateOf(false) }

    // Status farby plynú pri poll flipe free→occupied (žiadne skoky)
    val fillTop by animateColorAsState(if (occupied) sc.copy(alpha = 0.08f) else CreamElev, Motion.colorSpec, label = "ft")
    val fillBot by animateColorAsState(if (occupied) sc.copy(alpha = 0.14f) else CreamSunken, Motion.colorSpec, label = "fb")
    val edge by animateColorAsState(
        when {
            forgotten -> Danger
            editMode -> Navy.copy(alpha = 0.6f)
            occupied -> sc.copy(alpha = 0.45f)
            else -> BorderSoft
        }, Motion.colorSpec, label = "edge")
    // Forgotten pulz na ľavom prúžku (reduced-motion → statický)
    val barAlpha = if (forgotten && pulse && !reducedMotion()) {
        val tr = rememberInfiniteTransition(label = "forgot")
        tr.animateFloat(0.55f, 1f, infiniteRepeatable(tween(900), RepeatMode.Reverse), label = "fa").value
    } else 1f
    val dragScale by animateFloatAsState(if (isDragging) 1.04f else 1f, Motion.pressSpec, label = "drag")

    Surface(
        onClick = onClick,
        interactionSource = interaction,
        shape = shape,
        color = if (occupied) sc.copy(alpha = 0.10f) else MaterialTheme.colorScheme.surface,
        border = BorderStroke(if (forgotten || editMode) 2.dp else 1.dp, edge),
        modifier = Modifier
            // offset lambda pracuje v px, naše súradnice sú dp → násobíme density
            .offset { IntOffset((dragX * density).roundToInt(), (dragY * density).roundToInt()) }
            .size(resW.dp, resH.dp)
            // Voľné stoly „plávajú" vyššie (pozývajú na tap), obsadené sedia;
            // počas dragu sa chip zdvihne najvyššie.
            .paperShadow(if (isDragging) 14.dp else if (occupied) 2.dp else 6.dp, shape)
            .graphicsLayer { scaleX = dragScale; scaleY = dragScale }
            .pressScale(interaction, enabled = !editMode)
            .then(if (editMode) Modifier.pointerInput(t.id) {
                detectDragGestures(
                    onDragStart = { isDragging = true },
                    onDragCancel = { isDragging = false },
                    onDragEnd = {
                        isDragging = false
                        val sx = ((dragX / 20).roundToInt() * 20).coerceAtLeast(0)
                        val sy = ((dragY / 20).roundToInt() * 20).coerceAtLeast(0)
                        dragX = sx.toFloat(); dragY = sy.toFloat()
                        onMoved(sx, sy)
                    },
                ) { change, amount ->
                    change.consume()
                    dragX = (dragX + amount.x / density).coerceAtLeast(0f)
                    dragY = (dragY + amount.y / density).coerceAtLeast(0f)
                }
            } else Modifier),
    ) {
        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(fillTop, fillBot)))) {
            // Ľavý 4 dp status prúžok — čitateľný cez celú miestnosť
            if (t.status != "free") {
                Box(Modifier.align(Alignment.CenterStart).fillMaxHeight().width(4.dp)
                    .alpha(barAlpha)
                    .background(if (forgotten) Danger else sc))
            }
            Column(Modifier.fillMaxSize().padding(start = 10.dp, end = 8.dp, top = 8.dp, bottom = 8.dp),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(statusGlyph(t.status), color = sc, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                    Spacer(Modifier.width(4.dp))
                    Text(t.name, style = MaterialTheme.typography.labelLarge,
                        color = MaterialTheme.colorScheme.onSurface, maxLines = 1)
                    if (forgotten) { Spacer(Modifier.width(3.dp)); Text("⏰", fontSize = 11.sp) }
                }
                when {
                    occupied && total > 0 -> {
                        // Hero číslo stola — Sora bold + pokladničný ticker
                        AnimatedMoney(total, MaterialTheme.typography.labelLarge, Terra)
                        if (accounts > 1) Text("$accounts účty", style = MaterialTheme.typography.labelSmall, color = sc)
                    }
                    t.status == "reserved" && !t.time.isNullOrBlank() ->
                        Text(t.time!!, style = MaterialTheme.typography.labelSmall, color = sc)
                    t.status == "dirty" ->
                        Text("vyčistiť", style = MaterialTheme.typography.labelSmall, color = sc)
                    occupied ->
                        Text("otvorený", style = MaterialTheme.typography.labelSmall, color = sc)
                    hasDraft ->
                        Text("koncept", style = MaterialTheme.typography.labelSmall, color = Amber)
                    else ->
                        Text(statusLabel(t.status), style = MaterialTheme.typography.labelSmall, color = sc)
                }
                // Kapacita — pri obsadených/rezervovaných/špinavých + v edit móde
                if (t.status != "free" || editMode) {
                    Text("👤 ${t.seats}", style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            // Resize handle — pravý dolný roh, len v edit móde (snap 20 px,
            // min 80×80, max 240×200 — zhoda so server validáciou).
            if (editMode) {
                Box(Modifier.align(Alignment.BottomEnd).size(32.dp)
                    .pointerInput(t.id) {
                        detectDragGestures(
                            onDragEnd = {
                                val sw = ((resW / 20).roundToInt() * 20).coerceIn(80, 240)
                                val sh = ((resH / 20).roundToInt() * 20).coerceIn(80, 200)
                                resW = sw.toFloat(); resH = sh.toFloat()
                                onResized(sw, sh)
                            },
                        ) { change, amount ->
                            change.consume()
                            resW = (resW + amount.x / density).coerceIn(60f, 260f)
                            resH = (resH + amount.y / density).coerceIn(60f, 220f)
                        }
                    },
                    contentAlignment = Alignment.Center) {
                    Text("◢", color = Navy, fontSize = 13.sp)
                }
            }
        }
    }
}
