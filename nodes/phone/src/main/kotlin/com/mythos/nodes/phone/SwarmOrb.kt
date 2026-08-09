package com.mythos.nodes.phone

import android.graphics.BlendMode
import android.graphics.Paint
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.unit.Dp
import kotlinx.coroutines.delay
import kotlin.math.sin

/**
 * The orb: `design/ai_orb.html`'s particle swarm, driven by the node's own audio.
 *
 * WHAT THIS IS DOING PER FRAME, and why it is written the way it is:
 *
 *  - [SwarmMath.step] advances its particles inside a `withFrameNanos` loop, NOT in
 *    a `collectAsState`. The mic publishes a level every 20ms; recomposing at 50Hz
 *    to read it would recompose this subtree fifty times a second for a value only
 *    the draw phase ever looks at. The loop writes one Int, the draw lambda reads
 *    it, and only the draw phase is invalidated.
 *  - The draw pass allocates nothing. Compose's `drawPoints` takes a `List<Offset>`,
 *    which at 2400 particles and 60fps is ~144,000 allocations a second and shows up
 *    immediately as jank. Particles are instead binned into [BUCKETS] preallocated
 *    `FloatArray`s and blitted through the framework canvas with one reused `Paint`
 *    per bin.
 *  - Bloom is faked with two additive passes (wide+dim, narrow+bright) rather than
 *    a `BlurMaskFilter`. Mask filters are unreliable under hardware acceleration —
 *    they either force a software layer or silently draw nothing. Additive blending
 *    is order-independent, which is also why no depth sort is needed.
 *  - When motion is off (reduced-motion, or the socket is down) the loop is
 *    *cancelled*, not fed a constant. A frame loop that keeps ticking to render an
 *    unchanging image is a battery leak with no visible symptom.
 */
@Composable
fun SwarmOrb(
    color: Color,
    phase: VoiceNodeService.Phase,
    offline: Boolean,
    reduceMotion: Boolean,
    enabled: Boolean,
    stateLabel: String,
    diameter: Dp,
    onToggle: () -> Unit,
) {
    val swarm = remember { SwarmMath() }
    val envelope = remember { Envelope() }

    // Sized for the worst case (every particle in one bin) and allocated once. The
    // memory is trivial; the allocation churn it avoids is not.
    val binXY = remember { Array(BUCKETS) { FloatArray(swarm.count * 2) } }
    val binCount = remember { IntArray(BUCKETS) }
    val binArgb = remember { IntArray(BUCKETS) }
    val binDepth = remember { FloatArray(BUCKETS) }
    val paints = remember {
        Array(BUCKETS) {
            Paint().apply {
                isAntiAlias = true
                style = Paint.Style.STROKE
                strokeCap = Paint.Cap.ROUND
                blendMode = BlendMode.PLUS
            }
        }
    }

    // Bumped by the frame loop, read by the draw lambda. This is the whole
    // invalidation channel — nothing else in this subtree needs to recompose.
    var tick by remember { mutableIntStateOf(0) }
    // Plain holders, written in the frame callback and read in draw. Not snapshot
    // state: `tick` already carries the invalidation, and making each of these
    // observable would just add three more subscriptions to the same signal.
    val frame = remember { FrameState() }

    val stateHue = remember(color) { hueOfArgb(color.toArgb()) }
    val params = remember(phase, offline, stateHue) { paramsFor(phase, offline, stateHue) }
    val animate = !reduceMotion && !offline

    // Every dependency the loop reads is in the key, so switching state restarts it
    // cleanly rather than leaving a stale loop writing over a new one.
    LaunchedEffect(animate, params, phase) {
        // The envelope belongs to a state, so it starts from rest on a transition.
        // `frame.t` and the swarm's smoothing deliberately do NOT reset: this effect
        // restarts on every phase change, and rewinding there would make the orb
        // visibly snap back to a seeded sphere each time MYTHOS started speaking.
        envelope.reset()
        if (!animate) {
            // One frame, then stop. Reduced motion still gets the orb — it just
            // gets it as an object rather than as an animation. rewind() is needed
            // here and only here: a single step with smoothing on would barely move
            // off whatever the previous state left behind.
            swarm.rewind()
            swarm.step(STATIC_TIME, 1f / 60f, params)
            frame.amplitude = 0f
            tick++
            return@LaunchedEffect
        }
        var lastNanos = 0L
        while (true) {
            withFrameNanos { now ->
                // Clamped: coming back from a background stall, an unclamped dt
                // makes the envelope jump and the swarm teleport.
                val dt = if (lastNanos == 0L) 1f / 60f
                else ((now - lastNanos) / 1_000_000_000f).coerceIn(0f, 0.1f)
                lastNanos = now
                frame.t += dt

                val raw = when {
                    phase == VoiceNodeService.Phase.LISTENING -> OrbAudio.inputLevel
                    phase == VoiceNodeService.Phase.SPEAKING -> OrbAudio.sampleOutput(
                        nowMs = now / 1_000_000L,
                        tSeconds = frame.t,
                        speaking = true,
                    )
                    else -> 0f
                }
                frame.amplitude = envelope.step(raw, dt)
                swarm.step(frame.t, dt, params.copy(amplitude = frame.amplitude))
                tick++
            }
        }
    }

    DisposableEffect(Unit) {
        onDispose { OrbAudio.reset() }
    }

    // Driven by a tap, not by finger-down — a toggle has no "held" state to
    // read, so the press feel is a short animation rather than a live signal.
    var pressed by remember { mutableStateOf(false) }
    LaunchedEffect(pressed) {
        if (pressed) {
            delay(PRESS_PULSE_MS)
            pressed = false
        }
    }
    // Read inside the handler rather than captured, so the modifier is never re-keyed
    // on it.
    val enabledState = rememberUpdatedState(enabled)
    val listening = phase != VoiceNodeService.Phase.IDLE

    Box(
        modifier = Modifier
            // Sized by the caller from the space actually available. Note this is
            // NOT in the pointerInput key below: re-keying the gesture mid-gesture
            // would cancel a tap in progress.
            .size(diameter)
            .scale(if (pressed) 0.97f else 1f)
            .semantics {
                contentDescription = "Talk to MYTHOS. Current state: $stateLabel. " +
                    if (listening) "Tap to stop." else "Tap to start listening."
            }
            // Keyed on Unit, and `enabled` is read INSIDE the handler.
            //
            // This used to be pointerInput(enabled), where enabled folds in the
            // socket status. A reconnect is the normal case on a phone, so a
            // status flip mid-gesture re-keyed the modifier and could cancel a tap
            // already being recognised. The gesture must not be at the mercy of
            // the network — nor of the orb's animation, which is why neither the
            // phase nor the amplitude appears in this key either.
            .pointerInput(Unit) {
                detectTapGestures(
                    onTap = {
                        if (!enabledState.value) return@detectTapGestures
                        pressed = true
                        onToggle()
                    },
                )
            },
        contentAlignment = Alignment.Center,
    ) {
        // Two glow layers, both remembered: a radial gradient allocates a shader, and
        // only the alpha varies per frame. An explicit radius matters — left
        // unspecified the gradient spans the whole draw area, so a smaller
        // drawCircle would clip a flat disc with a hard edge instead of falling off.
        //
        // One layer at this size reads as a smudge. A wide ambient wash plus a tight
        // core is what makes it read as a light source rather than a blur.
        val density = LocalDensity.current
        val halfPx = remember(diameter, density) { with(density) { diameter.toPx() } / 2f }
        val ambientGlow = remember(color, halfPx) {
            Brush.radialGradient(
                colors = listOf(color.copy(alpha = 0.30f), Color.Transparent),
                radius = halfPx * 1.05f,
            )
        }
        val coreGlow = remember(color, halfPx) {
            Brush.radialGradient(
                colors = listOf(color.copy(alpha = 0.55f), Color.Transparent),
                radius = halfPx * 0.50f,
            )
        }

        Canvas(modifier = Modifier.fillMaxSize()) {
            // Reading `tick` is what subscribes this draw pass to the frame loop.
            // Without it the loop would advance the swarm and nothing would repaint.
            if (tick == Int.MIN_VALUE) return@Canvas

            val half = size.minDimension / 2f
            val center = Offset(size.width / 2f, size.height / 2f)
            val amp = frame.amplitude

            // The float. Two incommensurate frequencies so the path never visibly
            // repeats, under 3% of the radius so it reads as deliberate rather than
            // loose — and applied as a canvas translation, NOT as a Modifier offset,
            // because the touch target must stay where the thumb expects it while
            // the image drifts. The gradients' implicit centres translate with it.
            val driftX = sin(frame.t * 0.37f) * half * 0.018f
            val driftY = sin(frame.t * 0.53f + 1.1f) * half * 0.028f

            translate(driftX, driftY) {
                // Breathes with the voice, so even at a glance across a room the orb
                // is visibly reacting rather than merely spinning.
                drawCircle(
                    brush = ambientGlow,
                    radius = half * 1.05f,
                    center = center,
                    alpha = 0.55f + 0.45f * amp,
                )
                drawCircle(
                    brush = coreGlow,
                    radius = half * 0.50f,
                    center = center,
                    alpha = 0.40f + 0.60f * amp,
                )

                drawSwarm(swarm, params, binXY, binCount, binArgb, binDepth, paints, center, half, amp)
            }
        }
    }
}

/**
 * Project, bin and blit. No allocation anywhere in here — every array is owned by
 * the caller and reused, and the only per-frame objects are primitives.
 */
private fun DrawScope.drawSwarm(
    swarm: SwarmMath,
    params: SwarmParams,
    binXY: Array<FloatArray>,
    binCount: IntArray,
    binArgb: IntArray,
    binDepth: FloatArray,
    paints: Array<Paint>,
    center: Offset,
    half: Float,
    amplitude: Float,
) {
    // Scaled to the RESTING extent, not the loudest-possible one. Scaling to the
    // maximum is the intuitive choice and it is wrong: it sizes the orb for a frame
    // that occurs during a shout and leaves it drawing at ~60% of its box the rest
    // of the time. A shout now overflows by roughly 15%, which is dim outer
    // particles spilling past the layout bounds — far cheaper than a permanently
    // undersized orb.
    val extent = SwarmMath.restExtent(params)
    if (extent <= 0f) return
    val scale = half * SwarmMath.PROJECTION_FILL / extent

    binCount.fill(0)

    // Hue is binned around the state hue rather than over the whole circle: the
    // swarm's hues cluster tightly once biased, so binning 0..1 would leave all 900
    // particles in one or two bins and throw away the iridescence entirely.
    val stateHue = params.stateHue
    var dMin = Float.MAX_VALUE
    var dMax = -Float.MAX_VALUE
    for (i in 0 until swarm.count) {
        val d = wrapSigned(swarm.hue[i] - stateHue)
        if (d < dMin) dMin = d
        if (d > dMax) dMax = d
    }
    val dSpan = (dMax - dMin).coerceAtLeast(1e-4f)

    for (i in 0 until swarm.count) {
        val z = swarm.z[i]
        // Mild perspective, so the swarm reads as a sphere rather than a disc.
        val persp = FOCAL / (FOCAL - z).coerceAtLeast(FOCAL * 0.35f)
        val sx = center.x + swarm.x[i] * scale * persp
        val sy = center.y + swarm.y[i] * scale * persp

        val hueBin = (((wrapSigned(swarm.hue[i] - stateHue) - dMin) / dSpan) * (HUE_BINS - 1))
            .toInt().coerceIn(0, HUE_BINS - 1)
        // Depth and per-particle lightness share one axis: both make a particle
        // brighter and fatter, and separating them would multiply the bin count for
        // no visible gain once everything is blended additively.
        val depth = ((z / extent) + 1f) * 0.5f
        val lum = (swarm.light[i] * (0.55f + 0.45f * depth)).coerceIn(0f, 1f)
        val lumBin = (lum * (LUM_BINS - 1)).toInt().coerceIn(0, LUM_BINS - 1)

        val bin = hueBin * LUM_BINS + lumBin
        val n = binCount[bin]
        binXY[bin][n * 2] = sx
        binXY[bin][n * 2 + 1] = sy
        binCount[bin] = n + 1
    }

    // Bin colours: representative hue at the bin centre, lightness at the bin's tier.
    for (h in 0 until HUE_BINS) {
        val hue = stateHue + dMin + dSpan * ((h + 0.5f) / HUE_BINS)
        for (l in 0 until LUM_BINS) {
            val bin = h * LUM_BINS + l
            val tier = (l + 0.5f) / LUM_BINS
            binArgb[bin] = hslToArgb(hue, 0.82f, 0.20f + 0.68f * tier)
            binDepth[bin] = tier
        }
    }

    val canvas = drawContext.canvas.nativeCanvas
    val core = (half * CORE_WIDTH_FRACTION).coerceAtLeast(1.2f)
    val bloom = core * BLOOM_WIDTH_MULTIPLE

    for (bin in 0 until BUCKETS) {
        val n = binCount[bin]
        if (n == 0) continue
        val paint = paints[bin]
        val tier = binDepth[bin]
        val argb = binArgb[bin]

        // Wide + dim: the halo. Alpha stays low because every particle in the bin
        // adds to it, and additive blending saturates fast.
        paint.color = argb
        paint.alpha = (BLOOM_ALPHA * (0.45f + 0.55f * tier) * 255f).toInt().coerceIn(0, 255)
        paint.strokeWidth = bloom * (0.7f + 0.6f * tier)
        canvas.drawPoints(binXY[bin], 0, n * 2, paint)

        // Narrow + bright: the particle itself.
        paint.alpha = ((0.45f + 0.55f * tier) * (0.72f + 0.28f * amplitude) * 255f)
            .toInt().coerceIn(0, 255)
        paint.strokeWidth = core * (0.75f + 0.5f * tier)
        canvas.drawPoints(binXY[bin], 0, n * 2, paint)
    }
}

/** Signed distance on the hue circle, in (-0.5, 0.5]. */
private fun wrapSigned(d: Float): Float {
    var v = d - kotlin.math.floor(d)
    if (v > 0.5f) v -= 1f
    return v
}

/**
 * How each state moves. Colour alone is never the signal — [TalkScreen] keeps the
 * state word under the orb — but motion carries the same information for anyone
 * who is already looking at it.
 */
private fun paramsFor(
    phase: VoiceNodeService.Phase,
    offline: Boolean,
    stateHue: Float,
): SwarmParams = when {
    // Offline: a still sphere. Not slow — still. "Nothing is happening" has to look
    // different from "something is happening quietly".
    offline -> SwarmParams(
        turb = 0.10f, shell = 0.10f, spin = 0f, hueShift = 0.10f,
        stateHue = stateHue, hueBias = 0.90f,
    )
    // Listening: open and calm at rest, and everything reactive comes from the mic.
    phase == VoiceNodeService.Phase.LISTENING -> SwarmParams(
        radius = 62f, turb = 0.38f, flow = 0.9f, spin = 0.22f,
        stateHue = stateHue, hueBias = 0.68f,
    )
    // Thinking: contracted and agitated, spinning noticeably faster. There is no
    // audio on this path, so the motion has to say it on its own.
    phase == VoiceNodeService.Phase.THINKING -> SwarmParams(
        radius = 52f, turb = 0.70f, flow = 1.5f, spin = 0.95f, shell = 0.35f,
        stateHue = stateHue, hueBias = 0.72f,
    )
    // Speaking: wide, bright, and driven by the reply's own envelope.
    phase == VoiceNodeService.Phase.SPEAKING -> SwarmParams(
        radius = 64f, turb = 0.42f, flow = 1.0f, spin = 0.30f,
        stateHue = stateHue, hueBias = 0.62f,
    )
    // Ready: the reference's own tuning, unmodified.
    else -> SwarmParams(stateHue = stateHue, hueBias = 0.60f)
}

/** Mutable per-frame scalars, deliberately outside the snapshot system. */
private class FrameState {
    var t: Float = 0f
    var amplitude: Float = 0f
}

private const val HUE_BINS = 6
private const val LUM_BINS = 4
private const val BUCKETS = HUE_BINS * LUM_BINS

/** Camera distance in swarm units; sets how strong the perspective reads. */
private const val FOCAL = 320f

private const val CORE_WIDTH_FRACTION = 0.013f
private const val BLOOM_WIDTH_MULTIPLE = 3.4f
private const val BLOOM_ALPHA = 0.11f

/** A time far enough in that the static frame is not the seeded sphere. */
private const val STATIC_TIME = 7.3f

/** How long the tap's scale-down pulse lasts before easing back to rest. */
private const val PRESS_PULSE_MS = 120L
