package com.mythos.nodes.phone

import kotlin.math.abs
import kotlin.math.sqrt
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The swarm, checked for the things a screenshot cannot tell you: that no particle
 * escapes the projection the orb is scaled to, that the sphere is actually evenly
 * covered, that the palette lands on the state colour, and that a still frame is
 * genuinely still.
 */
class SwarmMathTest {

    private val params = SwarmParams(stateHue = 0.45f)

    @Test
    fun `every particle stays inside the extent the projection is scaled to`() {
        // At the real count, not a sample of it: the projection scale is derived
        // from maxExtent, so a particle past it is drawn outside the orb's box and
        // clips. Raising DEFAULT_COUNT must not be able to break that unnoticed.
        val swarm = SwarmMath(count = SwarmMath.DEFAULT_COUNT)
        val loud = params.copy(amplitude = 1f)
        val limit = SwarmMath.maxExtent(loud)
        var t = 0f
        repeat(240) {
            t += 1f / 60f
            swarm.step(t, 1f / 60f, loud)
        }
        for (i in 0 until swarm.count) {
            val d = sqrt(swarm.x[i] * swarm.x[i] + swarm.y[i] * swarm.y[i] + swarm.z[i] * swarm.z[i])
            // A particle beyond this is drawn outside the orb's box and clips.
            assertTrue(d <= limit, "particle $i reached $d, past the $limit extent")
        }
    }

    @Test
    fun `the first step seeds instead of lerping in from the origin`() {
        // Without seeding, every entry into composition would show the swarm
        // exploding outward from a single point.
        val swarm = SwarmMath(count = 120)
        swarm.step(0f, 1f / 60f, params)
        val mean = (0 until swarm.count).sumOf { i ->
            sqrt(
                (swarm.x[i] * swarm.x[i] + swarm.y[i] * swarm.y[i] + swarm.z[i] * swarm.z[i])
                    .toDouble()
            )
        } / swarm.count
        assertTrue(mean > params.radius * 0.5f, "swarm seeded collapsed at radius $mean")
    }

    @Test
    fun `a repeated frame at fixed time is identical, so reduced motion is still`() {
        val a = SwarmMath(count = 90)
        val b = SwarmMath(count = 90)
        a.step(7.3f, 1f / 60f, params)
        b.step(7.3f, 1f / 60f, params)
        for (i in 0 until a.count) {
            assertEquals(a.x[i], b.x[i], "particle $i is not deterministic in t")
            assertEquals(a.y[i], b.y[i])
            assertEquals(a.z[i], b.z[i])
        }
    }

    @Test
    fun `rewind makes the next step seed again`() {
        val swarm = SwarmMath(count = 60)
        swarm.step(0f, 1f / 60f, params)
        swarm.step(30f, 1f / 60f, params) // smoothed: barely moves in one frame
        val smoothed = swarm.x[0]
        swarm.rewind()
        swarm.step(30f, 1f / 60f, params) // seeded: lands on target immediately
        assertTrue(
            abs(swarm.x[0] - smoothed) > 1e-4f,
            "rewind did not drop the smoothing history",
        )
    }

    @Test
    fun `the sphere is covered evenly rather than banded`() {
        // The golden-angle term is accumulated in Double for exactly this reason:
        // in Float it loses enough precision to leave visible bands.
        val swarm = SwarmMath(count = SwarmMath.DEFAULT_COUNT)
        swarm.step(0f, 1f / 60f, params)
        val octants = IntArray(8)
        for (i in 0 until swarm.count) {
            var idx = 0
            if (swarm.x[i] >= 0) idx = idx or 1
            if (swarm.y[i] >= 0) idx = idx or 2
            if (swarm.z[i] >= 0) idx = idx or 4
            octants[idx]++
        }
        val expected = swarm.count / 8
        octants.forEachIndexed { i, n ->
            assertTrue(
                abs(n - expected) < expected * 0.35,
                "octant $i holds $n particles, expected about $expected",
            )
        }
    }

    @Test
    fun `hue bias pulls the palette onto the state colour`() {
        val swarm = SwarmMath(count = 200)
        swarm.step(3f, 1f / 60f, params.copy(hueBias = 1f))
        for (i in 0 until swarm.count) {
            assertTrue(
                abs(swarm.hue[i] - params.stateHue) < 1e-4f,
                "full bias left particle $i at hue ${swarm.hue[i]}",
            )
        }
    }

    @Test
    fun `no bias leaves the reference palette drifting`() {
        val swarm = SwarmMath(count = 200)
        swarm.step(3f, 1f / 60f, params.copy(hueBias = 0f))
        val min = (0 until swarm.count).minOf { swarm.hue[it] }
        val max = (0 until swarm.count).maxOf { swarm.hue[it] }
        assertTrue(max - min > 0.02f, "the iridescent drift collapsed to one hue")
    }

    @Test
    fun `saturation and lightness stay renderable`() {
        val swarm = SwarmMath(count = 400)
        swarm.step(2f, 1f / 60f, params.copy(amplitude = 1f, turb = 1.2f))
        for (i in 0 until swarm.count) {
            assertTrue(swarm.sat[i] in 0f..1f, "sat out of range: ${swarm.sat[i]}")
            // Never fully black and never blown out: both ends stop reading as
            // particles once everything is blended additively.
            assertTrue(swarm.light[i] in 0.15f..0.95f, "light out of range: ${swarm.light[i]}")
        }
    }

    @Test
    fun `louder audio makes the swarm larger and busier`() {
        val quiet = SwarmMath(count = 200)
        val loud = SwarmMath(count = 200)
        quiet.step(4f, 1f / 60f, params.copy(amplitude = 0f))
        loud.step(4f, 1f / 60f, params.copy(amplitude = 1f))
        val quietMean = (0 until 200).sumOf { i -> radiusOf(quiet, i).toDouble() } / 200
        val loudMean = (0 until 200).sumOf { i -> radiusOf(loud, i).toDouble() } / 200
        assertTrue(loudMean > quietMean * 1.1, "loud=$loudMean vs quiet=$quietMean")
    }

    private fun radiusOf(s: SwarmMath, i: Int) =
        sqrt(s.x[i] * s.x[i] + s.y[i] * s.y[i] + s.z[i] * s.z[i])

    @Test
    fun `hsl round-trips through the packed colour`() {
        for (h in listOf(0f, 0.15f, 0.33f, 0.52f, 0.78f, 0.99f)) {
            val argb = hslToArgb(h, 0.85f, 0.5f)
            assertEquals(0xFF, (argb ushr 24) and 0xFF, "colour must be opaque")
            assertTrue(abs(hueOfArgb(argb) - h) < 0.01f, "hue $h came back as ${hueOfArgb(argb)}")
        }
    }

    @Test
    fun `grey has no hue and does not divide by zero`() {
        val grey = hslToArgb(0.4f, 0f, 0.5f)
        assertEquals(0f, hueOfArgb(grey))
        assertEquals((grey shr 16) and 0xFF, grey and 0xFF)
    }

    @Test
    fun `the theme's own state colours survive the round trip`() {
        // These are the four the orb actually uses; if any of them lost its hue the
        // swarm would render grey for that state.
        mapOf(
            "accent" to 0xFF4FD8FF.toInt(),
            "listening" to 0xFF43E5A0.toInt(),
            "speaking" to 0xFFF5D020.toInt(),
            "thinking" to 0xFFA78BFA.toInt(),
        ).forEach { (name, argb) ->
            val hue = hueOfArgb(argb)
            assertTrue(hue > 0f && hue < 1f, "$name produced a degenerate hue $hue")
            val rebuilt = hslToArgb(hue, 0.8f, 0.55f)
            assertTrue(abs(hueOfArgb(rebuilt) - hue) < 0.01f, "$name did not round-trip")
        }
    }
}
