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
| `:phone` | The voice node — scanner, microphone, speaker, UI. *(Stage 2, not yet present.)* |

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

## Verifying it actually works

A green build proves nothing about radio. Verify in this order, stopping at the
first step that fails:

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
