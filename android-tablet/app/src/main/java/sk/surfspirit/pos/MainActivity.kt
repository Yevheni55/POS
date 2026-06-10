package sk.surfspirit.pos

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import sk.surfspirit.pos.core.AppPrefs
import sk.surfspirit.pos.ui.AppNav
import sk.surfspirit.pos.ui.components.LocalToast
import sk.surfspirit.pos.ui.components.PosToastHost
import sk.surfspirit.pos.ui.components.PosToastState
import sk.surfspirit.pos.ui.theme.SurfSpiritTheme
import sk.surfspirit.pos.ui.update.UpdateGate

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AppPrefs.init(applicationContext, getString(R.string.default_server_url))
        // Tablet (sw ≥ 600 dp) = kiosk landscape ako doteraz; telefón = voľná
        // rotácia (čašník drží mobil na výšku).
        requestedOrientation = if (resources.configuration.smallestScreenWidthDp >= 600)
            android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        else
            android.content.pm.ActivityInfo.SCREEN_ORIENTATION_FULL_USER
        // Kiosk: drž obrazovku zapnutú počas celej zmeny.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        enableEdgeToEdge()
        applyImmersive()
        setContent {
            SurfSpiritTheme {
                // Globálny toast — žije NAD navigáciou, prežije prepnutie
                // admin stránky aj admin ↔ POS.
                val toast = remember { PosToastState() }
                CompositionLocalProvider(LocalToast provides toast) {
                    Box(Modifier.fillMaxSize()) {
                        AppNav()
                        UpdateGate()   // skontroluje /uploads/app/latest.json a ponúkne update
                        PosToastHost(toast)   // posledné dieťa — toast nad všetkým
                    }
                }
            }
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) applyImmersive()   // re-skry lišty po dialógoch/klávesnici
    }

    /** Immersive sticky — skry status + nav bar (kiosk feel na 10.1" tablete). */
    private fun applyImmersive() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val c = WindowInsetsControllerCompat(window, window.decorView)
        c.hide(WindowInsetsCompat.Type.systemBars())
        c.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    }
}
