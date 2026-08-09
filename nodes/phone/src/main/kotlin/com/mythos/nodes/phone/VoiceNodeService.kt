package com.mythos.nodes.phone

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
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

    /**
     * A tier-3/4 action MYTHOS will not take without a human saying yes.
     *
     * `outcome` is null while the approval is still answerable and a word once it
     * is not — the sheet greys out and says which, rather than leaving a live
     * button over a confirm the server has already swept or given to someone
     * else. That distinction is the whole point: a tap on a lapsed confirm is a
     * silent no-op server-side, so the phone has to be the one that says so.
     */
    data class Approval(
        val id: String,
        val summary: String,
        val tier: Int,
        val expiresAtMs: Long,
        val outcome: String? = null,
    )

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private lateinit var settings: NodeSettings
    private lateinit var link: NodeLink
    private var scanner: BeaconScanner? = null
    private var player: SpeechPlayer? = null
    /** Gemini Live's raw 24kHz PCM — a different sink from `player`, see LivePcmPlayer. */
    private var livePlayer: LivePcmPlayer? = null
    private var mic: MicRecorder? = null
    private var listenJob: Job? = null

    /** Sightings stop when the beacon leaves; MYTHOS is told rather than left to guess. */
    private var lastSightingMs = 0L
    private var reportedLost = true

    /** Playhead recorded at TRANSFER, resumed from at RELEASE (§6.3). */
    private var handoffOffsetMs = 0L

    private var detector: WakeWordDetector? = null
    private var wakeGate: WakeWordGate? = null

    /** Guards the one-time wiring in onStartCommand — see the comment there. */
    private var wired = false

    /** Foreground promotion is one-shot; see onStartCommand. */
    private var foregrounded = false

    /** reqId of the hold-to-talk turn awaiting a reply, or null when idle. */
    @Volatile private var pendingReqId: String? = null
    private var deadlineJob: Job? = null

    /** Runs the approval sheet's own clock — see armApprovalExpiry. */
    private var approvalJob: Job? = null

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
        livePlayer = LivePcmPlayer().also { p ->
            p.setListener { playing ->
                if (playing) _phase.value = Phase.SPEAKING
                else if (_phase.value == Phase.SPEAKING) _phase.value = Phase.IDLE
                wakeGate?.notePlaying(playing)
            }
            // Lets the orb read the level of what is actually coming out of the
            // speaker. Installed here rather than in the player's constructor so
            // there is exactly one probe even if the service is recreated.
            p.installOrbProbe()
        }
        mic = MicRecorder(settings)
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Promotion is a Binder round trip and the notification never changes, so
        // doing it per action put two IPC hops between the operator's finger and
        // the microphone. Once is enough; Android keeps us in the foreground.
        if (!foregrounded) {
            foregrounded = true
            startForegroundCompat()
        }

        when (intent?.action) {
            ACTION_START_LISTENING -> { startListeningOnce(); return START_STICKY }
            ACTION_STOP_LISTENING -> { stopListening(); return START_STICKY }
            ACTION_CONFIRM_REPLY -> {
                val id = intent.getStringExtra(EXTRA_CONFIRM_ID)
                if (!id.isNullOrEmpty()) answerApproval(id, intent.getBooleanExtra(EXTRA_ACCEPT, false))
                return START_STICKY
            }
        }

        // Android delivers onStartCommand for EVERY startService call, and
        // MainActivity fires a bare one on each launch/resume. Everything below
        // is one-time wiring, so re-running it added a SECOND collector to the
        // same link.inbound SharedFlow — one speech-chunk frame then reached
        // consumeInbound() once per start and was enqueued into the player that
        // many times. Live symptom (operator, 2026-08-09): every sentence of the
        // reply spoken three times before the next one, matching the three
        // `voice-node.identified` lines in the server log. The scanner, the wake
        // detector and lostSweep were being tripled by the same path.
        if (wired) return START_STICKY
        wired = true

        link.connect()
        scope.launch { consumeInbound() }
        // Mirror the socket state onto a companion flow so the UI has one place
        // to read from and never needs a handle on the service instance.
        scope.launch { link.status.collect { _connection.value = it } }
        scope.launch { link.lastError.collect { _linkError.value = it } }
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
        // Published as well as the label so the UI can decide how loudly to show
        // this WITHOUT pattern-matching the wording. A future detector that
        // rephrases its status must not be able to make itself look healthy.
        _wakeAvailable.value = d.isAvailable
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
        // A turn is not over when this coroutine ends.
        //
        // `listenJob` completes the instant sendUtterance() hands the frame to the
        // socket — sendUtterance and armReplyDeadline both return immediately — so
        // the old guard was already open while MYTHOS was still thinking and before
        // the phone had spoken a word. Every press in that window started a WHOLE
        // NEW TURN: another recording, another STT call, another reqId, another
        // reply. Three presses of one question is three questions, and MYTHOS
        // answered all three. That is the "it repeats the entire answer three, then
        // more than three times" the operator reported across several builds — real
        // turns, never duplicated frames.
        //
        // Pressing again is still allowed; it just means "cancel that and listen to
        // me instead" rather than "ask a second time". Refusing outright would make
        // the orb feel dead for the length of a reply, which is the behaviour that
        // provoked the extra presses in the first place.
        val outgoing = pendingReqId
        if (outgoing != null) bargeIn(outgoing)
        listenJob = scope.launch {
            val recorder = mic ?: return@launch
            // Never record over our own voice: the mic would capture the TTS and
            // the transcript would come back as the operator saying whatever
            // MYTHOS just said (the same self-answering loop the HUD guards
            // against, and proven in this repo's episodic history).
            player?.stopAndClear()
            livePlayer?.stopAndClear()

            if (!recorder.start()) {
                // Silently returning to IDLE here is what makes a broken mic
                // indistinguishable from a button that does nothing — the operator
                // presses, nothing happens, and there is nowhere to look.
                _micStatus.value = recorder.lastError ?: "microphone unavailable"
                _phase.value = Phase.IDLE
                return@launch
            }
            _micStatus.value = ""
            _phase.value = Phase.LISTENING
            val pcm = withContext(Dispatchers.IO) { recorder.readUntilStopped() }
            recorder.stop()

            if (!recorder.isUsable(pcm)) {
                _phase.value = Phase.IDLE
                return@launch
            }
            _phase.value = Phase.THINKING
            val text = when (val result = withContext(Dispatchers.IO) { recorder.transcribe(pcm) }) {
                is MicRecorder.Result.Text -> result.text
                // The one case the old message was actually right about.
                MicRecorder.Result.NoSpeech -> {
                    _lastError.value = "Didn't catch that"
                    _phase.value = Phase.IDLE
                    return@launch
                }
                // Everything else is a fault worth naming. Saying "didn't catch
                // that" for a 503 sends the operator to check their microphone
                // when the microphone was never the problem.
                is MicRecorder.Result.Failed -> {
                    _lastError.value = result.reason
                    _phase.value = Phase.IDLE
                    return@launch
                }
            }
            // Honest failure above, never a guess: no transcript means no utterance
            // reaches the brain.
            _lastHeard.value = text
            _lastError.value = null
            val reqId = "node-" + System.currentTimeMillis()
            // A fresh turn owns the speaker. Anything still queued belongs to a
            // reply we are no longer waiting for.
            player?.stopAndClear()
            pendingReqId = reqId
            val sent = link.sendUtterance(reqId, text)
            if (!sent) {
                pendingReqId = null
                _lastError.value = "Not connected to MYTHOS"
                _phase.value = Phase.IDLE
            } else {
                armReplyDeadline(reqId)
            }
        }
    }

    /**
     * THINKING has to be able to fail.
     *
     * The phase left THINKING only on an inbound frame, so a reply that never
     * arrived — the socket it was promised to having closed mid-turn — left the
     * orb spinning with nothing to read and nothing to retry. Indistinguishable,
     * from the operator's side, from being ignored. That cost this build two
     * debugging rounds, so the wait now names itself.
     */
    private fun armReplyDeadline(reqId: String) {
        deadlineJob?.cancel()
        deadlineJob = scope.launch {
            delay(REPLY_TIMEOUT_MS)
            if (pendingReqId != reqId) return@launch
            pendingReqId = null
            _lastError.value = "No reply from MYTHOS — it may have dropped the turn"
            _phase.value = Phase.IDLE
        }
    }

    /** A frame arrived for the turn we are waiting on: stop the clock. */
    private fun noteReplyProgress() {
        deadlineJob?.cancel()
        deadlineJob = null
    }

    /**
     * Abandon the turn we are waiting on, because the operator started another.
     *
     * Both halves matter. Locally, the queued audio is dropped and the reqId is
     * forgotten, so `isStaleTurn` discards anything that still arrives for it.
     * Remotely, `stop` aborts the chunks MYTHOS has not synthesized yet — without
     * it the server finishes speaking into a socket whose listener no longer wants
     * it, which costs TTS budget and, if the barge-in is later abandoned, can still
     * be heard.
     */
    private fun bargeIn(reqId: String) {
        pendingReqId = null
        deadlineJob?.cancel()
        deadlineJob = null
        player?.stopAndClear()
        livePlayer?.stopAndClear()
        link.sendStop(reqId)
        Log.d(TAG, "barge-in over reqId=$reqId")
    }

    fun stopListening() {
        mic?.stop() // ends readUntilStopped's loop; the job finishes on its own
    }

    // ---- Approvals: the human half of the leash -----------------------------

    /**
     * Show a tier-3/4 approval and start its clock.
     *
     * MYTHOS already broadcast this request to every open socket, so the phone
     * has been receiving it all along and dropping it on the floor. The clock is
     * ours to run because the server never announces expiry: the confirm
     * registry sweeps lapsed entries passively on the next `create`, so a late
     * tap resolves nothing and — before `confirm-resolved` existed — said
     * nothing either. `ttlMs` comes from the server when it sends one rather
     * than being a second copy of LEASH_CONFIRM_TTL_MS here that drifts the
     * moment it is configured.
     */
    private fun showApproval(msg: JSONObject) {
        val payload = msg.optJSONObject("payload") ?: return
        val id = payload.optString("id").takeIf { it.isNotEmpty() } ?: return
        val ttl = payload.optLong("ttlMs", 0L).takeIf { it > 0L } ?: APPROVAL_TTL_FALLBACK_MS
        val summary = payload.optString("summary").takeIf { it.isNotBlank() }
            ?: payload.optString("tool").takeIf { it.isNotBlank() }
            ?: "Approve this action?"
        _approval.value = Approval(
            id = id,
            summary = summary,
            tier = payload.optInt("tier", 0),
            expiresAtMs = System.currentTimeMillis() + ttl,
        )
        // A counter-top node is usually face-down or across the room, and the
        // sheet is silent. The Live model is told to say it needs approval, and
        // when the turn came through Live that narration plays on the existing
        // player — but a confirm raised by any other path speaks not a word, so
        // there has to be a signal that does not depend on the model complying.
        buzz()
        armApprovalExpiry(id)
    }

    private fun armApprovalExpiry(id: String) {
        approvalJob?.cancel()
        approvalJob = scope.launch {
            val current = _approval.value ?: return@launch
            delay((current.expiresAtMs - System.currentTimeMillis()).coerceAtLeast(0L))
            val still = _approval.value
            if (still == null || still.id != id || still.outcome != null) return@launch
            // Greyed out and named, NOT dismissed. A sheet that vanishes on its
            // own is indistinguishable from one the operator's tap dismissed,
            // and they would believe they approved it.
            _approval.value = still.copy(outcome = "expired")
        }
    }

    /** The operator's answer. Sending is all we do — the outcome comes back. */
    fun answerApproval(id: String, accept: Boolean) {
        val current = _approval.value
        if (current != null && current.id == id && current.outcome != null) return
        if (!link.sendConfirmReply(id, accept)) {
            // The socket is down, so nothing was sent. Saying "denied" here would
            // be a lie in the safe direction, but still a lie: the action is
            // pending on the server and may yet be approved from the desktop.
            _approval.value = current?.copy(outcome = "not sent — no link")
            return
        }
        // Deliberately NOT closed here. The server's confirm-resolved is what
        // says whether this actually landed, and a sheet that closes on the tap
        // is exactly how a silent no-op reads as success.
        _approval.value = current?.copy(outcome = "sending…")
    }

    /**
     * The server resolved this confirm — by us, by the desktop, or by its TTL.
     *
     * 'not-permitted' is its own case and is not a failure of ours: tier 3/4
     * confirms are scoped to the connection that raised them, so a confirm the
     * DESKTOP triggered cannot be approved from the phone. Saying so beats a
     * button that does nothing.
     */
    private fun resolveApproval(msg: JSONObject) {
        val payload = msg.optJSONObject("payload") ?: return
        val id = payload.optString("id")
        val current = _approval.value ?: return
        if (current.id != id) return
        approvalJob?.cancel()
        approvalJob = null
        val outcome = when (payload.optString("outcome")) {
            "accepted" -> "approved"
            "rejected" -> "denied"
            "expired" -> "expired"
            "not-permitted" -> "approve this one on the device that asked"
            else -> "closed"
        }
        _approval.value = current.copy(outcome = outcome)
        approvalJob = scope.launch {
            delay(APPROVAL_LINGER_MS)
            if (_approval.value?.id == id) _approval.value = null
        }
    }

    fun dismissApproval() {
        approvalJob?.cancel()
        approvalJob = null
        _approval.value = null
    }

    /** Short, once. Vibration is a normal permission — no runtime prompt. */
    private fun buzz() {
        if (!settings.hapticsEnabled) return
        runCatching {
            val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                getSystemService(VibratorManager::class.java)?.defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                getSystemService(Vibrator::class.java)
            }
            vibrator?.vibrate(VibrationEffect.createOneShot(BUZZ_MS, VibrationEffect.DEFAULT_AMPLITUDE))
        }
    }

    /**
     * True when this frame belongs to a hold-to-talk turn we have already given
     * up on or never started.
     *
     * Entity-initiated speech (greetings, reminders) carries a `proactive-…`
     * reqId and is always ours to play — only a stale `node-…` turn is dropped.
     */
    private fun isStaleTurn(reqId: String): Boolean =
        reqId.startsWith("node-") && reqId != pendingReqId

    private suspend fun consumeInbound() {
        link.inbound.collect { msg ->
            val type = msg.optString("type")
            val reqId = msg.optString("reqId")
            if (type == "speech-chunk" || type == "done") {
                Log.d(TAG, "inbound $type reqId=$reqId pending=$pendingReqId")
                if (isStaleTurn(reqId)) return@collect
                noteReplyProgress()
            }
            when (type) {
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
                    // A Live-routed turn acks IMMEDIATELY with an empty `say` and
                    // routedToLive:true — the answer is still coming, as
                    // live-audio-out frames. Treating that ack as the end of the
                    // turn would reopen the mic mid-sentence and drop the caption,
                    // so only a batch `done` closes the turn here; the Live one is
                    // closed by live-turn-complete below.
                    if (msg.optBoolean("routedToLive")) {
                        armReplyDeadline(reqId)
                        return@collect
                    }
                    if (reqId == pendingReqId) pendingReqId = null
                    msg.optString("say").takeIf { it.isNotBlank() }?.let { _caption.value = it }
                    if (player?.isPlaying != true) _phase.value = Phase.IDLE
                }
                // ---- Gemini Live: the same brain the desktop app talks to ------
                // Raw 24kHz PCM, no container, so it goes to LivePcmPlayer rather
                // than the ExoPlayer queue. Before these three cases existed the
                // frames were silently dropped by a `when` with no else, which is
                // why voice nodes had to be routed to the flatter batch lane.
                "live-audio-out" -> {
                    noteReplyProgress()
                    livePlayer?.write(msg.optString("data").takeIf { it.isNotEmpty() })
                }
                "live-transcript" -> {
                    noteReplyProgress()
                    if (msg.optString("role") != "user") {
                        msg.optString("text").takeIf { it.isNotBlank() }?.let { _caption.value = it }
                    }
                }
                "live-turn-complete" -> {
                    pendingReqId = null
                    noteReplyProgress()
                    if (livePlayer?.isPlaying != true) _phase.value = Phase.IDLE
                }
                // Barge-in decided on the server (the model was interrupted).
                "live-interrupted" -> livePlayer?.stopAndClear()
                // Stage 3 sends this when a reply's remaining chunks were moved to
                // another device: drop what is queued rather than talking over it.
                "cancel" -> {
                    // The turn is over as far as this device is concerned, so the
                    // mic must not stay gated behind a reqId nothing will answer.
                    pendingReqId = null
                    noteReplyProgress()
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
                // MYTHOS will not take a tier-3/4 action without a human. The
                // frame has always arrived here (it is broadcast to every open
                // socket); until now the phone dropped it, which is why a
                // WhatsApp message asked for from the phone could never be sent
                // from the phone.
                "confirm-request" -> showApproval(msg)
                "confirm-resolved" -> resolveApproval(msg)
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
            // From API 34 the declared type must be BACKED BY a granted permission:
            // claiming FOREGROUND_SERVICE_TYPE_MICROPHONE without RECORD_AUDIO
            // throws SecurityException and kills the service on start.
            //
            // The UI path grants mic before ever starting us, so that case is
            // covered — but this service is START_STICKY, so Android also restarts
            // it after a kill with a null intent, and by then the operator may have
            // revoked the permission from system settings. Deriving the type from
            // what is actually granted keeps the node alive as a proximity scanner
            // instead of crash-looping, which is both the honest degradation and
            // the more useful one.
            var types = ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            } else {
                _micStatus.value = "microphone permission not granted — listening is off"
            }
            startForeground(NOTIFICATION_ID, notification, types)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    /**
     * A direct handle for the UI, so a press does not have to travel through
     * ActivityManager and back.
     *
     * The Intent path stays — the wake-word caller and the START_STICKY restart
     * both still use it — but hold-to-talk went finger → Binder → system_server →
     * Binder → service main thread → coroutine before the microphone opened, and
     * the first press after an idle period routinely felt dead. A dead-feeling
     * press is what made the operator press again, and every extra press was a
     * whole extra turn.
     */
    inner class LocalBinder : Binder() {
        fun service(): VoiceNodeService = this@VoiceNodeService
    }

    override fun onBind(intent: Intent?): IBinder = LocalBinder()

    override fun onDestroy() {
        super.onDestroy()
        scanner?.stop()
        detector?.stop()
        mic?.stop()
        player?.release()
        livePlayer?.release()
        link.disconnect()
        _phase.value = Phase.IDLE
        _scanning.value = false
        OrbAudio.reset()
        scope.cancel()
    }

    companion object {
        private const val TAG = "MythosNode"

        /**
         * How long a hold-to-talk turn may go unanswered before the phone says so.
         * Generous on purpose: a slow brain lane plus TTS synthesis is seconds, and
         * a false timeout that cuts off a real reply is worse than a late error.
         */
        private const val REPLY_TIMEOUT_MS = 45_000L

        /**
         * Only used if the operator answers an approval before the activity's
         * binding has landed — the server's own TTL is the ceiling either way.
         * Deliberately shorter than any plausible LEASH_CONFIRM_TTL_MS so the
         * fallback can lapse EARLY (honest: "gone, ask again") rather than late
         * (a live-looking button over a swept confirm).
         */
        private const val APPROVAL_TTL_FALLBACK_MS = 30_000L

        /** How long a resolved sheet stays up, so the outcome can be read. */
        private const val APPROVAL_LINGER_MS = 4_000L

        private const val BUZZ_MS = 220L

        const val ACTION_START_LISTENING = "com.mythos.nodes.phone.START_LISTENING"
        const val ACTION_STOP_LISTENING = "com.mythos.nodes.phone.STOP_LISTENING"
        const val ACTION_CONFIRM_REPLY = "com.mythos.nodes.phone.CONFIRM_REPLY"
        const val EXTRA_CONFIRM_ID = "confirmId"
        const val EXTRA_ACCEPT = "accept"

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

        private val _linkError = MutableStateFlow<String?>(null)
        /** Why the socket is down, shown verbatim under the NO LINK chip. A red
         *  chip with no reason sent a live session hunting the server for a
         *  failure that never left the phone. */
        val linkError: StateFlow<String?> = _linkError.asStateFlow()

        private val _micStatus = MutableStateFlow("")
        /** Non-empty only when something is actually wrong with the mic path. */
        val micStatus: StateFlow<String> = _micStatus.asStateFlow()

        private val _wakeStatus = MutableStateFlow("off")
        /** Verbatim in the UI — colour alone cannot say WHY hands-free is off. */
        val wakeStatus: StateFlow<String> = _wakeStatus.asStateFlow()

        private val _wakeAvailable = MutableStateFlow(false)
        /** Whether [wakeStatus] is reporting a working detector or a reason it is
         *  not. The UI dims this line when healthy and restores it when not, and
         *  that decision must come from here rather than from reading the label. */
        val wakeAvailable: StateFlow<Boolean> = _wakeAvailable.asStateFlow()

        private val _wakeSuppressed = MutableStateFlow(0)
        /** Detections that did not become a turn: own playback, retrigger, or lost
         *  the arbitration. Visible so "it heard me and stayed quiet" is
         *  distinguishable from "it never heard me". */
        val wakeSuppressed: StateFlow<Int> = _wakeSuppressed.asStateFlow()

        private val _connection = MutableStateFlow(NodeLink.Status.DISCONNECTED)
        val connection: StateFlow<NodeLink.Status> = _connection.asStateFlow()

        private val _identified = MutableStateFlow(false)
        val identified: StateFlow<Boolean> = _identified.asStateFlow()

        private val _approval = MutableStateFlow<Approval?>(null)
        /** Non-null while a tier-3/4 action is waiting on the operator. */
        val approval: StateFlow<Approval?> = _approval.asStateFlow()
    }
}
