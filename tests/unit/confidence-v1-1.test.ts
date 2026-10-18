import { describe, expect, it } from "vitest";
import { applyRiskRules, scoreHistoricalMetric } from "@/domain/scoring";
import type { MetricSeries } from "@/domain/scoring";

function fiveYearSeries(quality: "VALID" | "PARTIAL"): MetricSeries {
  return {
    currentValue: 20, source: quality === "PARTIAL" ? "tushare-derived-forward-pe" : "tushare-index-aggregate", asOf: "2026-08-21", availableAt: "2026-08-21",
    quality,
    history: Array.from({ length: 6 }, (_, index) => ({ value: 10 + index * 2, asOf: `${2021 + index}-08-21`, availableAt: `${2021 + index}-08-21`, quality })),
  };
}

describe("v1.1 Confidence", () => {
  it("PARTIAL 代理即使历史满五年最高也只到 MEDIUM", () => {
    expect(scoreHistoricalMetric(fiveYearSeries("PARTIAL"), 1, "LOWER_IS_BETTER", "2026-08-21").confidence).toBe("MEDIUM");
  });

  it("中等可信度限制强增配和降低仓位", () => {
    expect(applyRiskRules({ opportunityScore: 80, fundamentalHealth: "HEALTHY", confidence: "MEDIUM" }).state).toBe("LIGHT_ADD_ALLOWED");
    expect(applyRiskRules({ opportunityScore: 10, fundamentalHealth: "HEALTHY", confidence: "MEDIUM" }).state).toBe("DO_NOT_ADD");
  });
});
