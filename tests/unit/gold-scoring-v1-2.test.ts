import { describe, expect, it } from "vitest";
import { applyRiskRules } from "@/domain/scoring/engine";

/**
 * 黄金评分模型 v1.2（docs/hengcang_gold_model_revision_v1_2.md §29/§31）：
 * - GOLD 不再触发通用基本面熔断 REASSESS_THESIS；
 * - MacroSupport < goldMacroHeadwind 时输出 DO_NOT_ADD 且不立即生效；
 * - OVERWEIGHT > LOW_CONFIDENCE > 黄金宏观逆风 > 普通分数状态。
 */
describe("黄金 v1.2 状态规则", () => {
  it("Test A: 低 MacroSupport 不触发 REASSESS_THESIS，输出 DO_NOT_ADD（非立即）", () => {
    const result = applyRiskRules({
      bucket: "GOLD",
      opportunityScore: 45,
      fundamentalScore: 30,
      fundamentalCoverage: 0.85,
      confidence: "HIGH",
    });
    expect(result.state).toBe("DO_NOT_ADD");
    expect(result.allowAdd).toBe(false);
    expect(result.forceSell).toBe(false);
    expect(result.immediate).toBe(false);
    expect(result.reasons.join()).toContain("宏观");
    expect(result.reasons.join()).not.toContain("重新评估");
  });

  it("Test B: 权益基本面过低仍触发 REASSESS_THESIS", () => {
    const result = applyRiskRules({
      bucket: "VALUE_DIVIDEND",
      opportunityScore: 50,
      fundamentalScore: 30,
      fundamentalCoverage: 0.85,
      confidence: "HIGH",
    });
    expect(result.state).toBe("REASSESS_THESIS");
    expect(result.allowAdd).toBe(false);
  });

  it("Test C: 黄金宏观分 40 不拦路，高分继续走普通分数状态", () => {
    const result = applyRiskRules({
      bucket: "GOLD",
      opportunityScore: 70,
      fundamentalScore: 40,
      fundamentalCoverage: 0.9,
      confidence: "HIGH",
    });
    expect(result.state).toBe("LIGHT_ADD_ALLOWED");
  });

  it("Test D: 黄金超配优先于宏观逆风", () => {
    const result = applyRiskRules({
      bucket: "GOLD",
      opportunityScore: 50,
      fundamentalScore: 20,
      fundamentalCoverage: 0.9,
      confidence: "HIGH",
      currentWeightBps: 3000,
      positionLimitBps: 1500,
    });
    expect(result.state).toBe("OVERWEIGHT");
    expect(result.immediate).toBe(true);
  });

  it("Test E: LOW_CONFIDENCE 时不输出宏观逆风判断", () => {
    const result = applyRiskRules({
      bucket: "GOLD",
      opportunityScore: 50,
      fundamentalScore: 20,
      fundamentalCoverage: 0.5,
      confidence: "LOW",
    });
    expect(result.state).toBe("LOW_CONFIDENCE");
  });
});
