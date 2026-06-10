package sk.surfspirit.pos.ui.admin

import androidx.activity.compose.BackHandler
import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import sk.surfspirit.pos.ui.theme.*

/**
 * Natívny Admin shell — ľavý rail (sekcie ako web admin sidebar) + obsah.
 * Natívne obrazovky per stránka; stránky mimo v1 natívneho pokrytia bežia
 * vo WebView fallbacku s deep-linkom na hash route admin SPA.
 */
enum class AdminPage(
    val title: String,
    val icon: String,
    val hash: String,
    val section: String,
) {
    DASHBOARD("Dashboard", "📊", "dashboard", "PREHĽAD"),
    REPORTY("Reporty", "📈", "reports", "PREHĽAD"),
    HISTORIA("História", "🧾", "payments", "PREHĽAD"),
    CASHFLOW("Cashflow", "💶", "cashflow", "PREHĽAD"),

    MENU("Menu", "🍔", "menu", "PREDAJ"),
    RECEPTY("Receptúry", "📖", "recipes", "PREDAJ"),
    STOLY("Stoly", "🪑", "tables", "PREDAJ"),

    LUDIA("Zamestnanci", "👥", "staff", "ĽUDIA"),
    DOCHADZKA("Dochádzka", "🕐", "dochadzka", "ĽUDIA"),
    ZAM_SPOTREBA("Zam. spotreba", "🍽️", "zam-spotreba", "ĽUDIA"),
    STORNO("Storno kôš", "↩️", "storno", "ĽUDIA"),

    SKLAD_PREHLAD("Prehľad skladu", "📦", "inventory-dashboard", "SKLAD"),
    MATERIALY("Materiály", "🥕", "ingredients", "SKLAD"),
    POHYBY("Pohyby", "🔄", "stock-movements", "SKLAD"),
    OBJEDNAVKY("Objednávky", "🛒", "purchase-orders", "SKLAD"),
    MAJETOK("Majetok", "🏷️", "assets", "SKLAD"),
    SHISHA("Shisha", "💨", "shisha", "SKLAD"),

    NASTAVENIA("Nastavenia", "⚙️", "settings", "SYSTÉM"),
}

/** Saver pre AdminPage — ukladá názov enum-u, bezpečný fallback na DASHBOARD
 *  (keby konštanta medzi verziami zmizla). */
private val AdminPageSaver = Saver<AdminPage, String>(
    save = { it.name },
    restore = { name -> AdminPage.entries.firstOrNull { it.name == name } ?: AdminPage.DASHBOARD },
)

@Composable
fun AdminShell(onBackToPos: () -> Unit, onOpenFloorEdit: () -> Unit) {
    // rememberSaveable: zvolená stránka prežije config change / process death.
    var page by rememberSaveable(stateSaver = AdminPageSaver) { mutableStateOf(AdminPage.DASHBOARD) }

    BackHandler(enabled = true) { onBackToPos() }

    // Po odchode z adminu invaliduj menu cache — mohlo sa editovať
    DisposableEffect(Unit) {
        onDispose { sk.surfspirit.pos.core.Mem.categoriesAt = 0 }
    }

    // ── Telefón: horný bar s dropdown navigáciou (rail sa nezmestí) ──
    if (isPhone()) {
        var navOpen by remember { mutableStateOf(false) }
        Column(Modifier.fillMaxSize().background(Cream)) {
            Surface(color = CreamElev, modifier = Modifier.paperShadow(2.dp, RectangleShape)) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    Box {
                        TextButton(onClick = { navOpen = true }) {
                            Text("☰  ${page.icon} ${page.title}",
                                style = MaterialTheme.typography.titleSmall, color = Terra)
                        }
                        DropdownMenu(expanded = navOpen, onDismissRequest = { navOpen = false }) {
                            var lastSection = ""
                            AdminPage.entries.forEach { p ->
                                if (p.section != lastSection) {
                                    lastSection = p.section
                                    Text(p.section, Modifier.padding(start = 14.dp, top = 8.dp, bottom = 2.dp),
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                                DropdownMenuItem(
                                    text = { Text("${p.icon} ${p.title}",
                                        color = if (p == page) Terra else MaterialTheme.colorScheme.onSurface) },
                                    onClick = { page = p; navOpen = false },
                                )
                            }
                        }
                    }
                    Spacer(Modifier.weight(1f))
                    TextButton(onClick = onBackToPos) { Text("← Kasa", color = Terra) }
                }
            }
            Box(Modifier.weight(1f)) {
                AdminContent(page, onOpenFloorEdit, onBackToPos)
            }
        }
        return
    }

    Row(Modifier.fillMaxSize().background(Cream)) {
        // ── Rail ──
        Surface(
            Modifier.width(200.dp).fillMaxHeight().paperShadow(2.dp, RectangleShape),
            color = CreamElev,
        ) {
            Column(Modifier.fillMaxHeight()) {
                // Brand hlavička railu
                Row(Modifier.padding(horizontal = 14.dp, vertical = 14.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    Text("⚙️", fontSize = 18.sp)
                    Spacer(Modifier.width(8.dp))
                    Text("Admin", style = MaterialTheme.typography.titleMedium)
                }
                HorizontalDivider(color = BorderSoft)
                Column(Modifier.weight(1f).verticalScroll(rememberScrollState())
                    .padding(horizontal = 8.dp, vertical = 6.dp)) {
                    var lastSection = ""
                    AdminPage.entries.forEach { p ->
                        if (p.section != lastSection) {
                            lastSection = p.section
                            Text(p.section, Modifier.padding(start = 8.dp, top = 12.dp, bottom = 4.dp),
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        RailItem(p, p == page) { page = p }
                    }
                }
                HorizontalDivider(color = BorderSoft)
                // ← Kasa
                Surface(onClick = onBackToPos, color = Color.Transparent,
                    modifier = Modifier.fillMaxWidth()) {
                    Row(Modifier.padding(horizontal = 16.dp, vertical = 14.dp),
                        verticalAlignment = Alignment.CenterVertically) {
                        Text("←", color = Terra, fontWeight = FontWeight.Bold)
                        Spacer(Modifier.width(8.dp))
                        Text("Späť na kasu", style = MaterialTheme.typography.labelLarge, color = Terra)
                    }
                }
            }
        }

        // ── Obsah ──
        Box(Modifier.weight(1f).fillMaxHeight()) {
            AdminContent(page, onOpenFloorEdit, onBackToPos)
        }
    }
}

@Composable
private fun RailItem(p: AdminPage, active: Boolean, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val fill by animateColorAsState(if (active) Terra.copy(alpha = 0.10f) else Color.Transparent,
        Motion.colorSpec, label = "rail")
    val ink by animateColorAsState(if (active) Terra else MaterialTheme.colorScheme.onSurface,
        Motion.colorSpec, label = "railInk")
    Surface(onClick = onClick, interactionSource = interaction, shape = RoundedCornerShape(12.dp),
        color = fill, modifier = Modifier.fillMaxWidth().pressScale(interaction)) {
        Row(Modifier.height(IntrinsicSize.Min), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.width(3.dp).fillMaxHeight()
                .background(if (active) Terra else Color.Transparent))
            Spacer(Modifier.width(8.dp))
            Text(p.icon, fontSize = 15.sp, modifier = Modifier.width(22.dp))
            Spacer(Modifier.width(4.dp))
            Text(p.title, color = ink,
                fontWeight = if (active) FontWeight.ExtraBold else FontWeight.SemiBold,
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(vertical = 11.dp).weight(1f))
        }
    }
}
