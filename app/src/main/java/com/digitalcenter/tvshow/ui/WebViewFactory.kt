package com.digitalcenter.tvshow.ui

import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import android.util.Log
import android.webkit.WebSettings
import android.webkit.WebView
import com.digitalcenter.tvshow.config.AutoLoginConfig
import com.digitalcenter.tvshow.util.ViewportFit
import org.json.JSONObject
import kotlin.math.roundToInt

/**
 * 展示类 WebView 的公共装配：密度重写、setInitialScale、注入脚本缓存。
 *
 * 展示页与分区展示页共用同一套实现，避免两处规则漂移：
 *  - 密度重写：把 WebView 的 density 改为 `控件物理宽 / 目标 CSS 宽`，
 *    这样 1080p 电视拿到 1920×1080 的 CSS 视口，页面按大屏设计稿布局；
 *  - setInitialScale 兜底：部分电视固件忽略密度重写，用 [ViewportFit] 反推百分比；
 *  - 注入脚本只读一次：轮询/多格重载反复读 assets 没有意义。
 */
object WebViewFactory {

    /** 大屏页面的目标 CSS 视口：1920×1080（16:9），页面一律按此宽度布局 */
    const val TARGET_CSS_WIDTH = 1920
    const val TARGET_CSS_HEIGHT = 1080
    const val DENSITY_DPI_MIN = 60
    const val DENSITY_DPI_MAX = 1000

    /** 注入脚本路径（assets 下） */
    const val NAV_SCRIPT = "js/tv_nav.js"
    const val LOGIN_SCRIPT = "js/auto_login.js"

    /** 密度重写后的 WebView 与其名义参数 */
    class DisplayWebView(
        val webView: WebView,
        val densityDpi: Int,
        val density: Float
    )

    /**
     * 创建用于展示的 WebView：按目标 CSS 宽重写密度，并施加通用设置。
     *
     * @param hostWidthPx 控件在屏幕上的物理宽度（整屏或分区格宽）
     * @param targetCssWidth 目标 CSS 视口宽度（大屏页与分区页都是 1920）
     * @param uaVersionSuffix UA 后缀，用于区分展示页 / 分区页
     * @param minDensityDpi 密度下限（整屏 60，分区因格宽较小可放宽到 40）
     * @param configure 额外设置（如 databaseEnabled / loadsImagesAutomatically）
     */
    fun create(
        context: Context,
        hostWidthPx: Int,
        targetCssWidth: Int = TARGET_CSS_WIDTH,
        uaVersionSuffix: String,
        minDensityDpi: Int = DENSITY_DPI_MIN,
        configure: WebSettings.() -> Unit = {}
    ): DisplayWebView {
        val densityDpi = (160f * hostWidthPx / targetCssWidth)
            .roundToInt()
            .coerceIn(minDensityDpi, DENSITY_DPI_MAX)

        val config = Configuration(context.resources.configuration)
        config.densityDpi = densityDpi
        val displayContext = context.createConfigurationContext(config)
        val density = displayContext.resources.displayMetrics.density

        val webView = WebView(displayContext).apply {
            setBackgroundColor(Color.BLACK)
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                // 忽略页面自带的 viewport meta：布局宽度完全由 setInitialScale 决定，
                // 否则页面写死 width=device-width 时视口会跟着电视密度跑偏（960/980）
                useWideViewPort = false
                loadWithOverviewMode = false
                // 缩放由应用统一控制（菜单键 → 放大/缩小），避免与遥控器方向键冲突
                setSupportZoom(false)
                builtInZoomControls = false
                displayZoomControls = false
                mediaPlaybackRequiresUserGesture = false
                mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                cacheMode = WebSettings.LOAD_DEFAULT
                allowFileAccess = false
                allowContentAccess = false
                userAgentString = "$userAgentString $uaVersionSuffix"
                configure()
            }
        }
        return DisplayWebView(webView, densityDpi, density)
    }

    /**
     * 把 CSS 视口强制成 [targetCssWidth]：必须在 loadUrl 之前调用。
     * @return 实际应用的 initialScale 百分比（后续校准要用）
     */
    fun applyInitialScale(
        context: Context,
        webView: WebView,
        hostWidthPx: Int,
        density: Float,
        targetCssWidth: Int = TARGET_CSS_WIDTH
    ): Int {
        val percent = ViewportFit.scalePercent(context, hostWidthPx, density, targetCssWidth)
        webView.setInitialScale(percent)
        return percent
    }

    /** 生成注入用的自动登录配置 JSON（展示页与分区页共用） */
    fun autoLoginJson(login: AutoLoginConfig): String = JSONObject().apply {
        put("enabled", true)
        put("username", login.username)
        put("password", login.password)
        put("usernameSelector", login.usernameSelector)
        put("passwordSelector", login.passwordSelector)
        put("submitSelector", login.submitSelector)
        put("successSelector", login.successSelector)
        put("maxAttempts", 3)
        // 跨页面重载累计上限，防止站点登录失败时陷入「重载 → 再登录」死循环
        put("maxTotalAttempts", 3)
    }.toString()

    /** 注入自动登录脚本（脚本内容由调用方从 assets 读取） */
    fun injectAutoLogin(webView: WebView, login: AutoLoginConfig, script: String) {
        webView.evaluateJavascript(
            "window.__TV_AUTOLOGIN_DONE__=false;" +
                "window.__TV_AUTOLOGIN__=${autoLoginJson(login)};\n$script",
            null
        )
    }

    /** 注入 [ViewportFit.FILL_SCRIPT]，修补旧内核 100vh 解析错误导致的半屏塌陷 */
    fun fillViewport(webView: WebView, tag: String) {
        webView.evaluateJavascript(ViewportFit.FILL_SCRIPT) { result ->
            Log.d(tag, "100vh 修补结果（改写元素数）：$result")
        }
    }

    /** 销毁 WebView：先停加载清历史，避免持有已销毁实例的页面回调 */
    fun destroy(webView: WebView?) {
        if (webView == null) return
        webView.stopLoading()
        webView.loadUrl("about:blank")
        webView.clearHistory()
        webView.removeAllViews()
        webView.destroy()
    }
}

/** assets 注入脚本的一次性缓存（展示页轮询 / 分区页四格共享） */
class AssetScriptCache(private val context: Context, private val tag: String) {

    private val cache = HashMap<String, String>()

    fun read(path: String): String? {
        cache[path]?.let { return it }
        return runCatching {
            context.assets.open(path).bufferedReader().use { it.readText() }
        }.onSuccess { cache[path] = it }
            .onFailure { Log.w(tag, "读取资源失败：$path", it) }
            .getOrNull()
    }
}
