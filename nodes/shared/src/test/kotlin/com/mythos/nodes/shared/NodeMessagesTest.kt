package com.mythos.nodes.shared

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class NodeMessagesTest {

    @Test
    fun `reading carries the exact field names the server dispatches on`() {
        assertEquals(
            """{"type":"node-reading","nodeId":"kitchen-phone","rssi":-61.5,"name":"Pixel Watch"}""",
            NodeMessages.reading("kitchen-phone", -61.5, "Pixel Watch"),
        )
    }

    @Test
    fun `a quote in a device name cannot break the frame`() {
        // A BLE advertised name is attacker-influenced in principle and just
        // user-chosen in practice; either way an unescaped quote would produce a
        // frame the server drops in its `catch { return }`, so the node would go
        // silent for a reason nobody could see.
        val msg = NodeMessages.reading("n", -50.0, """say "hi" \ now""" + "\n")
        assertTrue(msg.contains("""\"hi\""""), "quotes must be escaped: $msg")
        assertTrue(msg.contains("""\\"""), "backslash must be escaped: $msg")
        assertTrue(msg.contains("""\n"""), "newline must be escaped: $msg")
        // Exactly the four structural quotes plus the escaped pair.
        assertEquals(0, msg.count { it == '\n' })
    }

    @Test
    fun `control characters are escaped as unicode`() {
        val msg = NodeMessages.reading("n", -50.0, "a\u0001b")
        assertTrue(msg.contains("\\u0001"), msg)
    }

    @Test
    fun `wake interpolates the node id rather than emitting a literal template`() {
        // Caught in review: a raw-string escaping slip produced the literal text
        // ${jsonEscape(nodeId)} instead of the value, which the server would then
        // treat as an unknown node id and silently drop — a wake word that reports
        // nothing, with no error anywhere.
        val msg = NodeMessages.wake("kitchen-phone")
        assertEquals("""{"type":"node-wake","nodeId":"kitchen-phone"}""", msg)
        assertFalse(msg.contains("jsonEscape"), "template leaked into the payload: $msg")
    }

    @Test
    fun `lost identify and utterance shapes`() {
        assertEquals("""{"type":"node-lost","nodeId":"desk-phone"}""", NodeMessages.lost("desk-phone"))
        assertEquals(
            """{"type":"identify","role":"node","nodeId":"desk-phone"}""",
            NodeMessages.identify("desk-phone"),
        )
        assertEquals(
            """{"type":"utterance","reqId":"r1","text":"what time is it"}""",
            NodeMessages.utterance("r1", "what time is it"),
        )
    }
}
