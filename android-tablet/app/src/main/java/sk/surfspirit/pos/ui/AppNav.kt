package sk.surfspirit.pos.ui

import androidx.compose.runtime.Composable
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import androidx.navigation.NavType
import sk.surfspirit.pos.core.AppPrefs

/**
 * Navigácia: login → floor → order/{tableId}. Štart závisí od toho, či je
 * uložený platný token. Backend overí token pri prvom requeste; ak je
 * neplatný (401), Floor obrazovka pošle používateľa späť na login.
 */
@Composable
fun AppNav() {
    val nav = rememberNavController()
    val start = if (AppPrefs.isLoggedIn) "floor" else "login"

    // UI state restore (web pos_uiState parita) — po reštarte appky sa vráť
    // na rozpísaný stôl, nech čašník pokračuje presne tam kde skončil.
    // Guard: pri process-death restore Navigation obnoví back stack sám —
    // vtedy NEnavigovať znova (duplicitný order entry na stacku).
    androidx.compose.runtime.LaunchedEffect(Unit) {
        if (AppPrefs.isLoggedIn && nav.currentDestination?.route?.startsWith("order/") != true) {
            sk.surfspirit.pos.core.Store.lastTable()?.let { tid ->
                nav.navigate("order/$tid") { launchSingleTop = true }
            }
        }
    }

    NavHost(navController = nav, startDestination = start) {
        composable("login") {
            LoginScreen(onLoggedIn = {
                nav.navigate("floor") {
                    popUpTo("login") { inclusive = true }
                }
            })
        }
        composable("floor") {
            FloorScreen(
                onOpenTable = { tableId -> nav.navigate("order/$tableId") },
                onLogout = {
                    AppPrefs.logout()
                    nav.navigate("login") { popUpTo("floor") { inclusive = true } }
                },
                onSessionExpired = {
                    nav.navigate("login") { popUpTo("floor") { inclusive = true } }
                },
                onAdmin = { nav.navigate("admin") },
            )
        }
        composable("admin") {
            AdminScreen(onBack = { nav.popBackStack() })
        }
        composable(
            route = "order/{tableId}",
            arguments = listOf(navArgument("tableId") { type = NavType.IntType }),
        ) { backStack ->
            val tableId = backStack.arguments?.getInt("tableId") ?: return@composable
            OrderScreen(
                tableId = tableId,
                onBack = { nav.popBackStack() },
                onLogout = {
                    AppPrefs.logout()
                    nav.navigate("login") { popUpTo("floor") { inclusive = true } }
                },
                onSessionExpired = {
                    nav.navigate("login") { popUpTo("floor") { inclusive = true } }
                },
            )
        }
    }
}
