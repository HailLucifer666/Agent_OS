# MYTHOS Voice Nodes

The Android half of proximity-arbitrated voice: a wrist beacon that says *where
you are*, and (from Stage 2) phones that listen and speak, with Aether deciding
which single device answers.

This is a **separate Gradle build** from the rest of the repo. Nothing else here
uses Gradle, and the Node test suite, the pre-commit hook and CI are all
unaffected by whether a Kotlin toolchain is installed on your machine. You never
need this directory to run MYTHOS.

## Modules

| Module | What it is |
|---|---|
| `:shared` | Beacon-payload crypto and the MYTHOS `/ws` message shapes. Pure logic, unit-tested on the JVM with no device. |
| `:wear` | The wrist beacon. Advertises the authenticated payload; that is all it does. |
| `:phone` | The voice node — scanner, microphone, speaker, UI. |

## Prerequisites

- **JDK 17.** Newer JDKs will not work with this AGP version.
- **Android SDK** with platform `android-35` and build-tools `35.0.0`.
- For installing: `adb`, from the SDK's `platform-tools`.

Point the build at your SDK by creating `nodes/local.properties`:

```properties
sdk.dir=/absolute/path/to/your/Android/sdk
```

That file is **gitignored by design** — the path is machine-specific, so it must
never be committed (see the repo's open-source portability rules in
`CLAUDE.md`). Everything else the build needs is downloaded by Gradle.

## Build and test

```bash
cd nodes
./gradlew :shared:testDebugUnitTest     # the byte-exact payload conformance tests
./gradlew :wear:assembleDebug           # -> wear/build/outputs/apk/debug/wear-debug.apk
./gradlew :phone:assembleDebug          # -> phone/build/outputs/apk/debug/phone-debug.apk
```

On Windows use `gradlew.bat` — the POSIX `gradlew` script mis-resolves its own
location when the repo path contains a space, which this one does.

If `JAVA_HOME` is unset or points at the wrong JDK, set it for the call rather
than globally:

```powershell
$env:JAVA_HOME = "<path to your JDK 17>"
```

## Installing the beacon on a watch

```bash
adb devices                                    # pair/connect the watch first
adb install -r wear/build/outputs/apk/debug/wear-debug.apk
```

### Provisioning the realm key

The beacon signs every payload with the **realm key** — the shared secret that
admits a device to your Aether mesh. It lives on your machine in
`~/.aether/realm.json` as the 64-hex-character `realm_key`.

A watch has no usable keyboard and usually no camera, so the key is delivered
once over adb:

```bash
adb shell am start -n com.mythos.nodes.wear/.MainActivity \
  --es realm_key <the 64 hex chars from ~/.aether/realm.json>
```

Optionally also set the beacon name (it must match what your scanners use to
derive `uid_hash` — `bridge.py --name`, default `mythos-wrist`):

```bash
  --es beacon_name mythos-wrist
```

The key goes straight into `EncryptedSharedPreferences`. It is never displayed,
never logged, and the app only ever admits *whether* one exists. A key that is
not exactly 32 bytes of hex is **rejected rather than stored** — a wrong key
produces payloads every scanner drops silently, which looks exactly like a dead
beacon.

Treat the key as a secret: `adb shell` command lines can appear in shell history
and in `logcat` on some devices. Rotate the realm key (`realm.json`'s
`key_history` supports a grace window) if you think it leaked.

## Setting up a phone node

```bash
adb install -r phone/build/outputs/apk/debug/phone-debug.apk
```

Then open the app, tap the gear, and fill in four things:

| Field | Value |
|---|---|
| MYTHOS address | `ws://<your PC's LAN IP>:4478` — scheme and host, no path |
| Auth token | `MYTHOS_AUTH_TOKEN` from `mythos/.env` |
| Node id | this device's entry in `AETHER_NODE_IDS`, exactly |
| Realm key | the 64 hex chars from `~/.aether/realm.json` |

On the MYTHOS side the phone needs a reachable bind and the node flags:

```properties
MYTHOS_BIND=0.0.0.0
MYTHOS_AUTH_TOKEN=<a long random string>
AETHER_NODE_TRUST=true
AETHER_PROXY_ENABLED=true
AETHER_NODE_IDS=kitchen-phone,desk-phone
AETHER_NODE_AUDIO=true
```

**The order of `AETHER_NODE_IDS` is load-bearing.** Position decides the proxy
port (`AETHER_PROXY_PORT_BASE + i`), and the aggregator's `--peers` must list
those ports in the same order or one room's readings are attributed to another:

```bash
python aggregator.py --peers ws://127.0.0.1:8765,ws://127.0.0.1:4480,ws://127.0.0.1:4481
```

`AETHER_NODE_TRUST` exists because a phone is not a browser: OkHttp sends no
`Origin` header, and the WS gate rejects no-Origin non-loopback clients before it
looks at a credential. The flag adds the one branch that admits them, and it
requires the auth token — no token, no node, regardless of the flag. Only do this
on a LAN you trust; the Aether protocol defers transport encryption (§11.4).

## Hands-free (wake word)

Push-to-talk works out of the box. Hands-free needs a wake-word model, and **this
app ships none** — you supply one:

```bash
adb push <your-model> /sdcard/Android/data/com.mythos.nodes.phone/files/wakeword/
```

That is a licensing decision as much as a technical one. Wake-word *weights* are
often licensed separately from the code that runs them — MYTHOS's own
openWakeWord weights are CC BY-NC-SA 4.0 (non-commercial) while its code is
Apache-2.0 — so nothing under restricted terms is redistributed here. What to
bundle in a shipped product, if anything, stays a decision for whoever ships it.
Nothing in this repo asserts what any particular licence permits.

With no model the app says `wake: no wake-word model installed` on screen. It
never silently pretends to listen: a wake word that quietly never fires is the
worst failure mode available, indistinguishable from a broken mic or a phrase
you're mispronouncing.

`WakeWordDetector` is the seam to implement against — feed it 16 kHz mono PCM16,
call `onDetected`. Two hazards are documented in that file, both learned here:
verify your mel/feature transform **by value** against a reference vector (BUG-175
was a port with every tensor shape correct and one scaling step missing — deaf at
1e-5, and perfectly plausible-looking), and never let the detector fire on the
node's own playback.

### How one phrase lights one device

A detection is a *report*, not a decision. The node sends `node-wake`; MYTHOS asks
the aggregator to arbitrate; the aggregator marks the current owner `ACCEPTED` and
every other present scanner `SUPPRESSED`; the verdict goes back to every node.
Only `ACCEPTED` opens a mic — and a node **absent** from the results (it cannot
currently see the beacon, so it is not in the election) stands down too, because
absence is not consent.

If Aether is down, the device that heard the phrase answers. Failing closed there
would make the entire mesh deaf, which is both worse and invisible.

To let the desktop compete on the same footing, set `AETHER_LOCAL_SCANNER_ID` in
`mythos/.env` to whatever you pass to `bridge.py --scanner <id>`.

## Verifying it actually works

A green build proves nothing about radio. Verify in this order, stopping at the
first step that fails:

**Step 0 needs no hardware at all, and is already passing.** Everything above the
BLE radio can be driven against the real aggregator:

```bash
MYTHOS_DIR=/path/to/mythos AGG_DIR=/path/to/Aether-BLE/aether-bridge AGG_PYTHON=/path/to/Aether-BLE/aether-bridge/.venv/Scripts/python.exe node mythos/scripts/verify-voice-nodes.js
```

It spawns `aggregator.py`, lets it dial the scanner-proxy as a peer, and checks
that its own election steers a real reply to the right socket and that a wake
arbitration names exactly one winner — 11/11 at the time of writing. Run this
first: if it fails, the steps below cannot succeed and the fault is not your
radio.

1. **The watch is transmitting something the mesh can verify.** On your machine:

   ```bash
   cd /path/to/Aether-BLE/aether-bridge
   python bridge.py --name mythos-wrist --scanner PC
   ```

   Walk toward and away from the laptop. RSSI should move. This is a real test,
   not a smoke test: `bridge.py` verifies the HMAC and the counter, so a wrong
   realm key, a wrong beacon name, or a byte-order mistake shows up as *nothing
   at all*.

2. **Aether elects it.** Start the aggregator against that scanner, then run
   MYTHOS with `AETHER_ENABLED=true`. The HUD's NEAREST DEVICE widget should
   paint from your wrist.

3. **Phones join the election** — Stage 1's scanner-proxy plus the `:phone`
   module. See `mythos/.env.example`'s "Voice Nodes" section for
   `AETHER_PROXY_ENABLED` / `AETHER_NODE_IDS` and the `--peers` ordering, which
   is load-bearing.

## Battery

An always-on BLE advertiser is the cheap part; the phone's always-on wake-word
listener (Stage 4) is what will actually cost battery. The beacon rotates its
payload every 5 seconds at medium TX power and medium interval — turn it off from
the watch UI when you don't want to be tracked, which is also the honest privacy
control.

## Attribution

`:shared`'s `BeaconAuth.kt` is copied from Aether-BLE (Apache-2.0) rather than
reimplemented — see `mythos/THIRD_PARTY_NOTICES.md` for why and under what
terms.
