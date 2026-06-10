package sk.surfspirit.pos.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Backspace
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.scale
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import sk.surfspirit.pos.ui.theme.BorderSoft
import sk.surfspirit.pos.ui.theme.Cream
import sk.surfspirit.pos.ui.theme.Elev
import sk.surfspirit.pos.ui.theme.IconSize
import sk.surfspirit.pos.ui.theme.Radius
import sk.surfspirit.pos.ui.theme.Terra
import sk.surfspirit.pos.ui.theme.colorSpecOrSnap
import sk.surfspirit.pos.ui.theme.glow
import sk.surfspirit.pos.ui.theme.paperShadow
import sk.surfspirit.pos.ui.theme.pressScale
import sk.surfspirit.pos.ui.theme.rememberPop

/* =====================================================================
   JEDINÝ PIN pad pre celú appku — Login, manager-PIN dialóg aj
   dochádzkový terminál. Veľkosti cez PinPadSize, pravý dolný slot cez
   PinPadCorner (OK / akcia „C" / prázdny). Haptika je VNÚTRI klávesu —
   caller už haptiku nerobí (inak by bzučalo dvakrát).
   ===================================================================== */

enum class PinPadSize(val key: Dp, val gap: Dp, val digit: TextUnit, val dot: Dp) {
    Dialog(64.dp, 10.dp, 22.sp, 14.dp),     // payment / manager-PIN dialógy
    Terminal(78.dp, 11.dp, 26.sp, 16.dp),   // dochádzkový kiosk
    Login(84.dp, 12.dp, 28.sp, 16.dp),
}

/** Pravý dolný slot padu. */
sealed interface PinPadCorner {
    data object None : PinPadCorner
    data class Confirm(val enabled: Boolean, val onConfirm: () -> Unit, val busy: Boolean = false) : PinPadCorner
    data class Action(val label: String, val onClick: () -> Unit) : PinPadCorner
}

/** PIN bodky s pop animáciou posledného bodu. */
@Composable
fun PinDots(len: Int, max: Int = 6, dotSize: Dp = 14.dp) {
    val pop = rememberPop(len)
    Row(horizontalArrangement = Arrangement.spacedBy(if (dotSize >= 16.dp) 12.dp else 10.dp)) {
        repeat(max) { i ->
            val fill by animateColorAsState(
                if (i < len) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant,
                colorSpecOrSnap(), label = "pinDot$i")
            Surface(
                shape = CircleShape, color = fill,
                modifier = Modifier.size(dotSize).scale(if (i == len - 1) pop else 1f),
            ) {}
        }
    }
}

@Composable
fun PinPad(
    onDigit: (String) -> Unit,
    onBackspace: () -> Unit,
    modifier: Modifier = Modifier,
    size: PinPadSize = PinPadSize.Dialog,
    corner: PinPadCorner = PinPadCorner.None,
) {
    val keys = listOf("1", "2", "3", "4", "5", "6", "7", "8", "9")
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(size.gap)) {
        for (r in 0..2) {
            Row(horizontalArrangement = Arrangement.spacedBy(size.gap)) {
                for (c in 0..2) {
                    val k = keys[r * 3 + c]
                    PadDigitKey(k, size) { onDigit(k) }
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(size.gap)) {
            PadBackspaceKey(size, onBackspace)
            PadDigitKey("0", size) { onDigit("0") }
            when (corner) {
                is PinPadCorner.None -> Spacer(Modifier.size(size.key))
                is PinPadCorner.Confirm -> PadConfirmKey(size, corner)
                is PinPadCorner.Action -> PadActionKey(size, corner.label, corner.onClick)
            }
        }
    }
}

@Composable
private fun PadDigitKey(label: String, size: PinPadSize, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val haptics = LocalHapticFeedback.current
    val fill by animateColorAsState(
        if (pressed) Terra.copy(alpha = 0.10f) else MaterialTheme.colorScheme.surface,
        colorSpecOrSnap(), label = "padKey")
    Surface(
        onClick = { haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove); onClick() },
        interactionSource = interaction,
        shape = RoundedCornerShape(Radius.md), color = fill,
        border = BorderStroke(1.dp, BorderSoft),
        modifier = Modifier.size(size.key)
            .paperShadow(Elev.rest, RoundedCornerShape(Radius.md))
            .pressScale(interaction),
    ) {
        Box(contentAlignment = Alignment.Center) {
            Text(label, fontSize = size.digit, style = MaterialTheme.typography.titleLarge)
        }
    }
}

@Composable
private fun PadBackspaceKey(size: PinPadSize, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    Surface(
        onClick = onClick, interactionSource = interaction,
        shape = RoundedCornerShape(Radius.md), color = MaterialTheme.colorScheme.surfaceVariant,
        modifier = Modifier.size(size.key)
            .paperShadow(Elev.rest, RoundedCornerShape(Radius.md))
            .pressScale(interaction),
    ) {
        Box(contentAlignment = Alignment.Center) {
            Icon(Icons.AutoMirrored.Filled.Backspace, "Vymazať", Modifier.size(IconSize.xl),
                tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun PadConfirmKey(size: PinPadSize, c: PinPadCorner.Confirm) {
    val interaction = remember { MutableInteractionSource() }
    val fill by animateColorAsState(
        if (c.enabled) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant,
        colorSpecOrSnap(), label = "padOk")
    Surface(
        onClick = { if (c.enabled && !c.busy) c.onConfirm() }, interactionSource = interaction,
        shape = RoundedCornerShape(Radius.md), color = fill,
        modifier = Modifier.size(size.key)
            .glow(c.enabled && !c.busy, RoundedCornerShape(Radius.md))
            .pressScale(interaction, enabled = c.enabled && !c.busy),
    ) {
        Box(contentAlignment = Alignment.Center) {
            if (c.busy) {
                androidx.compose.material3.CircularProgressIndicator(
                    Modifier.size(IconSize.lg), color = Cream, strokeWidth = 2.dp)
            } else {
                Text("OK", fontSize = (size.digit.value * 0.8f).sp,
                    color = if (c.enabled) Cream else MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.labelLarge)
            }
        }
    }
}

@Composable
private fun PadActionKey(size: PinPadSize, label: String, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    Surface(
        onClick = onClick, interactionSource = interaction,
        shape = RoundedCornerShape(Radius.md), color = MaterialTheme.colorScheme.surfaceVariant,
        modifier = Modifier.size(size.key)
            .paperShadow(Elev.rest, RoundedCornerShape(Radius.md))
            .pressScale(interaction),
    ) {
        Box(contentAlignment = Alignment.Center) {
            Text(label, fontSize = size.digit,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.titleLarge)
        }
    }
}
