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

/* =====================================================================
   „Warm Hearth POS" paleta — Stitch design systém (Bistro Modern).
   Tepl-é terracotta + pinkavá kr-émová canvas + deep-coffee text.
   Tonálne vrstvenie (surface-container ladder) + outline-variant bordery
   namiesto ťažk-ých tieňov. Single source of truth pre celú appku —
   všetky obrazovky odkazujú tieto vals priamo + cez MaterialTheme.
   ===================================================================== */

/* Cream ladder — od najsvetlejšej (card faces / bg) po sunken wells.
   Stitch surface=#fff8f6 · surface-container-low=#fff1ec · container=#ffe9e2 */
val Cream        = Color(0xFFFFF8F6)   // surface / background / card faces
val CreamElev    = Color(0xFFFFF1EC)   // surface-container-low — header, panely, pin pad
val CreamSunken  = Color(0xFFFFE9E2)   // surface-container — sunken wells / order pane

/* Terracotta primary — active states, primárne akcie, navigačné highlighty */
val Terra        = Color(0xFF95442A)   // primary
val TerraLight   = Color(0xFFB45C3F)   // primary-container — ember gradient start
val TerraDim     = Color(0xFF793017)   // on-primary-fixed-variant — gradient end / dim

/* Sémantické akcenty — earthy, ladia s hearth paletou */
val Sage         = Color(0xFF4A7A3A)   // success (forest/olive) — „v kuchyni"
val Amber        = Color(0xFFB87C1A)   // warning / queue / koncept
val Navy         = Color(0xFF1F3A5C)   // utility action (Predúčet / presun / edit)

/* Text — deep coffee (Stitch on-surface #281811) */
val Espresso     = Color(0xFF281811)   // on-surface / on-background
val EspressoSoft = Color(0xFF55433D)   // on-surface-variant
// Pôvodné #88726C malo na Cream len 4,29:1 a na CreamSunken 3,86:1 (pod AA
// 4,5:1 pre bežný text). #6E5A53 dáva 6,55:1 / 5,90:1 — AA všade, hue ostáva.
// Bordery NIŽŠIE zámerne ostávajú na #88726C — sú dekoratívne, nie text.
val EspressoDim  = Color(0xFF6E5A53)   // outline — muted brown (AA-safe)

/* Error — Stitch error #ba1a1a */
val Danger       = Color(0xFFBA1A1A)

/* Bordery — soft warm-taupe v Warm Hearth outline hue (#88726c), translucent
   „pencil-drawn" feel nech splývajú nad rôznymi cream tónmi. */
val BorderSoft   = Color(0x3388726C)   // ~20 % — outline-variant feel
val BorderMid    = Color(0x4D88726C)   // ~30 %
val BorderStrong = Color(0x6688726C)   // ~40 %
val Hairline     = BorderSoft          // alias — starší kód

/* Tieň — teplý espresso ambient (paper drop stack) */
val ShadowTint   = Color(0xFF2A1E14)

private val WarmHearthColors = lightColorScheme(
    primary = Terra,
    onPrimary = Cream,                       // ≈ #ffffff na terracotta — výborný kontrast
    primaryContainer = Color(0x1495442A),    // terra tint ~8 %
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
    // default šedých tonal overlays, nech modaly nepôsobia „stock Material".
    surfaceContainerLowest = Cream,
    surfaceContainerLow = Cream,
    surfaceContainer = Cream,
    surfaceContainerHigh = CreamElev,
    surfaceContainerHighest = CreamElev,
    surfaceTint = Color.Transparent,
)

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

@Composable
fun SurfSpiritTheme(content: @Composable () -> Unit) {
    // Appka je vždy v light „Warm Hearth" režime — POS dizajn je cream, neriešime dark.
    MaterialTheme(colorScheme = WarmHearthColors, typography = PosTypography, content = content)
}
