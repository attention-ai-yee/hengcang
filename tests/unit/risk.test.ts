import { describe, expect, it } from "vitest";
import { evaluateHoldingRisk } from "@/domain/risk";

describe("evaluateHoldingRisk", () => {
  it("单股严格超过 8% 时触发 OVERWEIGHT", () => {
    const result = evaluateHoldingRisk({
      holdingValueMinor: 4_800_001n,
      portfolioValueMinor: 60_000_000n,
      isSingleStock: true,
      isThematicEtf: false,
      limits: { singleStockBps: 800, thematicEtfBps: 1500 },
    });

    expect(result.isOverweight).toBe(true);
    expect(result.recommendationState).toBe("OVERWEIGHT");
    expect(result.severity).toBe("WARNING");
  });

  it("刚好等于 8% 时允许持有但禁止新增", () => {
    const result = evaluateHoldingRisk({
      holdingValueMinor: 4_800_000n,
      portfolioValueMinor: 60_000_000n,
      isSingleStock: true,
      isThematicEtf: false,
      limits: { singleStockBps: 800, thematicEtfBps: 1500 },
    });

    expect(result.isOverweight).toBe(false);
    expect(result.canAdd).toBe(false);
  });

  it("主题 ETF 严格超过 15% 时触发超配", () => {
    const result = evaluateHoldingRisk({
      holdingValueMinor: 9_000_001n,
      portfolioValueMinor: 60_000_000n,
      isSingleStock: false,
      isThematicEtf: true,
      limits: { singleStockBps: 800, thematicEtfBps: 1500 },
    });
    expect(result.isOverweight).toBe(true);
    expect(result.canAdd).toBe(false);
    expect(result.recommendationState).toBe("OVERWEIGHT");
  });
});
