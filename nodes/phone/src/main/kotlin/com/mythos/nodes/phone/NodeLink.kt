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

    private var webSocket: WebSocket? = null
    private var closedByUs = false
    private var attempt = 0

    private val _status = MutableStateFlow(Status.DISCONNECTED)
    val status: StateFlow<Status> = _status.asStateFlow()

    /**
     * Every inbound frame, parsed. extraBufferCapacity because speech chunks
     * arrive in bursts and a collector that is momentarily busy decoding audio
     * must not make the socket thread drop the next one.
     */
    private val _inbound = MutableSharedFlow<JSONObject>(extraBufferCapacity = 64)
    val inbound: SharedFlow<JSONObject> = _inbound.asSharedFlow()

    fun connect() {
        if (!settings.isConfigured()) {
            _status.value = Status.DISCONNECTED
            return
        }
        closedByUs = false
        openSocket()
    }

    private fun openSocket() {
        _status.value = Status.CONNECTING
        val request = Request.Builder()
            .url(settings.webSocketUrl())
            // Also sent as a header, for the HTTP routes and in case a future
            // MYTHOS stops accepting ?token=. Harmless duplication.
            .addHeader("Authorization", "Bearer ${settings.authToken}")
            .build()
        webSocket = client.newWebSocket(request, listener)
    }

    private val listener = object : WebSocketListener() {
        override fun onOpen(ws: WebSocket, response: Response) {
            attempt = 0
            _status.value = Status.CONNECTED
            // Claim our identity immediately. Until this lands the server has no
            // socket for this node id and will speak replies locally instead —
            // correct behaviour, but only briefly.
            ws.send(NodeMessages.identify(settings.nodeId))
        }

        override fun onMessage(ws: WebSocket, text: String) {
            val json = runCatching { JSONObject(text) }.getOrNull() ?: return
            _inbound.tryEmit(json)
        }

        override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
            _status.value = Status.DISCONNECTED
            scheduleReconnect()
        }

        override fun onClosed(ws: WebSocket, code: Int, reason: String) {
            _status.value = Status.DISCONNECTED
            scheduleReconnect()
        }
    }

    private fun scheduleReconnect() {
        if (closedByUs) return
        // Capped at 5s: this is a device on a home LAN that should recover
        // quickly, not a client politely backing off a busy public API.
        val delayMs = min(RECONNECT_MAX_MS, RECONNECT_BASE_MS shl min(attempt, 5))
        attempt++
        Thread {
            Thread.sleep(delayMs)
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

    fun sendUtterance(reqId: String, text: String): Boolean =
        send(NodeMessages.utterance(reqId, text))

    fun disconnect() {
        closedByUs = true
        runCatching { webSocket?.close(1000, "node stopping") }
        webSocket = null
        _status.value = Status.DISCONNECTED
    }

    companion object {
        private const val RECONNECT_BASE_MS = 250L
        private const val RECONNECT_MAX_MS = 5_000L
    }
}
