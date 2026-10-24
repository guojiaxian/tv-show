package com.digitalcenter.tvshow.net

import android.annotation.SuppressLint
import android.app.Activity
import android.app.Application
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.widget.FrameLayout
import android.widget.TextView
import android.widget.Toast
import com.digitalcenter.tvshow.config.CommandApplier
import com.digitalcenter.tvshow.config.LocalSettings
import com.digitalcenter.tvshow.config.RotationSetting
import com.digitalcenter.tvshow.config.ZoneSetting
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.SecureRandom
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 多设备互控 · 受控通道（电视端唯一上行通道）。
 *
 * 设计 docs/远程控制台-设计方案.md §7/§8/§10.2：
 *  - 3 秒心跳（失败指数退避最长 30 秒）：注册 / 上报本机状态 / 领指令 / 同步模式；
 *  - 模式 = 服务端权威 managed + 本机即时影子 [localMode]：遥控器【菜单】拨开关立即生效，
 *    意图 [switchIntent] 随下一拍心跳捎带，未确认前每拍重发（幂等，离线暂存恢复后送达）；
 *  - 展示类指令（show/rotate/zone/home）应用后自动进入远程被控：切画面 + 锁定遥控操作 + 角标；
 *    维护类（refresh/sync）不改变模式；
 *  - 退出远程被控一律二次确认（默认焦点「继续受控」，防误触）；进入无需确认。
 *
 * 线程模型：心跳在单线程后台执行；指令应用 / 模式翻转 / 角标更新全部 post 到主线程。
 */
object ControlChannel {

    private const val TAG = "ControlChannel"
    private const val PREF = "tvshow_device"
    private const val KEY_DEVICE_ID = "deviceId"

    private const val BEAT_INTERVAL_MS = 3000L
    private const val BEAT_MAX_BACKOFF_MS = 30_000L
    private const val BEAT_TIMEOUT_MS = 5000

    /** 心跳与档案的状态枚举（与服务端约定） */
    private const val DISPLAY_CMDS = "show,rotate,zone,home"

    /* ---------------- 状态（跨线程读，主线程写为主，这里用 @Volatile 保护心跳线程读） ---------------- */

    /** 即时影子：true = 本地控制（默认，行为与现状一致）；false = 远程被控 */
    @Volatile
    var localMode: Boolean = true
        private set

    /** 是否处于远程被控（展示操作锁定中） */
    val locked: Boolean get() = !localMode

    /** 已确认应用的指令序号（内存态，重启后由服务端 boot 重发机制兜底） */
    @Volatile
    private var ackedSeq = 0L

    /** 待送达的模式开关意图："local" | "remote" | null（确认送达后清除） */
    @Volatile
    private var switchIntent: String? = null

    /** 本进程启动后的第一次心跳 */
    @Volatile
    private var boot = true

    @Volatile
    private var deviceId: String? = null

    /** 指令应用失败的最近一次原因（随状态上报，控制屏可见） */
    @Volatile
    var lastError: String? = null

    /** 当前上报状态（JSON：{mode, entryId?, rotate?, zone?}），各 Activity 在状态变化时写入 */
    @Volatile
    var reported: JSONObject = JSONObject().put("mode", "home")
        set(value) {
            field = value
        }

    /** 栈顶 Activity（lifecycleCallbacks 自动跟踪，指令应用与角标更新的落点） */
    @Volatile
    private var currentActivity: Activity? = null

    private val mainHandler = Handler(Looper.getMainLooper())
    private val executor: ExecutorService = Executors.newSingleThreadExecutor { r ->
        Thread(r, "ctl-beat").apply { isDaemon = true }
    }
    private val started = AtomicBoolean(false)
    private var lastLockToastAt = 0L

    /* ---------------- 初始化 ---------------- */

    /** 幂等初始化；在首个 Activity 的 onCreate 调用（建议 [com.digitalcenter.tvshow.ui.MainActivity]） */
    @Synchronized
    fun init(context: Context) {
        if (started.getAndSet(true)) return
        val app = context.applicationContext as Application

        val prefs = app.getSharedPreferences(PREF, Context.MODE_PRIVATE)
        deviceId = prefs.getString(KEY_DEVICE_ID, null) ?: run {
            // 设备身份本地生成、终身不变（与 IP 无关）：dev- + 8 位十六进制
            val bytes = ByteArray(4)
            SecureRandom().nextBytes(bytes)
            val id = "dev-" + bytes.joinToString("") { "%02x".format(it) }
            prefs.edit().putString(KEY_DEVICE_ID, id).apply()
            id
        }

        // 自动跟踪栈顶 Activity：指令应用（CLEAR_TOP 切换）与角标更新都需要它
        app.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
            override fun onActivityResumed(activity: Activity) {
                currentActivity = activity
                refreshBadge(activity)
            }

            override fun onActivityPaused(activity: Activity) {
                if (currentActivity === activity) currentActivity = null
            }

            override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
            override fun onActivityStarted(activity: Activity) {}
            override fun onActivityStopped(activity: Activity) {}
            override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
            override fun onActivityDestroyed(activity: Activity) {}
        })

        executor.execute { beatLoop() }
        Log.i(TAG, "受控通道已启动：deviceId=$deviceId")
    }

    fun deviceId(): String? = deviceId

    /* ---------------- 状态上报（各 Activity 调用） ---------------- */

    fun reportHome() {
        reported = JSONObject().put("mode", "home")
    }

    fun reportPage(entryId: String) {
        reported = JSONObject().put("mode", "page").put("entryId", entryId)
    }

    fun reportCamera(entryId: String) {
        reported = JSONObject().put("mode", "camera").put("entryId", entryId)
    }

    fun reportRotate(index: Int, total: Int, intervalSec: Int, items: List<String>) {
        reported = JSONObject()
            .put("mode", "rotate")
            .put("rotate", JSONObject()
                .put("index", index)
                .put("total", total)
                .put("intervalSec", intervalSec)
                .put("items", JSONArray(items)))
    }

    fun reportZone(slots: List<String>) {
        reported = JSONObject()
            .put("mode", "zone")
            .put("zone", JSONObject().put("slots", JSONArray(slots.map { it.ifEmpty { null } })))
    }

    fun reportSettings() {
        reported = JSONObject().put("mode", "settings")
    }

    /* ---------------- 模式开关（遥控器【菜单】入口调用；主线程） ---------------- */

    /**
     * 现场交还本地：立即解锁、画面保持；意图随下一拍心跳送达服务端。
     * 二次确认由调用方（菜单项）用 TvDialogs.confirm 完成。
     */
    fun switchToLocal(context: Context) {
        applyMode(remote = false, silent = false, context = context)
        switchIntent = "local"
    }

    /** 现场主动进入远程被控（本地态下菜单里选择「远程被控」）：直接生效，无需确认 */
    fun switchToRemote(context: Context) {
        applyMode(remote = true, silent = false, context = context)
        switchIntent = "remote"
    }

    /** 模式影子翻转 + 角标 + 提示；立即生效，不等网络（服务端失联时照常工作） */
    private fun applyMode(remote: Boolean, silent: Boolean, context: Context? = null) {
        if (localMode == !remote) return
        localMode = !remote
        val activity = context ?: currentActivity
        activity?.let { mainHandler.post { refreshBadge(it) } }
        if (!silent) {
            val ctx = context ?: return
            mainHandler.post {
                Toast.makeText(
                    ctx,
                    if (remote) "已进入远程被控" else "已交还本地控制",
                    Toast.LENGTH_SHORT
                ).show()
            }
        }
    }

    /* ---------------- 远程被控锁定（各 Activity 按键分发处调用） ---------------- */

    /**
     * 受控锁定检查：远程被控时拦截除【菜单】外的全部按键（【菜单】是唯一的本地出口，
     * 菜单首项即控制模式开关）。返回 true 表示事件已被锁定吞掉。
     */
    fun interceptKeyLocked(keyCode: Int, context: Context): Boolean {
        if (localMode) return false
        // 菜单键豁免：受控态下仍可打开菜单切换回本地
        if (keyCode == android.view.KeyEvent.KEYCODE_MENU ||
            keyCode == android.view.KeyEvent.KEYCODE_INFO ||
            keyCode == android.view.KeyEvent.KEYCODE_BUTTON_Y
        ) return false
        val now = System.currentTimeMillis()
        if (now - lastLockToastAt > 5000L) {
            lastLockToastAt = now
            Toast.makeText(context, "远程被控中 · 按【菜单】可切回本地控制", Toast.LENGTH_SHORT).show()
        }
        return true
    }

    /* ---------------- 受控角标 ---------------- */

    private const val BADGE_TAG = "tvshow_ctl_badge"

    /** 在栈顶 Activity 的 decorView 上叠加 / 移除「远程被控」半透明角标（主线程） */
    @SuppressLint("InflateParams")
    fun refreshBadge(activity: Activity) {
        val decor = activity.window.decorView as? FrameLayout ?: return
        val existing = decor.findViewWithTag<TextView>(BADGE_TAG)
        if (localMode) {
            existing?.let { (it.parent as? FrameLayout)?.removeView(it) }
            return
        }
        if (existing != null) return
        val badge = TextView(activity).apply {
            tag = BADGE_TAG
            text = "远程被控"
            textSize = 12f
            setTextColor(Color.parseColor("#9FE7FF"))
            background = GradientDrawable().apply {
                cornerRadius = 40f
                setColor(Color.parseColor("#AA0A1020"))
                setStroke(2, Color.parseColor("#73D2F5"))
            }
            val pad = com.digitalcenter.tvshow.util.UiUtil.dp(context, 12f)
            setPadding(pad, pad / 3, pad, pad / 3)
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM or Gravity.END
            ).apply {
                marginEnd = com.digitalcenter.tvshow.util.UiUtil.dp(context, 18f)
                bottomMargin = com.digitalcenter.tvshow.util.UiUtil.dp(context, 18f)
            }
        }
        // decorView 不抢焦点，也不挡触摸（TextView 默认不消费触摸事件，仅作被动指示）
        badge.isFocusable = false
        decor.addView(badge)
    }

    /* ---------------- 心跳循环 ---------------- */

    private fun beatLoop() {
        var failStreak = 0
        while (true) {
            val delay = try {
                beatOnce()
                failStreak = 0
                BEAT_INTERVAL_MS
            } catch (e: InterruptedException) {
                throw e
            } catch (e: Exception) {
                failStreak++
                Log.d(TAG, "心跳失败（第 $failStreak 次）：${e.message}")
                (BEAT_INTERVAL_MS shl failStreak.coerceAtMost(4)).coerceAtMost(BEAT_MAX_BACKOFF_MS)
            }
            try {
                Thread.sleep(delay)
            } catch (e: InterruptedException) {
                return
            }
        }
    }

    private fun beatOnce() {
        val id = deviceId ?: return
        val base = com.digitalcenter.tvshow.net.ConfigRepository.serverBaseUrl().trimEnd('/')
        if (base.isBlank() || !base.startsWith("http")) return

        val body = JSONObject().apply {
            put("deviceId", id)
            put("kind", "tv")
            put("appVersion", "1.8")
            put("boot", boot)
            put("ackedSeq", ackedSeq)
            put("state", JSONObject(reported.toString()).putOpt("lastError", lastError ?: JSONObject.NULL))
        }
        boot = false
        switchIntent?.let { body.put("switchTo", it) }

        val conn = (URL("$base/api/ctl/beat").openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = BEAT_TIMEOUT_MS
            readTimeout = BEAT_TIMEOUT_MS
            doOutput = true
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
            setRequestProperty("Accept", "application/json")
        }
        try {
            conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            if (code != 200) throw IllegalStateException("HTTP $code")
            val text = conn.inputStream.use { it.readBytes().toString(Charsets.UTF_8) }
            handleResponse(JSONObject(text))
        } finally {
            conn.disconnect()
        }
    }

    private fun handleResponse(json: JSONObject) {
        val managed = json.optBoolean("managed", true)

        // 1) 意图确认：服务端状态与意图一致 → 清除（未清除前每拍重发）
        val intent = switchIntent
        if (intent != null && managed == (intent == "remote")) {
            switchIntent = null
        }

        // 2) 指令应用（展示类自动进入远程被控）
        val desired = json.optJSONObject("desired")
        if (desired != null) {
            val seq = desired.optLong("seq", 0L)
            val cmd = desired.optString("cmd")
            val args = desired.optJSONObject("args") ?: JSONObject()
            mainHandler.post {
                val activity = currentActivity
                if (activity == null) {
                    Log.w(TAG, "指令到达但无前台 Activity，丢弃：$cmd")
                } else {
                    CommandApplier.apply(activity, cmd, args)
                }
            }
            ackedSeq = seq
            return
        }

        // 3) 纯模式校正（无在途意图时）：控制端「取消控制」→ 解锁；服务端记忆 → 接管
        if (switchIntent == null) {
            if (!managed && !localMode) {
                val activity = currentActivity
                applyMode(remote = false, silent = false, context = activity)
                activity?.let {
                    mainHandler.post {
                        Toast.makeText(it, "控制端已交还本地控制", Toast.LENGTH_SHORT).show()
                    }
                }
            } else if (managed && localMode) {
                val activity = currentActivity
                applyMode(remote = true, silent = true, context = activity)
            }
        }
    }

    /** 展示类指令判定（供 CommandApplier 复用） */
    fun isDisplayCommand(cmd: String): Boolean = DISPLAY_CMDS.split(',').contains(cmd)

    /** 供 CommandApplier 在应用展示类指令后置受控态（本地无 Toast：切画面本身就是信号） */
    fun onDisplayCommandApplied() {
        val activity = currentActivity
        applyMode(remote = true, silent = true, context = activity)
    }
}
