package com.mythos.nodes.phone

import android.bluetooth.BluetoothManager
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import com.mythos.nodes.shared.BeaconAuth

/**
 * Watches for the wrist beacon and reports verified sightings.
 *
 * THE VERIFICATION IS THE POINT, and it happens HERE rather than on the server.
 * §11.2 requires a receiver to reject a payload that is the wrong length, has the
 * wrong magic or version, replays a counter, or fails its HMAC — and MYTHOS's
 * scanner-proxy trusts whatever a node pushes, because a node has already proved
 * itself with the auth token. So if this class forwarded unverified sightings, any
 * nearby device broadcasting 19 bytes on manufacturer ID 0xFFFF could drive the
 * election. It does not: [onVerified] fires only for a payload that passed.
 *
 * The counter is held in memory only, unlike the beacon's. That is deliberate and
 * the asymmetry is not an oversight: a scanner that forgets its last-accepted
 * counter re-accepts one already-seen payload after a restart, which costs
 * nothing (an attacker replaying a 5-second-old RSSI reading achieves an accurate
 * RSSI reading). A BEACON that forgets its counter re-emits values every scanner
 * will then reject, which silences it. Persist the transmitter's, not the
 * receiver's.
 *
 * Rejections are counted, never logged per event: a malfunctioning or malicious
 * device nearby is expected background noise (§11.2), and logging each one would
 * bury everything else. The count is surfaced in the UI so a mismatched realm key
 * is diagnosable — "seeing payloads, rejecting all of them" is a very different
 * problem from "seeing nothing".
 */
class BeaconScanner(
    private val context: Context,
    private val settings: NodeSettings,
    private val onVerified: (rssi: Double, deviceName: String) -> Unit,
    private val onRejected: (reason: String) -> Unit,
) {

    private var scanner: BluetoothLeScanner? = null
    private var lastCounter = 0L
    private var expectedUidHash: Long = 0L
    private var realmKey: ByteArray? = null

    /** Returns false when it cannot possibly work, so the caller can say why. */
    fun start(): Boolean {
        val key = settings.realmKey() ?: return false
        realmKey = key
        expectedUidHash = BeaconAuth.uidHashFromName(settings.beaconName)
        val adapter = context.getSystemService(BluetoothManager::class.java)?.adapter ?: return false
        if (!adapter.isEnabled) return false
        scanner = adapter.bluetoothLeScanner ?: return false

        // BALANCED, not LOW_LATENCY. This runs for hours on a phone that may be
        // on battery; the beacon advertises every few hundred ms, so the extra
        // duty cycle buys precision nobody can perceive in a room-sized decision.
        val scanSettings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_BALANCED)
            .build()
        return try {
            scanner?.startScan(emptyList(), scanSettings, callback)
            true
        } catch (e: SecurityException) {
            // BLUETOOTH_SCAN not granted — recoverable from the UI.
            false
        }
    }

    fun stop() {
        try {
            scanner?.stopScan(callback)
        } catch (e: SecurityException) {
            // Losing the permission while stopping changes nothing worth saying.
        }
        scanner = null
    }

    private val callback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            handle(result)
        }

        override fun onBatchScanResults(results: MutableList<ScanResult>) {
            results.forEach { handle(it) }
        }
    }

    private fun handle(result: ScanResult) {
        val payload = result.scanRecord?.getManufacturerSpecificData(AETHER_MFG_ID) ?: return
        val key = realmKey ?: return

        val verdict = BeaconAuth.verifyBeacon(payload, key, lastCounter)
        if (!verdict.ok) {
            onRejected(verdict.reason ?: "unknown")
            return
        }
        // A valid payload for a DIFFERENT beacon is not ours to report. Single-user
        // this phase, but forwarding it would attribute someone else's proximity to
        // this operator.
        if (verdict.uidHash != expectedUidHash) {
            onRejected("wrong_beacon")
            return
        }
        lastCounter = verdict.counter ?: lastCounter
        onVerified(result.rssi.toDouble(), settings.beaconName)
    }

    companion object {
        /**
         * Must equal `aether-bridge/bridge.py`'s AETHER_MFG_ID and the watch's
         * MANUFACTURER_ID. 0xFFFF is the SIG's reserved test id, which is correct
         * for a project with no assigned company id.
         */
        const val AETHER_MFG_ID = 0xFFFF
    }
}
