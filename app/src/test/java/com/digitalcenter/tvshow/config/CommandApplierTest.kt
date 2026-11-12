package com.digitalcenter.tvshow.config

import android.app.Activity
import com.digitalcenter.tvshow.net.ControlChannel
import com.digitalcenter.tvshow.ui.MainActivity
import com.digitalcenter.tvshow.ui.MediaDisplayActivity
import com.digitalcenter.tvshow.ui.WebDisplayActivity
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** 互控指令的界面决策：去哪一页、失败是否回首页、何时进入远程被控。 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class CommandApplierTest {

    @Before
    fun resetMode() {
        setLocalMode(true)
        ControlChannel.lastError = null
    }

    @After
    fun clearError() {
        ControlChannel.lastError = null
    }

    /** localMode 只暴露只读属性，单测直接复位底层字段，避免依赖执行顺序。 */
    private fun setLocalMode(value: Boolean) {
        val field = ControlChannel::class.java.getDeclaredField("localMode")
        field.isAccessible = true
        field.setBoolean(ControlChannel, value)
    }

    private fun activity(): Activity =
        Robolectric.buildActivity(Activity::class.java).setup().get()

    private fun lastTarget(activity: Activity): String? =
        shadowOf(activity).nextStartedActivity?.component?.className

    @Test
    fun displayCommandClassification() {
        assertTrue(ControlChannel.isDisplayCommand("show"))
        assertTrue(ControlChannel.isDisplayCommand("rotate"))
        assertTrue(ControlChannel.isDisplayCommand("zone"))
        assertTrue(ControlChannel.isDisplayCommand("home"))
        assertFalse(ControlChannel.isDisplayCommand("refresh"))
        assertFalse(ControlChannel.isDisplayCommand("sync"))
        assertFalse(ControlChannel.isDisplayCommand("turbo"))
        assertFalse(ControlChannel.isDisplayCommand("unknown"))
    }

    @Test
    fun showMissingEntryGoesHomeReportsErrorAndStaysLocal() {
        val activity = activity()
        CommandApplier.apply(activity, "show", JSONObject().put("entryId", "no-such-entry"))
        assertEquals(MainActivity::class.java.name, lastTarget(activity))
        assertNotEquals(null, ControlChannel.lastError)
        // 应用失败时设备实际已回首页，不应进入受控锁定
        assertFalse(ControlChannel.locked)
    }

    @Test
    fun showKnownEntryOpensDisplayAndEntersRemote() {
        val activity = activity()
        CommandApplier.apply(activity, "show", JSONObject().put("entryId", "storage-monitor"))
        assertEquals(WebDisplayActivity::class.java.name, lastTarget(activity))
        assertEquals(null, ControlChannel.lastError)
        assertTrue(ControlChannel.locked)
    }

    @Test
    fun homeGoesHomeAndEntersRemote() {
        val activity = activity()
        CommandApplier.apply(activity, "home", JSONObject())
        assertEquals(MainActivity::class.java.name, lastTarget(activity))
        assertTrue(ControlChannel.locked)
    }

    @Test
    fun refreshCallsReloadableWithoutChangingMode() {
        val activity = Robolectric.buildActivity(FakeReloadable::class.java).setup().get()
        CommandApplier.apply(activity, "refresh", JSONObject())
        assertEquals(1, activity.reloads)
        assertFalse(ControlChannel.locked)
        assertEquals(null, ControlChannel.lastError)
    }

    @Test
    fun mediaCommandOpensMediaDisplayAndEntersRemote() {
        val activity = activity()
        CommandApplier.apply(
            activity, "media",
            JSONObject().put("mediaId", "m-abc123").put("intervalSec", 15)
        )
        assertEquals(MediaDisplayActivity::class.java.name, lastTarget(activity))
        assertEquals(null, ControlChannel.lastError)
        assertTrue(ControlChannel.locked)
    }

    @Test
    fun unknownCommandReportsErrorAndStaysLocal() {
        val activity = activity()
        CommandApplier.apply(activity, "hologram", JSONObject())
        // 旧 APK 收到新版本指令（如素材上墙）时如实上报，便于控制台提示升级
        assertNotEquals(null, ControlChannel.lastError)
        assertFalse(ControlChannel.locked)
    }

    @Test
    fun turboUpdatesLocalSettingWithoutChangingMode() {
        val activity = activity()
        CommandApplier.apply(activity, "turbo", JSONObject().put("enabled", true))
        assertTrue(LocalSettings.turbo(activity).enabled)
        assertFalse(ControlChannel.locked)

        CommandApplier.apply(activity, "turbo", JSONObject().put("enabled", false))
        assertFalse(LocalSettings.turbo(activity).enabled)
        assertFalse(ControlChannel.locked)
        assertEquals(null, ControlChannel.lastError)
    }

    /** 可刷新画面的 Activity（refresh 指令的落点） */
    class FakeReloadable : Activity(), CommandApplier.Reloadable {
        var reloads = 0
        override fun reloadCurrent() {
            reloads++
        }
    }
}
