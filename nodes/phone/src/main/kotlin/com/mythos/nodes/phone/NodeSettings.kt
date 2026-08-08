package com.mythos.nodes.phone

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * What this node needs to know to exist: where MYTHOS is, how to prove itself,
 * who it is, and the beacon it watches for.
 *
 * The auth token is the same secret that guards MYTHOS's whole tool surface, so
 * it lives in EncryptedSharedPreferences and is never logged. Everything else is
 * ordinary configuration and shares that store only for simplicity.
 *
 * The realm key is here too, for the same reason the watch has one: this phone
 * VERIFIES beacon payloads locally (§11.2) rather than forwarding anything it
 * happens to see. Without it the scanner reports nothing at all — an unverified
 * advertisement must never reach the election.
 */
// `context` is a property, not a bare constructor param: openPrefs() below is a
// member function, and Kotlin only lets initializers capture a non-val parameter.
class NodeSettings(private val context: Context) {

    /**
     * Why this is guarded rather than a bare `create()`: the Android keystore can
     * become unreadable in real, ordinary situations — a device restored from
     * backup, a keystore reset after a lock-screen change, or the known
     * androidx.security failure where the master key exists but the prefs file was
     * encrypted under a previous one. `create()` throws then, and because it is
     * reached from the service's start path an uncaught throw kills the node at
     * launch with nothing to read.
     *
     * The recovery is to delete the unreadable file and start clean: the contents
     * are the server address, node id and token — configuration the operator can
     * re-enter in a minute — so losing them beats a node that cannot boot. It is
     * deliberately NOT a fallback to plaintext SharedPreferences: the auth token
     * guards MYTHOS's entire tool surface, and silently downgrading where it is
     * stored would be the wrong trade made invisibly.
     */
    private val prefs by lazy { openPrefs() }

    /** Non-null when the encrypted store had to be reset, for the UI to show. */
    var storeWarning: String? = null
        private set

    private fun openPrefs(): android.content.SharedPreferences {
        fun build() = EncryptedSharedPreferences.create(
            context,
            PREFS_NAME,
            MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
        return try {
            build()
        } catch (first: Exception) {
            // One retry, after clearing the unreadable file. If it fails again the
            // device genuinely cannot provide a keystore and there is nothing
            // honest left to do but surface it.
            runCatching {
                context.deleteSharedPreferences(PREFS_NAME)
            }
            storeWarning = "secure storage was reset — re-enter this node's settings"
            build()
        }
    }

    /**
     * Build-time prefill, used ONLY when the operator has stored nothing for that
     * field yet. Stored values always win, so editing a field in Settings is
     * permanent and a stale baked-in default can never override it — the failure
     * mode that would make this feature worse than typing.
     *
     * Empty in release builds by construction (see phone/build.gradle.kts), and
     * empty in debug too unless the operator put the values in the gitignored
     * nodes/local.properties themselves.
     */
    private fun stored(key: String, prefill: String): String {
        val v = prefs.getString(key, null)
        if (v != null) return v
        return prefill
    }

    /** e.g. `ws://192.168.0.10:4478` — scheme included, no path. */
    var serverUrl: String
        get() = stored(KEY_SERVER, BuildConfig.PREFILL_SERVER_URL)
        set(v) = prefs.edit().putString(KEY_SERVER, v.trim().trimEnd('/')).apply()

    var authToken: String
        get() = stored(KEY_TOKEN, BuildConfig.PREFILL_AUTH_TOKEN)
        set(v) = prefs.edit().putString(KEY_TOKEN, v.trim()).apply()

    /**
     * Must match this device's entry in MYTHOS's AETHER_NODE_IDS exactly —
     * including its POSITION there, which decides the proxy port the aggregator
     * dials. One string per device, everywhere.
     */
    var nodeId: String
        get() = stored(KEY_NODE_ID, BuildConfig.PREFILL_NODE_ID)
        set(v) = prefs.edit().putString(KEY_NODE_ID, v.trim()).apply()

    /** The tracked beacon's name, used to derive uid_hash. Not a secret. */
    var beaconName: String
        get() = stored(KEY_BEACON, BuildConfig.PREFILL_BEACON_NAME.ifEmpty { DEFAULT_BEACON_NAME })
        set(v) = prefs.edit().putString(KEY_BEACON, v.trim().ifEmpty { DEFAULT_BEACON_NAME }).apply()

    var hapticsEnabled: Boolean
        get() = prefs.getBoolean(KEY_HAPTICS, true)
        set(v) = prefs.edit().putBoolean(KEY_HAPTICS, v).apply()

    /** 32-byte realm key, or null until provisioned. */
    fun realmKey(): ByteArray? {
        // Same precedence as every other field, and the same validation: a
        // prefilled key that is the wrong length or not hex is treated as absent
        // rather than half-trusted, so the scanner reports nothing instead of
        // failing every verification and looking like an empty room.
        val hex = prefs.getString(KEY_REALM, null)
            ?: BuildConfig.PREFILL_REALM_KEY.takeIf { it.isNotEmpty() }
            ?: return null
        return runCatching { hexToBytes(hex) }.getOrNull()?.takeIf { it.size == REALM_KEY_BYTES }
    }

    fun hasRealmKey(): Boolean = realmKey() != null

    /**
     * Accepts the 64-hex-char `realm_key` from `~/.aether/realm.json`. Rejects —
     * and stores — nothing otherwise: a wrong key makes every payload fail
     * verification, which is indistinguishable from "no beacon nearby" unless the
     * failure is refused up front.
     */
    fun setRealmKeyHex(hex: String): Boolean {
        val cleaned = hex.trim().removePrefix("0x")
        if (cleaned.length != REALM_KEY_BYTES * 2) return false
        if (!cleaned.all { it.isDigit() || it in 'a'..'f' || it in 'A'..'F' }) return false
        prefs.edit().putString(KEY_REALM, cleaned.lowercase()).apply()
        return true
    }

    /** Everything needed to talk to MYTHOS is present. */
    fun isConfigured(): Boolean =
        serverUrl.isNotEmpty() && authToken.isNotEmpty() && nodeId.isNotEmpty()

    /** `ws(s)://host:port/ws?token=…` — the token rides the query string because
     *  a WS upgrade cannot carry an Authorization header from every client, and
     *  MYTHOS's extractToken() accepts it there. */
    fun webSocketUrl(): String {
        val base = serverUrl
            .replace(Regex("^http://", RegexOption.IGNORE_CASE), "ws://")
            .replace(Regex("^https://", RegexOption.IGNORE_CASE), "wss://")
        return "$base/ws?token=${android.net.Uri.encode(authToken)}"
    }

    /** Base for REST calls (STT). Kept http(s) whatever the ws scheme is. */
    fun httpBase(): String = serverUrl
        .replace(Regex("^ws://", RegexOption.IGNORE_CASE), "http://")
        .replace(Regex("^wss://", RegexOption.IGNORE_CASE), "https://")

    private fun hexToBytes(hex: String): ByteArray =
        ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    companion object {
        private const val PREFS_NAME = "mythos_node"
        const val REALM_KEY_BYTES = 32
        const val DEFAULT_BEACON_NAME = "mythos-wrist"
        private const val KEY_SERVER = "server_url"
        private const val KEY_TOKEN = "auth_token"
        private const val KEY_NODE_ID = "node_id"
        private const val KEY_BEACON = "beacon_name"
        private const val KEY_REALM = "realm_key"
        private const val KEY_HAPTICS = "haptics"
    }
}
