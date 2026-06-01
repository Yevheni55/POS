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
            )
        }
        composable(
            route = "order/{tableId}",
            arguments = listOf(navArgument("tableId") { type = NavType.IntType }),
        ) { backStack ->
            val tableId = backStack.arguments?.getInt("tableId") ?: return@composable
            OrderScreen(tableId = tableId, onBack = { nav.popBackStack() })
        }
    }
}
