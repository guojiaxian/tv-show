package com.digitalcenter.tvshow.net

import android.util.Log
import com.digitalcenter.tvshow.config.ConfigJson
import com.digitalcenter.tvshow.config.DisplayEntry
import com.digitalcenter.tvshow.config.RemoteConfig
import com.digitalcenter.tvshow.config.SyncSettings
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * 从服务端拉取配置。
 *
 * 增量协议：
 *   GET /api/config?since=<本地version>&epoch=<本地epoch>
 *     - 无变更           → 304，返回 [FetchOutcome.NotModified]
 *     - 有变更且增量完整 → 200，返回 [FetchOutcome.Delta]
 *     - 首次/代次变化/版本过旧 → 200，返回 [FetchOutcome.Full]
 * 同时携带 If-None-Match（ETag = "<epoch>-<version>"）作为廉价的前置判断。
 */
class ConfigClient(private val settings: SyncSettings) {

    companion object {
        private const val TAG = "ConfigClient"
        private const val MAX_ATTEMPTS = 3
    }

    /** 拉取结果 */
    sealed class FetchOutcome {
        /** 本地已是最新，无需处理 */
        object NotModified : FetchOutcome()

        /** 服务端返回全量（含 version/epoch） */
        data class Full(val config: RemoteConfig, val etag: String?) : FetchOutcome()

        /** 服务端返回增量 */
        data class Delta(
            val version: Long,
            val epoch: Long,
            val meta: RemoteConfig?,
            val upserted: List<DisplayEntry>,
            val deletedIds: List<String>,
            /** 顺序发生整体变化时下发的完整 id 顺序；null 表示顺序未变 */
            val order: List<String>?,
            val etag: String?
        ) : FetchOutcome()
    }

    class SyncException(message: String, cause: Throwable? = null) : IOException(message, cause)

    /**
     * 执行一次拉取。失败会按指数退避重试 [MAX_ATTEMPTS] 次后抛出异常，
     * 由上层决定回退到本地缓存。
     *
     * 传 [local] = null 即表示“无本地基准”，服务端会直接返回全量。
     */
    fun fetch(serverBaseUrl: String, local: RemoteConfig?): FetchOutcome {
        val base = serverBaseUrl.trimEnd('/')
        val since = local?.version ?: 0L
        val epoch = local?.epoch ?: 0L
        val etag = if (local != null && local.version > 0) "\"$epoch-$since\"" else null

        var lastError: Exception? = null
        for (attempt in 1..MAX_ATTEMPTS) {
            try {
                return request(base, since, epoch, etag)
            } catch (e: Exception) {
                lastError = e
                Log.w(TAG, "同步失败（第 $attempt/$MAX_ATTEMPTS 次）：${e.message}")
                if (attempt < MAX_ATTEMPTS) {
                    runCatching { Thread.sleep(400L * (1 shl (attempt - 1))) }
                }
            }
        }
        throw SyncException(lastError?.message ?: "同步失败", lastError)
    }

    private fun request(base: String, since: Long, epoch: Long, etag: String?): FetchOutcome {
        val url = URL("$base/api/config?since=$since&epoch=$epoch")
        val conn = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = settings.connectTimeoutMs
            readTimeout = settings.readTimeoutMs
            setRequestProperty("Accept", "application/json")
            etag?.let { setRequestProperty("If-None-Match", it) }
            useCaches = false
        }
        try {
            val code = conn.responseCode
            val responseEtag = conn.getHeaderField("ETag")
            when {
                code == HttpURLConnection.HTTP_NOT_MODIFIED -> return FetchOutcome.NotModified
                code == 200 -> {
                    val text = conn.inputStream.bufferedReader().use { it.readText() }
                    val root = JSONObject(text)
                    val fullObj = root.optJSONObject("full")
                    if (fullObj != null) {
                        val cfg = ConfigJson.parseConfig(fullObj).copy(
                            version = root.optLong("version", 0L),
                            epoch = root.optLong("epoch", 0L)
                        )
                        return FetchOutcome.Full(cfg, responseEtag)
                    }
                    val meta = root.optJSONObject("meta")?.let { m ->
                        // 增量 meta 只带部分字段，其余留给合并阶段沿用本地值
                        ConfigJson.parseConfig(m).copy(entries = emptyList())
                    }
                    return FetchOutcome.Delta(
                        version = root.optLong("version", 0L),
                        epoch = root.optLong("epoch", 0L),
                        meta = meta,
                        upserted = ConfigJson.parseEntries(root.optJSONArray("upserted")),
                        deletedIds = readStringArray(root.optJSONArray("deletedIds")),
                        order = root.optJSONArray("order")?.let { readStringArray(it) },
                        etag = responseEtag
                    )
                }
                else -> throw SyncException("服务端返回 HTTP $code")
            }
        } finally {
            conn.disconnect()
        }
    }

    private fun readStringArray(arr: JSONArray?): List<String> {
        if (arr == null) return emptyList()
        val out = ArrayList<String>(arr.length())
        for (i in 0 until arr.length()) {
            val s = arr.optString(i)
            if (s.isNotEmpty()) out.add(s)
        }
        return out
    }

    /**
     * 将拉取结果合并到本地配置。
     *
     * 返回 null 表示当前结果无法安全合并（版本回退/代次不一致），调用方应改为全量重拉。
     */
    fun merge(current: RemoteConfig?, outcome: FetchOutcome): RemoteConfig? {
        when (outcome) {
            is FetchOutcome.NotModified -> return current
            is FetchOutcome.Full -> return outcome.config
            is FetchOutcome.Delta -> {
                if (current == null) return null
                // 代次变化 → 必须全量，避免基于过期状态增量合并
                if (outcome.epoch != current.epoch) return null
                // 版本必须单调递增
                if (outcome.version <= current.version) return null

                val merged = LinkedHashMap<String, DisplayEntry>(current.entries.size + outcome.upserted.size)
                current.entries.forEach { merged[it.id] = it }
                outcome.deletedIds.forEach { merged.remove(it) }
                outcome.upserted.forEach { merged[it.id] = it }

                // 服务端下发了完整顺序 → 整体重排（Map 的 put 不会改变已有键的位置）
                val ordered = outcome.order?.let { ids ->
                    val out = ArrayList<DisplayEntry>(merged.size)
                    ids.forEach { id -> merged.remove(id)?.let { out.add(it) } }
                    // 兜底：万一有未列出的条目（理论上不会），追加在后面，避免丢数据
                    out.addAll(merged.values)
                    out
                } ?: merged.values.toList()

                val meta = outcome.meta
                return RemoteConfig(
                    appTitle = meta?.appTitle ?: current.appTitle,
                    appSubtitle = meta?.appSubtitle ?: current.appSubtitle,
                    exitConfirm = meta?.exitConfirm ?: current.exitConfirm,
                    exitTip = meta?.exitTip ?: current.exitTip,
                    entries = ordered,
                    version = outcome.version,
                    epoch = outcome.epoch
                )
            }
        }
    }
}
