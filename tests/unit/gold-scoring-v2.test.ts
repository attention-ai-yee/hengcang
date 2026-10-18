import { describe, expect, it } from "vitest";
import { applyRiskRules } from "@/domain/scoring/engine";

/**
 * 黄金状态规则 v2（docs/hengcang_v2_allocation_fundamentals_thesis.md §3.4）：
 * - 宏观支持度（实际利率、美元、资金流）只展示，不再拦路：2022 年后各国央行大量购金，
 *   美国实际利率升到十几年高位而金价大涨，v1.2 的「宏观逆风 → 停止新增」会恰好错过这段行情；
 * - 黄金没有经营基本面，不触发 REASSESS_THESIS，也不受「体检数据不足」的封顶；
 * - OVERWEIGHT > LOW_CONFIDENCE > 普通分数状态。
 */
describe("黄金 v2 状态规则", () => {
  it("Test A：宏观支持度再低也不拦路，按配置吸引力分走普通状态", () => {
    const result = applyRiskRules({ bucket: "GOLD", opportunityScore: 45, fundamentalHealth: "NOT_APPLICABLE", confidence: "HIGH" });
    expect(result.state).toBe("HOLD");
    expect(result.reasons.join()).not.toContain("宏观");
  });

  it("Test B：权益桶体检不通过仍即时触发 REASSESS_THESIS", () => {
    const result = applyRiskRules({
      bucket: "VALUE_DIVIDEND",
      opportunityScore: 50,
      fundamentalHealth: "DETERIORATING",
      healthReasons: ["基本面体检：盈利同比最近两期（相隔约一个季度）同比都为负"],
      confidence: "HIGH",
    });
    expect(result.state).toBe("REASSESS_THESIS");
    expect(result.immediate).toBe(true);
    expect(result.reasons[0]).toContain("盈利同比");
  });

  it("Test C：黄金即使被误传「恶化」也不会触发 REASSESS_THESIS", () => {
    const result = applyRiskRules({ bucket: "GOLD", opportunityScore: 70, fundamentalHealth: "DETERIORATING", confidence: "HIGH" });
    expect(result.state).toBe("LIGHT_ADD_ALLOWED");
  });

  it("Test D：黄金超配优先于普通分数状态", () => {
    const result = applyRiskRules({
      bucket: "GOLD",
      opportunityScore: 80,
      fundamentalHealth: "NOT_APPLICABLE",
      confidence: "HIGH",
      currentWeightBps: 3000,
      positionLimitBps: 1500,
    });
    expect(result.state).toBe("OVERWEIGHT");
    expect(result.immediate).toBe(true);
  });

  it("Test E：LOW_CONFIDENCE 优先于普通分数状态", () => {
    expect(applyRiskRules({ bucket: "GOLD", opportunityScore: 80, fundamentalHealth: "NOT_APPLICABLE", confidence: "LOW" }).state).toBe("LOW_CONFIDENCE");
  });

  it("Test F：黄金不受「体检数据不足」封顶，高分仍可强增配", () => {
    expect(applyRiskRules({ bucket: "GOLD", opportunityScore: 80, confidence: "HIGH" }).state).toBe("STRONG_ADD_ALLOWED");
  });
});
