# 保留 WebView 中通过反射/注解访问的成员（如果后续添加 @JavascriptInterface 需保留）
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# 保留配置模型类（使用 org.json 手工解析，此处仅做保护，避免被裁剪掉构造方法）
-keep class com.digitalcenter.tvshow.config.** { *; }
