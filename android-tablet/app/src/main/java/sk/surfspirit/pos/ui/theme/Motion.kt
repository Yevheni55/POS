package sk.surfspirit.pos.ui.theme

import android.provider.Settings
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.AnimationSpec
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import sk.surfspirit.pos.core.money

/**
 * Motion tokeny — zrkadlia DESIGN-CODE § 9 (--transition-fast 150 ms,
 * --transition-normal 250 ms). Rozpočet: max 3 súbežné animácie na
 * obrazovke; jediná povolená slučka je shift live-dot ALEBO forgotten
 * pulz (reduced-motion gated), nikdy obe naraz s treťou.
 */
object Motion {
    const val FAST = 150          // press, color/selection swap
    const val NORMAL = 250        // panel reveal, money tick
    val pressSpec = tween<Float>(durationMillis = 120)
    val colorSpec: AnimationSpec<Color> = tween(durationMillis = FAST, easing = FastOutSlowInEasing)
    val moneyTickSpec = tween<Float>(durationMillis = NORMAL, easing = FastOutSlowInEasing)
    val popSpec = spring<Float>(dampingRatio = 0.45f, stiffness = Spring.StiffnessMediumLow)
}

/** Telefónny breakpoint — šírka okna < 600 dp (web mobile breakpoint parita). */
@Composable
fun isPhone(): Boolean =
    androidx.compose.ui.platform.LocalConfiguration.current.screenWidthDp < 600

/** Android ekvivalent prefers-reduced-motion — vypnuté systémové animácie. */
@Composable
fun reducedMotion(): Boolean {
    val ctx = LocalContext.current
    return remember {
        try {
            Settings.Global.getFloat(ctx.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
        } catch (_: Exception) { false }
    }
}

/* ===== Paper-drop tiene — teplý espresso ambient (web --shadow-sm/md/lg) =====
   2 dp = resting karty/chipy · 6 dp = floating panel/header · 14 dp = dialógy */
private val ShadowAmbient = Color(0x141E1812)   // rgba(30,24,18,.08)
private val ShadowSpot = Color(0x1F1E1812)      // rgba(30,24,18,.12)

fun Modifier.paperShadow(elevation: Dp, shape: Shape): Modifier = this.shadow(
    elevation, shape, clip = false, ambientColor = ShadowAmbient, spotColor = ShadowSpot)

/* Terra emphasis glow (web --color-accent-glow rgba(184,84,42,.22)) —
   JEDINÝ primárny cue per fáza objednávky (is-primary state machine). */
private val GlowTerra = Color(0x52B8542A)

fun Modifier.glow(on: Boolean, shape: Shape = RoundedCornerShape(999.dp)): Modifier =
    if (on) this.shadow(10.dp, shape, clip = false, ambientColor = GlowTerra, spotColor = GlowTerra)
    else this

/**
 * Univerzálny press micro-interaction — scale 0.97 (120 ms). Rovnaký
 * interactionSource odovzdaj aj do Surface/Button(interactionSource=…).
 */
@Composable
fun Modifier.pressScale(interaction: MutableInteractionSource, enabled: Boolean = true): Modifier {
    // Bezpodmienečné composable volania — scale sa pri flipe `enabled`
    // (busy toggle) neresetuje cez skupinový swap, len prestane reagovať.
    val reduced = reducedMotion()
    val pressed by interaction.collectIsPressedAsState()
    val scale by animateFloatAsState(
        if (pressed && enabled && !reduced) 0.97f else 1f, Motion.pressSpec, label = "press")
    return this.graphicsLayer { scaleX = scale; scaleY = scale }
}

/**
 * Pokladničný „ticker" — suma sa dopočíta za 250 ms (sk-SK formát).
 * NaN sentinel: PRVÉ zobrazenie sumy je okamžité (snapTo) — count-up beží
 * len pri ZMENE hodnoty, nie pri otvorení stola s existujúcim účtom.
 */
@Composable
fun AnimatedMoney(value: Double, style: TextStyle, color: Color, modifier: Modifier = Modifier) {
    if (reducedMotion()) { Text(money(value), modifier, color = color, style = style); return }
    val anim = remember { Animatable(Float.NaN) }
    LaunchedEffect(value) {
        if (anim.value.isNaN()) anim.snapTo(value.toFloat())
        else anim.animateTo(value.toFloat(), Motion.moneyTickSpec)
    }
    val shown = if (anim.value.isNaN()) value else anim.value.toDouble()
    Text(money(shown), modifier, color = color, style = style)
}

/** Overshoot pop (1 → 1.16 → 1) pri zmene hodnoty — qty badge, PIN dot. */
@Composable
fun rememberPop(key: Any?): Float {
    if (reducedMotion()) return 1f
    val s = remember { Animatable(1f) }
    LaunchedEffect(key) {
        s.snapTo(1f); s.animateTo(1.16f, Motion.popSpec); s.animateTo(1f, Motion.popSpec)
    }
    return s.value
}
