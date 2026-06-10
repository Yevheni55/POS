package sk.surfspirit.pos.ui.admin

import androidx.activity.compose.BackHandler
import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.MenuBook
import androidx.compose.material.icons.automirrored.outlined.ReceiptLong
import androidx.compose.material.icons.automirrored.outlined.TrendingUp
import androidx.compose.material.icons.automirrored.outlined.Undo
import androidx.compose.material.icons.outlined.AdminPanelSettings
import androidx.compose.material.icons.outlined.Air
import androidx.compose.material.icons.outlined.Grain
import androidx.compose.material.icons.outlined.Group
import androidx.compose.material.icons.outlined.Inventory2
import androidx.compose.material.icons.outlined.Payments
import androidx.compose.material.icons.outlined.Restaurant
import androidx.compose.material.icons.outlined.RestaurantMenu
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.Sell
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.ShoppingCart
import androidx.compose.material.icons.outlined.SpaceDashboard
import androidx.compose.material.icons.outlined.SwapHoriz
import androidx.compose.material.icons.outlined.TableRestaurant
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import sk.surfspirit.pos.ui.theme.*

/**
 * Natívny Admin shell — ľavý rail (sekcie ako web admin sidebar) + obsah.
 * Natívne obrazovky per stránka; stránky mimo v1 natívneho pokrytia bežia
 * vo WebView fallbacku s deep-linkom na hash route admin SPA.
 */
enum class AdminPage(
    val title: String,
    val icon: ImageVector,
    val hash: String,
    val section: String,
) {
    DASHBOARD("Dashboard", Icons.Outlined.SpaceDashboard, "dashboard", "PREHĽAD"),
    REPORTY("Reporty", Icons.AutoMirrored.Outlined.TrendingUp, "reports", "PREHĽAD"),
    HISTORIA("História", Icons.AutoMirrored.Outlined.ReceiptLong, "payments", "PREHĽAD"),
    CASHFLOW("Cashflow", Icons.Outlined.Payments, "cashflow", "PREHĽAD"),

    MENU("Menu", Icons.Outlined.RestaurantMenu, "menu", "PREDAJ"),
    RECEPTY("Receptúry", Icons.AutoMirrored.Outlined.MenuBook, "recipes", "PREDAJ"),
    STOLY("Stoly", Icons.Outlined.TableRestaurant, "tables", "PREDAJ"),

    LUDIA("Zamestnanci", Icons.Outlined.Group, "staff", "ĽUDIA"),
    DOCHADZKA("Dochádzka", Icons.Outlined.Schedule, "dochadzka", "ĽUDIA"),
    ZAM_SPOTREBA("Zam. spotreba", Icons.Outlined.Restaurant, "zam-spotreba", "ĽUDIA"),
    STORNO("Storno kôš", Icons.AutoMirrored.Outlined.Undo, "storno", "ĽUDIA"),

    SKLAD_PREHLAD("Prehľad skladu", Icons.Outlined.Inventory2, "inventory-dashboard", "SKLAD"),
    MATERIALY("Materiály", Icons.Outlined.Grain, "ingredients", "SKLAD"),
    POHYBY("Pohyby", Icons.Outlined.SwapHoriz, "stock-movements", "SKLAD"),
    OBJEDNAVKY("Objednávky", Icons.Outlined.ShoppingCart, "purchase-orders", "SKLAD"),
    MAJETOK("Majetok", Icons.Outlined.Sell, "assets", "SKLAD"),
    SHISHA("Shisha", Icons.Outlined.Air, "shisha", "SKLAD"),

    NASTAVENIA("Nastavenia", Icons.Outlined.Settings, "settings", "SYSTÉM"),
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
            Surface(color = CreamElev, modifier = Modifier.paperShadow(Elev.rest, RectangleShape)) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    Box {
                        TextButton(onClick = { navOpen = true }) {
                            Text("☰", style = MaterialTheme.typography.titleSmall, color = Terra)
                            Spacer(Modifier.width(8.dp))
                            Icon(page.icon, null, Modifier.size(IconSize.md), tint = Terra)
                            Spacer(Modifier.width(6.dp))
                            Text(page.title,
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
                                    leadingIcon = { Icon(p.icon, null, Modifier.size(IconSize.md),
                                        tint = if (p == page) Terra else MaterialTheme.colorScheme.onSurface) },
                                    text = { Text(p.title,
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
            Modifier.width(200.dp).fillMaxHeight().paperShadow(Elev.rest, RectangleShape),
            color = CreamElev,
        ) {
            Column(Modifier.fillMaxHeight()) {
                // Brand hlavička railu
                Row(Modifier.padding(horizontal = 14.dp, vertical = 14.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Outlined.AdminPanelSettings, null, Modifier.size(IconSize.lg), tint = Terra)
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
        colorSpecOrSnap(), label = "rail")
    val ink by animateColorAsState(if (active) Terra else MaterialTheme.colorScheme.onSurface,
        colorSpecOrSnap(), label = "railInk")
    Surface(onClick = onClick, interactionSource = interaction, shape = RoundedCornerShape(Radius.md),
        color = fill, modifier = Modifier.fillMaxWidth().pressScale(interaction)) {
        Row(Modifier.height(IntrinsicSize.Min), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.width(3.dp).fillMaxHeight()
                .background(if (active) Terra else Color.Transparent))
            Spacer(Modifier.width(8.dp))
            Icon(p.icon, null, Modifier.size(IconSize.md), tint = ink)
            Spacer(Modifier.width(8.dp))
            Text(p.title, color = ink,
                fontWeight = if (active) FontWeight.ExtraBold else FontWeight.SemiBold,
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(vertical = 11.dp).weight(1f))
        }
    }
}
