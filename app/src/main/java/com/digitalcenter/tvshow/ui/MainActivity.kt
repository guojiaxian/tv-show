package com.digitalcenter.tvshow.ui

import android.app.Dialog
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.view.animation.DecelerateInterpolator
import android.widget.LinearLayout
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.digitalcenter.tvshow.BuildConfig
import com.digitalcenter.tvshow.R
import com.digitalcenter.tvshow.config.ConfigLoader
import com.digitalcenter.tvshow.config.DisplayEntry
import com.digitalcenter.tvshow.config.LocalSettings
import com.digitalcenter.tvshow.config.RemoteConfig
import com.digitalcenter.tvshow.config.RotationSetting
import com.digitalcenter.tvshow.config.TurboSetting
import com.digitalcenter.tvshow.databinding.ActivityMainBinding
import com.digitalcenter.tvshow.databinding.ItemEntryCardBinding
import com.digitalcenter.tvshow.net.ConfigRepository
import com.digitalcenter.tvshow.net.ControlChannel
import com.digitalcenter.tvshow.util.UiUtil
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 首页：大屏展示入口聚合界面。
 *
 * 数据来源：**内容**（入口列表、系统标题）全部来自服务端（经 [ConfigRepository] 同步），
 * 本地只保留兜底内容；**展示策略**（轮询开关/序列/间隔、四个分区各放什么）是本机设置，
 * 按【菜单】键进入设置界面修改，见 [SettingsActivity]。
 * 交互：遥控器方向键移动焦点，确定键进入对应大屏，返回键触发退出确认。
 */
class MainActivity : AppCompatActivity() {

    companion object {
        /** 自适应高度计算的安全余量，避免整除误差导致刚好溢出 1px */
        private const val SAFETY_MARGIN_PX = 8
    }

    private lateinit var binding: ActivityMainBinding
    private var config: RemoteConfig = ConfigLoader.defaultConfig()
    private var rotationSetting = RotationSetting()

    private val handler = Handler(Looper.getMainLooper())
    private val timeFormat = SimpleDateFormat("HH:mm:ss", Locale.CHINA)
    private val dateFormat = SimpleDateFormat("yyyy年MM月dd日 EEEE", Locale.CHINA)
    private val clockTask = object : Runnable {
        override fun run() {
            val now = Date()
            binding.clockText.text = timeFormat.format(now)
            binding.dateText.text = dateFormat.format(now)
            handler.postDelayed(this, 1000L)
        }
    }

    private var exitDialog: Dialog? = null
    private var homeMenuDialog: Dialog? = null
    private lateinit var keyHintShower: () -> Unit
    private var firstCard: View? = null

    /**
     * 首页宫格的增量渲染状态：内容同步时若入口集合/列数/卡片高度没变，
     * 只重绑变化的卡片，避免整屏 removeAllViews 造成焦点丢失与闪烁。
     */
    private val cardBindings = LinkedHashMap<String, ItemEntryCardBinding>()
    private val renderedSignatures = HashMap<String, String>()
    private var renderedEntryIds: List<String> = emptyList()
    private var renderedColumns = 0
    private var renderedCardHeight = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        // 首页底栏显示当前安装包版本，现场排查「装的是哪版」无需进设置
        binding.appVersion.text = "v${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})"
        binding.emptySync.setOnClickListener { syncFromServer(force = true) }

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        UiUtil.applyImmersive(this)

        // 先完成同步层初始化（同步返回，不阻塞），再用本地内容渲染首屏
        ConfigRepository.init(this)
        // 多设备互控：注册受控通道（心跳 + 领指令；幂等，全部 Activity 只初始化一次）
        ControlChannel.init(this)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (config.exitConfirm) {
                    showExitConfirm()
                } else {
                    finish()
                }
            }
        })

        render()
        // 首屏渲染完成后再发起网络同步，保证启动速度不受网络影响
        syncFromServer(force = false)

        // 本机开启了「开机自动播放」时，启动后直接进入轮询播放（数字标牌场景）；
        // 按【返回】可回到首页并停止轮询，之后可从菜单「轮询展示」再次进入。
        handler.postDelayed({ startRotationIfEnabled() }, 800L)
    }

    override fun onResume() {
        super.onResume()
        handler.removeCallbacks(clockTask)
        handler.post(clockTask)
        // 从设置界面返回后，轮询开关/序列可能已变，重新读取本机设置
        rotationSetting = LocalSettings.rotation(this)
        // 多设备互控：回首页即上报 home（随下一拍心跳）
        ControlChannel.reportHome()
        // 回到前台时补一次同步（受最小间隔限制，避免频繁请求）
        if (binding.root.isLaidOut) syncFromServer(force = false)
    }

    override fun onPause() {
        super.onPause()
        handler.removeCallbacks(clockTask)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) UiUtil.applyImmersive(this)
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        // 远程被控时锁定展示操作（【返回】豁免——正常退出操作，v6：退出取代取消控制）
        if (ControlChannel.interceptKeyLocked(keyCode, this, getString(R.string.ctl_locked_home))) return true
        showKeyHint()
        if (keyCode == KeyEvent.KEYCODE_MENU || keyCode == KeyEvent.KEYCODE_INFO) {
            showHomeMenu()
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    /**
     * 首页控制菜单。
     *
     * 「轮询展示」「分区展示」都是**直接进入展示页**：
     * 轮询的开关/页面/间隔、分区的每格内容，都在各自展示页里按【菜单】/【确定】现场调整，
     * 因此首页不再需要单独的设置入口。
     * 受控态下【菜单】被锁定（v6：受控端无取消入口，退出用【返回】）。
     */
    private fun showHomeMenu() {
        val labels = ArrayList<String>()
        val actions = ArrayList<() -> Unit>()

        labels.add(getString(R.string.menu_sync_now))
        actions.add { syncFromServer(force = true) }

        labels.add(getString(R.string.menu_rotation_display))
        actions.add { startRotation() }

        labels.add(getString(R.string.menu_zone_display))
        actions.add { startActivity(Intent(this, ZoneDisplayActivity::class.java)) }

        // 极速模式本机总开关：翻转后不强制刷新首页（首页无 WebView，下次进入展示页即生效）
        labels.add(turboMenuLabel())
        actions.add { toggleTurbo() }

        labels.add(getString(R.string.menu_cancel))
        actions.add { }

        homeMenuDialog = TvDialogs.menu(
            context = this,
            title = getString(R.string.home_menu_title),
            subtitle = "${config.appTitle}　·　v${config.version}",
            items = labels
        ) { index -> actions.getOrNull(index)?.invoke() }
        homeMenuDialog?.show()
    }

    private fun turboMenuLabel(): String =
        getString(
            if (LocalSettings.turbo(this).enabled) R.string.menu_turbo_on
            else R.string.menu_turbo_off
        )

    private fun toggleTurbo() {
        val next = !LocalSettings.turbo(this).enabled
        LocalSettings.saveTurbo(this, TurboSetting(next))
        Toast.makeText(
            this,
            if (next) R.string.turbo_enabled_toast else R.string.turbo_disabled_toast,
            Toast.LENGTH_SHORT
        ).show()
    }

    /** 开机自动播放（本机设置里开启时才生效），由启动流程触发 */
    private fun startRotationIfEnabled() {
        if (rotationSetting.enabled) startRotation()
    }

    /**
     * 进入轮询播放。
     *
     * 首次进入且还没选过轮询页面时，默认让**全部页面**参与轮询，做到"点开即用"；
     * 之后可在轮询播放页按【菜单】→「轮询设置」增删页面、调整顺序与停留时间。
     * 画面墙经服务端 /cam/view 画面墙网页同样参与轮询。
     */
    private fun startRotation() {
        val rotatable = config.entries
        if (rotatable.isEmpty()) {
            Toast.makeText(this, R.string.config_missing, Toast.LENGTH_LONG).show()
            return
        }
        if (rotationSetting.items.none { id -> rotatable.any { it.id == id } }) {
            rotationSetting = rotationSetting.copy(items = rotatable.map { it.id })
            LocalSettings.saveRotation(this, rotationSetting)
            rotationSetting = LocalSettings.rotation(this)
        }
        startActivity(
            Intent(this, WebDisplayActivity::class.java)
                .putExtra(WebDisplayActivity.EXTRA_ROTATION, true)
        )
    }

    /* ---------------- 渲染 ---------------- */

    private fun render() {
        config = ConfigRepository.snapshot()
        binding.appTitle.text = config.appTitle
        binding.appSubtitle.text = config.appSubtitle
        binding.keyHint.text = getString(R.string.home_key_hint)
        showKeyHint()
        buildGrid()
        renderSyncState()
    }

    /** 底部按键提示：显示 3s 后自动隐藏，按键后重新显示 */
    private fun showKeyHint() {
        if (!::keyHintShower.isInitialized) keyHintShower = UiUtil.bindAutoHideHint(binding.keyHint)
        keyHintShower()
    }

    /** 触发一次服务端同步；仅在状态或内容变化时重绘 */
    private fun syncFromServer(force: Boolean) {
        ConfigRepository.syncNow(force) { status ->
            if (isFinishing) return@syncNow
            when (status.state) {
                ConfigRepository.SyncState.UPDATED -> {
                    render()
                    Toast.makeText(this, getString(R.string.config_updated, status.config.version), Toast.LENGTH_SHORT).show()
                }
                ConfigRepository.SyncState.OFFLINE -> {
                    renderSyncState()
                    Toast.makeText(this, R.string.config_offline, Toast.LENGTH_SHORT).show()
                }
                ConfigRepository.SyncState.UP_TO_DATE -> {
                    renderSyncState()
                    if (force) Toast.makeText(this, R.string.config_up_to_date, Toast.LENGTH_SHORT).show()
                }
                else -> renderSyncState()
            }
        }
    }

    /** 底栏右侧显示同步状态，让运维一眼看出当前内容来源 */
    private fun renderSyncState() {
        val text = when (ConfigRepository.state()) {
            ConfigRepository.SyncState.SYNCING -> getString(R.string.sync_state_syncing)
            ConfigRepository.SyncState.OFFLINE -> getString(R.string.sync_state_offline)
            ConfigRepository.SyncState.FALLBACK -> getString(R.string.sync_state_fallback)
            else -> getString(R.string.sync_state_ok, config.version)
        }
        binding.syncState.text = text
        binding.syncState.setTextColor(
            when (ConfigRepository.state()) {
                ConfigRepository.SyncState.OFFLINE, ConfigRepository.SyncState.FALLBACK ->
                    ContextCompat.getColor(this, R.color.warn)
                ConfigRepository.SyncState.SYNCING ->
                    ContextCompat.getColor(this, R.color.text_secondary)
                else -> ContextCompat.getColor(this, R.color.ok)
            }
        )
    }

    private fun buildGrid() {
        val container = binding.gridContainer
        val entries = config.entries
        if (entries.isEmpty()) {
            cardBindings.clear()
            renderedSignatures.clear()
            renderedEntryIds = emptyList()
            renderedColumns = 0
            renderedCardHeight = 0
            container.removeAllViews()
            firstCard = null
            binding.emptyPanel.visibility = View.VISIBLE
            binding.emptyMessage.text = getString(
                R.string.home_empty_message,
                ConfigRepository.serverBaseUrl().trimEnd('/') + "/setting"
            )
            binding.emptyPanel.post { binding.emptySync.requestFocus() }
            return
        }
        binding.emptyPanel.visibility = View.GONE

        val gap = resources.getDimensionPixelSize(R.dimen.card_gap)
        val columns = columnsForScreen()
        val rows = (entries.size + columns - 1) / columns
        val cardHeight = adaptiveCardHeight(rows)
        val ids = entries.map { it.id }
        val signatures = entries.associate { it.id to it.toString() }

        // 入口集合/顺序/布局未变：只重绑内容有变化的卡片，保留焦点与动画
        if (ids == renderedEntryIds &&
            columns == renderedColumns &&
            cardHeight == renderedCardHeight &&
            cardBindings.keys.toList() == ids
        ) {
            entries.forEach { entry ->
                if (renderedSignatures[entry.id] != signatures[entry.id]) {
                    cardBindings[entry.id]?.let { bindCard(it, entry) }
                    renderedSignatures[entry.id] = signatures.getValue(entry.id)
                }
            }
            return
        }

        // 结构变化（增删/排序/列数/卡片高度）：整屏重建
        cardBindings.clear()
        renderedSignatures.clear()
        container.removeAllViews()
        firstCard = null

        entries.chunked(columns).forEachIndexed { rowIndex, rowEntries ->
            // clipChildren=false：焦点卡片放大后允许溢出本行边界，避免被裁掉边缘
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                clipChildren = false
            }

            rowEntries.forEachIndexed { index, entry ->
                val cardBinding = ItemEntryCardBinding.inflate(layoutInflater, row, false)
                val card = bindCard(cardBinding, entry)
                cardBindings[entry.id] = cardBinding
                renderedSignatures[entry.id] = signatures.getValue(entry.id)
                if (firstCard == null) firstCard = card

                val lp = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1f)
                if (index > 0) lp.marginStart = gap / 2
                if (index < rowEntries.lastIndex) lp.marginEnd = gap / 2
                row.addView(card, lp)
            }

            // 补齐空位，保证最后一行卡片宽度与其它行一致
            repeat(columns - rowEntries.size) {
                row.addView(View(this), LinearLayout.LayoutParams(0, 1, 1f))
            }

            val rowParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                cardHeight
            ).apply { if (rowIndex > 0) topMargin = gap }
            container.addView(row, rowParams)
        }

        renderedEntryIds = ids
        renderedColumns = columns
        renderedCardHeight = cardHeight
        container.post { firstCard?.requestFocus() }
    }

    /**
     * 自适应卡片高度：让 N 行正好铺满栅格可用高度（避免入口少时下方大片留白），
     * 并以 [R.dimen.card_height] 为下限（保证卡片内容不被压缩）。
     * 入口再多（3 行以上）时取下限，由 ScrollView 滚动查看。
     */
    private fun adaptiveCardHeight(rows: Int): Int {
        val metrics = resources.displayMetrics
        val usable = metrics.heightPixels -
            2 * resources.getDimensionPixelSize(R.dimen.screen_padding_v) -
            resources.getDimensionPixelSize(R.dimen.topbar_height) -
            resources.getDimensionPixelSize(R.dimen.bottombar_height) -
            2 * resources.getDimensionPixelSize(R.dimen.grid_padding_v) - SAFETY_MARGIN_PX
        val gap = resources.getDimensionPixelSize(R.dimen.card_gap)
        val minH = resources.getDimensionPixelSize(R.dimen.card_height)
        val maxH = resources.getDimensionPixelSize(R.dimen.card_max_height)
        val raw = (usable - (rows - 1).coerceAtLeast(0) * gap) / rows.coerceAtLeast(1)
        return raw.coerceIn(minH, maxH)
    }

    /** 依据屏幕宽度自适应列数：电视横屏常见 960dp 宽，取 3 列 */
    private fun columnsForScreen(): Int {
        val widthDp = resources.configuration.screenWidthDp
        return when {
            widthDp >= 1280 -> 4
            widthDp >= 940 -> 3
            widthDp >= 620 -> 2
            else -> 1
        }
    }

    private fun bindCard(cardBinding: ItemEntryCardBinding, entry: DisplayEntry): View {
        val accent = UiUtil.parseColor(entry.accent)
        val normalTitle = ContextCompat.getColor(this, R.color.text_primary)
        val normalAddress = ContextCompat.getColor(this, R.color.text_tertiary)
        val normalSubtitle = ContextCompat.getColor(this, R.color.text_secondary)

        cardBinding.cardTitle.text = entry.title
        cardBinding.cardSubtitle.text = entry.subtitle
        cardBinding.cardAddress.text =
            if (entry.isCamera) getString(R.string.camera_card_address) else entry.url
        cardBinding.cardIcon.setImageResource(iconRes(entry.icon))
        cardBinding.cardIcon.imageTintList = ColorStateList.valueOf(accent)
        cardBinding.iconBox.backgroundTintList =
            ColorStateList.valueOf(withAlpha(accent, 0.16f))
        cardBinding.cardSubtitle.setTextColor(normalSubtitle)

        val root = cardBinding.root
        root.tag = entry.id

        root.onFocusChangeListener = View.OnFocusChangeListener { v, hasFocus ->
            val scale = if (hasFocus) 1.05f else 1f
            v.animate()
                .scaleX(scale)
                .scaleY(scale)
                .setDuration(180L)
                .setInterpolator(DecelerateInterpolator())
                .start()
            v.elevation = if (hasFocus) UiUtil.dp(this, 16f).toFloat() else 0f

            cardBinding.cardTitle.setTextColor(if (hasFocus) Color.WHITE else normalTitle)
            cardBinding.cardAddress.setTextColor(if (hasFocus) accent else normalAddress)
            cardBinding.cardSubtitle.alpha = if (hasFocus) 1f else 0.85f
        }
        root.setOnClickListener { openEntry(entry) }
        return root
    }

    private fun openEntry(entry: DisplayEntry) {
        // 画面墙入口（type=camera）由客户端原生渲染摄像机画面，没有网页地址
        val target = if (entry.isCamera) CameraWallActivity::class.java else WebDisplayActivity::class.java
        startActivity(
            Intent(this, target).putExtra(WebDisplayActivity.EXTRA_ENTRY_ID, entry.id)
        )
    }

    private fun showExitConfirm() {
        if (exitDialog?.isShowing == true) return
        // 退出提示文案由服务端 meta 下发（管理后台「退出提示文案」），留空时用内置文案
        val message = config.exitTip.ifBlank { getString(R.string.exit_message) }
        exitDialog = TvDialogs.confirm(
            context = this,
            title = getString(R.string.exit_title),
            message = message,
            confirmText = getString(R.string.exit_confirm),
            cancelText = getString(R.string.exit_cancel)
        ) { finish() }
        exitDialog?.show()
    }

    override fun onDestroy() {
        // 清理时钟与「开机自动轮询」延时任务：避免 Activity 已结束时仍启动新页面
        handler.removeCallbacksAndMessages(null)
        exitDialog?.dismiss()
        homeMenuDialog?.dismiss()
        super.onDestroy()
    }

    private fun iconRes(icon: String?): Int = when (icon) {
        "storage" -> R.drawable.ic_storage
        "env" -> R.drawable.ic_env
        "security" -> R.drawable.ic_security
        else -> R.drawable.ic_default
    }

    private fun withAlpha(color: Int, alpha: Float): Int = Color.argb(
        (255 * alpha).toInt().coerceIn(0, 255),
        Color.red(color),
        Color.green(color),
        Color.blue(color)
    )
}
