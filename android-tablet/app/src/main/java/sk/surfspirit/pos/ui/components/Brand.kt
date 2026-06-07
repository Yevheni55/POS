package sk.surfspirit.pos.ui.components

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import sk.surfspirit.pos.core.money
import sk.surfspirit.pos.ui.theme.*
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale

/* ===== Status farby/glyfy — zhoda s web POS (T2 accessibility glyfy) ===== */
fun statusColor(s: String): Color = when (s) {
    "occupied" -> Terra
    "reserved" -> Color(0xFFC98A2B)
    "dirty" -> Danger
    else -> Sage
}
fun statusGlyph(s: String): String = when (s) {
    "occupied" -> "●"; "reserved" -> "◐"; "dirty" -> "✕"; else -> "○"
}
fun statusLabel(s: String): String = when (s) {
    "occupied" -> "obsadený"; "reserved" -> "rezerv."; "dirty" -> "špinavý"; else -> "voľný"
}

/** Terra zaoblené logo „SSS" — ako vo web header. */
@Composable
fun BrandLogo(size: Int = 38) {
    Surface(
        shape = RoundedCornerShape((size * 0.32f).dp),
        modifier = Modifier.size(size.dp),
        color = Color.Transparent,
    ) {
        Box(
            Modifier.background(Brush.linearGradient(listOf(Terra, TerraDim))),
            contentAlignment = Alignment.Center,
        ) {
            Text("SSS", color = Cream, fontFamily = Sora, fontWeight = FontWeight.ExtraBold,
                fontSize = (size * 0.34f).sp)
        }
    }
}

/** Živý čas — tiká po minútach (recompozícia každých 15 s stačí). */
@Composable
private fun rememberNow(): State<LocalDateTime> {
    val now = remember { mutableStateOf(LocalDateTime.now()) }
    LaunchedEffect(Unit) {
        while (true) { now.value = LocalDateTime.now(); delay(15_000) }
    }
    return now
}

private val TIME_FMT: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm")
private val DATE_FMT: DateTimeFormatter = DateTimeFormatter.ofPattern("EEEE d. MMMM", Locale("sk"))

/** Segmentový prepínač Stoly | Objednávka (ako web header). */
@Composable
private fun SegToggle(activeTab: String, onStoly: () -> Unit) {
    Surface(shape = RoundedCornerShape(999.dp), color = MaterialTheme.colorScheme.surfaceVariant) {
        Row(Modifier.padding(3.dp), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
            SegItem("Stoly", activeTab == "stoly", onStoly)
            SegItem("Objednávka", activeTab == "objednavka", {})
        }
    }
}

@Composable
private fun SegItem(label: String, active: Boolean, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val fill by animateColorAsState(if (active) Terra else Color.Transparent, Motion.colorSpec, label = "seg")
    val ink by animateColorAsState(if (active) Cream else EspressoSoft, Motion.colorSpec, label = "segInk")
    Surface(
        onClick = onClick,
        interactionSource = interaction,
        shape = RoundedCornerShape(999.dp),
        color = fill,
        modifier = Modifier.pressScale(interaction),
    ) {
        Text(label, Modifier.padding(horizontal = 16.dp, vertical = 9.dp),
            color = ink, style = MaterialTheme.typography.labelLarge)
    }
}

/**
 * Header bar — web parita: logo + „SL Spirit s. r. o." vľavo, Stoly|Objednávka
 * prepínač v strede, živý čas+dátum + user chip + Odhlásiť vpravo.
 *
 * @param activeTab "stoly" | "objednavka"
 * @param onStoly   klik na „Stoly" (na Objednávke = späť na plán stolov)
 */
@Composable
fun PosHeader(
    activeTab: String,
    userName: String?,
    onStoly: () -> Unit,
    onLogout: () -> Unit,
    onRefresh: (() -> Unit)? = null,
    onLockCode: (() -> Unit)? = null,
) {
    val now by rememberNow()
    // Paper-drop tieň namiesto tonal elevation — plán/menu „odpadne" pod header
    Surface(color = CreamElev, modifier = Modifier.paperShadow(6.dp, RectangleShape)) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            BrandLogo(38)
            Spacer(Modifier.width(12.dp))
            Column {
                Text("SL Spirit s. r. o.", style = MaterialTheme.typography.titleMedium)
                Text("Pokladničný systém", style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Spacer(Modifier.width(20.dp))
            SegToggle(activeTab, onStoly)
            Spacer(Modifier.weight(1f))
            // Čas + dátum
            Column(horizontalAlignment = Alignment.End) {
                Text(now.format(TIME_FMT), style = MaterialTheme.typography.titleMedium)
                Text(now.format(DATE_FMT).replaceFirstChar { it.uppercase() },
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Spacer(Modifier.width(16.dp))
            userName?.let {
                Surface(shape = RoundedCornerShape(999.dp), color = MaterialTheme.colorScheme.surfaceVariant) {
                    Row(Modifier.padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Surface(shape = CircleShape, color = Terra, modifier = Modifier.size(22.dp)) {
                            Box(contentAlignment = Alignment.Center) {
                                Text(it.take(1).uppercase(), color = Cream, fontFamily = Sora,
                                    fontWeight = FontWeight.Bold, fontSize = 12.sp)
                            }
                        }
                        Spacer(Modifier.width(8.dp))
                        Text(it, style = MaterialTheme.typography.bodyMedium)
                    }
                }
                Spacer(Modifier.width(8.dp))
            }
            onLockCode?.let { IconButton(onClick = it) { Icon(Icons.Filled.Lock, "Vygenerovať kód zámku") } }
            onRefresh?.let { IconButton(onClick = it) { Icon(Icons.Filled.Refresh, "Obnoviť") } }
            IconButton(onClick = onLogout) { Icon(Icons.AutoMirrored.Filled.Logout, "Odhlásiť") }
        }
    }
}

/** Tenký shift status strip — trvanie zmeny + otvorené stoly + tržby dnes. */
@Composable
fun ShiftStrip(openTables: Int, totalTables: Int, revenueToday: Double?) {
    // Trvanie zmeny — od štartu session (web parita: pos_shift_started_at).
    val sessionStart = remember {
        sk.surfspirit.pos.core.AppPrefs.getRaw("session_start")?.toLongOrNull()
            ?: System.currentTimeMillis().also {
                sk.surfspirit.pos.core.AppPrefs.putRaw("session_start", it.toString())
            }
    }
    var tick by remember { mutableStateOf(0) }
    LaunchedEffect(Unit) { while (true) { delay(30_000); tick++ } }
    val elapsedMs = remember(tick) { System.currentTimeMillis() - sessionStart }
    val hrs = elapsedMs / 3_600_000
    val mins = (elapsedMs % 3_600_000) / 60_000

    // Live dot pulz — JEDINÁ slučka na floor view; len keď je niečo otvorené.
    val dotAlpha = if (openTables > 0 && !reducedMotion()) {
        val tr = rememberInfiniteTransition(label = "liveDot")
        tr.animateFloat(0.45f, 1f,
            infiniteRepeatable(tween(1100), RepeatMode.Reverse), label = "dotA").value
    } else 1f

    Surface(color = MaterialTheme.colorScheme.surfaceVariant,
        modifier = Modifier.drawBehind {
            drawLine(BorderSoft, start = androidx.compose.ui.geometry.Offset(0f, size.height),
                end = androidx.compose.ui.geometry.Offset(size.width, size.height), strokeWidth = 1f)
        }) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Surface(shape = CircleShape, color = if (openTables > 0) Terra else Sage,
                modifier = Modifier.size(8.dp).alpha(dotAlpha)) {}
            Spacer(Modifier.width(8.dp))
            Text("Zmena: ${hrs}h ${mins.toString().padStart(2, '0')}m",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text("  ·  ", style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text("Otvorené stoly: $openTables / $totalTables",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            revenueToday?.let {
                Text("  ·  Tržby dnes: ", style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                AnimatedMoney(it, MaterialTheme.typography.labelMedium.copy(
                    fontFamily = Sora, fontWeight = FontWeight.Bold), Terra)
            }
        }
    }
}

/**
 * Espresso snackbar — tmavý toast na cream pozadí so sémantickým ľavým
 * prúžkom (✔ sage · ⏳ amber · chyba rust · inak terra). Nahrádza stock
 * šedý M3 snackbar v oboch Scaffoldoch.
 */
@Composable
fun PosSnackbarHost(state: SnackbarHostState) {
    SnackbarHost(state) { data ->
        val msg = data.visuals.message
        val bar = when {
            msg.startsWith("✔") -> Sage
            msg.startsWith("⏳") || msg.contains("Offline", ignoreCase = true) -> Amber
            msg.contains("hyba") || msg.contains("zlyhal") || msg.contains("CHÝBA")
                || msg.contains("nepodarilo") -> Danger
            else -> Terra
        }
        Surface(
            Modifier.padding(16.dp).paperShadow(6.dp, RoundedCornerShape(12.dp)),
            shape = RoundedCornerShape(12.dp), color = Espresso, contentColor = Cream,
        ) {
            Row(Modifier.height(IntrinsicSize.Min), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.width(4.dp).fillMaxHeight().background(bar))
                Text(msg, Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
                    style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
}

/**
 * OFFLINE banner — červený pás keď posledný fetch zlyhal (web parita).
 * Zostáva zámerne hlasný (safety); vsúva sa plynulo, neskáče layoutom.
 */
@Composable
fun OfflineBanner() {
    val offline by sk.surfspirit.pos.core.Net.offline
    val queued by sk.surfspirit.pos.core.Net.queueCount
    AnimatedVisibility(
        visible = offline || queued > 0,
        enter = expandVertically(tween(Motion.NORMAL)) + fadeIn(tween(Motion.NORMAL)),
        exit = shrinkVertically(tween(Motion.FAST)) + fadeOut(tween(Motion.FAST)),
    ) {
        Surface(color = if (offline) Danger else Amber) {
            Text(
                if (offline)
                    "OFFLINE — dáta sa synchronizujú po obnovení pripojenia" +
                        (if (queued > 0) "  ·  $queued vo fronte" else "")
                else
                    "$queued operácií vo fronte — synchronizujem…",
                Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 5.dp),
                color = Cream,
                style = MaterialTheme.typography.labelMedium,
                textAlign = TextAlign.Center,
            )
        }
    }
}
