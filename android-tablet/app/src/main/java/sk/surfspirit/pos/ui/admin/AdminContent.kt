package sk.surfspirit.pos.ui.admin

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import sk.surfspirit.pos.ui.AdminScreen
import sk.surfspirit.pos.ui.admin.pages.*

/**
 * Dispatcher obsahu — natívne obrazovky per stránka; len Objednávky skladu,
 * Majetok a Nastavenia (zriedkavé / konfiguračné) bežia vo WebView fallbacku
 * (živý admin z kasy, deep-link na hash route).
 */
@Composable
fun AdminContent(page: AdminPage, onOpenFloorEdit: () -> Unit, onBackToPos: () -> Unit = {}) {
    when (page) {
        AdminPage.DASHBOARD -> DashboardScreen()
        AdminPage.REPORTY -> ReportsHost()
        AdminPage.HISTORIA -> HistoriaHost()
        AdminPage.CASHFLOW -> CashflowScreen()
        AdminPage.MENU -> MenuAdminScreen()
        AdminPage.RECEPTY -> RecipesScreen()
        AdminPage.STOLY -> TablesInfoScreen(onOpenFloorEdit = onOpenFloorEdit)
        AdminPage.LUDIA -> StaffScreen()
        AdminPage.DOCHADZKA -> DochadzkaScreen()
        AdminPage.ZAM_SPOTREBA -> ZamSpotrebaScreen()
        AdminPage.STORNO -> StornoScreen()
        AdminPage.SKLAD_PREHLAD -> InventoryScreen()
        AdminPage.MATERIALY -> MaterialyScreen()
        AdminPage.POHYBY -> PohybyScreen()
        AdminPage.SHISHA -> ShishaScreen()
        // WebView fallback — zriedkavo používané / konfiguračné stránky.
        // key(page): tri stránky zdieľajú jedno call site, bez key by Compose
        // recykloval tú istú AdminScreen inštanciu (WebView factory beží len raz)
        // a prepnutie Objednávky → Nastavenia by nenavigovalo.
        AdminPage.OBJEDNAVKY, AdminPage.MAJETOK, AdminPage.NASTAVENIA ->
            key(page) { AdminScreen(onBack = onBackToPos, initialHash = page.hash) }
    }
}

/** Reporty: Denný | Trendy (Týždeň+Sezóna). */
@Composable
private fun ReportsHost() {
    var tab by remember { mutableStateOf(0) }
    Column {
        Box(Modifier.padding(start = 16.dp, top = 12.dp)) {
            PillTabs(listOf("Denný", "Trendy"), tab) { tab = it }
        }
        if (tab == 0) ReportsDailyScreen() else ReportsTrendsScreen()
    }
}

/** História: Platby | Fiškál a audit. */
@Composable
private fun HistoriaHost() {
    var tab by remember { mutableStateOf(0) }
    Column {
        Box(Modifier.padding(start = 16.dp, top = 12.dp)) {
            PillTabs(listOf("Platby", "Fiškál a audit"), tab) { tab = it }
        }
        if (tab == 0) PaymentsScreen() else FiscalAuditScreen()
    }
}
