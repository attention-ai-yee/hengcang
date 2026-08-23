import { describe, expect, it } from "vitest";
import { confirmStateTransition } from "@/domain/scoring/state";

/**
 * 回归测试（Code Review H5）：确认计数必须感知交易日。
 * 同一天多次刷新产生的候选快照只计一次，防止"盘中刷两次=两天"。
 */
describe("确认状态转换的日期感知（H5）", () => {
  const base = {
    previousState: "HOLD" as const,
    candidateState: "LIGHT_ADD_ALLOWED" as const,
    immediate: false,
  };

  it("两个不同交易日的同向候选 + 今天 = 连续三日，确认切换", () => {
    const result = confirmStateTransition({
      ...base,
      candidateHistory: ["LIGHT_ADD_ALLOWED", "LIGHT_ADD_ALLOWED"],
      candidateHistoryDates: ["2026-08-19", "2026-08-20"],
      confirmationTradingDays: 3,
    });
    expect(result.confirmed).toBe(true);
    expect(result.state).toBe("LIGHT_ADD_ALLOWED");
  });

  it("同一天重复刷新的双份候选不构成连续三日", () => {
    const result = confirmStateTransition({
      ...base,
      candidateHistory: ["LIGHT_ADD_ALLOWED", "LIGHT_ADD_ALLOWED"],
      candidateHistoryDates: ["2026-08-19", "2026-08-19"],
      confirmationTradingDays: 3,
    });
    expect(result.confirmed).toBe(false);
    expect(result.state).toBe("HOLD");
  });

  it("候选方向不一致时不确认", () => {
    const result = confirmStateTransition({
      ...base,
      candidateHistory: ["LIGHT_ADD_ALLOWED", "DO_NOT_ADD"],
      candidateHistoryDates: ["2026-08-19", "2026-08-20"],
      confirmationTradingDays: 3,
    });
    expect(result.confirmed).toBe(false);
  });

  it("未提供日期时保持原有行为（兼容旧调用方）", () => {
    const result = confirmStateTransition({
      ...base,
      candidateHistory: ["LIGHT_ADD_ALLOWED", "LIGHT_ADD_ALLOWED"],
      confirmationTradingDays: 3,
    });
    expect(result.confirmed).toBe(true);
  });

  it("即时态（熔断/超配/低可信度）绕过确认立即生效", () => {
    const result = confirmStateTransition({
      previousState: "HOLD",
      candidateState: "OVERWEIGHT",
      candidateHistory: [],
      immediate: true,
    });
    expect(result.confirmed).toBe(true);
    expect(result.state).toBe("OVERWEIGHT");
  });
});
