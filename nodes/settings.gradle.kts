// MYTHOS Voice Nodes — the Android/Wear half of the proximity-arbitrated voice
// mesh. Deliberately a SEPARATE Gradle build from the rest of the repo: nothing
// else here builds with Gradle, and the Node test suite / pre-commit hook /
// CI workflow must stay unaffected by whether a Kotlin toolchain is present.
//
// Modules:
//   :shared — pure JVM/Android logic shared by every node (beacon payload
//             crypto, wire messages). Unit-testable without a device.
//   :wear   — the wrist beacon (Stage 0). Advertises the authenticated §11.2
//             payload; that is its entire job.
//   :phone  — the voice node (Stages 1-5): BLE scanner, mic, speaker, HUD-styled
//             Compose UI.
//
// The Android SDK location goes in local.properties (gitignored) — never in a
// tracked file, since it is machine-specific by definition.

pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "mythos-nodes"

include(":shared")
include(":wear")
// :phone arrives with Stage 2 — an include for a directory that does not exist
// fails the whole build, so it is added when the module is.
