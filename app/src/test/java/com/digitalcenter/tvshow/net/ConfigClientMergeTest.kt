package com.digitalcenter.tvshow.net

import com.digitalcenter.tvshow.config.DisplayEntry
import com.digitalcenter.tvshow.config.RemoteConfig
import com.digitalcenter.tvshow.config.SyncSettings
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

/** 增量合并规则：全量替换、304 保持、代次/版本回退拒绝、删除+更新+重排。 */
class ConfigClientMergeTest {

    private val client = ConfigClient(SyncSettings())

    private fun entry(id: String) =
        DisplayEntry(id = id, title = id, subtitle = "", url = "http://example/$id")

    private fun config(vararg ids: String, version: Long = 3L, epoch: Long = 2L) = RemoteConfig(
        appTitle = "标题",
        appSubtitle = "",
        exitConfirm = true,
        exitTip = "",
        entries = ids.map { entry(it) },
        version = version,
        epoch = epoch
    )

    private fun delta(
        version: Long,
        epoch: Long = 2L,
        meta: RemoteConfig? = null,
        upserted: List<DisplayEntry> = emptyList(),
        deletedIds: List<String> = emptyList(),
        order: List<String>? = null
    ) = ConfigClient.FetchOutcome.Delta(version, epoch, meta, upserted, deletedIds, order, null)

    @Test
    fun fullReplacesCurrent() {
        val next = config("x", "y", version = 9L)
        val merged = client.merge(config("a"), ConfigClient.FetchOutcome.Full(next, null))
        assertSame(next, merged)
    }

    @Test
    fun notModifiedKeepsCurrent() {
        val current = config("a")
        assertSame(current, client.merge(current, ConfigClient.FetchOutcome.NotModified))
    }

    @Test
    fun deltaRequiresCurrentAndMatchingEpochAndNewerVersion() {
        assertNull(client.merge(null, delta(version = 4L)))
        assertNull(client.merge(config("a"), delta(version = 4L, epoch = 3L)))
        assertNull(client.merge(config("a", version = 5L), delta(version = 5L)))
        assertNull(client.merge(config("a", version = 6L), delta(version = 4L)))
    }

    @Test
    fun deltaAppliesDeleteUpsertAndOrder() {
        val current = config("a", "b", "c")
        val merged = client.merge(
            current,
            delta(
                version = 4L,
                upserted = listOf(entry("b"), entry("d")),
                deletedIds = listOf("a"),
                order = listOf("c", "b", "d")
            )
        )!!
        assertEquals(listOf("c", "b", "d"), merged.entries.map { it.id })
        assertEquals(4L, merged.version)
        // meta 未下发：标题沿用本地
        assertEquals("标题", merged.appTitle)
    }

    @Test
    fun deltaMetaOverridesOnlyProvidedFields() {
        val meta = RemoteConfig(
            appTitle = "新标题",
            appSubtitle = "新副标题",
            exitConfirm = false,
            exitTip = "",
            entries = emptyList()
        )
        val merged = client.merge(config("a"), delta(version = 4L, meta = meta))!!
        assertEquals("新标题", merged.appTitle)
        assertEquals("新副标题", merged.appSubtitle)
        assertEquals(false, merged.exitConfirm)
        assertEquals("", merged.exitTip)
        assertEquals(listOf("a"), merged.entries.map { it.id })
    }
}
