package sk.surfspirit.pos.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

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

// Sora/Manrope sa dajú pridať ako res/font + FontFamily; pre slice 1 ostávame
// na systémovom sans-serif (čistý, čitateľný na tablete). Veľkosti ladené pre 10.1".
private val PosTypography = Typography(
    titleLarge = TextStyle(fontWeight = FontWeight.ExtraBold, fontSize = 24.sp, letterSpacing = (-0.3).sp),
    titleMedium = TextStyle(fontWeight = FontWeight.Bold, fontSize = 18.sp),
    bodyLarge = TextStyle(fontWeight = FontWeight.Normal, fontSize = 16.sp),
    bodyMedium = TextStyle(fontWeight = FontWeight.Medium, fontSize = 14.sp),
    labelLarge = TextStyle(fontWeight = FontWeight.Bold, fontSize = 15.sp),
    labelSmall = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 11.sp, letterSpacing = 0.6.sp),
)

@Composable
fun SurfSpiritTheme(content: @Composable () -> Unit) {
    // Appka je vždy v light "Daylight" režime — POS dizajn je cream, neriešime dark.
    MaterialTheme(colorScheme = DaylightColors, typography = PosTypography, content = content)
}
