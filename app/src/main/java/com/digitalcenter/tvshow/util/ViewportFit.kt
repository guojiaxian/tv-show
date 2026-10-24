package com.digitalcenter.tvshow.util

import android.content.Context
import android.util.Log
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * 把 WebView 的 **CSS 视口**强制成固定宽度（大屏统一按 1920×1080 布局）。
 *
 * 为什么需要它：
 * 服务端那些大屏页面全是按 1920×1080 设计的响应式页面，实际布局完全取决于 CSS 视口宽度：
 *  - 视口给到 1920 → 完整桌面布局，正好铺满电视；
 *  - 视口只有 960/980（电视上报 2 倍密度时的常见结果）→ 页面按窄屏重排，
 *    标题、图表被放大（存储集群页「被放大」），虚拟化页则把舞台缩到半屏（只剩左上角）。
 *
 * 做法：`useWideViewPort=false`（忽略页面自带的 viewport meta）+ `setInitialScale(p)`，
 * 让布局宽度 = 控件像素宽 / (dpr × p/100)，反解出需要的 p：
 *
 *     p = 100 × 控件像素宽 / (dpr × 目标 CSS 宽)
 *
 * 其中 dpr 是 WebView 真实上报的 devicePixelRatio。密度重写（用
 * createConfigurationContext 改 densityDpi）在部分电视固件上并不生效，
 * 因此这里不假设 dpr，而是**用实测的 innerWidth 反推并持久化一个密度因子**：
 *
 *     dpr = 100 × 控件像素宽 / (实测 innerWidth × 当前 p)
 *     因子 = dpr / 该 WebView 名义密度
 *
 * 因子与「哪台电视」有关，与具体页面无关，因此存在本地、跨页面/跨启动复用；
 * 首次打开若视口不对，校准一次并重载即可收敛，之后每次加载都直接命中。
 */
object ViewportFit {

    private const val TAG = "ViewportFit"
    private const val PREF = "tvshow_viewport"
    private const val KEY_FACTOR = "density_factor"

    /** setInitialScale 允许的百分比范围（100 = 不缩放） */
    const val MIN_PERCENT = 10
    const val MAX_PERCENT = 400

    private const val FACTOR_MIN = 0.05f
    private const val FACTOR_MAX = 8f

    /** 视口偏差超过该比例就认为需要校准 */
    const val TOLERANCE = 0.02f

    /** 用于读取真实视口的探测脚本，返回 "innerWidth,innerHeight,dpr,screenWidth,screenHeight" */
    const val PROBE_SCRIPT =
        "(function(){try{return window.innerWidth+','+window.innerHeight+','+" +
            "window.devicePixelRatio+','+screen.width+','+screen.height;}catch(e){return '';}})()"

    /**
     * 修补旧内核的 `100vh` 解析错误。
     *
     * 现场电视（Chrome 66）在「缩放视口」下把 `100vh` 解析成**未缩放的视口高度**
     * （约 540，等于 screen.height），而 `window.innerHeight` 是正确的 1080。
     * 于是 `.app{min-height:100vh}` 这类全高骨架失效，整条 flex 链退化成内容高度，
     * 页面只渲染在上半屏、下半屏留白（大屏页与分区展示都会中招）。
     *
     * 做法：先用探针测出 `100vh` 的真实解析值，与 innerHeight 偏差超过 5 个百分点才启动修补；
     * 然后从 body 起沿「最高的可见子元素」链下行（最多 6 层），把 computed
     * min-height/height 恰好等于坏值（正负 3px）且未设过内联高度的元素改写成 `Hpx`。
     * 返回改写的元素个数；100vh 正常或页面已铺满时返回 0，不做任何改动。
     */
    const val FILL_SCRIPT = """
(function(){
  try{
    var H = window.innerHeight || document.documentElement.clientHeight || 0;
    if(!H) return 0;
    var b = document.body; if(!b) return 0;
    var p = document.createElement('div');
    p.style.cssText = 'position:absolute;left:-99999px;top:0;width:1px;height:100vh;';
    b.appendChild(p);
    var vh = p.getBoundingClientRect().height;
    if(p.parentNode) p.parentNode.removeChild(p);
    if(!vh || Math.abs(vh - H) <= H * 0.05) return 0;
    function near(x){ return x > 0 && Math.abs(x - vh) <= 3; }
    function kids(n){
      var a = [], c = n.children, i;
      for(i = 0; i < c.length; i++){
        var e = c[i], s = window.getComputedStyle(e);
        if(s.display === 'none' || s.visibility === 'hidden') continue;
        if(s.position === 'fixed' || s.position === 'absolute') continue;
        var r = e.getBoundingClientRect();
        if(r.width < 20 || r.height <= 0) continue;
        a.push(e);
      }
      return a;
    }
    var node = b, patched = 0, d;
    for(d = 0; d < 6 && node; d++){
      var list = [node].concat(kids(node)), hit = 0, i, tallest = null, th = -1;
      for(i = 0; i < list.length; i++){
        var el = list[i], cs = window.getComputedStyle(el);
        var mh = parseFloat(cs.minHeight), hh = parseFloat(cs.height);
        if(near(mh) && !el.style.minHeight){ el.style.minHeight = H + 'px'; hit++; continue; }
        if(near(hh) && !el.style.height){ el.style.height = H + 'px'; hit++; continue; }
      }
      patched += hit;
      if(hit) break;
      for(i = 1; i < list.length; i++){
        var r2 = list[i].getBoundingClientRect();
        if(r2.height > th){ th = r2.height; tallest = list[i]; }
      }
      if(!tallest) break;
      node = tallest;
    }
    return patched;
  }catch(e){ return -1; }
})()
"""

    /** 一次页面加载的视口实测值 */
    data class ViewportInfo(
        val innerWidth: Int,
        val innerHeight: Int,
        val dpr: Float,
        val screenWidth: Int,
        val screenHeight: Int
    ) {
        val readable: String
            get() = "视口 ${innerWidth}×${innerHeight} · dpr $dpr · 屏幕 ${screenWidth}×${screenHeight}"
    }

    /** 解析 [PROBE_SCRIPT] 的返回值（evaluateJavascript 会给结果加引号） */
    fun parseProbe(raw: String?): ViewportInfo? {
        val text = raw?.trim()?.trim('"') ?: return null
        if (text.isEmpty()) return null
        val parts = text.split(',')
        if (parts.size < 5) return null
        val w = parts[0].trim().toIntOrNull() ?: return null
        val h = parts[1].trim().toIntOrNull() ?: 0
        val dpr = parts[2].trim().toFloatOrNull() ?: return null
        return ViewportInfo(
            innerWidth = w,
            innerHeight = h,
            dpr = dpr,
            screenWidth = parts[3].trim().toIntOrNull() ?: 0,
            screenHeight = parts[4].trim().toIntOrNull() ?: 0
        )
    }

    /** 该电视的密度因子（WebView 实际 dpr / 名义密度），默认 1 */
    fun factor(context: Context): Float =
        prefs(context).getFloat(KEY_FACTOR, 1f).coerceIn(FACTOR_MIN, FACTOR_MAX)

    fun hasFactor(context: Context): Boolean = prefs(context).contains(KEY_FACTOR)

    /**
     * 计算 setInitialScale 需要的百分比。
     * @param viewPixelWidth WebView 控件的物理像素宽度
     * @param assumedDensity 该 WebView 的名义密度（displayContext 的 density）
     * @param targetCssWidth 目标 CSS 视口宽度（大屏 1920，分区同为大屏标准 1920）
     */
    fun scalePercent(
        context: Context,
        viewPixelWidth: Int,
        assumedDensity: Float,
        targetCssWidth: Int
    ): Int {
        if (viewPixelWidth <= 0 || assumedDensity <= 0f || targetCssWidth <= 0) return 100
        val dpr = (assumedDensity * factor(context)).coerceAtLeast(0.05f)
        val percent = 100f * viewPixelWidth / (dpr * targetCssWidth)
        return percent.roundToInt().coerceIn(MIN_PERCENT, MAX_PERCENT)
    }

    /**
     * 用实测视口校准密度因子。
     * @return 因子是否发生了变化（变化则需要重新计算并重载）
     */
    fun calibrate(
        context: Context,
        viewPixelWidth: Int,
        assumedDensity: Float,
        info: ViewportInfo,
        currentPercent: Int
    ): Boolean {
        if (viewPixelWidth <= 0 || assumedDensity <= 0f || currentPercent <= 0) return false
        if (info.innerWidth <= 0) return false
        // dpr = 控件像素宽 / 布局宽 = 控件像素宽 / (物理宽 / (dpr × p/100)) → 反解
        val dpr = 100f * viewPixelWidth / (info.innerWidth * currentPercent.toFloat())
        if (dpr <= 0f || dpr.isNaN() || dpr.isInfinite()) return false
        val next = (dpr / assumedDensity).coerceIn(FACTOR_MIN, FACTOR_MAX)
        val old = factor(context)
        if (abs(next - old) < 0.02f) return false
        prefs(context).edit().putFloat(KEY_FACTOR, next).apply()
        Log.i(TAG, "密度因子校准：$old → $next（${info.readable}，当前 initialScale=$currentPercent%）")
        return true
    }

    /** 视口宽度是否已达到目标（允许 [TOLERANCE] 偏差） */
    fun matched(info: ViewportInfo, targetCssWidth: Int): Boolean {
        if (info.innerWidth <= 0) return false
        return abs(info.innerWidth - targetCssWidth) <= targetCssWidth * TOLERANCE
    }

    fun snap(context: Context, factor: Float) {
        prefs(context).edit().putFloat(KEY_FACTOR, factor.coerceIn(FACTOR_MIN, FACTOR_MAX)).apply()
    }

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(PREF, Context.MODE_PRIVATE)
}
