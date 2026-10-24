package com.digitalcenter.tvshow.net

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * 摄像头接口客户端（画面墙专用，客户端只读）。
 *
 * 服务端把 RTSP 转成浏览器可吃的 MJPEG，客户端只负责拉流显示：
 *  - `GET /api/cameras`            → 摄像头清单 + 画面墙 9 格排布
 *  - `GET /cam/wall.mjpg?row=1..3` → 画面墙按**行**合成的一整条 1920×360 画面
 *  - `GET /cam/<id>.mjpg?q=high`   → 单路主码流（1×1 放大时用）
 *
 * 为什么画面墙按行取：浏览器/WebView 对同一域名只并发 6 条 HTTP/1.1 连接，
 * 而 MJPEG 是永不结束的长连接——9 路会占满连接把其余请求永久排队（表现为
 * 随机几格永远黑屏）。按行合成后整面墙只占 3 条连接，还留出余量给接口请求。
 *
 * 为什么排布由服务端下发：墙上有一格是品牌 logo（不占摄像头编号），其余格子
 * 依次往后挪。若两端各自推算「第几格放第几路」，规则一旦不同就会图文错位，
 * 因此统一以服务端 `cells` 为准。
 */
object CameraClient {

    private const val TAG = "CameraClient"

    /** 画面上的一路摄像头 */
    data class CameraInfo(val id: Int, val title: String, val online: Boolean)

    /** 排布中的品牌格：该格服务端发黑帧，logo 由客户端本地资源绘制 */
    const val WALL_LOGO = -1

    /** 排布中的空位 */
    const val WALL_EMPTY = 0

    /** 画面墙数据：摄像头清单 + 9 格排布（正数为摄像头编号，其余见 WALL_LOGO / WALL_EMPTY） */
    data class Wall(val cameras: List<CameraInfo>, val cells: List<Int>)

    /** 拉取摄像头清单与画面墙排布；模块未启用或解析失败时返回空数据 */
    fun fetchWall(serverBaseUrl: String, timeoutMs: Int = 5000): Wall {
        val url = URL("${serverBaseUrl.trimEnd('/')}/api/cameras")
        val conn = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = timeoutMs
            readTimeout = timeoutMs
            setRequestProperty("Accept", "application/json")
            useCaches = false
        }
        try {
            val code = conn.responseCode
            if (code != 200) {
                Log.w(TAG, "摄像头清单返回 HTTP $code")
                return Wall(emptyList(), emptyList())
            }
            val text = conn.inputStream.bufferedReader().use { it.readText() }
            val root = JSONObject(text)
            if (!root.optBoolean("enabled", false)) {
                Log.i(TAG, "服务端未启用摄像头模块")
                return Wall(emptyList(), emptyList())
            }
            val arr = root.optJSONArray("cameras") ?: return Wall(emptyList(), emptyList())
            val out = ArrayList<CameraInfo>(arr.length())
            for (i in 0 until arr.length()) {
                val obj = arr.optJSONObject(i) ?: continue
                val id = obj.optInt("id", 0)
                if (id <= 0) continue
                out.add(
                    CameraInfo(
                        id = id,
                        title = obj.optString("title").trim().ifBlank { "摄像头 $id" },
                        online = obj.optBoolean("online", false)
                    )
                )
            }
            // 老版本服务端不下发 cells 时退化为下标直排，保证画面照常显示
            val cells = parseCells(root.optJSONArray("cells")).ifEmpty { out.map { it.id } }
            return Wall(out, cells)
        } finally {
            conn.disconnect()
        }
    }

    /** `cells` 元素：字符串 'logo' → 品牌格，null → 空位，正数 → 摄像头编号 */
    private fun parseCells(arr: JSONArray?): List<Int> {
        if (arr == null) return emptyList()
        val out = ArrayList<Int>(arr.length())
        for (i in 0 until arr.length()) {
            when (val v = arr.opt(i)) {
                null, JSONObject.NULL -> out.add(WALL_EMPTY)
                is Number -> out.add(v.toInt().coerceAtLeast(WALL_EMPTY))
                is String -> out.add(if (v == "logo") WALL_LOGO else WALL_EMPTY)
                else -> out.add(WALL_EMPTY)
            }
        }
        return out
    }

    /** 画面墙第 row 行（1 起）的合成流地址；gen 用于重连时绕开连接缓存 */
    fun wallRowUrl(serverBaseUrl: String, row: Int, gen: Long): String =
        "${serverBaseUrl.trimEnd('/')}/cam/wall.mjpg?row=$row&t=$gen"

    /** 单路画面流地址；quality=high 用主码流（1×1 放大时更清晰） */
    fun singleUrl(serverBaseUrl: String, id: Int, high: Boolean, gen: Long): String =
        "${serverBaseUrl.trimEnd('/')}/cam/$id.mjpg?q=${if (high) "high" else "low"}&t=$gen"
}
