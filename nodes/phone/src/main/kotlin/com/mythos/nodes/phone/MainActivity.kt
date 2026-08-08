package com.mythos.nodes.phone

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.provider.Settings
import android.view.HapticFeedbackConstants
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.core.view.WindowCompat

/**
 * Single activity, single screen.
 *
 * Permissions are requested when the operator first tries to talk, not on launch:
 * a cold "allow microphone?" before anything is configured has no context, and
 * gets denied.
 */
class MainActivity : ComponentActivity() {

    private lateinit var settings: NodeSettings
    private var showSettings by mutableStateOf(false)
    private var configured by mutableStateOf(false)

    private val requestPermissions =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grants ->
            if (grants[Manifest.permission.RECORD_AUDIO] == true) startNodeService()
        }

    @androidx.compose.material3.ExperimentalMaterial3Api
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Draw into the cutout/status area — the orb is the screen, and a black
        // field has no seam to hide.
        WindowCompat.setDecorFitsSystemWindows(window, false)

        settings = NodeSettings(applicationContext)
        configured = settings.isConfigured()
        if (configured) ensurePermissionsThenStart()

        // Honour the system's reduced-motion setting. Read once here rather than
        // hardcoded off, so the breathing/rotating orb is opt-out for anyone who
        // has already told the OS that motion is a problem.
        val reduceMotion = runCatching {
            Settings.Global.getFloat(contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
        }.getOrDefault(false)

        setContent {
            TalkScreen(
                reduceMotion = reduceMotion,
                isConfigured = configured,
                onHoldStart = {
                    if (settings.hapticsEnabled) {
                        window.decorView.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
                    }
                    withService(
                        { it.startListeningOnce() },
                        VoiceNodeService.ACTION_START_LISTENING,
                    )
                },
                onHoldEnd = {
                    withService(
                        { it.stopListening() },
                        VoiceNodeService.ACTION_STOP_LISTENING,
                    )
                },
                onOpenSettings = { showSettings = true },
            )

            if (showSettings) {
                SettingsSheet(
                    settings = settings,
                    onDismiss = { showSettings = false },
                    onSaved = {
                        showSettings = false
                        configured = settings.isConfigured()
                        // Restart so the socket picks up the new address/token and
                        // re-identifies; a live socket cannot change its credential.
                        stopService(Intent(this, VoiceNodeService::class.java))
                        ensurePermissionsThenStart()
                    },
                )
            }
        }
    }

    private fun ensurePermissionsThenStart() {
        val needed = mutableListOf(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            needed += Manifest.permission.BLUETOOTH_SCAN
            needed += Manifest.permission.BLUETOOTH_CONNECT
        } else {
            // Below 31 a BLE scan is treated as a location capability whether or
            // not you want the location — there is no neverForLocation escape.
            needed += Manifest.permission.ACCESS_FINE_LOCATION
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            needed += Manifest.permission.POST_NOTIFICATIONS
        }
        val missing = needed.filter {
            checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isEmpty()) startNodeService() else requestPermissions.launch(missing.toTypedArray())
    }

    private fun startNodeService() {
        if (!settings.isConfigured()) return
        startForegroundService(Intent(this, VoiceNodeService::class.java))
    }

    // ---- Direct handle on the service, so a press is a method call -----------
    //
    // Hold-to-talk used to be startService(Intent), which is a Binder round trip
    // into ActivityManager and another one back before onStartCommand ran on the
    // service's main thread. The first press after an idle period routinely felt
    // like nothing happened — and a press that feels ignored gets repeated, which
    // is how one question became three answers.
    //
    // The Intent path is kept as the fallback for the window before the binding
    // lands, and it remains how the wake word and a START_STICKY restart arrive.

    private var boundService: VoiceNodeService? = null

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            boundService = (binder as? VoiceNodeService.LocalBinder)?.service()
        }
        override fun onServiceDisconnected(name: ComponentName?) {
            boundService = null
        }
    }

    override fun onStart() {
        super.onStart()
        bindService(Intent(this, VoiceNodeService::class.java), connection, Context.BIND_AUTO_CREATE)
    }

    override fun onStop() {
        super.onStop()
        runCatching { unbindService(connection) }
        boundService = null
    }

    private fun withService(direct: (VoiceNodeService) -> Unit, fallbackAction: String) {
        if (!settings.isConfigured()) return
        val bound = boundService
        if (bound != null) direct(bound) else sendServiceAction(fallbackAction)
    }

    private fun sendServiceAction(action: String) {
        if (!settings.isConfigured()) return
        startService(Intent(this, VoiceNodeService::class.java).setAction(action))
    }
}
