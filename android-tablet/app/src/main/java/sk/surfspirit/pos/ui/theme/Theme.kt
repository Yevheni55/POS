package sk.surfspirit.pos.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import sk.surfspirit.pos.R

/* ===== Daylight paleta — PRESNÁ zhoda so živým web POS (css/pos.css :root) ===== */
val Cream        = Color(0xFFF5EFE3)   // --color-bg
val CreamElev    = Color(0xFFECE4D2)   // --color-bg-elevated / sunken
val CreamSunken  = Color(0xFFE4DAC4)   // o stupeň hlbšie (panel wells)
val Terra        = Color(0xFFB8542A)   // --color-accent (terra clay)
val TerraDim     = Color(0xFFA04920)   // --color-accent-dim
val Sage         = Color(0xFF4A7A3A)   // --color-success (forest/olive)
val Amber        = Color(0xFFB87C1A)   // --accent-amber / Poslať / reserved
val Navy         = Color(0xFF1F3A5C)   // secondary / Predúčet
val Espresso     = Color(0xFF1E1812)   // --color-text (dark espresso)
val EspressoSoft = Color(0xFF5A4F3C)   // --color-text-sec
val EspressoDim  = Color(0xFF8A7D65)   // --color-text-dim
val Danger       = Color(0xFFB03830)   // --color-danger (rust)

/* Warm-taupe bordery — „pencil-drawn", nie pen-stroke (web --color-border*) */
val BorderSoft   = Color(0x337A6450)   // rgba(122,100,80,.20)
val BorderMid    = Color(0x4D7A6450)   // rgba(122,100,80,.30)
val BorderStrong = Color(0x6B7A6450)   // rgba(122,100,80,.42)
val Hairline     = BorderSoft          // alias — starší kód

/* Tieň — teplý espresso ambient (web 3-tier paper drop stack) */
val ShadowTint   = Color(0xFF2A1E14)

private val DaylightColors = lightColorScheme(
    primary = Terra,
    onPrimary = Cream,
    primaryContainer = Color(0x14B8542A),
    onPrimaryContainer = TerraDim,
    secondary = Sage,
    onSecondary = Cream,
    background = Cream,
    onBackground = Espresso,
    surface = CreamElev,
    onSurface = Espresso,
    surfaceVariant = CreamSunken,
    onSurfaceVariant = EspressoSoft,
    outline = BorderSoft,
    outlineVariant = BorderMid,
    error = Danger,
    onError = Cream,
    // Dialógy/sheety (M3 surfaceContainer* rodina) — cream ladder namiesto
    // default šedých tonal overlays, nech modaly nepôsobia "stock Material".
    surfaceContainerLowest = Cream,
    surfaceContainerLow = Cream,
    surfaceContainer = Cream,
    surfaceContainerHigh = Cream,
    surfaceContainerHighest = CreamElev,
    surfaceTint = Color.Transparent,
)

// Brand fonty — zhoda s web POS (Sora = display, Manrope = body).
val Sora = FontFamily(
    Font(R.font.sora_regular, FontWeight.Normal),
    Font(R.font.sora_semibold, FontWeight.SemiBold),
    Font(R.font.sora_bold, FontWeight.Bold),
    Font(R.font.sora_extrabold, FontWeight.ExtraBold),
)
val Manrope = FontFamily(
    Font(R.font.manrope_regular, FontWeight.Normal),
    Font(R.font.manrope_medium, FontWeight.Medium),
    Font(R.font.manrope_semibold, FontWeight.SemiBold),
    Font(R.font.manrope_bold, FontWeight.Bold),
)

// Display štýly → Sora; textové → Manrope. Veľkosti ladené pre 10.1".
private val PosTypography = Typography(
    // Money/hero tier — CELKOM hero (order panel) a K ÚHRADE (payment dialóg)
    displaySmall = TextStyle(fontFamily = Sora, fontWeight = FontWeight.ExtraBold, fontSize = 30.sp, letterSpacing = (-0.5).sp),
    headlineSmall = TextStyle(fontFamily = Sora, fontWeight = FontWeight.ExtraBold, fontSize = 26.sp, letterSpacing = (-0.4).sp),
    titleLarge = TextStyle(fontFamily = Sora, fontWeight = FontWeight.ExtraBold, fontSize = 24.sp, letterSpacing = (-0.3).sp),
    titleMedium = TextStyle(fontFamily = Sora, fontWeight = FontWeight.Bold, fontSize = 18.sp),
    titleSmall = TextStyle(fontFamily = Sora, fontWeight = FontWeight.SemiBold, fontSize = 14.sp),
    bodyLarge = TextStyle(fontFamily = Manrope, fontWeight = FontWeight.Normal, fontSize = 16.sp),
    bodyMedium = TextStyle(fontFamily = Manrope, fontWeight = FontWeight.Medium, fontSize = 14.sp),
    bodySmall = TextStyle(fontFamily = Manrope, fontWeight = FontWeight.Normal, fontSize = 12.sp),
    labelLarge = TextStyle(fontFamily = Sora, fontWeight = FontWeight.Bold, fontSize = 15.sp),
    labelMedium = TextStyle(fontFamily = Manrope, fontWeight = FontWeight.SemiBold, fontSize = 12.sp),
    labelSmall = TextStyle(fontFamily = Manrope, fontWeight = FontWeight.SemiBold, fontSize = 11.sp, letterSpacing = 0.6.sp),
)

@Composable
fun SurfSpiritTheme(content: @Composable () -> Unit) {
    // Appka je vždy v light "Daylight" režime — POS dizajn je cream, neriešime dark.
    MaterialTheme(colorScheme = DaylightColors, typography = PosTypography, content = content)
}
