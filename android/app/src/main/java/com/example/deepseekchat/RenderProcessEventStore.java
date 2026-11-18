package com.example.deepseekchat;

import android.content.Context;
import android.content.SharedPreferences;
import java.util.ArrayList;
import java.util.List;

/**
 * 渲染进程事件落盘（诊断用）。
 *
 * <p>为什么必须落盘：{@code onRenderProcessGone} 的接管发生在原生层，而诊断日志
 * （{@code src/services/diagnostics}）跑在 WebView 里 —— 渲染进程一死，JS 侧那段记忆
 * 就一起没了。只能先把「死亡 / 自愈」这件事写到 {@link SharedPreferences}，等新的
 * 渲染进程起来后由 {@link DiagnosticsDevicePlugin#renderProcessEvents} 交回 JS，
 * 否则线上永远分不清「修好了」和「根本没触发」。
 *
 * <p>存储格式：一行一条，制表符分隔 {@code at \t event \t didCrash \t detail}，
 * 只保留最近 {@link #MAX_EVENTS} 条（诊断只关心最近几次，不需要无限增长）。
 */
public final class RenderProcessEventStore {

    static final String PREFS = "deepseek-native-events";
    static final String KEY_EVENTS = "render_process_events";
    /** 环形保留条数：超过就丢最旧的。 */
    static final int MAX_EVENTS = 5;
    /** detail 里不允许出现制表符/换行（会破坏行格式）。 */
    private static final int MAX_DETAIL = 160;

    private RenderProcessEventStore() {}

    /** 追加一条事件。任何异常都不许外抛：这条路径本身是崩溃兜底。 */
    static void append(Context context, String event, boolean didCrash, String detail) {
        if (context == null || event == null) {
            return;
        }
        try {
            SharedPreferences prefs = prefs(context);
            List<String> lines = split(prefs.getString(KEY_EVENTS, ""));
            lines.add(System.currentTimeMillis() + "\t" + event + "\t" + didCrash + "\t" + clean(detail));
            while (lines.size() > MAX_EVENTS) {
                lines.remove(0);
            }
            prefs.edit().putString(KEY_EVENTS, join(lines)).apply();
        } catch (RuntimeException ignored) {
            // 落盘失败不影响自愈：返回 true 阻止系统杀进程优先级更高。
        }
    }

    /** 读出全部事件行（最旧 -> 最新）。 */
    static List<String> read(Context context) {
        if (context == null) {
            return new ArrayList<>();
        }
        try {
            return split(prefs(context).getString(KEY_EVENTS, ""));
        } catch (RuntimeException error) {
            return new ArrayList<>();
        }
    }

    /** 清空（JS 侧消费完之后调用，避免同一条记录每次启动都重复上报）。 */
    static void clear(Context context) {
        if (context == null) {
            return;
        }
        try {
            prefs(context).edit().remove(KEY_EVENTS).apply();
        } catch (RuntimeException ignored) {
            // 同上：诊断清不掉不影响主流程。
        }
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static List<String> split(String raw) {
        List<String> out = new ArrayList<>();
        if (raw == null || raw.length() == 0) {
            return out;
        }
        int from = 0;
        while (from < raw.length()) {
            int at = raw.indexOf('\n', from);
            if (at < 0) {
                out.add(raw.substring(from));
                break;
            }
            out.add(raw.substring(from, at));
            from = at + 1;
        }
        return out;
    }

    private static String join(List<String> lines) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < lines.size(); i++) {
            if (i > 0) {
                sb.append('\n');
            }
            sb.append(lines.get(i));
        }
        return sb.toString();
    }

    private static String clean(String detail) {
        if (detail == null) {
            return "";
        }
        String flat = detail.replace('\t', ' ').replace('\n', ' ').replace('\r', ' ');
        return flat.length() > MAX_DETAIL ? flat.substring(0, MAX_DETAIL) : flat;
    }
}
