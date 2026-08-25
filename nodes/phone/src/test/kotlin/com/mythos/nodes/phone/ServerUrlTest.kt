package com.mythos.nodes.phone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The operator-typed server URL had no validation and no test, and the cost was
 * a phone permanently stuck on "LINKING".
 *
 * `192.168.0.10:4478` — a scheme-less URL, the most natural way to mistype this
 * field — reached OkHttp's `Request.Builder().url()`, which throws on it. In
 * NodeLink.openSocket() the throw landed after `_status` was already CONNECTING
 * and before any socket existed. So: no error text for the operator, no socket,
 * and no listener callback to ever call scheduleReconnect(). The link stopped
 * rather than failed, and from MYTHOS's side there was neither a rejection nor an
 * attempt in the log — indistinguishable from a sleeping phone.
 *
 * These rules were moved out of NodeSettings to be testable at all: NodeSettings
 * needs an Android Context for EncryptedSharedPreferences and cannot be built in
 * a JVM unit test, which is exactly why this never had coverage.
 */
class ServerUrlTest {

    @Test
    fun `accepts the four schemes the app can actually map between`() {
        for (url in listOf(
            "ws://192.168.0.10:4478",
            "wss://mythos.example:443",
            "http://192.168.0.10:4478",
            "https://mythos.example",
        )) {
            assertTrue("$url must be accepted", ServerUrl.hasSupportedScheme(url))
            assertNull("$url must report no problem", ServerUrl.problem(url))
        }
    }

    @Test
    fun `scheme matching is case insensitive`() {
        // Android keyboards capitalise the first letter of a field by default,
        // so WS:// is not a hypothetical.
        assertTrue(ServerUrl.hasSupportedScheme("WS://192.168.0.10:4478"))
        assertTrue(ServerUrl.hasSupportedScheme("Wss://host"))
        assertTrue(ServerUrl.hasSupportedScheme("HTTP://host"))
        assertNull(ServerUrl.problem("WS://192.168.0.10:4478"))
    }

    @Test
    fun `rejects the scheme-less URL that caused the stuck-CONNECTING bug`() {
        val typed = "192.168.0.10:4478"
        assertFalse(ServerUrl.hasSupportedScheme(typed))

        val problem = ServerUrl.problem(typed)
        assertNotNull("a rejected URL must explain itself", problem)
        // The message has to name the fix, not the fault. OkHttp's own wording
        // ("Expected URL scheme 'http' or 'https'") does not tell an operator
        // which field to edit or that ws:// is the answer.
        assertTrue("must show the corrected URL: $problem", problem!!.contains("ws://$typed"))
        assertTrue("must mention the TLS alternative: $problem", problem.contains("wss://"))
    }

    @Test
    fun `rejects a bare hostname and a bare IP`() {
        for (url in listOf("192.168.0.10", "mythos.local", "localhost:4478")) {
            assertFalse("$url must be rejected", ServerUrl.hasSupportedScheme(url))
            assertNotNull(ServerUrl.problem(url))
        }
    }

    @Test
    fun `rejects schemes OkHttp does not speak`() {
        // A paste or an autocomplete can produce these, and every one of them
        // would have thrown out of openSocket() the same way.
        for (url in listOf(
            "file:///sdcard/mythos",
            "javascript:alert(1)",
            "content://com.android.providers/1",
            "ftp://192.168.0.10",
            "//192.168.0.10:4478",
        )) {
            assertFalse("$url must be rejected", ServerUrl.hasSupportedScheme(url))
            assertNotNull("$url must report a problem", ServerUrl.problem(url))
        }
    }

    @Test
    fun `an empty URL says it is empty rather than suggesting a scheme`() {
        val problem = ServerUrl.problem("")
        assertNotNull(problem)
        assertTrue("empty is its own message: $problem", problem!!.contains("empty"))
        // "write ws://" with nothing after it would be nonsense.
        assertFalse(problem.contains("write ws://"))
    }

    @Test
    fun `http maps to ws and https to wss, leaving ws untouched`() {
        assertEquals("ws://h:1", ServerUrl.toWebSocketScheme("http://h:1"))
        assertEquals("wss://h", ServerUrl.toWebSocketScheme("https://h"))
        assertEquals("ws://h:1", ServerUrl.toWebSocketScheme("ws://h:1"))
        assertEquals("wss://h", ServerUrl.toWebSocketScheme("wss://h"))
    }

    @Test
    fun `ws maps back to http for the REST calls`() {
        assertEquals("http://h:1", ServerUrl.toHttpScheme("ws://h:1"))
        assertEquals("https://h", ServerUrl.toHttpScheme("wss://h"))
        assertEquals("http://h:1", ServerUrl.toHttpScheme("http://h:1"))
        assertEquals("https://h", ServerUrl.toHttpScheme("https://h"))
    }

    @Test
    fun `the scheme rewrite only touches the scheme, never the rest of the URL`() {
        // A host or path containing the literal text "http" must survive. The
        // regexes are anchored with ^ for this reason; an unanchored replace
        // would corrupt a URL like the one below.
        assertEquals(
            "ws://http-relay.example:4478/path/https",
            ServerUrl.toWebSocketScheme("http://http-relay.example:4478/path/https"),
        )
        assertEquals(
            "http://ws-relay.example/ws/wss",
            ServerUrl.toHttpScheme("ws://ws-relay.example/ws/wss"),
        )
    }
}
