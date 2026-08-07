package com.mythos.nodes.phone

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Configuration, once. Server, credential, identity, beacon.
 *
 * Validation is inline and states the consequence rather than the rule — "must
 * match AETHER_NODE_IDS" is what an operator can act on; "invalid input" is not.
 * Nothing is saved until Save, so a half-typed URL never takes the node offline.
 */
@androidx.compose.material3.ExperimentalMaterial3Api
@Composable
fun SettingsSheet(
    settings: NodeSettings,
    onDismiss: () -> Unit,
    onSaved: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    var serverUrl by remember { mutableStateOf(settings.serverUrl) }
    var token by remember { mutableStateOf(settings.authToken) }
    var nodeId by remember { mutableStateOf(settings.nodeId) }
    var beacon by remember { mutableStateOf(settings.beaconName) }
    var realmKey by remember { mutableStateOf("") }
    var haptics by remember { mutableStateOf(settings.hapticsEnabled) }
    var showToken by remember { mutableStateOf(false) }
    var realmError by remember { mutableStateOf<String?>(null) }

    val urlError = when {
        serverUrl.isBlank() -> "Required — where MYTHOS is running"
        !serverUrl.matches(Regex("^(ws|wss|http|https)://[^/\\s]+$")) ->
            "Needs scheme and host, no path — e.g. ws://192.168.0.10:4478"
        else -> null
    }
    val tokenError = if (token.isBlank()) "Required — MYTHOS_AUTH_TOKEN from mythos/.env" else null
    val nodeIdError = if (nodeId.isBlank()) "Required — must match this device's entry in AETHER_NODE_IDS" else null
    val canSave = urlError == null && tokenError == null && nodeIdError == null

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = MythosTheme.Panel,
        contentColor = MythosTheme.Text,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp)
                .padding(bottom = 32.dp),
        ) {
            Text("NODE SETTINGS", fontSize = 13.sp, letterSpacing = 2.sp, fontFamily = FontFamily.Monospace, color = MythosTheme.Accent)

            SectionLabel("CONNECTION")
            NodeField(
                value = serverUrl,
                onValueChange = { serverUrl = it },
                label = "MYTHOS address",
                error = urlError,
            )
            NodeField(
                value = token,
                onValueChange = { token = it },
                label = "Auth token",
                error = tokenError,
                visual = if (showToken) VisualTransformation.None else PasswordVisualTransformation(),
                trailing = {
                    Text(
                        text = if (showToken) "HIDE" else "SHOW",
                        color = MythosTheme.Accent,
                        fontSize = 10.sp,
                        fontFamily = FontFamily.Monospace,
                        modifier = Modifier
                            .padding(end = 12.dp)
                            .clickableNoRipple { showToken = !showToken },
                    )
                },
            )

            SectionLabel("IDENTITY")
            NodeField(
                value = nodeId,
                onValueChange = { nodeId = it },
                label = "Node id",
                error = nodeIdError,
            )
            Text(
                text = "Its POSITION in AETHER_NODE_IDS decides which proxy port the aggregator dials, so the order there must match --peers.",
                color = MythosTheme.TextFaint,
                fontSize = 11.sp,
                modifier = Modifier.padding(top = 4.dp),
            )

            SectionLabel("BEACON")
            NodeField(
                value = beacon,
                onValueChange = { beacon = it },
                label = "Beacon name",
                error = null,
            )
            NodeField(
                value = realmKey,
                onValueChange = { realmKey = it; realmError = null },
                label = if (settings.hasRealmKey()) "Realm key (stored — paste to replace)" else "Realm key (64 hex chars)",
                error = realmError,
                visual = PasswordVisualTransformation(),
            )
            Text(
                text = "From ~/.aether/realm.json. Without it this node verifies nothing and reports no sightings at all.",
                color = MythosTheme.TextFaint,
                fontSize = 11.sp,
                modifier = Modifier.padding(top = 4.dp),
            )

            SectionLabel("PREFERENCES")
            Row(
                modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text("Haptics on press", color = MythosTheme.Text, fontSize = 14.sp)
                Switch(
                    checked = haptics,
                    onCheckedChange = { haptics = it },
                    colors = SwitchDefaults.colors(
                        checkedThumbColor = MythosTheme.Accent,
                        checkedTrackColor = MythosTheme.Accent.copy(alpha = 0.30f),
                        uncheckedThumbColor = MythosTheme.TextDim,
                        uncheckedTrackColor = MythosTheme.BgRaised,
                    ),
                )
            }

            Spacer(Modifier.height(20.dp))

            Button(
                onClick = {
                    if (realmKey.isNotBlank() && !settings.setRealmKeyHex(realmKey)) {
                        // Refuse rather than store: a wrong key makes every payload
                        // fail verification, which is indistinguishable from an
                        // absent beacon.
                        realmError = "Need exactly 64 hex characters"
                        return@Button
                    }
                    settings.serverUrl = serverUrl
                    settings.authToken = token
                    settings.nodeId = nodeId
                    settings.beaconName = beacon
                    settings.hapticsEnabled = haptics
                    onSaved()
                },
                enabled = canSave,
                shape = RoundedCornerShape(MythosTheme.RadiusMd),
                colors = ButtonDefaults.buttonColors(
                    containerColor = MythosTheme.Accent.copy(alpha = 0.18f),
                    contentColor = MythosTheme.Accent,
                    disabledContainerColor = MythosTheme.BgRaised,
                    disabledContentColor = MythosTheme.TextFaint,
                ),
                modifier = Modifier.fillMaxWidth().height(MythosTheme.TouchTarget),
            ) {
                Text("SAVE AND RECONNECT", fontSize = 12.sp, letterSpacing = 1.sp, fontFamily = FontFamily.Monospace)
            }
        }
    }
}

@androidx.compose.material3.ExperimentalMaterial3Api
@Composable
private fun NodeField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    error: String?,
    visual: VisualTransformation = VisualTransformation.None,
    trailing: (@Composable () -> Unit)? = null,
) {
    Column(Modifier.fillMaxWidth().padding(top = 8.dp)) {
        OutlinedTextField(
            value = value,
            onValueChange = onValueChange,
            label = { Text(label, fontSize = 12.sp) },
            singleLine = true,
            isError = error != null,
            visualTransformation = visual,
            trailingIcon = trailing,
            shape = RoundedCornerShape(MythosTheme.RadiusSm),
            colors = TextFieldDefaults.colors(
                focusedContainerColor = MythosTheme.BgRaised,
                unfocusedContainerColor = MythosTheme.BgRaised,
                errorContainerColor = MythosTheme.BgRaised,
                focusedTextColor = MythosTheme.Text,
                unfocusedTextColor = MythosTheme.Text,
                focusedIndicatorColor = MythosTheme.Accent,
                unfocusedIndicatorColor = MythosTheme.Hairline,
                errorIndicatorColor = MythosTheme.Danger,
                focusedLabelColor = MythosTheme.Accent,
                unfocusedLabelColor = MythosTheme.TextDim,
                cursorColor = MythosTheme.Accent,
            ),
            modifier = Modifier.fillMaxWidth(),
        )
        // Error text below the field, never as a colour change alone.
        error?.let {
            Text(it, color = MythosTheme.Danger, fontSize = 11.sp, modifier = Modifier.padding(start = 4.dp, top = 3.dp))
        }
    }
}

/** Tap target without the Material ripple, which reads wrong on this surface. */
private fun Modifier.clickableNoRipple(onClick: () -> Unit): Modifier =
    this.pointerInput(Unit) { detectTapGestures(onTap = { onClick() }) }
