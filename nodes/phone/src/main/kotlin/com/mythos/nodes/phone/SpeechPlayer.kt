package com.mythos.nodes.phone

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Base64
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Plays the reply.
 *
 * MYTHOS streams a spoken reply as `speech-chunk` frames — one per sentence, each
 * independently encoded, arriving while earlier ones are still playing. The mime
 * varies by TTS provider: `audio/mpeg` from edge-tts, `audio/wav` from
 * gemini/piper. A chunk can also carry NO audio at all (`audioB64: null`) when the
 * TTS sidecar is down, in which case it is text-only and there is nothing to play;
 * this node stays silent for those rather than pretending, because a node that
 * silently drops half a reply is worse than one that visibly says nothing.
 *
 * WHY ExoPlayer AND NOT MediaPlayer-per-chunk. Three reasons, and the third is
 * the one that matters later:
 *  - It queues: appending to a playlist gives near-gapless sentence-to-sentence
 *    playback, where sequential MediaPlayers leave an audible seam mid-reply.
 *  - It handles both mp3 and wav from a data: URI without branching.
 *  - It has seekTo(). Stage 5's conversation handoff records the playhead offset
 *    on TRANSFER and resumes from it on RELEASE (§6.3) — impossible to do
 *    honestly without a seekable player, and faking it would restart the sentence
 *    on the new device.
 *
 * ## THREAD AFFINITY IS NOT OPTIONAL, AND THIS CLASS OWNS IT
 *
 * ExoPlayer binds to the Looper of the thread that built it and throws
 * `IllegalStateException("Player is accessed on the wrong thread")` on ANY access
 * from another one. Every caller here is a coroutine on `Dispatchers.Default`
 * (VoiceNodeService's inbound loop), so the first arriving speech chunk would have
 * crashed the service — the app installs, connects, looks healthy, and dies the
 * moment MYTHOS speaks.
 *
 * Nothing in the unit suite or the build could have caught that: it is a runtime
 * contract of a library, invisible to a compiler and to any test that does not run
 * a real player on a real Looper. Found by auditing for launch-blocking hazards
 * rather than by a green signal — the same class as this repo's Electron
 * `screen`-before-ready crash, which also shipped behind passing tests.
 *
 * So the player is confined to the main Looper and this class marshals everything:
 * mutations are posted, and the two reads that must return a value do a bounded
 * blocking round-trip. `isPlaying` is served from a cached flag the player itself
 * updates, so the hot path (the wake-word gate asking "am I speaking?") never
 * blocks or hops threads at all.
 */
class SpeechPlayer(context: Context) {

    private val main = Handler(Looper.getMainLooper())

    private val player: ExoPlayer = ExoPlayer.Builder(context)
        // Explicit rather than implicit: this must not silently re-bind to
        // whatever thread happens to construct SpeechPlayer in the future.
        .setLooper(Looper.getMainLooper())
        .build()
        .apply { playWhenReady = true }

    /**
     * Mirrors the player's own state, updated on the main thread by the listener
     * below. Cached because the wake-word gate reads it on every detection frame,
     * and a cross-thread read would either crash or block.
     */
    @Volatile
    private var playingCached: Boolean = false

    init {
        onMain {
            player.addListener(object : Player.Listener {
                override fun onIsPlayingChanged(playing: Boolean) {
                    playingCached = playing
                    externalListener?.invoke(playing)
                }
            })
        }
    }

    private var externalListener: ((Boolean) -> Unit)? = null

    /** True while audio is actually coming out of the speaker. */
    val isPlaying: Boolean get() = playingCached

    /** Current playhead. Bounded blocking read — see the class header. */
    val positionMs: Long get() = readOnMain(0L) { player.currentPosition }

    fun setListener(onPlayingChanged: (Boolean) -> Unit) {
        externalListener = onPlayingChanged
    }

    /**
     * Enqueue one chunk. Returns false when the chunk carried no audio, so the
     * caller can distinguish "nothing to play" from "played".
     *
     * The base64 is decoded and the URI built on the CALLING thread — that work is
     * pure CPU and has no player affinity, so keeping it off the main thread stops
     * a long reply from janking the UI. Only the player calls hop.
     */
    fun enqueue(audioB64: String?, mime: String?): Boolean {
        if (audioB64.isNullOrEmpty()) return false
        // A data: URI keeps this entirely in memory — no temp files to clean up,
        // and nothing of the operator's speech or MYTHOS's replies is left on disk.
        val type = mime?.takeIf { it.isNotBlank() } ?: "audio/mpeg"
        val uri = "data:$type;base64,${Base64.encodeToString(Base64.decode(audioB64, Base64.DEFAULT), Base64.NO_WRAP)}"
        onMain {
            player.addMediaItem(MediaItem.fromUri(uri))
            if (!player.isPlaying) player.prepare()
        }
        return true
    }

    /** Barge-in, or a `cancel` for a reply now owned by another device. */
    fun stopAndClear() = onMain {
        player.stop()
        player.clearMediaItems()
    }

    // ---- Stage 5 conversation handoff (§6.3) --------------------------------
    // Pause/resume are separate from stopAndClear because a handoff must NOT
    // discard the queue: the sentence keeps playing, just somewhere else.

    /**
     * Pause and report where the playhead stopped. Blocking, deliberately: the
     * offset is what the next device resumes from, and returning a stale or
     * guessed value would restart the sentence rather than continue it.
     */
    fun pauseForHandoff(): Long = readOnMain(0L) {
        player.pause()
        player.currentPosition
    }

    fun seekTo(offsetMs: Long) = onMain { player.seekTo(offsetMs) }

    fun resume() = onMain { player.play() }

    fun release() = onMain { player.release() }

    // ---- marshalling -------------------------------------------------------

    /** Run on the main thread, immediately if already there. */
    private inline fun onMain(crossinline block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block() else main.post { block() }
    }

    /**
     * Read a value from the player, bounded so a wedged main thread degrades to
     * the fallback instead of hanging the caller forever. Executes inline when
     * already on main, which also means it can never deadlock on itself.
     */
    private fun <T> readOnMain(fallback: T, block: () -> T): T {
        if (Looper.myLooper() == Looper.getMainLooper()) return block()
        var result = fallback
        val latch = CountDownLatch(1)
        main.post {
            try { result = block() } finally { latch.countDown() }
        }
        return if (latch.await(READ_TIMEOUT_MS, TimeUnit.MILLISECONDS)) result else fallback
    }

    private companion object {
        /** Generous for a main-thread hop, short enough not to stall a handoff. */
        const val READ_TIMEOUT_MS = 250L
    }
}
