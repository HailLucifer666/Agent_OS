package com.mythos.nodes.phone

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.TimeUnit

/**
 * Microphone capture, and the round trip to MYTHOS's existing
 * `POST /api/voice/transcribe`.
 *
 * WHY 16 kHz MONO PCM16 IN A RIFF WRAPPER, specifically. The server's STT chain
 * (VOICE_STT_CHAIN) is not uniform: groq accepts almost any container, but
 * local-whisper throws outright on anything that is not WAV and expects 16 kHz.
 * So this is the one format that satisfies every link in the chain — pick MP4/AAC
 * (the obvious MediaRecorder default) and the node works right up until the
 * operator's cloud key runs out and the local fallback engages.
 *
 * The header is hand-built for the same reason: MediaRecorder cannot emit raw
 * PCM16 WAV at all, and 44 bytes of well-documented struct is less machinery than
 * a transcoding dependency.
 *
 * Rate limiting worth knowing: that route sits behind MYTHOS's `expensiveLimit`
 * (8 requests/minute per IP, RATE_LIMIT_EXPENSIVE). Each phone has its own IP so
 * each gets its own bucket, which is why per-node push-to-talk is fine and a
 * chatty always-streaming design would not be.
 */
class MicRecorder(private val settings: NodeSettings) {

    private var record: AudioRecord? = null
    @Volatile private var recording = false

    private val http = OkHttpClient.Builder()
        // STT is a network round trip through a cloud provider; the default 10s
        // read timeout cuts off legitimate slow transcriptions.
        .callTimeout(45, TimeUnit.SECONDS)
        .build()

    /**
     * Start capturing. Caller must already hold RECORD_AUDIO — this is
     * @SuppressLint'ed rather than checking, because a silent permission check
     * here would turn a missing grant into "the mic produced nothing", which is
     * indistinguishable from a quiet room.
     */
    @SuppressLint("MissingPermission")
    fun start(): Boolean {
        val minBuffer = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL, ENCODING)
        if (minBuffer <= 0) return false
        // Everything here can throw, and an uncaught throw takes the whole
        // foreground service down on the operator's first press:
        //  - the constructor raises SecurityException without RECORD_AUDIO (the
        //    grant can be revoked from settings after the service started, and
        //    START_STICKY restarts us without going through the UI's request);
        //  - it also throws when another app holds the mic exclusively;
        //  - startRecording() raises IllegalStateException if the device hands
        //    back a record object that initialised but cannot start.
        // Returning false instead lets the caller say "microphone unavailable",
        // which is the difference between a diagnosable node and a dead one.
        val rec = try {
            AudioRecord(
                // VOICE_RECOGNITION rather than MIC: it applies the platform's
                // noise suppression/AGC tuned for speech and skips the effects meant
                // for music capture.
                MediaRecorder.AudioSource.VOICE_RECOGNITION,
                SAMPLE_RATE,
                CHANNEL,
                ENCODING,
                minBuffer * 4,
            )
        } catch (e: SecurityException) {
            lastError = "microphone permission denied"
            return false
        } catch (e: IllegalArgumentException) {
            lastError = "microphone unavailable on this device"
            return false
        }
        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            rec.release()
            lastError = "microphone busy — another app may be using it"
            return false
        }
        return try {
            rec.startRecording()
            record = rec
            recording = true
            lastError = null
            true
        } catch (e: IllegalStateException) {
            rec.release()
            lastError = "microphone could not start"
            false
        }
    }

    /** Why the last start() failed, for the UI to show verbatim. */
    @Volatile
    var lastError: String? = null
        private set

    /**
     * Read until [stop] is called, returning the captured PCM. Blocking — call
     * from a background dispatcher.
     */
    fun readUntilStopped(): ByteArray {
        val rec = record ?: return ByteArray(0)
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(4096)
        while (recording) {
            val read = rec.read(buffer, 0, buffer.size)
            if (read > 0) out.write(buffer, 0, read)
            if (read < 0) break
            // A hard ceiling so a stuck button cannot grow an unbounded buffer and
            // then POST tens of megabytes.
            if (out.size() > MAX_PCM_BYTES) break
        }
        return out.toByteArray()
    }

    fun stop() {
        recording = false
        val rec = record ?: return
        runCatching { rec.stop() }
        runCatching { rec.release() }
        record = null
    }

    /** Enough audio to be worth transcribing (~0.3s), not a stray tap. */
    fun isUsable(pcm: ByteArray): Boolean = pcm.size >= SAMPLE_RATE / 3 * 2

    /**
     * POST the audio and return the transcript, or null on any failure. Null is
     * honest here: the caller shows "didn't catch that" rather than inventing
     * text, and nothing is sent to the brain.
     */
    fun transcribe(pcm: ByteArray): String? {
        val wav = wrapAsWav(pcm)
        val body = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("audio", "node.wav", wav.toRequestBody("audio/wav".toMediaType()))
            .build()
        val request = Request.Builder()
            .url("${settings.httpBase()}/api/voice/transcribe")
            .addHeader("Authorization", "Bearer ${settings.authToken}")
            .post(body)
            .build()
        return runCatching {
            http.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return null
                val json = JSONObject(response.body?.string().orEmpty())
                json.optString("text").takeIf { it.isNotBlank() }
            }
        }.getOrNull()
    }

    /** The canonical 44-byte RIFF/WAVE header for PCM16, little-endian. */
    private fun wrapAsWav(pcm: ByteArray): ByteArray {
        val channels = 1
        val bitsPerSample = 16
        val byteRate = SAMPLE_RATE * channels * bitsPerSample / 8
        val out = ByteArrayOutputStream(44 + pcm.size)

        fun ascii(s: String) = out.write(s.toByteArray(Charsets.US_ASCII))
        fun le32(v: Int) = out.write(
            byteArrayOf(
                (v and 0xFF).toByte(),
                ((v shr 8) and 0xFF).toByte(),
                ((v shr 16) and 0xFF).toByte(),
                ((v shr 24) and 0xFF).toByte(),
            )
        )
        fun le16(v: Int) = out.write(byteArrayOf((v and 0xFF).toByte(), ((v shr 8) and 0xFF).toByte()))

        ascii("RIFF")
        le32(36 + pcm.size)   // size of everything after this field
        ascii("WAVE")
        ascii("fmt ")
        le32(16)              // PCM fmt chunk size
        le16(1)               // format = PCM
        le16(channels)
        le32(SAMPLE_RATE)
        le32(byteRate)
        le16(channels * bitsPerSample / 8) // block align
        le16(bitsPerSample)
        ascii("data")
        le32(pcm.size)
        out.write(pcm)
        return out.toByteArray()
    }

    companion object {
        const val SAMPLE_RATE = 16_000
        private const val CHANNEL = AudioFormat.CHANNEL_IN_MONO
        private const val ENCODING = AudioFormat.ENCODING_PCM_16BIT
        /** ~60s of 16kHz mono PCM16. */
        private const val MAX_PCM_BYTES = SAMPLE_RATE * 2 * 60
    }
}
