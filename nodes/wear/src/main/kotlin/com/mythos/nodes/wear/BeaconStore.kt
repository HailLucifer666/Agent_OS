package com.mythos.nodes.wear

import android.content.Context
import android.util.Base64
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.coroutines.flow.first

private val Context.beaconDataStore by preferencesDataStore(name = "mythos_beacon")

/**
 * Persistent state for the wrist beacon: the monotonic counter, and the realm
 * key.
 *
 * THE COUNTER IS THE SECURITY-RELEVANT PART. §11.2 requires it to be strictly
 * increasing per uid_hash and to survive a restart — a receiver rejects
 * `counter <= last_accepted`, so resetting to zero on reboot would make the
 * watch invisible until the counter climbed past whatever the scanners last
 * saw, and (worse) would reopen the replay window for every payload broadcast
 * before the reboot. So it is read once at service start, and every allocation
 * is written back before the value is used on air, never after.
 *
 * The two live in different stores on purpose: the counter is ordinary state
 * (DataStore), while the realm key is the mesh's shared secret and belongs in
 * EncryptedSharedPreferences. Neither is ever logged.
 */
class BeaconStore(private val context: Context) {

    private val counterKey = longPreferencesKey("beacon_counter")
    private val beaconNameKey = stringPreferencesKey("beacon_name")

    private val securePrefs by lazy {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            "mythos_beacon_secure",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    suspend fun lastCounter(): Long =
        context.beaconDataStore.data.first()[counterKey] ?: 0L

    /**
     * Reserve the next counter value and PERSIST IT FIRST.
     *
     * Ordering is the whole point: if the process died between advertising a
     * counter and persisting it, the next boot would reuse a value already seen
     * on air and every scanner would reject it as a replay. Persist, then
     * advertise.
     */
    suspend fun nextCounter(): Long {
        var reserved = 0L
        context.beaconDataStore.edit { prefs ->
            reserved = (prefs[counterKey] ?: 0L) + 1L
            prefs[counterKey] = reserved
        }
        return reserved
    }

    suspend fun beaconName(): String =
        context.beaconDataStore.data.first()[beaconNameKey] ?: DEFAULT_BEACON_NAME

    suspend fun setBeaconName(name: String) {
        context.beaconDataStore.edit { it[beaconNameKey] = name }
    }

    /** The 32-byte realm key, or null until the watch has been provisioned. */
    fun realmKey(): ByteArray? {
        val encoded = securePrefs.getString(REALM_KEY_PREF, null) ?: return null
        return runCatching { Base64.decode(encoded, Base64.NO_WRAP) }
            .getOrNull()
            ?.takeIf { it.size == REALM_KEY_BYTES }
    }

    fun hasRealmKey(): Boolean = realmKey() != null

    /**
     * Store a realm key supplied as 64 hex characters (the shape in
     * `~/.aether/realm.json`). Returns false — and stores nothing — on anything
     * that is not exactly a 32-byte hex value, so a truncated adb paste fails
     * visibly instead of leaving the watch advertising payloads no scanner can
     * verify.
     */
    fun setRealmKeyHex(hex: String): Boolean {
        val cleaned = hex.trim().removePrefix("0x")
        if (cleaned.length != REALM_KEY_BYTES * 2) return false
        if (!cleaned.all { it.isDigit() || it in 'a'..'f' || it in 'A'..'F' }) return false
        val bytes = ByteArray(REALM_KEY_BYTES) {
            cleaned.substring(it * 2, it * 2 + 2).toInt(16).toByte()
        }
        securePrefs.edit()
            .putString(REALM_KEY_PREF, Base64.encodeToString(bytes, Base64.NO_WRAP))
            .apply()
        return true
    }

    companion object {
        const val REALM_KEY_BYTES = 32
        private const val REALM_KEY_PREF = "realm_key"

        /**
         * Must match what the scanners use to derive uid_hash — the phone app's
         * configured beacon name and `bridge.py --name`. It is not a secret; the
         * HMAC is what authenticates the payload.
         */
        const val DEFAULT_BEACON_NAME = "mythos-wrist"
    }
}
