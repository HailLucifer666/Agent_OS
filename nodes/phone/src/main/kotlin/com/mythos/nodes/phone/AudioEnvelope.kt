package com.mythos.nodes.phone

import kotlin.math.abs
import kotlin.math.log10
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * The amplitude the orb reacts to, and everything needed to measure it honestly.
 *
 * Deliberately free of Android imports so the maths is unit-testable on the JVM —
 * the only thing that ever needed a device was the audio itself, not the analysis.
 *
 * THE THREE THINGS THAT MAKE THIS HARDER THAN "take the RMS":
 *
 *  1. RMS is not loudness. Ordinary speech sits around 0.02–0.08 RMS, so a linear
 *     map to a radius leaves the orb visibly dead and reads as a broken feature.
 *     [perceptual] converts to dBFS and maps against a noise floor instead.
 *  2. Audio arrives at one rate and frames render at another. Smoothing therefore
 *     belongs in [Envelope], stepped per *frame* with a real delta-time — never
 *     per audio chunk, or the orb's feel changes with the buffer size.
 *  3. Written audio is not yet audible audio. AudioTrack accepts a write long
 *     before the speaker plays it, so an amplitude sampled at write time leads the
 *     voice. [PlaybackRms] stores each measurement against the frame range it
 *     covers, and the UI asks what is playing *now*.
 */

/** Enough of a signal to be a sound rather than a room. Below this the orb rests. */
private const val NOISE_FLOOR_DB = -55f

/** RMS floor guarding log10(0), one step under the noise floor's amplitude. */
private const val RMS_EPSILON = 1e-5f

private const val INT16_SCALE = 32768f

/**
 * RMS of signed 16-bit little-endian PCM, normalised to 0..1 against full scale.
 *
 * [length] is honoured rather than [pcm].size because AudioRecord.read fills only
 * part of the buffer — measuring the whole array would average in the stale tail
 * of the previous read and mute every transient.
 */
fun rms16le(pcm: ByteArray, length: Int = pcm.size): Float {
    val usable = min(length, pcm.size) and 1.inv() // whole samples only
    if (usable <= 0) return 0f
    var sum = 0.0
    var i = 0
    while (i < usable) {
        // Kotlin's Byte is signed; the low byte must be masked back to 0..255
        // before it is combined, or every negative low byte corrupts the sample.
        val sample = ((pcm[i + 1].toInt() shl 8) or (pcm[i].toInt() and 0xFF)).toShort().toInt()
        val norm = sample / INT16_SCALE
        sum += (norm * norm).toDouble()
        i += 2
    }
    return sqrt(sum / (usable / 2)).toFloat().coerceIn(0f, 1f)
}

/**
 * Map an RMS to something an eye reads as loudness: dBFS against a noise floor,
 * gated so a silent room produces exact zero rather than a permanent shimmer.
 */
fun perceptual(rms: Float): Float {
    if (rms <= RMS_EPSILON) return 0f
    val db = 20f * log10(rms)
    if (db <= NOISE_FLOOR_DB) return 0f
    return ((db - NOISE_FLOOR_DB) / -NOISE_FLOOR_DB).coerceIn(0f, 1f)
}

/**
 * Asymmetric smoothing: rise almost immediately, fall slowly.
 *
 * Symmetric smoothing is the classic mistake here — make it fast enough to catch a
 * syllable and the orb flickers between them; make it slow enough to be calm and it
 * lags the voice. Speech needs a quick attack and a lazy release, which is also
 * exactly how a VU meter has always behaved.
 */
class Envelope(
    private val attackSeconds: Float = 0.035f,
    private val releaseSeconds: Float = 0.28f,
) {
    var value: Float = 0f
        private set

    /** Advance toward [target] over [dtSeconds] of real time. */
    fun step(target: Float, dtSeconds: Float): Float {
        val tau = if (target > value) attackSeconds else releaseSeconds
        // dt/tau rather than a fixed constant, so a dropped frame does not make the
        // envelope quietly slower than it was designed to be.
        val k = if (tau <= 0f) 1f else (dtSeconds / tau).coerceIn(0f, 1f)
        value += (target - value) * k
        return value
    }

    fun reset() {
        value = 0f
    }
}

/**
 * A ring of "this much level, over these output frames", so the orb can show what
 * the speaker is playing rather than what the socket has written.
 *
 * [reset] exists for one specific reason: AudioTrack.flush() sets the playback head
 * back to zero. A barge-in that flushes without resetting this leaves every stored
 * frame range in the future, and the orb either freezes or reads a level from a
 * sentence that was already cancelled.
 */
class PlaybackRms(private val capacity: Int = 256) {
    private val startFrame = LongArray(capacity)
    private val endFrame = LongArray(capacity)
    private val level = FloatArray(capacity)
    private var writeIndex = 0
    private var stored = 0

    @Synchronized
    fun add(start: Long, end: Long, rms: Float) {
        if (end <= start) return
        startFrame[writeIndex] = start
        endFrame[writeIndex] = end
        level[writeIndex] = rms
        writeIndex = (writeIndex + 1) % capacity
        if (stored < capacity) stored++
    }

    /** The level covering [frame], or 0 when nothing queued covers it. */
    @Synchronized
    fun levelAt(frame: Long): Float {
        for (n in 0 until stored) {
            // Newest first: during a long reply the answer is nearly always in the
            // last few entries, and an unmatched frame is the cheap case anyway.
            val i = Math.floorMod(writeIndex - 1 - n, capacity)
            if (frame >= startFrame[i] && frame < endFrame[i]) return level[i]
        }
        return 0f
    }

    @Synchronized
    fun reset() {
        writeIndex = 0
        stored = 0
    }

    @get:Synchronized
    val size: Int get() = stored
}

/**
 * A speech-shaped envelope for the one path that cannot be measured.
 *
 * `speech-chunk` replies play through ExoPlayer, which decodes inside itself and
 * exposes no PCM — so on that path this is what the orb moves to. It is NOT the
 * voice. It is a syllable rate, a phrase contour and a little irregularity,
 * multiplied together because that is what makes a flat oscillation stop looking
 * like a metronome. Deterministic in [t] so it never jitters between frames.
 */
fun syntheticSpeechEnvelope(t: Float): Float {
    val syllable = 0.5f + 0.5f * sin(t * TWO_PI * 3.6f)
    val phrase = 0.62f + 0.38f * sin(t * TWO_PI * 0.43f + 1.1f)
    val jitter = 0.86f + 0.14f * sin(t * TWO_PI * 11.7f + 0.4f)
    return (syllable * phrase * jitter).coerceIn(0f, 1f)
}

private const val TWO_PI = 6.283185307179586f

/**
 * The one place the orb reads audio from, so the UI never needs a handle on the
 * service, the recorder or the player — matching how [VoiceNodeService] already
 * publishes its state through a companion object.
 */
object OrbAudio {

    /** Perceptual mic level, published per 20ms read while the mic is open. */
    @Volatile
    var inputLevel: Float = 0f
        private set

    /**
     * Installed by [LivePcmPlayer]. Returns the perceptual level currently audible,
     * or a NEGATIVE value when Live is not playing at all — which is how "a silent
     * gap inside a reply" stays distinguishable from "this path is not in use".
     * Collapsing those two into 0f is what makes a synthetic envelope fight a real
     * one.
     */
    @Volatile
    var outputProbe: (() -> Float)? = null

    private const val REAL_AUDIO_GRACE_MS = 300L

    @Volatile
    private var lastRealOutputMs = 0L

    fun submitInput(rms: Float) {
        inputLevel = perceptual(rms)
    }

    /**
     * What the orb should show for output right now.
     *
     * [speaking] is the service's own phase, not a guess from the audio: a reply
     * that is genuinely between words must not fall through to the synthetic
     * envelope, or a Live turn shows two envelopes beating against each other.
     */
    fun sampleOutput(nowMs: Long, tSeconds: Float, speaking: Boolean): Float {
        val real = outputProbe?.invoke() ?: -1f
        if (real >= 0f) {
            lastRealOutputMs = nowMs
            return real
        }
        if (!speaking) return 0f
        if (nowMs - lastRealOutputMs < REAL_AUDIO_GRACE_MS) return 0f
        return syntheticSpeechEnvelope(tSeconds)
    }

    /** Back to rest: a turn ended, the socket dropped, or the service is going away. */
    fun reset() {
        inputLevel = 0f
        lastRealOutputMs = 0L
    }
}

/** Shortest-path interpolation on the hue circle, so cyan→violet never sweeps green. */
fun lerpHue(from: Float, to: Float, amount: Float): Float {
    val a = wrap01(from)
    val b = wrap01(to)
    var d = b - a
    if (abs(d) > 0.5f) d -= kotlin.math.sign(d)
    return wrap01(a + d * amount)
}

/**
 * Wrap into [0, 1) — and mean it.
 *
 * The naive `v - floor(v)` returns exactly 1.0 for a value a hair below zero: at
 * that magnitude `1f + -1e-8f` rounds to `1f`. A hue of 1.0 is out of contract for
 * everything downstream that bins or indexes on it, and it only shows up for
 * specific interpolation midpoints — the kind of edge that survives every
 * eyeball test and then produces one stray wrong-coloured particle.
 */
private fun wrap01(v: Float): Float {
    val w = v - kotlin.math.floor(v)
    return if (w >= 1f || w < 0f) 0f else w
}
