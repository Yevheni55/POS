package sk.surfspirit.pos.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
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
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(999.dp),
        color = if (active) Terra else Color.Transparent,
    ) {
        Text(label, Modifier.padding(horizontal = 16.dp, vertical = 7.dp),
            color = if (active) Cream else MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.labelLarge)
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
) {
    val now by rememberNow()
    Surface(color = MaterialTheme.colorScheme.surface, tonalElevation = 2.dp) {
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
            onRefresh?.let { IconButton(onClick = it) { Icon(Icons.Filled.Refresh, "Obnoviť") } }
            IconButton(onClick = onLogout) { Icon(Icons.AutoMirrored.Filled.Logout, "Odhlásiť") }
        }
    }
}

/** Tenký shift status strip — otvorené stoly + (best-effort) tržby dnes. */
@Composable
fun ShiftStrip(openTables: Int, totalTables: Int, revenueToday: String?) {
    Surface(color = MaterialTheme.colorScheme.surfaceVariant) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Surface(shape = CircleShape, color = if (openTables > 0) Terra else Sage,
                modifier = Modifier.size(8.dp)) {}
            Spacer(Modifier.width(8.dp))
            Text("Otvorené stoly: $openTables / $totalTables",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            revenueToday?.let {
                Text("  ·  ", style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text("Tržby dnes: $it", style = MaterialTheme.typography.labelMedium,
                    color = Terra, fontWeight = FontWeight.Bold)
            }
        }
    }
}
