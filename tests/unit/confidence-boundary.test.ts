import { describe, expect, it } from "vitest";
import { fullYearsBetween, scoreHistoricalMetric } from "@/domain/scoring/percentile";
import type { MetricSeries } from "@/domain/scoring/types";

/**
 * 回归测试（Code Review H4 + M11）：
 * - 年限按完整日历年计算（不能用 Δms/365.25，闰日会把恰好 N 年算成 N-ε）；
 * - 权威阈值为 v1.1：VALID 且 ≥3 个完整日历年 → HIGH 候选；≥1 年 → MEDIUM；
 *   PARTIAL 或 derived 来源封顶 MEDIUM；manual 恒为 LOW。
 */
const EVAL_DATE = "2026-08-23";

function seriesFrom(earliest: string): MetricSeries {
  return {
    currentValue: 3,
    history: [
      { value: 1, asOf: earliest, availableAt: earliest + "T18:00:00+08:00", quality: "VALID" },
      { value: 3, asOf: EVAL_DATE, availableAt: EVAL_DATE + "T18:00:00+08:00", quality: "VALID" },
    ],
    source: "tushare-index-aggregate",
    asOf: EVAL_DATE,
    quality: "VALID",
    coverage: 1,
  };
}

function confidenceFor(series: MetricSeries, evaluationDate = EVAL_DATE): "HIGH" | "MEDIUM" | "LOW" {
  return scoreHistoricalMetric(series, 1, "HIGHER_IS_BETTER", evaluationDate).confidence;
}

describe("置信度年限边界（H4/M11，权威 v1.1）", () => {
  it("fullYearsBetween 按日历年计算并正确处理闰日", () => {
    expect(fullYearsBetween("2021-08-23", "2026-08-23")).toBe(5);
    expect(fullYearsBetween("2021-08-23", "2026-08-22")).toBe(4);
    expect(fullYearsBetween("2020-02-29", "2024-02-29")).toBe(4);
    expect(fullYearsBetween("2024-01-01", "2025-01-01")).toBe(1);
  });

  it("恰好与超过 3 个完整日历年的干净 VALID 序列可达 HIGH", () => {
    expect(confidenceFor(seriesFrom("2023-08-23"))).toBe("HIGH");
    expect(confidenceFor(seriesFrom("2019-08-23"))).toBe("HIGH");
  });

  it("差一天不足 3 年（只有 2 个完整年）保持 MEDIUM", () => {
    expect(fullYearsBetween("2023-08-24", EVAL_DATE)).toBe(2);
    expect(confidenceFor(seriesFrom("2023-08-24"))).toBe("MEDIUM");
    expect(confidenceFor(seriesFrom("2025-08-23"))).toBe("MEDIUM");
  });

  it("不足 1 年为 LOW", () => {
    expect(confidenceFor(seriesFrom("2025-12-01"))).toBe("LOW");
  });

  it("PARTIAL 或 derived 来源封顶 MEDIUM；manual 恒为 LOW", () => {
    const fiveYearSeries = seriesFrom("2021-08-23");
    expect(confidenceFor({ ...fiveYearSeries, quality: "PARTIAL" })).toBe("MEDIUM");
    expect(confidenceFor({ ...fiveYearSeries, source: "DERIVED:MA200:tushare" })).toBe("MEDIUM");
    expect(confidenceFor({ ...fiveYearSeries, source: "manual" })).toBe("LOW");
  });
});
