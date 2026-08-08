package com.mythos.nodes.phone

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The suppression rules that decide whether a wake detection is allowed to become
 * a report.
 *
 * Worth testing separately from any detector because it is the part that must hold
 * whatever model the operator supplies, and the only part testable with no audio,
 * no device and no model. Both rules exist because of failures this project has
 * already had:
 *
 *  - **Own playback.** A phone that hears its own TTS transcribes MYTHOS as the
 *    operator and answers itself. The HUD carries five separate guards for the
 *    same reason.
 *  - **Retrigger.** One spoken phrase produces detections across several
 *    consecutive frames; each would otherwise become its own arbitration request,
 *    and the later verdicts would land after the winner had begun listening —
 *    suppressing the device mid-utterance.
 *
 * Time is injected rather than slept, so these are deterministic: a test that
 * sleeps 300ms to check a 300ms window is a test that fails on a loaded machine.
 */
class WakeWordGateTest {

    /** A clock the test advances by hand. */
    private class Clock(var now: Long = 10_000L) {
        fun advance(ms: Long) { now += ms }
    }

    private fun gate(clock: Clock, speaking: () -> Boolean = { false }) =
        WakeWordGate(isSpeaking = speaking, nowMs = { clock.now })

    @Test
    fun `an idle node allows a detection`() {
        val clock = Clock()
        val g = gate(clock)
        assertNull(g.rejectionReason())
        assertTrue(g.allow())
    }

    @Test
    fun `a detection while speaking is rejected as own playback`() {
        val clock = Clock()
        val g = gate(clock, speaking = { true })
        assertEquals("own playback", g.rejectionReason())
        assertFalse(g.allow())
    }

    @Test
    fun `the tail keeps suppressing after playback stops, then releases`() {
        val clock = Clock()
        var speaking = true
        val g = gate(clock) { speaking }

        g.notePlaying(true)
        assertEquals("own playback", g.rejectionReason())

        // Playback ends. The audio buffer drains after isPlaying flips and a small
        // room reverberates, so the phrase is still MYTHOS's voice for a moment.
        speaking = false
        g.notePlaying(false)
        clock.advance(WakeWordGate.PLAYBACK_TAIL_MS - 50)
        assertEquals("playback tail", g.rejectionReason())

        clock.advance(100) // now past the tail
        assertNull(g.rejectionReason())
    }

    @Test
    fun `the tail is measured from the END of playback, not its start`() {
        val clock = Clock()
        var speaking = true
        val g = gate(clock) { speaking }

        g.notePlaying(true)
        // A long reply: if the tail were measured from when playback STARTED, it
        // would have expired long before the reply finished, and the last sentence
        // out of the speaker could trigger the node.
        clock.advance(30_000)
        speaking = false
        g.notePlaying(false)
        assertEquals("playback tail", g.rejectionReason())
    }

    @Test
    fun `a second detection inside the retrigger window is dropped`() {
        val clock = Clock()
        val g = gate(clock)

        assertTrue(g.allow(), "first detection of a phrase must pass")
        assertEquals("retrigger", g.rejectionReason())
        assertFalse(g.allow())

        clock.advance(WakeWordGate.RETRIGGER_MS - 1)
        assertEquals("retrigger", g.rejectionReason())

        clock.advance(2)
        assertNull(g.rejectionReason(), "a genuinely new phrase must get through")
        assertTrue(g.allow())
    }

    @Test
    fun `a rejected detection does not start the retrigger window`() {
        val clock = Clock()
        var speaking = true
        val g = gate(clock) { speaking }

        assertFalse(g.allow(), "suppressed by playback")
        speaking = false
        g.notePlaying(false)
        clock.advance(WakeWordGate.PLAYBACK_TAIL_MS + 10)

        // The real phrase arrives right after MYTHOS stops talking — the most
        // ordinary case there is (the operator interrupting the tail end of a
        // reply). If a *rejected* detection had armed the retrigger window, this
        // one would be swallowed and the node would look deaf exactly when the
        // operator was most likely to speak.
        assertNull(g.rejectionReason())
        assertTrue(g.allow())
    }
}
