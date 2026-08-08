package com.mythos.nodes.phone

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
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
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
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
 * used only where it means something: breathing while idle (waiting), arcs
 * rotating while thinking (working), still when offline (nothing is happening) —
 * and all of it is dropped when the system asks for reduced motion.
 */
@Composable
fun TalkScreen(
    reduceMotion: Boolean,
    onHoldStart: () -> Unit,
    onHoldEnd: () -> Unit,
    onOpenSettings: () -> Unit,
    isConfigured: Boolean,
) {
    val phase by VoiceNodeService.phase.collectAsState()
    val connection by VoiceNodeService.connection.collectAsState()
    val caption by VoiceNodeService.caption.collectAsState()
    val heard by VoiceNodeService.lastHeard.collectAsState()
    val error by VoiceNodeService.lastError.collectAsState()
    val scanning by VoiceNodeService.scanning.collectAsState()
    val rejections by VoiceNodeService.rejections.collectAsState()
    val wakeStatus by VoiceNodeService.wakeStatus.collectAsState()
    val micStatus by VoiceNodeService.micStatus.collectAsState()
    val linkError by VoiceNodeService.linkError.collectAsState()
    val wakeSuppressed by VoiceNodeService.wakeSuppressed.collectAsState()

    val offline = connection != NodeLink.Status.CONNECTED

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
            Orb(
                color = orbColor,
                phase = phase,
                offline = offline,
                reduceMotion = reduceMotion,
                enabled = isConfigured && !offline,
                stateLabel = stateLabel,
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
            Spacer(Modifier.height(14.dp))
            Text(
                text = "wake: $wakeStatus" + if (wakeSuppressed > 0) " · $wakeSuppressed suppressed" else "",
                color = MythosTheme.TextFaint,
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
    }
}

@Composable
private fun Orb(
    color: Color,
    phase: VoiceNodeService.Phase,
    offline: Boolean,
    reduceMotion: Boolean,
    enabled: Boolean,
    stateLabel: String,
    onHoldStart: () -> Unit,
    onHoldEnd: () -> Unit,
) {
    val transition = rememberInfiniteTransition(label = "orb")

    // Breathing only while genuinely idle and online. A pulsing orb during
    // LISTENING would compete with the thing the operator is doing.
    val breath by transition.animateFloat(
        initialValue = 1f,
        targetValue = if (reduceMotion || offline || phase != VoiceNodeService.Phase.IDLE) 1f else 1.03f,
        animationSpec = infiniteRepeatable(
            animation = tween(MythosTheme.DurBreathMs, easing = MythosTheme.Ease),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "breath",
    )

    val sweep by transition.animateFloat(
        initialValue = 0f,
        targetValue = if (reduceMotion || offline) 0f else 360f,
        animationSpec = infiniteRepeatable(animation = tween(2600), repeatMode = RepeatMode.Restart),
        label = "sweep",
    )

    var pressed by remember { mutableStateOf(false) }
    // The gesture reads this instead of capturing `enabled`, so the handler sees
    // the current value without the modifier having to be re-keyed on it.
    val enabledState = rememberUpdatedState(enabled)

    Box(
        modifier = Modifier
            .size(220.dp)
            // Press feedback is opacity/scale only — nothing reflows under a thumb.
            .scale(breath * if (pressed) 0.97f else 1f)
            .semantics {
                contentDescription = "Talk to MYTHOS. Current state: $stateLabel. " +
                    "Press and hold to speak."
            }
            // Keyed on Unit, and `enabled` is read INSIDE the handler.
            //
            // This used to be pointerInput(enabled), where enabled folds in the
            // socket status. A reconnect is the normal case on a phone, so a
            // status flip mid-hold re-keyed the modifier, cancelled the coroutine
            // while it was suspended in tryAwaitRelease(), and the lines after it
            // never ran: onHoldEnd() was never called, the mic was never told to
            // stop, and `pressed` stuck on. The gesture must not be at the mercy
            // of the network.
            .pointerInput(Unit) {
                detectTapGestures(
                    onPress = {
                        if (!enabledState.value) return@detectTapGestures
                        pressed = true
                        try {
                            onHoldStart()
                            // Suspends until release, which is exactly push-to-talk:
                            // the mic is open for as long as the finger is down.
                            tryAwaitRelease()
                        } finally {
                            // Runs even if this gesture is cancelled, so the mic is
                            // always told to close and the orb never sticks pressed.
                            pressed = false
                            onHoldEnd()
                        }
                    },
                )
            },
        contentAlignment = Alignment.Center,
    ) {
        Canvas(modifier = Modifier.fillMaxSize()) {
            val r = size.minDimension / 2f
            val center = Offset(size.width / 2f, size.height / 2f)

            // Radial glow — the accent's --accent-glow, as light rather than a ring.
            drawCircle(
                brush = Brush.radialGradient(
                    colors = listOf(color.copy(alpha = 0.30f), Color.Transparent),
                    center = center,
                    radius = r,
                ),
                radius = r,
                center = center,
            )
            // The core disc.
            drawCircle(color = color.copy(alpha = 0.16f), radius = r * 0.52f, center = center)
            drawCircle(
                color = color,
                radius = r * 0.52f,
                center = center,
                style = Stroke(width = 1.5.dp.toPx()),
            )
            // Two hairline arcs, offset so rotation is legible without being busy.
            drawArc(
                color = color.copy(alpha = 0.75f),
                startAngle = sweep,
                sweepAngle = 70f,
                useCenter = false,
                style = Stroke(width = 1.5.dp.toPx()),
                topLeft = Offset(center.x - r * 0.80f, center.y - r * 0.80f),
                size = androidx.compose.ui.geometry.Size(r * 1.60f, r * 1.60f),
            )
            drawArc(
                color = color.copy(alpha = 0.35f),
                startAngle = sweep + 180f,
                sweepAngle = 40f,
                useCenter = false,
                style = Stroke(width = 1.dp.toPx()),
                topLeft = Offset(center.x - r * 0.92f, center.y - r * 0.92f),
                size = androidx.compose.ui.geometry.Size(r * 1.84f, r * 1.84f),
            )
        }
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
