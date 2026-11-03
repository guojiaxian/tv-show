package com.digitalcenter.tvshow.ui

import android.annotation.SuppressLint
import android.app.Dialog
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.net.http.SslError
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.digitalcenter.tvshow.R
import com.digitalcenter.tvshow.config.AutoLoginConfig
import com.digitalcenter.tvshow.config.ConfigLoader
import com.digitalcenter.tvshow.config.DisplayEntry
import com.digitalcenter.tvshow.config.LocalSettings
import com.digitalcenter.tvshow.config.RotationSetting
import com.digitalcenter.tvshow.config.TurboSetting
import com.digitalcenter.tvshow.config.CommandApplier
import com.digitalcenter.tvshow.config.displayUrlOf
import com.digitalcenter.tvshow.config.effectiveUrlOf
import com.digitalcenter.tvshow.databinding.ActivityWebBinding
import com.digitalcenter.tvshow.net.ConfigRepository
import com.digitalcenter.tvshow.net.ControlChannel
import com.digitalcenter.tvshow.util.UiUtil
import com.digitalcenter.tvshow.util.ViewportFit
import org.json.JSONObject
import kotlin.math.roundToInt

/**
 * 大屏展示页：使用 WebView 加载指定 IP + 端口的展示页面，
 * 并将电视遥控器按键映射到网页元素（焦点移动 / 触发点击）。
 */
class WebDisplayActivity : AppCompatActivity(), CommandApplier.Reloadable {

    companion object {
        const val EXTRA_ENTRY_ID = "extra_entry_id"
        /** 轮询播放模式：按本机轮询设置自动切页 */
        const val EXTRA_ROTATION = "extra_rotation"
        private const val TAG = "WebDisplay"
        private const val NAV_SCRIPT = "js/tv_nav.js"
        private const val LOGIN_SCRIPT = "js/auto_login.js"
        private const val ZOOM_MIN = 50
        private const val ZOOM_MAX = 200
        private const val ZOOM_STEP = 10
        private const val OVERLAY_DURATION_MS = 3000L

        /** 大屏页面的目标 CSS 视口：1920×1080（16:9），页面一律按此宽度布局 */
        private const val TARGET_CSS_WIDTH = 1920
        private const val TARGET_CSS_HEIGHT = 1080
        private const val DENSITY_DPI_MIN = 60
        private const val DENSITY_DPI_MAX = 1000

        /** 视口不达标时最多重载几次（校准密度因子用，一次即可收敛） */
        private const val MAX_CALIBRATION_RELOADS = 2

        /**
         * 现代 SPA（Vite/webpack 现代构建）需要的内核下限。
         * `??`（空值合并）需 Chrome 80、类字段需 Chrome 72，都是**语法解析**错误，
         * 注入 polyfill 也救不了；低于该版本打开这类页面只会得到一块白屏。
         */
        private const val WEBVIEW_MIN_FOR_MODERN_SPA = 80

        /** 白屏探测：延迟与轮次（首屏渲染较慢的页面需要多等几轮） */
        private const val BLANK_CHECK_DELAY_MS = 4000L
        private const val BLANK_CHECK_ROUNDS = 2

        /** 探测页面是否「有内容」：至少 2 个已渲染且尺寸正常的元素 */
        private const val BLANK_PROBE_SCRIPT =
            "(function(){try{var b=document.body;if(!b)return 0;" +
                "var l=b.querySelectorAll('*'),n=0;" +
                "for(var i=0;i<l.length&&i<4000;i++){var e=l[i],t=(e.tagName||'').toLowerCase();" +
                "if(t==='script'||t==='style'||t==='noscript'||t==='link'||t==='meta'||t==='template')continue;" +
                "var r=e.getBoundingClientRect();" +
                "if(r.width>=20&&r.height>=20){n++;if(n>=2)return 1;}}" +
                "return 0;}catch(e){return 1;}})()"

        /** 生成注入用的自动登录配置 JSON（分区展示也会复用） */
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
    }

    private lateinit var binding: ActivityWebBinding
    private lateinit var webView: WebView
    private val handler = Handler(Looper.getMainLooper())

    private var entry: DisplayEntry? = null
    private var zoomPercent = 100
    private var pageError = false
    private var autoFitApplied = false
    /** 最近一次应用「入口缩放/自动适配」的入口 id：轮询切页时据此重置，避免沿用上一页的缩放 */
    private var zoomEntryId: String? = null
    /** 当前入口是否经服务端兼容代理加载（决定自动登录由服务端还是客户端注入） */
    private var viaCompatProxy = false
    /** 当前入口是否走极速模式截图包装页（自动登录由服务端完成，客户端不再注入） */
    private var viaTurbo = false
    /** 实际加载的地址（走代理时与入口原始地址不同，浮层显示它便于现场核对） */
    private var loadedUrl = ""
    /** 最近一条脚本错误（含语法错误），白屏时直接显示在电视上，现场无 adb 也能定位 */
    private var lastJsError = ""
    private var overlayToken = 0
    private var controlDialog: Dialog? = null

    /** 白屏探测令牌：每次重新加载递增，旧一轮探测自动作废 */
    private var blankToken = 0

    /** 本 WebView 的名义密度（displayContext 的 density），用于反推真实 dpr */
    private var displayDensity = 1f
    /** 当前 setInitialScale 百分比：把 CSS 视口强制到 TARGET_CSS_WIDTH */
    private var initialScalePercent = 100
    /** 本页因视口校准重载的次数，避免反复重载 */
    private var calibrationReloads = 0
    /** 最近一次实测视口（显示在信息浮层，现场无 adb 也能核对） */
    private var viewportText = ""

    /** WebView 内核主版本号（从 UA 解析，用于兼容性诊断；0 表示解析失败） */
    private val chromeMajor: Int by lazy {
        Regex("Chrome/(\\d+)").find(webView.settings.userAgentString ?: "")
            ?.groupValues?.getOrNull(1)?.toIntOrNull() ?: 0
    }

    /* ---------- 轮询播放状态（序列与间隔来自本机设置） ---------- */
    private var config: com.digitalcenter.tvshow.config.RemoteConfig = ConfigLoader.defaultConfig()
    private var rotationSetting = RotationSetting()
    private var rotationActive = false
    private var rotationEntries: List<DisplayEntry> = emptyList()
    private var rotationIndex = 0

    /** 注入脚本只读一次：轮询/刷新反复读 assets 没有意义 */
    private val assetCache = HashMap<String, String>()

    /** 每秒刷新轮询倒计时指示 */
    private val rotationTick = object : Runnable {
        override fun run() {
            if (!rotationActive) return
            renderRotationChip()
            handler.postDelayed(this, 1000L)
        }
    }

    /** 到达间隔边界时切到下一页 */
    private val rotationAdvance = Runnable {
        if (!rotationActive || rotationEntries.isEmpty()) return@Runnable
        rotationIndex = (rotationIndex + 1) % rotationEntries.size
        entry = rotationEntries[rotationIndex]
        Log.i(TAG, "轮询切页 → ${rotationIndex + 1}/${rotationEntries.size} ${entry?.title}")
        startLoad()
        showInfoOverlay()
        scheduleRotation()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityWebBinding.inflate(layoutInflater)
        setContentView(binding.root)

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        UiUtil.applyImmersive(this)

        val entryId = intent.getStringExtra(EXTRA_ENTRY_ID)
        // 入口信息统一来自同步层（服务端下发，失败时回退本地缓存/兜底内容）
        ConfigRepository.init(this)
        config = ConfigRepository.snapshot()

        if (intent.getBooleanExtra(EXTRA_ROTATION, false)) {
            rotationSetting = LocalSettings.rotation(this)
            rotationEntries = LocalSettings.rotationEntries(config, rotationSetting)
            if (rotationEntries.isEmpty()) {
                Toast.makeText(this, R.string.rotation_unavailable, Toast.LENGTH_LONG).show()
                finish()
                return
            }
            rotationActive = true
            rotationIndex = computeRotationIndex()
        }

        val resolved = if (rotationActive) rotationEntries[rotationIndex] else config.entryOf(entryId)
        if (resolved == null) {
            Toast.makeText(this, R.string.entry_unavailable, Toast.LENGTH_LONG).show()
            finish()
            return
        }
        entry = resolved
        if (resolved.scale > 0) zoomPercent = resolved.scale.coerceIn(ZOOM_MIN, ZOOM_MAX)

        webView = createDisplayWebView()
        binding.webContainer.addView(
            webView,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        )

        setupWebView()
        binding.retryButton.setOnClickListener { reloadPage() }

        startLoad()
        showInfoOverlay()
        if (rotationActive) {
            binding.rotationChip.visibility = View.VISIBLE
            renderRotationChip()
            scheduleRotation()
            Log.i(
                TAG,
                "轮询播放已启动：${rotationEntries.size} 页，间隔 ${rotationSetting.intervalSec}s，" +
                    "当前第 ${rotationIndex + 1} 页"
            )
        }
    }

    /* ---------------- 轮询播放 ---------------- */

    /**
     * 按本机轮询设置的**时钟起点**推导当前应显示第几页。
     * 起点在"保存轮询设置"时写入本机，因此退出重进、进程被杀后重新打开，
     * 都会接着原来的进度继续，而不是每次都从第 1 页重新计时。
     */
    private fun computeRotationIndex(): Int {
        val n = rotationEntries.size
        if (n <= 0) return 0
        val start = rotationSetting.startedAt
        if (start <= 0L) return 0
        val intervalMs = rotationSetting.intervalSec * 1000L
        val elapsed = System.currentTimeMillis() - start
        if (elapsed <= 0L) return 0
        return ((elapsed / intervalMs) % n).toInt()
    }

    /** 对齐到下一个切页边界（而不是"从现在起再等 N 秒"），保证长时间运行不累积漂移 */
    private fun scheduleRotation() {
        if (!rotationActive || rotationEntries.isEmpty()) return
        val intervalMs = rotationSetting.intervalSec * 1000L
        val start = rotationSetting.startedAt
        val now = System.currentTimeMillis()
        val nextAt = if (start > 0L) {
            val k = ((now - start) / intervalMs) + 1
            start + k * intervalMs
        } else {
            now + intervalMs
        }
        val delay = (nextAt - now).coerceIn(300L, intervalMs)
        handler.removeCallbacks(rotationAdvance)
        handler.postDelayed(rotationAdvance, delay)
        handler.removeCallbacks(rotationTick)
        handler.post(rotationTick)
    }

    private fun renderRotationChip() {
        if (!rotationActive || rotationEntries.isEmpty()) return
        val intervalMs = rotationSetting.intervalSec * 1000L
        val start = rotationSetting.startedAt
        val remaining = if (start > 0L) {
            val now = System.currentTimeMillis()
            val into = (now - start).coerceAtLeast(0L) % intervalMs
            ((intervalMs - into) / 1000L).coerceAtLeast(0L)
        } else {
            intervalMs / 1000L
        }
        binding.rotationChip.text = getString(
            R.string.rotation_chip,
            rotationIndex + 1,
            rotationEntries.size,
            remaining
        )
    }

    /* ---------------- WebView 初始化 ---------------- */

    /**
     * 创建用于展示大屏的 WebView。
     *
     * 电视在 1080p 下通常上报 2 倍密度，WebView 的 CSS 视口因此只有 960×540，
     * 页面会按手机/平板布局渲染，大屏设计稿被压扁或触发响应式降级。
     * 这里把 WebView 的密度重写为 `屏幕物理宽度 / 1920`：
     *  - 1080p：density 1.0，CSS 视口 1920×1080，1 CSS px = 1 物理像素（最清晰）
     *  - 4K：density 2.0，CSS 视口仍是 1920×1080，内容等比放大铺满屏幕
     *  - 720p：density 0.67，CSS 视口仍是 1920×1080
     * 于是任意 16:9 电视上都能拿到不低于 1920×1080 的 CSS 视口，且页面铺满屏幕。
     */
    private fun createDisplayWebView(): WebView {
        val metrics = resources.displayMetrics
        val densityDpi = (160f * metrics.widthPixels / TARGET_CSS_WIDTH)
            .roundToInt()
            .coerceIn(DENSITY_DPI_MIN, DENSITY_DPI_MAX)

        val config = Configuration(resources.configuration)
        config.densityDpi = densityDpi
        val displayContext = createConfigurationContext(config)
        displayDensity = displayContext.resources.displayMetrics.density

        val cssWidth = metrics.widthPixels * 160 / densityDpi
        val cssHeight = metrics.heightPixels * 160 / densityDpi
        Log.i(
            TAG,
            "屏幕 ${metrics.widthPixels}×${metrics.heightPixels}px, densityDpi=$densityDpi " +
                "→ WebView CSS 视口 ${cssWidth}×${cssHeight}"
        )

        return WebView(displayContext)
    }

    /**
     * 把 CSS 视口强制成 1920×1080（16:9）：
     * 布局宽度 = 控件像素宽 / (dpr × setInitialScale 百分比)，因此
     * `percent = 100 × 控件像素宽 / (dpr × 1920)`。密度重写在部分电视固件上不生效，
     * 这里不假设 dpr，而是用本机持久化的密度因子（见 [ViewportFit]）推算，
     * 页面加载完成后还会实测 innerWidth 反向校准。必须在 loadUrl 之前调用。
     */
    private fun applyViewportScale() {
        initialScalePercent = ViewportFit.scalePercent(
            this,
            resources.displayMetrics.widthPixels,
            displayDensity,
            TARGET_CSS_WIDTH
        )
        webView.setInitialScale(initialScalePercent)
        Log.i(
            TAG,
            "强制视口：initialScale=$initialScalePercent%（名义密度 $displayDensity，" +
                "密度因子 ${ViewportFit.factor(this)}，目标 ${TARGET_CSS_WIDTH}×$TARGET_CSS_HEIGHT）"
        )
    }

    /**
     * 页面加载完成后实测 CSS 视口宽度；偏离 1920 就校准密度因子并重载（最多 1~2 次）。
     * 因子与页面无关，校准一次后本机所有页面、后续启动都直接命中。
     */
    private fun calibrateViewport() {
        webView.evaluateJavascript(ViewportFit.PROBE_SCRIPT) { result ->
            if (pageError) return@evaluateJavascript
            val info = ViewportFit.parseProbe(result) ?: return@evaluateJavascript
            viewportText = info.readable
            Log.i(TAG, "视口实测：${info.readable}（目标 ${TARGET_CSS_WIDTH}×$TARGET_CSS_HEIGHT）")
            if (ViewportFit.matched(info, TARGET_CSS_WIDTH)) {
                // 视口已达标：把实测值显示出来，现场按【菜单】/进入页面即可核对
                showInfoOverlay()
                return@evaluateJavascript
            }
            if (calibrationReloads >= MAX_CALIBRATION_RELOADS) {
                Log.w(TAG, "视口校准已达上限，仍为 ${info.innerWidth}（目标 $TARGET_CSS_WIDTH）")
                showInfoOverlay()
                return@evaluateJavascript
            }
            val changed = ViewportFit.calibrate(
                this,
                resources.displayMetrics.widthPixels,
                displayDensity,
                info,
                initialScalePercent
            )
            if (!changed) return@evaluateJavascript
            calibrationReloads++
            applyViewportScale()
            webView.reload()
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        webView.setBackgroundColor(Color.BLACK)
        webView.isFocusable = true
        webView.isFocusableInTouchMode = true

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
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
            loadsImagesAutomatically = true
            userAgentString = "$userAgentString TvShowCenter/1.0"
        }

        applyViewportScale()

        webView.setWebViewClient(object : WebViewClient() {

            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: WebResourceRequest?
            ): Boolean {
                val uri = request?.url ?: return false
                return handleExternalScheme(uri)
            }

            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                pageError = false
                showLoading()
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                if (pageError) return
                binding.progressBar.visibility = View.GONE
                binding.loadingPanel.visibility = View.GONE
                injectScripts()
                calibrateViewport()
                scheduleBlankCheck()
                // 首屏后再补两次：SPA 常在第一帧之后才挂载全高骨架，
                // 而旧内核的 100vh 修补必须作用在已生成的节点上
                handler.postDelayed({ if (!pageError) applyViewportFill() }, 1500L)
                handler.postDelayed({ if (!pageError) applyViewportFill() }, 3500L)
                view?.requestFocus()

                if (!autoFitApplied) {
                    autoFitApplied = true
                    handler.postDelayed({ applyAutoFit() }, 1200L)
                }
            }

            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?
            ) {
                if (request?.isForMainFrame == true) {
                    Log.w(TAG, "主文档加载失败：${error?.description}")
                    showError(getString(R.string.error_network))
                }
            }

            override fun onReceivedHttpError(
                view: WebView?,
                request: WebResourceRequest?,
                errorResponse: WebResourceResponse?
            ) {
                val code = errorResponse?.statusCode ?: 0
                if (request?.isForMainFrame == true && code >= 400) {
                    Log.w(TAG, "主文档返回异常状态码：$code")
                    showError(getString(R.string.error_http, code))
                }
            }

            override fun onReceivedSslError(
                view: WebView?,
                handler: SslErrorHandler?,
                error: SslError?
            ) {
                if (entry?.allowInsecureSsl == true) {
                    Log.w(TAG, "已按配置忽略证书错误：${error?.url}")
                    handler?.proceed()
                } else {
                    Log.e(TAG, "证书校验失败：${error?.url}")
                    handler?.cancel()
                    showError(getString(R.string.error_ssl))
                }
            }
        })

        webView.setWebChromeClient(object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                binding.progressBar.progress = newProgress
                binding.progressBar.visibility =
                    if (newProgress in 1..99 && !pageError) View.VISIBLE else View.GONE
            }

            override fun onConsoleMessage(consoleMessage: ConsoleMessage?): Boolean {
                val m = consoleMessage
                Log.d(TAG, "[console] ${m?.message()} (${m?.sourceId()}:${m?.lineNumber()})")
                // 记下最近一条脚本错误：白屏时显示在电视上，现场无需 adb 即可读出原因
                if (m != null && m.messageLevel() == ConsoleMessage.MessageLevel.ERROR) {
                    val where = m.sourceId()?.takeLast(90).orEmpty()
                    lastJsError = "${m.message()}  @$where:${m.lineNumber()}".take(220)
                }
                return true
            }
        })
    }

    /** 非 http(s) 协议交给系统处理，避免在 WebView 内打开无效页面 */
    private fun handleExternalScheme(uri: Uri): Boolean {
        return when (uri.scheme?.lowercase()) {
            null, "http", "https", "about", "javascript", "data", "blob", "file", "ws", "wss" -> false
            else -> {
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, uri)) }
                true
            }
        }
    }

    /* ---------------- 页面加载与脚本注入 ---------------- */

    private fun startLoad() {
        val e = entry ?: return
        // 每个入口的 scale/autoFit 是独立配置：轮询切页时必须重置，
        // 否则第二页起会沿用第一页（或上一页自动适配后）的缩放比例。
        if (zoomEntryId != e.id) {
            zoomEntryId = e.id
            zoomPercent = if (e.scale > 0) e.scale.coerceIn(ZOOM_MIN, ZOOM_MAX) else 100
            autoFitApplied = false
        }
        // 开启旧内核兼容转译的入口改走服务端反向代理：服务端把现代 JS 降级后再下发，
        // 否则老内核（Chrome 66）解析即抛，页面只会白屏
        viaCompatProxy = e.compatTranspile
        // 本机极速模式总开关 + 该页在服务端配置为参与 → 加载服务端截图包装页
        viaTurbo = !e.isCamera && LocalSettings.turbo(this).enabled && e.turboEnabled
        val target = effectiveUrlOf(e, ConfigRepository.serverBaseUrl(), LocalSettings.turbo(this).enabled)
        loadedUrl = target
        lastJsError = ""
        // 换页/重新加载：重置视口校准计数（校准自身触发的 reload 不走这里）
        calibrationReloads = 0
        viewportText = ""
        if (viaTurbo) Log.i(TAG, "极速模式：加载服务端截图包装页 $target")
        else if (viaCompatProxy) Log.i(TAG, "兼容转译：改经服务端代理加载 $target")
        showLoading()
        webView.loadUrl(target)
        // 多设备互控：上报当前状态（单页与轮询切页都经过这里，一处覆盖全部路径）
        if (rotationActive) {
            ControlChannel.reportRotate(
                rotationIndex, rotationEntries.size,
                rotationSetting.intervalSec, rotationSetting.items
            )
        } else {
            ControlChannel.reportPage(e.id)
        }
    }

    /** 维护类指令 refresh 的落点（[CommandApplier] 经栈顶 Activity 调用） */
    override fun reloadCurrent() {
        reloadPage()
    }

    private fun reloadPage() {
        pageError = false
        autoFitApplied = false
        calibrationReloads = 0
        viewportText = ""
        showLoading()
        webView.reload()
    }

    private fun injectScripts() {
        // 1) 遥控器焦点导航引擎
        readAsset(NAV_SCRIPT)?.let { webView.evaluateJavascript(it, null) }

        // 2) 自动登录（按入口配置启用）
        //    走兼容代理时，服务端已在 HTML 里注入了同款脚本（标记 __TV_AUTOLOGIN_SERVER__），
        //    客户端不再重复注入，避免两套脚本各登录一次；
        //    极速模式同理：登录由服务端无头浏览器完成，包装页无需登录脚本
        val login = entry?.autoLogin
        if (!viaCompatProxy && !viaTurbo && login != null && login.enabled && login.password.isNotEmpty()) {
            readAsset(LOGIN_SCRIPT)?.let { script ->
                webView.evaluateJavascript(
                    "window.__TV_AUTOLOGIN_DONE__=false;" +
                        "window.__TV_AUTOLOGIN__=${autoLoginJson(login)};\n$script",
                    null
                )
            }
        }

        // 3) 应用缩放
        applyZoom()

        // 4) 修补旧内核 100vh 解析错误导致的「只占上半屏」
        applyViewportFill()
    }

    /** 注入 [ViewportFit.FILL_SCRIPT]，把因 100vh 失效而塌陷的页面骨架重新撑满 */
    private fun applyViewportFill() {
        webView.evaluateJavascript(ViewportFit.FILL_SCRIPT) { result ->
            Log.d(TAG, "100vh 修补结果（改写元素数）：$result")
        }
    }

    private fun readAsset(path: String): String? {
        assetCache[path]?.let { return it }
        return runCatching {
            assets.open(path).bufferedReader().use { it.readText() }
        }.onSuccess { assetCache[path] = it }
            .onFailure { Log.w(TAG, "读取资源失败：$path", it) }
            .getOrNull()
    }

    /* ---------------- 显示适配与缩放 ---------------- */

    /**
     * 应用缩放比例。
     *
     * 100% 时刻意**不写** zoom：根元素上的 zoom 会让浏览器为整个文档建立缩放渲染
     * 上下文，实时刷新的大屏页面（如动环监控）会因持续整体重绘而明显卡顿；
     * 需要恢复默认时清除内联样式即可。
     */
    private fun applyZoom() {
        val script = if (zoomPercent == 100) {
            "try{document.documentElement.style.zoom='';}catch(e){}"
        } else {
            "try{document.documentElement.style.zoom='${zoomPercent / 100.0}';}catch(e){}"
        }
        webView.evaluateJavascript(script, null)
    }

    /* ---------------- 白屏探测与兼容性提示 ---------------- */

    /**
     * 主文档加载完成后探测页面是否「一片空白」。
     *
     * 现场电视的 WebView 内核偏旧，而虚拟化集群、AI 大模型这类现代 SPA 使用了
     * `??`、类字段等新语法，脚本会直接解析失败，页面只剩白板且不给任何提示。
     * 这种情况无法靠注入脚本补救，至少要告诉用户原因与下一步该怎么办。
     */
    private fun scheduleBlankCheck() {
        val token = ++blankToken
        checkBlank(token, 0)
    }

    private fun checkBlank(token: Int, round: Int) {
        handler.postDelayed({
            if (token != blankToken || pageError) return@postDelayed
            webView.evaluateJavascript(BLANK_PROBE_SCRIPT) { result ->
                if (token != blankToken || pageError) return@evaluateJavascript
                if (result?.trim()?.trim('"') == "1") {
                    binding.compatPanel.visibility = View.GONE
                    return@evaluateJavascript
                }
                if (round + 1 >= BLANK_CHECK_ROUNDS) {
                    showCompatHint()
                } else {
                    checkBlank(token, round + 1)
                }
            }
        }, BLANK_CHECK_DELAY_MS)
    }

    private fun showCompatHint() {
        val base = if (chromeMajor in 1 until WEBVIEW_MIN_FOR_MODERN_SPA) {
            getString(R.string.compat_old_kernel, chromeMajor, WEBVIEW_MIN_FOR_MODERN_SPA)
        } else {
            getString(R.string.compat_blank)
        }
        // 把最近一条脚本错误直接显示在电视上：现场没有 adb 也能读出白屏原因
        binding.compatMessage.text = if (lastJsError.isNotEmpty()) {
            base + "\n\n" + getString(R.string.compat_last_error, lastJsError)
        } else {
            base
        }
        Log.w(TAG, "页面无可见内容（WebView 内核 Chrome/$chromeMajor，加载 $loadedUrl）：$lastJsError")
        binding.compatPanel.visibility = View.VISIBLE
    }

    /**
     * 页面内容宽度超出视口时（例如按 1920 固定宽度设计的大屏），
     * 自动计算缩放比例铺满电视屏幕。
     */
    private fun applyAutoFit() {
        if (entry?.autoFit != true || pageError) return
        val script = "(function(){try{var d=document.documentElement;" +
            "var w=Math.max(d.scrollWidth||0,(document.body&&document.body.scrollWidth)||0);" +
            "var v=window.innerWidth||0;" +
            "if(v>0&&w>v*1.06){var p=Math.floor(v/w*100);return p>95?0:p;}return 0;}catch(e){return 0;}})()"
        webView.evaluateJavascript(script) { result ->
            val fit = result?.trim()?.trim('"')?.toFloatOrNull()?.toInt() ?: 0
            if (fit in ZOOM_MIN until 100) {
                Log.i(TAG, "自动适配大屏缩放：$fit%")
                zoomPercent = fit
                applyZoom()
                showInfoOverlay()
            }
        }
    }

    private fun changeZoom(delta: Int) {
        val next = (zoomPercent + delta).coerceIn(ZOOM_MIN, ZOOM_MAX)
        if (next == zoomPercent) return
        zoomPercent = next
        applyZoom()
        Toast.makeText(this, getString(R.string.zoom_changed, zoomPercent), Toast.LENGTH_SHORT).show()
        showInfoOverlay()
    }

    /* ---------------- 状态面板 ---------------- */

    private fun showLoading() {
        // 新一轮加载：作废上一轮的探测，并收起兼容性提示
        blankToken++
        binding.compatPanel.visibility = View.GONE
        binding.progressBar.visibility = View.VISIBLE
        binding.progressBar.progress = 0
        // 轮询切换时只显示顶部进度条，不盖全屏加载页，避免切页时闪烁
        if (rotationActive) {
            binding.loadingPanel.visibility = View.GONE
        } else {
            binding.loadingPanel.visibility = View.VISIBLE
        }
        binding.errorPanel.visibility = View.GONE
    }

    private fun showError(message: String) {
        pageError = true
        binding.progressBar.visibility = View.GONE
        binding.loadingPanel.visibility = View.GONE
        binding.errorMessage.text = message
        binding.errorPanel.visibility = View.VISIBLE
        binding.retryButton.requestFocus()
    }

    private fun showInfoOverlay() {
        val info = entry ?: return
        val overlay = binding.infoOverlay
        val token = ++overlayToken

        // 附带真实加载地址、内核版本与实测视口：现场无 adb 也能核对是否已按 1920×1080 布局
        val shown = loadedUrl.ifEmpty { info.url }
        val mode = when {
            viaTurbo -> getString(R.string.turbo_mode_label)
            viaCompatProxy -> "兼容代理"
            else -> "直连"
        }
        val viewport = if (viewportText.isNotEmpty()) "\n$viewportText  ·  目标 $TARGET_CSS_WIDTH×$TARGET_CSS_HEIGHT"
        else ""
        val baseText = "${info.title}\n$shown\n$mode  ·  缩放 ${zoomPercent}%  ·  " +
            "内核 Chrome/${if (chromeMajor > 0) chromeMajor else "未知"}$viewport"
        overlay.text = baseText
        if (viaTurbo) fetchShotFrameAge { age ->
            // 浮层还可见时才补写帧龄
            if (token == overlayToken && age >= 0) {
                overlay.text = baseText + "\n" + getString(R.string.turbo_frame_ago, age)
            }
        }
        overlay.visibility = View.VISIBLE
        overlay.animate().alpha(1f).setDuration(180L).start()

        handler.postDelayed({
            if (token != overlayToken) return@postDelayed
            overlay.animate().alpha(0f).setDuration(320L).withEndAction {
                if (token == overlayToken) overlay.visibility = View.INVISIBLE
            }.start()
        }, OVERLAY_DURATION_MS)
    }

    /**
     * 拉取服务端采集状态（/shot/<id>/meta.json），回调当前帧龄（秒）。
     * 仅用于信息浮层现场核对采集是否存活；失败回调 -1，不影响展示。
     */
    private fun fetchShotFrameAge(onResult: (Int) -> Unit) {
        val e = entry ?: return
        Thread {
            var age = -1
            try {
                val url = ConfigRepository.serverBaseUrl().trimEnd('/') + "/shot/" + e.id + "/meta.json"
                val conn = java.net.URL(url).openConnection() as java.net.HttpURLConnection
                conn.connectTimeout = 3000
                conn.readTimeout = 3000
                conn.inputStream.use { stream ->
                    val text = stream.bufferedReader().readText()
                    val ts = org.json.JSONObject(text).optLong("ts", 0L)
                    if (ts > 0) age = ((System.currentTimeMillis() - ts) / 1000L).toInt().coerceAtLeast(0)
                }
                conn.disconnect()
            } catch (ignored: Exception) {
            }
            handler.post { onResult(age) }
        }.start()
    }

    /* ---------------- 遥控器按键映射 ---------------- */

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
            // 远程被控时锁定展示操作（【返回】豁免——正常退出操作，v6：退出取代取消控制）
            if (ControlChannel.interceptKeyLocked(event.keyCode, this)) return true
            when (event.keyCode) {
                // 返回键：直接回到首页，避免在网页历史中迷失
                KeyEvent.KEYCODE_BACK -> {
                    finish()
                    return true
                }
                // 菜单键：控制菜单（刷新 / 缩放 / 返回首页）
                KeyEvent.KEYCODE_MENU,
                KeyEvent.KEYCODE_INFO,
                KeyEvent.KEYCODE_BUTTON_Y -> {
                    showControlMenu()
                    return true
                }
            }
        }

        // WebView 必须持有焦点才能接收方向键，异常面板展示时焦点交给“重试”按钮
        if (event.action == KeyEvent.ACTION_DOWN &&
            binding.errorPanel.visibility != View.VISIBLE &&
            !webView.hasFocus()
        ) {
            webView.requestFocus()
        }
        return super.dispatchKeyEvent(event)
    }

    /** 翻转极速模式总开关并立即用新地址重载当前页 */
    private fun toggleTurboAndReload() {
        val next = !LocalSettings.turbo(this).enabled
        LocalSettings.saveTurbo(this, TurboSetting(next))
        Toast.makeText(
            this,
            if (next) R.string.turbo_enabled_toast else R.string.turbo_disabled_toast,
            Toast.LENGTH_SHORT
        ).show()
        pageError = false
        autoFitApplied = false
        startLoad()
        showInfoOverlay()
    }

    private fun showControlMenu() {
        val info = entry ?: return
        val labels = ArrayList<String>()
        val actions = ArrayList<() -> Unit>()

        // 轮询播放模式下，再按一次【菜单】即进入轮询设置
        if (rotationActive) {
            labels.add(getString(R.string.menu_rotation_settings))
            actions.add { startActivity(Intent(this, SettingsActivity::class.java)) }
        }

        labels.add(getString(R.string.menu_refresh))
        actions.add { reloadPage() }

        // 极速模式开关：翻转后立即用新地址重载当前页（单页/轮询均生效）
        labels.add(
            getString(
                if (LocalSettings.turbo(this).enabled) R.string.menu_turbo_on
                else R.string.menu_turbo_off
            )
        )
        actions.add { toggleTurboAndReload() }

        if (webView.canGoBack()) {
            labels.add(getString(R.string.menu_back))
            actions.add { webView.goBack() }
        }
        labels.add(getString(R.string.menu_zoom_in))
        actions.add { changeZoom(ZOOM_STEP) }
        labels.add(getString(R.string.menu_zoom_out))
        actions.add { changeZoom(-ZOOM_STEP) }
        labels.add(getString(R.string.menu_zoom_reset))
        actions.add { changeZoom(100 - zoomPercent) }
        labels.add(getString(R.string.menu_home))
        actions.add { finish() }

        labels.add(getString(R.string.menu_cancel))
        actions.add { }

        val subtitle = "${info.title}  ·  ${info.url}  ·  缩放 ${zoomPercent}%"
        controlDialog = TvDialogs.menu(
            context = this,
            title = getString(R.string.menu_title),
            subtitle = subtitle,
            items = labels
        ) { index -> actions.getOrNull(index)?.invoke() }
        controlDialog?.show()
    }

    /* ---------------- 生命周期 ---------------- */

    override fun onResume() {
        super.onResume()
        webView.onResume()
        if (rotationActive) {
            syncRotationSettings()
            scheduleRotation()
        }
        // 多设备互控：回到前台时按当前模式补一次上报（startLoad 已覆盖切页路径）
        if (rotationActive) {
            ControlChannel.reportRotate(
                rotationIndex, rotationEntries.size,
                rotationSetting.intervalSec, rotationSetting.items
            )
        } else {
            entry?.let { ControlChannel.reportPage(it.id) }
        }
    }

    /**
     * 从轮询设置界面返回后重新读取本机设置：
     * 序列/间隔/时钟起点可能已变，按新设置重新对齐当前页（改动过设置时会从第 1 页重新开始）。
     */
    private fun syncRotationSettings() {
        rotationSetting = LocalSettings.rotation(this)
        val latest = LocalSettings.rotationEntries(config, rotationSetting)
        if (latest.isEmpty()) return
        rotationEntries = latest
        rotationIndex = computeRotationIndex().coerceIn(0, latest.lastIndex)
        val target = rotationEntries[rotationIndex]
        if (entry?.id != target.id) {
            entry = target
            startLoad()
            showInfoOverlay()
        }
        binding.rotationChip.visibility = View.VISIBLE
        renderRotationChip()
    }

    override fun onPause() {
        webView.onPause()
        super.onPause()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) {
            UiUtil.applyImmersive(this)
            if (binding.errorPanel.visibility != View.VISIBLE) {
                webView.requestFocus()
            }
        }
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        overlayToken++
        controlDialog?.dismiss()
        webView.apply {
            stopLoading()
            loadUrl("about:blank")
            clearHistory()
            removeAllViews()
            destroy()
        }
        super.onDestroy()
    }
}
