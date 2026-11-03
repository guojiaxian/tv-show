package com.digitalcenter.tvshow.config

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * 轮询设置。
 *
 * 这是**本机展示策略**，由客户端自己维护（不再来自服务端）：
 * 服务端只提供"有哪些页面可以展示"，由每台电视决定轮播哪些页面、间隔多久。
 */
data class RotationSetting(
    val enabled: Boolean = false,
    /** 每页停留秒数 */
    val intervalSec: Int = DEFAULT_INTERVAL_SEC,
    /** 参与轮询的入口 id，顺序即播放顺序 */
    val items: List<String> = emptyList(),
    /** 本机时钟起点（毫秒）：由它推导当前是第几页，退出重进不会跳页 */
    val startedAt: Long = 0L
)

/** 分区设置：2×2 拼接中的一格；[entryId] 为空表示该格不使用 */
data class ZoneSetting(
    val position: Int,
    val entryId: String = ""
) {
    val hasContent: Boolean get() = entryId.isNotEmpty()
}

/**
 * 极速模式设置：只有本机总开关。
 * 各页面的刷新率 / JPEG 质量 / 是否参与，全部随服务端配置统一下发（见 [DisplayEntry]）。
 */
data class TurboSetting(val enabled: Boolean = false)

/**
 * 客户端本地设置（轮询 + 分区）。
 *
 * 为什么放在客户端：轮询与分区是"这块屏幕怎么展示"的策略，与内容（页面列表）分离；
 * 内容仍由服务端统一维护，展示策略则由每台电视各自决定，互不影响。
 * 数据量很小，用 SharedPreferences 同步读写即可。
 */
object LocalSettings {

    private const val PREF = "tvshow_local_settings"
    private const val KEY_ROTATION = "rotation"
    private const val KEY_ZONES = "zones"
    private const val KEY_TURBO = "turbo"

    /**
     * 进程内缓存：轮询/极速设置只在设置界面或指令里写入，
     * 展示页每加载一页都会读一次，频繁读 SharedPreferences + JSON 解析没有必要。
     * 进程重启或清除应用数据后自然失效；本对象只由本进程写，无跨进程一致性问题。
     */
    @Volatile
    private var rotationCache: RotationSetting? = null
    @Volatile
    private var turboCache: TurboSetting? = null

    /** 极速模式本机总开关（默认关，关闭时一切照旧） */
    fun turbo(context: Context): TurboSetting {
        turboCache?.let { return it }
        val raw = prefs(context).getString(KEY_TURBO, null)
        val parsed = if (raw == null) {
            TurboSetting()
        } else {
            runCatching {
                TurboSetting(JSONObject(raw).optBoolean("enabled", false))
            }.getOrDefault(TurboSetting())
        }
        turboCache = parsed
        return parsed
    }

    fun saveTurbo(context: Context, setting: TurboSetting) {
        val obj = JSONObject().apply { put("enabled", setting.enabled) }
        prefs(context).edit().putString(KEY_TURBO, obj.toString()).apply()
        turboCache = setting
    }

    fun rotation(context: Context): RotationSetting {
        rotationCache?.let { return it }
        val raw = prefs(context).getString(KEY_ROTATION, null)
        val parsed = if (raw == null) {
            RotationSetting()
        } else {
            runCatching {
                val obj = JSONObject(raw)
                RotationSetting(
                    enabled = obj.optBoolean("enabled", false),
                    intervalSec = obj.optInt("intervalSec", DEFAULT_INTERVAL_SEC)
                        .coerceIn(MIN_INTERVAL_SEC, MAX_INTERVAL_SEC),
                    items = obj.optJSONArray("items")?.let { arr ->
                        (0 until arr.length()).mapNotNull { i ->
                            arr.optString(i).takeIf { it.isNotEmpty() }
                        }
                    } ?: emptyList(),
                    startedAt = obj.optLong("startedAt", 0L)
                )
            }.getOrDefault(RotationSetting())
        }
        rotationCache = parsed
        return parsed
    }

    /** 保存轮询设置；[restartClock] 为 true 时把时钟起点重置为当前时刻（从第 1 页重新开始） */
    fun saveRotation(context: Context, setting: RotationSetting, restartClock: Boolean = true) {
        val saved = normalizeRotation(setting, System.currentTimeMillis(), restartClock)
        val obj = JSONObject().apply {
            put("enabled", saved.enabled)
            put("intervalSec", saved.intervalSec)
            put("items", JSONArray().apply { saved.items.forEach { put(it) } })
            put("startedAt", saved.startedAt)
        }
        prefs(context).edit().putString(KEY_ROTATION, obj.toString()).apply()
        rotationCache = saved
    }

    /**
     * 轮询设置归一化：间隔夹取到允许范围、页面去重、按规则确定时钟起点。
     * 抽成纯函数，保存与单测共用同一套规则。
     */
    fun normalizeRotation(setting: RotationSetting, now: Long, restartClock: Boolean): RotationSetting {
        val interval = setting.intervalSec.coerceIn(MIN_INTERVAL_SEC, MAX_INTERVAL_SEC)
        val startedAt = if (restartClock || setting.startedAt <= 0L) now else setting.startedAt
        return RotationSetting(
            enabled = setting.enabled,
            intervalSec = interval,
            items = setting.items.distinct(),
            startedAt = startedAt
        )
    }

    /** 读取分区设置，始终保持 4 格（缺省格为空） */
    fun zones(context: Context): List<ZoneSetting> {
        val raw = prefs(context).getString(KEY_ZONES, null)
        val parsed = raw?.let { text ->
            runCatching {
                val arr = JSONArray(text)
                (0 until arr.length()).mapNotNull { i ->
                    val obj = arr.optJSONObject(i) ?: return@mapNotNull null
                    val position = obj.optInt("position", -1)
                    if (position < 0 || position >= ZONE_COUNT) return@mapNotNull null
                    ZoneSetting(position, obj.optString("entryId", ""))
                }
            }.getOrDefault(emptyList())
        } ?: emptyList()
        return (0 until ZONE_COUNT).map { pos ->
            parsed.firstOrNull { it.position == pos } ?: ZoneSetting(pos)
        }
    }

    fun saveZones(context: Context, zones: List<ZoneSetting>) {
        val arr = JSONArray().apply {
            zones.sortedBy { it.position }.forEach { zone ->
                put(JSONObject().apply {
                    put("position", zone.position)
                    put("entryId", zone.entryId)
                })
            }
        }
        prefs(context).edit().putString(KEY_ZONES, arr.toString()).apply()
    }

    /**
     * 轮询序列对应的入口；服务端删掉的页面会被自动跳过。
     *
     * 这里不看 [RotationSetting.enabled]：该开关只决定"开机是否自动进入轮询播放"，
     * 用户从首页【菜单】→「轮询展示」显式进入时始终应当播放。
     * 画面墙（type=camera）通过服务端 /cam/view 画面墙网页同样参与轮询。
     */
    fun rotationEntries(config: RemoteConfig, setting: RotationSetting): List<DisplayEntry> =
        setting.items.mapNotNull { id -> config.entryOf(id) }

    /** 分区（按格位 0..3）对应的入口；该格未配置或页面已被删除时为 null。
     *  画面墙经服务端 /cam/view 页面可在 WebView 格内嵌播放 */
    fun zoneEntries(config: RemoteConfig, zones: List<ZoneSetting>): List<DisplayEntry?> =
        zones.sortedBy { it.position }.map { zone ->
            if (zone.hasContent) config.entryOf(zone.entryId) else null
        }

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(PREF, Context.MODE_PRIVATE)
}
