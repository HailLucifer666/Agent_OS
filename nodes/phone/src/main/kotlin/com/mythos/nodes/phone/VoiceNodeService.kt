package com.mythos.nodes.phone

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

/**
 * The voice node itself: one foreground service holding the socket, the scanner,
 * the microphone and the speaker.
 *
 * All four live together because they are one device's single conversation. A
 * separate scanner process would need its own socket, and MYTHOS identifies a node
 * BY its socket — two connections would be two candidates for one node id.
 *
 * Foreground, with both `microphone` and `connectedDevice` types, because every
 * part of this must keep working with the screen off. That is the entire premise:
 * a phone on a kitchen counter is not a phone someone is looking at.
 */
class VoiceNodeService : Service() {

    enum class Phase { IDLE, LISTENING, THINKING, SPEAKING }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private lateinit var settings: NodeSettings
    private lateinit var link: NodeLink
    private var scanner: BeaconScanner? = null
    private var player: SpeechPlayer? = null
    private var mic: MicRecorder? = null
    private var listenJob: Job? = null

    /** Sightings stop when the beacon leaves; MYTHOS is told rather than left to guess. */
    private var lastSightingMs = 0L
    private var reportedLost = true

    /** Playhead recorded at TRANSFER, resumed from at RELEASE (§6.3). */
    private var handoffOffsetMs = 0L

    private var detector: WakeWordDetector? = null
    private var wakeGate: WakeWordGate? = null

    override fun onCreate() {
        super.onCreate()
        settings = NodeSettings(applicationContext)
        link = NodeLink(settings)
        player = SpeechPlayer(applicationContext).also { p ->
            p.setListener { playing ->
                // Playback state drives the orb, and Stage 4's wake-word
                // suppression window will hang off exactly this signal: a phone
                // that hears its own TTS would answer itself.
                if (playing) _phase.value = Phase.SPEAKING
                else if (_phase.value == Phase.SPEAKING) _phase.value = Phase.IDLE
                // The gate measures its tail from the END of playback, so it needs
                // the transition, not a poll.
                wakeGate?.notePlaying(playing)
            }
        }
        mic = MicRecorder(settings)
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForegroundCompat()

        when (intent?.action) {
            ACTION_START_LISTENING -> { startListeningOnce(); return START_STICKY }
            ACTION_STOP_LISTENING -> { stopListening(); return START_STICKY }
        }

        link.connect()
        scope.launch { consumeInbound() }
        // Mirror the socket state onto a companion flow so the UI has one place
        // to read from and never needs a handle on the service instance.
        scope.launch { link.status.collect { _connection.value = it } }
        startScanner()
        startWakeWord()
        scope.launch { lostSweep() }
        return START_STICKY
    }

    // ---- Aether half: verified sightings become node-readings ---------------

    private fun startScanner() {
        val started = BeaconScanner(
            context = applicationContext,
            settings = settings,
            onVerified = { rssi, name ->
                lastSightingMs = System.currentTimeMillis()
                reportedLost = false
                _rejections.value = 0
                link.sendReading(rssi, name)
            },
            onRejected = { _rejections.value = _rejections.value + 1 },
        ).let { s -> if (s.start()) s else null }
        scanner = started
        _scanning.value = started != null
    }

    /**
     * Tell MYTHOS when the beacon is gone instead of letting the proxy time out.
     * The proxy would eventually mark this node lost on its own after 6s of
     * silence, but saying so takes one frame and makes the election correct
     * seconds earlier — which is the difference between the right device answering
     * and the last device answering.
     */
    private suspend fun lostSweep() {
        while (true) {
            delay(LOST_SWEEP_MS)
            val silentFor = System.currentTimeMillis() - lastSightingMs
            if (!reportedLost && silentFor > LOST_AFTER_MS) {
                reportedLost = true
                link.sendLost()
            }
        }
    }

    // ---- Wake word: heard here, arbitrated by Aether ------------------------

    /**
     * Start hands-free listening, if the operator supplied a model.
     *
     * A detection is NOT a decision. It becomes a `node-wake` report, MYTHOS asks
     * Aether to rank every device that heard the phrase, and only the device named
     * ACCEPTED opens its mic — otherwise four phones in a hallway all answer one
     * sentence. The gate drops detections caused by our own playback before any of
     * that, since a phone that hears its own TTS answers itself.
     */
    private fun startWakeWord() {
        val gate = WakeWordGate(isSpeaking = { player?.isPlaying == true })
        wakeGate = gate

        val model = WakeWordDetector.findModel(getExternalFilesDir(null) ?: filesDir)
        val d: WakeWordDetector = if (model == null) {
            // Honest and visible: hands-free is off because there is no model, not
            // because anything is broken. Push-to-talk still works.
            NoOpDetector("no wake-word model installed")
        } else {
            // A model is present but this build ships no inference engine for it —
            // see WakeWordDetector's header for why no model or engine is bundled.
            // Reporting the file we found makes a wrong-format drop diagnosable.
            NoOpDetector("model found (${model.name}) but no detector engine in this build")
        }
        detector = d
        _wakeStatus.value = d.statusLabel
        if (!d.isAvailable) return

        d.start {
            val reason = gate.rejectionReason()
            if (reason != null) {
                _wakeSuppressed.value = _wakeSuppressed.value + 1
                return@start
            }
            if (!gate.allow()) return@start
            // If the socket is down there is nobody to arbitrate; answering locally
            // is better than being deaf, and MYTHOS's own fallback does the same.
            if (!link.sendWake()) startListeningOnce()
        }
    }

    // ---- Voice half: mic up, speech down -----------------------------------

    /**
     * Capture one utterance, transcribe it, send it. Exposed as an action so the
     * UI, and later Stage 4's wake-word arbitration, are both just callers — no
     * restructuring needed when the wake word starts driving this.
     */
    fun startListeningOnce() {
        if (listenJob?.isActive == true) return
        listenJob = scope.launch {
            val recorder = mic ?: return@launch
            // Never record over our own voice: the mic would capture the TTS and
            // the transcript would come back as the operator saying whatever
            // MYTHOS just said (the same self-answering loop the HUD guards
            // against, and proven in this repo's episodic history).
            player?.stopAndClear()

            if (!recorder.start()) {
                _phase.value = Phase.IDLE
                return@launch
            }
            _phase.value = Phase.LISTENING
            val pcm = withContext(Dispatchers.IO) { recorder.readUntilStopped() }
            recorder.stop()

            if (!recorder.isUsable(pcm)) {
                _phase.value = Phase.IDLE
                return@launch
            }
            _phase.value = Phase.THINKING
            val text = withContext(Dispatchers.IO) { recorder.transcribe(pcm) }
            if (text.isNullOrBlank()) {
                // Honest failure: no transcript means no utterance. Never guess.
                _lastError.value = "Didn't catch that"
                _phase.value = Phase.IDLE
                return@launch
            }
            _lastHeard.value = text
            _lastError.value = null
            val sent = link.sendUtterance("node-" + System.currentTimeMillis(), text)
            if (!sent) {
                _lastError.value = "Not connected to MYTHOS"
                _phase.value = Phase.IDLE
            }
        }
    }

    fun stopListening() {
        mic?.stop() // ends readUntilStopped's loop; the job finishes on its own
    }

    private suspend fun consumeInbound() {
        link.inbound.collect { msg ->
            when (msg.optString("type")) {
                "speech-chunk" -> {
                    val played = player?.enqueue(
                        msg.optString("audioB64").takeIf { it.isNotEmpty() },
                        msg.optString("mime"),
                    ) ?: false
                    // The text rides along even when audio does not, so the caption
                    // is right whether or not TTS was up.
                    msg.optString("text").takeIf { it.isNotBlank() }?.let { _caption.value = it }
                    if (played) _phase.value = Phase.SPEAKING
                }
                "done" -> {
                    msg.optString("say").takeIf { it.isNotBlank() }?.let { _caption.value = it }
                    if (player?.isPlaying != true) _phase.value = Phase.IDLE
                }
                // Stage 3 sends this when a reply's remaining chunks were moved to
                // another device: drop what is queued rather than talking over it.
                "cancel" -> {
                    player?.stopAndClear()
                    _phase.value = Phase.IDLE
                }
                // Stage 5 — the conversation handoff FSM (§6.3). Each phase lasts
                // ~200ms, so this must act on the phase itself rather than waiting
                // for the next election perception, which arrives after the whole
                // handoff is over.
                //
                // Both devices receive every phase. The one holding the sentence
                // pauses on TRANSFER and remembers the playhead; the one taking it
                // seeks to that offset on CONFIRM and resumes on RELEASE. Chunks
                // that have not been synthesized yet are redirected server-side,
                // which is why the sentence CONTINUES here instead of restarting.
                "conversation" -> when (msg.optString("phase")) {
                    "TRANSFER" -> {
                        // Attribution is still the old owner here, so whoever is
                        // actually playing is the one who pauses.
                        if (player?.isPlaying == true) {
                            handoffOffsetMs = player?.pauseForHandoff() ?: 0L
                        }
                    }
                    "CONFIRM" -> {
                        // Attribution flips now. Seek but do NOT resume — resuming
                        // a beat early is audible as a stutter across the two
                        // devices.
                        if (handoffOffsetMs > 0L) player?.seekTo(handoffOffsetMs)
                    }
                    "RELEASE" -> {
                        player?.resume()
                        handoffOffsetMs = 0L
                    }
                    "IDLE" -> handoffOffsetMs = 0L
                }
                // Stage 4 — the arbitration verdict. Every node receives it,
                // including the losers, because a device that heard the phrase and
                // is told nothing cannot tell "you lost" from "nobody heard you":
                // it would either answer as well, or sit there looking broken.
                "wake-outcome" -> {
                    val results = msg.optJSONArray("results")
                    var mine: String? = null
                    if (results != null) {
                        for (i in 0 until results.length()) {
                            val entry = results.optJSONObject(i) ?: continue
                            if (entry.optString("id") == settings.nodeId) {
                                mine = entry.optString("outcome")
                            }
                        }
                    }
                    when (mine) {
                        "ACCEPTED" -> startListeningOnce()
                        // §6.1: `results` lists only PRESENT scanners, so a node
                        // that cannot currently see the beacon appears nowhere in
                        // it. Absence is NOT consent — anything that is not an
                        // explicit ACCEPTED stands down.
                        else -> _wakeSuppressed.value = _wakeSuppressed.value + 1
                    }
                }
                "identified" -> _identified.value = msg.optBoolean("ok", false)
            }
        }
    }

    // ---- Service plumbing ---------------------------------------------------

    private fun createChannel() {
        val manager = getSystemService(NotificationManager::class.java) ?: return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "MYTHOS voice node", NotificationManager.IMPORTANCE_LOW),
        )
    }

    private fun startForegroundCompat() {
        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("MYTHOS node")
            .setContentText(settings.nodeId.ifEmpty { "not configured" })
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        super.onDestroy()
        scanner?.stop()
        detector?.stop()
        mic?.stop()
        player?.release()
        link.disconnect()
        _phase.value = Phase.IDLE
        _scanning.value = false
        scope.cancel()
    }

    companion object {
        const val ACTION_START_LISTENING = "com.mythos.nodes.phone.START_LISTENING"
        const val ACTION_STOP_LISTENING = "com.mythos.nodes.phone.STOP_LISTENING"

        private const val CHANNEL_ID = "mythos_node"
        private const val NOTIFICATION_ID = 3001
        private const val LOST_SWEEP_MS = 1_000L
        /** Slightly under the proxy's own 6s threshold, so we say it first. */
        private const val LOST_AFTER_MS = 4_000L

        private val _phase = MutableStateFlow(Phase.IDLE)
        val phase: StateFlow<Phase> = _phase.asStateFlow()

        private val _caption = MutableStateFlow("")
        val caption: StateFlow<String> = _caption.asStateFlow()

        private val _lastHeard = MutableStateFlow("")
        val lastHeard: StateFlow<String> = _lastHeard.asStateFlow()

        private val _lastError = MutableStateFlow<String?>(null)
        val lastError: StateFlow<String?> = _lastError.asStateFlow()

        private val _scanning = MutableStateFlow(false)
        val scanning: StateFlow<Boolean> = _scanning.asStateFlow()

        /** Verified-payload rejections; a climbing count with zero sightings is a
         *  realm-key or beacon-name mismatch, not an absent beacon. */
        private val _rejections = MutableStateFlow(0)
        val rejections: StateFlow<Int> = _rejections.asStateFlow()

        private val _wakeStatus = MutableStateFlow("off")
        /** Verbatim in the UI — colour alone cannot say WHY hands-free is off. */
        val wakeStatus: StateFlow<String> = _wakeStatus.asStateFlow()

        private val _wakeSuppressed = MutableStateFlow(0)
        /** Detections that did not become a turn: own playback, retrigger, or lost
         *  the arbitration. Visible so "it heard me and stayed quiet" is
         *  distinguishable from "it never heard me". */
        val wakeSuppressed: StateFlow<Int> = _wakeSuppressed.asStateFlow()

        private val _connection = MutableStateFlow(NodeLink.Status.DISCONNECTED)
        val connection: StateFlow<NodeLink.Status> = _connection.asStateFlow()

        private val _identified = MutableStateFlow(false)
        val identified: StateFlow<Boolean> = _identified.asStateFlow()
    }
}
