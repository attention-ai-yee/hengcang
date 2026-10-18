import { describe, expect, it } from "vitest";
import {
  applyRiskRules,
  calculateOpportunityScore,
  confirmStateTransition,
  getBaseState,
  shouldSuppressRecommendation,
} from "@/domain/scoring";

/**
 * v2 规范案例（docs/hengcang_v2_allocation_fundamentals_thesis.md §3）：
 * 配置吸引力分 = 70% × 便宜程度 + 30% × 趋势；基本面改为体检，只负责「恶化 → 暂停新增」。
 */
describe("评分引擎规范案例（v2）", () => {
  it("Case A：科技便宜、趋势好、体检正常 → 77 分，可明显增配", () => {
    const opportunityScore = calculateOpportunityScore(80, 70);
    const result = applyRiskRules({
      opportunityScore,
      fundamentalHealth: "HEALTHY",
      confidence: "HIGH",
      currentWeightBps: 2000,
      positionLimitBps: 4000,
    });
    expect(opportunityScore).toBe(77);
    expect(result.state).toBe("STRONG_ADD_ALLOWED");
    expect(result.allowAdd).toBe(true);
  });

  it("Case B：单股超过 8% 时停止新增但不强制卖出", () => {
    const result = applyRiskRules({
      opportunityScore: 82,
      fundamentalHealth: "HEALTHY",
      confidence: "HIGH",
      currentWeightBps: 1200,
      positionLimitBps: 800,
    });
    expect(result.state).toBe("OVERWEIGHT");
    expect(result.allowAdd).toBe(false);
    expect(result.forceSell).toBe(false);
  });

  it("Case C：再便宜，体检不通过也即时暂停新增、重新评估逻辑", () => {
    const opportunityScore = calculateOpportunityScore(95, 20);
    const result = applyRiskRules({
      opportunityScore,
      fundamentalHealth: "DETERIORATING",
      healthReasons: ["基本面体检：盈利同比最近两期（相隔约一个季度）同比都为负（-12 @ 2026-10-20，-8 @ 2026-07-15）"],
      confidence: "HIGH",
    });
    expect(opportunityScore).toBe(72.5);
    expect(result.state).toBe("REASSESS_THESIS");
    expect(result.allowAdd).toBe(false);
    expect(result.immediate).toBe(true);
    expect(result.reasons[0]).toContain("-12 @ 2026-10-20");
  });

  it("体检数据不足时不触发熔断，只把强增配封顶为小幅增配", () => {
    const result = applyRiskRules({ opportunityScore: 80, fundamentalHealth: "UNKNOWN", confidence: "HIGH" });
    expect(result.state).toBe("LIGHT_ADD_ALLOWED");
    expect(result.allowAdd).toBe(true);
    expect(result.reasons.join()).toContain("体检");
  });

  it("可信度低时一律 LOW_CONFIDENCE（体检数据不足也不例外）", () => {
    const result = applyRiskRules({ opportunityScore: 30, fundamentalHealth: "UNKNOWN", confidence: "LOW" });
    expect(result.state).toBe("LOW_CONFIDENCE");
    expect(result.allowAdd).toBe(false);
  });

  it("Case D：黄金趋势强但拥挤 → 49.5 分，中性持有", () => {
    expect(calculateOpportunityScore(30, 95)).toBe(49.5);
    expect(getBaseState(49.5)).toBe("HOLD");
  });

  it("仓位等于上限时不算超配", () => {
    const result = applyRiskRules({
      opportunityScore: 80,
      fundamentalHealth: "HEALTHY",
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
