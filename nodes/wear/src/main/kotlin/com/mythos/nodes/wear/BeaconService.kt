package com.mythos.nodes.wear

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.bluetooth.BluetoothManager
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertisingSet
import android.bluetooth.le.AdvertisingSetCallback
import android.bluetooth.le.AdvertisingSetParameters
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.mythos.nodes.shared.BeaconAuth
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * The wrist beacon. Its entire job is to advertise the §11.2 authenticated
 * 19-byte payload and rotate the counter, so that nearby scanners can measure
 * RSSI to something they can prove is this watch.
 *
 * WHY AdvertisingSet AND NOT startAdvertising/stopAdvertising.
 * The payload has to change every rotation, and `BluetoothLeAdvertiser`'s legacy
 * API cannot alter live advertising data — the only way to change it is to stop
 * and restart, which drops the advertisement for a moment and produces a
 * visible RSSI gap (and, under a stall watchdog, spurious `lost` transitions).
 * `AdvertisingSet.setAdvertisingData()` replaces the payload in place, so the
 * radio never stops.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It never scans, never resolves a name, never
 * asks for location, and never logs the realm key or the payload. A beacon that
 * only broadcasts cannot leak what is around it.
 *
 * WITHOUT A REALM KEY IT ADVERTISES NOTHING. An unsigned or wrongly-signed
 * payload is dropped silently by every receiver (§11.2), so broadcasting one
 * would look identical to working while achieving nothing. The service instead
 * reports `NoRealmKey` and stays quiet, which the UI can actually show.
 */
class BeaconService : Service() {

    sealed interface State {
        data object Stopped : State
        data object NoRealmKey : State
        data object NoBluetooth : State
        data object NoPermission : State
        data class Advertising(val counter: Long) : State
        data class Failed(val reason: String) : State
    }

    private val scope = CoroutineScope(Dispatchers.Default + Job())
    private lateinit var store: BeaconStore
    private var advertisingSet: AdvertisingSet? = null
    private var rotateJob: Job? = null

    private val callback = object : AdvertisingSetCallback() {
        override fun onAdvertisingSetStarted(set: AdvertisingSet?, txPower: Int, status: Int) {
            if (status != ADVERTISE_SUCCESS || set == null) {
                _state.value = State.Failed("advertising start failed (status $status)")
                return
            }
            advertisingSet = set
        }

        override fun onAdvertisingDataSet(set: AdvertisingSet?, status: Int) {
            if (status != ADVERTISE_SUCCESS) {
                // A rotation that silently failed would leave the watch
                // broadcasting a counter the scanners have already accepted, so
                // it must not be swallowed.
                _state.value = State.Failed("payload rotation failed (status $status)")
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        store = BeaconStore(applicationContext)
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForegroundCompat()
        if (rotateJob?.isActive != true) {
            rotateJob = scope.launch { run() }
        }
        return START_STICKY
    }

    private suspend fun run() {
        val realmKey = store.realmKey()
        if (realmKey == null) {
            _state.value = State.NoRealmKey
            return
        }
        val adapter = getSystemService(BluetoothManager::class.java)?.adapter
        val advertiser = adapter?.bluetoothLeAdvertiser
        if (adapter == null || !adapter.isEnabled || advertiser == null) {
            _state.value = State.NoBluetooth
            return
        }
        val uidHash = BeaconAuth.uidHashFromName(store.beaconName())

        val parameters = AdvertisingSetParameters.Builder()
            .setLegacyMode(true) // widest scanner compatibility, including bridge.py's bleak
            .setConnectable(false)
            .setScannable(true)
            .setInterval(AdvertisingSetParameters.INTERVAL_MEDIUM)
            .setTxPowerLevel(AdvertisingSetParameters.TX_POWER_MEDIUM)
            .build()

        try {
            advertiser.startAdvertisingSet(parameters, advertiseData(realmKey, uidHash), null, null, null, callback)
        } catch (e: SecurityException) {
            // BLUETOOTH_ADVERTISE not granted yet — recoverable from the UI, so
            // report it rather than dying.
            _state.value = State.NoPermission
            return
        }

        // Rotate forever. A fresh counter every ROTATE_INTERVAL_MS is what makes
        // a captured payload useless a few seconds later.
        while (true) {
            delay(ROTATE_INTERVAL_MS)
            val set = advertisingSet ?: continue
            val data = advertiseData(realmKey, uidHash)
            try {
                set.setAdvertisingData(data)
            } catch (e: SecurityException) {
                _state.value = State.NoPermission
                return
            }
        }
    }

    /**
     * Build the next payload. `nextCounter()` persists before returning, so the
     * value that reaches the air has already survived a would-be crash — see
     * BeaconStore.
     */
    private suspend fun advertiseData(realmKey: ByteArray, uidHash: Long): AdvertiseData {
        val counter = store.nextCounter()
        val payload = BeaconAuth.buildBeaconPayload(realmKey, uidHash, counter)
        _state.value = State.Advertising(counter)
        return AdvertiseData.Builder()
            .setIncludeDeviceName(false) // the name is not the identity; the MAC is not either
            .setIncludeTxPowerLevel(false)
            .addManufacturerData(MANUFACTURER_ID, payload)
            .build()
    }

    private fun createChannel() {
        val manager = getSystemService(NotificationManager::class.java) ?: return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "MYTHOS beacon", NotificationManager.IMPORTANCE_LOW),
        )
    }

    private fun startForegroundCompat() {
        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("MYTHOS beacon")
            .setContentText("Broadcasting presence")
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setOngoing(true)
            .build()
        startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        super.onDestroy()
        rotateJob?.cancel()
        val adapter = getSystemService(BluetoothManager::class.java)?.adapter
        try {
            adapter?.bluetoothLeAdvertiser?.stopAdvertisingSet(callback)
        } catch (e: SecurityException) {
            // Losing the permission while stopping changes nothing worth saying.
        }
        advertisingSet = null
        _state.value = State.Stopped
        scope.cancel()
    }

    companion object {
        /**
         * Bluetooth SIG reserves 0xFFFF for internal/interoperability testing.
         * Aether is not an SIG-registered company, so this is the correct channel
         * — and it must match `aether-bridge/bridge.py`'s AETHER_MFG_ID exactly or
         * the scanner never looks at the payload.
         */
        const val MANUFACTURER_ID = 0xFFFF

        /**
         * 5s. Short enough that a captured payload is stale quickly, long enough
         * that the counter (a 32-bit field) cannot realistically wrap: ~680 years.
         */
        const val ROTATE_INTERVAL_MS = 5_000L

        private const val CHANNEL_ID = "mythos_beacon"
        private const val NOTIFICATION_ID = 2001

        private val _state = MutableStateFlow<State>(State.Stopped)

        /** Observed by MainActivity so the watch face can tell the truth. */
        val state: StateFlow<State> = _state.asStateFlow()
    }
}
