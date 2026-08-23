import { describe, expect, it } from "vitest";
import { calculateAssetScore, combineComponents, scoreHistoricalMetric } from "@/domain/scoring";
import type { AssetModelInput, HistoricalObservation, MetricSeries, TrendModelInput } from "@/domain/scoring";

const AS_OF = "2025-12-31";

function series(currentValue: number, values = [10, 20, 30, 40, 50, 60]): MetricSeries {
  const history: HistoricalObservation[] = values.map((value, index) => ({
    value,
    asOf: `${2020 + index}-01-02`,
    availableAt: `${2020 + index}-01-02`,
  }));
  return { currentValue, history, source: "TEST_AUTO", asOf: AS_OF, availableAt: AS_OF };
}

function trend(): TrendModelInput {
  return {
    price: { value: 120, source: "TEST_AUTO", asOf: AS_OF },
    ma20: { value: 115, source: "TEST_AUTO", asOf: AS_OF },
    ma60: { value: 110, source: "TEST_AUTO", asOf: AS_OF },
    ma200: { value: 100, source: "TEST_AUTO", asOf: AS_OF },
    momentum6m: series(60),
  };
}

function modelInputs(): AssetModelInput[] {
  return [
    {
      bucket: "VALUE_DIVIDEND", asOf: AS_OF, trend: trend(), pe: series(10), pb: series(20),
      dividendYield: series(60), earningsGrowth: series(50), roe: series(50),
      dividendStability: { score: 90, source: "TEST_AUTO", asOf: AS_OF },
    },
    {
      bucket: "TECH_GROWTH", asOf: AS_OF, trend: trend(), pe: series(20), ps: series(20),
      earningsGrowth: series(60), revenueGrowth: series(50), peg: series(10),
    },
    {
      bucket: "BROAD_EQUITY", asOf: AS_OF, trend: trend(), pe: series(20), pb: series(20),
      equityRiskPremium: series(60), indexEarningsGrowth: series(50), earningsRevision: series(50),
    },
    {
      bucket: "GOLD", asOf: AS_OF, trend: trend(), pricePosition: series(50),
      distanceFromMa200: series(40), momentum3m: series(50), realYield: series(10),
      dollarIndex: series(20), etfFlow: series(60), centralBankDemand: series(50),
    },
  ];
}

describe("四类资产独立模型", () => {
  it.each(modelInputs().map((input) => [input.bucket, input] as const))("%s 可生成完整、同方向分数", (_bucket, input) => {
    const result = calculateAssetScore(input);
    expect(result.cheapnessScore).toBeTypeOf("number");
    expect(result.fundamentalScore).toBeTypeOf("number");
    expect(result.trendScore).toBeTypeOf("number");
    expect(result.opportunityScore).toBeGreaterThanOrEqual(0);
    expect(result.opportunityScore).toBeLessThanOrEqual(100);
    expect(Object.keys(result.components).length).toBeGreaterThan(0);
  });

  it("黄金模型不包含 PE 或 PB", () => {
    const gold = calculateAssetScore(modelInputs()[3]);
    expect(Object.keys(gold.components).some((key) => /(^|\.)p[eb]$/i.test(key))).toBe(false);
  });
});

describe("百分位与缺失数据", () => {
  it("只使用评估日已发布的数据，禁止未来数据泄漏", () => {
    const metric: MetricSeries = {
      currentValue: 50, source: "TEST_AUTO", asOf: "2024-06-30", availableAt: "2024-06-30",
      history: [
        { value: 10, asOf: "2020-01-01", availableAt: "2020-01-01" },
        { value: 100, asOf: "2024-01-01", availableAt: "2024-07-01" },
      ],
    };
    const result = scoreHistoricalMetric(metric, 1, "HIGHER_IS_BETTER", "2024-06-30");
    expect(result.percentile).toBe(100);
  });

  it("缺失指标自动按剩余权重重新归一化", () => {
    const result = combineComponents({
      available: { rawValue: 80, percentile: null, score: 80, weight: 0.6, source: "AUTO", asOf: AS_OF, confidence: "HIGH" },
      missing: { rawValue: null, percentile: null, score: null, weight: 0.4, source: "AUTO", asOf: AS_OF, confidence: "LOW" },
    });
    expect(result.score).toBe(80);
    expect(result.coverage).toBe(0.6);
    expect(result.confidence).toBe("MEDIUM");
    expect(result.missingMetrics).toEqual(["missing"]);
  });
});
