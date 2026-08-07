// Versions are pinned deliberately: this build has to keep working on a
// contributor's machine years from now, and a floating version is how an
// Android project silently stops compiling.
plugins {
    id("com.android.application") version "8.5.2" apply false
    id("com.android.library") version "8.5.2" apply false
    kotlin("android") version "2.0.21" apply false
    // From Kotlin 2.0 the Compose compiler ships with Kotlin itself and this
    // plugin is REQUIRED whenever buildFeatures.compose is on — the old
    // composeOptions.kotlinCompilerExtensionVersion route is gone, and its
    // absence fails configuration outright rather than degrading. Version must
    // track the Kotlin version above.
    id("org.jetbrains.kotlin.plugin.compose") version "2.0.21" apply false
}
