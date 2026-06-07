package sk.surfspirit.pos.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Backspace
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
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

/* ============================ PIN pad (zdieľaný) ============================ */

@Composable
fun PinDots(len: Int, max: Int = 6) {
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        repeat(max) { i ->
            Surface(
                shape = CircleShape,
                color = if (i < len) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant,
                modifier = Modifier.size(14.dp),
            ) {}
        }
    }
}

@Composable
fun NumPad(onDigit: (String) -> Unit, onBackspace: () -> Unit, onOk: () -> Unit, okEnabled: Boolean, keySize: Int = 64) {
    val keys = listOf("1","2","3","4","5","6","7","8","9")
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        for (r in 0..2) {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                for (c in 0..2) PadKey(keys[r * 3 + c], keySize) { onDigit(keys[r * 3 + c]) }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            PadKeyIcon(keySize, onBackspace)
            PadKey("0", keySize) { onDigit("0") }
            PadKeyOk(keySize, okEnabled, onOk)
        }
    }
}

@Composable
private fun PadKey(label: String, size: Int, onClick: () -> Unit) {
    Surface(onClick = onClick, shape = RoundedCornerShape(14.dp), color = MaterialTheme.colorScheme.surface,
        tonalElevation = 1.dp, modifier = Modifier.size(size.dp)) {
        Box(contentAlignment = Alignment.Center) { Text(label, fontSize = (size * 0.32f).sp, style = MaterialTheme.typography.titleLarge) }
    }
}

@Composable
private fun PadKeyIcon(size: Int, onClick: () -> Unit) {
    Surface(onClick = onClick, shape = RoundedCornerShape(14.dp), color = MaterialTheme.colorScheme.surfaceVariant,
        modifier = Modifier.size(size.dp)) {
        Box(contentAlignment = Alignment.Center) {
            androidx.compose.material3.Icon(Icons.AutoMirrored.Filled.Backspace, "Vymazať", Modifier.size((size * 0.34f).dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun PadKeyOk(size: Int, enabled: Boolean, onClick: () -> Unit) {
    Surface(onClick = { if (enabled) onClick() }, shape = RoundedCornerShape(14.dp),
        color = if (enabled) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant,
        modifier = Modifier.size(size.dp)) {
        Box(contentAlignment = Alignment.Center) {
            Text("OK", fontSize = (size * 0.26f).sp,
                color = if (enabled) Cream else MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.labelLarge)
        }
    }
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
                if (resp.ok) onVerified() else { error = "Neoprávnený prístup."; pin = "" }
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
                NumPad(
                    onDigit = { if (pin.length < 6) pin += it },
                    onBackspace = { if (pin.isNotEmpty()) pin = pin.dropLast(1) },
                    onOk = { submit() },
                    okEnabled = pin.length >= 4 && !busy,
                    keySize = 58,
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
 * Cashier musí explicitne vybrať DVE veci (žiadne auto-defaulty):
 * 1. Bolo už pripravené? Áno (odpis) / Nie (vrátiť na sklad)
 * 2. Dôvod (5 možností) + voliteľná poznámka.
 * „Potvrdiť" je disabled kým nie sú obe zvolené. Zhoda s web showStornoReason.
 */
@Composable
fun StornoReasonDialog(
    itemName: String,
    qty: Int,
    onConfirm: (StornoReason) -> Unit,
    onDismiss: () -> Unit,
) {
    var wasPrepared by remember { mutableStateOf<Boolean?>(null) }
    var reason by remember { mutableStateOf<String?>(null) }
    var note by remember { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Column {
                Text("$qty× $itemName", style = MaterialTheme.typography.titleMedium)
                Text("STORNO", style = MaterialTheme.typography.labelSmall, color = Danger)
            }
        },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                Text("Bolo už pripravené?", style = MaterialTheme.typography.labelMedium)
                Spacer(Modifier.height(6.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    PrepBtn("🔥 Áno, pripravené", "jedlo / nápoj išlo von → odpis",
                        wasPrepared == true, Modifier.weight(1f)) { wasPrepared = true }
                    PrepBtn("🔄 Nie, nestihli sme", "vrátiť suroviny na sklad",
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
                                    shape = RoundedCornerShape(10.dp),
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
private fun PrepBtn(label: String, hint: String, active: Boolean, modifier: Modifier, onClick: () -> Unit) {
    Surface(
        onClick = onClick, shape = RoundedCornerShape(10.dp),
        color = if (active) Terra.copy(alpha = 0.12f) else MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, if (active) Terra else MaterialTheme.colorScheme.outline),
        modifier = modifier,
    ) {
        Column(Modifier.padding(10.dp)) {
            Text(label, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold,
                color = if (active) Terra else MaterialTheme.colorScheme.onSurface)
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

private val SAUCES = listOf("Big Mac domáca", "Chilli-mayo", "Tatárka domáca", "Kečup", "BBQ")

/**
 * Sauce picker pre combá — web parita: ak má objednávka rovnaké combo už
 * s omáčkou, hore je prominent „Opakovať omáčku" CTA (1 klik = rovnaká
 * voľba) + checkboxy sú pre-checknuté. onConfirm dostáva zoznam omáčok
 * (prázdny = bez omáčky); zrušenie = onDismiss.
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
        title = { Text("Omáčka — $productName") },
        text = {
            Column {
                if (previous != null) {
                    val prevLabel = if (previous.isEmpty()) "bez omáčky" else previous.joinToString(" + ")
                    Surface(
                        onClick = { onConfirm(previous) },
                        shape = RoundedCornerShape(10.dp),
                        color = Terra.copy(alpha = 0.10f),
                        border = BorderStroke(1.dp, Terra.copy(alpha = 0.4f)),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Column(Modifier.padding(12.dp)) {
                            Text("↻ Opakovať omáčku", style = MaterialTheme.typography.labelSmall, color = Terra)
                            Text(prevLabel, style = MaterialTheme.typography.bodyMedium,
                                fontWeight = FontWeight.Bold, color = Terra)
                        }
                    }
                    Spacer(Modifier.height(10.dp))
                }
                SAUCES.forEach { s ->
                    Row(verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.fillMaxWidth()) {
                        Checkbox(checked = sel.contains(s), onCheckedChange = {
                            if (it) sel.add(s) else sel.remove(s)
                        })
                        Text(s)
                    }
                }
            }
        },
        confirmButton = {
            Row {
                TextButton(onClick = { onConfirm(emptyList()) }) { Text("Bez omáčky") }
                Spacer(Modifier.width(4.dp))
                Button(onClick = { onConfirm(sel.toList()) },
                    colors = ButtonDefaults.buttonColors(containerColor = Terra, contentColor = Cream),
                ) { Text("Potvrdiť") }
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Zrušiť") } },
    )
}

/* ============================ Qty pickery ============================ */

/**
 * Long-press bulk add — mriežka 1..10, jeden gest = 5× Pivo (web qtyPopup).
 */
@Composable
fun QtyPopupDialog(itemName: String, onPick: (Int) -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(itemName, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Počet kusov", style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                (1..10).chunked(5).forEach { row ->
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        row.forEach { n ->
                            Surface(onClick = { onPick(n) }, shape = RoundedCornerShape(10.dp),
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
        },
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
                Text(code, style = MaterialTheme.typography.titleLarge.copy(fontSize = 44.sp, letterSpacing = 8.sp),
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
                        modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
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
                TabRow(selectedTabIndex = tab) {
                    Tab(selected = tab == 0, onClick = { tab = 0 }, text = { Text("Rovnomerne") })
                    Tab(selected = tab == 1, onClick = { tab = 1 }, text = { Text("Po položkách") })
                }
                Spacer(Modifier.height(12.dp))
                if (tab == 0) {
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
                                shape = RoundedCornerShape(8.dp),
                                color = if (isSel) Terra.copy(alpha = 0.10f) else MaterialTheme.colorScheme.surface,
                                border = BorderStroke(1.dp, if (isSel) Terra else MaterialTheme.colorScheme.outline),
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Row(verticalAlignment = Alignment.CenterVertically,
                                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp)) {
                                    Icon(if (isSel) Icons.Filled.Check else Icons.Filled.Close,
                                        null, Modifier.size(16.dp),
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
                    Surface(onClick = { onPick(o.id) }, shape = RoundedCornerShape(10.dp),
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
    onPay: (method: String, given: Double?) -> Unit,
    onDismiss: () -> Unit,
) {
    var method by remember(initialMethod) { mutableStateOf(initialMethod) }
    var given by remember { mutableStateOf("") }
    val givenVal = given.replace(',', '.').toDoubleOrNull() ?: 0.0
    val change = givenVal - total

    AlertDialog(
        properties = DialogProperties(usePlatformDefaultWidth = false),
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text("Platba") },
        text = {
            Column(Modifier.widthIn(min = 320.dp, max = 460.dp).verticalScroll(rememberScrollState())) {
                Text(money(total), style = MaterialTheme.typography.titleLarge, color = Terra,
                    fontWeight = FontWeight.ExtraBold)
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
                    )
                    Spacer(Modifier.height(8.dp))
                    // Quick presets — Presne + najbližšie 5/10/20/50/100 € (web parita)
                    val presets = cashPresets(total)
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        presets.forEach { p ->
                            OutlinedButton(onClick = { given = String.format("%.2f", p).replace('.', ',') },
                                contentPadding = PaddingValues(horizontal = 6.dp, vertical = 4.dp),
                                modifier = Modifier.weight(1f)) {
                                Text(if (p == total) "Presne" else "${p.toInt()}", maxLines = 1, fontSize = 13.sp)
                            }
                        }
                    }
                    Spacer(Modifier.height(10.dp))
                    if (givenVal > 0) {
                        if (change >= 0)
                            Text("Vydať: ${money(change)}", style = MaterialTheme.typography.titleMedium, color = Sage)
                        else
                            Text("CHÝBA: ${money(-change)}", style = MaterialTheme.typography.titleMedium, color = Danger)
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
                if (busy) { Spacer(Modifier.height(12.dp)); CircularProgressIndicator(Modifier.size(24.dp)) }
            }
        },
        confirmButton = {
            Button(
                onClick = { onPay(method, if (method == "hotovost" && givenVal > 0) givenVal else null) },
                enabled = !busy,
                colors = ButtonDefaults.buttonColors(containerColor = Terra, contentColor = Cream),
            ) { Text("Zaplatiť ${money(total)}") }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text("Zrušiť") } },
    )
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
    Surface(shape = RoundedCornerShape(8.dp), color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline)) {
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
    Surface(
        onClick = onClick, modifier = modifier.height(52.dp), shape = RoundedCornerShape(10.dp),
        color = if (active) Terra else MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, if (active) Terra else MaterialTheme.colorScheme.outline),
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
                    )
                    Spacer(Modifier.height(8.dp))
                    val (lbl, col) = when {
                        diff > 0.001 -> "Prebytok: ${money(diff)}" to Sage
                        diff < -0.001 -> "Manko: ${money(-diff)}" to Danger
                        else -> "Sedí" to Sage
                    }
                    Text(lbl, color = col, fontWeight = FontWeight.Bold)
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
