plugins {
    id("com.android.library")
    kotlin("android")
}

android {
    namespace = "com.mythos.nodes.shared"
    compileSdk = 35

    defaultConfig {
        // Low enough to be shared by both the watch and the phone module.
        minSdk = 26
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    testImplementation(kotlin("test"))
}
