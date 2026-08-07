package com.mythos.nodes.phone

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/**
 * The MYTHOS design language, on a phone.
 *
 * These are not "a dark palette" — they are the HUD's own semantic tokens
 * (`mythos/ui/public/css/tokens/semantic.css`) transcribed, so watch, phone and
 * desktop read as one product rather than three apps that happen to be dark. If
 * a token changes there, change it here; do not invent a near-miss shade.
 *
 * Dark only, deliberately: every surface this product has is dark, a phone node
 * lives on a counter or a bedside table, and true black costs nothing on OLED.
 *
 * Accessibility rules that the components below actually keep:
 *  - Colour is never the only signal. Every state carries a word as well.
 *  - Contrast: TEXT on BG ≈ 14:1, TEXT_DIM ≈ 7:1, ACCENT ≈ 10:1 — all past 4.5:1.
 *  - Press states change opacity/scale only, never layout, so nothing reflows
 *    under a thumb.
 */
object MythosTheme {

    // --bg / --bg-raised / --panel
    val Bg = Color(0xFF000000)
    val BgRaised = Color(0xFF0A101C)
    val Panel = Color(0xFF0E1626)

    // --hairline: a border you can feel more than see.
    val Hairline = Color(0x2478C8FF)

    // --text / --text-dim / --text-faint
    val Text = Color(0xFFD7E3F4)
    val TextDim = Color(0xFF8BA3C4)
    val TextFaint = Color(0xFF6B82A3)

    // --accent + the orb state colours. These carry meaning, so they are named
    // for the state and not for the hue.
    val Accent = Color(0xFF4FD8FF)
    val Listening = Color(0xFF43E5A0)
    val Speaking = Color(0xFFF5D020)
    val Thinking = Color(0xFFA78BFA)
    val Danger = Color(0xFFFF5F66)
    val Offline = Color(0xFF5F7391)

    // --radius-*
    val RadiusSm = 6.dp
    val RadiusMd = 10.dp
    val RadiusLg = 16.dp

    // --dur-* / --ease. The breathing period is slow on purpose: an idle orb
    // should read as "waiting", not "working".
    const val DurFastMs = 140
    const val DurMedMs = 320
    const val DurBreathMs = 900

    val Ease = CubicBezierEasing(0.16f, 1f, 0.3f, 1f)

    /** Minimum touch target. Non-negotiable on a device used at arm's length. */
    val TouchTarget = 48.dp
}
