package sk.surfspirit.pos

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import sk.surfspirit.pos.core.AppPrefs
import sk.surfspirit.pos.ui.AppNav
import sk.surfspirit.pos.ui.theme.SurfSpiritTheme
import sk.surfspirit.pos.ui.update.UpdateGate

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AppPrefs.init(applicationContext, getString(R.string.default_server_url))
        // Kiosk: drž obrazovku zapnutú počas celej zmeny.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        enableEdgeToEdge()
        applyImmersive()
        setContent {
            SurfSpiritTheme {
                AppNav()
                UpdateGate()   // skontroluje /uploads/app/latest.json a ponúkne update
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
