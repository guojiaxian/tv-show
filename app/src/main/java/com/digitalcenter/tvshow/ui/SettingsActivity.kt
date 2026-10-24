package com.digitalcenter.tvshow.ui

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.digitalcenter.tvshow.R
import com.digitalcenter.tvshow.config.ConfigLoader
import com.digitalcenter.tvshow.config.LocalSettings
import com.digitalcenter.tvshow.config.MAX_INTERVAL_SEC
import com.digitalcenter.tvshow.config.MIN_INTERVAL_SEC
import com.digitalcenter.tvshow.config.RemoteConfig
import com.digitalcenter.tvshow.config.RotationSetting
import com.digitalcenter.tvshow.databinding.ActivitySettingsBinding
import com.digitalcenter.tvshow.databinding.ItemSettingRowBinding
import com.digitalcenter.tvshow.net.ConfigRepository
import com.digitalcenter.tvshow.net.ControlChannel
import com.digitalcenter.tvshow.util.UiUtil

/**
 * 轮询设置。
 *
 * 入口：在**轮询播放页**按【菜单】→「轮询设置」（对应 `WebDisplayActivity`），
 * 改完按【返回】即回到轮询播放并立刻按新设置生效。
 *
 * 轮询是**本机策略**而不是内容，因此不放在服务端：
 * 服务端只维护"有哪些页面可以展示"，由每台电视自己决定轮播哪些页面、间隔多久。
 * 设置保存在本机 [LocalSettings]，不影响其它设备。
 *
 * 遥控器操作：上下移动焦点，确定执行，页面行上可用左右键调整播放顺序。
 */
class SettingsActivity : AppCompatActivity() {

    companion object {
        /** 轮询间隔可选值（秒），避免电视上弹出软键盘输入 */
        private val INTERVAL_PRESETS = intArrayOf(5, 10, 15, 20, 30, 45, 60, 120, 300)
    }

    private lateinit var binding: ActivitySettingsBinding
    private val handler = Handler(Looper.getMainLooper())

    private var config: RemoteConfig = ConfigLoader.defaultConfig()
    private var rotationSetting = RotationSetting()
    private var firstRow: View? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivitySettingsBinding.inflate(layoutInflater)
        setContentView(binding.root)

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        UiUtil.applyImmersive(this)

        ConfigRepository.init(this)
        config = ConfigRepository.snapshot()
        rotationSetting = LocalSettings.rotation(this)

        binding.settingsTitle.text = getString(R.string.rotation_settings_title)
        binding.settingsSubtitle.text = getString(R.string.rotation_settings_subtitle)
        binding.settingsHint.text = getString(R.string.rotation_settings_hint)

        renderRows()
    }

    override fun onResume() {
        super.onResume()
        // 多设备互控：上报本机设置界面（远程指令到达时此页会被 CLEAR_TOP 切走）
        ControlChannel.reportSettings()
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        // 远程被控时锁定设置操作（【菜单】豁免——可切回本地控制）
        if (ControlChannel.interceptKeyLocked(keyCode, this)) return true
        return super.onKeyDown(keyCode, event)
    }

    /* ---------------- 行渲染 ---------------- */

    private fun renderRows() {
        val container = binding.settingsContainer
        container.removeAllViews()
        firstRow = null

        addRow(
            container,
            getString(R.string.rotation_enabled_label),
            getString(if (rotationSetting.enabled) R.string.state_on else R.string.state_off)
        ) {
            rotationSetting = rotationSetting.copy(enabled = !rotationSetting.enabled)
            persistRotation()
        }

        addRow(
            container,
            getString(R.string.rotation_interval_label),
            getString(R.string.rotation_interval_value, rotationSetting.intervalSec)
        ) { pickInterval() }

        addSection(container, getString(R.string.rotation_pages_section))

        // 画面墙经服务端 /cam/view 页面同样参与轮询，设置列表包含全部入口
        config.entries.forEach { entry ->
            val position = rotationSetting.items.indexOf(entry.id)
            val value = if (position >= 0) {
                getString(R.string.rotation_page_position, position + 1, rotationSetting.items.size)
            } else {
                getString(R.string.rotation_page_excluded)
            }
            addRow(container, entry.title, value, onMove = { dir ->
                moveInSequence(entry.id, dir)
            }) {
                toggleInSequence(entry.id)
            }
        }

        addSection(container, getString(R.string.rotation_order_section))

        if (config.entries.isEmpty()) {
            Toast.makeText(this, R.string.config_missing, Toast.LENGTH_LONG).show()
        }
        container.post { firstRow?.requestFocus() }
    }

    private fun addSection(container: LinearLayout, text: String) {
        val view = TextView(this).apply {
            this.text = text
            setTextColor(ContextCompat.getColor(context, R.color.text_tertiary))
            textSize = 13f
            setPadding(UiUtil.dp(context, 8f), UiUtil.dp(context, 14f), 0, UiUtil.dp(context, 6f))
        }
        container.addView(view, LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
    }

    /**
     * 添加一个可聚焦设置行。
     * @param onMove 提供后，左右方向键会回调（-1 上移 / +1 下移），用于调整播放顺序
     */
    private fun addRow(
        container: LinearLayout,
        label: String,
        value: String,
        onMove: ((Int) -> Boolean)? = null,
        onClick: () -> Unit
    ): View {
        val rowBinding = ItemSettingRowBinding.inflate(layoutInflater, container, false)
        rowBinding.rowLabel.text = label
        rowBinding.rowValue.text = value

        val row = rowBinding.root
        row.setOnClickListener { onClick() }
        if (onMove != null) {
            row.setOnKeyListener { _, keyCode, event ->
                if (event.action == KeyEvent.ACTION_DOWN) {
                    when (keyCode) {
                        KeyEvent.KEYCODE_DPAD_LEFT -> onMove(-1)
                        KeyEvent.KEYCODE_DPAD_RIGHT -> onMove(1)
                        else -> false
                    }
                } else {
                    false
                }
            }
        }

        val lp = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { if (firstRow != null) topMargin = UiUtil.dp(this@SettingsActivity, 8f) }
        container.addView(row, lp)
        if (firstRow == null) firstRow = row
        return row
    }

    /* ---------------- 轮询设置 ---------------- */

    private fun toggleInSequence(entryId: String) {
        val items = rotationSetting.items.toMutableList()
        if (!items.remove(entryId)) items.add(entryId)
        rotationSetting = rotationSetting.copy(items = items)
        persistRotation()
    }

    /** 在轮询序列中上移/下移一个页面 */
    private fun moveInSequence(entryId: String, direction: Int): Boolean {
        val items = rotationSetting.items.toMutableList()
        val from = items.indexOf(entryId)
        if (from < 0) return false
        val to = (from + direction).coerceIn(0, items.size - 1)
        if (to == from) return false
        items.removeAt(from)
        items.add(to, entryId)
        rotationSetting = rotationSetting.copy(items = items)
        persistRotation()
        return true
    }

    private fun pickInterval() {
        val labels = INTERVAL_PRESETS.map { getString(R.string.rotation_interval_value, it) }
        TvDialogs.menu(
            context = this,
            title = getString(R.string.rotation_interval_label),
            subtitle = getString(R.string.rotation_interval_range, MIN_INTERVAL_SEC, MAX_INTERVAL_SEC),
            items = labels
        ) { index ->
            INTERVAL_PRESETS.getOrNull(index)?.let { seconds ->
                rotationSetting = rotationSetting.copy(intervalSec = seconds)
                persistRotation()
            }
        }.show()
    }

    /** 保存轮询设置：每次都重置本机时钟起点，从第 1 页重新开始计时 */
    private fun persistRotation() {
        LocalSettings.saveRotation(this, rotationSetting)
        rotationSetting = LocalSettings.rotation(this)
        renderRows()
        markSaved()
    }

    private fun markSaved() {
        binding.settingsState.text = getString(R.string.settings_saved)
        handler.removeCallbacksAndMessages(null)
        handler.postDelayed({ binding.settingsState.text = "" }, 1600L)
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }
}
