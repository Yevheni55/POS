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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import sk.surfspirit.pos.ui.theme.*

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

/** Header bar — logo + názov vľavo, user + akcie vpravo (web parita). */
@Composable
fun PosHeader(
    title: String,
    userName: String?,
    onLogout: () -> Unit,
    onRefresh: (() -> Unit)? = null,
) {
    Surface(color = MaterialTheme.colorScheme.surface, tonalElevation = 2.dp) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            BrandLogo(38)
            Spacer(Modifier.width(12.dp))
            Column {
                Text("Kaviareň & Bar", style = MaterialTheme.typography.titleMedium)
                Text("Pokladničný systém", style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Spacer(Modifier.width(20.dp))
            Text(title, style = MaterialTheme.typography.titleLarge)
            Spacer(Modifier.weight(1f))
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
