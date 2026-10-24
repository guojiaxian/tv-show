package com.digitalcenter.tvshow.net

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.digitalcenter.tvshow.config.BootstrapConfig
import com.digitalcenter.tvshow.config.ConfigLoader
import com.digitalcenter.tvshow.config.RemoteConfig
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 配置仓库：客户端取数的唯一入口。
 *
 * 设计要点：
 *  - [snapshot] **同步返回**当前生效配置（内存 → 缓存文件 → 包内兜底），
 *    因此首屏渲染完全不等待网络，启动加载时间可控；
 *  - [syncNow] 在后台线程做增量同步，有变更才回调刷新界面；
 *  - 同步失败时保留缓存内容并把状态置为 [SyncState.OFFLINE]，不清空已有数据；
 *  - 客户端只读：这里没有任何写服务端的接口。
 */
object ConfigRepository {

    private const val TAG = "ConfigRepo"

    private const val PREF_NAME = "tvshow_config"
    private const val KEY_CACHE_SCHEMA = "cache_schema"

    /**
     * 本地缓存结构版本。
     *
     * 解析/写入规则发生变化（例如新增字段）时**必须递增**：旧缓存里缺字段，
     * 而服务端此时版本号往往没变、增量同步返回 304，坏数据就永远修不回来
     * —— 曾因此出现「首页少了机房监控入口」，重启与同步都无解。
     * 版本不一致时直接删除旧缓存，下一次同步会以 since=0 全量重拉。
     */
    private const val CACHE_SCHEMA = 3

    enum class SyncState {
        /** 本地兜底内容（从未成功同步过） */
        FALLBACK,

        /** 正在同步 */
        SYNCING,

        /** 同步完成且内容有变化 */
        UPDATED,

        /** 同步完成，内容无变化 */
        UP_TO_DATE,

        /** 同步失败，继续使用缓存内容 */
        OFFLINE
    }

    data class SyncStatus(
        val state: SyncState,
        val config: RemoteConfig,
        val message: String? = null
    )

    private val executor = Executors.newSingleThreadExecutor { r ->
        Thread(r, "config-sync").apply { isDaemon = true }
    }
    private val mainHandler = Handler(Looper.getMainLooper())
    private val syncing = AtomicBoolean(false)

    @Volatile
    private var bootstrap: BootstrapConfig? = null

    @Volatile
    private var store: ConfigStore? = null

    @Volatile
    private var current: RemoteConfig? = null

    @Volatile
    private var etag: String? = null

    @Volatile
    private var lastSyncAt = 0L

    @Volatile
    private var lastState: SyncState = SyncState.FALLBACK

    @Volatile
    private var lastError: String? = null

    private var scheduler: ScheduledExecutorService? = null

    /** 幂等初始化；建议在 Application 或首页 onCreate 调用 */
    @Synchronized
    fun init(context: Context) {
        if (current != null) return
        val appContext = context.applicationContext
        val boot = ConfigLoader.loadBootstrap(appContext)
        bootstrap = boot
        val configStore = ConfigStore(appContext)
        store = configStore

        // 缓存结构版本不一致 → 作废旧缓存。
        // 旧缓存可能缺字段（如 type），此时服务端往往返回 304（版本没变），
        // 坏数据永远修不回来；清掉后下一次同步会以 since=0 全量重拉。
        val prefs = appContext.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
        val cachedSchema = prefs.getInt(KEY_CACHE_SCHEMA, 0)
        if (cachedSchema != CACHE_SCHEMA) {
            Log.i(TAG, "缓存结构升级（$cachedSchema → $CACHE_SCHEMA），作废旧缓存并全量重拉")
            configStore.clear()
            prefs.edit().putInt(KEY_CACHE_SCHEMA, CACHE_SCHEMA).apply()
        }

        val cached = configStore.load()
        current = cached?.config
            ?: boot.fallback.also {
                Log.i(TAG, "无可用缓存，使用包内兜底内容（${boot.fallback.entries.size} 个入口）")
            }
        etag = cached?.etag
        lastState = if (cached != null) SyncState.UP_TO_DATE else SyncState.FALLBACK

        Log.i(
            TAG,
            "初始化完成：server=${boot.serverBaseUrl} 来源=${if (cached != null) "本地缓存" else "包内兜底"} " +
                "version=${current?.version ?: 0} 条目=${current?.entries?.size ?: 0}"
        )

        startPeriodicSyncIfNeeded(boot)
    }

    /** 当前生效配置，同步返回，绝不阻塞 */
    fun snapshot(): RemoteConfig =
        current ?: bootstrap?.fallback ?: ConfigLoader.defaultConfig()

    fun serverBaseUrl(): String = bootstrap?.serverBaseUrl ?: ConfigLoader.DEFAULT_SERVER_BASE_URL

    fun state(): SyncState = lastState

    fun lastError(): String? = lastError

    fun lastSyncAt(): Long = lastSyncAt

    /**
     * 触发一次同步。
     *
     * @param force true 时忽略最小间隔限制（手动刷新场景）
     * @param callback 在**主线程**回调；仅当状态变化或内容更新时触发
     */
    fun syncNow(force: Boolean = false, callback: ((SyncStatus) -> Unit)? = null) {
        val boot = bootstrap ?: run {
            callback?.let { mainHandler.post { it(SyncStatus(SyncState.FALLBACK, snapshot(), "尚未初始化")) } }
            return
        }

        val now = System.currentTimeMillis()
        if (!force && now - lastSyncAt < boot.sync.minSyncIntervalMs) {
            Log.d(TAG, "距上次同步不足 ${boot.sync.minSyncIntervalMs}ms，跳过")
            callback?.let { mainHandler.post { it(SyncStatus(lastState, snapshot(), "刚刚已同步")) } }
            return
        }
        if (!syncing.compareAndSet(false, true)) {
            Log.d(TAG, "已有同步在进行，跳过本次")
            callback?.let { mainHandler.post { it(SyncStatus(lastState, snapshot(), "同步进行中")) } }
            return
        }

        val before = snapshot()
        lastState = SyncState.SYNCING
        callback?.let { mainHandler.post { it(SyncStatus(SyncState.SYNCING, before)) } }

        executor.execute {
            var status = SyncStatus(SyncState.SYNCING, before)
            try {
                val client = ConfigClient(boot.sync)
                var outcome = client.fetch(boot.serverBaseUrl, before)
                var merged = client.merge(before, outcome)

                // 增量无法安全合并（首次/代次变化/版本回退）→ 传 null 触发一次全量拉取
                if (merged == null && outcome !is ConfigClient.FetchOutcome.NotModified) {
                    Log.i(TAG, "增量不可用，改为全量拉取")
                    outcome = client.fetch(boot.serverBaseUrl, null)
                    merged = client.merge(null, outcome)
                }

                val newEtag = when (outcome) {
                    is ConfigClient.FetchOutcome.Full -> outcome.etag
                    is ConfigClient.FetchOutcome.Delta -> outcome.etag
                    is ConfigClient.FetchOutcome.NotModified -> etag
                }

                val changed = merged != null && (before.version != merged.version ||
                    before.entries != merged.entries ||
                    before.appTitle != merged.appTitle ||
                    before.appSubtitle != merged.appSubtitle ||
                    before.exitConfirm != merged.exitConfirm)

                if (merged != null) {
                    current = merged
                    etag = newEtag
                    // 有实际变更才落盘，减少写次数
                    if (changed) store?.save(merged, newEtag)
                }
                lastSyncAt = System.currentTimeMillis()
                lastError = null
                lastState = if (changed) SyncState.UPDATED else SyncState.UP_TO_DATE
                status = SyncStatus(lastState, snapshot())
                Log.i(TAG, "同步完成：${if (changed) "内容已更新" else "无变更"} → v${snapshot().version}")
            } catch (e: Exception) {
                lastSyncAt = System.currentTimeMillis()
                lastError = e.message
                lastState = SyncState.OFFLINE
                status = SyncStatus(SyncState.OFFLINE, snapshot(), e.message)
                Log.w(TAG, "同步失败，继续使用本地内容：${e.message}")
            } finally {
                syncing.set(false)
                val finalStatus = status
                callback?.let { mainHandler.post { it(finalStatus) } }
            }
        }
    }

    /** pollIntervalSec > 0 时开启后台定时轮询（默认关闭） */
    @Synchronized
    private fun startPeriodicSyncIfNeeded(boot: BootstrapConfig) {
        val interval = boot.sync.pollIntervalSec
        if (interval <= 0 || scheduler != null) return
        val s = Executors.newSingleThreadScheduledExecutor { r ->
            Thread(r, "config-poll").apply { isDaemon = true }
        }
        s.scheduleWithFixedDelay({ runCatching { syncNow(force = false) } }, interval.toLong(), interval.toLong(), TimeUnit.SECONDS)
        scheduler = s
        Log.i(TAG, "已开启定时轮询：每 ${interval}s 一次")
    }
}
