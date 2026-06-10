package sk.surfspirit.pos.ui.components

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import sk.surfspirit.pos.ui.theme.Amber
import sk.surfspirit.pos.ui.theme.Cream
import sk.surfspirit.pos.ui.theme.Danger
import sk.surfspirit.pos.ui.theme.Elev
import sk.surfspirit.pos.ui.theme.Espresso
import sk.surfspirit.pos.ui.theme.Motion
import sk.surfspirit.pos.ui.theme.Radius
import sk.surfspirit.pos.ui.theme.Sage
import sk.surfspirit.pos.ui.theme.Space
import sk.surfspirit.pos.ui.theme.paperShadow
import sk.surfspirit.pos.ui.theme.reducedMotion

/* =====================================================================
   JEDEN toast systém pre celú appku — tón nesie stav (žiadne čuchanie
   prefixov správ), host žije NAD navigáciou (MainActivity/AppNav), takže
   toast prežije prepnutie admin stránky aj admin ↔ POS.
   ===================================================================== */

enum class ToastTone(val bar: Color) {
    Success(Sage), Info(sk.surfspirit.pos.ui.theme.Terra), Warning(Amber), Error(Danger)
}

class PosToastState {
    var message by mutableStateOf<String?>(null)
        internal set
    var tone by mutableStateOf(ToastTone.Info)
        internal set
    // generácia — rovnaká správa 2× za sebou musí reštartnúť auto-dismiss
    internal var gen by mutableStateOf(0)

    fun show(msg: String, tone: ToastTone) { message = msg; this.tone = tone; gen++ }
    /** Legacy signatúra AdminToastState — kompatibilná migrácia call sites. */
    fun show(msg: String, error: Boolean = false) =
        show(msg, if (error) ToastTone.Error else ToastTone.Success)
    fun success(msg: String) = show(msg, ToastTone.Success)
    fun error(msg: String) = show(msg, ToastTone.Error)
    fun warning(msg: String) = show(msg, ToastTone.Warning)
    fun dismiss() { message = null }
}

val LocalToast = staticCompositionLocalOf<PosToastState> {
    error("PosToastState nie je poskytnutý — CompositionLocalProvider(LocalToast …) patrí do MainActivity")
}

/**
 * Host — espresso pill so sémantickým ľavým prúžkom, bottom-center.
 * Renderuj RAZ, ako posledné dieťa root Boxu nad AppNav. Auto-dismiss:
 * Error 4 s, ostatné 2,5 s.
 */
@Composable
fun PosToastHost(state: PosToastState) {
    val msg = state.message
    val reduced = reducedMotion()
    Box(Modifier.fillMaxSize()) {
        AnimatedVisibility(
            visible = msg != null,
            enter = if (reduced) fadeIn(tween(0)) else
                slideInVertically(tween(Motion.NORMAL)) { it / 2 } + fadeIn(tween(Motion.NORMAL)),
            exit = if (reduced) fadeOut(tween(0)) else
                slideOutVertically(tween(Motion.FAST)) { it / 2 } + fadeOut(tween(Motion.FAST)),
            modifier = Modifier.align(Alignment.BottomCenter),
        ) {
            // Posledná neprázdna správa — počas exit animácie msg už je null
            var shown by androidx.compose.runtime.remember { mutableStateOf("" to ToastTone.Info) }
            if (msg != null) shown = msg to state.tone
            val (text, tone) = shown
            Surface(
                Modifier.padding(Space.s4).paperShadow(Elev.float, RoundedCornerShape(Radius.md)),
                shape = RoundedCornerShape(Radius.md), color = Espresso, contentColor = Cream,
            ) {
                Row(Modifier.height(IntrinsicSize.Min)
                    .semantics { liveRegion = LiveRegionMode.Polite }) {
                    Box(Modifier.width(4.dp).fillMaxHeight().background(tone.bar))
                    Text(text, Modifier.padding(horizontal = Space.s4 - 2.dp, vertical = Space.s3),
                        style = MaterialTheme.typography.bodyMedium)
                }
            }
        }
    }
    LaunchedEffect(msg, state.gen) {
        if (msg != null) {
            delay(if (state.tone == ToastTone.Error) 4000 else 2500)
            state.dismiss()
        }
    }
}
