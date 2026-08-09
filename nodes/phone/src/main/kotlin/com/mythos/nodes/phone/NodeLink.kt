package com.mythos.nodes.phone

import com.mythos.nodes.shared.NodeMessages
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import kotlin.math.min

/**
 * The node's single connection to MYTHOS. One socket carries everything, both
 * directions: proximity readings and utterances up, speech chunks and (later)
 * wake outcomes and handoff phases down.
 *
 * One socket rather than several because MYTHOS identifies a node BY its socket —
 * `voiceNodes` maps nodeId to the connection that claimed it, and that is the
 * address replies are delivered to. A second connection would just be a second
 * candidate for the same id, which the server reports as an anomaly.
 *
 * RECONNECT IS THE NORMAL CASE, not an error path: phones sleep, Wi-Fi roams
 * between APs, and MYTHOS restarts. So backoff is capped low (5s) rather than
 * growing without bound, `identify` is re-sent on every open (the server has
 * forgotten us), and pings keep NAT and doze from silently killing an idle
 * socket while leaving it "open".
 */
class NodeLink(private val settings: NodeSettings) {

    enum class Status { DISCONNECTED, CONNECTING, CONNECTED }

    private val client = OkHttpClient.Builder()
        // Without this an idle socket dies invisibly: the phone keeps a dead
        // connection it believes is live, and the reply for the room it is
        // standing in goes nowhere.
        .pingInterval(20, TimeUnit.SECONDS)
        .build()

    // Written from OkHttp's dispatcher threads and read from the reconnect
    // thread and the UI's callers, so none of these may be cached per-thread.
    @Volatile private var webSocket: WebSocket? = null
    @Volatile private var closedByUs = false
    @Volatile private var attempt = 0
    @Volatile private var reconnectPending = false

    private val _status = MutableStateFlow(Status.DISCONNECTED)
    val status: StateFlow<Status> = _status.asStateFlow()

    /**
     * Every inbound frame, parsed. extraBufferCapacity because speech chunks
     * arrive in bursts and a collector that is momentarily busy decoding audio
     * must not make the socket thread drop the next one.
     */
    private val _inbound = MutableSharedFlow<JSONObject>(extraBufferCapacity = 64)
    val inbound: SharedFlow<JSONObject> = _inbound.asSharedFlow()

    /**
     * Why the socket last failed, verbatim from the throwable, or null while
     * connected.
     *
     * This exists because its absence cost a live debugging session. onFailure
     * received the Throwable and discarded it, so every distinct cause —
     * cleartext blocked by network policy, wrong port, no route to host, a 401
     * from a mistyped token — collapsed into the same red "NO LINK" chip with
     * nothing to read. The server side is no help for the failures that never
     * reach it: its log shows no rejection AND no attempt, which is
     * indistinguishable from the phone being asleep.
     *
     * The HTTP status is included when there is one: it is the difference
     * between "rejected" (a credential problem) and "never arrived" (a network
     * or policy problem), which are opposite fixes.
     */
    private val _lastError = MutableStateFlow<String?>(null)
    val lastError: StateFlow<String?> = _lastError.asStateFlow()

    fun connect() {
        // Idempotent on purpose: a second call used to open a second socket and
        // drop the reference to the first without closing it, so the server saw
        // two live sockets claiming one node id. The caller is now guarded too
        // (VoiceNodeService.wired), but a link that leaks sockets when called
        // twice is a trap for the next caller.
        if (webSocket != null && _status.value != Status.DISCONNECTED) return
        if (!settings.isConfigured()) {
            _status.value = Status.DISCONNECTED
            return
        }
        closedByUs = false
        openSocket()
    }

    @Synchronized
    private fun openSocket() {
        // Close whatever we are replacing. Without this every reconnect LEAKED a
        // live socket: the field was overwritten, but the old connection stayed
        // open on both ends, still delivering frames into the same _inbound. The
        // device then played one reply once per leaked socket.
        val previous = webSocket
        webSocket = null
        if (previous != null) runCatching { previous.cancel() }

        _status.value = Status.CONNECTING
        val request = Request.Builder()
            .url(settings.webSocketUrl())
            // Also sent as a header, for the HTTP routes and in case a future
            // MYTHOS stops accepting ?token=. Harmless duplication.
            .addHeader("Authorization", "Bearer ${settings.authToken}")
            .build()
        webSocket = client.newWebSocket(request, listener)
    }

    /**
     * One listener instance serves every socket this link ever opens, so each
     * callback MUST establish that it speaks for the current one.
     *
     * Without that check a dead socket's `onClosed` set the whole link
     * DISCONNECTED and scheduled a reconnect while a healthy socket was already
     * carrying traffic — and once the server started closing superseded sockets,
     * each close produced another socket, which superseded another, forever. It
     * also flipped the UI's connection chip on and off fast enough that the error
     * text under it could not be read.
     */
    private val listener = object : WebSocketListener() {
        override fun onOpen(ws: WebSocket, response: Response) {
            if (ws !== webSocket) return
            _lastError.value = null
            _status.value = Status.CONNECTED
            // Claim our identity immediately. Until this lands the server has no
            // socket for this node id and will speak replies locally instead —
            // correct behaviour, but only briefly.
            // LIVE_AUDIO says this build has LivePcmPlayer, so MYTHOS may answer
            // through Gemini Live instead of the batch lane.
            ws.send(NodeMessages.identify(settings.nodeId, listOf(CAP_LIVE_AUDIO)))
        }

        override fun onMessage(ws: WebSocket, text: String) {
            if (ws !== webSocket) return
            // Backoff resets here rather than in onOpen: a socket that opens and
            // immediately dies is not a working socket, and treating it as one
            // pinned the delay at its 250ms floor for as long as the failure
            // lasted. A frame we can read is the first real proof of health.
            attempt = 0
            val json = runCatching { JSONObject(text) }.getOrNull() ?: return
            _inbound.tryEmit(json)
        }

        override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
            if (ws !== webSocket) return
            val code = response?.code
            val detail = t.message?.takeIf { it.isNotBlank() } ?: t.javaClass.simpleName
            _lastError.value = when {
                // Distinguish the credential failures from the network ones, since
                // the fix is a different field in a different place.
                code == 401 -> "401 — the auth token does not match MYTHOS_AUTH_TOKEN"
                code == 403 -> "403 — refused; set AETHER_NODE_TRUST=true on MYTHOS"
                code == 429 -> "429 — too many attempts; wait a moment"
                code != null -> "HTTP $code — $detail"
                else -> detail
            }
            _status.value = Status.DISCONNECTED
            scheduleReconnect()
        }

        override fun onClosed(ws: WebSocket, code: Int, reason: String) {
            if (ws !== webSocket) return
            _status.value = Status.DISCONNECTED
            // MYTHOS closes a socket with exactly this code and reason when a
            // NEWER socket of ours claimed the same node id. Reconnecting would
            // mean racing our own replacement.
            if (code == 1000 && reason == SUPERSEDED) return
            scheduleReconnect()
        }
    }

    @Synchronized
    private fun scheduleReconnect() {
        if (closedByUs) return
        // One pending reconnect at a time. Several callbacks can report the same
        // dead socket, and each used to start its own thread — every one of which
        // opened a real socket.
        if (reconnectPending) return
        reconnectPending = true
        // Capped at 5s: this is a device on a home LAN that should recover
        // quickly, not a client politely backing off a busy public API.
        val delayMs = min(RECONNECT_MAX_MS, RECONNECT_BASE_MS shl min(attempt, 5))
        attempt++
        Thread {
            Thread.sleep(delayMs)
            reconnectPending = false
            if (!closedByUs) openSocket()
        }.apply { isDaemon = true }.start()
    }

    /** True only if the frame was handed to an OPEN socket. */
    private fun send(payload: String): Boolean {
        val ws = webSocket ?: return false
        if (_status.value != Status.CONNECTED) return false
        return runCatching { ws.send(payload) }.getOrDefault(false)
    }

    fun sendReading(rssi: Double, name: String): Boolean =
        send(NodeMessages.reading(settings.nodeId, rssi, name))

    fun sendLost(): Boolean = send(NodeMessages.lost(settings.nodeId))

    fun sendWake(): Boolean = send(NodeMessages.wake(settings.nodeId))

    fun sendUtterance(reqId: String, text: String): Boolean =
        send(NodeMessages.utterance(reqId, text))

    fun sendStop(reqId: String): Boolean = send(NodeMessages.stop(reqId))

    /** The operator's answer to a tier-3/4 approval. See NodeMessages.confirmReply. */
    fun sendConfirmReply(confirmId: String, accept: Boolean): Boolean =
        send(NodeMessages.confirmReply(confirmId, accept))

    fun disconnect() {
        closedByUs = true
        runCatching { webSocket?.close(1000, "node stopping") }
        webSocket = null
        _status.value = Status.DISCONNECTED
    }

    companion object {
        private const val RECONNECT_BASE_MS = 250L
        private const val RECONNECT_MAX_MS = 5_000L

        /** Close reason MYTHOS uses when a newer socket claims the same node id. */
        const val SUPERSEDED = "superseded"

        /** This build can render Gemini Live's raw 24kHz PCM (LivePcmPlayer). */
        const val CAP_LIVE_AUDIO = "live-audio"
    }
}
