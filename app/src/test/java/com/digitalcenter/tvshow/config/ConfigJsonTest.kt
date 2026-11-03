package com.digitalcenter.tvshow.config

import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 缓存 JSON 的读写必须成对：任何字段在序列化后都应能原样解析回来。
 * 历史上漏写 compatTranspile 导致服务端 304 后该字段永久丢失，这里用往返断言兜住。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class ConfigJsonTest {

    @Test
    fun entrySerializationRoundTripsAllFields() {
        val src = DisplayEntry(
            id = "demo-1",
            title = "标题",
            subtitle = "副标题",
            url = "http://example/a?x=1",
            type = ENTRY_TYPE_URL,
            accent = "#112233",
            icon = "storage",
            scale = 110,
            autoFit = false,
            allowInsecureSsl = true,
            compatTranspile = true,
            turboEnabled = false,
            turboIntervalSec = 0.5,
            turboQuality = 85,
            autoLogin = AutoLoginConfig(
                enabled = true,
                username = "u",
                password = "p",
                usernameSelector = "#u",
                passwordSelector = "#p",
                submitSelector = "#s",
                successSelector = "#ok"
            )
        )
        val back = ConfigJson.parseEntry(ConfigJson.toJson(src))
        assertEquals(src, back)
    }

    @Test
    fun configSerializationKeepsVersionEpochAndEntries() {
        val cfg = RemoteConfig(
            appTitle = "标题",
            appSubtitle = "副标题",
            exitConfirm = false,
            exitTip = "退出提示",
            entries = listOf(
                DisplayEntry(id = "a", title = "A", subtitle = "", url = "http://example/a"),
                DisplayEntry(id = "b", title = "B", subtitle = "", url = "http://example/b")
            ),
            version = 42L,
            epoch = 7L
        )
        val back = ConfigJson.parseConfig(ConfigJson.toJson(cfg))
        assertEquals(42L, back.version)
        assertEquals(7L, back.epoch)
        assertEquals(listOf("a", "b"), back.entries.map { it.id })
        assertEquals("标题", back.appTitle)
        assertEquals(false, back.exitConfirm)
    }
}
