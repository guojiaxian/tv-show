package com.digitalcenter.tvshow.ui

import android.annotation.SuppressLint
import android.app.Dialog
import android.graphics.Color
import android.net.http.SslError
import android.os.Bundle
import android.util.Log
import android.view.KeyEvent
import android.view.WindowManager
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.digitalcenter.tvshow.R
import com.digitalcenter.tvshow.config.CommandApplier
import com.digitalcenter.tvshow.net.ConfigRepository
import com.digitalcenter.tvshow.net.ControlChannel
import com.digitalcenter.tvshow.util.UiUtil

/**
 * 素材上墙展示页（多设备互控 · media 指令的落点）。
 *
 * 由 [CommandApplier] 在收到 `media` 指令（素材上墙）时启动：加载服务端的素材播放页
 * `GET /media/<id>/view`——图片全屏、PDF/PPT/文档按服务端栅格化的分页图片定时翻页播放、
 * MP4 `<video>` 循环播放。播放页为 ES5（Chrome 66 可执行），电视端与电脑端加载同一地址。
 *
 * 遥控器：【返回】回首页；【菜单】控制菜单（刷新页面 / 返回首页）；受控时按键锁定照常生效
 * （【返回】放行，现场可正常退出摆脱素材画面）。
 */
class MediaDisplayActivity : AppCompatActivity(), CommandApplier.Reloadable {

    companion object {
        const val EXTRA_MEDIA_ID = "extra_media_id"
        const val EXTRA_INTERVAL_SEC = "extra_interval_sec"
        private const val TAG = "MediaDisplay"
    }

    private lateinit var webView: WebView
    private var mediaId: String = ""

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        UiUtil.applyImmersive(this)

        ConfigRepository.init(this)
        ControlChannel.init(this)

        mediaId = intent.getStringExtra(EXTRA_MEDIA_ID).orEmpty()
        if (mediaId.isEmpty()) {
            Toast.makeText(this, R.string.entry_unavailable, Toast.LENGTH_LONG).show()
            finish()
            return
        }
        val intervalSec = intent.getIntExtra(EXTRA_INTERVAL_SEC, 10).coerceIn(3, 3600)
        val base = ConfigRepository.serverBaseUrl().trimEnd('/')
        val url = "$base/media/$mediaId/view?interval=$intervalSec"

        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        setContentView(root)

        val created = WebViewFactory.create(
            context = this,
            hostWidthPx = resources.displayMetrics.widthPixels,
            targetCssWidth = WebViewFactory.TARGET_CSS_WIDTH,
            uaVersionSuffix = "TvShowCenter-Media/1.0"
        )
        webView = created.webView
        webView.isFocusable = true
        webView.isFocusableInTouchMode = true
        WebViewFactory.applyInitialScale(
            this, webView, resources.displayMetrics.widthPixels, created.density,
            WebViewFactory.TARGET_CSS_WIDTH
        )
        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url2: String?) {
                view?.requestFocus()
            }

            override fun onReceivedSslError(view: WebView?, handler: SslErrorHandler?, error: SslError?) {
                // 素材来自本服务端（serverBaseUrl），不做外链 https；证书异常直接拒绝并留日志
                Log.w(TAG, "素材播放页证书校验失败：${error?.url}")
                handler?.cancel()
            }
        }
        webView.webChromeClient = object : WebChromeClient() {}

        root.addView(
            webView,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        )
        Log.i(TAG, "素材上墙：$url")
        webView.loadUrl(url)
    }

    /** 维护类指令 refresh 的落点 */
    override fun reloadCurrent() {
        webView.reload()
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
        // 多设备互控：上报素材状态（mode=media + mediaId，控制台摘要显示「素材：xxx」）
        ControlChannel.reportMedia(mediaId)
    }

    override fun onPause() {
        webView.onPause()
        super.onPause()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) UiUtil.applyImmersive(this)
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
            // 远程被控时锁定展示操作（【返回】豁免——正常退出操作，v6：退出取代取消控制）。
            // 手动翻页属于展示操作：受控时同样被锁定（防误按），交还本地后即可用。
            if (ControlChannel.interceptKeyLocked(event.keyCode, this, getString(R.string.ctl_locked_display))) return true
            when (event.keyCode) {
                KeyEvent.KEYCODE_BACK -> {
                    finish()
                    return true
                }
                KeyEvent.KEYCODE_MENU,
                KeyEvent.KEYCODE_INFO,
                KeyEvent.KEYCODE_BUTTON_Y -> {
                    showControlMenu()
                    return true
                }
                // 手动播放：← 上一页 → 下一页 确定 暂停/继续自动翻页
                // （转发给播放页 __tvMediaNav 钩子；暂停状态由屏上「已暂停」指示反馈）
                KeyEvent.KEYCODE_DPAD_LEFT -> {
                    mediaNav("prev")
                    return true
                }
                KeyEvent.KEYCODE_DPAD_RIGHT -> {
                    mediaNav("next")
                    return true
                }
                KeyEvent.KEYCODE_DPAD_CENTER,
                KeyEvent.KEYCODE_ENTER,
                KeyEvent.KEYCODE_NUMPAD_ENTER -> {
                    mediaNav("toggle")
                    return true
                }
            }
        }
        if (event.action == KeyEvent.ACTION_DOWN && !webView.hasFocus()) {
            webView.requestFocus()
        }
        return super.dispatchKeyEvent(event)
    }

    /** 调用播放页的手动播放钩子（prev / next / toggle），页面自身负责翻页与暂停指示 */
    private fun mediaNav(action: String) {
        webView.evaluateJavascript("window.__tvMediaNav && window.__tvMediaNav('$action')", null)
    }

    private fun showControlMenu() {
        val labels = ArrayList<String>()
        val actions = ArrayList<() -> Unit>()
        labels.add(getString(R.string.menu_refresh))
        actions.add { reloadCurrent() }
        labels.add(getString(R.string.menu_home))
        actions.add { finish() }
        labels.add(getString(R.string.menu_cancel))
        actions.add { }

        menuDialog = TvDialogs.menu(
            context = this,
            title = getString(R.string.menu_title),
            subtitle = getString(R.string.media_menu_subtitle),
            items = labels
        ) { index -> actions.getOrNull(index)?.invoke() }
        menuDialog?.show()
    }

    private var menuDialog: Dialog? = null

    override fun onDestroy() {
        menuDialog?.dismiss()
        WebViewFactory.destroy(webView)
        super.onDestroy()
    }
}
