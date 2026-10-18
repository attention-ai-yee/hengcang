import { describe, expect, it, vi } from "vitest";
import { REFRESH_INTERVAL_MS, scheduleNextTick } from "../../scripts/worker";

/**
 * 回归：`pnpm worker` 启动即退出（数据新鲜度修复）。
 *
 * 旧实现对该循环唯一的 setTimeout 调用 `timer.unref()`，进程没有任何 ref 句柄，
 * Node 事件循环随即结束；自动刷新永远等不到第一次 tick。调度被抽成
 * `scheduleNextTick(handler, intervalMs)` 后，这里锁住三点：
 * 1. 返回的 timer 必须是 ref 状态（hasRef() === true）；
 * 2. 延时参数原样透传给 setTimeout；
 * 3. 到达间隔才触发 handler；
 * 另外验证被测试导入时不会启动常驻 timer / 信号处理器，避免污染 vitest 宿主进程。
 */
const SIX_HOURS = 6 * 60 * 60 * 1000;

describe("worker 常驻刷新调度（启动即退出回归）", () => {
  it("REFRESH_INTERVAL_MS 为 6 小时", () => {
    expect(REFRESH_INTERVAL_MS).toBe(SIX_HOURS);
  });

  it("scheduleNextTick 返回 ref 状态的 timer（不得 unref）", () => {
    const handler = vi.fn();
    const timer = scheduleNextTick(handler, SIX_HOURS);
    try {
      expect(timer.hasRef()).toBe(true);
    } finally {
      clearTimeout(timer);
    }
  });

  it("按给定间隔调度：未到点不触发，到点才触发一次", () => {
    vi.useFakeTimers();
    try {
      const handler = vi.fn();
      const timer = scheduleNextTick(handler, 1234);
      try {
        expect(timer.hasRef()).toBe(true);
        vi.advanceTimersByTime(1233);
        expect(handler).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(handler).toHaveBeenCalledTimes(1);
      } finally {
        clearTimeout(timer);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("被导入时不启动常驻循环、不注册信号处理器", async () => {
    // 直接执行（pnpm worker）才允许启动；测试导入不得留下 ref timer 或进程级 handler。
    const sigintBefore = process.listenerCount("SIGINT");
    const sigtermBefore = process.listenerCount("SIGTERM");
    vi.useFakeTimers();
    try {
      vi.resetModules();
      await import("../../scripts/worker");
      expect(vi.getTimerCount()).toBe(0);
      expect(process.listenerCount("SIGINT")).toBe(sigintBefore);
      expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore);
    } finally {
      vi.useRealTimers();
    }
  });
});
