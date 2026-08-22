import { describe, expect, it } from "vitest";
import {
  applyRiskRules,
  calculateOpportunityScore,
  confirmStateTransition,
  getBaseState,
  shouldSuppressRecommendation,
} from "@/domain/scoring";

describe("评分引擎规范案例", () => {
  it("Case A：科技便宜且基本面好", () => {
    const opportunityScore = calculateOpportunityScore(80, 85, 70);
    const result = applyRiskRules({
      opportunityScore,
      fundamentalScore: 85,
      confidence: "HIGH",
      currentWeightBps: 2000,
      positionLimitBps: 4000,
    });
    expect(opportunityScore).toBe(79.5);
    expect(result.state).toBe("STRONG_ADD_ALLOWED");
    expect(result.allowAdd).toBe(true);
  });

  it("Case B：单股超过 8% 时停止新增但不强制卖出", () => {
    const result = applyRiskRules({
      opportunityScore: 82,
      fundamentalScore: 80,
      confidence: "HIGH",
      currentWeightBps: 1200,
      positionLimitBps: 800,
    });
    expect(result.state).toBe("OVERWEIGHT");
    expect(result.allowAdd).toBe(false);
    expect(result.forceSell).toBe(false);
  });

  it("Case C：基本面低于 35 时即时熔断", () => {
    const opportunityScore = calculateOpportunityScore(95, 25, 20);
    const result = applyRiskRules({ opportunityScore, fundamentalScore: 25, confidence: "HIGH" });
    expect(result.state).toBe("REASSESS_THESIS");
    expect(result.allowAdd).toBe(false);
    expect(result.immediate).toBe(true);
  });

  it("基本面覆盖不足时不误触发熔断", () => {
    const result = applyRiskRules({
      opportunityScore: 30,
      fundamentalScore: 20,
      fundamentalCoverage: 0.4,
      confidence: "LOW",
    });
    expect(result.state).toBe("LOW_CONFIDENCE");
    expect(result.allowAdd).toBe(false);
  });

  it("Case D：黄金趋势强但拥挤时得到 61 分", () => {
    expect(calculateOpportunityScore(30, 90, 95)).toBe(61);
    expect(getBaseState(61)).toBe("LIGHT_ADD_ALLOWED");
  });

  it("仓位等于上限时不算超配", () => {
    const result = applyRiskRules({
      opportunityScore: 80,
      fundamentalScore: 80,
      confidence: "HIGH",
      currentWeightBps: 800,
      positionLimitBps: 800,
    });
    expect(result.state).toBe("STRONG_ADD_ALLOWED");
  });
});

describe("状态确认与冷却", () => {
  it("普通状态连续三个交易日后才切换", () => {
    const pending = confirmStateTransition({
      previousState: "HOLD",
      candidateState: "LIGHT_ADD_ALLOWED",
      candidateHistory: ["LIGHT_ADD_ALLOWED"],
      immediate: false,
    });
    const confirmed = confirmStateTransition({
      previousState: "HOLD",
      candidateState: "LIGHT_ADD_ALLOWED",
      candidateHistory: ["LIGHT_ADD_ALLOWED", "LIGHT_ADD_ALLOWED"],
      immediate: false,
    });
    expect(pending).toEqual({ state: "HOLD", confirmed: false });
    expect(confirmed).toEqual({ state: "LIGHT_ADD_ALLOWED", confirmed: true });
  });

  it("七个自然日内抑制同方向建议", () => {
    expect(shouldSuppressRecommendation({
      state: "LIGHT_ADD_ALLOWED",
      lastDecisionDirection: "ADD",
      lastDecisionAt: "2026-08-01",
      asOf: "2026-08-07",
    })).toBe(true);
    expect(shouldSuppressRecommendation({
      state: "LIGHT_ADD_ALLOWED",
      lastDecisionDirection: "ADD",
      lastDecisionAt: "2026-08-01",
      asOf: "2026-08-08",
    })).toBe(false);
  });
});
