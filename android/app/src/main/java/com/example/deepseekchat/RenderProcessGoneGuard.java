package com.example.deepseekchat;

/**
 * 渲染进程死亡（{@code WebViewClient#onRenderProcessGone}）的接管策略。
 *
 * <p>这个类存在的唯一理由是「必须回 true」：Android / Chromium 只要收到 false（或没人
 * 覆写），就会判定这次渲染进程死亡没有任何 WebView 接管，直接终止宿主进程 ——
 * {@code aw_browser_terminator.cc(112)} 的原话是
 * {@code "wasn't handed by all associated webviews, killing application"}。
 * 因此 {@link #handle(boolean, String)} 无论内部发生什么（重入、post 失败、重建抛异常）
 * 都必须返回 true；恢复动作本身失败只降级成「记一条日志」，绝不把控制权交回系统。
 *
 * <p>本文件**不 import android.\***：线程调度（{@link Dispatcher}）、诊断落盘
 * （{@link Recorder}）、重建动作（{@link Rebuilder}）全部从构造参数注入，于是这套
 * 决策逻辑可以在 JVM 单测里跑（{@code android/app/src/test/.../RenderProcessGoneGuardTest.java}），
 * 不需要设备、不需要模拟器。
 *
 * <p>纯 Java 7 语法（匿名内部类、无 lambda），避免依赖各模块的 compileOptions。
 */
public final class RenderProcessGoneGuard {

    /** 线程调度端口：生产实现用 {@code WebView.post()}，单测里同步执行。 */
    public interface Dispatcher {
        void post(Runnable task);
    }

    /** 诊断端口：生产实现写 logcat + SharedPreferences，单测记录进列表。 */
    public interface Recorder {
        void record(String event, boolean didCrash, String detail);
    }

    /** 恢复动作端口：生产实现整层重建（Activity.recreate），单测里只数调用次数。 */
    public interface Rebuilder {
        void rebuild();
    }

    /** 渲染进程崩溃（didCrash=true）。 */
    public static final String EVENT_CRASH = "webview_render_process_crashed";
    /** 渲染进程被系统回收 / 更新（didCrash=false）。 */
    public static final String EVENT_KILLED = "webview_render_process_killed";
    /** 重建尚未结束时又收到一次回调：只记日志，不重复重建。 */
    public static final String EVENT_IGNORED = "webview_render_process_gone_ignored";
    /** 重建动作失败或被推迟：进程仍然活着（已接管），但界面需要人工重试。 */
    public static final String EVENT_REBUILD_FAILED = "webview_render_process_rebuild_failed";

    private final Dispatcher dispatcher;
    private final Recorder recorder;
    private final Rebuilder rebuilder;

    /** 重入标志：同一次死亡可能在重建完成前再次回调，连环重建会连环崩溃。 */
    private boolean recovering;

    public RenderProcessGoneGuard(Dispatcher dispatcher, Recorder recorder, Rebuilder rebuilder) {
        this.dispatcher = dispatcher;
        this.recorder = recorder;
        this.rebuilder = rebuilder;
    }

    /**
     * 接管一次渲染进程死亡事件。
     *
     * @param didCrash {@code RenderProcessGoneDetail#didCrash()}，true = 崩溃，false = 被系统回收/更新
     * @param detail 仅用于日志的人类可读上下文（可为 null）
     * @return **永远是 true**：false 会让系统杀掉整个宿主进程
     */
    public boolean handle(final boolean didCrash, final String detail) {
        if (recovering) {
            recorder.record(EVENT_IGNORED, didCrash, detail);
            return true;
        }
        recovering = true;
        recorder.record(didCrash ? EVENT_CRASH : EVENT_KILLED, didCrash, detail);
        try {
            dispatcher.post(new Runnable() {
                @Override
                public void run() {
                    try {
                        rebuilder.rebuild();
                    } catch (RuntimeException error) {
                        // recreate() 在 onSaveInstanceState 之后、Activity 正在销毁窗口期会抛
                        // IllegalStateException。此时进程还活着（已接管），只是界面没重建起来。
                        recorder.record(EVENT_REBUILD_FAILED, didCrash, describe(error));
                    } finally {
                        recovering = false;
                    }
                }
            });
        } catch (RuntimeException error) {
            // post 失败（WebView 已 detach / view 没有 handler）：仍然是「已接管」，别把进程交回去。
            recovering = false;
            recorder.record(EVENT_REBUILD_FAILED, didCrash, describe(error));
        }
        return true;
    }

    /** 是否处在「已接管、重建中」的状态。 */
    public boolean isRecovering() {
        return recovering;
    }

    private static String describe(RuntimeException error) {
        return error.getClass().getSimpleName() + ": " + error.getMessage();
    }
}
