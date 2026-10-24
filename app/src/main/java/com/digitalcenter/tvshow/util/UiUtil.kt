package com.digitalcenter.tvshow.util

import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.animation.DecelerateInterpolator
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import kotlin.math.roundToInt

object UiUtil {

    /** 底部提示浮层的自动隐藏时长 */
    private const val HINT_HIDE_MS = 3000L

    /** 全屏沉浸式显示：隐藏状态栏与导航栏，适合电视大屏常驻展示 */
    fun applyImmersive(activity: Activity) {
        WindowCompat.setDecorFitsSystemWindows(activity.window, false)
        val controller = WindowInsetsControllerCompat(activity.window, activity.window.decorView)
        controller.hide(WindowInsetsCompat.Type.systemBars())
        controller.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    }

    fun dp(context: Context, value: Float): Int =
        (value * context.resources.displayMetrics.density).roundToInt()

    /** 解析 #RRGGBB / #AARRGGBB 颜色，失败时返回兜底色 */
    fun parseColor(hex: String?, fallback: Int = Color.parseColor("#2FD2F5")): Int {
        if (hex.isNullOrBlank()) return fallback
        return runCatching { Color.parseColor(hex.trim()) }.getOrDefault(fallback)
    }

    /** 为焦点元素附加缩放 + 阴影动画，提供清晰的大屏焦点反馈 */
    fun attachFocusAnimation(view: View, focusedScale: Float = 1.05f) {
        view.onFocusChangeListener = View.OnFocusChangeListener { v, hasFocus ->
            val scale = if (hasFocus) focusedScale else 1f
            v.animate()
                .scaleX(scale)
                .scaleY(scale)
                .setDuration(180L)
                .setInterpolator(DecelerateInterpolator())
                .start()
            v.elevation = if (hasFocus) dp(v.context, 16f).toFloat() else 0f
        }
    }

    /**
     * 绑定「3 秒自动隐藏」的提示浮层（按键提示等）。
     * 返回 show()：显示浮层并重置 3s 计时；用户每次按键后调用，静止 3s 后自动隐藏。
     */
    fun bindAutoHideHint(view: View): () -> Unit {
        val handler = Handler(Looper.getMainLooper())
        var hideTask: Runnable? = null
        return {
            view.visibility = View.VISIBLE
            hideTask?.let(handler::removeCallbacks)
            hideTask = Runnable { view.visibility = View.INVISIBLE }
                .also { handler.postDelayed(it, HINT_HIDE_MS) }
        }
    }
}
