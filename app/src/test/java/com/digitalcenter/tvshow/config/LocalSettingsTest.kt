package com.digitalcenter.tvshow.config

import org.junit.Assert.assertEquals
import org.junit.Test

/** 本机展示设置的纯逻辑：保存前的归一化、轮询/分区到入口的映射。 */
class LocalSettingsTest {

    private fun config(vararg ids: String) = RemoteConfig(
        appTitle = "t",
        appSubtitle = "",
        exitConfirm = true,
        exitTip = "",
        entries = ids.map {
            DisplayEntry(id = it, title = it, subtitle = "", url = "http://example/$it")
        },
        version = 1,
        epoch = 1
    )

    @Test
    fun normalizeRotation_clampsIntervalDedupsItemsAndKeepsClock() {
        val now = 1_000L
        val kept = LocalSettings.normalizeRotation(
            RotationSetting(
                enabled = true,
                intervalSec = 0,
                items = listOf("a", "a", "b"),
                startedAt = 500L
            ),
            now,
            restartClock = false
        )
        assertEquals(MIN_INTERVAL_SEC, kept.intervalSec)
        assertEquals(listOf("a", "b"), kept.items)
        assertEquals(500L, kept.startedAt)
        assertEquals(true, kept.enabled)
    }

    @Test
    fun normalizeRotation_restartClockOverridesAndClampsUpperBound() {
        val now = 2_000L
        val restarted = LocalSettings.normalizeRotation(
            RotationSetting(intervalSec = 99_999, items = emptyList(), startedAt = 500L),
            now,
            restartClock = true
        )
        assertEquals(MAX_INTERVAL_SEC, restarted.intervalSec)
        assertEquals(now, restarted.startedAt)

        val noClock = LocalSettings.normalizeRotation(
            RotationSetting(startedAt = 0L),
            now,
            restartClock = false
        )
        assertEquals(now, noClock.startedAt)
    }

    @Test
    fun rotationEntries_skipsDeletedPagesAndPreservesOrder() {
        val entries = LocalSettings.rotationEntries(
            config("a", "b", "c"),
            RotationSetting(items = listOf("c", "missing", "a"))
        )
        assertEquals(listOf("c", "a"), entries.map { it.id })
    }

    @Test
    fun zoneEntries_mapsFourSlotsAndNullsForUnsetOrDeleted() {
        val zones = listOf(
            ZoneSetting(0, "a"),
            ZoneSetting(1, ""),
            ZoneSetting(2, "missing"),
            ZoneSetting(3, "b")
        )
        val entries = LocalSettings.zoneEntries(config("a", "b"), zones)
        assertEquals(4, entries.size)
        assertEquals("a", entries[0]?.id)
        assertEquals(null, entries[1])
        assertEquals(null, entries[2])
        assertEquals("b", entries[3]?.id)
    }
}
