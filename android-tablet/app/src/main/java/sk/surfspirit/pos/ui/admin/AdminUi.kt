package sk.surfspirit.pos.ui.admin

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import sk.surfspirit.pos.ui.theme.*

/* =====================================================================
   Admin UI kit — zdieľané stavebné bloky pre natívne admin obrazovky.
   Daylight identita: paper karty, warm-taupe bordery, Sora čísla.
   ===================================================================== */

/** Sekčný nadpis — Sora, s voliteľnou akciou vpravo. */
@Composable
fun AdminSectionTitle(title: String, modifier: Modifier = Modifier, action: (@Composable () -> Unit)? = null) {
    Row(modifier.fillMaxWidth().padding(bottom = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
        action?.invoke()
    }
}

/** Stat karta — label hore, veľké Sora číslo, voliteľný delta riadok. */
@Composable
fun StatCard(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
    accent: Color = Terra,
    sub: String? = null,
    subColor: Color? = null,
) {
    Surface(
        modifier.paperShadow(2.dp, RoundedCornerShape(14.dp)),
        shape = RoundedCornerShape(14.dp),
        color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, BorderSoft),
    ) {
        Column(Modifier.padding(horizontal = 14.dp, vertical = 12.dp)) {
            Text(label.uppercase(), style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(4.dp))
            Text(value, style = MaterialTheme.typography.titleLarge, color = accent, maxLines = 1)
            sub?.let {
                Spacer(Modifier.height(2.dp))
                Text(it, style = MaterialTheme.typography.labelSmall,
                    color = subColor ?: MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
            }
        }
    }
}

/** Paper karta — obal pre sekcie/tabuľky. */
@Composable
fun AdminCard(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Surface(
        modifier.paperShadow(2.dp, RoundedCornerShape(14.dp)),
        shape = RoundedCornerShape(14.dp),
        color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, BorderSoft),
    ) {
        Column(Modifier.padding(14.dp), content = content)
    }
}

/** Hlavička tabuľky — uppercase labels podľa váh stĺpcov. */
@Composable
fun TableHeader(vararg cols: Pair<String, Float>) {
    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        cols.forEach { (label, w) ->
            Text(label.uppercase(), Modifier.weight(w),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
        }
    }
    HorizontalDivider(color = BorderSoft)
}

/** Riadok tabuľky — bunky podľa váh; voliteľný onClick. */
@Composable
fun TableRow(
    cells: List<Pair<String, Float>>,
    modifier: Modifier = Modifier,
    cellColors: List<Color?>? = null,
    onClick: (() -> Unit)? = null,
) {
    val base = Modifier.fillMaxWidth().padding(vertical = 8.dp)
    val rowMod = if (onClick != null) {
        val interaction = remember { MutableInteractionSource() }
        modifier.pressScale(interaction).then(base)
    } else modifier.then(base)
    Surface(color = Color.Transparent, onClick = onClick ?: {}, enabled = onClick != null) {
        Row(rowMod, verticalAlignment = Alignment.CenterVertically) {
            cells.forEachIndexed { i, (text, w) ->
                Text(text, Modifier.weight(w), style = MaterialTheme.typography.bodyMedium,
                    color = cellColors?.getOrNull(i) ?: MaterialTheme.colorScheme.onSurface,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
    HorizontalDivider(color = BorderSoft.copy(alpha = 0.5f))
}

/** Pill tab row — pre podstránky (Denný / Týždenný / Sezóna…). */
@Composable
fun PillTabs(tabs: List<String>, selected: Int, onSelect: (Int) -> Unit) {
    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        tabs.forEachIndexed { i, t ->
            val active = i == selected
            Surface(onClick = { onSelect(i) }, shape = RoundedCornerShape(999.dp),
                color = if (active) Terra else MaterialTheme.colorScheme.surface,
                border = BorderStroke(1.dp, if (active) Terra else BorderSoft)) {
                Text(t, Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
                    color = if (active) Cream else MaterialTheme.colorScheme.onSurface,
                    style = MaterialTheme.typography.labelMedium)
            }
        }
    }
}

/** Status badge — tint + farba podľa sémantiky. */
@Composable
fun StatusBadge(text: String, color: Color) {
    Surface(shape = RoundedCornerShape(6.dp), color = color.copy(alpha = 0.12f),
        border = BorderStroke(1.dp, color.copy(alpha = 0.35f))) {
        Text(text, Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
            style = MaterialTheme.typography.labelSmall, color = color, maxLines = 1)
    }
}

/** Loading / error / empty stavy. */
@Composable
fun LoadingBox() {
    Box(Modifier.fillMaxWidth().padding(40.dp), contentAlignment = Alignment.Center) {
        CircularProgressIndicator()
    }
}

@Composable
fun ErrorBox(message: String, onRetry: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(message, color = Danger, style = MaterialTheme.typography.bodyMedium)
        Spacer(Modifier.height(10.dp))
        Button(onClick = onRetry) { Text("Skúsiť znova") }
    }
}

@Composable
fun EmptyHint(text: String) {
    Box(Modifier.fillMaxWidth().padding(28.dp), contentAlignment = Alignment.Center) {
        Text(text, style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** Denná navigácia ‹ dátum › + „Dnes". */
@Composable
fun DateNav(label: String, onPrev: () -> Unit, onNext: () -> Unit, onToday: (() -> Unit)? = null) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        OutlinedButton(onClick = onPrev, contentPadding = PaddingValues(horizontal = 10.dp)) { Text("‹") }
        Text(label, style = MaterialTheme.typography.titleSmall)
        OutlinedButton(onClick = onNext, contentPadding = PaddingValues(horizontal = 10.dp)) { Text("›") }
        onToday?.let { TextButton(onClick = it) { Text("Dnes", color = Navy) } }
    }
}

/** Jednoduchý stĺpcový graf (Canvas) — hodiny dňa / dni týždňa. */
@Composable
fun BarChart(
    values: List<Double>,
    labels: List<String>,
    modifier: Modifier = Modifier,
    barColor: Color = Terra,
    height: Int = 140,
) {
    val maxV = (values.maxOrNull() ?: 0.0).coerceAtLeast(0.0001)
    Column(modifier.fillMaxWidth()) {
        Canvas(Modifier.fillMaxWidth().height(height.dp)) {
            val n = values.size.coerceAtLeast(1)
            val slot = size.width / n
            val barW = slot * 0.62f
            values.forEachIndexed { i, v ->
                val h = (v / maxV).toFloat() * size.height
                drawRoundRect(
                    color = barColor.copy(alpha = if (v > 0) 0.85f else 0.15f),
                    topLeft = Offset(i * slot + (slot - barW) / 2, size.height - h),
                    size = Size(barW, h.coerceAtLeast(2f)),
                    cornerRadius = androidx.compose.ui.geometry.CornerRadius(4f, 4f),
                )
            }
        }
        Row(Modifier.fillMaxWidth()) {
            labels.forEach {
                Text(it, Modifier.weight(1f), style = MaterialTheme.typography.labelSmall.copy(fontSize = 9.sp),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1, overflow = TextOverflow.Clip)
            }
        }
    }
}

/* ---------- Toast + screen scaffold ---------- */

class AdminToastState {
    var message by mutableStateOf<String?>(null)
    var isError by mutableStateOf(false)
    fun show(msg: String, error: Boolean = false) { message = msg; isError = error }
}

@Composable
fun rememberAdminToast(): AdminToastState = remember { AdminToastState() }

/**
 * Obal admin obrazovky — scroll obsah + toast overlay (espresso pill so
 * sémantickým prúžkom). Každá obrazovka si drží vlastný AdminToastState.
 */
@Composable
fun AdminScreenBox(
    toast: AdminToastState,
    scrollable: Boolean = true,
    content: @Composable ColumnScope.() -> Unit,
) {
    Box(Modifier.fillMaxSize()) {
        val base = Modifier.fillMaxSize().padding(16.dp)
        Column(if (scrollable) base.verticalScroll(rememberScrollState()) else base, content = content)
        toast.message?.let { msg ->
            LaunchedEffect(msg) {
                kotlinx.coroutines.delay(if (toast.isError) 4000 else 2500)
                toast.message = null
            }
            Surface(
                Modifier.align(Alignment.BottomCenter).padding(16.dp)
                    .paperShadow(6.dp, RoundedCornerShape(12.dp)),
                shape = RoundedCornerShape(12.dp), color = Espresso, contentColor = Cream,
            ) {
                Row(Modifier.height(IntrinsicSize.Min), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.width(4.dp).fillMaxHeight()
                        .background(if (toast.isError) Danger else Sage))
                    Text(msg, Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
                        style = MaterialTheme.typography.bodyMedium)
                }
            }
        }
    }
}

/** Potvrdzovací dialóg pre admin akcie. */
@Composable
fun AdminConfirm(
    title: String,
    text: String,
    confirmLabel: String = "Potvrdiť",
    danger: Boolean = false,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { Text(text) },
        confirmButton = {
            Button(onClick = onConfirm,
                colors = ButtonDefaults.buttonColors(
                    containerColor = if (danger) Danger else Terra, contentColor = Cream)) {
                Text(confirmLabel)
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Zrušiť") } },
    )
}

/** Form pole s labelom — jednotný vzhľad admin formulárov. */
@Composable
fun FormField(
    label: String,
    value: String,
    onChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    placeholder: String = "",
    singleLine: Boolean = true,
    keyboard: androidx.compose.foundation.text.KeyboardOptions = androidx.compose.foundation.text.KeyboardOptions.Default,
    suffix: String? = null,
) {
    Column(modifier) {
        Text(label, style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(4.dp))
        OutlinedTextField(
            value = value, onValueChange = onChange,
            placeholder = { if (placeholder.isNotBlank()) Text(placeholder) },
            singleLine = singleLine, keyboardOptions = keyboard,
            suffix = suffix?.let { { Text(it) } },
            modifier = Modifier.fillMaxWidth(),
        )
    }
}
