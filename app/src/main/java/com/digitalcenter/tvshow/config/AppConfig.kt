package com.digitalcenter.tvshow.config

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.URI

/** 自动登录配置 */
data class AutoLoginConfig(
    val enabled: Boolean = false,
    val username: String = "",
    val password: String = "",
    val usernameSelector: String = "",
    val passwordSelector: String = "",
    val submitSelector: String = "",
    val successSelector: String = ""
)

/** 入口类型：普通网页大屏 */
const val ENTRY_TYPE_URL = "url"
/** 入口类型：内置画面墙（直接看摄像机，url 为空，内容来自服务端 /api/cameras） */
const val ENTRY_TYPE_CAMERA = "camera"

/** 单个大屏入口配置（字段与服务端下发结构一一对应） */
data class DisplayEntry(
    val id: String,
    val title: String,
    val subtitle: String,
    val url: String,
    /** 入口类型：url / camera（见 [ENTRY_TYPE_URL]、[ENTRY_TYPE_CAMERA]） */
    val type: String = ENTRY_TYPE_URL,
    /** 主题色，形如 #2FD2F5 */
    val accent: String = "#2FD2F5",
    /** 图标标识：storage / env / security / 其它 */
    val icon: String = "",
    /** 缩放百分比，100 表示原始比例，0 或省略表示使用默认值 */
    val scale: Int = 0,
    /** 内容宽度超出视口时自动缩小以铺满屏幕 */
    val autoFit: Boolean = true,
    /** 允许忽略自签名证书错误（内网 https 场景） */
    val allowInsecureSsl: Boolean = false,
    /** 旧内核兼容：改走服务端反向代理，由服务端把现代 JS 降级到老内核可解析 */
    val compatTranspile: Boolean = false,
    /** 极速模式：本页是否参与截图展示（参与与否由服务端配置统一下发） */
    val turboEnabled: Boolean = true,
    /** 极速模式：本页刷新率（秒），服务端按它周期截图 */
    val turboIntervalSec: Double = 2.0,
    /** 极速模式：本页 JPEG 质量（50~95） */
    val turboQuality: Int = 75,
    val autoLogin: AutoLoginConfig? = null
) {
    /** 内置画面墙入口：没有网页地址，由客户端原生渲染摄像机画面 */
    val isCamera: Boolean get() = type == ENTRY_TYPE_CAMERA
}

/**
 * 极速模式展示地址：服务端包装页（双缓冲刷帧 + 心跳），刷新率/质量由服务端按
 * 该入口后台配置内联注入，客户端不传参数。
 */
fun turboUrlOf(entry: DisplayEntry, serverBaseUrl: String): String =
    serverBaseUrl.trimEnd('/') + "/shot/" + entry.id + "/view"

/**
 * 画面墙网页地址（服务端 ES5 页面，内嵌三条按行合成的 MJPEG）：
 * 供轮询展示 / 分区展示的 WebView 内嵌加载；首页打开画面墙仍走原生 CameraWallActivity。
 */
fun cameraViewUrlOf(serverBaseUrl: String): String =
    serverBaseUrl.trimEnd('/') + "/cam/view"

/**
 * 实际加载地址判定（单一出口，轮询/分区/单页共用）：
 *  1. 画面墙（type=camera）：加载服务端画面墙网页（轮询/分区内嵌场景）；
 *  2. 本机极速模式总开关开启 且 该页在服务端配置为参与：走服务端截图包装页；
 *  3. 其余：原逻辑（直连或兼容代理）。
 */
fun effectiveUrlOf(entry: DisplayEntry, serverBaseUrl: String, turboEnabled: Boolean): String =
    when {
        entry.isCamera -> cameraViewUrlOf(serverBaseUrl)
        turboEnabled && entry.turboEnabled -> turboUrlOf(entry, serverBaseUrl)
        else -> displayUrlOf(entry, serverBaseUrl)
    }

/**
 * 展示地址：开启「旧内核兼容转译」的入口改经服务端反向代理加载。
 *
 * 老电视的系统 WebView 内核（如小米电视的 Chrome 66）解析不了现代 SPA 产物里的
 * `??`、公有类字段等语法，直连只会得到一块白屏；经 `/proxy/<id>/…` 由服务端降级后
 * 再下发才能正常渲染。代理地址按「上游 pathname + search + hash」1:1 镜像，
 * 与电脑端 [proxySrcOf] 的规则一致。未开启该开关的入口保持直连，行为不变。
 */
fun displayUrlOf(entry: DisplayEntry, serverBaseUrl: String): String {
    if (!entry.compatTranspile) return entry.url
    return try {
        val u = URI(entry.url)
        val path = u.rawPath?.takeIf { it.isNotEmpty() } ?: "/"
        val query = u.rawQuery?.let { "?$it" }.orEmpty()
        val hash = u.rawFragment?.let { "#$it" }.orEmpty()
        serverBaseUrl.trimEnd('/') + "/proxy/" + entry.id + path + query + hash
    } catch (e: Exception) {
        Log.w("ConfigJson", "兼容代理地址生成失败，退回直连：${entry.url}", e)
        entry.url
    }
}

/**
 * 服务端下发的完整配置（也是本地兜底配置的载体）。
 * version/epoch 用于增量同步；本地兜底配置的 version 为 0。
 *
 * 这里只包含**内容**（页面列表、系统标题）；轮询与分区属于本机展示策略，
 * 由 [LocalSettings] 单独保存。
 */
data class RemoteConfig(
    val appTitle: String,
    val appSubtitle: String,
    val exitConfirm: Boolean,
    val exitTip: String,
    val entries: List<DisplayEntry>,
    val version: Long = 0L,
    val epoch: Long = 0L
) {
    fun entryOf(id: String?): DisplayEntry? = entries.firstOrNull { it.id == id }
}

/** 拼接大屏固定为 2×2，共 4 个分区 */
const val ZONE_COUNT = 4
/** 每个分区的目标分辨率：无论屏幕多大，分区页面的 CSS 视口都按 1920×1080 建立 */
const val ZONE_MIN_WIDTH = 1920
const val ZONE_MIN_HEIGHT = 1080
/** 轮询默认间隔（秒） */
const val DEFAULT_INTERVAL_SEC = 15
/** 轮询间隔允许范围（秒） */
const val MIN_INTERVAL_SEC = 1
const val MAX_INTERVAL_SEC = 3600

/** 同步参数（服务端地址与超时来自本地引导配置） */
data class SyncSettings(
    val connectTimeoutMs: Int = 3000,
    val readTimeoutMs: Int = 5000,
    /** >0 时启用后台定时轮询；默认 0（关闭），只在启动/回到前台/手动时同步 */
    val pollIntervalSec: Int = 0,
    /** 回到前台时两次同步的最小间隔，避免频繁请求 */
    val minSyncIntervalMs: Long = 15_000L
)

/** 本地引导配置：只负责“去哪里取数据”与“取不到时显示什么” */
data class BootstrapConfig(
    val serverBaseUrl: String,
    val sync: SyncSettings,
    val fallback: RemoteConfig
)

/**
 * 配置模型与 JSON 解析工具。
 *
 * 职责边界：**内容**（入口列表、系统标题）一律来自服务端，客户端不做增删改；
 * **展示策略**（轮询、分区）是本机设置，见 [LocalSettings]。
 */
object ConfigJson {

    fun parseAutoLogin(obj: JSONObject?): AutoLoginConfig? {
        if (obj == null) return null
        return AutoLoginConfig(
            enabled = obj.optBoolean("enabled", true),
            username = obj.optString("username", ""),
            password = obj.optString("password", ""),
            usernameSelector = obj.optString("usernameSelector", ""),
            passwordSelector = obj.optString("passwordSelector", ""),
            submitSelector = obj.optString("submitSelector", ""),
            successSelector = obj.optString("successSelector", "")
        )
    }

    fun parseEntry(obj: JSONObject): DisplayEntry? {
        val url = obj.optString("url").trim()
        val type = obj.optString("type").trim().ifBlank { ENTRY_TYPE_URL }
        // 画面墙入口（type=camera）没有网页地址，内容来自服务端摄像头接口；
        // 其余类型必须有地址，否则视为无效条目
        if (url.isEmpty() && type != ENTRY_TYPE_CAMERA) return null
        val id = obj.optString("id").trim()
        return DisplayEntry(
            id = id.ifBlank { "entry-" + url.hashCode().toString(16) },
            title = obj.optString("title").ifBlank { "未命名大屏" },
            subtitle = obj.optString("subtitle", ""),
            url = url,
            type = type,
            accent = obj.optString("accent", "#2FD2F5"),
            icon = obj.optString("icon", ""),
            scale = obj.optInt("scale", 0),
            autoFit = obj.optBoolean("autoFit", true),
            allowInsecureSsl = obj.optBoolean("allowInsecureSsl", false),
            compatTranspile = obj.optBoolean("compatTranspile", false),
            turboEnabled = obj.optBoolean("turboEnabled", true),
            turboIntervalSec = obj.optDouble("turboIntervalSec", 2.0)
                .let { if (it.isNaN()) 2.0 else it.coerceIn(0.2, 60.0) },
            turboQuality = obj.optInt("turboQuality", 75).coerceIn(50, 95),
            autoLogin = parseAutoLogin(obj.optJSONObject("autoLogin"))
        )
    }

    fun parseEntries(array: JSONArray?): List<DisplayEntry> {
        if (array == null) return emptyList()
        val out = ArrayList<DisplayEntry>(array.length())
        for (i in 0 until array.length()) {
            val obj = array.optJSONObject(i) ?: continue
            parseEntry(obj)?.let { out.add(it) }
        }
        return out
    }

    /** 解析全量配置（服务端 /api/config 的 full 字段，或本地兜底配置） */
    fun parseConfig(obj: JSONObject, fallback: RemoteConfig? = null): RemoteConfig {
        return RemoteConfig(
            appTitle = obj.optString("appTitle").ifBlank { fallback?.appTitle ?: "数智中心大屏聚合平台" },
            appSubtitle = obj.optString("appSubtitle", fallback?.appSubtitle ?: ""),
            exitConfirm = obj.optBoolean("exitConfirm", fallback?.exitConfirm ?: true),
            exitTip = obj.optString("exitTip").ifBlank { fallback?.exitTip ?: "按【返回】键将退出应用" },
            entries = parseEntries(obj.optJSONArray("entries")).ifEmpty { fallback?.entries ?: emptyList() },
            version = obj.optLong("version", fallback?.version ?: 0L),
            epoch = obj.optLong("epoch", fallback?.epoch ?: 0L)
        )
    }

    /** 判断一个 JSON 对象是否为“全量配置”形态 */
    fun looksLikeConfig(obj: JSONObject?): Boolean =
        obj != null && (obj.has("entries") || obj.has("appTitle"))

    /* ---------------- 序列化（与上面的解析成对维护） ---------------- */

    fun toJson(login: AutoLoginConfig): JSONObject = JSONObject().apply {
        put("enabled", login.enabled)
        put("username", login.username)
        put("password", login.password)
        put("usernameSelector", login.usernameSelector)
        put("passwordSelector", login.passwordSelector)
        put("submitSelector", login.submitSelector)
        put("successSelector", login.successSelector)
    }

    /**
     * 入口序列化（本地缓存用）。
     *
     * **新增模型字段时必须同步补在这里**：缓存是离线兜底，漏写字段会在重启后回落默认值，
     * 而服务端此时通常返回 304（版本未变），该字段就永远补不回来
     * —— 历史上 compatTranspile 就这样丢过，导致旧内核兼容失效继续白屏。
     * 与 [parseEntry] 放在同一文件成对维护，避免两处漏改。
     */
    fun toJson(entry: DisplayEntry): JSONObject = JSONObject().apply {
        put("id", entry.id)
        put("title", entry.title)
        put("subtitle", entry.subtitle)
        put("url", entry.url)
        put("type", entry.type)
        put("accent", entry.accent)
        put("icon", entry.icon)
        put("scale", entry.scale)
        put("autoFit", entry.autoFit)
        put("allowInsecureSsl", entry.allowInsecureSsl)
        put("compatTranspile", entry.compatTranspile)
        // 极速模式 3 字段同样必须写全（同 compatTranspile 教训）
        put("turboEnabled", entry.turboEnabled)
        put("turboIntervalSec", entry.turboIntervalSec)
        put("turboQuality", entry.turboQuality)
        entry.autoLogin?.let { put("autoLogin", toJson(it)) }
    }

    /** 全量配置序列化（写入本地缓存） */
    fun toJson(config: RemoteConfig): JSONObject = JSONObject().apply {
        put("appTitle", config.appTitle)
        put("appSubtitle", config.appSubtitle)
        put("exitConfirm", config.exitConfirm)
        put("exitTip", config.exitTip)
        put("version", config.version)
        put("epoch", config.epoch)
        put("entries", JSONArray().apply { config.entries.forEach { put(toJson(it)) } })
    }
}

/**
 * 引导配置加载器：只读“服务端地址 + 兜底内容”。
 *
 * 优先级：外部文件 > assets/config.json > 内置默认值。
 * 外部文件用于现场运维临时切换服务器地址（无需重新出包），
 * 兼容早期“顶层直接放 entries”的旧格式。
 */
object ConfigLoader {

    private const val TAG = "ConfigLoader"
    private const val ASSET_NAME = "config.json"
    const val EXTERNAL_FILE_NAME = "config.json"

    const val DEFAULT_SERVER_BASE_URL = "http://10.8.11.4:18000"

    fun externalFile(context: Context): File? =
        context.getExternalFilesDir(null)?.let { File(it, EXTERNAL_FILE_NAME) }

    fun loadBootstrap(context: Context): BootstrapConfig {
        val external = externalFile(context)
        if (external != null && external.isFile) {
            val text = runCatching { external.readText() }.getOrNull()
            parseBootstrap(text)?.let {
                Log.i(TAG, "已加载外部引导配置：${external.absolutePath} → ${it.serverBaseUrl}")
                return it
            }
            Log.w(TAG, "外部引导配置不可用，回退内置：${external.absolutePath}")
        }
        val assetText = runCatching {
            context.assets.open(ASSET_NAME).bufferedReader().use { it.readText() }
        }.getOrNull()
        return parseBootstrap(assetText) ?: defaultBootstrap()
    }

    fun parseBootstrap(text: String?): BootstrapConfig? {
        if (text.isNullOrBlank()) return null
        return runCatching {
            val root = JSONObject(text)

            // 兼容旧格式：顶层就是配置本身（没有 serverBaseUrl / fallback）
            val fallbackObj = root.optJSONObject("fallback")
            if (fallbackObj == null && root.has("entries")) {
                val legacy = ConfigJson.parseConfig(root)
                if (legacy.entries.isEmpty()) return null
                Log.i(TAG, "检测到旧版引导配置格式，已按兜底内容处理")
                return BootstrapConfig(DEFAULT_SERVER_BASE_URL, SyncSettings(), legacy)
            }

            val serverBaseUrl = root.optString("serverBaseUrl").trim()
                .ifBlank { DEFAULT_SERVER_BASE_URL }

            val syncObj = root.optJSONObject("sync")
            val sync = SyncSettings(
                connectTimeoutMs = syncObj?.optInt("connectTimeoutMs", 3000) ?: 3000,
                readTimeoutMs = syncObj?.optInt("readTimeoutMs", 5000) ?: 5000,
                pollIntervalSec = syncObj?.optInt("pollIntervalSec", 0) ?: 0,
                minSyncIntervalMs = syncObj?.optLong("minSyncIntervalMs", 15_000L) ?: 15_000L
            )

            val fallback = fallbackObj?.let { ConfigJson.parseConfig(it) } ?: defaultConfig()
            BootstrapConfig(serverBaseUrl.trimEnd('/'), sync, fallback)
        }.onFailure { Log.w(TAG, "引导配置解析异常", it) }.getOrNull()
    }

    /** 兜底内容：即使外部文件与 assets 都缺失也能正常启动 */
    fun defaultConfig(): RemoteConfig = RemoteConfig(
        appTitle = "数智中心大屏聚合平台",
        appSubtitle = "DIGITAL CENTER · DISPLAY HUB",
        exitConfirm = true,
        exitTip = "按【返回】键将退出应用",
        entries = listOf(
            DisplayEntry(
                id = "storage-monitor",
                title = "数智资源中心存储集群资源监控",
                subtitle = "存储集群容量总览 / 分区视图 / 容量趋势",
                url = "http://10.8.11.4:1111/",
                accent = "#2FD2F5",
                icon = "storage"
            ),
            DisplayEntry(
                id = "env-monitor",
                title = "数智资源中心机房动环监控",
                subtitle = "机房动力环境运行状态实时监控",
                url = "http://10.8.12.130/#/index",
                accent = "#3FE0A6",
                icon = "env",
                autoLogin = AutoLoginConfig(
                    enabled = true,
                    username = "show",
                    password = "wtzx@2026"
                )
            ),
            DisplayEntry(
                id = "security-cockpit",
                title = "物探中心网络安全监控与自动化运维平台",
                subtitle = "网络安全态势监测与自动化运维驾驶舱",
                url = "http://10.8.11.3/cockpit",
                accent = "#FFB020",
                icon = "security",
                autoLogin = AutoLoginConfig(
                    enabled = true,
                    username = "admin",
                    password = "admin",
                    usernameSelector = "#username",
                    passwordSelector = "#password",
                    submitSelector = "#loginBtn"
                )
            )
        )
    )

    fun defaultBootstrap(): BootstrapConfig =
        BootstrapConfig(DEFAULT_SERVER_BASE_URL, SyncSettings(), defaultConfig())
}
