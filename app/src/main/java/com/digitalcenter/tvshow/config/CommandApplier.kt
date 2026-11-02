package com.digitalcenter.tvshow.config

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.util.Log
import android.widget.Toast
import com.digitalcenter.tvshow.net.ConfigRepository
import com.digitalcenter.tvshow.net.ControlChannel
import com.digitalcenter.tvshow.ui.CameraWallActivity
import com.digitalcenter.tvshow.ui.MainActivity
import com.digitalcenter.tvshow.ui.WebDisplayActivity
import com.digitalcenter.tvshow.ui.ZoneDisplayActivity
import org.json.JSONObject

/**
 * 多设备互控 · 指令应用器：把服务端下发的指令映射到界面动作。
 *
 * 设计 §10.2 的核心表：
 *  - show   → 画面墙入口进 [CameraWallActivity]，普通页面进 [WebDisplayActivity]；
 *             入口已不存在时回首页并上报 lastError
 *  - rotate → 写入本机轮询设置（同相切换时沿用服务端统一起点），进入轮询播放
 *  - zone   → 写入本机分区设置，进入 2×2 分屏
 *  - home   → 回首页（受控停在首页）
 *  - refresh / sync → 维护类，作用于栈顶 Activity，不改变模式
 *
 * 全部动作在主线程执行（由 [ControlChannel] post）；指令应用失败不阻塞后续指令，
 * 仅记录 lastError 随心跳上报，控制屏可见。
 */
object CommandApplier {

    private const val TAG = "CommandApplier"

    /** 可刷新当前画面的 Activity 实现此接口（refresh 指令作用于栈顶） */
    interface Reloadable {
        fun reloadCurrent()
    }

    fun apply(activity: Activity, cmd: String, args: JSONObject) {
        ControlChannel.lastError = null
        try {
            when (cmd) {
                "show" -> applyShow(activity, args)
                "rotate" -> applyRotate(activity, args)
                "zone" -> applyZone(activity, args)
                "home" -> goHome(activity)
                "refresh" -> applyRefresh(activity)
                "sync" -> ConfigRepository.syncNow(force = true)
                else -> Log.w(TAG, "未知指令：$cmd（忽略）")
            }
        } catch (e: Exception) {
            Log.w(TAG, "指令应用失败：$cmd -> ${e.message}")
            ControlChannel.lastError = "指令应用失败：$cmd（${e.message}）"
        }
        // 展示类指令 = 强制接管：切画面 + 锁定 + 角标（设计 §8）。
        // 应用失败（入口已删除 / 序列全不可用等，lastError 非空）时设备实际已回首页，
        // 不应再进入受控锁定，否则控制台显示「被控」而现场在首页，需等下一拍心跳纠偏。
        if (ControlChannel.isDisplayCommand(cmd) && ControlChannel.lastError == null) {
            ControlChannel.onDisplayCommandApplied()
        }
    }

    /* ---------------- show ---------------- */

    private fun applyShow(activity: Activity, args: JSONObject) {
        val entryId = args.optString("entryId")
        val entry = ConfigRepository.snapshot().entryOf(entryId)
        if (entry == null) {
            ControlChannel.lastError = "指令引用的入口「$entryId」已不存在"
            Toast.makeText(activity, ControlChannel.lastError, Toast.LENGTH_LONG).show()
            goHome(activity)
            return
        }
        // 「强制原址打开」入口在远程指令下仍内嵌播放：受控电视无人值守，弹浏览器无意义
        val target = if (entry.isCamera) CameraWallActivity::class.java else WebDisplayActivity::class.java
        activity.startActivity(
            Intent(activity, target)
                .putExtra(WebDisplayActivity.EXTRA_ENTRY_ID, entry.id)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_NEW_TASK)
        )
    }

    /* ---------------- rotate ---------------- */

    private fun applyRotate(activity: Activity, args: JSONObject) {
        val context = activity.applicationContext
        val current = LocalSettings.rotation(context)
        val items = buildList {
            val arr = args.optJSONArray("items")
            for (i in 0 until (arr?.length() ?: 0)) {
                val id = arr?.optString(i).orEmpty()
                // 内容同步滞后时个别入口可能暂不可见：跳过（与轮询序列既有规则一致）
                if (id.isNotEmpty() && ConfigRepository.snapshot().entryOf(id) != null) add(id)
            }
        }
        if (items.isEmpty()) {
            ControlChannel.lastError = "轮询序列中的入口在本机均不可用"
            Toast.makeText(activity, ControlChannel.lastError, Toast.LENGTH_LONG).show()
            goHome(activity)
            return
        }
        val intervalSec = args.optInt("intervalSec", current.intervalSec).coerceIn(1, 3600)
        // 同相切换（phaseSync）时服务端已生成对齐边界的统一起点；否则以本机收到时刻起算
        val startedAt = if (args.has("startedAt")) args.optLong("startedAt") else 0L
        LocalSettings.saveRotation(
            context,
            RotationSetting(
                enabled = current.enabled,
                intervalSec = intervalSec,
                items = items,
                startedAt = startedAt
            ),
            restartClock = false
        )
        activity.startActivity(
            Intent(activity, WebDisplayActivity::class.java)
                .putExtra(WebDisplayActivity.EXTRA_ROTATION, true)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_NEW_TASK)
        )
    }

    /* ---------------- zone ---------------- */

    private fun applyZone(activity: Activity, args: JSONObject) {
        val context = activity.applicationContext
        val slots = args.optJSONArray("slots")
        val zones = (0 until com.digitalcenter.tvshow.config.ZONE_COUNT).map { pos ->
            val id = slots?.optString(pos).orEmpty()
            ZoneSetting(position = pos, entryId = id)
        }
        LocalSettings.saveZones(context, zones)
        activity.startActivity(
            Intent(activity, ZoneDisplayActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_NEW_TASK)
        )
    }

    /* ---------------- home / refresh ---------------- */

    private fun goHome(activity: Activity) {
        val intent = Intent(activity, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        if (activity !is MainActivity) activity.finish()
        activity.startActivity(intent)
    }

    private fun applyRefresh(activity: Activity) {
        val reloadable = activity as? Reloadable
        if (reloadable != null) {
            reloadable.reloadCurrent()
        } else if (activity is MainActivity) {
            // 首页没有可刷新的网页：等价于强制同步一次内容
            ConfigRepository.syncNow(force = true)
        }
    }
}
