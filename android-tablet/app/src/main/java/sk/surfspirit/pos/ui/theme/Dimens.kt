package sk.surfspirit.pos.ui.theme

import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/* =====================================================================
   Dimenzné tokeny — zrkadlia web DESIGN-CODE.md (§ spacing, § radius,
   § shadows), aby tablet a web hovorili jedným slovníkom.

   PRAVIDLO: v ui zdrojoch sa radius / elevácia / icon-size NEpíšu ako
   literály — vždy cez tokeny. Výnimka = komentár `// token-exempt: dôvod`.
   Spacing literály sú povolené, ale preferuj Space.* hodnoty (4/8 rytmus).
   ===================================================================== */

/** Spacing škála — web --space-1..12 (4/8 rytmus). */
object Space {
    val s05: Dp = 2.dp    // hairline medzery (seg toggle inner)
    val s1: Dp = 4.dp
    val s2: Dp = 8.dp
    val s3: Dp = 12.dp
    val s4: Dp = 16.dp    // default content/card padding (web --space-4)
    val s5: Dp = 20.dp
    val s6: Dp = 24.dp
    val s8: Dp = 32.dp
    val s12: Dp = 48.dp
}

/** Radius škála — web --radius-xs/sm/md/lg/full (4/8/14/22/999). */
object Radius {
    val xs: Dp = 4.dp     // badge, indikátorový prúžok, kbd
    val sm: Dp = 8.dp     // tlačidlo, input, chip, malá dlaždica
    val md: Dp = 14.dp    // karta, panel, table chip, PIN kláves
    val lg: Dp = 22.dp    // modal, sheet, veľká karta
    val full: Dp = 999.dp // pill / kruh
}

/** Elevačný rebrík — paperShadow vrstvy (web --shadow-sm/md/lg). */
object Elev {
    val rest: Dp = 2.dp   // resting karty / chipy / klávesy
    val float: Dp = 6.dp  // header, plávajúce panely, toasty
    val modal: Dp = 14.dp // dialógy
}

/** Ikonové veľkosti — jednotný rytmus namiesto ad-hoc 8..28 dp. */
object IconSize {
    val sm: Dp = 14.dp    // meta/badge ikonky v labeloch
    val md: Dp = 18.dp    // inline default
    val lg: Dp = 22.dp    // IconButton / akčné ikony
    val xl: Dp = 28.dp    // pad klávesy, hero
}

/** A11y minimum pre akúkoľvek tapateľnú plochu (Apple 44pt / MD 48dp). */
val MinTouch: Dp = 48.dp
