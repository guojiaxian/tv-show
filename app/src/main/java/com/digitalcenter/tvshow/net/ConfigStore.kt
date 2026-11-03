package com.digitalcenter.tvshow.net

import android.content.Context
import android.util.Log
import com.digitalcenter.tvshow.config.ConfigJson
import com.digitalcenter.tvshow.config.RemoteConfig
import org.json.JSONObject
import java.io.File

/**
 * 本地配置缓存。
 *
 * 作用：服务端不可用（弱网/断网/服务器维护）时仍能正常展示上一次同步到的内容，
 * 同时保存 version/epoch/etag 作为下次增量同步的基准。
 *
 * 写盘采用「临时文件 + rename」的原子方式，避免掉电/进程被杀导致缓存损坏。
 */
class ConfigStore(context: Context) {

    companion object {
        private const val TAG = "ConfigStore"
        private const val FILE_NAME = "server-config.json"
    }

    private val cacheFile = File(context.filesDir, FILE_NAME)
    private val tmpFile = File(context.filesDir, "$FILE_NAME.tmp")

    /** 缓存内容：配置 + 用于条件请求的元信息 */
    data class Cached(val config: RemoteConfig, val etag: String?, val savedAt: Long)

    fun load(): Cached? {
        if (!cacheFile.isFile) return null
        return runCatching {
            val root = JSONObject(cacheFile.readText())
            val configObj = root.optJSONObject("config") ?: return null
            val entries = ConfigJson.parseEntries(configObj.optJSONArray("entries"))
            if (entries.isEmpty()) {
                Log.w(TAG, "缓存中没有有效入口，忽略")
                return null
            }
            Cached(
                config = RemoteConfig(
                    appTitle = configObj.optString("appTitle"),
                    appSubtitle = configObj.optString("appSubtitle", ""),
                    exitConfirm = configObj.optBoolean("exitConfirm", true),
                    exitTip = configObj.optString("exitTip", ""),
                    entries = entries,
                    version = configObj.optLong("version", 0L),
                    epoch = configObj.optLong("epoch", 0L)
                ),
                etag = root.optString("etag", "").ifBlank { null },
                savedAt = root.optLong("savedAt", 0L)
            )
        }.onFailure { Log.w(TAG, "缓存读取失败，按无缓存处理", it) }.getOrNull()
    }

    fun save(config: RemoteConfig, etag: String?): Boolean {
        return runCatching {
            val root = JSONObject().apply {
                put("savedAt", System.currentTimeMillis())
                put("etag", etag ?: "")
                // 序列化统一由 ConfigJson 负责，与解析成对维护（见 ConfigJson.toJson）
                put("config", ConfigJson.toJson(config))
            }
            tmpFile.writeText(root.toString())
            // 先直接 rename 覆盖（POSIX 上 rename 是原子替换）；
            // 旧实现「先 delete 再 rename」既破坏原子性，又在 rename 失败时静默丢缓存。
            if (!tmpFile.renameTo(cacheFile)) {
                // 个别文件系统不支持覆盖式 rename：退化为删除后重命名，但仍需检查结果
                cacheFile.delete()
                if (!tmpFile.renameTo(cacheFile)) {
                    error("缓存文件重命名失败：${tmpFile.absolutePath} → ${cacheFile.absolutePath}")
                }
            }
            true
        }.onFailure { Log.w(TAG, "缓存写入失败", it) }.getOrDefault(false)
    }

    fun clear() {
        runCatching { cacheFile.delete() }
        runCatching { tmpFile.delete() }
    }
}
