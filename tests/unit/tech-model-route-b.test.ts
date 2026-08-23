import { describe, expect, it } from "vitest";
import { calculateAssetScore } from "@/domain/scoring";
import { deriveRatioSeries } from "@/domain/scoring/series-transforms";
import type { AssetModelInput, MetricSeries, TrendModelInput } from "@/domain/scoring/types";

const AS_OF = "2026-08-21";

function pairSeries(numValues: number[], denValues: number[], source: string): { num: MetricSeries; den: MetricSeries } {
  const mk = (values: number[], src: string): MetricSeries => ({
    currentValue: values[values.length - 1],
    history: values.map((value, i) => ({
      value,
      asOf: 2020 + Math.floor(i / 12) + "-" + String((i % 12) + 1).padStart(2, "0") + "-15",
      availableAt: "2021-01-01T18:00:00+08:00",
      quality: "VALID" as const,
    })),
    source: src,
    asOf: AS_OF,
    quality: "VALID",
    coverage: 1,
  });
  return { num: mk(numValues, source), den: mk(denValues, "tushare-index-aggregate") };
}

function flat(value: number, source: string): MetricSeries {
  return { currentValue: value, history: [{ value, asOf: "2022-06-15", availableAt: "2022-06-15T18:00:00+08:00", quality: "VALID" }], source, asOf: AS_OF, quality: "VALID", coverage: 1 };
}

const trend: TrendModelInput = {
  price: { value: 2100, source: "tushare", asOf: AS_OF },
  ma20: { value: 2050, source: "DERIVED:MA20:tushare", asOf: AS_OF },
  ma60: { value: 2010, source: "DERIVED:MA60:tushare", asOf: AS_OF },
  ma200: { value: 1950, source: "DERIVED:MA200:tushare", asOf: AS_OF },
  momentum6m: flat(0.08, "DERIVED:MOMENTUM_6M:tushare"),
};

function techInput(): AssetModelInput {
  return {
    bucket: "TECH_GROWTH", asOf: AS_OF, trend,
    pe: flat(38, "tushare-index-aggregate"),
    ps: flat(4.2, "tushare-index-aggregate"),
    earningsGrowth: flat(18, "tushare-index-aggregate"),
    revenueGrowth: flat(11, "tushare-index-aggregate"),
    peg: flat(38 / 18, "DERIVED:PEG_TTM:tushare-index-aggregate"),
  };
}

describe("科技 v1.4 Route B（TTM 已实现基本面模型）", () => {
  it("deriveRatioSeries：对齐相除、负增长取下限得极大值、来源为确定性变换命名", () => {
    const { num, den } = pairSeries([30, 40, 50], [10, 20, -5], "tushare-index-aggregate");
    const derived = deriveRatioSeries(num, den, { featureName: "PEG_TTM" });
    expect(derived.source).toBe("DERIVED:PEG_TTM:tushare-index-aggregate");
    expect(derived.history.length).toBe(3);
    expect(derived.history[0].value).toBeCloseTo(3, 10);
    // 分母 -5 被下限保护为 +1 -> 比值 50（极贵），而不是符号翻转出的负数
    expect(derived.history[2].value).toBeCloseTo(50, 10);
    expect(derived.currentValue).toBeCloseTo(50, 10);
  });

  it("科技全真实数据 -> 置信度 HIGH，组件不含前瞻代理", () => {
    const result = calculateAssetScore(techInput());
    expect(result.confidence).toBe("HIGH");
    const keys = Object.keys(result.components);
    expect(keys.some((k) => k.includes("forwardPe"))).toBe(false);
    expect(keys.some((k) => k === "cheapness.pe" || k.startsWith("cheapness.pe"))).toBe(true);
  });

  it("缺 PEG 时按缺失重归一而非归零，且不阻断整体评分", () => {
    const input = techInput();
    delete (input as { peg?: MetricSeries }).peg;
    const result = calculateAssetScore(input);
    expect(result.opportunityScore).toBeTypeOf("number");
  });
});