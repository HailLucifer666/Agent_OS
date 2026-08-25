package com.mythos.nodes.phone

/**
 * The rules for the operator-typed server URL, with no Android dependency, so
 * they can be unit-tested.
 *
 * They live here rather than in NodeSettings because NodeSettings needs an
 * Android Context for EncryptedSharedPreferences and cannot be constructed in a
 * plain JVM test — which is why these rules had no test, and why the bug below
 * survived to be found in a live debugging session instead.
 *
 * THE BUG. `serverUrl` is typed by a human, and the natural way to get it wrong
 * is to omit the scheme: `192.168.0.10:4478`. webSocketUrl() only rewrites
 * http/https into ws/wss, so a scheme-less value passed through unchanged to
 * OkHttp's `Request.Builder().url()`, which throws IllegalArgumentException on
 * it. In NodeLink.openSocket() that throw landed AFTER the status was set to
 * CONNECTING and BEFORE any socket existed, so the phone showed "LINKING"
 * forever: no error text, no socket, and — because every retry is scheduled from
 * a socket listener callback — no attempt ever again. From MYTHOS's side there
 * was neither a rejection nor an attempt to find in the log, which looks exactly
 * like a sleeping phone.
 */
object ServerUrl {

    /**
     * The schemes webSocketUrl()/httpBase() know how to map between. Anything
     * else is refused rather than handed to the request builder to throw on:
     * no scheme at all, and also schemes OkHttp does not speak (file:,
     * javascript:, content:) which a paste or an autocomplete can produce.
     */
    private val SUPPORTED = listOf("ws://", "wss://", "http://", "https://")

    fun hasSupportedScheme(url: String): Boolean =
        SUPPORTED.any { url.startsWith(it, ignoreCase = true) }

    /**
     * Null when the URL is usable, otherwise a sentence naming what to type. The
     * settings UI shows this string, so it is an instruction, not a diagnosis —
     * "Expected URL scheme" (OkHttp's own wording) tells an operator nothing
     * about which field to edit or what to put in it.
     *
     * Deliberately does NOT repair the URL by prepending a scheme. ws:// and
     * wss:// are not interchangeable, and quietly choosing the plaintext one for
     * someone who meant TLS is a worse outcome than asking them to type it.
     */
    fun problem(url: String): String? {
        if (url.isEmpty()) return "Server URL is empty — enter ws://<pc-ip>:4478"
        if (!hasSupportedScheme(url)) {
            return "Server URL needs a scheme: write ws://$url (or wss:// for TLS)"
        }
        return null
    }

    /** http(s) -> ws(s). Any already-ws(s) URL is returned unchanged. */
    fun toWebSocketScheme(url: String): String = url
        .replace(Regex("^http://", RegexOption.IGNORE_CASE), "ws://")
        .replace(Regex("^https://", RegexOption.IGNORE_CASE), "wss://")

    /** ws(s) -> http(s), for the REST (STT) calls. */
    fun toHttpScheme(url: String): String = url
        .replace(Regex("^ws://", RegexOption.IGNORE_CASE), "http://")
        .replace(Regex("^wss://", RegexOption.IGNORE_CASE), "https://")
}
