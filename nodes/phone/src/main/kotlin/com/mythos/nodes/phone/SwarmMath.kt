package com.mythos.nodes.phone

import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * The orb's swarm, ported from `design/ai_orb.html`.
 *
 * The reference is three.js: 20,000 instanced tetrahedra with an UnrealBloom pass,
 * on a desktop GPU. This is the same *maths* — Fibonacci-sphere distribution, three
 * layered curl-turbulence sines, the breath term, the shell/core split, the slow
 * drift and the iridescent HSL palette, at the reference's own tuning constants —
 * evaluated on the CPU for a number of particles a phone can actually afford. The
 * constants are copied deliberately and should not be "tidied": they are what makes
 * it read as that orb rather than a generic point cloud.
 *
 * Two departures from the reference, both intentional:
 *
 *  - **2400 particles, not 20,000.** Each particle costs about a dozen
 *    transcendental calls per frame; 900 measured at 0.21ms and 1500 at 0.30ms on
 *    this machine, so 2400 is roughly half a millisecond. 20,000 is a dropped frame.
 *  - **Hue biased toward a state colour.** The reference drifts freely through cyan
 *    → violet → magenta. Here that drift is retained but pulled most of the way
 *    toward the current state's colour, so LISTENING and SPEAKING are unmistakable
 *    while the surface still shimmers.
 *
 * No Android imports: all of this is unit-testable on the JVM.
 */
class SwarmMath(val count: Int = DEFAULT_COUNT) {

    // Per-particle invariants. Computed once — recomputing a Fibonacci sphere every
    // frame is pure waste, and allocating these arrays per frame is the single
    // easiest way to turn this into a garbage-collector benchmark.
    private val baseX = FloatArray(count)
    private val baseY = FloatArray(count)
    private val baseZ = FloatArray(count)
    private val frac = FloatArray(count)
    private val theta = FloatArray(count)
    private val edge = FloatArray(count)

    /** Smoothed output positions, in the reference's own units (radius ~60). */
    val x = FloatArray(count)
    val y = FloatArray(count)
    val z = FloatArray(count)

    val hue = FloatArray(count)
    val sat = FloatArray(count)
    val light = FloatArray(count)

    private var seeded = false

    init {
        for (i in 0 until count) {
            val f = (i + 0.5f) / count
            val y0 = 1f - 2f * f
            val r0 = sqrt((1f - y0 * y0).coerceAtLeast(0f))
            // Double for the golden-angle accumulation specifically: in Float,
            // `golden * i` loses enough precision by a few thousand particles to
            // put visible bands in what is supposed to be an even sphere.
            val th = (GOLDEN_ANGLE * i).toFloat()
            baseX[i] = r0 * cos(th)
            baseY[i] = y0
            baseZ[i] = r0 * sin(th)
            frac[i] = f
            theta[i] = th
            edge[i] = abs(y0)
        }
    }

    /**
     * Advance the swarm to elapsed time [t] seconds, over [dt] seconds of frame time.
     *
     * The reference lerps each particle toward its target by a fixed 0.1 per frame,
     * which is what gives the swarm its liquid trailing feel. That is reproduced
     * here, but as a delta-time rate rather than a per-frame constant, so a dropped
     * frame does not change how the orb moves.
     */
    fun step(t: Float, dt: Float, p: SwarmParams) {
        // Amplitude is applied to radius and turbulence rather than to a plain
        // scale: a swarm that merely gets bigger reads as a zoom, whereas a swarm
        // that gets bigger AND more agitated reads as a voice.
        val amp = p.amplitude.coerceIn(0f, 1f)
        val radius = p.radius * (1f + AMP_RADIUS * amp)
        val turb = (p.turb + AMP_TURB * amp).coerceAtMost(1.6f)
        val lightBoost = AMP_LIGHT * amp

        val tf = t * p.flow
        val breath = 1f + 0.06f * sin(tf * 1.2f) + 0.03f * sin(tf * 2.7f + 1.3f)
        val dist = turb * 0.22f
        val rotA = tf * p.spin
        val cA = cos(rotA)
        val sA = sin(rotA)
        val hueDrift = 0.05f

        // Seed the first frame directly; lerping in from an all-zero array makes the
        // orb visibly explode outward from a point every time it enters composition.
        val k = if (!seeded) 1f else (dt * LERP_RATE).coerceIn(0f, 1f)

        for (i in 0 until count) {
            val bx = baseX[i]
            val by = baseY[i]
            val bz = baseZ[i]
            val f = frac[i]
            val th = theta[i]

            val w1 = sin(3f * bx + tf * 1.7f + cos(2f * bz - tf)) * cos(2f * by - tf * 1.3f)
            val w2 = sin(4f * bz - tf * 1.1f + cos(3f * bx + tf * 0.7f)) * cos(3f * by + tf)
            val w3 = sin(2f * by + tf * 2.1f + cos(4f * bx - tf * 0.5f)) * cos(2f * bz + tf * 0.9f)

            val band = 0.5f + 0.5f * sin(f * TWO_PI * 3f + tf * 0.6f)
            val shellMix = band * p.shell
            val rMod = breath * (1f - shellMix * (0.55f + 0.35f * sin(th * 0.5f + tf)))

            val xr = bx * cA - bz * sA
            val zr = bx * sA + bz * cA

            val px = (xr + w1 * dist) * radius * rMod
            val py = (by + w2 * dist * 1.15f) * radius * rMod
            val pz = (zr + w3 * dist) * radius * rMod

            x[i] += (px - x[i]) * k
            y[i] += (py - y[i]) * k
            z[i] += (pz - z[i]) * k

            val swirl = 0.5f + 0.5f * sin(by * 2f + xr * 1.5f + tf * 1.4f + w1 * 2f)
            val designHue = 0.52f + p.hueShift * 0.28f * swirl + hueDrift * sin(tf * 0.5f + f * TWO_PI)

            hue[i] = lerpHue(designHue, p.stateHue, p.hueBias)
            sat[i] = (0.75f + 0.2f * swirl).coerceIn(0f, 1f)
            light[i] = (0.55f + 0.25f * w2 * turb + 0.12f * edge[i] + lightBoost).coerceIn(0.15f, 0.95f)
        }
        seeded = true
    }

    /** Drop the smoothing history, so the next [step] seeds instead of lerping. */
    fun rewind() {
        seeded = false
    }

    companion object {
        /**
         * Raised from 900, then again to 2400 once the projection was fixed and
         * the orb actually filled its box: on a device the earlier counts read as
         * a grainy point cloud rather than a lit sphere. Anything much beyond this needs
         * the golden-angle precision note in [SwarmMath.init] taken seriously.
         */
        const val DEFAULT_COUNT = 2400

        /** The reference's own golden angle, in Double for precision (see init). */
        private const val GOLDEN_ANGLE = 2.399963229728653

        private const val TWO_PI = 6.283185307179586f

        /** Reference lerp was 0.1/frame at 60fps; 6/s is the same feel, dt-correct. */
        private const val LERP_RATE = 6f

        // How much a full-scale signal grows the swarm.
        //
        // These were 0.22/0.55/0.18, which measured badly on a device: the loudest
        // possible frame reached 1.43x the resting one, so scaling the projection to
        // fit it left the orb drawing at ~60% of the space allotted to it whenever
        // nobody was talking — which is nearly all the time. Growth is now smaller
        // and the difference is made up in BRIGHTNESS, which costs no space at all.
        private const val AMP_RADIUS = 0.12f
        private const val AMP_TURB = 0.35f
        private const val AMP_LIGHT = 0.30f

        /**
         * The furthest a particle can travel from centre at full volume.
         *
         * A genuine bound, not an estimate — measured p99.9 reaches 0.96 of it — so
         * it is the right thing for bounds tests. It is the WRONG thing to scale the
         * projection by: see [restExtent].
         */
        fun maxExtent(p: SwarmParams): Float = extentAt(p, 1f)

        /**
         * The extent with no audio, which is what the projection should be scaled to.
         *
         * The orb is silent most of the time. Sizing it so that the loudest
         * conceivable frame fits exactly means the resting state — the state anyone
         * actually looks at — is drawn small, and no amount of increasing the
         * layout size fixes that, because the shrink is inside the projection.
         * Scaling to rest instead lets a shout overflow the box slightly, which is
         * the correct trade: the particles that spill are the dim outer ones.
         */
        fun restExtent(p: SwarmParams): Float = extentAt(p, 0f)

        /**
         * How much of the orb's half-size the RESTING swarm is drawn at.
         *
         * Lives here rather than in the renderer so the test that bounds the
         * full-volume spill is checking the number actually used to draw.
         */
        const val PROJECTION_FILL = 0.88f

        private fun extentAt(p: SwarmParams, amplitude: Float): Float {
            val radius = p.radius * (1f + AMP_RADIUS * amplitude)
            val breathMax = 1f + 0.06f + 0.03f
            val turbMax = (p.turb + AMP_TURB * amplitude).coerceAtMost(1.6f)
            // |base| <= 1, |w| <= 1, and py carries the 1.15 factor.
            return radius * breathMax * (1f + turbMax * 0.22f * 1.15f)
        }
    }
}

/**
 * The reference's five dials, plus what the phone adds: which state we are in and
 * how loud it is. Defaults are the reference's `PARAMS` verbatim.
 */
data class SwarmParams(
    val radius: Float = 60f,
    val flow: Float = 0.8f,
    val turb: Float = 0.45f,
    val shell: Float = 0.25f,
    val hueShift: Float = 0.35f,
    val spin: Float = 0.25f,
    /** Hue of the current state colour, 0..1. */
    val stateHue: Float = 0.52f,
    /** How far the iridescent drift is pulled toward [stateHue]. */
    val hueBias: Float = 0.65f,
    /** Perceptual audio level, 0..1. */
    val amplitude: Float = 0f,
)

/** HSL to packed ARGB, allocation-free, so it can run per particle per frame. */
fun hslToArgb(h: Float, s: Float, l: Float): Int {
    val hh = h - floor(h)
    val ss = s.coerceIn(0f, 1f)
    val ll = l.coerceIn(0f, 1f)
    if (ss <= 0f) {
        val v = (ll * 255f + 0.5f).toInt().coerceIn(0, 255)
        return (0xFF shl 24) or (v shl 16) or (v shl 8) or v
    }
    val q = if (ll < 0.5f) ll * (1f + ss) else ll + ss - ll * ss
    val p = 2f * ll - q
    val r = hueToChannel(p, q, hh + 1f / 3f)
    val g = hueToChannel(p, q, hh)
    val b = hueToChannel(p, q, hh - 1f / 3f)
    return (0xFF shl 24) or
        ((r * 255f + 0.5f).toInt().coerceIn(0, 255) shl 16) or
        ((g * 255f + 0.5f).toInt().coerceIn(0, 255) shl 8) or
        (b * 255f + 0.5f).toInt().coerceIn(0, 255)
}

private fun hueToChannel(p: Float, q: Float, tRaw: Float): Float {
    var t = tRaw
    if (t < 0f) t += 1f
    if (t > 1f) t -= 1f
    return when {
        t < 1f / 6f -> p + (q - p) * 6f * t
        t < 1f / 2f -> q
        t < 2f / 3f -> p + (q - p) * (2f / 3f - t) * 6f
        else -> p
    }
}

/** Hue of a packed ARGB colour, 0..1 — used to derive [SwarmParams.stateHue]. */
fun hueOfArgb(argb: Int): Float {
    val r = ((argb shr 16) and 0xFF) / 255f
    val g = ((argb shr 8) and 0xFF) / 255f
    val b = (argb and 0xFF) / 255f
    val max = maxOf(r, g, b)
    val min = minOf(r, g, b)
    val d = max - min
    if (d <= 0f) return 0f
    val h = when (max) {
        r -> ((g - b) / d + if (g < b) 6f else 0f) / 6f
        g -> ((b - r) / d + 2f) / 6f
        else -> ((r - g) / d + 4f) / 6f
    }
    return h - floor(h)
}
