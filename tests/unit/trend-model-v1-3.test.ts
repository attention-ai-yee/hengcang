import { describe, expect, it } from "vitest";
import { calculateTrend } from "@/domain/scoring/models";
import type { MetricSeries, TrendModelInput } from "@/domain/scoring/types";

const AS_OF = "2026-08-21";

function flat(value: number): MetricSeries {
  return {
    currentValue: value,
    history: [{ value, asOf: AS_OF, availableAt: AS_OF + "T18:00:00+08:00", quality: "VALID" }],
    source: "tushare",
    asOf: AS_OF,
    availableAt: AS_OF + "T18:00:00+08:00",
    quality: "VALID",
    coverage: 1,
  };
}

function momentum6m(): MetricSeries {
  // 递增的动量历史，当前值接近历史最差 -> 百分位个位数（复现黄金实况）
  const history = Array.from({ length: 40 }, (_, i) => ({
    value: 0.05 + i * 0.01,
    asOf: `2025-${String((i % 12) + 1).padStart(2, "0")}-15`,
    availableAt: `2025-${String((i % 12) + 1).padStart(2, "0")}-15T18:00:00+08:00`,
    quality: "VALID" as const,
  }));
  return { currentValue: 0.06, history, source: "DERIVED:MOMENTUM_6M:tushare", asOf: AS_OF, quality: "VALID" };
}

function trendInput(price: number, ma20: number, ma60: number, ma200: number): TrendModelInput {
  return {
    price: { value: price, source: "tushare", asOf: AS_OF },
    ma20: { value: ma20, source: "DERIVED:MA20:tushare", asOf: AS_OF },
    ma60: { value: ma60, source: "DERIVED:MA60:tushare", asOf: AS_OF },
    ma200: { value: ma200, source: "DERIVED:MA200:tushare", asOf: AS_OF },
    momentum6m: momentum6m(),
  };
}

describe("Trend Model v1.3：连续化长期趋势与均线结构", () => {
  it("黄金实况复现：价格 = MA200 × 0.9902 -> MA200 项 ≈ 40.2，三项合成 ≈ 25", () => {
    const result = calculateTrend(trendInput(983.56, 924.73, 916.10, 993.34), AS_OF);
    expect(result.components.ma200?.score).toBeCloseTo(40.2, 1);
    expect(result.components.maAlignment?.score).toBeCloseTo(28.0, 0);
    expect(result.score).toBeGreaterThan(23);
    expect(result.score).toBeLessThan(28);
  });

  it("带内线性：+5% 饱和 100，-5% 饱和 0，中点偏上插值", () => {
    expect(calculateTrend(trendInput(105, 100, 100, 100), AS_OF).components.ma200?.score).toBe(100);
    expect(calculateTrend(trendInput(95, 100, 100, 100), AS_OF).components.ma200?.score).toBe(0);
    expect(calculateTrend(trendInput(102.5, 100, 100, 100), AS_OF).components.ma200?.score).toBeCloseTo(75, 6);
  });

  it("均线结构：短期修复给部分分，不再一票归零", () => {
    const result = calculateTrend(trendInput(983.56, 100.94, 100, 107.77), AS_OF);
    expect(result.components.maAlignment?.score).toBeGreaterThan(25);
    expect(result.components.maAlignment?.score).toBeLessThan(31);
  });

  it("6M 动量保持连续百分位语义不变", () => {
    const strong = calculateTrend(
      trendInput(120, 115, 110, 100),
      AS_OF,
    );
    expect(strong.components.momentum6m?.score).toBeTypeOf("number");
  });

  it("MA200 缺失时该项按缺失重归一而不是归零", () => {
    const input = trendInput(983.56, 924.73, 916.10, 993.34);
    input.ma200 = { value: null, source: "DERIVED:MA200:tushare", asOf: AS_OF };
    const result = calculateTrend(input, AS_OF);
    expect(result.components.ma200?.score ?? null).toBeNull();
    expect(result.score).toBeTypeOf("number");
  });
});
