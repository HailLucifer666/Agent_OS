plugins {
    id("com.android.application")
    kotlin("android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.mythos.nodes.wear"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.mythos.nodes.wear"
        // Wear OS 4. BLUETOOTH_ADVERTISE is a runtime permission from 31, and
        // 33 is what current watches actually ship, so there is no older
        // BLUETOOTH/BLUETOOTH_ADMIN compatibility path to maintain here.
        minSdk = 33
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    implementation(project(":shared"))

    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-compose:1.9.1")
    implementation("androidx.lifecycle:lifecycle-service:2.8.4")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.4")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    // Wear Compose — the round-screen-aware layout primitives. Material3 on the
    // phone, wear.compose.material on the watch; they are separate artifacts.
    implementation(platform("androidx.compose:compose-bom:2024.09.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.wear.compose:compose-material:1.4.0")
    implementation("androidx.wear.compose:compose-foundation:1.4.0")
    debugImplementation("androidx.compose.ui:ui-tooling")

    // Counter persistence — §11.2 requires the last-used counter to survive a
    // restart, or every reboot reopens a replay window.
    implementation("androidx.datastore:datastore-preferences:1.1.1")

    // Realm key at rest. The key is the mesh's shared secret; it never belongs
    // in plain SharedPreferences or a log line.
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
}
