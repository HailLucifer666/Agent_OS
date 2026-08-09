package com.mythos.nodes.phone

/**
 * The pure state machine behind the orb's tap-to-toggle auto mode.
 *
 * Extracted out of [VoiceNodeService] so it is unit-testable with no Android
 * Service, socket or coroutine involved — the service owns the side effects
 * (starting the mic, sending `stop`, driving the phase), this owns only the
 * decision of when to make them.
 *
 * Two rules are load-bearing and both come from proven failure modes in this
 * repo's history, not from design taste:
 *  - Re-arming needs BOTH [onTurnComplete] and [onPlaybackFinished] before it
 *    fires — whichever lands second is the one that actually re-arms.
 *    Re-arming on turn-complete alone reopens the mic while MYTHOS is still
 *    speaking, and the phone transcribes its own TTS as the operator.
 *  - Consecutive no-speech turns are capped: a phone left in a pocket must
 *    not hold the mic open indefinitely against silence.
 */
class AutoModeController(private val maxConsecutiveNoSpeech: Int = 3) {

    /** What the caller must do in response to a transition. */
    enum class Command { START_LISTENING, HARD_STOP, NONE }

    var autoMode: Boolean = false
        private set

    private var noSpeechStreak = 0
    private var awaitingTurnComplete = false
    private var awaitingPlaybackFinish = false

    /** The operator tapped the orb. */
    fun onToggle(): Command =
        if (autoMode) {
            reset()
            Command.HARD_STOP
        } else {
            autoMode = true
            armWait()
            Command.START_LISTENING
        }

    /** MYTHOS's reply finished arriving (`done` / `live-turn-complete`). */
    fun onTurnComplete(): Command {
        if (!autoMode) return Command.NONE
        awaitingTurnComplete = false
        return maybeRearm()
    }

    /** Playback actually stopped (the player's `playing` flipped to false). */
    fun onPlaybackFinished(): Command {
        if (!autoMode) return Command.NONE
        awaitingPlaybackFinish = false
        return maybeRearm()
    }

    /** Playback started, so the next finish is one this turn is waiting on. */
    fun onPlaybackStarted() {
        awaitingPlaybackFinish = true
    }

    /** A real utterance came back — the phone is not sitting in silence. */
    fun onSpeechDetected() {
        noSpeechStreak = 0
    }

    /** The recording came back empty (no speech, or too short to use). */
    fun onNoSpeech(): Command {
        if (!autoMode) return Command.NONE
        noSpeechStreak++
        if (noSpeechStreak >= maxConsecutiveNoSpeech) {
            autoMode = false
            return Command.NONE
        }
        return Command.START_LISTENING
    }

    private fun maybeRearm(): Command {
        if (awaitingTurnComplete || awaitingPlaybackFinish) return Command.NONE
        if (noSpeechStreak >= maxConsecutiveNoSpeech) {
            autoMode = false
            return Command.NONE
        }
        armWait()
        return Command.START_LISTENING
    }

    private fun armWait() {
        awaitingTurnComplete = true
        awaitingPlaybackFinish = false
    }

    private fun reset() {
        autoMode = false
        noSpeechStreak = 0
        awaitingTurnComplete = false
        awaitingPlaybackFinish = false
    }
}
