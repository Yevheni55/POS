package sk.surfspirit.pos.ui.theme

import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import sk.surfspirit.pos.R

/* =====================================================================
   „Warm Hearth POS" paleta — Stitch design systém (Bistro Modern).
   v3.2 Night Service: paleta žije v HearthPalette + LocalHearth —
   všetky doterajšie top-level vals (Terra, Cream, …) sú @Composable
   gettery nad aktívnou paletou, takže existujúci kód kompiluje bez
   zmien a dark mode je čisto dátová záležitosť. Non-composable miesta
   (draw lambdy, helpery) si hodnotu hoistnú v composable scope.
   ===================================================================== */

/** Kompletná Hearth paleta — light (Warm Hearth) aj night (Night Service). */
data class HearthPalette(
    // Cream/surface ladder
    val cream: Color,
    val creamElev: Color,
    val creamSunken: Color,
    // Terra trio
    val terra: Color,
    val terraLight: Color,
    val terraDim: Color,
    // Sémantické akcenty
    val sage: Color,
    val amber: Color,
    val navy: Color,
    val danger: Color,
    // Espresso text trio
    val espresso: Color,
    val espressoSoft: Color,
    val espressoDim: Color,
    // Bordery
    val borderSoft: Color,
    val borderMid: Color,
    val borderStrong: Color,
    // Ember gradient (hero CELKOM / brand momenty) — na tme NEinvertovať,
    // len posunúť do svetlejších uhlíkov.
    val emberStart: Color,
    val emberMid: Color,
    val emberEnd: Color,
    // Obsah na terra/ember plochách (tlačidlá, hero) — na tme nesmie byť
    // špinavo-tmavý text na svetlej terre.
    val onTerra: Color,
    val isDark: Boolean,
)

/** Warm Hearth — denná paleta (pôvodné hodnoty, nezmenené). */
val LightHearth = HearthPalette(
    cream = Color(0xFFFFF8F6),
    creamElev = Color(0xFFFFF1EC),
    creamSunken = Color(0xFFFFE9E2),
    terra = Color(0xFF95442A),
    terraLight = Color(0xFFB45C3F),
    terraDim = Color(0xFF793017),
    sage = Color(0xFF4A7A3A),
    amber = Color(0xFFB87C1A),
    navy = Color(0xFF1F3A5C),
    danger = Color(0xFFBA1A1A),
    espresso = Color(0xFF281811),
    espressoSoft = Color(0xFF55433D),
    // Pôvodné #88726C malo na Cream len 4,29:1 (pod AA); #6E5A53 = 6,55:1.
    espressoDim = Color(0xFF6E5A53),
    borderSoft = Color(0x3388726C),
    borderMid = Color(0x4D88726C),
    borderStrong = Color(0x6688726C),
    emberStart = Color(0xFFB45C3F),
    emberMid = Color(0xFF95442A),
    emberEnd = Color(0xFF793017),
    onTerra = Color(0xFFFFF8F6),
    isDark = false,
)

/** Night Service — AA prepočítaná tmavá paleta (plán v3.2). Raw Terra je na
 *  tme 2,7:1 → primary #D9805C; ember hero sa neinvertuje, len zosvetlí. */
val NightHearth = HearthPalette(
    cream = Color(0xFF1E140F),        // surface
    creamElev = Color(0xFF2B1E16),    // elevated panely
    creamSunken = Color(0xFF150D09),  // sunken wells
    terra = Color(0xFFD9805C),
    terraLight = Color(0xFFE2926B),
    terraDim = Color(0xFFB45C3F),
    sage = Color(0xFF8FBF7A),
    amber = Color(0xFFE0A84F),
    navy = Color(0xFF8FB4DC),
    danger = Color(0xFFFF8A7A),
    espresso = Color(0xFFF4E7DF),
    espressoSoft = Color(0xFFD3BFB4),
    espressoDim = Color(0xFFA78B7F),
    borderSoft = Color(0x40A78B7F),
    borderMid = Color(0x59A78B7F),
    borderStrong = Color(0x73A78B7F),
    emberStart = Color(0xFFE2926B),
    emberMid = Color(0xFFD9805C),
    emberEnd = Color(0xFF95442A),
    onTerra = Color(0xFF2B130A),
    isDark = true,
)

/** Aktívna paleta — poskytuje SurfSpiritTheme; default light (preview/testy). */
val LocalHearth = staticCompositionLocalOf { LightHearth }

/* ---- Kompatibilné accessory — celý existujúci kód ich používa priamo. ----
   @Composable get() číta aktívnu paletu; funguje aj v default parametroch
   composable funkcií. Non-composable kontext (draw lambdy) si hodnotu
   hoistne do lokálu v composable scope. */
val Cream: Color @Composable get() = LocalHearth.current.cream
val CreamElev: Color @Composable get() = LocalHearth.current.creamElev
val CreamSunken: Color @Composable get() = LocalHearth.current.creamSunken
val Terra: Color @Composable get() = LocalHearth.current.terra
val TerraLight: Color @Composable get() = LocalHearth.current.terraLight
val TerraDim: Color @Composable get() = LocalHearth.current.terraDim
val Sage: Color @Composable get() = LocalHearth.current.sage
val Amber: Color @Composable get() = LocalHearth.current.amber
val Navy: Color @Composable get() = LocalHearth.current.navy
val Danger: Color @Composable get() = LocalHearth.current.danger
val Espresso: Color @Composable get() = LocalHearth.current.espresso
val EspressoSoft: Color @Composable get() = LocalHearth.current.espressoSoft
val EspressoDim: Color @Composable get() = LocalHearth.current.espressoDim
val BorderSoft: Color @Composable get() = LocalHearth.current.borderSoft
val BorderMid: Color @Composable get() = LocalHearth.current.borderMid
val BorderStrong: Color @Composable get() = LocalHearth.current.borderStrong
val Hairline: Color @Composable get() = LocalHearth.current.borderSoft   // alias — starší kód

/* Tieň — teplý espresso ambient; ostáva rovnaký v oboch režimoch (tiene sú
   tmavé aj na tme) a NIE je composable (paperShadow beží v draw fáze). */
val ShadowTint = Color(0xFF2A1E14)

private fun hearthColorScheme(p: HearthPalette): ColorScheme {
    val base = if (p.isDark) darkColorScheme() else lightColorScheme()
    return base.copy(
        primary = p.terra,
        onPrimary = p.onTerra,
        primaryContainer = p.terra.copy(alpha = 0.08f),
        onPrimaryContainer = if (p.isDark) p.terraLight else p.terraDim,
        secondary = p.sage,
        onSecondary = p.onTerra,
        background = p.cream,
        onBackground = p.espresso,
        surface = p.creamElev,
        onSurface = p.espresso,
        surfaceVariant = p.creamSunken,
        onSurfaceVariant = p.espressoSoft,
        outline = p.borderSoft,
        outlineVariant = p.borderMid,
        error = p.danger,
        onError = if (p.isDark) Color(0xFF2B130A) else p.cream,
        // Dialógy/sheety (M3 surfaceContainer* rodina) — hearth ladder namiesto
        // default šedých tonal overlays, nech modaly nepôsobia „stock Material".
        surfaceContainerLowest = p.cream,
        surfaceContainerLow = p.cream,
        surfaceContainer = p.cream,
        surfaceContainerHigh = p.creamElev,
        surfaceContainerHighest = p.creamElev,
        surfaceTint = Color.Transparent,
    )
}

// Warm Hearth používa JEDEN font — Plus Jakarta Sans (moderný, priateľský,
// vysoko čitateľný). Bold/extrabold váhy ťažko využívané na ceny a tituly.
val PlusJakarta = FontFamily(
    Font(R.font.plus_jakarta_regular, FontWeight.Normal),
    Font(R.font.plus_jakarta_medium, FontWeight.Medium),
    Font(R.font.plus_jakarta_semibold, FontWeight.SemiBold),
    Font(R.font.plus_jakarta_bold, FontWeight.Bold),
    Font(R.font.plus_jakarta_extrabold, FontWeight.ExtraBold),
)
// Aliasy — celý existujúci kód odkazuje `Sora` (display) / `Manrope` (body);
// oba teraz ukazujú na Plus Jakarta Sans → jednotná Warm Hearth typografia.
val Sora = PlusJakarta
val Manrope = PlusJakarta

// Serif akcent — Instrument Serif (zhoda so značkou na webe surfspirit.sk).
// LEN na display momenty: značka, názov stola, „CELKOM" / „K ÚHRADE".
val Serif = FontFamily(Font(R.font.instrument_serif_regular, FontWeight.Normal))

// Display štýly = ťažké váhy (peniaze/tituly); textové = normal/medium.
// Veľkosti ladené pre 10.1" POS čitateľnosť (zachované z Daylight tuningu).
// „tnum" = tabular figures → ceny/sumy v stĺpcoch sa zarovnajú (rovnaká šírka číslic).
private const val TNUM = "tnum"
private val PosTypography = Typography(
    // Money/hero tier — CELKOM hero (order panel) a K ÚHRADE (payment dialóg)
    displaySmall = TextStyle(fontFamily = PlusJakarta, fontWeight = FontWeight.ExtraBold, fontSize = 30.sp, letterSpacing = (-0.5).sp, fontFeatureSettings = TNUM),
    headlineSmall = TextStyle(fontFamily = PlusJakarta, fontWeight = FontWeight.ExtraBold, fontSize = 26.sp, letterSpacing = (-0.4).sp, fontFeatureSettings = TNUM),
    titleLarge = TextStyle(fontFamily = PlusJakarta, fontWeight = FontWeight.ExtraBold, fontSize = 24.sp, letterSpacing = (-0.3).sp, fontFeatureSettings = TNUM),
    titleMedium = TextStyle(fontFamily = PlusJakarta, fontWeight = FontWeight.Bold, fontSize = 18.sp, fontFeatureSettings = TNUM),
    titleSmall = TextStyle(fontFamily = PlusJakarta, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, fontFeatureSettings = TNUM),
    bodyLarge = TextStyle(fontFamily = PlusJakarta, fontWeight = FontWeight.Normal, fontSize = 16.sp),
    bodyMedium = TextStyle(fontFamily = PlusJakarta, fontWeight = FontWeight.Medium, fontSize = 14.sp, fontFeatureSettings = TNUM),
    bodySmall = TextStyle(fontFamily = PlusJakarta, fontWeight = FontWeight.Normal, fontSize = 12.sp, fontFeatureSettings = TNUM),
    labelLarge = TextStyle(fontFamily = PlusJakarta, fontWeight = FontWeight.Bold, fontSize = 15.sp, letterSpacing = 0.2.sp, fontFeatureSettings = TNUM),
    labelMedium = TextStyle(fontFamily = PlusJakarta, fontWeight = FontWeight.SemiBold, fontSize = 12.sp, fontFeatureSettings = TNUM),
    labelSmall = TextStyle(fontFamily = PlusJakarta, fontWeight = FontWeight.SemiBold, fontSize = 11.sp, letterSpacing = 0.6.sp, fontFeatureSettings = TNUM),
)

/* ---- Theme mode (light | dark | auto) — AppPrefs.themeMode ---------- */

/** Mutable trigger — setThemeMode() ním okamžite prekreslí celú appku. */
private val themeModeState = mutableStateOf(sk.surfspirit.pos.core.AppPrefs.themeMode)

fun setThemeMode(mode: String) {
    sk.surfspirit.pos.core.AppPrefs.themeMode = mode
    themeModeState.value = mode
}

/** auto = Night Service 19:00–06:00 (bar večer) — minútový ticker. */
@Composable
private fun resolveDark(mode: String): Boolean = when (mode) {
    "dark" -> true
    "light" -> false
    else -> {
        var hour by androidx.compose.runtime.remember {
            mutableStateOf(java.time.LocalTime.now().hour)
        }
        androidx.compose.runtime.LaunchedEffect(Unit) {
            while (true) {
                kotlinx.coroutines.delay(60_000)
                hour = java.time.LocalTime.now().hour
            }
        }
        hour >= 19 || hour < 6
    }
}

@Composable
fun SurfSpiritTheme(content: @Composable () -> Unit) {
    val mode by themeModeState
    val dark = resolveDark(mode)
    val palette = if (dark) NightHearth else LightHearth
    androidx.compose.runtime.CompositionLocalProvider(LocalHearth provides palette) {
        MaterialTheme(colorScheme = hearthColorScheme(palette), typography = PosTypography, content = content)
    }
}
