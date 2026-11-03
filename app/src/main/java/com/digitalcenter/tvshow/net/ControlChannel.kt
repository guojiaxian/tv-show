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
import com.digitalcenter.tvshow.BuildConfig
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
 * 设计 docs/远程控制台-设计方案.md §7/§8/§10.2（v6 修订：受控端无任何取消入口）：
 *  - 3 秒心跳（失败指数退避最长 30 秒）：注册 / 上报本机状态 / 领指令 / 同步模式；
 *  - 模式 = 服务端权威 managed + 本机影子 [localMode]：状态翻转（取消控制）只在控制台；
 *    现场摆脱受控画面 = 正常退出操作（【返回】键已放行）；
 *  - 展示类指令（show/rotate/zone/home）应用后自动进入远程被控：切画面 + 锁定遥控操作 + 角标；
 *    维护类（refresh/sync）不改变模式；
 *  - 控制端 release → 心跳响应 managed=false → 解锁（画面保持）。
 *
 * 线程模型：心跳在单线程后台执行；指令应用 / 模式翻转 / 角标更新全部 post 到主线程。
 */
object ControlChannel {

    private const val TAG = "ControlChannel"
    private const val PREF = "tvshow_device"
    private const val KEY_DEVICE_ID = "deviceId"

    private const val BEAT_INTERVAL_MS = 3000L
    /** 失败退避上限 = 3 次心跳（9 秒）：与服务端离线判定对齐，网络恢复后一个周期内即同步状态 */
    private const val BEAT_MAX_BACKOFF_MS = 9_000L
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

    /** 本进程启动后的第一次心跳 */
    @Volatile
    private var boot = true

    @Volatile
    private var deviceId: String? = null

    /** 应用上下文（心跳上报本机极速模式开关等本机设置时使用） */
    @Volatile
    private var appContext: Context? = null

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

    /** 上次因内容落后触发强制同步的时刻（防抖：同步失败时不每拍重试） */
    @Volatile
    private var lastSyncKickAt = 0L

    /** 最近应用的展示指令 {cmd,args}：现场本地操作偏离它即自动交还（v6） */
    @Volatile
    private var lastApplied: JSONObject? = null

    /** 交还意图在途：响应确认 managed=false 后才清 lastApplied（失败随下一拍自动重发） */
    @Volatile
    private var pendingRelease = false

    /* ---------------- 初始化 ---------------- */

    /** 幂等初始化；在首个 Activity 的 onCreate 调用（建议 [com.digitalcenter.tvshow.ui.MainActivity]） */
    @Synchronized
    fun init(context: Context) {
        if (started.getAndSet(true)) return
        val app = context.applicationContext as Application
        appContext = app.applicationContext

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

    /* ---------------- 模式（v6 决议：受控端无任何取消入口） ----------------
     * 现场想摆脱受控画面 = 正常退出操作（【返回】退出当前画面，见 interceptKeyLocked 放行）；
     * 状态翻转（取消控制）只在控制台。这里只保留两条被动路径：
     * 控制端 release → managed=false → 解锁；boot 恢复 / 指令 → managed=true → 接管。 */

    /** 模式影子翻转 + 角标 + 提示（仅由心跳响应的被动路径触发，主线程） */
    private fun applyMode(remote: Boolean, silent: Boolean, activity: Activity? = null) {
        if (localMode == !remote) return
        localMode = !remote
        val target = activity ?: currentActivity
        target?.let { mainHandler.post { refreshBadge(it) } }
        if (!silent) {
            val ctx: Context = target ?: return
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
     * 受控锁定检查：远程被控时拦截方向 / 确定 / 菜单等展示操作（无人值守防误按）；
     * 【返回】放行——现场随时可用正常退出操作摆脱当前画面（回首页 / 退出应用）。
     * 返回 true 表示事件已被锁定吞掉。
     */
    fun interceptKeyLocked(
        keyCode: Int,
        context: Context,
        tip: String = "远程被控中 · 可按【返回】退出当前画面"
    ): Boolean {
        if (localMode) return false
        // 返回键豁免：受控态下仍可正常退出当前画面（v6：退出操作取代取消控制）
        if (keyCode == android.view.KeyEvent.KEYCODE_BACK) return false
        val now = System.currentTimeMillis()
        if (now - lastLockToastAt > 5000L) {
            lastLockToastAt = now
            Toast.makeText(context, tip, Toast.LENGTH_SHORT).show()
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

        val state = JSONObject(reported.toString())
            .putOpt("lastError", lastError ?: JSONObject.NULL)
        // 本机极速模式开关：控制台据此显示「极速：开/关」并下发相反的开关
        appContext?.let { state.put("turbo", LocalSettings.turbo(it).enabled) }
        val body = JSONObject().apply {
            put("deviceId", id)
            put("kind", "tv")
            put("appVersion", BuildConfig.VERSION_NAME)
            put("boot", boot)
            put("ackedSeq", ackedSeq)
            put("state", state)
        }
        // 注意：boot 只有在本拍**成功送达**后才置 false（见下方 responseCode 检查）。
        // 若在发请求前就清掉，首次心跳因网络故障失败时，下一拍会以 boot=false 重试，
        // 服务端据此丢失「进程刚启动」的信号，可能继续沿用重启前的受控状态。
        // 现场本地操作偏离指令画面 → 自动交还本地（服务端 managed=false，控制台如实显示）；
        // 本机立即解锁（角标移除）；若服务端恰有在途指令则指令优先（忽略本次交还并回下发）
        val la = lastApplied
        if (!localMode && la != null && !followsCommand(la, reported)) {
            // lastApplied 不在此清除：响应确认 managed=false 才清——本拍失败时
            // 偏离仍在，意图随下一拍自动重发（幂等），不会丢
            body.put("switchTo", "local")
            pendingRelease = true
            applyMode(remote = false, silent = true, activity = currentActivity)
        }

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
            // 服务端已收到本拍心跳：之后即使响应解析失败，也不应再以 boot=true 重发
            boot = false
            val text = conn.inputStream.use { it.readBytes().toString(Charsets.UTF_8) }
            handleResponse(JSONObject(text))
        } finally {
            conn.disconnect()
        }
    }

    private fun handleResponse(json: JSONObject) {
        val managed = json.optBoolean("managed", true)

        // 0) 内容版本比对：服务端配置有更新（Web 管理后台保存等）→ 立即强制同步。
        //    借 3s 心跳实现「Web 保存后 ≤3 秒电视端拿到新内容」；5s 防抖避免同步
        //    失败期间每拍重试。
        val content = json.optJSONObject("content")
        if (content != null) {
            val snap = ConfigRepository.snapshot()
            val stale = content.optLong("version", snap.version) != snap.version ||
                content.optLong("epoch", snap.epoch) != snap.epoch
            if (stale) {
                val now = System.currentTimeMillis()
                if (now - lastSyncKickAt > 5000L) {
                    lastSyncKickAt = now
                    Log.i(TAG, "检测到服务端内容更新（v${content.optLong("version")} > 本机 v${snap.version}），立即同步")
                    mainHandler.post { ConfigRepository.syncNow(force = true) }
                }
            }
        }

        // 1) 指令应用（展示类自动进入远程被控）
        val desired = json.optJSONObject("desired")
        if (desired != null) {
            val seq = desired.optLong("seq", 0L)
            val cmd = desired.optString("cmd")
            val args = desired.optJSONObject("args") ?: JSONObject()
            if (isDisplayCommand(cmd)) {
                pendingRelease = false // 新指令优先：交还意图已被服务端忽略
                lastApplied = JSONObject().put("cmd", cmd).put("args", args)
            }
            mainHandler.post {
                val activity = currentActivity
                if (activity == null) {
                    // 不确认：服务端会在下一拍重发，等回到前台再应用，避免指令被静默丢弃
                    Log.w(TAG, "指令到达但无前台 Activity，等待下次心跳重发：$cmd")
                } else {
                    CommandApplier.apply(activity, cmd, args)
                    ackedSeq = seq
                }
            }
            return
        }

        // 2) 纯模式校正（无指令时）：控制端「取消控制」→ 解锁；服务端记忆 → 接管（boot 恢复）
        if (!managed && !localMode) {
            lastApplied = null
            pendingRelease = false // 交还意图已送达确认（含自动交还路径）
            applyMode(remote = false, silent = false, activity = currentActivity)
        } else if (managed && localMode) {
            applyMode(remote = true, silent = true, activity = currentActivity)
        } else if (pendingRelease && !managed) {
            pendingRelease = false
            lastApplied = null
        }
    }

    /** 实际状态是否仍在执行该指令（与 Web 显示端 followsCommand 同一套比对规则） */
    private fun followsCommand(la: JSONObject, r: JSONObject): Boolean {
        return try {
            val args = la.optJSONObject("args") ?: JSONObject()
            when (la.optString("cmd")) {
                "show", "camera" ->
                    (r.optString("mode") == "page" || r.optString("mode") == "camera") &&
                        r.optString("entryId") == args.optString("entryId")
                "rotate" -> {
                    val rr = r.optJSONObject("rotate") ?: return false
                    r.optString("mode") == "rotate" &&
                        rr.optJSONArray("items")?.join(",") == args.optJSONArray("items")?.join(",") &&
                        rr.optInt("intervalSec") == args.optInt("intervalSec") // index 不比对
                }
                "zone" -> {
                    val z = r.optJSONObject("zone") ?: return false
                    r.optString("mode") == "zone" &&
                        z.optJSONArray("slots")?.join(",") == args.optJSONArray("slots")?.join(",")
                }
                "home" -> r.optString("mode") == "home"
                else -> true // 维护类不参与
            }
        } catch (e: Exception) {
            true
        }
    }

    /** 展示类指令判定（供 CommandApplier 复用） */
    fun isDisplayCommand(cmd: String): Boolean = DISPLAY_CMDS.split(',').contains(cmd)

    /** 供 CommandApplier 在应用展示类指令后置受控态（本地无 Toast：切画面本身就是信号） */
    fun onDisplayCommandApplied() {
        val activity = currentActivity
        applyMode(remote = true, silent = true, activity = activity)
    }
}
