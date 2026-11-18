package com.example.deepseekchat;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.List;
import org.junit.Test;

/**
 * {@link RenderProcessGoneGuard} 的契约（Issue #44）。
 *
 * <p>这一组断言守的是「返回 true」这条命门：返回 false 就等于告诉 Chromium「这次渲染进程
 * 死亡没有任何 WebView 接管」，它会直接杀掉宿主进程（aw_browser_terminator.cc:112）。
 * 所以下面每条用例，除了验证具体行为，还都要再确认一次返回值是 true。
 *
 * <p>纯 JVM 单测：不碰 android.*，不需要模拟器（{@code ./gradlew testDebugUnitTest}）。
 */
public class RenderProcessGoneGuardTest {

    /** 记录型诊断端口。 */
    private static final class RecordingRecorder implements RenderProcessGoneGuard.Recorder {
        final List<String> events = new ArrayList<>();
        final List<Boolean> crashFlags = new ArrayList<>();
        final List<String> details = new ArrayList<>();

        @Override public void record(String event, boolean didCrash, String detail) {
            events.add(event);
            crashFlags.add(didCrash);
            details.add(detail);
        }
    }

    /** 队列型调度端口：模拟 WebView.post —— 任务必须等到 flush 才在「UI 线程」跑。 */
    private static final class QueueDispatcher implements RenderProcessGoneGuard.Dispatcher {
        final List<Runnable> queue = new ArrayList<>();

        @Override public void post(Runnable task) {
            queue.add(task);
        }

        void flush() {
            List<Runnable> pending = new ArrayList<>(queue);
            queue.clear();
            for (Runnable task : pending) {
                task.run();
            }
        }
    }

    /** 计数型重建端口。 */
    private static final class CountingRebuilder implements RenderProcessGoneGuard.Rebuilder {
        int calls;
        RuntimeException toThrow;

        @Override public void rebuild() {
            calls++;
            if (toThrow != null) {
                throw toThrow;
            }
        }
    }

    private final RecordingRecorder recorder = new RecordingRecorder();
    private final QueueDispatcher dispatcher = new QueueDispatcher();
    private final CountingRebuilder rebuilder = new CountingRebuilder();

    private RenderProcessGoneGuard guard() {
        return new RenderProcessGoneGuard(dispatcher, recorder, rebuilder);
    }

    @Test public void crashIsAlwaysClaimedByReturningTrue() {
        assertTrue("崩溃必须回 true，否则系统杀应用", guard().handle(true, "didCrash=true"));
    }

    @Test public void systemKillIsAlsoClaimed() {
        // didCrash=false 是「被系统回收 / WebView 更新」，同样必须接管，否则一样杀进程。
        assertTrue(guard().handle(false, "didCrash=false"));
    }

    @Test public void crashAndKillAreDistinguishedInDiagnostics() {
        RenderProcessGoneGuard guard = guard();
        guard.handle(true, "didCrash=true,priorityAtExit=1");
        assertEquals(RenderProcessGoneGuard.EVENT_CRASH, recorder.events.get(0));
        assertEquals(Boolean.TRUE, recorder.crashFlags.get(0));
        assertEquals("didCrash=true,priorityAtExit=1", recorder.details.get(0));

        RecordingRecorder second = new RecordingRecorder();
        new RenderProcessGoneGuard(dispatcher, second, rebuilder).handle(false, "didCrash=false");
        assertEquals(RenderProcessGoneGuard.EVENT_KILLED, second.events.get(0));
        assertEquals(Boolean.FALSE, second.crashFlags.get(0));
    }

    @Test public void rebuildIsScheduledInsteadOfRunOnTheCallbackThread() {
        guard().handle(true, "didCrash=true");
        assertEquals("回调线程里不该直接重建，必须 post 到 UI 线程", 0, rebuilder.calls);
        assertEquals(1, dispatcher.queue.size());
        dispatcher.flush();
        assertEquals(1, rebuilder.calls);
    }

    @Test public void reentrantCallbacksDoNotRebuildTwice() {
        RenderProcessGoneGuard guard = guard();
        guard.handle(true, "first");
        assertTrue(guard.isRecovering());
        // 重建还没跑完又来一次回调：只记日志，不能连环重建。
        assertTrue("重入也必须回 true", guard.handle(true, "second"));
        assertEquals(1, dispatcher.queue.size());
        assertEquals(RenderProcessGoneGuard.EVENT_IGNORED, recorder.events.get(1));
        dispatcher.flush();
        assertEquals(1, rebuilder.calls);
        assertFalse(guard.isRecovering());
        // 恢复完成后再死一次，仍然要能重建。
        guard.handle(true, "third");
        dispatcher.flush();
        assertEquals(2, rebuilder.calls);
    }

    @Test public void rebuildFailureStillKeepsTheClaimAndResetsState() {
        rebuilder.toThrow = new IllegalStateException("Can not perform this action after onSaveInstanceState");
        RenderProcessGoneGuard guard = guard();
        assertTrue("重建失败也必须回 true", guard.handle(true, "didCrash=true"));
        dispatcher.flush(); // 不许把异常抛回调用方
        assertEquals(RenderProcessGoneGuard.EVENT_REBUILD_FAILED, recorder.events.get(1));
        assertTrue(recorder.details.get(1).contains("IllegalStateException"));
        assertFalse("失败后要能重试", guard.isRecovering());
        guard.handle(true, "retry");
        dispatcher.flush();
        assertEquals(2, rebuilder.calls);
    }

    @Test public void dispatchFailureStillKeepsTheClaim() {
        RenderProcessGoneGuard.Dispatcher broken = new RenderProcessGoneGuard.Dispatcher() {
            @Override public void post(Runnable task) {
                throw new IllegalStateException("view has no handler");
            }
        };
        RecordingRecorder recorder = new RecordingRecorder();
        RenderProcessGoneGuard guard = new RenderProcessGoneGuard(broken, recorder, rebuilder);
        assertTrue("post 失败也必须回 true", guard.handle(true, "didCrash=true"));
        assertEquals(RenderProcessGoneGuard.EVENT_REBUILD_FAILED, recorder.events.get(1));
        assertFalse(guard.isRecovering());
        assertEquals(0, rebuilder.calls);
    }
}
