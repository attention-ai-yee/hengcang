import { describe, expect, it } from "vitest";
import { aggregateDividendYield, aggregateHarmonicMetric, aggregateFundamentalMetric } from "@/providers/tushare/index-aggregator";

const weights = [
  { indexSymbol: "000300.SH", constituentSymbol: "A", effectiveDate: "2026-08-01", weight: 0.6 },
  { indexSymbol: "000300.SH", constituentSymbol: "B", effectiveDate: "2026-08-01", weight: 0.4 },
];

describe("指数成分聚合", () => {
  it("PE 使用权重调和平均而不是算术平均", () => {
    const result = aggregateHarmonicMetric("PE_TTM", weights, [
      { symbol: "A", tradeDate: "2026-08-21", peTtm: 10, pb: null, psTtm: null, dividendYield: null },
      { symbol: "B", tradeDate: "2026-08-21", peTtm: 20, pb: null, psTtm: null, dividendYield: null },
    ]);
    expect(result.value).toBeCloseTo(12.5);
    expect(result.quality).toBe("VALID");
  });

  it("股息率按权重平均，零股息是有效值", () => {
    const result = aggregateDividendYield(weights, [
      { symbol: "A", tradeDate: "2026-08-21", peTtm: null, pb: null, psTtm: null, dividendYield: 5 },
      { symbol: "B", tradeDate: "2026-08-21", peTtm: null, pb: null, psTtm: null, dividendYield: 2 },
    ]);
    expect(result.value).toBeCloseTo(3.8);
  });

  it("覆盖率对应 VALID / PARTIAL / 不发布", () => {
    const basics = [{ symbol: "A", tradeDate: "2026-08-21", peTtm: 10, pb: null, psTtm: null, dividendYield: null }];
    expect(aggregateHarmonicMetric("PE_TTM", weights, basics).quality).toBe("PARTIAL");
    expect(aggregateHarmonicMetric("PE_TTM", [{ ...weights[0], weight: 0.55 }, { ...weights[1], weight: 0.45 }], basics).value).toBeNull();
  });

  it("财务聚合只用评价日已经披露的数据", () => {
    const result = aggregateFundamentalMetric("EARNINGS_GROWTH", weights, [
      { symbol: "A", reportPeriod: "2025-12-31", availableAt: "2026-03-20T08:00:00+08:00", roe: 10, earningsGrowth: 10, revenueGrowth: 10 },
      { symbol: "A", reportPeriod: "2025-12-31", availableAt: "2026-04-10T08:00:00+08:00", roe: 10, earningsGrowth: 14, revenueGrowth: 10 },
      { symbol: "B", reportPeriod: "2025-12-31", availableAt: "2026-03-20T08:00:00+08:00", roe: 10, earningsGrowth: 10, revenueGrowth: 10 },
    ], "2026-03-31");
    expect(result.value).toBeCloseTo(10);
  });
});
