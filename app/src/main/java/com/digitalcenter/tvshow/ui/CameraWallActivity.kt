package com.digitalcenter.tvshow.ui

import android.graphics.Bitmap
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.digitalcenter.tvshow.R
import com.digitalcenter.tvshow.config.CommandApplier
import com.digitalcenter.tvshow.net.CameraClient
import com.digitalcenter.tvshow.net.ConfigRepository
import com.digitalcenter.tvshow.net.ControlChannel
import com.digitalcenter.tvshow.net.MjpegReader
import com.digitalcenter.tvshow.util.UiUtil
import java.util.concurrent.Executors

/**
 * 机房监控画面墙：客户端原生渲染摄像机实时画面（零第三方库，仅 HttpURLConnection）。
 *
 * 入口是服务端 `type=camera` 的条目（没有网页地址），由首页点击直接进入。
 *
 * 两种布局：
 *  - **3×3 画面墙**：服务端把每 3 路按行 `hstack` 合成一条 1920×360 画面，客户端只加载
 *    3 条流（否则 9 路 MJPEG 长连接会占满浏览器同源 6 连接上限，表现为随机几格永久黑屏）；
 *  - **1×1 单画面**：只拉当前选中那一路的主码流，放大观看。
 *
 * 墙上可能有一格是品牌 logo（服务端把该格合成黑帧，客户端据此格叠本地图片），
 * 「格 → 摄像头」必须按服务端下发的排布反查，不能按下标直等，否则图文错位。
 *
 * 遥控器：方向键选格、确定键放大/退回、菜单键切换布局/重连/返回首页、返回键回首页。
 */
class CameraWallActivity : AppCompatActivity(), CommandApplier.Reloadable {

    companion object {
        private const val TAG = "CameraWall"

        /** 与服务端 camera.js 的 WALL_COLS / WALL_ROWS 保持一致 */
        private const val WALL_COLS = 3
        private const val WALL_ROWS = 3
        private const val WALL_CELLS = WALL_COLS * WALL_ROWS

        private const val MODE_WALL = 3
        private const val MODE_SINGLE = 1

        /** 断流后重连等待（毫秒） */
        private const val RECONNECT_DELAY_MS = 3000L

        /** 品牌格 logo 占格子的比例（与电脑端 object-fit:contain + 60% 尺寸一致） */
        private const val LOGO_SCALE = 0.6f
    }

    private lateinit var wallContainer: FrameLayout
    private lateinit var overlayGrid: LinearLayout
    private lateinit var modeChip: TextView
    private lateinit var emptyText: TextView
    private lateinit var keyHintShower: () -> Unit

    private var cameras: List<CameraClient.CameraInfo> = emptyList()

    /** 服务端下发的画面墙 9 格排布：正数为摄像头编号，品牌格/空位见 CameraClient */
    private var wallCells: List<Int> = emptyList()
    private var layout = MODE_WALL

    /** 当前高亮的**格子序号**（不是摄像头下标：品牌格占位后两者不再重合） */
    private var selected = 0

    /** 视频层（3×3 时按行三条，单画面时一条）与选格浮层 */
    private val views = ArrayList<ImageView>()
    private val readers = ArrayList<MjpegReader?>()
    private val cells = ArrayList<WallCell>()

    /** logo 只有品牌格有值，其余格为 null */
    private data class WallCell(val box: FrameLayout, val label: TextView, val logo: ImageView?)

    /** 每发起一轮拉流就 +1，用于废弃旧流的帧回调与在途重连 */
    private var streamGen = 0L
    private var streaming = false
    @Volatile
    private var destroyed = false

    private val handler = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor { r ->
        Thread(r, "cam-list").apply { isDaemon = true }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_camera)

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        UiUtil.applyImmersive(this)

        wallContainer = findViewById(R.id.wallContainer)
        overlayGrid = findViewById(R.id.overlayGrid)
        modeChip = findViewById(R.id.modeChip)
        emptyText = findViewById(R.id.emptyText)
        // 底部按键提示：3s 自动隐藏，按键后重新显示
        keyHintShower = UiUtil.bindAutoHideHint(findViewById(R.id.hintBar))
        keyHintShower()

        ConfigRepository.init(this)
        emptyText.text = getString(R.string.camera_loading)
        emptyText.visibility = View.VISIBLE

        loadCameras()
        Log.i(TAG, "画面墙启动：屏幕 ${resources.displayMetrics.widthPixels}×" +
            "${resources.displayMetrics.heightPixels}px")
    }

    /* ---------------- 摄像头清单 ---------------- */

    private fun loadCameras() {
        val base = ConfigRepository.serverBaseUrl()
        io.execute {
            val wall = runCatching { CameraClient.fetchWall(base) }
                .onFailure { Log.w(TAG, "拉取摄像头清单失败：${it.message}") }
                .getOrDefault(CameraClient.Wall(emptyList(), emptyList()))
            handler.post {
                if (destroyed) return@post
                cameras = wall.cameras
                wallCells = wall.cells
                if (cameras.isEmpty()) {
                    emptyText.text = getString(R.string.camera_empty)
                    emptyText.visibility = View.VISIBLE
                    modeChip.visibility = View.GONE
                    return@post
                }
                emptyText.visibility = View.GONE
                layout = MODE_WALL
                // 高亮落在第一个真正有画面的格子上，避免停在品牌格/空位
                selected = selectableIndices().firstOrNull() ?: 0
                startStreams()
            }
        }
    }

    /** 排布中第 index 格对应的摄像头；品牌格、空位、越界一律返回 null */
    private fun cameraAt(index: Int): CameraClient.CameraInfo? {
        val id = wallCells.getOrNull(index) ?: return null
        if (id <= 0) return null
        return cameras.firstOrNull { it.id == id }
    }

    /** 是否品牌格（服务端该格发黑帧，logo 由客户端本地图片绘制） */
    private fun isLogoCell(index: Int) = wallCells.getOrNull(index) == CameraClient.WALL_LOGO

    /** 所有「有摄像头」的格子序号（左上到右下），方向键只在其中移动 */
    private fun selectableIndices() = (0 until WALL_CELLS).filter { cameraAt(it) != null }

    /* ---------------- 拉流 ---------------- */

    /** 按当前布局重建视频层与选格浮层，并重新拉起所有流 */
    private fun startStreams() {
        if (cameras.isEmpty()) return
        stopStreams()
        val gen = ++streamGen
        buildLayer()
        val slots = if (layout == MODE_SINGLE) 1 else WALL_ROWS
        repeat(slots) { slot ->
            val reader = createReader(slot, gen)
            readers.add(reader)
            reader.start()
        }
        updateChip()
        updateCells()
        streaming = true
    }

    /** 断开全部流，并让在途的帧回调与重连计划全部失效 */
    private fun stopStreams() {
        streamGen++
        readers.forEach { it?.stop() }
        readers.clear()
        streaming = false
    }

    private fun createReader(slot: Int, gen: Long): MjpegReader {
        val base = ConfigRepository.serverBaseUrl()
        val url = if (layout == MODE_SINGLE) {
            val camera = cameraAt(selected)
            CameraClient.singleUrl(base, camera?.id ?: 1, high = true, gen = gen)
        } else {
            CameraClient.wallRowUrl(base, slot + 1, gen)
        }
        return MjpegReader(url, object : MjpegReader.Listener {
            override fun onFrame(bitmap: Bitmap) {
                if (gen != streamGen) return
                views.getOrNull(slot)?.setImageBitmap(bitmap)
            }

            override fun onClosed(reason: String?) {
                if (gen != streamGen || destroyed) return
                Log.w(TAG, "槽位 $slot 流断开（$reason），${RECONNECT_DELAY_MS}ms 后重连")
                handler.postDelayed({
                    if (gen != streamGen || destroyed) return@postDelayed
                    readers.getOrNull(slot)?.stop()
                    val next = createReader(slot, gen)
                    readers[slot] = next
                    next.start()
                }, RECONNECT_DELAY_MS)
            }
        })
    }

    /* ---------------- 视图构建 ---------------- */

    private fun buildLayer() {
        wallContainer.removeAllViews()
        overlayGrid.removeAllViews()
        views.clear()
        cells.clear()

        if (layout == MODE_SINGLE) {
            val view = ImageView(this).apply {
                setBackgroundColor(Color.BLACK)
                scaleType = ImageView.ScaleType.FIT_CENTER
            }
            wallContainer.addView(
                view,
                FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT
                )
            )
            views.add(view)
            overlayGrid.visibility = View.GONE
            return
        }

        // 3×3：三条按行合成的画面竖排铺满（1920×360 × 3 = 1920×1080）
        val column = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        repeat(WALL_ROWS) {
            val view = ImageView(this).apply {
                setBackgroundColor(Color.BLACK)
                scaleType = ImageView.ScaleType.FIT_XY
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f
                )
            }
            column.addView(view)
            views.add(view)
        }
        wallContainer.addView(
            column,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        )
        overlayGrid.visibility = View.VISIBLE
        buildOverlay()
    }

    /** 3×3 透明选格浮层：每格一个描边框 + 通道标题，不吃焦点、不拦按键 */
    private fun buildOverlay() {
        for (row in 0 until WALL_ROWS) {
            val rowView = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f
                )
            }
            for (col in 0 until WALL_COLS) {
                val index = row * WALL_COLS + col
                val box = FrameLayout(this).apply {
                    layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1f)
                    background = ContextCompat.getDrawable(this@CameraWallActivity, R.drawable.bg_zone_idle)
                    isFocusable = false
                    isClickable = false
                }
                val label = TextView(this).apply {
                    layoutParams = FrameLayout.LayoutParams(
                        FrameLayout.LayoutParams.WRAP_CONTENT,
                        FrameLayout.LayoutParams.WRAP_CONTENT,
                        Gravity.TOP or Gravity.START
                    ).apply {
                        leftMargin = UiUtil.dp(this@CameraWallActivity, 14f)
                        topMargin = UiUtil.dp(this@CameraWallActivity, 14f)
                    }
                    background = ContextCompat.getDrawable(this@CameraWallActivity, R.drawable.bg_hint_bar)
                    setPadding(UiUtil.dp(this@CameraWallActivity, 14f), UiUtil.dp(this@CameraWallActivity, 8f),
                        UiUtil.dp(this@CameraWallActivity, 14f), UiUtil.dp(this@CameraWallActivity, 8f))
                    setTextColor(ContextCompat.getColor(this@CameraWallActivity, R.color.text_primary))
                    textSize = 13f
                    isFocusable = false
                    isClickable = false
                }
                box.addView(label)
                val logo = if (isLogoCell(index)) addLogo(box) else null
                rowView.addView(box)
                cells.add(WallCell(box, label, logo))
            }
            overlayGrid.addView(rowView)
        }
    }

    /** 品牌格：黑底之上居中放本地 logo，按格子的 60% 绘制且保持原图比例 */
    private fun addLogo(box: FrameLayout): ImageView {
        val logo = ImageView(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
            setImageResource(R.drawable.wutan_logo)
            // FIT_CENTER 先按格子尺寸等比容纳，再整体缩到 60%——等价于 object-fit: contain
            scaleType = ImageView.ScaleType.FIT_CENTER
            scaleX = LOGO_SCALE
            scaleY = LOGO_SCALE
            isFocusable = false
            isClickable = false
        }
        box.addView(logo)
        return logo
    }

    /* ---------------- 状态刷新 ---------------- */

    private fun updateChip() {
        modeChip.visibility = View.VISIBLE
        modeChip.text = if (layout == MODE_WALL) {
            getString(R.string.camera_mode_wall)
        } else {
            getString(R.string.camera_mode_single, cameraAt(selected)?.title ?: "")
        }
    }

    private fun updateCells() {
        cells.forEachIndexed { index, cell ->
            val camera = cameraAt(index)
            if (camera == null) {
                cell.label.visibility = View.GONE
                cell.box.background = null
                return@forEachIndexed
            }
            cell.label.visibility = View.VISIBLE
            cell.label.text = if (camera.online) {
                "${camera.id} · ${camera.title}"
            } else {
                "${camera.id} · ${camera.title}（${getString(R.string.camera_offline)}）"
            }
            cell.label.setTextColor(
                ContextCompat.getColor(
                    this,
                    if (camera.online) R.color.text_primary else R.color.warn
                )
            )
            cell.box.background = ContextCompat.getDrawable(
                this,
                if (index == selected && layout == MODE_WALL) R.drawable.bg_zone_active else R.drawable.bg_zone_idle
            )
        }
    }

    /* ---------------- 遥控器 ---------------- */

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
            // 远程被控时锁定展示操作（【返回】豁免——正常退出操作，v6：退出取代取消控制）
            if (ControlChannel.interceptKeyLocked(event.keyCode, this)) return true
            keyHintShower()
            when (event.keyCode) {
                KeyEvent.KEYCODE_BACK -> {
                    finish()
                    return true
                }
                KeyEvent.KEYCODE_MENU, KeyEvent.KEYCODE_INFO, KeyEvent.KEYCODE_BUTTON_Y -> {
                    showControlMenu()
                    return true
                }
                KeyEvent.KEYCODE_DPAD_UP -> return moveSelection(-1, 0)
                KeyEvent.KEYCODE_DPAD_DOWN -> return moveSelection(1, 0)
                KeyEvent.KEYCODE_DPAD_LEFT -> return moveSelection(0, -1)
                KeyEvent.KEYCODE_DPAD_RIGHT -> return moveSelection(0, 1)
                KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> {
                    toggleZoom()
                    return true
                }
            }
        }
        return super.dispatchKeyEvent(event)
    }

    /** 单画面时方向键切换上一路/下一路；3×3 时在格间移动并跳过品牌格/空位 */
    private fun moveSelection(rowDelta: Int, colDelta: Int): Boolean {
        if (cameras.isEmpty()) return true
        val selectable = selectableIndices()
        if (selectable.isEmpty()) return true

        if (layout == MODE_SINGLE) {
            val step = if (rowDelta + colDelta >= 0) 1 else -1
            val at = selectable.indexOf(selected).let { if (it < 0) 0 else it }
            selected = selectable[(at + step + selectable.size) % selectable.size]
            startStreams()
            Toast.makeText(
                this,
                getString(R.string.camera_switched, cameraAt(selected)?.title ?: ""),
                Toast.LENGTH_SHORT
            ).show()
            return true
        }

        val step = if (rowDelta != 0) rowDelta * WALL_COLS else colDelta
        var next = selected
        while (true) {
            next += step
            if (next < 0 || next >= WALL_CELLS) return true
            // 左右移动不跨行
            if (colDelta != 0 && next / WALL_COLS != selected / WALL_COLS) return true
            if (cameraAt(next) != null) {
                selected = next
                updateCells()
                return true
            }
        }
    }

    /** 确定键：3×3 放大选中画面，单画面退回 3×3；品牌格/空位不放大 */
    private fun toggleZoom() {
        if (cameras.isEmpty()) return
        if (layout == MODE_WALL && cameraAt(selected) == null) return
        layout = if (layout == MODE_WALL) MODE_SINGLE else MODE_WALL
        startStreams()
    }

    private fun showControlMenu() {
        val labels = ArrayList<String>()
        val actions = ArrayList<() -> Unit>()

        labels.add(getString(if (layout == MODE_WALL) R.string.camera_menu_single else R.string.camera_menu_wall))
        actions.add {
            layout = if (layout == MODE_WALL) MODE_SINGLE else MODE_WALL
            startStreams()
        }
        labels.add(getString(R.string.camera_menu_reconnect))
        actions.add {
            startStreams()
            Toast.makeText(this, R.string.camera_reconnecting, Toast.LENGTH_SHORT).show()
        }
        labels.add(getString(R.string.menu_home))
        actions.add { finish() }

        TvDialogs.menu(
            context = this,
            title = getString(R.string.camera_title),
            subtitle = getString(R.string.camera_menu_subtitle, cameras.size),
            items = labels
        ) { index -> actions.getOrNull(index)?.invoke() }.show()
    }

    /** 维护类指令 refresh 的落点：重连全部画面 */
    override fun reloadCurrent() {
        startStreams()
        Toast.makeText(this, R.string.camera_reconnecting, Toast.LENGTH_SHORT).show()
    }

    /* ---------------- 生命周期 ---------------- */

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) UiUtil.applyImmersive(this)
    }

    override fun onResume() {
        super.onResume()
        if (cameras.isNotEmpty() && !streaming) startStreams()
        // 多设备互控：上报画面墙状态（entryId 可能为空——本页无强依赖）
        ControlChannel.reportCamera(intent.getStringExtra(WebDisplayActivity.EXTRA_ENTRY_ID).orEmpty())
    }

    override fun onPause() {
        stopStreams()
        super.onPause()
    }

    override fun onDestroy() {
        destroyed = true
        stopStreams()
        handler.removeCallbacksAndMessages(null)
        io.shutdownNow()
        super.onDestroy()
    }
}
