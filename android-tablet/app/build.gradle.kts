plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.serialization") version "1.9.24"
}

android {
    namespace = "sk.surfspirit.pos"
    compileSdk = 34

    defaultConfig {
        applicationId = "sk.surfspirit.pos"
        minSdk = 26          // Android 8.0 — adaptívna ikona bez PNG; pokryje bežné 10.1" tablety
        targetSdk = 34
        versionCode = 21
        versionName = "3.0.1"
        // Default adresa POS servera (LAN). Mení sa v appke → uloží do prefs.
        resValue("string", "default_server_url", "http://192.168.1.235:3080")
    }

    buildTypes {
        release {
            // Distribúcia zatiaľ beží cez assembleDebug (auto-update kanál) —
            // minifikácia ovplyvní len release kanál. Keep rules pre
            // kotlinx-serialization DTO už sú v proguard-rules.pro.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
        // Strong skipping (experimentálne v Compose compiler 1.5.14) — skipuje aj
        // composables s nestabilnými parametrami a memoizuje lambdy → menej
        // recompozícií product gridu pri rýchlom markovaní. Default až v Kotlin 2.x.
        freeCompilerArgs += listOf(
            "-P", "plugin:androidx.compose.compiler.plugins.kotlin:strongSkipping=true",
        )
    }

    buildFeatures { compose = true; buildConfig = true }   // buildConfig pre VERSION_CODE (auto-update)
    composeOptions { kotlinCompilerExtensionVersion = "1.5.14" }   // pre Kotlin 1.9.24

    packaging {
        resources { excludes += "/META-INF/{AL2.0,LGPL2.1}" }
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.06.00")
    implementation(composeBom)

    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-compose:1.9.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.4")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.4")   // LifecycleResumeEffect
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.4")

    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.navigation:navigation-compose:2.7.7")
    // Glassmorphism — reálny backdrop blur (RenderEffect API 31+, fallback nižšie)
    implementation("dev.chrisbanes.haze:haze:0.7.3")
    // View-Material knižnica — poskytuje XML tému Theme.Material3.* (themes.xml)
    implementation("com.google.android.material:material:1.12.0")

    // Sieť — Retrofit + OkHttp + kotlinx-serialization
    implementation("com.squareup.retrofit2:retrofit:2.11.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.okhttp3:logging-interceptor:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")
    // Oficiálny Retrofit kotlinx-serialization converter (zladený s 2.11.0)
    implementation("com.squareup.retrofit2:converter-kotlinx-serialization:2.11.0")

    debugImplementation("androidx.compose.ui:ui-tooling")
}

// Dizajn tokeny (ui/theme/Dimens.kt) — lacný regex strážca: žiadne literálové
// radius/elevation/icon-size/fontSize v ui zdrojoch mimo theme/. Výnimka
// potrebuje `// token-exempt: dôvod` na TOM ISTOM riadku. Spacing sa nestráži
// (konvencia). Ratchet: allowlist nemigrovaných súborov drž prázdny.
val tokenExemptAllowlist = setOf<String>()

tasks.register("checkDesignTokens") {
    group = "verification"
    description = "Zlyhá pri literálových dp/sp hodnotách mimo dizajn tokenov v ui zdrojoch"
    doLast {
        val uiDir = file("src/main/java/sk/surfspirit/pos/ui")
        val patterns = listOf(
            Regex("""RoundedCornerShape\(\s*\d+(\.\d+)?\.dp"""),
            Regex("""paperShadow\(\s*\d+(\.\d+)?\.dp"""),
            Regex("""fontSize\s*=\s*\d+(\.\d+)?\.sp"""),
        )
        val violations = mutableListOf<String>()
        uiDir.walkTopDown()
            .filter { it.isFile && it.extension == "kt" && !it.path.replace('\\', '/').contains("/theme/") }
            .filter { it.name !in tokenExemptAllowlist }
            .forEach { f ->
                f.readLines().forEachIndexed { i, line ->
                    if (line.contains("token-exempt")) return@forEachIndexed
                    patterns.forEach { p ->
                        if (p.containsMatchIn(line)) violations += "${f.name}:${i + 1}: ${line.trim().take(100)}"
                    }
                }
            }
        if (violations.isNotEmpty()) {
            throw GradleException(
                "Dizajn tokeny: ${violations.size} literálov mimo Dimens.kt (pridaj token alebo // token-exempt):\n" +
                violations.take(40).joinToString("\n"))
        }
    }
}

tasks.named("check") { dependsOn("checkDesignTokens") }
