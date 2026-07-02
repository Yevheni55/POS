package sk.surfspirit.pos.ui.admin

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import sk.surfspirit.pos.ui.theme.BorderSoft
import sk.surfspirit.pos.ui.theme.CreamSunken
import sk.surfspirit.pos.ui.theme.Terra

/* =====================================================================
   Jednotné admin tabuľky (plán v3.x bod 18) — TableCol popisuje stĺpec
   (váha + numeric = end-align s tabular figures), PosTableHeader kreslí
   hlavičku (voliteľne sortovateľnú ▲▼), PosTableRow riadky so zebrou.
   Triedenie je KLIENTSKE nad načítanou stránkou (server sort neexistuje,
   stránky ťahajú ≤ stovky riadkov) — limitáciu priznaj v UI page-size
   poznámkou, nie tichým orezaním.
   ===================================================================== */

/** Definícia stĺpca: label + váha + numeric (end-align, tnum už je v typo). */
data class TableCol(
    val label: String,
    val weight: Float,
    val numeric: Boolean = false,
    /** Kľúč pre triedenie — null = stĺpec nesortovateľný. */
    val sortKey: String? = null,
)

/** Smer triedenia pre SortableHeader. */
data class TableSort(val key: String, val desc: Boolean = true)

/**
 * Hlavička tabuľky z TableCol definícií; tap na sortovateľný stĺpec
 * cykluje desc → asc → desc… (nový stĺpec začína desc).
 */
@Composable
fun PosTableHeader(
    cols: List<TableCol>,
    sort: TableSort? = null,
    onSort: ((TableSort) -> Unit)? = null,
) {
    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically) {
        cols.forEach { c ->
            val sortable = c.sortKey != null && onSort != null
            val active = sort?.key != null && sort.key == c.sortKey
            val arrow = when { !active -> ""; sort!!.desc -> " ▼"; else -> " ▲" }
            Text(
                c.label.uppercase() + arrow,
                Modifier.weight(c.weight).then(
                    if (sortable) Modifier.clickable {
                        onSort!!(if (active) TableSort(c.sortKey!!, !sort!!.desc) else TableSort(c.sortKey!!, true))
                    } else Modifier),
                style = MaterialTheme.typography.labelSmall,
                color = if (active) Terra else MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = if (c.numeric) TextAlign.End else TextAlign.Start,
                maxLines = 1,
            )
        }
    }
    HorizontalDivider(color = BorderSoft)
}

/**
 * Bunka riadku — text alebo vlastný composable (badge). Text bunky dedia
 * numeric zarovnanie zo stĺpca.
 */
data class TableCell(
    val text: String? = null,
    val color: Color? = null,
    val content: (@Composable () -> Unit)? = null,
)

/**
 * Riadok tabuľky so zebrou (párne riadky CreamSunken tint) + BorderSoft
 * dividerom; numeric stĺpce end-align (tabular figures z typografie).
 */
@Composable
fun PosTableRow(
    cols: List<TableCol>,
    cells: List<TableCell>,
    index: Int,
    onClick: (() -> Unit)? = null,
) {
    val zebra = index % 2 == 1
    Surface(
        color = if (zebra) CreamSunken.copy(alpha = 0.45f) else Color.Transparent,
        onClick = onClick ?: {},
        enabled = onClick != null,
    ) {
        Row(Modifier.fillMaxWidth().padding(vertical = 8.dp, horizontal = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            cols.forEachIndexed { i, c ->
                val cell = cells.getOrNull(i) ?: TableCell("")
                if (cell.content != null) {
                    Row(Modifier.weight(c.weight),
                        horizontalArrangement = if (c.numeric) Arrangement.End else Arrangement.Start) {
                        cell.content.invoke()
                    }
                } else {
                    Text(cell.text ?: "", Modifier.weight(c.weight),
                        style = MaterialTheme.typography.bodyMedium,
                        color = cell.color ?: MaterialTheme.colorScheme.onSurface,
                        textAlign = if (c.numeric) TextAlign.End else TextAlign.Start,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
    HorizontalDivider(color = BorderSoft.copy(alpha = 0.5f))
}
