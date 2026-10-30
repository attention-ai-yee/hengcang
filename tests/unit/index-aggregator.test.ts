import { describe, expect, it } from "vitest";
import { aggregateDividendYield, aggregateHarmonicMetric, aggregateFundamentalMetric, weightedMedian } from "@/providers/tushare/index-aggregator";

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

describe("增长率按加权中位数汇总（2026-10-30 真实数据复查）", () => {
  it("加权中位数：累计权重过半的值；正好在两个值之间取平均", () => {
    expect(weightedMedian([{ value: -20, weight: 0.5 }, { value: 10, weight: 0.5 }])).toBe(-5);
    expect(weightedMedian([{ value: 0, weight: 1 }, { value: -30, weight: 1 }, { value: -25, weight: 1 }])).toBe(-25);
    expect(weightedMedian([{ value: 5, weight: 0.6 }, { value: 900, weight: 0.4 }])).toBe(5);
    expect(weightedMedian([])).toBeNull();
  });

  it("小基数公司的暴涨不会把指数增速拉成正数：多数权重在下滑时汇总为负", () => {
    const weights = ["A", "B", "C", "D"].map((symbol, index) => ({ indexSymbol: "X", effectiveDate: "2026-09-30", constituentSymbol: symbol, weight: [0.3, 0.3, 0.2, 0.2][index] }));
    const report = (symbol: string, earningsGrowth: number) => ({ symbol, reportPeriod: "2026-09-30", availableAt: "2026-10-25T08:00:00+08:00", roe: 10, earningsGrowth, revenueGrowth: earningsGrowth });
    const result = aggregateFundamentalMetric("EARNINGS_GROWTH", weights, [report("A", -8), report("B", -5), report("C", 1500), report("D", 3)], "2026-10-30");
    expect(result.value).toBe(-5);
    expect(result.reportPeriod).toBe("2026-09-30");
    expect(result.reportPeriodShare).toBe(1);
  });

  it("同一天发了年报和一季报：不论数据顺序都取一季报（2026-10-30 离线重算复查）", () => {
    const weights = [{ indexSymbol: "X", effectiveDate: "2026-03-31", constituentSymbol: "A", weight: 1 }];
    const annual = { symbol: "A", reportPeriod: "2025-12-31", availableAt: "2026-04-30T08:00:00+08:00", roe: 10, earningsGrowth: 6, revenueGrowth: 6 };
    const firstQuarter = { ...annual, reportPeriod: "2026-03-31", earningsGrowth: 30, revenueGrowth: 30 };
    for (const reports of [[annual, firstQuarter], [firstQuarter, annual]]) {
      const result = aggregateFundamentalMetric("EARNINGS_GROWTH", weights, reports, "2026-05-10");
      expect(result).toMatchObject({ value: 30, reportPeriod: "2026-03-31" });
    }
  });

  it("财报季里记下主导报告期占有效权重的比例（体检据此挑「纯」的上一期）", () => {
    const weights = ["A", "B", "C", "D"].map((symbol, index) => ({ indexSymbol: "X", effectiveDate: "2026-09-30", constituentSymbol: symbol, weight: [0.3, 0.3, 0.2, 0.2][index] }));
    const report = (symbol: string, reportPeriod: string) => ({ symbol, reportPeriod, availableAt: "2026-10-25T08:00:00+08:00", roe: 10, earningsGrowth: 5, revenueGrowth: 5 });
    const result = aggregateFundamentalMetric("EARNINGS_GROWTH", weights, [report("A", "2026-09-30"), report("B", "2026-06-30"), report("C", "2026-09-30"), report("D", "2026-06-30")], "2026-10-30");
    expect(result.reportPeriod).toBe("2026-09-30");
    expect(result.reportPeriodShare).toBe(0.5);
  });
});

