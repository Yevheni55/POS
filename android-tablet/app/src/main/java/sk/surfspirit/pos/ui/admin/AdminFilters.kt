package sk.surfspirit.pos.ui.admin

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import sk.surfspirit.pos.ui.theme.BorderSoft
import sk.surfspirit.pos.ui.theme.Cream
import sk.surfspirit.pos.ui.theme.IconSize
import sk.surfspirit.pos.ui.theme.Radius
import sk.surfspirit.pos.ui.theme.Terra
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit

/* =====================================================================
   v3.3 Admin zjednotenie — filter lexikón (plán bod 16-17):
   · 2–4 voľby  = PillTabs
   · 5+ volieb  = FilterDropdown (ExposedDropdownMenuBox)
   · rozsah dát = DateRangeNav (‹ › + tap na label = DatePicker + presety)
   · fulltext   = SearchField (lupa + clear)
   ===================================================================== */

/**
 * Rozsahová navigácia dátumov — ‹ › posúva o dĺžku rozsahu, tap na label
 * otvorí M3 DatePicker (od → do), preset chips Dnes · Včera · 7 dní · Mesiac.
 * Nahrádza raw text inputy v admin stránkach. ISO "yyyy-MM-dd" (API formát).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DateRangeNav(
    fromIso: String,
    toIso: String,
    onRange: (String, String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val from = remember(fromIso) { runCatching { LocalDate.parse(fromIso) }.getOrNull() }
    val to = remember(toIso) { runCatching { LocalDate.parse(toIso) }.getOrNull() }
    var pickerFor by remember { mutableStateOf<Int?>(null) }   // 0=od, 1=do
    val today = LocalDate.now(ZoneId.of("Europe/Bratislava"))
    val fmt = remember { DateTimeFormatter.ofPattern("d.M.yyyy") }
    val spanDays = if (from != null && to != null)
        ChronoUnit.DAYS.between(from, to).coerceAtLeast(0) + 1 else 1L
    // Celý kalendárny mesiac (1. deň → koniec mesiaca, príp. → dnes pri preset
    // „Mesiac") sa posúva po mesiacoch — posun o spanDays by z mája spravil 2.5.–1.6.
    // Guard to != from: 1. deň mesiaca s presetom „Dnes" ostáva denný krok.
    val fullMonth = from != null && to != null &&
        from.dayOfMonth == 1 && from.year == to.year && from.month == to.month &&
        (to.dayOfMonth == to.lengthOfMonth() || (to == today && to != from))

    Column(modifier) {
        Row(verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            OutlinedButton(onClick = {
                if (from != null && to != null) {
                    if (fullMonth)
                        onRange(from.minusMonths(1).toString(), from.minusDays(1).toString())
                    else
                        onRange(from.minusDays(spanDays).toString(), to.minusDays(spanDays).toString())
                }
            }, contentPadding = PaddingValues(horizontal = 10.dp)) {
                Icon(Icons.AutoMirrored.Filled.KeyboardArrowLeft, "Predchádzajúce obdobie", Modifier.size(IconSize.lg))
            }
            TextButton(onClick = { pickerFor = 0 }) {
                Text(
                    when {
                        from != null && to != null && from == to -> from.format(fmt)
                        from != null && to != null -> from.format(fmt) + " – " + to.format(fmt)
                        else -> "$fromIso – $toIso"
                    },
                    style = MaterialTheme.typography.titleSmall,
                    color = MaterialTheme.colorScheme.onSurface,
                )
            }
            OutlinedButton(onClick = {
                if (from != null && to != null) {
                    if (fullMonth) {
                        val nf = from.plusMonths(1)
                        val eom = nf.withDayOfMonth(nf.lengthOfMonth())
                        // V aktuálnom mesiaci koniec = dnes (parita s preset „Mesiac").
                        val nt = if (nf.year == today.year && nf.month == today.month &&
                            today.isBefore(eom)) today else eom
                        onRange(nf.toString(), nt.toString())
                    } else {
                        onRange(from.plusDays(spanDays).toString(), to.plusDays(spanDays).toString())
                    }
                }
            }, contentPadding = PaddingValues(horizontal = 10.dp)) {
                Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, "Nasledujúce obdobie", Modifier.size(IconSize.lg))
            }
        }
        Spacer(Modifier.height(6.dp))
        Row(Modifier.horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            DrPreset("Dnes", today, today, from, to, onRange)
            DrPreset("Včera", today.minusDays(1), today.minusDays(1), from, to, onRange)
            DrPreset("7 dní", today.minusDays(6), today, from, to, onRange)
            DrPreset("Mesiac", today.withDayOfMonth(1), today, from, to, onRange)
        }
    }

    pickerFor?.let { which ->
        val initial = (if (which == 0) from else to) ?: today
        val state = rememberDatePickerState(
            initialSelectedDateMillis = initial.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli())
        DatePickerDialog(
            onDismissRequest = { pickerFor = null },
            confirmButton = {
                TextButton(onClick = {
                    val ms = state.selectedDateMillis
                    if (ms == null) { pickerFor = null; return@TextButton }
                    val d = Instant.ofEpochMilli(ms).atZone(ZoneOffset.UTC).toLocalDate()
                    if (which == 0) {
                        val newTo = if (to == null || d.isAfter(to)) d else to
                        onRange(d.toString(), newTo.toString())
                        pickerFor = 1   // plynulý výber rozsahu — hneď aj koniec
                    } else {
                        val newFrom = if (from == null || d.isBefore(from)) d else from
                        onRange(newFrom.toString(), d.toString())
                        pickerFor = null
                    }
                }) { Text(if (which == 0) "Od → do…" else "Uložiť") }
            },
            dismissButton = { TextButton(onClick = { pickerFor = null }) { Text("Zrušiť") } },
        ) {
            DatePicker(state = state, title = {
                Text(if (which == 0) "Začiatok obdobia" else "Koniec obdobia",
                    Modifier.padding(start = 24.dp, top = 16.dp))
            })
        }
    }
}

@Composable
private fun DrPreset(
    label: String,
    f: LocalDate,
    t: LocalDate,
    from: LocalDate?,
    to: LocalDate?,
    onRange: (String, String) -> Unit,
) {
    val active = from == f && to == t
    Surface(onClick = { onRange(f.toString(), t.toString()) },
        shape = RoundedCornerShape(Radius.full),
        color = if (active) Terra else MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, if (active) Terra else BorderSoft)) {
        Text(label, Modifier.padding(horizontal = 12.dp, vertical = 7.dp),
            color = if (active) Cream else MaterialTheme.colorScheme.onSurface,
            style = MaterialTheme.typography.labelMedium)
    }
}

/** Dropdown filter pre 5+ volieb (filter lexikón) — ExposedDropdownMenuBox. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FilterDropdown(
    label: String,
    options: List<String>,
    selected: Int,
    onSelect: (Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    var open by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded = open, onExpandedChange = { open = it }, modifier = modifier) {
        OutlinedTextField(
            value = options.getOrNull(selected) ?: "",
            onValueChange = {},
            readOnly = true,
            label = { Text(label) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = open) },
            modifier = Modifier.menuAnchor().fillMaxWidth(),
            singleLine = true,
        )
        ExposedDropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            options.forEachIndexed { i, opt ->
                DropdownMenuItem(
                    text = { Text(opt, color = if (i == selected) Terra else MaterialTheme.colorScheme.onSurface) },
                    onClick = { onSelect(i); open = false },
                )
            }
        }
    }
}

/** Fulltext filter — lupa + clear (filter lexikón). */
@Composable
fun SearchField(
    value: String,
    onChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    placeholder: String = "Hľadať…",
) {
    OutlinedTextField(
        value = value, onValueChange = onChange,
        placeholder = { Text(placeholder) },
        leadingIcon = { Icon(Icons.Filled.Search, null,
            Modifier.size(IconSize.md), tint = MaterialTheme.colorScheme.outline) },
        trailingIcon = if (value.isNotEmpty()) {
            {
                IconButton(onClick = { onChange("") }) {
                    Icon(Icons.Filled.Close, "Vymazať hľadanie", Modifier.size(IconSize.md))
                }
            }
        } else null,
        singleLine = true,
        shape = RoundedCornerShape(Radius.full),
        modifier = modifier.fillMaxWidth(),
    )
}

/**
 * MoneyField — FormField preset pre eurové sumy: Decimal klávesnica,
 * € suffix, povolená čiarka aj bodka (rovnaký filter ako PayDialog).
 */
@Composable
fun MoneyField(
    label: String,
    value: String,
    onChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    placeholder: String = "0,00",
    error: String? = null,
) {
    FormField(
        label = label,
        value = value,
        onChange = { raw -> onChange(raw.filter { ch -> ch.isDigit() || ch == ',' || ch == '.' }) },
        modifier = modifier,
        placeholder = placeholder,
        keyboard = KeyboardOptions(keyboardType = KeyboardType.Decimal),
        suffix = "€",
        error = error,
    )
}
