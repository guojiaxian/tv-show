import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// 读取根目录 gradle.properties 中的签名配置，缺省时回退为 debug 签名
val signingProps = Properties().apply {
    val f = rootProject.file("gradle.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "com.digitalcenter.tvshow"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.digitalcenter.tvshow"
        // 兼容老款小米电视（MIUI TV 基于 Android 6.0.1 / SDK 23），minSdk 不能高于 23
        minSdk = 23
        targetSdk = 34
        // 小米电视覆盖安装要求 versionCode 严格递增，禁止回退
        versionCode = 20
        versionName = "1.8"
    }

    signingConfigs {
        create("release") {
            val storePath = signingProps.getProperty("TVSHOW_STORE_FILE", "keystore/tvshow-release.jks")
            val storeFileObj = rootProject.file(storePath)
            if (storeFileObj.exists()) {
                storeFile = storeFileObj
                storePassword = signingProps.getProperty("TVSHOW_STORE_PASSWORD")
                keyAlias = signingProps.getProperty("TVSHOW_KEY_ALIAS")
                keyPassword = signingProps.getProperty("TVSHOW_KEY_PASSWORD")
            }
            // 小米等电视端内置安装器依赖 v1（JAR）签名校验，AGP 8 在 minSdk>=24 时默认关闭，
            // 缺失会导致「检测安装包异常，无法安装」；官方要求按 v1、v2、v3 顺序全量签名
            enableV1Signing = true
            enableV2Signing = true
            enableV3Signing = true
        }
        // debug 签名同样补齐 v1/v2/v3，便于电视端直接安装调试包
        getByName("debug") {
            enableV1Signing = true
            enableV2Signing = true
            enableV3Signing = true
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            val releaseSigning = signingConfigs.getByName("release")
            signingConfig = if (releaseSigning.storeFile != null) {
                releaseSigning
            } else {
                signingConfigs.getByName("debug")
            }
        }
        debug {
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
        viewBinding = true
    }

    packaging {
        resources.excludes += setOf("META-INF/*.kotlin_module")
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.6.1")
}
