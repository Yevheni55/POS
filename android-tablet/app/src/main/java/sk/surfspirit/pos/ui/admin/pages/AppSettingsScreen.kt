package sk.surfspirit.pos.ui.admin.pages

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import sk.surfspirit.pos.core.AppPrefs
import sk.surfspirit.pos.ui.admin.AdminCard
import sk.surfspirit.pos.ui.admin.AdminScreenBox
import sk.surfspirit.pos.ui.admin.AdminSectionTitle
import sk.surfspirit.pos.ui.admin.PillTabs
import sk.surfspirit.pos.ui.theme.Cream
import sk.surfspirit.pos.ui.theme.Terra

/**
 * AppSettingsScreen — nastavenia APLIKÁCIE na tomto zariadení (AppPrefs).
 * Nezamieňať s webovým „Nastavenia" (firma/tlač/zľavy — WebView stránka):
 * tu žijú veci lokálne pre tablet — QR platba, undo okno, výkonový režim.
 */
@Composable
fun AppSettingsScreen() {
    var qrEnabled by remember { mutableStateOf(AppPrefs.qrPaymentEnabled) }
    var undoSecs by remember { mutableStateOf(AppPrefs.sendUndoSecs) }
    var perfIdx by remember {
        mutableStateOf(when (AppPrefs.perfMode) { "on" -> 1; "off" -> 2; else -> 0 })
    }

    AdminScreenBox {
        AdminSectionTitle("Aplikácia — nastavenia zariadenia")
        Text(
            "Platia len pre tento tablet (ukladajú sa lokálne). Firemné údaje, " +
                "tlačiarne a zľavy sú v Nastaveniach (web admin).",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(14.dp))

        AdminCard {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("QR platba (Portos PayMe)", style = MaterialTheme.typography.titleSmall)
                    Text(
                        if (qrEnabled) "Tlačidlo „QR platba“ je na pokladni viditeľné."
                        else "Tlačidlo „QR platba“ je skryté — zákazník platí len hotovosťou/kartou.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Spacer(Modifier.width(12.dp))
                Switch(
                    checked = qrEnabled,
                    onCheckedChange = { qrEnabled = it; AppPrefs.qrPaymentEnabled = it },
                    colors = SwitchDefaults.colors(checkedTrackColor = Terra, checkedThumbColor = Cream),
                )
            }
        }
        Spacer(Modifier.height(12.dp))

        AdminCard {
            Text("Undo okno pre „Poslať“", style = MaterialTheme.typography.titleSmall)
            Text(
                if (undoSecs == 0) "Vypnuté — Poslať odchádza okamžite."
                else "Poslať sa dá vrátiť do $undoSecs s (0 = vypnuté).",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(6.dp))
            Row(verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Slider(
                    value = undoSecs.toFloat(),
                    onValueChange = { undoSecs = it.toInt() },
                    onValueChangeFinished = { AppPrefs.sendUndoSecs = undoSecs },
                    valueRange = 0f..10f,
                    steps = 9,
                    modifier = Modifier.weight(1f),
                )
                Text("$undoSecs s", style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.width(38.dp))
            }
        }
        Spacer(Modifier.height(12.dp))

        AdminCard {
            Text("Výkonový režim", style = MaterialTheme.typography.titleSmall)
            Text(
                "Slabý tablet: vypne drahé GPU efekty (blur, glow). Zmena sa prejaví po reštarte appky.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(8.dp))
            PillTabs(listOf("Auto", "Šetrný", "Plný vizuál"), perfIdx) {
                perfIdx = it
                AppPrefs.perfMode = when (it) { 1 -> "on"; 2 -> "off"; else -> "auto" }
            }
        }
    }
}
