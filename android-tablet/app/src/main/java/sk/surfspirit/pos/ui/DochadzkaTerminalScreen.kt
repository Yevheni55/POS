package sk.surfspirit.pos.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Backspace
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import retrofit2.http.Body
import retrofit2.http.POST
import sk.surfspirit.pos.core.errorMessage
import sk.surfspirit.pos.net.Api
import sk.surfspirit.pos.ui.theme.*
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter

/* ===== DTOs — public PIN endpointy (bez JWT), zhoda so server/routes/attendance.js ===== */

@Serializable private data class DtPinReq(val pin: String, val period: String? = null)
@Serializable private data class DtClockReq(val pin: String, val type: String)
@Serializable private data class DtStaff(
    val id: Int = 0, val name: String = "", val position: String = "",
    val hourlyRate: Double = 0.0,
)
@Serializable private data class DtStateResp(
    val staff: DtStaff = DtStaff(),
    val currentState: String = "clocked_out",
    val todayMinutes: Int = 0,
)
@Serializable private data class DtPaid(val amount: Double = 0.0, val paidAt: String? = null)
@Serializable private data class DtShift(
    val inAt: String? = null, val outAt: String? = null,
    val minutes: Int = 0, val earnings: Double = 0.0,
    val closed: Boolean = false, val paid: DtPaid? = null,
)
@Serializable private data class DtSummary(
    val shiftCount: Int = 0, val openShifts: Int = 0,
    val totalMinutes: Int = 0, val totalEarnings: Double = 0.0,
    val paidEarnings: Double = 0.0, val unpaidEarnings: Double = 0.0,
    val hourlyRate: Double = 0.0,
)
@Serializable private data class DtMyShiftsResp(
    val staff: DtStaff = DtStaff(),
    val shifts: List<DtShift> = emptyList(),
    val summary: DtSummary = DtSummary(),
)

private interface DtApi {
    @POST("api/attendance/identify") suspend fun identify(@Body body: DtPinReq): DtStateResp
    @POST("api/attendance/clock") suspend fun clock(@Body body: DtClockReq): DtStateResp
    @POST("api/attendance/my-shifts") suspend fun myShifts(@Body body: DtPinReq): DtMyShiftsResp
}
private val dtApi: DtApi by lazy { Api.create(DtApi::class.java) }

private fun dtFmtMinutes(m: Int): String = "${m / 60}h ${m % 60}m"
private fun dtFmtHours(m: Int): String = "${m / 60}h ${(m % 60).toString().padStart(2, '0')}m"
private fun dtEur(v: Double): String = sk.surfspirit.pos.core.money(v)
private val DT_TZ: ZoneId = ZoneId.of("Europe/Bratislava")
private fun dtTime(iso: String?): String =
    iso?.let { runCatching { java.time.Instant.parse(it).atZone(DT_TZ).format(DateTimeFormatter.ofPattern("HH:mm")) }.getOrNull() } ?: "—"
private fun dtDate(iso: String?): String =
    iso?.let { runCatching { java.time.Instant.parse(it).atZone(DT_TZ).format(DateTimeFormatter.ofPattern("dd.MM.")) }.getOrNull() } ?: "—"

/**
 * Self-service dochádzkový terminál (web dochadzka.html parita) — PIN pichačka
 * bez prihlásenia: identify pri ≥4 čísliciach, Príchod/Odchod so splash
 * potvrdením, „Moje smeny" (hodiny + zárobky + vyplatené) s auto-zatvorením.
 */
@Composable
fun DochadzkaTerminalScreen(onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    val haptics = LocalHapticFeedback.current

    var pin by remember { mutableStateOf("") }
    var staff by remember { mutableStateOf<DtStaff?>(null) }
    var state by remember { mutableStateOf("clocked_out") }
    var todayMinutes by remember { mutableStateOf(0) }
    var busy by remember { mutableStateOf(false) }
    var toast by remember { mutableStateOf<Pair<String, Boolean>?>(null) }   // msg to isOk
    var splash by remember { mutableStateOf<Pair<String, String>?>(null) }   // title to name
    var myShifts by remember { mutableStateOf<DtMyShiftsResp?>(null) }
    var msPeriod by remember { mutableStateOf("month") }
    var resetJob by remember { mutableStateOf<Job?>(null) }

    fun resetAll() {
        resetJob?.cancel()
        pin = ""; staff = null; state = "clocked_out"; todayMinutes = 0
    }

    // Web parita: 8 s po identifikácii bez akcie → reset
    fun scheduleReset(ms: Long = 8000) {
        resetJob?.cancel()
        resetJob = scope.launch { delay(ms); resetAll() }
    }

    fun showToast(msg: String, ok: Boolean) {
        toast = msg to ok
        scope.launch { delay(2400); toast = null }
    }

    fun identify() {
        if (pin.length < 4 || busy) return
        scope.launch {
            try {
                val res = withContext(Dispatchers.IO) { dtApi.identify(DtPinReq(pin)) }
                staff = res.staff; state = res.currentState; todayMinutes = res.todayMinutes
                scheduleReset()
            } catch (e: Exception) {
                showToast(errorMessage(e).ifBlank { "Neplatný PIN" }, false)
                pin = ""
            }
        }
    }

    fun clock(type: String) {
        val st = staff ?: return
        if (busy) return
        busy = true
        scope.launch {
            try {
                val res = withContext(Dispatchers.IO) { dtApi.clock(DtClockReq(pin, type)) }
                staff = res.staff; state = res.currentState; todayMinutes = res.todayMinutes
                haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                val now = ZonedDateTime.now(DT_TZ).format(DateTimeFormatter.ofPattern("HH:mm"))
                splash = (if (type == "clock_in") "Príchod $now" else "Odchod $now") to res.staff.name
                resetJob?.cancel()
                scope.launch {
                    delay(3000); splash = null
                    delay(200); resetAll()
                }
            } catch (e: Exception) {
                showToast(errorMessage(e), false)
            } finally { busy = false }
        }
    }

    fun openMyShifts(period: String = "month") {
        if (staff == null || pin.length < 4) { showToast("Najprv zadaj PIN", false); return }
        msPeriod = period
        scope.launch {
            try {
                val res = withContext(Dispatchers.IO) { dtApi.myShifts(DtPinReq(pin, period)) }
                myShifts = res
                resetJob?.cancel()
                // Auto-close 60 s (web parita)
                resetJob = scope.launch { delay(60_000); myShifts = null; resetAll() }
            } catch (e: Exception) { showToast(errorMessage(e), false) }
        }
    }

    BackHandler(enabled = true) {
        if (myShifts != null) { myShifts = null; resetAll() } else onBack()
    }

    Surface(color = Cream, modifier = Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxSize().padding(28.dp), verticalAlignment = Alignment.CenterVertically) {
            // ── Ľavá: brand + status + akcie ──
            Column(Modifier.weight(1f).padding(end = 28.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    BrandBadge()
                    Spacer(Modifier.width(14.dp))
                    Column {
                        Text("Dochádzka", style = MaterialTheme.typography.titleLarge)
                        Text("Pichni si príchod alebo odchod", style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                Spacer(Modifier.height(24.dp))

                // Status karta
                Surface(shape = RoundedCornerShape(22.dp), color = CreamElev,
                    modifier = Modifier.fillMaxWidth().paperShadow(6.dp, RoundedCornerShape(22.dp))) {
                    Column(Modifier.padding(22.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        val st = staff
                        if (st == null) {
                            Text("Zadaj svoj PIN", style = MaterialTheme.typography.titleMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                        } else {
                            Text(st.name, style = MaterialTheme.typography.titleLarge)
                            if (st.position.isNotBlank())
                                Text(st.position, style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Spacer(Modifier.height(8.dp))
                            val inWork = state == "clocked_in"
                            Surface(shape = RoundedCornerShape(999.dp),
                                color = (if (inWork) Sage else EspressoDim).copy(alpha = 0.14f),
                                border = BorderStroke(1.dp, (if (inWork) Sage else EspressoDim).copy(alpha = 0.4f))) {
                                Text(if (inWork) "V práci" else "Doma",
                                    Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                                    color = if (inWork) Sage else EspressoSoft,
                                    style = MaterialTheme.typography.labelLarge)
                            }
                            Spacer(Modifier.height(6.dp))
                            Text("Dnes: ${dtFmtMinutes(todayMinutes)}",
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
                Spacer(Modifier.height(16.dp))

                // Akcie — Príchod / Odchod / Moje smeny
                AnimatedVisibility(visible = staff != null, enter = fadeIn(), exit = fadeOut()) {
                    Column {
                        if (state != "clocked_in") {
                            Button(onClick = { clock("clock_in") }, enabled = !busy,
                                colors = ButtonDefaults.buttonColors(containerColor = Sage, contentColor = Cream),
                                modifier = Modifier.fillMaxWidth().height(64.dp).glow(!busy)) {
                                Text("▶  Príchod", style = MaterialTheme.typography.titleMedium, color = Cream)
                            }
                        }
                        if (state == "clocked_in") {
                            Button(onClick = { clock("clock_out") }, enabled = !busy,
                                colors = ButtonDefaults.buttonColors(containerColor = Amber, contentColor = Espresso),
                                modifier = Modifier.fillMaxWidth().height(64.dp).glow(!busy)) {
                                Text("⏹  Odchod", style = MaterialTheme.typography.titleMedium)
                            }
                        }
                        Spacer(Modifier.height(10.dp))
                        OutlinedButton(onClick = { openMyShifts("month") },
                            modifier = Modifier.fillMaxWidth().height(48.dp),
                            border = BorderStroke(1.dp, Navy)) {
                            Text("Moje smeny a zárobky", color = Navy)
                        }
                    }
                }

                Spacer(Modifier.weight(1f))
                TextButton(onClick = onBack) { Text("← Späť na kasu", color = EspressoSoft) }
            }

            // ── Pravá: PIN pad ──
            Surface(Modifier.weight(1f).paperShadow(6.dp, RoundedCornerShape(22.dp)),
                shape = RoundedCornerShape(22.dp), color = CreamElev) {
                Column(Modifier.padding(vertical = 26.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    val dotPop = rememberPop(pin.length)
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        repeat(6) { i ->
                            Surface(shape = CircleShape,
                                color = if (i < pin.length) Terra else MaterialTheme.colorScheme.surfaceVariant,
                                modifier = Modifier.size(16.dp)
                                    .scale(if (i == pin.length - 1) dotPop else 1f)) {}
                        }
                    }
                    Spacer(Modifier.height(20.dp))
                    val keys = listOf("1","2","3","4","5","6","7","8","9")
                    Column(horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(11.dp)) {
                        for (r in 0..2) {
                            Row(horizontalArrangement = Arrangement.spacedBy(11.dp)) {
                                for (c in 0..2) {
                                    val k = keys[r * 3 + c]
                                    DtKey(k) {
                                        if (pin.length < 6) {
                                            haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                                            pin += k
                                            if (pin.length >= 4) identify()
                                        }
                                    }
                                }
                            }
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(11.dp)) {
                            DtKeyIcon { if (pin.isNotEmpty()) pin = pin.dropLast(1) }
                            DtKey("0") {
                                if (pin.length < 6) {
                                    haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                                    pin += "0"
                                    if (pin.length >= 4) identify()
                                }
                            }
                            DtKeyText("C") { resetAll() }
                        }
                    }
                }
            }
        }
    }

    // ── Splash potvrdenie (Príchod/Odchod) ──
    splash?.let { (title, name) ->
        val isIn = title.startsWith("Príchod")
        Box(Modifier.fillMaxSize().background((if (isIn) Sage else Amber).copy(alpha = 0.96f)),
            contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(if (isIn) "✓" else "👋", fontSize = 64.sp, color = Cream)
                Spacer(Modifier.height(8.dp))
                Text(title, style = MaterialTheme.typography.titleLarge.copy(fontSize = 40.sp),
                    color = if (isIn) Cream else Espresso)
                Text(name, style = MaterialTheme.typography.titleMedium,
                    color = (if (isIn) Cream else Espresso).copy(alpha = 0.85f))
            }
        }
    }

    // ── Moje smeny overlay ──
    myShifts?.let { data ->
        Surface(Modifier.fillMaxSize(), color = Cream.copy(alpha = 0.98f)) {
            Column(Modifier.fillMaxSize().padding(24.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(data.staff.name + (data.staff.position.takeIf { it.isNotBlank() }?.let { " · $it" } ?: ""),
                            style = MaterialTheme.typography.titleLarge)
                    }
                    listOf("month" to "Tento mesiac", "season" to "Sezóna", "all" to "Všetko").forEach { (key, label) ->
                        val active = msPeriod == key
                        Surface(onClick = { openMyShifts(key) }, shape = RoundedCornerShape(999.dp),
                            color = if (active) Terra else CreamElev,
                            border = BorderStroke(1.dp, if (active) Terra else BorderSoft),
                            modifier = Modifier.padding(start = 6.dp)) {
                            Text(label, Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
                                color = if (active) Cream else Espresso,
                                style = MaterialTheme.typography.labelMedium)
                        }
                    }
                    Spacer(Modifier.width(10.dp))
                    Button(onClick = { myShifts = null; resetAll() },
                        colors = ButtonDefaults.buttonColors(containerColor = Terra, contentColor = Cream)) {
                        Text("Zavrieť")
                    }
                }
                Spacer(Modifier.height(16.dp))
                // Súhrn
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    DtStat("Hodiny", dtFmtHours(data.summary.totalMinutes),
                        "${data.summary.shiftCount} smien" +
                            (if (data.summary.openShifts > 0) " · ${data.summary.openShifts} otvorená" else ""),
                        Espresso, Modifier.weight(1f))
                    DtStat("Zárobok", dtEur(data.summary.totalEarnings),
                        if (data.summary.hourlyRate > 0) "${dtEur(data.summary.hourlyRate)}/hod" else "sadzba neurčená",
                        Terra, Modifier.weight(1f))
                    DtStat("Vyplatené", dtEur(data.summary.paidEarnings),
                        "zostáva ${dtEur(data.summary.unpaidEarnings)}", Sage, Modifier.weight(1f))
                }
                Spacer(Modifier.height(14.dp))
                if (data.shifts.isEmpty()) {
                    Text("Za toto obdobie žiadne smeny.", style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(30.dp))
                } else {
                    LazyColumn(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        items(data.shifts) { sh ->
                            Surface(shape = RoundedCornerShape(10.dp), color = CreamElev,
                                border = BorderStroke(1.dp, if (sh.closed) BorderSoft else Amber.copy(alpha = 0.5f))) {
                                Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp),
                                    verticalAlignment = Alignment.CenterVertically) {
                                    Text(dtDate(sh.inAt), Modifier.width(56.dp),
                                        style = MaterialTheme.typography.labelLarge)
                                    Text("${dtTime(sh.inAt)} – ${if (sh.outAt != null) dtTime(sh.outAt) else "stále vo vnútri"}",
                                        Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                                    Text(dtFmtHours(sh.minutes), Modifier.width(80.dp),
                                        style = MaterialTheme.typography.bodyMedium)
                                    if (sh.closed) {
                                        Text(dtEur(sh.earnings), style = MaterialTheme.typography.labelLarge, color = Terra)
                                        Spacer(Modifier.width(8.dp))
                                        if (sh.paid != null)
                                            Text("✓ vyplatené", style = MaterialTheme.typography.labelSmall, color = Sage)
                                        else
                                            Text("čaká", style = MaterialTheme.typography.labelSmall, color = Amber)
                                    } else {
                                        Text("prebieha", style = MaterialTheme.typography.labelSmall, color = Amber)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // ── Toast ──
    toast?.let { (msg, ok) ->
        Box(Modifier.fillMaxSize().padding(bottom = 28.dp), contentAlignment = Alignment.BottomCenter) {
            Surface(shape = RoundedCornerShape(12.dp), color = Espresso, contentColor = Cream,
                modifier = Modifier.paperShadow(6.dp, RoundedCornerShape(12.dp))) {
                Row(Modifier.height(IntrinsicSize.Min), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.width(4.dp).fillMaxHeight().background(if (ok) Sage else Danger))
                    Text(msg, Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
                        style = MaterialTheme.typography.bodyMedium)
                }
            }
        }
    }
}

/* ===== drobné composables ===== */

@Composable
private fun BrandBadge() {
    Surface(color = Terra, shape = RoundedCornerShape(14.dp)) {
        Text("🕐", Modifier.padding(horizontal = 14.dp, vertical = 10.dp), fontSize = 22.sp)
    }
}

@Composable
private fun DtStat(label: String, value: String, foot: String, accent: Color, modifier: Modifier) {
    Surface(modifier.paperShadow(2.dp, RoundedCornerShape(14.dp)),
        shape = RoundedCornerShape(14.dp), color = CreamElev,
        border = BorderStroke(1.dp, BorderSoft)) {
        Column(Modifier.padding(14.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(label.uppercase(), style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(value, style = MaterialTheme.typography.titleLarge, color = accent)
            Text(foot, style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun DtKey(label: String, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    Surface(onClick = onClick, interactionSource = interaction,
        shape = RoundedCornerShape(16.dp), color = Cream,
        border = BorderStroke(1.dp, BorderSoft),
        modifier = Modifier.size(78.dp).paperShadow(2.dp, RoundedCornerShape(16.dp)).pressScale(interaction)) {
        Box(contentAlignment = Alignment.Center) {
            Text(label, fontSize = 28.sp, style = MaterialTheme.typography.titleLarge)
        }
    }
}

@Composable
private fun DtKeyText(label: String, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    Surface(onClick = onClick, interactionSource = interaction,
        shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surfaceVariant,
        modifier = Modifier.size(78.dp).paperShadow(2.dp, RoundedCornerShape(16.dp)).pressScale(interaction)) {
        Box(contentAlignment = Alignment.Center) {
            Text(label, fontSize = 22.sp, color = EspressoSoft, fontWeight = FontWeight.Bold)
        }
    }
}

@Composable
private fun DtKeyIcon(onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    Surface(onClick = onClick, interactionSource = interaction,
        shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surfaceVariant,
        modifier = Modifier.size(78.dp).paperShadow(2.dp, RoundedCornerShape(16.dp)).pressScale(interaction)) {
        Box(contentAlignment = Alignment.Center) {
            Icon(Icons.AutoMirrored.Filled.Backspace, "Vymazať", Modifier.size(26.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

