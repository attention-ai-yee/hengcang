import { describe, expect, it } from "vitest";
import { confirmStateTransition, shouldSuppressRecommendation } from "@/domain/scoring/state";
import type { RecommendationState } from "@/domain/types";

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

/**
 * 交易日连续性修复：只要求日期互异时，断档、周末缺日与月度回填都能凑足
 * "3 个交易日"。提供 tradingDates 后必须最近 required 个快照日期在日历中
 * 连续相邻，且当前 asOf 是已知交易日；否则保守不确认。
 */
describe("连续交易日的严格连续性校验", () => {
  const base = {
    previousState: "HOLD" as const,
    candidateState: "LIGHT_ADD_ALLOWED" as const,
    immediate: false,
    confirmationTradingDays: 3,
    candidateHistory: ["LIGHT_ADD_ALLOWED", "LIGHT_ADD_ALLOWED"] as RecommendationState[],
  };
  // 2026-08 中旬的已知交易日（08-22/08-23 为周末）。
  const tradingDates = [
    "2026-08-17",
    "2026-08-18",
    "2026-08-19",
    "2026-08-20",
    "2026-08-21",
    "2026-08-24",
    "2026-08-25",
  ];

  it("连续三个已知交易日（跨周末也算连续）确认切换", () => {
    const result = confirmStateTransition({
      ...base,
      candidateHistoryDates: ["2026-08-20", "2026-08-21"],
      asOf: "2026-08-24",
      tradingDates,
    });
    expect(result.confirmed).toBe(true);
    expect(result.state).toBe("LIGHT_ADD_ALLOWED");
  });

  it("周末快照（非交易日）不能凑成连续确认", () => {
    const result = confirmStateTransition({
      ...base,
      candidateHistoryDates: ["2026-08-21", "2026-08-23"],
      asOf: "2026-08-24",
      tradingDates,
    });
    expect(result.confirmed).toBe(false);
    expect(result.state).toBe("HOLD");
  });

  it("日历中间断档（缺一个交易日）不确认", () => {
    const result = confirmStateTransition({
      ...base,
      candidateHistoryDates: ["2026-08-17", "2026-08-19"],
      asOf: "2026-08-21",
      tradingDates,
    });
    expect(result.confirmed).toBe(false);
  });

  it("月度回填（每月只采样一天）不确认", () => {
    const monthlyTradingDates = [
      "2026-06-15",
      "2026-06-16",
      "2026-07-15",
      "2026-07-16",
      "2026-08-17",
      "2026-08-18",
    ];
    const result = confirmStateTransition({
      ...base,
      candidateHistoryDates: ["2026-06-15", "2026-07-15"],
      asOf: "2026-08-17",
      tradingDates: monthlyTradingDates,
    });
    expect(result.confirmed).toBe(false);
  });

  it("当前 asOf 不在交易日历中时不确认（即使历史日期连续）", () => {
    const result = confirmStateTransition({
      ...base,
      candidateHistoryDates: ["2026-08-19", "2026-08-20"],
      asOf: "2026-08-22",
      tradingDates,
    });
    expect(result.confirmed).toBe(false);
  });

  it("候选历史日期不足 required-1 个时不确认（保守）", () => {
    const result = confirmStateTransition({
      ...base,
      candidateHistory: ["LIGHT_ADD_ALLOWED"] as RecommendationState[],
      candidateHistoryDates: ["2026-08-20"],
      asOf: "2026-08-21",
      tradingDates,
    });
    expect(result.confirmed).toBe(false);
  });

  it("tradingDates 为空数组时回退到日期互异口径（向后兼容）", () => {
    const result = confirmStateTransition({
      ...base,
      candidateHistoryDates: ["2026-08-19", "2026-08-20"],
      asOf: "2026-08-21",
      tradingDates: [],
    });
    expect(result.confirmed).toBe(true);
  });

  it("未提供 tradingDates 时保持原有行为（即使 asOf 是周末）", () => {
    const result = confirmStateTransition({
      ...base,
      candidateHistoryDates: ["2026-08-19", "2026-08-20"],
      asOf: "2026-08-22",
    });
    expect(result.confirmed).toBe(true);
  });
});

/**
 * 同日冷却修复：decidedAt 带时区而 asOf 是 date-only 时，旧的
 * Date.parse 相减会得到负数，导致当天决策不抑制。改为比较日期部分后
 * 同日 elapsed=0 → 抑制；仍保持 elapsed >= 0 && elapsed < cooldownDays。
 */
describe("同方向建议的同日冷却（日期部分比较）", () => {
  const base = {
    state: "LIGHT_ADD_ALLOWED" as const,
    lastDecisionDirection: "ADD" as const,
  };

  it("带时区的当天决策在当天评估时抑制（旧实现会因负数漏抑制）", () => {
    expect(shouldSuppressRecommendation({
      ...base,
      lastDecisionAt: "2026-10-18T15:00:00+08:00",
      asOf: "2026-10-18",
    })).toBe(true);
  });

  it("冷却期第 6 天（elapsed=6 < 7）仍抑制", () => {
    expect(shouldSuppressRecommendation({
      ...base,
      lastDecisionAt: "2026-10-18T15:00:00+08:00",
      asOf: "2026-10-24",
    })).toBe(true);
  });

  it("冷却期第 7 天边界（elapsed=7）不再抑制", () => {
    expect(shouldSuppressRecommendation({
      ...base,
      lastDecisionAt: "2026-10-18T15:00:00+08:00",
      asOf: "2026-10-25",
    })).toBe(false);
  });

  it("决策日晚于评估日（未来）不抑制", () => {
    expect(shouldSuppressRecommendation({
      ...base,
      lastDecisionAt: "2026-10-19T00:00:00+08:00",
      asOf: "2026-10-18",
    })).toBe(false);
  });

  it("方向不同不抑制", () => {
    expect(shouldSuppressRecommendation({
      state: "REDUCE_CONSIDER",
      lastDecisionDirection: "ADD",
      lastDecisionAt: "2026-10-18T15:00:00+08:00",
      asOf: "2026-10-18",
    })).toBe(false);
  });

  it("date-only 决策日保持原有七天语义（第 6 天抑制 / 第 7 天放行）", () => {
    expect(shouldSuppressRecommendation({
      ...base,
      lastDecisionAt: "2026-08-01",
      asOf: "2026-08-07",
    })).toBe(true);
    expect(shouldSuppressRecommendation({
      ...base,
      lastDecisionAt: "2026-08-01",
      asOf: "2026-08-08",
    })).toBe(false);
  });
});
