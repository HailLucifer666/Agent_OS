package com.mythos.nodes.phone

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.util.Base64

/**
 * Playback for Gemini Live's audio, which is nothing like a `speech-chunk`.
 *
 * `speech-chunk` carries a whole synthesized sentence in a container (mp3/wav)
 * and is handled by [SpeechPlayer]'s ExoPlayer queue. Live instead streams raw
 * signed 16-bit little-endian PCM at 24 kHz, mono, in small frames as the model
 * speaks — there is no container, no duration, and no sentence boundary. Handing
 * that to ExoPlayer means a decoder error per frame, which is why the phone was
 * routed away from Live entirely and answered from the batch text lane instead:
 * a different, flatter model than the desktop's.
 *
 * AudioTrack in MODE_STREAM is the right sink for it — write bytes as they
 * arrive, let the track underrun silently between turns.
 *
 * Writes happen on the caller's thread and AudioTrack.write blocks when the
 * buffer is full, which is the backpressure we want: the socket reader paces
 * itself to real time instead of buffering an entire reply in memory.
 */
class LivePcmPlayer {

    private var track: AudioTrack? = null

    @Volatile
    private var playing = false

    /** True while Live audio is actually being written to the speaker. */
    val isPlaying: Boolean get() = playing

    private var listener: ((Boolean) -> Unit)? = null

    fun setListener(onPlayingChanged: (Boolean) -> Unit) {
        listener = onPlayingChanged
    }

    /**
     * Level per frame range, so the orb shows what the speaker is playing rather
     * than what the socket has written. See [installOrbProbe].
     */
    private val levels = PlaybackRms()

    /** Output frames handed to the track since the last flush. */
    private var framesWritten = 0L

    /**
     * Let the orb read this player's level.
     *
     * WHY THIS IS NOT SIMPLY "RMS THE BYTES AS THEY ARRIVE". The track is built with
     * a buffer four times the platform minimum, and [write] returns as soon as there
     * is room in it — so a level measured at write time is the level of audio that
     * has not been played yet. Visualising that makes the orb lead the voice by the
     * whole buffer depth, which is small enough to look like a bug rather than a
     * delay. `playbackHeadPosition` is the only value that says what is audible now.
     *
     * The probe returns a NEGATIVE number when Live is not playing at all, which is
     * how the orb tells "a silent gap inside a reply" (stay still) from "this path
     * is not in use" (fall back to the legacy path's envelope).
     */
    fun installOrbProbe() {
        OrbAudio.outputProbe = {
            val sink = track
            if (!playing || sink == null) {
                -1f
            } else {
                // Unsigned: the head position is an Int that wraps after ~24 hours
                // of continuous playback, and a signed read would make it go
                // backwards at that point instead of past the stored ranges.
                val head = runCatching { sink.playbackHeadPosition.toLong() and 0xFFFFFFFFL }
                    .getOrDefault(0L)
                perceptual(levels.levelAt(head))
            }
        }
    }

    @Synchronized
    private fun ensureTrack(): AudioTrack {
        track?.let { return it }
        // A floor of four buffers: the minimum is sized for the smallest safe
        // write, and Live's frames arrive in bursts over a LAN socket. Underruns
        // are audible as clicks, and a phone speaker makes them obvious.
        val minBytes = AudioTrack.getMinBufferSize(SAMPLE_RATE, CHANNEL, ENCODING)
        val bufferBytes = if (minBytes > 0) minBytes * 4 else SAMPLE_RATE // 0.5s fallback
        val created = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(ENCODING)
                    .setSampleRate(SAMPLE_RATE)
                    .setChannelMask(CHANNEL)
                    .build()
            )
            .setBufferSizeInBytes(bufferBytes)
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
        created.play()
        track = created
        return created
    }

    /**
     * Play one base64 PCM frame. Returns false when there was nothing to play, so
     * the caller can tell "no audio" from "played" exactly as [SpeechPlayer] does.
     */
    fun write(base64Pcm: String?): Boolean {
        if (base64Pcm.isNullOrEmpty()) return false
        val bytes = runCatching { Base64.decode(base64Pcm, Base64.DEFAULT) }.getOrNull() ?: return false
        if (bytes.isEmpty()) return false
        val sink = runCatching { ensureTrack() }.getOrNull() ?: return false
        if (!playing) {
            playing = true
            listener?.invoke(true)
        }
        // Measured BEFORE the write, because the write blocks once the buffer is
        // full — by the time it returns, some of this frame is already audible.
        val frames = bytes.size / BYTES_PER_FRAME
        if (frames > 0) {
            levels.add(framesWritten, framesWritten + frames, rms16le(bytes, frames * BYTES_PER_FRAME))
            framesWritten += frames
        }
        runCatching { sink.write(bytes, 0, bytes.size) }
        return true
    }

    /**
     * The turn ended, or the operator barged in.
     *
     * `pause` + `flush` rather than `stop`: stop() drains what is already queued,
     * which is the opposite of what a barge-in wants — MYTHOS would keep talking
     * over the operator for the length of the buffer.
     */
    @Synchronized
    fun stopAndClear() {
        val sink = track
        if (sink != null) {
            runCatching { sink.pause() }
            runCatching { sink.flush() }
            runCatching { sink.play() }
        }
        // flush() sets playbackHeadPosition back to zero. Without this reset every
        // stored range would then sit in the future, and after the first barge-in
        // the orb would read levels from a sentence that was already cancelled.
        levels.reset()
        framesWritten = 0L
        if (playing) {
            playing = false
            listener?.invoke(false)
        }
    }

    @Synchronized
    fun release() {
        runCatching { track?.pause() }
        runCatching { track?.flush() }
        runCatching { track?.release() }
        track = null
        levels.reset()
        framesWritten = 0L
        if (OrbAudio.outputProbe != null) OrbAudio.outputProbe = null
        if (playing) {
            playing = false
            listener?.invoke(false)
        }
    }

    private companion object {
        /**
         * Fixed by the wire format, not a preference: live-session.js documents
         * onAudioOut as base64 PCM 24k, and the HUD's own player uses
         * PLAYBACK_RATE = 24000. Changing this pitch-shifts MYTHOS.
         */
        const val SAMPLE_RATE = 24_000
        const val CHANNEL = AudioFormat.CHANNEL_OUT_MONO
        const val ENCODING = AudioFormat.ENCODING_PCM_16BIT
        /** Mono PCM16: one frame is one sample is two bytes. */
        const val BYTES_PER_FRAME = 2
    }
}
