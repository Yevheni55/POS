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
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
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
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
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
    onDochadzka: (() -> Unit)? = null,
) {
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    // Štart z in-memory cache — návrat z objednávky kreslí plán OKAMŽITE
    // (žiadny spinner), sieť ho len potichu obnoví.
    var tables by remember { mutableStateOf(Mem.tables ?: emptyList()) }
    var zones by remember { mutableStateOf(Mem.zones ?: emptyList()) }
    var totals by remember { mutableStateOf(
        Mem.orders?.groupBy { it.tableId }?.mapValues { (_, v) -> v.sumOf { o -> o.grandTotal } } ?: emptyMap()) }
    var accountsPerTable by remember { mutableStateOf(
        Mem.orders?.groupBy { it.tableId }?.mapValues { it.value.size } ?: emptyMap()) }
    var oldestOrderAt by remember { mutableStateOf<Map<Int, Long>>(emptyMap()) }
    var revenueToday by remember { mutableStateOf(Mem.revenueToday) }
    var activeZone by remember { mutableStateOf<String?>(
        Mem.zones?.firstOrNull()?.slug ?: Mem.tables?.firstOrNull()?.zone) }
    // Stoly s rozpísaným (offline odparkovaným) draftom — ukáž na chipe
    var draftIds by remember { mutableStateOf<Set<Int>>(emptySet()) }
    var loading by remember { mutableStateOf(Mem.tables == null) }
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
    // Súhrn zmeny sa nepodarilo načítať (transport/5xx) — vedomá voľba namiesto
    // tichého odhlásenia bez uzávierky
    var closeSummaryFailed by remember { mutableStateOf(false) }
    // Idempotency kľúč uzávierky — jeden na celý close-flow (od otvorenia
    // dialógu): „Uzavrieť" retry po chybe drží ten istý kľúč, server replayne
    // výsledok namiesto druhej uzávierky.
    val closeShiftNonce = remember(showCloseShift) { java.util.UUID.randomUUID().toString() }

    /** Načítanie — quiet=true nepreklápa `loading` spinner (background poll);
     *  fullRefresh=false preskočí zóny + z-report (poll medzi 4. tickmi). */
    fun load(quiet: Boolean = false, fullRefresh: Boolean = true) {
        // Spinner len pri ÚPLNE prvom otvorení bez cache — návraty sú okamžité
        if (!quiet && tables.isEmpty()) { loading = true; error = null }
        draftIds = Store.draftTableIds()
        scope.launch {
            try {
                // Paralelný fan-out — 1 RTT namiesto 4 sekvenčných. Zóny a z-report
                // sa menia zriedka, preto len pri plnom refreshi; ich zlyhanie
                // load nezhodí (nezávislý runCatching ako doteraz).
                coroutineScope {
                    val tblsD = async(Dispatchers.IO) { Api.service.tables() }
                    val ordsD = async(Dispatchers.IO) { Api.service.allOrders() }
                    val zonesD = if (fullRefresh)
                        async(Dispatchers.IO) { runCatching { Api.service.zones() }.getOrNull() } else null
                    // z-report je requireRole(manazer/admin) — čašníkovi by vracal 403
                    val revD = if (fullRefresh && isManager)
                        async(Dispatchers.IO) { runCatching { Api.service.zReport(todayIso()).totalRevenue }.getOrNull() } else null
                    val tbls = tblsD.await()
                    val ords = ordsD.await()
                    tables = tbls
                    totals = ords.groupBy { it.tableId }.mapValues { (_, v) -> v.sumOf { o -> o.grandTotal } }
                    accountsPerTable = ords.groupBy { it.tableId }.mapValues { it.value.size }
                    oldestOrderAt = ords.groupBy { it.tableId }.mapValues { (_, v) ->
                        v.mapNotNull { o -> o.createdAt?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() } }
                            .minOrNull() ?: Long.MAX_VALUE
                    }
                    zonesD?.await()?.let { zones = it }
                    if (activeZone == null || tbls.none { it.zone == activeZone })
                        activeZone = zones.firstOrNull()?.slug ?: tbls.firstOrNull()?.zone
                    revD?.await()?.let { revenueToday = it }
                    // In-memory cache pre okamžité prechody + prefs cache pre offline boot
                    Mem.tables = tbls; Mem.zones = zones; Mem.orders = ords; Mem.revenueToday = revenueToday
                    Store.cacheTables(tbls)
                    if (zones.isNotEmpty()) Store.cacheZones(zones)
                }
                Net.reportSuccess()
                error = null
                withContext(Dispatchers.IO) { runCatching { Store.flushQueue() } }
                Store.refreshQueueCount()
            } catch (e: Exception) {
                if (e.httpCode() == 401) {
                    // Stale/expirovaný token → čisto na login (web requireAuth parita)
                    AppPrefs.logout(); onSessionExpired(); return@launch
                }
                Net.reportFailure(e)
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
    // Beží len v RESUMED — na pozadí (vrecko čašníka) sa rádio/server nebudí.
    val lifecycleOwner = LocalLifecycleOwner.current
    LaunchedEffect(Unit) {
        lifecycleOwner.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            var tick = 0
            while (true) {
                delay(15_000)
                tick++
                // Zóny + z-report stačí každý 4. tick (~1 min) — menia sa zriedka
                if (!editMode) load(quiet = true, fullRefresh = tick % 4 == 0)
            }
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
            catch (e: Exception) {
                showCloseShift = false
                classifyShiftSummaryFailure(e, onLogout = onLogout,
                    onFailed = { closeSummaryFailed = true })
            }
        }
    }
    fun confirmClose(actual: Double) {
        closeBusy = true; closeError = null
        scope.launch {
            try {
                withContext(Dispatchers.IO) { Api.service.shiftClose(CloseShiftReq(actual), "shift-close-$closeShiftNonce") }
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

    val phone = isPhone()
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
                    onAdmin = if (isManager) onAdmin else null,
                    onDochadzka = onDochadzka)
                OfflineBanner()
                ShiftStrip(openTables = openCount, totalTables = tables.size,
                    revenueToday = revenueToday?.takeIf { it > 0 })
            }
        }
    ) { pad ->
        Box(Modifier.fillMaxSize().warmCanvas().padding(pad)) {
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
                        // Priestorový edit (drag/resize x/y) má zmysel len na tablete;
                        // telefón ukazuje responzívny grid, kde absolútne pozície neplatia.
                        if (isManager && !phone) {
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
                    } else if (phone) {
                        // Telefón: plne responzívny grid stolov — wrapuje na šírku,
                        // len vertikálny scroll, žiadne absolútne x/y, tap = otvor stôl.
                        LazyVerticalGrid(
                            columns = GridCells.Adaptive(minSize = 150.dp),
                            contentPadding = PaddingValues(16.dp),
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                            verticalArrangement = Arrangement.spacedBy(10.dp),
                            modifier = Modifier.fillMaxSize(),
                        ) {
                            items(zoneTables, key = { it.id }) { t ->
                                PhoneTableCard(
                                    t = t,
                                    total = totals[t.id] ?: 0.0,
                                    accounts = accountsPerTable[t.id] ?: 0,
                                    forgotten = isForgotten(t),
                                    hasDraft = draftIds.contains(t.id),
                                    onClick = { onOpenTable(t.id) },
                                )
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
    if (closeSummaryFailed) CloseSummaryFailedDialog(
        onRetry = { closeSummaryFailed = false; startCloseFlow() },
        onLogout = { closeSummaryFailed = false; onLogout() },
        onDismiss = { closeSummaryFailed = false },
    )
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
 * Telefónna karta stola — responzívny grid (žiadne absolútne x/y, žiadny drag).
 * Rovnaký vizuálny jazyk ako TableChip, ale fillMaxWidth v gridovej bunke.
 */
@Composable
private fun PhoneTableCard(
    t: TableDto,
    total: Double,
    accounts: Int,
    forgotten: Boolean,
    hasDraft: Boolean,
    onClick: () -> Unit,
) {
    val sc = statusColor(t.status)
    val occupied = t.status == "occupied"
    val interaction = remember { MutableInteractionSource() }
    val shape = RoundedCornerShape(16.dp)
    Surface(
        onClick = onClick,
        interactionSource = interaction,
        shape = shape,
        color = if (occupied) sc.copy(alpha = 0.10f) else MaterialTheme.colorScheme.surface,
        border = BorderStroke(if (forgotten) 2.dp else 1.dp,
            when { forgotten -> Danger; occupied -> sc.copy(alpha = 0.45f); else -> BorderSoft }),
        modifier = Modifier.fillMaxWidth().height(100.dp)
            .paperShadow(if (occupied) 2.dp else 4.dp, shape)
            .pressScale(interaction),
    ) {
        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(
            if (occupied) listOf(sc.copy(alpha = 0.08f), sc.copy(alpha = 0.14f))
            else listOf(CreamElev, CreamSunken)))) {
            if (t.status != "free") {
                Box(Modifier.align(Alignment.CenterStart).fillMaxHeight().width(4.dp)
                    .background(if (forgotten) Danger else sc))
            }
            Column(Modifier.fillMaxSize().padding(start = 12.dp, end = 10.dp, top = 8.dp, bottom = 8.dp),
                verticalArrangement = Arrangement.Center) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(statusGlyph(t.status), color = sc, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                    Spacer(Modifier.width(5.dp))
                    Text(t.name, style = MaterialTheme.typography.titleSmall,
                        color = MaterialTheme.colorScheme.onSurface, maxLines = 1,
                        modifier = Modifier.weight(1f))
                    if (forgotten) Text("⏰", fontSize = 12.sp)
                }
                Spacer(Modifier.height(3.dp))
                when {
                    occupied && total > 0 -> {
                        AnimatedMoney(total, MaterialTheme.typography.titleMedium, Terra)
                        if (accounts > 1) Text("$accounts účty",
                            style = MaterialTheme.typography.labelSmall, color = sc)
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
                Spacer(Modifier.height(3.dp))
                Text("👤 ${t.seats}", style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
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
