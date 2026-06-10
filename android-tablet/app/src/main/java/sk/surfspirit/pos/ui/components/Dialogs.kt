package sk.surfspirit.pos.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.outlined.Autorenew
import androidx.compose.material.icons.outlined.LocalFireDepartment
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import sk.surfspirit.pos.core.errorMessage
import sk.surfspirit.pos.core.httpCode
import sk.surfspirit.pos.core.money
import sk.surfspirit.pos.net.*
import sk.surfspirit.pos.ui.theme.*

/* ============================ Generic confirm ============================ */

@Composable
fun ConfirmDialog(
    title: String,
    message: String,
    confirmLabel: String = "Potvrdiť",
    dismissLabel: String = "Zrušiť",
    danger: Boolean = false,
    busy: Boolean = false,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(title) },
        text = { Text(message) },
        confirmButton = {
            Button(
                onClick = onConfirm,
                enabled = !busy,
                colors = if (danger) ButtonDefaults.buttonColors(containerColor = Danger, contentColor = Cream)
                         else ButtonDefaults.buttonColors(containerColor = Terra, contentColor = Cream),
            ) {
                if (busy) CircularProgressIndicator(Modifier.size(18.dp), color = Cream, strokeWidth = 2.dp)
                else Text(confirmLabel)
            }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text(dismissLabel) } },
    )
}

/* ============================ PIN pad (zdieľaný) ============================
   Implementácia žije v PinPad.kt (PinPad/PinDots/PinPadSize/PinPadCorner). */

@Deprecated("Použi PinPad(size = PinPadSize.Dialog, corner = PinPadCorner.Confirm(...))",
    ReplaceWith("PinPad(onDigit, onBackspace, size = PinPadSize.Dialog, corner = PinPadCorner.Confirm(okEnabled, onOk))"))
@Composable
fun NumPad(onDigit: (String) -> Unit, onBackspace: () -> Unit, onOk: () -> Unit, okEnabled: Boolean, keySize: Int = 64) {
    PinPad(onDigit, onBackspace,
        size = PinPadSize.Dialog,
        corner = PinPadCorner.Confirm(okEnabled, onOk))
}

/* ======================== Manager PIN gate ======================== */

/**
 * Manažérsky PIN — overí cez POST /api/auth/verify-manager. Po úspechu volá
 * onVerified(). Web parita: storno odoslaných položiek, zľava, zrušenie
 * zaplatenej objednávky, override limitu.
 */
@Composable
fun ManagerPinDialog(contextLabel: String, onVerified: () -> Unit, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    var pin by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    fun submit() {
        if (pin.length < 4 || busy) return
        busy = true; error = null
        scope.launch {
            try {
                val resp = withContext(Dispatchers.IO) { Api.service.verifyManager(ManagerVerifyReq(pin)) }
                if (resp.ok) {
                    // Krátkodobá elevácia (~110 s okno): auth interceptor posiela
                    // manažérsky token namiesto čašníckeho, takže gated follow-up
                    // volanie (storno/zľava/...) prejde requireRole na serveri.
                    if (resp.token.isNotBlank()) Api.setElevated(resp.token)
                    onVerified()
                } else { error = "Neoprávnený prístup."; pin = "" }
            } catch (e: Exception) {
                error = errorMessage(e); pin = ""
            } finally { busy = false }
        }
    }

    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text("Manažérsky PIN") },
        text = {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                if (contextLabel.isNotBlank()) {
                    Text(contextLabel, style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.height(12.dp))
                }
                PinDots(pin.length)
                Spacer(Modifier.height(16.dp))
                PinPad(
                    onDigit = { if (pin.length < 6) pin += it },
                    onBackspace = { if (pin.isNotEmpty()) pin = pin.dropLast(1) },
                    size = PinPadSize.Dialog,
                    corner = PinPadCorner.Confirm(
                        enabled = pin.length >= 4 && !busy,
                        onConfirm = { submit() },
                        busy = busy,
                    ),
                )
                error?.let {
                    Spacer(Modifier.height(10.dp))
                    Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text("Zrušiť") } },
    )
}

/* ======================== Storno dôvod (web parita) ======================== */

/** Výsledok storno reason modalu — ide do POST /api/storno-basket. */
data class StornoReason(val reason: String, val wasPrepared: Boolean, val note: String)

private val STORNO_REASONS = listOf(
    "order_error" to "Chyba objednávky",
    "complaint" to "Reklamácia",
    "breakage" to "Rozbité / rozliate",
    "staff_meal" to "Zamestnanecká spotreba",
    "other" to "Iné",
)

/**
 * Bežný prípad = 1 tap: voľby sú PREDVOLENÉ (storno sa v praxi týka už
 * odoslanej položky → pripravené=true, dôvod=chyba objednávky) a cashier
 * ich len potvrdí alebo zmení vo výnimke. Vedomá divergencia od webu
 * (tam žiadne defaulty) — schválené pri návrhu v3.0.
 */
@Composable
fun StornoReasonDialog(
    itemName: String,
    qty: Int,
    defaultPrepared: Boolean? = null,
    defaultReason: String? = null,
    batchLines: List<String> = emptyList(),   // >1 položka = spoločný dôvod pre všetky
    onConfirm: (StornoReason) -> Unit,
    onDismiss: () -> Unit,
) {
    var wasPrepared by remember { mutableStateOf(defaultPrepared) }
    var reason by remember { mutableStateOf(defaultReason) }
    var note by remember { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Column {
                Text(if (batchLines.isEmpty()) "$qty× $itemName" else itemName,
                    style = MaterialTheme.typography.titleMedium)
                Text("STORNO", style = MaterialTheme.typography.labelSmall, color = Danger)
            }
        },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                if (batchLines.isNotEmpty()) {
                    Surface(shape = RoundedCornerShape(Radius.sm),
                        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)) {
                        Column(Modifier.fillMaxWidth().padding(10.dp),
                            verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            batchLines.forEach { Text(it, style = MaterialTheme.typography.bodyMedium) }
                        }
                    }
                    Text("Spoločný dôvod pre všetky položky",
                        Modifier.padding(top = 4.dp, bottom = 8.dp),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Text("Bolo už pripravené?", style = MaterialTheme.typography.labelMedium)
                Spacer(Modifier.height(6.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    PrepBtn("Áno, pripravené", "jedlo / nápoj išlo von → odpis",
                        Icons.Outlined.LocalFireDepartment,
                        wasPrepared == true, Modifier.weight(1f)) { wasPrepared = true }
                    PrepBtn("Nie, nestihli sme", "vrátiť suroviny na sklad",
                        Icons.Outlined.Autorenew,
                        wasPrepared == false, Modifier.weight(1f)) { wasPrepared = false }
                }
                Spacer(Modifier.height(12.dp))
                Text("Dôvod", style = MaterialTheme.typography.labelMedium)
                Spacer(Modifier.height(6.dp))
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    STORNO_REASONS.chunked(2).forEach { row ->
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            row.forEach { (value, label) ->
                                val active = reason == value
                                Surface(
                                    onClick = { reason = value },
                                    shape = RoundedCornerShape(Radius.sm),
                                    color = if (active) Terra.copy(alpha = 0.12f) else MaterialTheme.colorScheme.surface,
                                    border = BorderStroke(1.dp, if (active) Terra else MaterialTheme.colorScheme.outline),
                                    modifier = Modifier.weight(1f),
                                ) {
                                    Text(label, Modifier.padding(horizontal = 10.dp, vertical = 10.dp),
                                        style = MaterialTheme.typography.bodyMedium,
                                        color = if (active) Terra else MaterialTheme.colorScheme.onSurface,
                                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                                }
                            }
                            if (row.size == 1) Spacer(Modifier.weight(1f))
                        }
                    }
                }
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = note, onValueChange = { if (it.length <= 200) note = it },
                    placeholder = { Text("Poznámka (voliteľná)") },
                    modifier = Modifier.fillMaxWidth(), singleLine = true,
                    shape = RoundedCornerShape(Radius.md),
                )
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    val wp = wasPrepared; val r = reason
                    if (wp != null && r != null) onConfirm(StornoReason(r, wp, note.trim()))
                },
                enabled = wasPrepared != null && reason != null,
                colors = ButtonDefaults.buttonColors(containerColor = Terra, contentColor = Cream),
            ) { Text("Potvrdiť") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Zrušiť") } },
    )
}

@Composable
private fun PrepBtn(
    label: String, hint: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    active: Boolean, modifier: Modifier, onClick: () -> Unit,
) {
    val interaction = remember { MutableInteractionSource() }
    val fill by animateColorAsState(if (active) Terra.copy(alpha = 0.12f) else MaterialTheme.colorScheme.surface,
        colorSpecOrSnap(), label = "prep")
    val edge by animateColorAsState(if (active) Terra else BorderSoft, colorSpecOrSnap(), label = "prepE")
    Surface(
        onClick = onClick, interactionSource = interaction, shape = RoundedCornerShape(Radius.sm),
        color = fill, border = BorderStroke(1.dp, edge),
        modifier = modifier.pressScale(interaction),
    ) {
        Column(Modifier.padding(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(icon, null, Modifier.size(IconSize.md),
                    tint = if (active) Terra else MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.width(6.dp))
                Text(label, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold,
                    color = if (active) Terra else MaterialTheme.colorScheme.onSurface)
            }
            Text(hint, style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/* ============================ Item note ============================ */

// Web parita — 8 presetov, chips TOGGLE (tap pridá, tap znova odoberie).
private val NOTE_PRESETS = listOf(
    "bez cibule", "bez majonézy", "bez paradajok", "extra ostré",
    "medium", "prepečené", "bez ľadu", "alergia",
)

@Composable
fun NoteDialog(initial: String, sent: Boolean = false, onSave: (String) -> Unit, onDismiss: () -> Unit) {
    var note by remember { mutableStateOf(initial) }

    fun parts(): List<String> = note.split(",").map { it.trim() }.filter { it.isNotEmpty() }
    fun togglePreset(preset: String) {
        val p = parts().toMutableList()
        if (p.contains(preset)) p.remove(preset) else p.add(preset)
        note = p.joinToString(", ")
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Poznámka k položke") },
        text = {
            Column {
                if (sent) {
                    Text("Položka už bola odoslaná — poznámka sa uloží k účtu. Nový bon sa nevytlačí.",
                        style = MaterialTheme.typography.labelSmall, color = Amber)
                    Spacer(Modifier.height(8.dp))
                }
                OutlinedTextField(
                    value = note, onValueChange = { if (it.length <= 200) note = it },
                    placeholder = { Text("napr. bez cibule") },
                    modifier = Modifier.fillMaxWidth(), minLines = 2,
                    shape = RoundedCornerShape(Radius.md),
                )
                Spacer(Modifier.height(10.dp))
                val active = parts()
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    NOTE_PRESETS.chunked(3).forEach { row ->
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            row.forEach { opt ->
                                val isOn = active.contains(opt)
                                FilterChip(selected = isOn, onClick = { togglePreset(opt) },
                                    label = { Text(opt, maxLines = 1) })
                            }
                        }
                    }
                }
            }
        },
        confirmButton = { Button(onClick = { onSave(note.trim()) }) { Text("Uložiť") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Zrušiť") } },
    )
}

/* ============================ Sauce / combo picker ============================ */

// Emoji = rýchly periférny scan v rušnej smene; poradie zhodné s webom.
private val SAUCES = listOf(
    "🍔" to "Big Mac domáca",
    "🌶️" to "Chilli-mayo",
    "🥒" to "Tatárka domáca",
    "🍅" to "Kečup",
    "🔥" to "BBQ",
)

/**
 * Sauce picker pre combá — web parita: ak má objednávka rovnaké combo už
 * s omáčkou, hore je prominent „Opakovať omáčku" CTA (1 klik = rovnaká
 * voľba) + voľby sú pre-checknuté. onConfirm dostáva zoznam omáčok
 * (prázdny = bez omáčky); zrušenie = onDismiss.
 *
 * Warm Hearth: veľké tap-karty (≥46 dp) s emoji + fajkou namiesto
 * checkboxov, ember CTA na opakovanie, pill tlačidlá.
 *
 * @param previous null = žiadna predchádzajúca voľba; [] = „bez omáčky"
 */
@Composable
fun SauceDialog(
    productName: String,
    previous: List<String>? = null,
    onConfirm: (List<String>) -> Unit,
    onDismiss: () -> Unit,
) {
    val sel = remember { mutableStateListOf<String>().apply { previous?.let { addAll(it) } } }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Column {
                Text("Omáčka", style = MaterialTheme.typography.titleLarge.copy(fontFamily = Serif))
                Text(productName, style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        },
        text = {
            Column(
                Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (previous != null) {
                    val prevLabel = if (previous.isEmpty()) "bez omáčky" else previous.joinToString(" + ")
                    val repInt = remember { MutableInteractionSource() }
                    Surface(
                        onClick = { onConfirm(previous) },
                        interactionSource = repInt,
                        shape = RoundedCornerShape(Radius.md),
                        color = Color.Transparent,
                        modifier = Modifier.fillMaxWidth()
                            .paperShadow(Elev.rest, RoundedCornerShape(Radius.md))
                            .pressScale(repInt),
                    ) {
                        Row(
                            Modifier.background(emberBrush()).padding(horizontal = 14.dp, vertical = 12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text("↻ OPAKOVAŤ OMÁČKU", style = MaterialTheme.typography.labelSmall,
                                    color = Cream.copy(alpha = 0.85f))
                                Text(prevLabel, style = MaterialTheme.typography.bodyLarge,
                                    fontWeight = FontWeight.Bold, color = Cream,
                                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                            Icon(Icons.Filled.Check, null, Modifier.size(IconSize.lg), tint = Cream)
                        }
                    }
                    Spacer(Modifier.height(2.dp))
                }
                SAUCES.forEach { (emoji, name) ->
                    SauceRow(emoji, name, selected = sel.contains(name)) {
                        if (sel.contains(name)) sel.remove(name) else sel.add(name)
                    }
                }
            }
        },
        confirmButton = {
            Row {
                OutlinedButton(
                    onClick = { onConfirm(emptyList()) },
                    shape = RoundedCornerShape(Radius.full),
                    border = BorderStroke(1.dp, BorderSoft),
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.onSurfaceVariant),
                ) { Text("Bez omáčky") }
                Spacer(Modifier.width(8.dp))
                Button(
                    onClick = { onConfirm(sel.toList()) },
                    shape = RoundedCornerShape(Radius.full),
                    colors = ButtonDefaults.buttonColors(containerColor = Terra, contentColor = Cream),
                ) { Text(if (sel.isEmpty()) "Potvrdiť" else "Potvrdiť (${sel.size})") }
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Zrušiť") } },
    )
}

/** Tap-karta omáčky — vizuálny jazyk MoveSelectRow (terra tint + fajka v krúžku). */
@Composable
private fun SauceRow(emoji: String, name: String, selected: Boolean, onToggle: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val fill by animateColorAsState(
        if (selected) Terra.copy(alpha = 0.10f) else MaterialTheme.colorScheme.surface,
        colorSpecOrSnap(), label = "sauceFill")
    val edge by animateColorAsState(if (selected) Terra else BorderSoft, colorSpecOrSnap(), label = "sauceEdge")
    Surface(
        onClick = onToggle,
        interactionSource = interaction,
        shape = RoundedCornerShape(Radius.md),
        color = fill,
        border = BorderStroke(1.dp, edge),
        modifier = Modifier.fillMaxWidth().heightIn(min = 46.dp).pressScale(interaction),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
            Text(emoji, style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.width(10.dp))
            Text(name, Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge,
                fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium,
                color = if (selected) Terra else MaterialTheme.colorScheme.onSurface,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
            Box(
                Modifier.size(22.dp)
                    .background(if (selected) Terra else Color.Transparent, CircleShape)
                    .border(1.5.dp, if (selected) Terra else BorderSoft, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                if (selected) Icon(Icons.Filled.Check, null, Modifier.size(IconSize.sm), tint = Cream)
            }
        }
    }
}

/* ============================ Qty pickery ============================ */

/**
 * Long-press bulk add — mriežka 1..10, jeden gest = 5× Pivo (web qtyPopup).
 */
@Composable
@OptIn(ExperimentalMaterial3Api::class)   // ModalBottomSheet
fun QtyPopupDialog(itemName: String, onPick: (Int) -> Unit, onDismiss: () -> Unit) {
    val qtyGrid: @Composable () -> Unit = {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Počet kusov", style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            (1..10).chunked(5).forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    row.forEach { n ->
                        Surface(onClick = { onPick(n) }, shape = RoundedCornerShape(Radius.sm),
                            color = MaterialTheme.colorScheme.surface,
                            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
                            modifier = Modifier.size(52.dp)) {
                            Box(contentAlignment = Alignment.Center) {
                                Text("$n", style = MaterialTheme.typography.titleMedium, color = Terra)
                            }
                        }
                    }
                }
            }
        }
    }
    if (isPhone()) {
        // Telefón: bottom sheet — palec dosiahne, swipe-down zruší, menu
        // ostáva viditeľné nad sheetom (modal dialog by zakryl celú obrazovku).
        ModalBottomSheet(onDismissRequest = onDismiss, containerColor = Cream) {
            Column(Modifier.padding(horizontal = Space.s4).padding(bottom = Space.s6)) {
                Text(itemName, style = MaterialTheme.typography.titleSmall,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                Spacer(Modifier.height(10.dp))
                qtyGrid()
            }
        }
    } else AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(itemName, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        text = { qtyGrid() },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onDismiss) { Text("Zrušiť") } },
    )
}

/**
 * „Koľko presunúť?" — stepper 1..max (default = všetko) + quick chips
 * 1 / Polovica / Všetko + suma preview. Web _showMoveQtyPicker parita.
 * Použité v move-mode aj split-by-items.
 */
@Composable
fun MoveQtyPickerDialog(
    itemName: String,
    emoji: String,
    unitPrice: Double,
    maxQty: Int,
    onConfirm: (Int) -> Unit,
    onDismiss: () -> Unit,
) {
    var current by remember { mutableStateOf(maxQty) }
    val half = (maxQty / 2).coerceAtLeast(1)
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Koľko presunúť?") },
        text = {
            Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
                Text("$emoji $itemName", style = MaterialTheme.typography.bodyMedium,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                Spacer(Modifier.height(12.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OutlinedButton(onClick = { if (current > 1) current-- }, enabled = current > 1) { Text("−") }
                    Column(horizontalAlignment = Alignment.CenterHorizontally,
                        modifier = Modifier.padding(horizontal = 20.dp)) {
                        Text("$current", style = MaterialTheme.typography.titleLarge, color = Terra)
                        Text("z celkom $maxQty ks", style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    OutlinedButton(onClick = { if (current < maxQty) current++ }, enabled = current < maxQty) { Text("+") }
                }
                Spacer(Modifier.height(8.dp))
                Text(money(unitPrice * current), style = MaterialTheme.typography.titleMedium, color = Terra)
                Spacer(Modifier.height(10.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    AssistChip(onClick = { current = 1 }, label = { Text("1") })
                    if (maxQty >= 4 && half != 1 && half != maxQty)
                        AssistChip(onClick = { current = half }, label = { Text("Polovica ($half)") })
                    AssistChip(onClick = { current = maxQty }, label = { Text("Všetko ($maxQty)") })
                }
            }
        },
        confirmButton = {
            Button(onClick = { onConfirm(current) },
                colors = ButtonDefaults.buttonColors(containerColor = Terra, contentColor = Cream),
            ) { Text("Potvrdiť") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Zrušiť") } },
    )
}

/* ============================ TTLock kód zámku ============================ */

@Composable
fun LockCodeDialog(code: String, validUntil: String, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("🔐 Kód zámku") },
        text = {
            Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
                Text(code, style = MaterialTheme.typography.titleLarge.copy(fontSize = 44.sp, letterSpacing = 8.sp),   // token-exempt: velkost mimo skaly
                    color = Terra, fontWeight = FontWeight.ExtraBold)
                Spacer(Modifier.height(8.dp))
                Text("Platný do: $validUntil", style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        },
        confirmButton = { Button(onClick = onDismiss) { Text("OK") } },
        dismissButton = {},
    )
}

/* ============================ Discount ============================ */

@Composable
fun DiscountDialog(
    discounts: List<DiscountDto>,
    hasDiscount: Boolean,
    busy: Boolean,
    error: String?,
    onApplyPreset: (Int) -> Unit,
    onApplyCustom: (Double) -> Unit,
    onRemove: () -> Unit,
    onDismiss: () -> Unit,
) {
    var custom by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text("Zľava") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                discounts.forEach { d ->
                    val suffix = if (d.type == "percent") "${d.value.toInt()} %" else money(d.value)
                    OutlinedButton(onClick = { onApplyPreset(d.id) }, enabled = !busy,
                        modifier = Modifier.fillMaxWidth().height(44.dp).padding(vertical = 1.dp)) {
                        Text(d.name, Modifier.weight(1f)); Text(suffix, fontWeight = FontWeight.Bold, color = Terra)
                    }
                }
                Spacer(Modifier.height(8.dp))
                Text("Vlastné %", style = MaterialTheme.typography.labelMedium)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(
                        value = custom, onValueChange = { custom = it.filter { c -> c.isDigit() } },
                        modifier = Modifier.weight(1f), singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        suffix = { Text("%") },
                        shape = RoundedCornerShape(Radius.md),
                    )
                    Spacer(Modifier.width(8.dp))
                    Button(onClick = { custom.toDoubleOrNull()?.let { onApplyCustom(it) } },
                        enabled = !busy && (custom.toDoubleOrNull()?.let { it in 1.0..100.0 } == true)) { Text("Použiť") }
                }
                error?.let {
                    Spacer(Modifier.height(8.dp))
                    Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                }
            }
        },
        confirmButton = {
            if (hasDiscount) TextButton(onClick = onRemove, enabled = !busy) { Text("Odstrániť zľavu", color = Danger) }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text("Zavrieť") } },
    )
}

/* ============================ Split bill ============================ */

@Composable
fun SplitDialog(
    items: List<OrderItemDto>,
    total: Double,
    busy: Boolean,
    error: String?,
    onEqual: (Int) -> Unit,
    onByItems: (List<MoveQty>) -> Unit,
    onDismiss: () -> Unit,
) {
    var tab by remember { mutableStateOf(0) }   // 0 = rovnomerne, 1 = po položkách
    var parts by remember { mutableStateOf(2) }
    // itemId -> vybraná qty (web _splitSelectedItems). Companion/sauce
    // annotation riadky sa nezobrazujú — idú s primárnou položkou.
    val selected = remember { mutableStateMapOf<Long, Int>() }
    var qtyPickFor by remember { mutableStateOf<OrderItemDto?>(null) }

    val pickable = items.filter { it.qty > 0 && it.name != "Omáčka (combo)" }
    val selSubtotal = selected.entries.sumOf { (id, q) ->
        (pickable.firstOrNull { it.id == id }?.price ?: 0.0) * q
    }
    // Guard: aspoň jedna položka (alebo jej časť) musí ostať na pôvodnom účte
    val movingEverything = pickable.isNotEmpty() && pickable.all { selected[it.id] == it.qty }

    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text("Rozdeliť účet") },
        text = {
            Column {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf("Rovnomerne", "Po položkách").forEachIndexed { i, label ->
                        val active = tab == i
                        Surface(
                            onClick = { tab = i },
                            shape = RoundedCornerShape(Radius.full),
                            color = if (active) Terra else Cream,
                            border = if (active) null else BorderStroke(1.dp, BorderSoft),
                        ) {
                            Text(
                                label,
                                modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
                                style = MaterialTheme.typography.labelLarge,
                                color = if (active) Cream else MaterialTheme.colorScheme.onSurface,
                            )
                        }
                    }
                }
                Spacer(Modifier.height(12.dp))
                if (tab == 0) {
                    // Rush path: chips = 1 tap na bežné počty; ± stepper ostáva
                    // len pre nepárne hodnoty (7/9/10).
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp),
                        modifier = Modifier.fillMaxWidth()) {
                        listOf(2, 3, 4, 5, 6, 8).forEach { n ->
                            val active = parts == n
                            Surface(
                                onClick = { parts = n },
                                shape = RoundedCornerShape(Radius.full),
                                color = if (active) Terra else MaterialTheme.colorScheme.surface,
                                border = BorderStroke(1.dp, if (active) Terra else BorderSoft),
                                modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                            ) {
                                Box(contentAlignment = Alignment.Center) {
                                    Text("$n", style = MaterialTheme.typography.titleMedium,
                                        color = if (active) Cream else MaterialTheme.colorScheme.onSurface)
                                }
                            }
                        }
                    }
                    Spacer(Modifier.height(10.dp))
                    Row(verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.Center, modifier = Modifier.fillMaxWidth()) {
                        OutlinedButton(onClick = { if (parts > 2) parts-- }, enabled = parts > 2) { Text("−") }
                        Text("$parts účty", Modifier.padding(horizontal = 20.dp),
                            style = MaterialTheme.typography.titleMedium)
                        OutlinedButton(onClick = { if (parts < 10) parts++ }, enabled = parts < 10) { Text("+") }
                    }
                    Spacer(Modifier.height(8.dp))
                    Text("Každý platí: ${money(total / parts)}",
                        style = MaterialTheme.typography.titleSmall, color = Terra,
                        textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
                } else {
                    Column(Modifier.heightIn(max = 260.dp).verticalScroll(rememberScrollState()),
                        verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        pickable.forEach { it2 ->
                            val selQty = selected[it2.id]
                            val isSel = selQty != null
                            Surface(
                                onClick = {
                                    when {
                                        isSel -> selected.remove(it2.id)
                                        it2.qty <= 1 -> selected[it2.id] = 1
                                        else -> qtyPickFor = it2
                                    }
                                },
                                shape = RoundedCornerShape(Radius.sm),
                                color = if (isSel) Terra.copy(alpha = 0.10f) else MaterialTheme.colorScheme.surface,
                                border = BorderStroke(1.dp, if (isSel) Terra else MaterialTheme.colorScheme.outline),
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Row(verticalAlignment = Alignment.CenterVertically,
                                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp)) {
                                    Icon(if (isSel) Icons.Filled.Check else Icons.Filled.Close,
                                        null, Modifier.size(IconSize.md),
                                        tint = if (isSel) Terra else MaterialTheme.colorScheme.outline)
                                    Spacer(Modifier.width(8.dp))
                                    Text("${it2.emoji} ${it2.name}", Modifier.weight(1f),
                                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    if (it2.qty > 1) {
                                        val badge = if (isSel && selQty!! < it2.qty) "$selQty/${it2.qty}" else "${it2.qty}×"
                                        Text(badge, style = MaterialTheme.typography.labelSmall,
                                            color = if (isSel) Terra else MaterialTheme.colorScheme.onSurfaceVariant)
                                        Spacer(Modifier.width(6.dp))
                                    }
                                    Text(money(it2.price * (selQty ?: it2.qty)),
                                        style = MaterialTheme.typography.bodyMedium)
                                }
                            }
                        }
                    }
                    Spacer(Modifier.height(6.dp))
                    Row {
                        Text("Vybrané na nový účet:", Modifier.weight(1f),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(money(selSubtotal), style = MaterialTheme.typography.labelMedium, color = Terra)
                    }
                    if (movingEverything) {
                        Text("Aspoň jedna položka (alebo jej časť) musí ostať na pôvodnom účte.",
                            style = MaterialTheme.typography.labelSmall, color = Danger)
                    }
                }
                error?.let {
                    Spacer(Modifier.height(8.dp))
                    Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                }
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    if (tab == 0) onEqual(parts)
                    else onByItems(selected.entries.map { (id, q) -> MoveQty(id, q) })
                },
                enabled = !busy && (tab == 0 || (selected.isNotEmpty() && !movingEverything)),
                colors = ButtonDefaults.buttonColors(containerColor = Terra, contentColor = Cream),
            ) {
                if (busy) CircularProgressIndicator(Modifier.size(18.dp), color = Cream, strokeWidth = 2.dp)
                else Text("Rozdeliť")
            }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text("Zrušiť") } },
    )

    qtyPickFor?.let { item ->
        MoveQtyPickerDialog(item.name, item.emoji, item.price, item.qty,
            onConfirm = { q -> selected[item.id] = q; qtyPickFor = null },
            onDismiss = { qtyPickFor = null })
    }
}

/* ============================ Table picker (move) ============================ */

@Composable
fun TablePickerDialog(
    tables: List<TableDto>,
    currentTableId: Int,
    busy: Boolean,
    onPick: (Int) -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text("Vyberte cieľový stôl") },
        text = {
            Column(Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState())) {
                val byZone = tables.filter { it.id != currentTableId }.groupBy { it.zone }
                byZone.forEach { (zone, list) ->
                    Text(zone.replaceFirstChar { it.uppercase() }, style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp, bottom = 4.dp))
                    list.chunked(4).forEach { row ->
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(bottom = 8.dp)) {
                            row.forEach { t ->
                                OutlinedButton(onClick = { onPick(t.id) }, enabled = !busy,
                                    modifier = Modifier.weight(1f),
                                    border = BorderStroke(1.dp, statusColor(t.status).copy(alpha = 0.5f))) {
                                    Text(t.name, maxLines = 1)
                                }
                            }
                            repeat(4 - row.size) { Spacer(Modifier.weight(1f)) }
                        }
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text("Zrušiť") } },
    )
}

/* ============================ Account picker ============================ */

@Composable
fun AccountPickerDialog(
    orders: List<OrderDto>,
    onPick: (Int) -> Unit,
    onNew: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Účty na stole") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                orders.forEach { o ->
                    val count = o.items.sumOf { it.qty }
                    var preview = o.items.take(4).joinToString(" ") { it.emoji }
                    if (o.items.size > 4) preview += " +${o.items.size - 4}"
                    Surface(onClick = { onPick(o.id) }, shape = RoundedCornerShape(Radius.sm),
                        color = MaterialTheme.colorScheme.surface,
                        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
                        modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
                        Row(Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(o.label.ifBlank { "Účet #${o.id}" }, fontWeight = FontWeight.SemiBold)
                                Text(preview.ifBlank { "Prázdny účet" }, style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            Column(horizontalAlignment = Alignment.End) {
                                Text(money(o.grandTotal), fontWeight = FontWeight.Bold, color = Terra)
                                Text("$count pol.", style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }
                }
                Spacer(Modifier.height(6.dp))
                Button(onClick = onNew, colors = ButtonDefaults.buttonColors(containerColor = Sage, contentColor = Cream),
                    modifier = Modifier.fillMaxWidth()) { Text("+ Nový účet") }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onDismiss) { Text("Zavrieť") } },
    )
}

/* ============================ Payment ============================ */

@Composable
fun PaymentDialog(
    total: Double,
    items: List<PrintItem> = emptyList(),   // receipt preview riadky
    tableName: String = "",
    staffName: String = "",
    subtotal: Double = 0.0,
    discount: Double = 0.0,
    busy: Boolean,
    error: String?,
    fiscalNote: String?,
    initialMethod: String = "hotovost",
    payPhase: Int? = null,           // 1=odosielam 2=fiškalizujem 3=čakám na server
    payPhaseStartedAt: Long = 0L,
    onPay: (method: String, given: Double?) -> Unit,
    onDismiss: () -> Unit,
) {
    var method by remember(initialMethod) { mutableStateOf(initialMethod) }
    var given by remember { mutableStateOf("") }
    val givenVal = given.replace(',', '.').toDoubleOrNull() ?: 0.0
    val change = givenVal - total
    // Hotovosť s vyplneným „Dostal som" pod sumou (CHÝBA) → Zaplatiť disabled.
    // Prázdne pole = platí presne, povolené.
    val shortfall = method == "hotovost" && given.isNotEmpty() && givenVal < total - 0.005

    AlertDialog(
        properties = DialogProperties(usePlatformDefaultWidth = false),
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text("Platba") },
        text = {
            Column(Modifier.widthIn(min = 320.dp, max = 460.dp).verticalScroll(rememberScrollState())) {
                // Hero „K ÚHRADE" — rovnaký money-anchor jazyk ako CELKOM karta
                Surface(shape = RoundedCornerShape(Radius.md), color = Terra.copy(alpha = 0.08f),
                    border = BorderStroke(1.dp, Terra.copy(alpha = 0.26f)),
                    modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) {
                        Text("K ÚHRADE", style = MaterialTheme.typography.labelSmall,
                            color = EspressoSoft)
                        Text(money(total), style = MaterialTheme.typography.headlineSmall, color = Terra)
                    }
                }
                // Receipt preview — čašník vidí PRESNE čo pôjde na bon, chytí
                // chybu (zlú položku / qty) PRED Portos roundtripom (web parita).
                if (items.isNotEmpty()) {
                    Spacer(Modifier.height(10.dp))
                    ReceiptPreview(items, tableName, staffName, subtotal, discount, total, method)
                }
                Spacer(Modifier.height(12.dp))
                // Method toggle
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                    MethodBtn("Hotovosť", method == "hotovost", Modifier.weight(1f)) { method = "hotovost" }
                    MethodBtn("Karta", method == "karta", Modifier.weight(1f)) { method = "karta" }
                }
                if (method == "hotovost") {
                    Spacer(Modifier.height(12.dp))
                    Text("Dostal som", style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                    OutlinedTextField(
                        value = given, onValueChange = { given = it.filter { c -> c.isDigit() || c == ',' || c == '.' } },
                        modifier = Modifier.fillMaxWidth(), singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                        suffix = { Text("€") },
                        shape = RoundedCornerShape(Radius.md),
                    )
                    Spacer(Modifier.height(8.dp))
                    // Quick presets — Presne + najbližšie 5/10/20/50/100 € (web parita)
                    val presets = cashPresets(total)
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        presets.forEach { p ->
                            OutlinedButton(onClick = { given = String.format("%.2f", p).replace('.', ',') },
                                contentPadding = PaddingValues(horizontal = 6.dp, vertical = 4.dp),
                                modifier = Modifier.weight(1f).height(44.dp)) {
                                Text(if (p == total) "Presne" else "${p.toInt()}", maxLines = 1,
                                    fontSize = 13.sp)   // token-exempt: velkost mimo skaly
                            }
                        }
                    }
                    Spacer(Modifier.height(10.dp))
                    if (givenVal > 0) {
                        // Výdavok/CHÝBA — animovaná suma + crossfade sage↔rust
                        val ok = change >= 0
                        val ink by animateColorAsState(if (ok) Sage else Danger, colorSpecOrSnap(), label = "chg")
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(if (ok) "Vydať: " else "CHÝBA: ",
                                style = MaterialTheme.typography.titleMedium, color = ink)
                            AnimatedMoney(if (ok) change else -change,
                                MaterialTheme.typography.titleMedium, ink)
                        }
                    }
                }
                fiscalNote?.let {
                    Spacer(Modifier.height(8.dp))
                    Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                error?.let {
                    Spacer(Modifier.height(8.dp))
                    Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                }
                if (payPhase != null) {
                    Spacer(Modifier.height(12.dp))
                    PayProgressTracker(payPhase, payPhaseStartedAt)
                } else if (busy) {
                    Spacer(Modifier.height(12.dp)); CircularProgressIndicator(Modifier.size(24.dp))
                }
                // Nejasný stav po vyčerpaní pollingu — re-poll cez ten istý onPay
                // je bezpečný: idempotency kľúč sa nemení, server replayne
                // výsledok, nikdy nevznikne druhá platba.
                if (!busy && fiscalNote?.contains("overenie") == true) {
                    Spacer(Modifier.height(10.dp))
                    OutlinedButton(
                        onClick = { onPay(method, if (method == "hotovost" && givenVal > 0) givenVal else null) },
                        modifier = Modifier.fillMaxWidth().height(44.dp),
                    ) { Text("Skontrolovať znova") }
                }
            }
        },
        confirmButton = {
            Button(
                onClick = { onPay(method, if (method == "hotovost" && givenVal > 0) givenVal else null) },
                enabled = !busy && !shortfall,
                colors = ButtonDefaults.buttonColors(containerColor = Terra, contentColor = Cream),
                modifier = Modifier.height(48.dp).glow(!busy && !shortfall),
            ) { Text("Zaplatiť ${money(total)}") }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text("Zrušiť") } },
    )
}

/**
 * Fázový tracker platby — namiesto anonymného spinnera cashier VIDÍ, kde
 * platba je a koľko to trvá. Od fázy 2 (Portos) trvalé varovanie: ukončenie
 * appky počas fiškalizácie = riziko dvojitého dokladu pri slepom opakovaní.
 */
@Composable
private fun PayProgressTracker(phase: Int, startedAt: Long) {
    var elapsed by remember { mutableStateOf(0L) }
    LaunchedEffect(phase, startedAt) {
        while (true) {
            elapsed = (System.currentTimeMillis() - startedAt) / 1000
            kotlinx.coroutines.delay(1_000)
        }
    }
    val steps = listOf("Odosielam objednávku…", "Fiškalizujem (Portos)…", "Čakám na odpoveď servera…")
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        steps.forEachIndexed { i, label ->
            val stepNo = i + 1
            Row(verticalAlignment = Alignment.CenterVertically) {
                when {
                    stepNo < phase -> Icon(Icons.Filled.Check, null, Modifier.size(IconSize.md), tint = Sage)
                    stepNo == phase -> CircularProgressIndicator(Modifier.size(IconSize.md), strokeWidth = 2.dp, color = Terra)
                    else -> Surface(shape = CircleShape, color = MaterialTheme.colorScheme.surfaceVariant,
                        modifier = Modifier.size(IconSize.sm)) {}
                }
                Spacer(Modifier.width(8.dp))
                Text(label, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium,
                    color = if (stepNo <= phase) MaterialTheme.colorScheme.onSurface
                        else MaterialTheme.colorScheme.onSurfaceVariant)
                if (stepNo == phase) Text("${elapsed} s", style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (phase >= 2) {
            Surface(shape = RoundedCornerShape(Radius.sm), color = Amber.copy(alpha = 0.12f),
                border = BorderStroke(1.dp, Amber.copy(alpha = 0.4f))) {
                Text("Neukončuj aplikáciu — platba prebieha. Pri slepom opakovaní hrozí dvojitý doklad.",
                    Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
                    style = MaterialTheme.typography.labelMedium, color = Amber)
            }
        }
    }
}

/** Thermal-receipt-styled náhľad — stôl + čas + obsluha + položky + SPOLU. */
@Composable
private fun ReceiptPreview(
    items: List<PrintItem>,
    tableName: String,
    staffName: String,
    subtotal: Double,
    discount: Double,
    total: Double,
    method: String,
) {
    val now = remember { java.time.ZonedDateTime.now(java.time.ZoneId.of("Europe/Bratislava")) }
    val timeStr = remember(now) {
        now.format(java.time.format.DateTimeFormatter.ofPattern("dd.MM.yyyy · HH:mm"))
    }
    Surface(shape = RoundedCornerShape(Radius.sm), color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, BorderMid)) {
        Column(Modifier.fillMaxWidth().padding(10.dp)) {
            Row { Text(tableName, Modifier.weight(1f), style = MaterialTheme.typography.labelMedium)
                Text(timeStr, style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant) }
            if (staffName.isNotBlank()) {
                Row { Text("Obsluha", Modifier.weight(1f), style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(staffName, style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
            HorizontalDivider(Modifier.padding(vertical = 6.dp))
            Column(Modifier.heightIn(max = 180.dp).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(3.dp)) {
                items.forEach { it2 ->
                    Row {
                        Column(Modifier.weight(1f)) {
                            Text(it2.name, style = MaterialTheme.typography.bodySmall, maxLines = 1,
                                overflow = TextOverflow.Ellipsis)
                            Text(if (it2.qty > 1) "${it2.qty}× ${money(it2.price)}" else money(it2.price),
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                            if (it2.note.isNotBlank())
                                Text("+ ${it2.note}", style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        Text(money(it2.price * it2.qty), style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
            if (discount > 0.005) {
                HorizontalDivider(Modifier.padding(vertical = 6.dp))
                Row { Text("Medzisúčet", Modifier.weight(1f), style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(money(subtotal), style = MaterialTheme.typography.labelSmall) }
                Row { Text("Zľava", Modifier.weight(1f), style = MaterialTheme.typography.labelSmall, color = Sage)
                    Text("−${money(discount)}", style = MaterialTheme.typography.labelSmall, color = Sage) }
            }
            HorizontalDivider(Modifier.padding(vertical = 6.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("SPOLU", Modifier.weight(1f), style = MaterialTheme.typography.labelLarge)
                Text(money(total), style = MaterialTheme.typography.titleMedium, color = Terra)
            }
            val cnt = items.size
            Text("${if (method == "karta") "Karta" else "Hotovosť"} · $cnt ${if (cnt == 1) "položka" else if (cnt < 5) "položky" else "položiek"}",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

private fun cashPresets(total: Double): List<Double> {
    val presets = mutableListOf(total)
    for (denom in listOf(5.0, 10.0, 20.0, 50.0, 100.0)) {
        val v = Math.ceil(total / denom) * denom
        if (v > total && presets.none { Math.abs(it - v) < 0.005 }) presets.add(v)
    }
    return presets.take(5)
}

@Composable
private fun MethodBtn(label: String, active: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val fill by animateColorAsState(if (active) Terra else MaterialTheme.colorScheme.surface,
        colorSpecOrSnap(), label = "method")
    val edge by animateColorAsState(if (active) Terra else BorderSoft, colorSpecOrSnap(), label = "methodE")
    Surface(
        onClick = onClick, interactionSource = interaction,
        modifier = modifier.height(52.dp).pressScale(interaction),
        shape = RoundedCornerShape(Radius.sm),
        color = fill, border = BorderStroke(1.dp, edge),
    ) {
        Box(contentAlignment = Alignment.Center) {
            Text(label, color = if (active) Cream else MaterialTheme.colorScheme.onSurface,
                fontWeight = FontWeight.Bold, style = MaterialTheme.typography.labelLarge)
        }
    }
}

/* ============================ Close shift (Z-report) ============================ */

@Composable
fun CloseShiftDialog(
    summary: ShiftSummaryDto?,
    busy: Boolean,
    error: String?,
    onClose: (Double) -> Unit,
    onJustLogout: () -> Unit,
    onDismiss: () -> Unit,
) {
    val expected = summary?.expectedCash ?: 0.0
    var actual by remember(summary) { mutableStateOf(if (expected > 0) String.format("%.2f", expected).replace('.', ',') else "") }
    val actualVal = actual.replace(',', '.').toDoubleOrNull() ?: 0.0
    val diff = actualVal - expected

    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text("Uzávierka zmeny") },
        text = {
            Column {
                if (summary == null) {
                    Text("Načítavam súhrn zmeny…"); CircularProgressIndicator(Modifier.size(22.dp).padding(top = 8.dp))
                } else {
                    SumRow("Počiatočná hotovosť", money(summary.openingCash))
                    SumRow("Tržby v hotovosti", money(summary.cashPayments))
                    SumRow("Očakávané v kase", money(expected), bold = true)
                    Spacer(Modifier.height(10.dp))
                    Text("Spočítaná hotovosť", style = MaterialTheme.typography.labelMedium)
                    OutlinedTextField(
                        value = actual, onValueChange = { actual = it.filter { c -> c.isDigit() || c == ',' || c == '.' } },
                        modifier = Modifier.fillMaxWidth(), singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), suffix = { Text("€") },
                        shape = RoundedCornerShape(Radius.md),
                    )
                    Spacer(Modifier.height(8.dp))
                    // Diff — crossfade sage↔rust + animovaná suma
                    val isShort = diff < -0.001
                    val diffInk by animateColorAsState(if (isShort) Danger else Sage,
                        colorSpecOrSnap(), label = "diff")
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(when {
                            diff > 0.001 -> "Prebytok: "
                            isShort -> "Manko: "
                            else -> "Sedí"
                        }, color = diffInk, fontWeight = FontWeight.Bold)
                        if (diff > 0.001 || isShort)
                            AnimatedMoney(kotlin.math.abs(diff),
                                MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Bold), diffInk)
                    }
                }
                error?.let {
                    Spacer(Modifier.height(8.dp))
                    Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                }
            }
        },
        confirmButton = {
            Button(onClick = { onClose(actualVal) }, enabled = !busy && summary != null,
                colors = ButtonDefaults.buttonColors(containerColor = Terra, contentColor = Cream)) {
                if (busy) CircularProgressIndicator(Modifier.size(18.dp), color = Cream, strokeWidth = 2.dp)
                else Text("Uzavrieť a odhlásiť")
            }
        },
        dismissButton = {
            Row {
                TextButton(onClick = onJustLogout, enabled = !busy) { Text("Len odhlásiť") }
                TextButton(onClick = onDismiss, enabled = !busy) { Text("Späť") }
            }
        },
    )
}

@Composable
private fun SumRow(label: String, value: String, bold: Boolean = false) {
    Row(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
        Text(label, Modifier.weight(1f), color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, fontWeight = if (bold) FontWeight.Bold else FontWeight.Normal,
            color = if (bold) Terra else MaterialTheme.colorScheme.onSurface)
    }
}

/**
 * Súhrn zmeny sa nepodarilo načítať (transport/5xx) — odhlásenie bez
 * uzávierky musí byť vedomá voľba, nie tichý logout (inak chýba closingCash
 * a zajtrajšia expectedCash nesedí). Zdieľané Order/Floor screenom.
 */
@Composable
fun CloseSummaryFailedDialog(onRetry: () -> Unit, onLogout: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Uzávierka zmeny") },
        text = { Text("Uzávierku sa nepodarilo načítať. Skontroluj pripojenie k serveru a skús znova, alebo sa odhlás bez uzávierky.") },
        confirmButton = {
            Button(onClick = onRetry,
                colors = ButtonDefaults.buttonColors(containerColor = Terra, contentColor = Cream)) {
                Text("Skúsiť znova")
            }
        },
        dismissButton = {
            TextButton(onClick = onLogout) {
                Text("Odhlásiť bez uzávierky")
            }
        },
    )
}

/**
 * Klasifikácia zlyhania GET shift-summary pri štarte uzávierky:
 * 404 = žiadna otvorená zmena, 401 = expirovaný token → rovno odhlásiť;
 * transport/5xx — zmena MOŽNO existuje, preskočenie uzávierky musí byť
 * vedomá voľba (onFailed → CloseSummaryFailedDialog).
 */
fun classifyShiftSummaryFailure(e: Exception, onLogout: () -> Unit, onFailed: () -> Unit) {
    when (e.httpCode()) {
        404, 401 -> onLogout()
        else -> onFailed()
    }
}
