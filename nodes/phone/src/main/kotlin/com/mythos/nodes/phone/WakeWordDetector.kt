package com.mythos.nodes.phone

import java.io.File

/**
 * The wake-word detector seam.
 *
 * NO MODEL SHIPS IN THIS APK, deliberately, and that is a licensing decision as
 * much as a design one. MYTHOS is sold, and wake-word models are the part of this
 * stack whose terms most often forbid that: the HUD's own openWakeWord weights are
 * CC BY-NC-SA 4.0 (non-commercial) while its code is Apache-2.0, and several
 * ready-made KWS models are similar — permissive code, restricted weights. Reading
 * only the code LICENSE and concluding "permissive for everything" is the exact
 * trap `mythos/THIRD_PARTY_NOTICES.md` records.
 *
 * So the model is BYO, like every API key in this project: the operator drops a
 * file on the device, this class loads it from there, and nothing under restricted
 * terms is ever redistributed. What model to bundle in a paid product — if any —
 * stays a decision for whoever ships it, made with a lawyer, and is not encoded
 * here. Nothing in this file asserts what any licence permits.
 *
 * [NoOpDetector] is the honest default: with no model present the node reports
 * itself deaf rather than pretending to listen. A wake word that silently never
 * fires is the worst outcome available — indistinguishable from a broken mic, a
 * lost socket, or a phrase the operator is mispronouncing.
 *
 * ## Implementing one
 *
 * Feed 16 kHz mono PCM16 (the same format MicRecorder already produces) and call
 * `onDetected` when the phrase is heard. Two hazards, both learned the hard way in
 * this repo:
 *
 *  - **Check preprocessing by VALUE, not by shape.** BUG-175: a port of
 *    openWakeWord copied every tensor shape correctly and missed one scaling step
 *    in the mel transform (`x/10 + 2`). The pipeline ran, the shapes matched, and
 *    the detector scored 1e-5 where it should have scored 0.998 — completely deaf,
 *    and perfectly plausible-looking. Pin your feature extraction against a
 *    known-good reference vector before trusting any of it.
 *  - **Suppress while speaking.** A phone that hears its own TTS will transcribe
 *    MYTHOS as the operator and answer itself; this has already happened in this
 *    project's history. [WakeWordGate] below owns that window.
 */
interface WakeWordDetector {

    /** False when this detector cannot possibly fire, so the UI can say why. */
    val isAvailable: Boolean

    /** Human-readable state for the UI — never a bare boolean. */
    val statusLabel: String

    fun start(onDetected: () -> Unit): Boolean

    fun stop()

    companion object {
        /**
         * Where the operator puts their model. App-private external storage, so it
         * is reachable over adb without any storage permission:
         *
         *   adb push my-wakeword.tflite \
         *     /sdcard/Android/data/com.mythos.nodes.phone/files/wakeword/
         */
        fun modelDir(filesDir: File): File = File(filesDir, "wakeword")

        fun findModel(filesDir: File): File? =
            modelDir(filesDir).takeIf { it.isDirectory }
                ?.listFiles { f -> f.isFile && f.length() > 0 }
                ?.firstOrNull()
    }
}

/**
 * What runs when no model has been provided: nothing, loudly.
 *
 * It reports `isAvailable = false` and a label the UI shows verbatim, so "hands-free
 * is off because there is no model" is visible instead of being mistaken for a
 * hardware fault. Push-to-talk is unaffected — the node is fully usable without
 * ever installing a wake-word model.
 */
class NoOpDetector(private val reason: String) : WakeWordDetector {
    override val isAvailable: Boolean = false
    override val statusLabel: String = reason
    override fun start(onDetected: () -> Unit): Boolean = false
    override fun stop() {}
}

/**
 * Decides whether a detection is allowed to become a wake REPORT.
 *
 * Separate from the detector because it is the part that must be right regardless
 * of which model an operator supplies, and the part that is testable without one.
 *
 * Two independent suppressions:
 *  - **Own playback.** While this node is speaking — and for a tail afterwards,
 *    since a room reverberates and the audio buffer drains after `isPlaying` goes
 *    false — a detection is almost certainly MYTHOS's own voice. The HUD has five
 *    such checks for the same reason.
 *  - **Retrigger.** A single spoken phrase produces several detections across
 *    consecutive frames; each would otherwise become its own arbitration request.
 */
class WakeWordGate(
    private val isSpeaking: () -> Boolean,
    private val nowMs: () -> Long = { System.currentTimeMillis() },
) {
    private var lastPlaybackAtMs = 0L
    private var lastReportAtMs = 0L

    /**
     * Call on every playback state change.
     *
     * Stamped on BOTH transitions, not just `true`. Stamping only when playback
     * starts measures the tail from the START of a reply — so after a 30-second
     * answer the window has expired before the last sentence has even left the
     * speaker, and the node can trigger on its own voice. Caught by
     * WakeWordGateTest's "measured from the END" case, which failed against
     * exactly that mistake.
     */
    fun notePlaying(playing: Boolean) {
        lastPlaybackAtMs = nowMs()
    }

    /** Null when allowed; otherwise the reason it was suppressed (for the log/UI). */
    fun rejectionReason(): String? {
        val now = nowMs()
        if (isSpeaking()) return "own playback"
        if (now - lastPlaybackAtMs < PLAYBACK_TAIL_MS) return "playback tail"
        if (now - lastReportAtMs < RETRIGGER_MS) return "retrigger"
        return null
    }

    /** True if the detection may be reported; records the report when it does. */
    fun allow(): Boolean {
        if (rejectionReason() != null) return false
        lastReportAtMs = nowMs()
        return true
    }

    companion object {
        /**
         * 300ms past the end of playback. The audio buffer drains after isPlaying
         * flips, and a small room's reverb outlives the signal.
         */
        const val PLAYBACK_TAIL_MS = 300L

        /** One phrase, one arbitration. */
        const val RETRIGGER_MS = 1500L
    }
}
