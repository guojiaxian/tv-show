package com.digitalcenter.tvshow.net

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean

/**
 * MJPEG 拉流器：在独立线程读取 `multipart/x-mixed-replace` 流，
 * 按 JPEG 的帧标记（SOI = FFD8 / EOI = FFD9）切出单帧，解码后回主线程回调。
 *
 * 采用「不解析 multipart 头、只扫 JPEG 标记」的方式：各厂 ffmpeg/摄像头的
 * boundary 与头部写法不一，而 JPEG 的 SOI/EOI 是稳定的，扫标记最简单可靠。
 *
 * 内存：解码复用同一块 [Bitmap]（[BitmapFactory.Options.inBitmap]）+ RGB_565，
 * 避免 10fps 长跑时每帧新分配几 MB 触发频繁 GC 导致画面卡顿。
 *
 * 用法：`start()` 拉流，`stop()` 断开（会关闭连接，读取线程随即退出）。
 */
class MjpegReader(
    private val url: String,
    private val listener: Listener
) {

    interface Listener {
        /** 解码出的一帧（主线程回调；同一 [MjpegReader] 的帧会复用同一 Bitmap 对象） */
        fun onFrame(bitmap: Bitmap)

        /** 流结束或出错（主线程回调）；上层据此延时重连 */
        fun onClosed(reason: String?)
    }

    companion object {
        private const val TAG = "MjpegReader"
        private const val CONNECT_TIMEOUT_MS = 6000
        private const val READ_TIMEOUT_MS = 20000

        /** 单帧上限，防止异常流把内存吃光 */
        private const val MAX_FRAME_BYTES = 4 * 1024 * 1024
        private const val SOI_0 = 0xFF
        private const val SOI_1 = 0xD8
        private const val EOI_1 = 0xD9
    }

    private val running = AtomicBoolean(false)
    private val mainHandler = Handler(Looper.getMainLooper())

    @Volatile
    private var connection: HttpURLConnection? = null

    @Volatile
    private var reusable: Bitmap? = null

    /**
     * 主线程尚未消费上一帧时置 true：此时新解码的帧直接丢弃，
     * 避免 10fps 多路流把主线程消息队列堆满、画面越拖越滞后。
     */
    @Volatile
    private var framePending = false

    private var thread: Thread? = null

    val isRunning: Boolean get() = running.get()

    fun start() {
        if (!running.compareAndSet(false, true)) return
        reusable = null
        framePending = false
        thread = Thread({ readLoop() }, "mjpeg").apply {
            isDaemon = true
            start()
        }
    }

    fun stop() {
        if (!running.compareAndSet(true, false)) return
        // 关掉连接让阻塞中的 read() 立刻抛错返回，无需等待读超时
        runCatching { connection?.disconnect() }
        framePending = false
        thread = null
    }

    /* ---------------- 拉流线程 ---------------- */

    private fun readLoop() {
        var reason: String? = null
        try {
            val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                connectTimeout = CONNECT_TIMEOUT_MS
                readTimeout = READ_TIMEOUT_MS
                useCaches = false
                setRequestProperty("Accept", "multipart/x-mixed-replace, image/jpeg")
                setRequestProperty("Connection", "close")
            }
            connection = conn
            val code = conn.responseCode
            if (code != HttpURLConnection.HTTP_OK) {
                reason = "HTTP $code"
            } else {
                conn.inputStream.use { scanFrames(it) }
            }
        } catch (e: Exception) {
            reason = e.message ?: e.javaClass.simpleName
            if (running.get()) Log.w(TAG, "拉流中断：$reason")
        } finally {
            connection = null
            val wasRunning = running.getAndSet(false)
            if (wasRunning) mainHandler.post { listener.onClosed(reason) }
        }
    }

    /** 逐字节扫 SOI/EOI，攒出一帧就解码 */
    private fun scanFrames(input: InputStream) {
        val stream = BufferedInputStream(input, 64 * 1024)
        val frame = ByteArrayOutputStream(256 * 1024)
        val buffer = ByteArray(16 * 1024)
        var inFrame = false
        var prev = -1

        while (running.get()) {
            val read = stream.read(buffer)
            if (read < 0) break
            for (i in 0 until read) {
                val b = buffer[i].toInt() and 0xFF
                if (!inFrame) {
                    if (prev == SOI_0 && b == SOI_1) {
                        inFrame = true
                        frame.reset()
                        frame.write(SOI_0)
                        frame.write(SOI_1)
                    }
                } else {
                    frame.write(b)
                    if (prev == SOI_0 && b == EOI_1) {
                        deliver(frame.toByteArray())
                        frame.reset()
                        inFrame = false
                    } else if (frame.size() > MAX_FRAME_BYTES) {
                        frame.reset()
                        inFrame = false
                    }
                }
                prev = b
            }
        }
    }

    /** 解码并在主线程回调；复用上一帧的 Bitmap 以减少分配 */
    private fun deliver(bytes: ByteArray) {
        if (!running.get() || framePending) return
        val bitmap = decode(bytes) ?: return
        framePending = true
        mainHandler.post {
            try {
                if (running.get()) listener.onFrame(bitmap)
            } finally {
                // 主线程消费完才允许投递下一帧
                framePending = false
            }
        }
    }

    private fun decode(bytes: ByteArray): Bitmap? {
        val options = BitmapFactory.Options().apply {
            inMutable = true
            inPreferredConfig = Bitmap.Config.RGB_565
            val cache = reusable
            if (cache != null && !cache.isRecycled) inBitmap = cache
        }
        var bitmap = runCatching {
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
        }.getOrNull()

        if (bitmap == null) {
            // 尺寸变化导致 inBitmap 复用失败时，退化为一次全新解码
            options.inBitmap = null
            bitmap = runCatching {
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
            }.getOrNull()
        }
        if (bitmap != null) reusable = bitmap
        return bitmap
    }
}
