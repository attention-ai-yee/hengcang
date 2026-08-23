import { describe, expect, it } from "vitest";
import { calculateAssetScore } from "@/domain/scoring";
import type { AssetModelInput, MetricSeries, ValueDividendInput } from "@/domain/scoring/types";

/**
 * 回归测试（Code Review H3/H4）：
 * - 整根支柱缺失时禁止输出增配状态（重权只允许在指标级发生）；
 * - 干净数据在引擎层可以重新产出 HIGH 置信度与增配状态；
 * - 基本面熔断（更严重的即时态）优先于支柱闸门。
 */
const EVAL_DATE = "2026-08-23";

function metric(value: number): MetricSeries {
  return {
    currentValue: value,
    history: [{ value, asOf: "2020-01-01", availableAt: "2020-01-01T00:00:00Z", quality: "VALID" }],
    source: "tushare-index-aggregate",
    asOf: EVAL_DATE,
    availableAt: EVAL_DATE + "T00:00:00Z",
    quality: "VALID",
    coverage: 1,
  };
}

function series(values: number[]): MetricSeries {
  const history = values.map((value, index) => ({
    value,
    asOf: `202${index}-01-01`,
    availableAt: `202${index}-01-01T00:00:00Z`,
    quality: "VALID" as const,
  }));
  const latest = history[history.length - 1];
  return {
    currentValue: latest.value,
    history,
    source: "tushare-index-aggregate",
    asOf: latest.asOf,
    availableAt: latest.availableAt,
    quality: "VALID",
    coverage: 1,
  };
}

function inputWithTrend(trend: ValueDividendInput["trend"]): ValueDividendInput {
  return {
    bucket: "VALUE_DIVIDEND",
    asOf: EVAL_DATE,
    trend,
    pe: metric(10),
    pb: metric(1),
    dividendYield: metric(5),
    earningsGrowth: metric(8),
    roe: metric(12),
    dividendStability: { score: 80, source: "tushare-index-aggregate", asOf: EVAL_DATE, quality: "VALID" },
  };
}

const missingTrend: AssetModelInput["trend"] = {
  price: { value: null, source: "UNAVAILABLE", asOf: EVAL_DATE },
  ma20: { value: null, source: "UNAVAILABLE", asOf: EVAL_DATE },
  ma60: { value: null, source: "UNAVAILABLE", asOf: EVAL_DATE },
  ma200: { value: null, source: "UNAVAILABLE", asOf: EVAL_DATE },
  momentum6m: { currentValue: null, history: [], source: "UNAVAILABLE", asOf: EVAL_DATE },
};

const presentTrend: AssetModelInput["trend"] = {
  price: { value: 120, source: "tushare", asOf: EVAL_DATE },
  ma20: { value: 110, source: "tushare", asOf: EVAL_DATE },
  ma60: { value: 100, source: "tushare", asOf: EVAL_DATE },
  ma200: { value: 80, source: "tushare", asOf: EVAL_DATE },
  momentum6m: {
    currentValue: 0.15,
    history: [
      { value: 0.1, asOf: "2020-01-01", availableAt: "2020-01-01T00:00:00Z", quality: "VALID" },
      { value: 0.15, asOf: EVAL_DATE, availableAt: EVAL_DATE + "T00:00:00Z", quality: "VALID" },
    ],
    source: "tushare-index-aggregate",
    asOf: EVAL_DATE,
    quality: "VALID",
    coverage: 1,
  },
};

describe("支柱级完整性闸门（H3）", () => {
  it("趋势支柱整体缺失时输出 LOW_CONFIDENCE 且禁止增配", () => {
    const result = calculateAssetScore(inputWithTrend(missingTrend));
    expect(result.cheapnessScore).not.toBeNull();
    expect(result.fundamentalScore).not.toBeNull();
    expect(result.trendScore).toBeNull();
    expect(result.state).toBe("LOW_CONFIDENCE");
    expect(result.allowAdd).toBe(false);
    expect(result.confidence).toBe("MEDIUM");
    expect(result.reasons.join("")).toContain("缺少整根评分支柱");
  });

  it("三根支柱齐全时正常输出增配状态且可达 HIGH 置信度", () => {
    const result = calculateAssetScore(inputWithTrend(presentTrend));
    expect(result.missingMetrics).toHaveLength(0);
    expect(result.state).toBe("LIGHT_ADD_ALLOWED");
    expect(result.allowAdd).toBe(true);
    expect(result.confidence).toBe("HIGH");
    expect(result.reasons.join("")).not.toContain("缺少整根评分支柱");
  });

  it("基本面熔断优先于支柱闸门", () => {
    const weakFundamental: AssetModelInput = {
      ...inputWithTrend(missingTrend),
      earningsGrowth: series([20, 8, -50]),
      roe: series([30, 20, 12]),
      dividendStability: { score: 10, source: "tushare-index-aggregate", asOf: EVAL_DATE, quality: "VALID" },
    };
    const result = calculateAssetScore(weakFundamental);
    expect(result.fundamentalScore).toBeLessThan(35);
    expect(result.candidateState).toBe("REASSESS_THESIS");
  });
});
