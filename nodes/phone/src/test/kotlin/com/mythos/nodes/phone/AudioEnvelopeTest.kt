package com.mythos.nodes.phone

import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The amplitude pipeline, tested where it is testable.
 *
 * These are the parts that decide whether the orb is honest: whether a level is
 * measured correctly, whether it maps to something an eye reads as loudness, and —
 * most importantly — whether the level shown belongs to the audio currently coming
 * out of the speaker rather than to audio still sitting in the buffer.
 */
class AudioEnvelopeTest {

    private fun pcmOf(vararg samples: Int): ByteArray {
        val out = ByteArray(samples.size * 2)
        samples.forEachIndexed { i, s ->
            out[i * 2] = (s and 0xFF).toByte()
            out[i * 2 + 1] = ((s shr 8) and 0xFF).toByte()
        }
        return out
    }

    @Test
    fun `silence measures zero`() {
        assertEquals(0f, rms16le(pcmOf(0, 0, 0, 0)))
    }

    @Test
    fun `a full-scale square measures one`() {
        val pcm = pcmOf(32767, -32768, 32767, -32768)
        assertTrue(abs(rms16le(pcm) - 1f) < 0.001f, "expected ~1.0, got ${rms16le(pcm)}")
    }

    @Test
    fun `negative samples are not read as huge positives`() {
        // The low byte of a negative sample has its high bit set. Combining the two
        // bytes without masking it back to 0..255 turns quiet audio into full scale,
        // which would peg the orb permanently.
        val quiet = pcmOf(-256, -256, -256, -256)
        assertTrue(rms16le(quiet) < 0.02f, "quiet negative audio measured ${rms16le(quiet)}")
    }

    @Test
    fun `only the bytes actually read are measured`() {
        // AudioRecord fills part of the buffer; the stale tail must not be averaged
        // in, or every transient is diluted by whatever the previous read left.
        val buffer = ByteArray(200)
        val loud = pcmOf(20000, -20000, 20000, -20000)
        loud.copyInto(buffer)
        val measuredHead = rms16le(buffer, loud.size)
        val measuredAll = rms16le(buffer)
        assertTrue(measuredHead > 0.5f, "head-only read measured $measuredHead")
        assertTrue(measuredAll < measuredHead / 2f, "stale tail was not excluded")
    }

    @Test
    fun `speech-level audio maps to a visible amount of motion`() {
        // The whole reason perceptual() exists: ordinary speech sits around 0.05
        // RMS, and a linear map would move the orb by five percent, which reads as
        // a broken feature rather than a quiet one.
        val level = perceptual(0.05f)
        assertTrue(level > 0.4f, "speech-level RMS mapped to only $level")
        assertTrue(level < 1f)
    }

    @Test
    fun `a silent room maps to exact zero`() {
        assertEquals(0f, perceptual(0f))
        assertEquals(0f, perceptual(0.0005f), "below the noise floor must rest, not shimmer")
    }

    @Test
    fun `perceptual mapping is monotonic`() {
        var previous = -1f
        for (rms in listOf(0.002f, 0.01f, 0.05f, 0.2f, 0.6f, 1f)) {
            val level = perceptual(rms)
            assertTrue(level >= previous, "level went backwards at rms=$rms")
            previous = level
        }
        assertEquals(1f, perceptual(1f))
    }

    @Test
    fun `the envelope rises faster than it falls`() {
        val dt = 1f / 60f
        val rising = Envelope()
        repeat(3) { rising.step(1f, dt) }

        val falling = Envelope()
        repeat(60) { falling.step(1f, dt) }
        val peak = falling.value
        repeat(3) { falling.step(0f, dt) }
        val dropped = peak - falling.value

        assertTrue(
            rising.value > dropped,
            "attack gained ${rising.value} while release only lost $dropped — " +
                "symmetric smoothing makes the orb flicker between syllables",
        )
    }

    @Test
    fun `the envelope does not overshoot its target`() {
        val e = Envelope()
        // A dropped frame hands over a large dt; k must clamp rather than fly past.
        e.step(1f, 5f)
        assertTrue(e.value <= 1f, "overshot to ${e.value}")
        assertEquals(1f, e.value)
    }

    @Test
    fun `playback level is read by frame position, not by write order`() {
        val ring = PlaybackRms()
        ring.add(0, 1000, 0.1f)
        ring.add(1000, 2000, 0.9f)

        assertEquals(0.1f, ring.levelAt(500))
        assertEquals(0.9f, ring.levelAt(1500))
        // The head has not reached the second frame yet: showing 0.9 here is
        // exactly the bug this class exists to prevent.
        assertEquals(0.1f, ring.levelAt(999))
    }

    @Test
    fun `an unplayed position reads as silence`() {
        val ring = PlaybackRms()
        ring.add(0, 100, 0.8f)
        assertEquals(0f, ring.levelAt(500), "past the queue must rest")
    }

    @Test
    fun `reset clears the ring, because flush resets the playback head`() {
        val ring = PlaybackRms()
        ring.add(0, 1000, 0.9f)
        ring.reset()
        assertEquals(0, ring.size)
        // After a barge-in the head is back at zero; without the reset this would
        // still answer 0.9 and the orb would keep pulsing to a cancelled sentence.
        assertEquals(0f, ring.levelAt(0))
    }

    @Test
    fun `the ring drops the oldest entries rather than growing`() {
        val ring = PlaybackRms(capacity = 4)
        for (i in 0 until 10) ring.add(i * 10L, (i + 1) * 10L, i / 10f)
        assertEquals(4, ring.size)
        assertEquals(0f, ring.levelAt(5), "an evicted range must not still answer")
        assertEquals(0.9f, ring.levelAt(95))
    }

    @Test
    fun `the synthetic envelope stays in range and actually varies`() {
        var min = Float.MAX_VALUE
        var max = -Float.MAX_VALUE
        var t = 0f
        while (t < 5f) {
            val v = syntheticSpeechEnvelope(t)
            assertTrue(v in 0f..1f, "out of range at t=$t: $v")
            if (v < min) min = v
            if (v > max) max = v
            t += 1f / 60f
        }
        assertTrue(max - min > 0.5f, "synthetic speech barely moved (span ${max - min})")
    }

    @Test
    fun `the synthetic envelope is deterministic`() {
        // Any randomness here would make the orb jitter between frames rather than
        // pulse, because this is evaluated fresh every frame from t alone.
        assertEquals(syntheticSpeechEnvelope(2.5f), syntheticSpeechEnvelope(2.5f))
    }

    @Test
    fun `real output wins over the synthetic fallback`() {
        OrbAudio.reset()
        OrbAudio.outputProbe = { 0.42f }
        try {
            assertEquals(0.42f, OrbAudio.sampleOutput(1_000L, 1f, speaking = true))
        } finally {
            OrbAudio.outputProbe = null
        }
    }

    @Test
    fun `a silent gap inside a live reply does not trigger the synthetic envelope`() {
        OrbAudio.reset()
        OrbAudio.outputProbe = { 0f } // playing, but between words
        try {
            assertEquals(0f, OrbAudio.sampleOutput(1_000L, 1f, speaking = true))
            // Live stops reporting; within the grace window this is still a gap in a
            // real reply, not the legacy path starting.
            OrbAudio.outputProbe = { -1f }
            assertEquals(0f, OrbAudio.sampleOutput(1_100L, 1f, speaking = true))
        } finally {
            OrbAudio.outputProbe = null
        }
    }

    @Test
    fun `the legacy path falls through to the synthetic envelope`() {
        OrbAudio.reset()
        OrbAudio.outputProbe = { -1f }
        try {
            // Well past the grace window with no Live audio at all: this reply is
            // coming through ExoPlayer, which exposes no PCM to measure.
            val level = OrbAudio.sampleOutput(60_000L, 1.4f, speaking = true)
            assertEquals(syntheticSpeechEnvelope(1.4f), level)
        } finally {
            OrbAudio.outputProbe = null
        }
    }

    @Test
    fun `nothing pulses when the node is not speaking`() {
        OrbAudio.reset()
        OrbAudio.outputProbe = { -1f }
        try {
            assertEquals(0f, OrbAudio.sampleOutput(60_000L, 1.4f, speaking = false))
        } finally {
            OrbAudio.outputProbe = null
        }
    }

    /**
     * Distance between two hues ON THE CIRCLE. Comparing them linearly is a trap:
     * a midpoint that lands a hair below zero wraps to 0.99999999, which is the
     * correct answer and looks like a maximal error to a subtraction.
     */
    private fun assertHue(expected: Float, actual: Float, message: String) {
        val d = abs(expected - actual)
        val circular = minOf(d, 1f - d)
        assertTrue(circular < 1e-5f, "$message: expected ~$expected, got $actual")
    }

    @Test
    fun `hue interpolation takes the short way round the circle`() {
        // Cyan (0.52) to magenta (0.88) the long way sweeps through green, which
        // would make a state change look like a rainbow wipe.
        assertHue(0f, lerpHue(0.95f, 0.05f, 0.5f), "wrapping upward past 1")
        assertHue(0f, lerpHue(0.05f, 0.95f, 0.5f), "wrapping downward past 0")
        assertHue(0.3f, lerpHue(0.2f, 0.4f, 0.5f), "plain midpoint")
        assertHue(0.2f, lerpHue(0.2f, 0.4f, 0f), "no bias returns the source hue")
        assertHue(0.4f, lerpHue(0.2f, 0.4f, 1f), "full bias returns the state hue")
    }

    @Test
    fun `interpolation never leaves the unit circle`() {
        // SwarmOrb bins hues by their distance from the state hue; a value outside
        // 0..1 would land outside every bin and drop those particles.
        for (from in listOf(0f, 0.05f, 0.5f, 0.95f, 0.999f)) {
            for (to in listOf(0f, 0.05f, 0.5f, 0.95f, 0.999f)) {
                for (amount in listOf(0f, 0.25f, 0.5f, 0.65f, 1f)) {
                    val h = lerpHue(from, to, amount)
                    assertTrue(h >= 0f && h < 1f, "lerpHue($from,$to,$amount) = $h")
                }
            }
        }
    }
}
