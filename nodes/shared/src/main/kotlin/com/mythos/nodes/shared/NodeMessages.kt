package com.mythos.nodes.shared

/**
 * The MYTHOS `/ws` wire shapes a voice node uses.
 *
 * Deliberately hand-built JSON with no serialization library: these are four
 * tiny flat objects, the field names are a contract with `mythos/server/index.js`
 * (grep `node-reading` there), and a dependency whose only job is to emit
 * `{"type":"node-reading",...}` earns nothing. The escaping below is the reason
 * this is a shared, tested object rather than string concatenation at each call
 * site — a device name containing a quote must not produce a frame the server
 * silently fails to parse.
 *
 * Note these are MYTHOS messages, not Aether protocol messages. The node never
 * speaks Aether's §4 `reading`/`lost` shape — MYTHOS's scanner-proxy translates,
 * because a phone cannot be an Aether scanner (it cannot be dialled). See
 * `mythos/src/core/aether/scanner-proxy.js`.
 */
public object NodeMessages {

    /** Minimal JSON string escaping — quotes, backslashes, and control chars. */
    public fun jsonEscape(raw: String): String {
        val sb = StringBuilder(raw.length + 8)
        for (ch in raw) {
            when (ch) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                else -> if (ch < ' ') sb.append("\\u%04x".format(ch.code)) else sb.append(ch)
            }
        }
        return sb.toString()
    }

    /**
     * A verified BLE observation of the tracked beacon. Only ever sent for a
     * payload that passed [BeaconAuth.verifyBeacon] — an unauthenticated
     * advertisement must never reach the election.
     */
    public fun reading(nodeId: String, rssi: Double, name: String): String =
        """{"type":"node-reading","nodeId":"${jsonEscape(nodeId)}","rssi":$rssi,"name":"${jsonEscape(name)}"}"""

    /** This node can no longer see the beacon. */
    public fun lost(nodeId: String): String =
        """{"type":"node-lost","nodeId":"${jsonEscape(nodeId)}"}"""

    /** Claim a node identity on this socket, so speech can be routed back to it. */
    public fun identify(nodeId: String): String =
        """{"type":"identify","role":"node","nodeId":"${jsonEscape(nodeId)}"}"""

    /**
     * This node heard the wake phrase. A REPORT, not a claim — MYTHOS asks Aether
     * to rank every device that heard it, and only the winner listens. A node that
     * decided for itself would mean four devices answering one phrase.
     */
    public fun wake(nodeId: String): String =
        """{"type":"node-wake","nodeId":"${jsonEscape(nodeId)}"}"""

    /**
     * Claim a node identity, declaring what this build can play.
     *
     * `caps` is the whole reason a phone can be answered by Gemini Live: the
     * server refuses to route a node into Live unless the client says it can
     * render Live's raw PCM frames, because a build that cannot is answered into
     * silence. An older APK sends no caps and keeps the batch path, so upgrading
     * MYTHOS never breaks a phone that is already in someone's pocket.
     */
    public fun identify(nodeId: String, caps: List<String>): String {
        val list = caps.joinToString(",") { "\"${jsonEscape(it)}\"" }
        return """{"type":"identify","role":"node","nodeId":"${jsonEscape(nodeId)}","caps":[$list]}"""
    }

    /**
     * Approve or decline a pending tier-3/4 action.
     *
     * THE FIELD IS `confirmId`, NOT `id`. The direction flips: MYTHOS broadcasts
     * the request as `{"type":"confirm-request","payload":{"id":…}}` and reads
     * the reply as `msg.confirmId` (server/index.js `handleConfirmReply`). A
     * client that echoes the inbound name back destructures to `undefined`, and
     * `leash.confirm.accept(undefined)` returns null — which was, until the
     * `confirm-resolved` frame existed, a completely SILENT no-op. The sheet
     * closes, the operator believes they approved, and the message is never
     * sent. Nothing in a build or a green suite catches that, which is why the
     * exact shape is pinned in NodeMessagesTest.
     */
    public fun confirmReply(confirmId: String, accept: Boolean): String =
        """{"type":"confirm-reply","confirmId":"${jsonEscape(confirmId)}","accept":$accept}"""

    /** A transcribed utterance from this node's microphone. */
    public fun utterance(reqId: String, text: String): String =
        """{"type":"utterance","reqId":"${jsonEscape(reqId)}","text":"${jsonEscape(text)}"}"""

    /**
     * Abandon a turn already in flight — the operator started talking again.
     *
     * MYTHOS aborts the chunks it has not synthesized yet, so it stops speaking
     * into a listener that has moved on instead of finishing the sentence.
     */
    public fun stop(reqId: String): String =
        """{"type":"stop","reqId":"${jsonEscape(reqId)}"}"""
}
