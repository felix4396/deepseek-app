package com.example.deepseekchat;

import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.DisplayMetrics;
import android.view.WindowManager;
import android.webkit.WebView;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Read-only, minimal device facts for diagnostics; never reads identifiers or account data. */
@CapacitorPlugin(name = "DiagnosticsDevice")
public class DiagnosticsDevicePlugin extends Plugin {
    private String version(PackageInfo info) {
        if (info == null) return "unknown";
        return info.versionName == null ? "unknown" : info.versionName;
    }
    private long versionCode(PackageInfo info) {
        if (info == null) return 0L;
        return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
    }
    /**
     * 渲染进程死亡 / 自愈记录（Issue #44）。
     *
     * <p>为什么要有这个接口：{@code onRenderProcessGone} 的接管发生在原生层，而诊断日志缓冲
     * 跑在渲染进程里 —— 渲染进程一死那段记忆就没了。{@code MainActivity} 只能先把事件写进
     * {@code SharedPreferences}，渲染进程重建后由这里交回 JS，否则线上分不清「修好了」
     * 和「根本没触发」。只读：不清空，由 JS 侧用时间水位线自己判重。
     */
    @PluginMethod
    public void renderProcessEvents(PluginCall call) {
        try {
            JSArray events = new JSArray();
            for (String line : RenderProcessEventStore.read(getContext())) {
                String[] parts = line.split("\t", -1);
                if (parts.length < 3) continue;
                JSObject item = new JSObject();
                item.put("at", parseAt(parts[0]));
                item.put("event", parts[1]);
                item.put("didCrash", "true".equals(parts[2]));
                item.put("detail", parts.length > 3 ? parts[3] : "");
                events.put(item);
            }
            JSObject out = new JSObject();
            out.put("events", events);
            out.put("source", "RenderProcessEventStore");
            call.resolve(out);
        } catch (Exception error) {
            call.reject("读取渲染进程记录失败", "RENDER_PROCESS_EVENTS_UNAVAILABLE");
        }
    }

    private static long parseAt(String raw) {
        try {
            return Long.parseLong(raw);
        } catch (NumberFormatException error) {
            return 0L;
        }
    }

    @PluginMethod
    public void snapshot(PluginCall call) {
        try {
            JSObject out = new JSObject();
            out.put("androidRelease", Build.VERSION.RELEASE == null ? "unknown" : Build.VERSION.RELEASE);
            out.put("androidSdk", Build.VERSION.SDK_INT);
            out.put("manufacturer", Build.MANUFACTURER == null ? "unknown" : Build.MANUFACTURER);
            out.put("brand", Build.BRAND == null ? "unknown" : Build.BRAND);
            out.put("model", Build.MODEL == null ? "unknown" : Build.MODEL);
            PackageManager pm = getContext().getPackageManager();
            PackageInfo app = pm.getPackageInfo(getContext().getPackageName(), 0);
            out.put("appVersionName", version(app));
            out.put("appVersionCode", versionCode(app));
            android.content.pm.ApplicationInfo appInfo = pm.getApplicationInfo(getContext().getPackageName(), PackageManager.GET_META_DATA);
            String variant = appInfo.metaData == null ? "unknown" : appInfo.metaData.getString("com.example.deepseekchat.ARTIFACT_VARIANT", "unknown");
            out.put("artifactVariant", variant);
            out.put("appSource", "PackageManager");
            String webPackage = "unknown", webVersion = "unknown";
            if (Build.VERSION.SDK_INT >= 26) {
                PackageInfo wi = WebView.getCurrentWebViewPackage();
                if (wi != null) { webPackage = wi.packageName; webVersion = version(wi); }
            } else {
                // API <26 has no authoritative current-provider API. Do not guess from installed packages.
                webPackage = "unknown";
                webVersion = "unknown";
            }
            out.put("webviewPackage", webPackage);
            out.put("webviewVersion", webVersion);
            DisplayMetrics dm = getContext().getResources().getDisplayMetrics();
            out.put("density", dm.density);
            out.put("fontScale", getContext().getResources().getConfiguration().fontScale);
            out.put("screenWidth", dm.widthPixels);
            out.put("screenHeight", dm.heightPixels);
            call.resolve(out);
        } catch (Exception error) {
            call.reject("读取设备信息失败", "DEVICE_INFO_UNAVAILABLE");
        }
    }
}
