package com.digitalcenter.tvshow.ui

import android.annotation.SuppressLint
import android.content.res.Configuration
import android.graphics.Color
import android.net.http.SslError
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.GridLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.digitalcenter.tvshow.R
import com.digitalcenter.tvshow.config.ConfigLoader
import com.digitalcenter.tvshow.config.DisplayEntry
import com.digitalcenter.tvshow.config.LocalSettings
import com.digitalcenter.tvshow.config.RemoteConfig
import com.digitalcenter.tvshow.config.ZONE_COUNT
import com.digitalcenter.tvshow.config.ZONE_MIN_HEIGHT
import com.digitalcenter.tvshow.config.ZONE_MIN_WIDTH
import com.digitalcenter.tvshow.config.ZoneSetting
import com.digitalcenter.tvshow.config.TurboSetting
import com.digitalcenter.tvshow.config.effectiveUrlOf
import com.digitalcenter.tvshow.net.ConfigRepository
import com.digitalcenter.tvshow.util.UiUtil
import com.digitalcenter.tvshow.util.ViewportFit
import kotlin.math.roundToInt

/**
 * 分区展示：2×2 拼接大屏，四个分区各占屏幕四分之一。
 *
 * 由首页【菜单】→「分区展示（2×2 拼接）」**直接进入**，进入后即可现场配置：
 *  - 方向键：在四格之间移动当前分区，目标格青色描边**闪一下即淡出**（不做常驻边框，
 *    以免长期压住四个真实页面的画面；当前格位另有 Toast 与选择弹层标题提示）
 *  - 确定键：弹出页面列表，为该格选择要显示的页面（可选「不使用」）
 *  - 菜单键：刷新全部页面 / 返回首页
 * 选择结果按本机保存（[LocalSettings]），与其他电视无关，也不占用服务端。
 *
 * 分辨率处理（关键点）：
 * 每个分区都是一个独立 WebView，其 CSS 视口被强制为 1920×1080：
 *  - 先按 `该格物理宽度 / 1920` 重写密度；
 *  - 再用 `setInitialScale` 兜底（密度重写在部分电视固件上不生效），
 *    并在页面加载完成后实测 innerWidth 反向校准密度因子（[ViewportFit]）。
 * 于是每格页面都按 1920×1080 布局后整体缩放到格子里：
 *  - 在 3840×2160 的拼接屏上，每格 1920×1080 物理像素 → 1:1 原生呈现；
 *  - 在 1920×1080 的普通电视上，每格 960×540 → 页面仍按 1920×1080 布局后整体缩放。
 * 这样"每个分区不低于 1920×1080"这一标准在客户端真正落地。
 */
class ZoneDisplayActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "ZoneDisplay"
        private const val NAV_SCRIPT = "js/tv_nav.js"
        private const val LOGIN_SCRIPT = "js/auto_login.js"
        /** 高亮保持时长，之后淡出（毫秒） */
        private const val FLASH_HOLD_MS = 600L
        private const val FLASH_FADE_MS = 320L
        /** 视口不达标时最多重载几次（校准密度因子用） */
        private const val MAX_CALIBRATION_RELOADS = 2
    }

    private var config: RemoteConfig = ConfigLoader.defaultConfig()
    private var zoneSettings: List<ZoneSetting> = emptyList()
    /** 每格对应的入口，下标即格位 0..3；null 表示该格未配置（或页面已被服务端删除） */
    private var cellEntries: List<DisplayEntry?> = emptyList()
    /** 当前选中的格位（方向键移动，确定键为该格选页面） */
    private var activePosition = 0

    private lateinit var root: FrameLayout
    private lateinit var grid: GridLayout
    private lateinit var hint: TextView
    private lateinit var keyHintShower: () -> Unit

    /** 每格：容器 + WebView（未配置内容时为 null）+ 状态文字 + 高亮层 */
    private class ZoneSlot(
        val position: Int,
        val container: FrameLayout,
        val glow: View,
        var webView: WebView? = null,
        val status: TextView,
        /** 该格 WebView 的名义密度，用于反推真实 dpr 做视口校准 */
        var assumedDensity: Float = 1f,
        var initialScalePercent: Int = 100,
        var calibrationReloads: Int = 0
    )

    private val slots = LinkedHashMap<Int, ZoneSlot>()
    private val handler = Handler(Looper.getMainLooper())
    /** 高亮令牌：后一次高亮会让前一次尚未执行的淡出失效，避免刚点亮就被旧的定时器熄灭 */
    private var flashToken = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        UiUtil.applyImmersive(this)

        ConfigRepository.init(this)
        config = ConfigRepository.snapshot()
        zoneSettings = LocalSettings.zones(this)
        cellEntries = LocalSettings.zoneEntries(config, zoneSettings)

        buildLayout()
        renderZones()
        flashZone(activePosition)
        Log.i(
            TAG,
            "分区展示启动：${cellEntries.count { it != null }}/$ZONE_COUNT 格已配置，屏幕 " +
                "${resources.displayMetrics.widthPixels}×${resources.displayMetrics.heightPixels}px"
        )
    }

    /* ---------------- 布局 ---------------- */

    private fun buildLayout() {
        root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }

        grid = GridLayout(this).apply {
            columnCount = 2
            rowCount = 2
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        }
        root.addView(grid)

        // 底部按键提示（半透明，压在网格之上）
        hint = TextView(this).apply {
            setBackgroundColor(Color.parseColor("#CC0C1524"))
            setTextColor(Color.parseColor("#8FA6C4"))
            textSize = 13f
            gravity = Gravity.CENTER
            setPadding(24, 14, 24, 14)
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT
            ).apply { gravity = Gravity.BOTTOM }
        }
        root.addView(hint)
        updateHint()

        setContentView(root)
    }

    /** 底部按键提示：显示 3s 后自动隐藏，按键后重新显示 */
    private fun showKeyHint() {
        if (!::keyHintShower.isInitialized) keyHintShower = UiUtil.bindAutoHideHint(hint)
        keyHintShower()
    }

    private fun updateHint() {
        hint.text =
            if (cellEntries.all { it == null }) getString(R.string.zone_none)
            else getString(R.string.zone_hint)
        showKeyHint()
    }

    private fun renderZones() {
        grid.removeAllViews()
        slots.clear()

        val metrics = resources.displayMetrics
        val cellW = metrics.widthPixels / 2
        val cellH = metrics.heightPixels / 2

        for (position in 0 until ZONE_COUNT) {
            val container = FrameLayout(this).apply {
                // 仅作分区之间 1dp 的分隔线；当前分区不靠它标识（WebView 会把容器背景整个盖住），
                // 高亮由上层的 glow 视图负责
                setBackgroundResource(R.drawable.bg_zone_idle)
            }
            grid.addView(
                container,
                GridLayout.LayoutParams(GridLayout.spec(position / 2), GridLayout.spec(position % 2)).apply {
                    width = cellW
                    height = cellH
                }
            )

            val status = TextView(this).apply {
                setTextColor(Color.parseColor("#5F7796"))
                textSize = 13f
                gravity = Gravity.CENTER
                layoutParams = FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.WRAP_CONTENT,
                    FrameLayout.LayoutParams.WRAP_CONTENT
                ).apply { gravity = Gravity.CENTER }
            }
            val glow = View(this).apply {
                setBackgroundResource(R.drawable.bg_zone_active)
                alpha = 0f
                // 纯展示层：不抢焦点、不拦截按键
                isFocusable = false
                isFocusableInTouchMode = false
                isClickable = false
            }
            slots[position] = ZoneSlot(position, container, glow, null, status)
            renderCell(position)
        }
    }

    /** 渲染单独一格：销毁旧 WebView 后按本机设置重建（选完页面只刷新这一格） */
    private fun renderCell(position: Int) {
        val slot = slots[position] ?: return
        slot.webView?.let { destroyWebView(it) }
        slot.webView = null
        slot.container.removeAllViews()
        slot.glow.animate().cancel()

        val entry = cellEntries.getOrNull(position)
        val cellW = resources.displayMetrics.widthPixels / 2
        val webView = entry?.let { createZoneWebView(slot, it, cellW) }
        if (entry == null || webView == null) {
            slot.status.text = getString(R.string.zone_empty)
            slot.container.addView(slot.status)
        } else {
            slot.webView = webView
            slot.container.addView(
                webView,
                FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT
                )
            )
            loadZone(slot, entry)
        }

        // 高亮层始终压在内容之上，并复位为熄灭（需要时由 flashZone 点亮）
        slot.container.addView(
            slot.glow,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        )
        slot.glow.alpha = 0f
    }

    /**
     * 为单个分区创建 WebView：把该格的 CSS 视口强制为 1920×1080。
     *
     * 先按 `该格物理宽 / 1920` 重写密度，再用 `setInitialScale` 兜底：
     * 密度重写在部分电视固件上不生效，此时靠 initialScale 把布局宽度拉回 1920
     * （用本机持久化的密度因子推算，见 [ViewportFit]）。
     * @param cellWidthPx 该格在屏幕上的物理宽度
     */
    private fun createZoneWebView(slot: ZoneSlot, entry: DisplayEntry, cellWidthPx: Int): WebView? {
        if (cellWidthPx <= 0) return null
        val densityDpi = (160f * cellWidthPx / ZONE_MIN_WIDTH)
            .roundToInt()
            .coerceIn(40, 1000)

        val zoneConfig = Configuration(resources.configuration)
        zoneConfig.densityDpi = densityDpi
        val zoneContext = createConfigurationContext(zoneConfig)
        slot.assumedDensity = zoneContext.resources.displayMetrics.density
        slot.calibrationReloads = 0
        slot.initialScalePercent = ViewportFit.scalePercent(
            this,
            cellWidthPx,
            slot.assumedDensity,
            ZONE_MIN_WIDTH
        )

        val webView = WebView(zoneContext)
        webView.setBackgroundColor(Color.BLACK)
        // 遥控器按键全部由本 Activity 处理（方向键选格 / 确定选页面），WebView 不抢焦点
        webView.isFocusable = false
        webView.isFocusableInTouchMode = false
        // 四个 WebView 同时运行，禁用不必要的缓存与缩放以降低开销
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            // 与展示页一致：忽略页面 viewport meta，布局宽度由 setInitialScale 决定
            useWideViewPort = false
            loadWithOverviewMode = false
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            cacheMode = WebSettings.LOAD_DEFAULT
            allowFileAccess = false
            allowContentAccess = false
            userAgentString = "$userAgentString TvShowCenter-Zone/1.0"
        }
        webView.setInitialScale(slot.initialScalePercent)
        webView.webChromeClient = object : WebChromeClient() {}

        val cssHeight = resources.displayMetrics.heightPixels / 2 * 160 / densityDpi
        Log.i(
            TAG,
            "分区 ${entry.id}：目标 ${ZONE_MIN_WIDTH}×$ZONE_MIN_HEIGHT，格宽 ${cellWidthPx}px " +
                "→ densityDpi=$densityDpi（CSS 视口 ${ZONE_MIN_WIDTH}×${cssHeight}…），" +
                "initialScale=${slot.initialScalePercent}%"
        )
        return webView
    }

    private fun loadZone(slot: ZoneSlot, entry: DisplayEntry) {
        val webView = slot.webView ?: return

        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                injectZoneScripts(view, entry)
                calibrateZoneViewport(slot, entry)
                // 旧内核 100vh 失效会让分区页面只渲染在上半格，首屏后再补两次
                handler.postDelayed({ fillZone(view) }, 1500L)
                handler.postDelayed({ fillZone(view) }, 3500L)
            }

            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?
            ) {
                if (request?.isForMainFrame == true) {
                    Log.w(TAG, "分区 ${entry.id} 加载失败：${error?.description}")
                    slot.status.text = getString(R.string.error_network)
                    if (slot.status.parent == null) slot.container.addView(slot.status)
                }
            }

            override fun onReceivedSslError(
                view: WebView?,
                handler: SslErrorHandler?,
                error: SslError?
            ) {
                if (entry.allowInsecureSsl) {
                    Log.w(TAG, "分区 ${entry.id} 忽略证书错误：${error?.url}")
                    handler?.proceed()
                } else {
                    Log.e(TAG, "分区 ${entry.id} 证书校验失败：${error?.url}")
                    handler?.cancel()
                }
            }
        }
        // 极速模式判定与地址切换（单口走 effectiveUrlOf，与展示页同一判定）
        val turbo = LocalSettings.turbo(this).enabled
        // 兼容转译入口经服务端代理加载（服务端已注入自动登录，见 injectZoneScripts）；
        // 极速模式则加载服务端截图包装页（登录由服务端无头浏览器完成）
        webView.loadUrl(effectiveUrlOf(entry, ConfigRepository.serverBaseUrl(), turbo))
    }

    /**
     * 分区视口自校准：实测该格 CSS 视口宽度，偏离 1920 时校准密度因子并重载一次。
     * 密度因子与页面无关、全机共用，通常第一次打开展示页时就已经收敛。
     */
    private fun calibrateZoneViewport(slot: ZoneSlot, entry: DisplayEntry) {
        val webView = slot.webView ?: return
        val cellWidthPx = resources.displayMetrics.widthPixels / 2
        webView.evaluateJavascript(ViewportFit.PROBE_SCRIPT) { result ->
            val info = ViewportFit.parseProbe(result) ?: return@evaluateJavascript
            Log.i(TAG, "分区 ${entry.id} 视口实测：${info.readable}（目标 ${ZONE_MIN_WIDTH}）")
            if (ViewportFit.matched(info, ZONE_MIN_WIDTH)) return@evaluateJavascript
            if (slot.calibrationReloads >= MAX_CALIBRATION_RELOADS) return@evaluateJavascript
            val changed = ViewportFit.calibrate(
                this,
                cellWidthPx,
                slot.assumedDensity,
                info,
                slot.initialScalePercent
            )
            if (!changed) return@evaluateJavascript
            slot.calibrationReloads++
            slot.initialScalePercent = ViewportFit.scalePercent(
                this,
                cellWidthPx,
                slot.assumedDensity,
                ZONE_MIN_WIDTH
            )
            webView.setInitialScale(slot.initialScalePercent)
            webView.reload()
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun injectZoneScripts(webView: WebView?, entry: DisplayEntry) {
        if (webView == null) return
        readAsset(NAV_SCRIPT)?.let { webView.evaluateJavascript(it, null) }
        val login = entry.autoLogin
        // 极速模式包装页无需自动登录（服务端无头浏览器已完成登录）
        if (!entry.compatTranspile && !LocalSettings.turbo(this).enabled &&
            login != null && login.enabled && login.password.isNotEmpty()
        ) {
            readAsset(LOGIN_SCRIPT)?.let { script ->
                webView.evaluateJavascript(
                    "window.__TV_AUTOLOGIN_DONE__=false;" +
                        "window.__TV_AUTOLOGIN__=${WebDisplayActivity.autoLoginJson(login)};\n$script",
                    null
                )
            }
        }
        // 旧内核 100vh 解析错误 → 分区页面只占上半格，注入修补脚本
        fillZone(webView)
    }

    /** 注入 [ViewportFit.FILL_SCRIPT]，把因 100vh 失效而塌陷的分区页面重新撑满 */
    private fun fillZone(webView: WebView?) {
        webView?.evaluateJavascript(ViewportFit.FILL_SCRIPT) { result ->
            Log.d(TAG, "分区 100vh 修补（改写元素数）：$result")
        }
    }

    private fun readAsset(path: String): String? = runCatching {
        assets.open(path).bufferedReader().use { it.readText() }
    }.onFailure { Log.w(TAG, "读取资源失败：$path", it) }.getOrNull()

    private fun destroyWebView(webView: WebView) {
        webView.stopLoading()
        webView.loadUrl("about:blank")
        webView.clearHistory()
        webView.removeAllViews()
        webView.destroy()
    }

    /* ---------------- 当前分区：移动与选择页面 ---------------- */

    /**
     * 高亮某一格：立即点亮，[FLASH_HOLD_MS] 之后淡出，不做常驻边框
     * （四个分区都在展示真实页面，长期压一圈亮色边框会干扰观看）。
     * @param position 目标格位，传负数表示熄灭全部
     */
    private fun flashZone(position: Int, holdMs: Long = FLASH_HOLD_MS) {
        flashToken++
        val token = flashToken
        slots.forEach { (pos, slot) ->
            slot.glow.animate().cancel()
            if (pos == position) slot.glow.alpha = 1f else fadeGlow(slot.glow)
        }
        if (position < 0 || holdMs <= 0) return
        // 若期间又按了方向键，旧定时器作废，避免新点亮的高亮被提前熄灭
        handler.postDelayed({ if (token == flashToken) fadeGlow(position) }, holdMs)
    }

    private fun fadeGlow(position: Int) {
        slots[position]?.let { fadeGlow(it.glow) }
    }

    private fun fadeGlow(glow: View) {
        if (glow.alpha == 0f) return
        glow.animate().alpha(0f).setDuration(FLASH_FADE_MS).start()
    }

    /** 方向键在 2×2 网格里移动当前分区（到边界不循环，避免"跳格"误解） */
    private fun moveActive(rowDelta: Int, colDelta: Int) {
        val row = (activePosition / 2 + rowDelta).coerceIn(0, 1)
        val col = (activePosition % 2 + colDelta).coerceIn(0, 1)
        val next = row * 2 + col
        if (next == activePosition) return
        activePosition = next
        flashZone(next)
        Toast.makeText(this, getString(R.string.zone_switched, cellLabel(next)), Toast.LENGTH_SHORT).show()
    }

    /** 为当前格选择页面：列出服务端全部页面 + 「不使用」 */
    private fun pickZoneEntry(position: Int) {
        // 弹层标题虽有格位编号，仍先闪一下操作对象，避免"改错格"
        flashZone(position)
        val labels = config.entries.map { it.title } + getString(R.string.zone_cell_unset)
        TvDialogs.menu(
            context = this,
            title = getString(R.string.zone_pick_title, position + 1),
            subtitle = getString(R.string.zone_settings_subtitle, ZONE_MIN_WIDTH, ZONE_MIN_HEIGHT),
            items = labels
        ) { index ->
            val entryId = config.entries.getOrNull(index)?.id ?: ""
            zoneSettings = LocalSettings.zones(this).map { zone ->
                if (zone.position == position) ZoneSetting(position, entryId) else zone
            }
            LocalSettings.saveZones(this, zoneSettings)
            cellEntries = LocalSettings.zoneEntries(config, zoneSettings)
            renderCell(position)
            flashZone(position)
            updateHint()
            Toast.makeText(
                this,
                getString(R.string.zone_selected, position + 1, cellLabel(position)),
                Toast.LENGTH_SHORT
            ).show()
        }.show()
    }

    /** 当前分区的称呼：优先用页面标题，取不到（未配置）则用格位 */
    private fun cellLabel(position: Int): String =
        cellEntries.getOrNull(position)?.title?.takeIf { it.isNotBlank() }
            ?: getString(R.string.zone_cell, position + 1)

    private fun showControlMenu() {
        val labels = ArrayList<String>()
        val actions = ArrayList<() -> Unit>()

        labels.add(getString(R.string.menu_zone_refresh))
        actions.add { reloadAll() }

        // 极速模式开关：翻转后 4 格全部按新地址重载
        labels.add(
            getString(
                if (LocalSettings.turbo(this).enabled) R.string.menu_turbo_on
                else R.string.menu_turbo_off
            )
        )
        actions.add { toggleTurboAndReloadZones() }

        labels.add(getString(R.string.menu_home))
        actions.add { finish() }

        TvDialogs.menu(
            context = this,
            title = getString(R.string.zone_title),
            subtitle = getString(R.string.zone_settings_subtitle, ZONE_MIN_WIDTH, ZONE_MIN_HEIGHT),
            items = labels
        ) { index -> actions.getOrNull(index)?.invoke() }.show()
    }

    /** 翻转极速模式总开关，4 格全部重载 */
    private fun toggleTurboAndReloadZones() {
        val next = !LocalSettings.turbo(this).enabled
        LocalSettings.saveTurbo(this, TurboSetting(next))
        Toast.makeText(
            this,
            if (next) R.string.turbo_enabled_toast else R.string.turbo_disabled_toast,
            Toast.LENGTH_SHORT
        ).show()
        slots.values.forEach { slot ->
            cellEntries.getOrNull(slot.position)?.let { entry -> loadZone(slot, entry) }
        }
    }

    private fun reloadAll() {
        slots.values.forEach { it.webView?.reload() }
        Toast.makeText(this, R.string.menu_refresh, Toast.LENGTH_SHORT).show()
    }

    /* ---------------- 遥控器 ---------------- */

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
            showKeyHint()
            when (event.keyCode) {
                KeyEvent.KEYCODE_BACK -> {
                    finish()
                    return true
                }
                KeyEvent.KEYCODE_MENU, KeyEvent.KEYCODE_INFO, KeyEvent.KEYCODE_BUTTON_Y -> {
                    showControlMenu()
                    return true
                }
                KeyEvent.KEYCODE_DPAD_UP -> {
                    moveActive(-1, 0)
                    return true
                }
                KeyEvent.KEYCODE_DPAD_DOWN -> {
                    moveActive(1, 0)
                    return true
                }
                KeyEvent.KEYCODE_DPAD_LEFT -> {
                    moveActive(0, -1)
                    return true
                }
                KeyEvent.KEYCODE_DPAD_RIGHT -> {
                    moveActive(0, 1)
                    return true
                }
                KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> {
                    pickZoneEntry(activePosition)
                    return true
                }
            }
        }
        return super.dispatchKeyEvent(event)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) UiUtil.applyImmersive(this)
    }

    override fun onResume() {
        super.onResume()
        slots.values.forEach { it.webView?.onResume() }
    }

    override fun onPause() {
        slots.values.forEach { it.webView?.onPause() }
        super.onPause()
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        slots.values.forEach { slot ->
            slot.webView?.let { destroyWebView(it) }
            slot.webView = null
        }
        slots.clear()
        super.onDestroy()
    }
}
