package com.digitalcenter.tvshow.ui

import android.app.Activity
import android.content.Context
import com.digitalcenter.tvshow.R
import com.digitalcenter.tvshow.net.ControlChannel

/**
 * 多设备互控 · 电视端菜单辅助：控制模式开关的菜单项文案与切换动作。
 *
 * 设计 §8.2：各展示 Activity 的【菜单】控制菜单**首项**固定为「控制模式」；
 * 远程被控态下菜单裁剪为「控制模式 + 关闭」两项（其余条目属于被锁定的展示操作）。
 * 退出远程被控需二次确认（默认焦点「继续受控」，防遥控器误触）；进入直接生效。
 */
object CtlUi {

    /** 菜单项文案：「控制模式：本地控制 / 远程被控」 */
    fun modeMenuLabel(context: Context): String =
        if (ControlChannel.locked) context.getString(R.string.menu_ctl_mode_remote)
        else context.getString(R.string.menu_ctl_mode_local)

    /** 菜单项动作：切到本地需二次确认；切到远程直接生效 */
    fun toggleMode(activity: Activity) {
        if (ControlChannel.locked) {
            TvDialogs.confirm(
                context = activity,
                title = activity.getString(R.string.ctl_exit_title),
                message = activity.getString(R.string.ctl_exit_message),
                confirmText = activity.getString(R.string.ctl_exit_confirm),
                cancelText = activity.getString(R.string.ctl_exit_cancel)
            ) {
                ControlChannel.switchToLocal(activity)
            }.show()
        } else {
            ControlChannel.switchToRemote(activity)
        }
    }
}
