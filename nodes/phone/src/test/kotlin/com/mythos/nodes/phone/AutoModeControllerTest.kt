package com.mythos.nodes.phone

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The pure state machine behind the orb's tap-to-toggle auto mode, extracted
 * from [VoiceNodeService] so it is testable without an Android Service.
 *
 * Fix 5: push-to-talk (press-and-hold) became tap-to-toggle with auto mode —
 * one tap arms continuous listening, a second tap while armed is a hard stop.
 * Two sequencing rules are pinned here because both are proven failure modes
 * in this repo's history:
 *  - re-arming the mic must wait for BOTH the turn to complete AND playback
 *    to actually finish. Re-arming on turn-complete alone reopens the mic
 *    while MYTHOS is still speaking, and the phone transcribes its own TTS
 *    as the operator (see project memory: "TTS plays into the Live mic").
 *  - a phone left in a pocket must not hold the mic open forever on silence,
 *    so consecutive no-speech turns are capped.
 */
class AutoModeControllerTest {

    @Test
    fun `a tap while idle arms auto mode and starts listening`() {
        val c = AutoModeController()
        assertFalse(c.autoMode)
        assertEquals(AutoModeController.Command.START_LISTENING, c.onToggle())
        assertTrue(c.autoMode)
    }

    @Test
    fun `a second tap while armed is a hard stop, not another start`() {
        val c = AutoModeController()
        c.onToggle()
        assertEquals(AutoModeController.Command.HARD_STOP, c.onToggle())
        assertFalse(c.autoMode)
    }

    @Test
    fun `turn-complete alone does not re-arm before playback finishes`() {
        val c = AutoModeController()
        c.onToggle()
        c.onPlaybackStarted()
        assertEquals(AutoModeController.Command.NONE, c.onTurnComplete())
        assertTrue(c.autoMode, "must still be armed, just waiting on playback")
    }

    @Test
    fun `playback finishing before turn-complete does not re-arm early either`() {
        val c = AutoModeController()
        c.onToggle()
        c.onPlaybackStarted()
        assertEquals(AutoModeController.Command.NONE, c.onPlaybackFinished())
        assertEquals(AutoModeController.Command.START_LISTENING, c.onTurnComplete())
    }

    @Test
    fun `re-arms only once both turn-complete and playback-finished have landed`() {
        val c = AutoModeController()
        c.onToggle()
        c.onPlaybackStarted()
        assertEquals(AutoModeController.Command.NONE, c.onTurnComplete())
        assertEquals(AutoModeController.Command.START_LISTENING, c.onPlaybackFinished())
    }

    @Test
    fun `a turn with no audio at all still re-arms on turn-complete`() {
        val c = AutoModeController()
        c.onToggle()
        // No onPlaybackStarted() call: a text-only reply never plays anything.
        assertEquals(AutoModeController.Command.START_LISTENING, c.onTurnComplete())
    }

    @Test
    fun `not in auto mode, turn-complete and playback-finished are no-ops`() {
        val c = AutoModeController()
        assertEquals(AutoModeController.Command.NONE, c.onTurnComplete())
        assertEquals(AutoModeController.Command.NONE, c.onPlaybackFinished())
    }

    @Test
    fun `hard stop while a turn is pending clears the wait so a later turn cannot re-arm it`() {
        val c = AutoModeController()
        c.onToggle()
        c.onPlaybackStarted()
        c.onToggle() // hard stop
        assertEquals(AutoModeController.Command.NONE, c.onPlaybackFinished())
    }

    @Test
    fun `three consecutive no-speech turns drop out of auto mode`() {
        val c = AutoModeController()
        c.onToggle()
        assertEquals(AutoModeController.Command.START_LISTENING, c.onNoSpeech())
        assertTrue(c.autoMode)
        assertEquals(AutoModeController.Command.START_LISTENING, c.onNoSpeech())
        assertTrue(c.autoMode)
        // Third strike drops out rather than re-arming a fourth time.
        assertEquals(AutoModeController.Command.NONE, c.onNoSpeech())
        assertFalse(c.autoMode)
    }

    @Test
    fun `real speech resets the no-speech streak`() {
        val c = AutoModeController()
        c.onToggle()
        c.onNoSpeech()
        c.onNoSpeech()
        c.onSpeechDetected()
        // Streak reset: two more no-speech turns should not trip the cap yet.
        assertEquals(AutoModeController.Command.START_LISTENING, c.onNoSpeech())
        assertTrue(c.autoMode)
        assertEquals(AutoModeController.Command.START_LISTENING, c.onNoSpeech())
        assertTrue(c.autoMode)
    }

    @Test
    fun `the cap is not in effect while not in auto mode`() {
        val c = AutoModeController()
        assertEquals(AutoModeController.Command.NONE, c.onNoSpeech())
        assertFalse(c.autoMode)
    }
}
