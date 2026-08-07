package com.mythos.nodes.wear

import android.Manifest
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.lifecycleScope
import androidx.wear.compose.material.Button
import androidx.wear.compose.material.ButtonDefaults
import androidx.wear.compose.material.Text
import kotlinx.coroutines.launch

/**
 * The whole watch UI: one toggle, and an honest report of what the radio is
 * actually doing.
 *
 * Palette matches the MYTHOS HUD's semantic tokens (cyan accent on true black),
 * so watch, phone and desktop read as one product. Colour is never the only
 * signal — every state also carries a word.
 *
 * REALM-KEY PROVISIONING. There is no usable keyboard on a watch and no camera
 * on most, so the 64-hex-char realm key arrives once via an adb intent extra:
 *
 *   adb shell am start -n com.mythos.nodes.wear/.MainActivity --es realm_key <hex>
 *
 * It goes straight into EncryptedSharedPreferences and is never displayed or
 * logged — the UI only ever admits whether one exists. A malformed key is
 * rejected loudly rather than stored, because a wrong key produces payloads that
 * every scanner drops silently, which is indistinguishable from a dead beacon.
 */
class MainActivity : ComponentActivity() {

    private var keyProvisioned by mutableStateOf(false)
    private var provisionNotice by mutableStateOf<String?>(null)

    private val requestAdvertise = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) startBeacon()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val store = BeaconStore(applicationContext)
        consumeRealmKeyExtra(intent, store)
        keyProvisioned = store.hasRealmKey()

        setContent {
            BeaconScreen(
                keyProvisioned = keyProvisioned,
                notice = provisionNotice,
                onToggle = { running -> if (running) stopBeacon() else ensurePermissionThenStart() },
            )
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val store = BeaconStore(applicationContext)
        consumeRealmKeyExtra(intent, store)
        keyProvisioned = store.hasRealmKey()
    }

    private fun consumeRealmKeyExtra(intent: Intent?, store: BeaconStore) {
        val hex = intent?.getStringExtra(EXTRA_REALM_KEY) ?: return
        provisionNotice = if (store.setRealmKeyHex(hex)) {
            "realm key stored"
        } else {
            "rejected: need ${BeaconStore.REALM_KEY_BYTES * 2} hex chars"
        }
        // Do not leave the secret sitting in the Activity's intent for the next
        // onNewIntent/recreation to re-read.
        intent.removeExtra(EXTRA_REALM_KEY)
        intent.getStringExtra(EXTRA_BEACON_NAME)?.let { name ->
            if (name.isNotBlank()) lifecycleScope.launch { store.setBeaconName(name.trim()) }
        }
    }

    private fun ensurePermissionThenStart() {
        if (checkSelfPermission(Manifest.permission.BLUETOOTH_ADVERTISE) == android.content.pm.PackageManager.PERMISSION_GRANTED) {
            startBeacon()
        } else {
            requestAdvertise.launch(Manifest.permission.BLUETOOTH_ADVERTISE)
        }
    }

    private fun startBeacon() {
        startForegroundService(Intent(this, BeaconService::class.java))
    }

    private fun stopBeacon() {
        stopService(Intent(this, BeaconService::class.java))
    }

    companion object {
        const val EXTRA_REALM_KEY = "realm_key"
        const val EXTRA_BEACON_NAME = "beacon_name"
    }
}

// MYTHOS HUD semantic tokens (mythos/ui/public/css/tokens/semantic.css).
private val BG = Color(0xFF000000)
private val ACCENT = Color(0xFF4FD8FF)
private val LISTENING = Color(0xFF43E5A0)
private val DANGER = Color(0xFFFF5F66)
private val TEXT = Color(0xFFD7E3F4)
private val TEXT_DIM = Color(0xFF8BA3C4)

@Composable
private fun BeaconScreen(
    keyProvisioned: Boolean,
    notice: String?,
    onToggle: (running: Boolean) -> Unit,
) {
    val state by BeaconService.state.collectAsState()
    val running = state is BeaconService.State.Advertising

    // One line of plain language per state. Colour reinforces it; it never
    // carries the meaning alone.
    val (label, tint) = when (val s = state) {
        is BeaconService.State.Advertising -> "BROADCASTING" to LISTENING
        BeaconService.State.NoRealmKey -> "NO REALM KEY" to DANGER
        BeaconService.State.NoBluetooth -> "BLUETOOTH OFF" to DANGER
        BeaconService.State.NoPermission -> "PERMISSION NEEDED" to DANGER
        is BeaconService.State.Failed -> "FAILED" to DANGER
        BeaconService.State.Stopped -> "IDLE" to TEXT_DIM
    }

    Box(
        modifier = Modifier.fillMaxSize().background(BG),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Button(
                onClick = { onToggle(running) },
                colors = ButtonDefaults.buttonColors(
                    backgroundColor = if (running) ACCENT.copy(alpha = 0.18f) else Color(0xFF0E1626),
                    contentColor = if (running) ACCENT else TEXT,
                ),
                // 56dp: comfortably past the 48dp minimum target, which matters
                // more on a wrist than anywhere else.
                modifier = Modifier.size(72.dp).clip(CircleShape),
            ) {
                Text(
                    text = if (running) "STOP" else "START",
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Medium,
                    fontFamily = FontFamily.Monospace,
                )
            }

            Text(
                text = label,
                color = tint,
                fontSize = 12.sp,
                fontFamily = FontFamily.Monospace,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(top = 10.dp),
            )

            // The counter is the only number worth showing: it is the proof the
            // rotation is actually happening rather than the radio being stuck on
            // one payload.
            (state as? BeaconService.State.Advertising)?.let { s ->
                Text(
                    text = "counter ${s.counter}",
                    color = TEXT_DIM,
                    fontSize = 11.sp,
                    fontFamily = FontFamily.Monospace,
                    modifier = Modifier.padding(top = 2.dp),
                )
            }

            (state as? BeaconService.State.Failed)?.let { s ->
                Text(
                    text = s.reason,
                    color = DANGER,
                    fontSize = 10.sp,
                    fontFamily = FontFamily.Monospace,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(top = 2.dp),
                )
            }

            Text(
                text = if (keyProvisioned) "key: provisioned" else "key: missing",
                color = if (keyProvisioned) TEXT_DIM else DANGER,
                fontSize = 10.sp,
                fontFamily = FontFamily.Monospace,
                modifier = Modifier.padding(top = 6.dp),
            )

            notice?.let {
                Text(
                    text = it,
                    color = TEXT_DIM,
                    fontSize = 10.sp,
                    fontFamily = FontFamily.Monospace,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(top = 2.dp),
                )
            }
        }
    }
}
