plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// 自签名密钥由 scripts/build-apk.sh 生成（不入库）。
// CI 里靠 GitHub Actions 缓存/Secret 复用同一把 key，否则每次构建都是新签名，
// 覆盖安装会报签名不一致，必须先卸载。
val localKeystore = rootProject.file("keystore/veliora.jks")

// 版本号由构建脚本经 -PvelioraVersionCode / -PvelioraVersionName 传入；
// 下面的默认值只是兜底（直接在 Android Studio 里点 Run 时会用到）。
val velioraVersionCode = (project.findProperty("velioraVersionCode") as String?)?.toIntOrNull() ?: 4
val velioraVersionName = (project.findProperty("velioraVersionName") as String?) ?: "1.0.1"

android {
    namespace = "org.veliora.television"
    compileSdk = 35

    defaultConfig {
        applicationId = "org.veliora.television"
        minSdk = 26
        targetSdk = 35
        // versionCode 只增不减：回退或长期不变会导致电视上无法覆盖安装
        versionCode = velioraVersionCode
        versionName = velioraVersionName
    }

    signingConfigs {
        create("release") {
            if (localKeystore.exists()) {
                storeFile = localKeystore
                storePassword = "veliora"
                keyAlias = "veliora"
                keyPassword = "veliora"
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // keystore 缺失时回退 debug 签名，保证 assembleRelease 总能出包
            signingConfig = if (localKeystore.exists())
                signingConfigs.getByName("release")
            else
                signingConfigs.getByName("debug")
        }
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
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // 原生播放器：MediaCodec 硬解直通，4K/HEVC 不受 WebView MSE 限制
    implementation("androidx.media3:media3-exoplayer:1.5.1")
    implementation("androidx.media3:media3-exoplayer-hls:1.5.1")
    implementation("androidx.media3:media3-ui:1.5.1")
}
