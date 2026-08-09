package com.mythos.nodes.phone

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import android.view.HapticFeedbackConstants
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.Canvas
import androidx.compose.material3.Text

/**
 * The whole app: a black field, one orb, and what MYTHOS just said.
 *
 * One primary action per screen — press and hold the orb to talk. Everything else
 * (server, token, node id) is configuration and lives behind the gear, because a
 * device on a kitchen counter is configured once and used a thousand times.
 *
 * The orb carries state through colour AND a word, never colour alone. Motion is
 * used only where it means something: breathing while idle (waiting), reacting to
 * the actual audio while listening and speaking, contracted and spinning hard while
 * thinking (working), still when offline (nothing is happening) — and all of it is
 * dropped when the system asks for reduced motion.
 */
@Composable
fun TalkScreen(
    reduceMotion: Boolean,
    onHoldStart: () -> Unit,
    onHoldEnd: () -> Unit,
    onOpenSettings: () -> Unit,
    isConfigured: Boolean,
    onApproval: (String, Boolean) -> Unit = { _, _ -> },
    hapticsEnabled: Boolean = true,
) {
    val phase by VoiceNodeService.phase.collectAsState()
    val connection by VoiceNodeService.connection.collectAsState()
    val caption by VoiceNodeService.caption.collectAsState()
    val heard by VoiceNodeService.lastHeard.collectAsState()
    val error by VoiceNodeService.lastError.collectAsState()
    val scanning by VoiceNodeService.scanning.collectAsState()
    val rejections by VoiceNodeService.rejections.collectAsState()
    val wakeStatus by VoiceNodeService.wakeStatus.collectAsState()
    val wakeAvailable by VoiceNodeService.wakeAvailable.collectAsState()
    val micStatus by VoiceNodeService.micStatus.collectAsState()
    val linkError by VoiceNodeService.linkError.collectAsState()
    val wakeSuppressed by VoiceNodeService.wakeSuppressed.collectAsState()
    val approval by VoiceNodeService.approval.collectAsState()

    val offline = connection != NodeLink.Status.CONNECTED

    // The orb is sized from the screen rather than from a fixed number, because the
    // same 220dp that read as a widget on a phone reads as a dot on a tablet. Both
    // terms are load-bearing: width alone overflows a short screen in landscape,
    // height alone leaves a tablet with a small orb in a wide field.
    // 360x640 -> 269dp, 411x891 -> 353dp, tablet -> the 380dp cap.
    //
    // Nothing on this screen scrolls, deliberately. A verticalScroll parent would
    // compete with the orb's own press-and-hold: past the drag threshold the
    // scroller wins the pointer, tryAwaitRelease returns, and push-to-talk cuts out
    // whenever a thumb moves a few pixels. Sizing to fit avoids that entirely — and
    // the fractions leave enough slack for the reply and the status lines below.
    val configuration = LocalConfiguration.current
    val orbDiameter = minOf(
        configuration.screenWidthDp.dp * 0.86f,
        configuration.screenHeightDp.dp * 0.42f,
    ).coerceIn(240.dp, 380.dp)

    // State -> (colour, word). The word is what a colour-blind operator, or anyone
    // glancing from across a room, actually reads.
    val orbColor: Color
    val stateLabel: String
    when {
        offline -> { orbColor = MythosTheme.Offline; stateLabel = "OFFLINE" }
        phase == VoiceNodeService.Phase.LISTENING -> { orbColor = MythosTheme.Listening; stateLabel = "LISTENING" }
        phase == VoiceNodeService.Phase.THINKING -> { orbColor = MythosTheme.Thinking; stateLabel = "THINKING" }
        phase == VoiceNodeService.Phase.SPEAKING -> { orbColor = MythosTheme.Speaking; stateLabel = "SPEAKING" }
        else -> { orbColor = MythosTheme.Accent; stateLabel = "READY" }
    }

    // One tick per state change, so a node on a counter can be felt as well as
    // watched. Deliberately NOT a buzz that follows the voice: Android's vibrator
    // is not a real-time stream, so tracking an envelope means re-issuing effects
    // tens of times a second — battery cost, mushy on most motors, and audible as
    // a rattle on cheap ones.
    //
    // Seeded with the current phase so entering the screen is silent, and skipped
    // while offline so a flapping socket cannot buzz in someone's pocket. The
    // remembered phase still advances when suppressed, or reconnecting would fire
    // a tick for a transition that happened minutes ago.
    val view = LocalView.current
    var tickedPhase by remember { mutableStateOf(phase) }
    LaunchedEffect(phase, offline, hapticsEnabled) {
        if (phase == tickedPhase) return@LaunchedEffect
        tickedPhase = phase
        if (hapticsEnabled && !offline) {
            view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
        }
    }

    Box(modifier = Modifier.fillMaxSize().background(MythosTheme.Bg)) {

        ConnectionChip(
            connection = connection,
            scanning = scanning,
            modifier = Modifier.align(Alignment.TopStart).padding(16.dp),
        )

        GearButton(
            onClick = onOpenSettings,
            modifier = Modifier.align(Alignment.TopEnd).padding(8.dp),
        )

        Column(
            modifier = Modifier.fillMaxSize().padding(horizontal = 28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            SwarmOrb(
                color = orbColor,
                phase = phase,
                offline = offline,
                reduceMotion = reduceMotion,
                enabled = isConfigured && !offline,
                stateLabel = stateLabel,
                diameter = orbDiameter,
                onHoldStart = onHoldStart,
                onHoldEnd = onHoldEnd,
            )

            Spacer(Modifier.height(24.dp))

            Text(
                text = stateLabel,
                color = orbColor,
                fontSize = 12.sp,
                letterSpacing = 2.sp,
                fontFamily = FontFamily.Monospace,
            )

            Spacer(Modifier.height(20.dp))

            // What MYTHOS said. The reply is the content of this screen; everything
            // else is chrome.
            Text(
                text = caption.ifEmpty { if (isConfigured) "Hold to talk" else "Set up this node to begin" },
                color = if (caption.isEmpty()) MythosTheme.TextFaint else MythosTheme.Text,
                fontSize = if (caption.isEmpty()) 14.sp else 18.sp,
                textAlign = TextAlign.Center,
                lineHeight = 26.sp,
            )

            if (heard.isNotEmpty()) {
                Spacer(Modifier.height(12.dp))
                Text(
                    text = "you: $heard",
                    color = MythosTheme.TextDim,
                    fontSize = 12.sp,
                    fontFamily = FontFamily.Monospace,
                    textAlign = TextAlign.Center,
                )
            }

            error?.let {
                Spacer(Modifier.height(12.dp))
                Text(
                    text = it,
                    color = MythosTheme.Danger,
                    fontSize = 12.sp,
                    fontFamily = FontFamily.Monospace,
                    textAlign = TextAlign.Center,
                )
            }

            // The reason the socket is down, when it is. Shown only while
            // offline: once linked it is stale history, not status.
            if (offline) linkError?.let {
                Spacer(Modifier.height(10.dp))
                Text(
                    text = it,
                    color = MythosTheme.Danger,
                    fontSize = 11.sp,
                    fontFamily = FontFamily.Monospace,
                    textAlign = TextAlign.Center,
                )
            }

            // A revoked microphone permission would otherwise present as a
            // press-and-hold that simply does nothing. Say it instead.
            if (micStatus.isNotEmpty()) {
                Spacer(Modifier.height(10.dp))
                Text(
                    text = micStatus,
                    color = MythosTheme.Danger,
                    fontSize = 11.sp,
                    fontFamily = FontFamily.Monospace,
                    textAlign = TextAlign.Center,
                )
            }

            // Hands-free state, in words. "off because there is no model" and
            // "listening" must never be the same silence — a wake word that
            // quietly never fires is the single worst failure mode available.
            //
            // Quiet when healthy, full contrast when not. The condition comes from
            // the detector's own `isAvailable`, published as `wakeAvailable` — NOT
            // from reading the label text, or a detector that rephrases its status
            // could make itself invisible. A suppression count is also worth
            // seeing, so it un-dims too.
            Spacer(Modifier.height(14.dp))
            val wakeHealthy = wakeAvailable && wakeSuppressed == 0
            Text(
                text = "wake: $wakeStatus" + if (wakeSuppressed > 0) " · $wakeSuppressed suppressed" else "",
                color = MythosTheme.TextFaint.copy(alpha = if (wakeHealthy) 0.40f else 1f),
                fontSize = 10.sp,
                fontFamily = FontFamily.Monospace,
                textAlign = TextAlign.Center,
            )

            // The diagnostic that would otherwise cost an evening: payloads seen
            // and rejected means a realm-key or beacon-name mismatch, which looks
            // exactly like "no beacon nearby" without this line.
            if (scanning && rejections > 20) {
                Spacer(Modifier.height(12.dp))
                Text(
                    text = "$rejections beacon payloads rejected — check realm key / beacon name",
                    color = MythosTheme.Danger,
                    fontSize = 11.sp,
                    fontFamily = FontFamily.Monospace,
                    textAlign = TextAlign.Center,
                )
            }
        }

        // Last, so it draws over everything: an approval is the only thing on
        // this screen that MYTHOS is actually blocked on.
        approval?.let { ApprovalSheet(it, onApproval) }
    }
}

/**
 * The tier-3/4 gate, full-screen because it is not a notification — MYTHOS is
 * stopped until it is answered.
 *
 * Once `outcome` is set the sheet stays up, greyed, showing the word. It does
 * NOT close on the tap: the server's `confirm-resolved` is what proves the reply
 * landed, and a sheet that closes on the tap makes a silent no-op — a lapsed
 * confirm, or one scoped to the desktop — look exactly like an approval.
 */
@Composable
private fun ApprovalSheet(
    approval: VoiceNodeService.Approval,
    onApproval: (String, Boolean) -> Unit,
) {
    val settled = approval.outcome != null
    Box(
        modifier = Modifier
            .fillMaxSize()
            // Opaque enough that the orb behind cannot be mistaken for the
            // primary action, and it swallows taps aimed at the orb.
            .background(MythosTheme.Bg.copy(alpha = 0.94f))
            .pointerInput(Unit) { detectTapGestures { } }
            .padding(horizontal = 28.dp),
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                text = "TIER ${approval.tier} · APPROVAL",
                color = if (settled) MythosTheme.TextFaint else MythosTheme.Danger,
                fontSize = 11.sp,
                letterSpacing = 2.sp,
                fontFamily = FontFamily.Monospace,
            )
            Spacer(Modifier.height(18.dp))
            Text(
                text = approval.summary,
                color = if (settled) MythosTheme.TextDim else MythosTheme.Text,
                fontSize = 18.sp,
                lineHeight = 26.sp,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(28.dp))

            if (settled) {
                Text(
                    text = approval.outcome ?: "",
                    color = MythosTheme.TextDim,
                    fontSize = 13.sp,
                    fontFamily = FontFamily.Monospace,
                    textAlign = TextAlign.Center,
                )
            } else {
                Row(horizontalArrangement = Arrangement.Center) {
                    ApprovalButton("Deny", MythosTheme.Danger) { onApproval(approval.id, false) }
                    Spacer(Modifier.width(16.dp))
                    ApprovalButton("Approve", MythosTheme.Accent) { onApproval(approval.id, true) }
                }
            }
        }
    }
}

@Composable
private fun ApprovalButton(label: String, color: Color, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .height(MythosTheme.TouchTarget)
            .clip(RoundedCornerShape(MythosTheme.RadiusSm))
            .background(color.copy(alpha = 0.16f))
            .semantics { contentDescription = label }
            .pointerInput(Unit) { detectTapGestures(onTap = { onClick() }) }
            .padding(horizontal = 26.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(text = label, color = color, fontSize = 15.sp, fontFamily = FontFamily.Monospace)
    }
}

@Composable
private fun ConnectionChip(
    connection: NodeLink.Status,
    scanning: Boolean,
    modifier: Modifier = Modifier,
) {
    val (dot, label) = when (connection) {
        NodeLink.Status.CONNECTED -> MythosTheme.Accent to "LINKED"
        NodeLink.Status.CONNECTING -> MythosTheme.Speaking to "LINKING"
        NodeLink.Status.DISCONNECTED -> MythosTheme.Danger to "NO LINK"
    }
    Row(
        modifier = modifier
            .clip(RoundedCornerShape(MythosTheme.RadiusSm))
            .background(MythosTheme.Panel.copy(alpha = 0.55f))
            .padding(horizontal = 10.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(7.dp).clip(CircleShape).background(dot))
        Spacer(Modifier.width(7.dp))
        Text(
            text = if (scanning) "$label · SCANNING" else label,
            color = MythosTheme.TextDim,
            fontSize = 10.sp,
            letterSpacing = 1.sp,
            fontFamily = FontFamily.Monospace,
        )
    }
}

@Composable
private fun GearButton(onClick: () -> Unit, modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            // 48dp even though the glyph is small — the target is what matters.
            .size(MythosTheme.TouchTarget)
            .clip(CircleShape)
            .semantics { contentDescription = "Node settings" }
            .pointerInput(Unit) { detectTapGestures(onTap = { onClick() }) },
        contentAlignment = Alignment.Center,
    ) {
        Canvas(Modifier.size(20.dp)) {
            val r = size.minDimension / 2f
            val c = Offset(size.width / 2f, size.height / 2f)
            drawCircle(color = MythosTheme.TextDim, radius = r * 0.42f, center = c, style = Stroke(1.5.dp.toPx()))
            drawCircle(color = MythosTheme.TextDim, radius = r * 0.92f, center = c, style = Stroke(1.5.dp.toPx()))
        }
    }
}

@Composable
fun SectionLabel(text: String) {
    Text(
        text = text,
        color = MythosTheme.TextFaint,
        fontSize = 10.sp,
        letterSpacing = 1.5.sp,
        fontWeight = FontWeight.Medium,
        fontFamily = FontFamily.Monospace,
        modifier = Modifier.fillMaxWidth().padding(top = 18.dp, bottom = 6.dp),
    )
}
