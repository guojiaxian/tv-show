package com.digitalcenter.tvshow.net

import android.content.Context
import android.util.Log
import com.digitalcenter.tvshow.config.ConfigJson
import com.digitalcenter.tvshow.config.DisplayEntry
import com.digitalcenter.tvshow.config.RemoteConfig
import org.json.JSONArray
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
                put("config", toJson(config))
            }
            tmpFile.writeText(root.toString())
            if (cacheFile.exists()) cacheFile.delete()
            tmpFile.renameTo(cacheFile)
            true
        }.onFailure { Log.w(TAG, "缓存写入失败", it) }.getOrDefault(false)
    }

    fun clear() {
        runCatching { cacheFile.delete() }
        runCatching { tmpFile.delete() }
    }

    private fun toJson(config: RemoteConfig): JSONObject = JSONObject().apply {
        put("appTitle", config.appTitle)
        put("appSubtitle", config.appSubtitle)
        put("exitConfirm", config.exitConfirm)
        put("exitTip", config.exitTip)
        put("version", config.version)
        put("epoch", config.epoch)
        put("entries", JSONArray().apply { config.entries.forEach { put(toJson(it)) } })
    }

    private fun toJson(entry: DisplayEntry): JSONObject = JSONObject().apply {
        put("id", entry.id)
        put("title", entry.title)
        put("subtitle", entry.subtitle)
        put("url", entry.url)
        put("type", entry.type)
        put("accent", entry.accent)
        put("icon", entry.icon)
        put("scale", entry.scale)
        put("autoFit", entry.autoFit)
        put("allowInsecureSsl", entry.allowInsecureSsl)
        // 必须逐字段写全：这里漏写的字段在下次启动读缓存时会回落到默认值，
        // 而服务端此时往往返回 304（版本没变），该字段就永远拿不回来了
        // —— 曾因此导致 compatTranspile 丢失、兼容代理不生效、老内核继续白屏
        put("compatTranspile", entry.compatTranspile)
        // 极速模式 3 字段同样必须写全，否则 304 后永远补不回（同 compatTranspile 教训）
        put("turboEnabled", entry.turboEnabled)
        put("turboIntervalSec", entry.turboIntervalSec)
        put("turboQuality", entry.turboQuality)
        entry.autoLogin?.let { al ->
            put("autoLogin", JSONObject().apply {
                put("enabled", al.enabled)
                put("username", al.username)
                put("password", al.password)
                put("usernameSelector", al.usernameSelector)
                put("passwordSelector", al.passwordSelector)
                put("submitSelector", al.submitSelector)
                put("successSelector", al.successSelector)
            })
        }
    }
}
