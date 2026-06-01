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

/* ===== Daylight paleta (cream + terra) — zhoduje sa s web POS ===== */
val Cream        = Color(0xFFF5EFE3)
val CreamElev    = Color(0xFFECE4D2)
val CreamSunken  = Color(0xFFE4DAC4)
val Terra        = Color(0xFFB8542A)
val TerraDim     = Color(0xFFA04920)
val Sage         = Color(0xFF4A7A3A)
val Espresso     = Color(0xFF2A2018)
val EspressoSoft = Color(0xCC2A2018)   // ~.80
val EspressoDim  = Color(0x612A2018)   // ~.38
val Danger       = Color(0xFFB5432F)
val Hairline     = Color(0x1F1E1812)   // ~rgba(30,24,18,.12)

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
    outline = Hairline,
    error = Danger,
    onError = Cream,
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
