package com.mythos.nodes.phone

import android.content.Context
import android.util.Base64
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer

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
 */
class SpeechPlayer(context: Context) {

    private val player: ExoPlayer = ExoPlayer.Builder(context).build().apply {
        playWhenReady = true
    }

    /** True while audio is actually coming out of the speaker. */
    val isPlaying: Boolean get() = player.isPlaying

    /** Current playhead, for the Stage 5 handoff offset. */
    val positionMs: Long get() = player.currentPosition

    fun setListener(onPlayingChanged: (Boolean) -> Unit) {
        player.addListener(object : Player.Listener {
            override fun onIsPlayingChanged(playing: Boolean) = onPlayingChanged(playing)
        })
    }

    /**
     * Enqueue one chunk. Returns false when the chunk carried no audio, so the
     * caller can distinguish "nothing to play" from "played".
     */
    fun enqueue(audioB64: String?, mime: String?): Boolean {
        if (audioB64.isNullOrEmpty()) return false
        // A data: URI keeps this entirely in memory — no temp files to clean up,
        // and nothing of the operator's speech or MYTHOS's replies is left on disk.
        val type = mime?.takeIf { it.isNotBlank() } ?: "audio/mpeg"
        val uri = "data:$type;base64,${Base64.encodeToString(Base64.decode(audioB64, Base64.DEFAULT), Base64.NO_WRAP)}"
        player.addMediaItem(MediaItem.fromUri(uri))
        if (!player.isPlaying) player.prepare()
        return true
    }

    /** Barge-in, or a `cancel` for a reply now owned by another device. */
    fun stopAndClear() {
        player.stop()
        player.clearMediaItems()
    }

    // ---- Stage 5 conversation handoff (§6.3) --------------------------------
    // Pause/resume are separate from stopAndClear because a handoff must NOT
    // discard the queue: the sentence keeps playing, just somewhere else.

    fun pauseForHandoff(): Long {
        player.pause()
        return player.currentPosition
    }

    fun seekTo(offsetMs: Long) {
        player.seekTo(offsetMs)
    }

    fun resume() {
        player.play()
    }

    fun release() {
        player.release()
    }
}
