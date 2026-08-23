import { describe, expect, it } from "vitest";
import { fullYearsBetween, scoreHistoricalMetric } from "@/domain/scoring/percentile";
import type { MetricSeries } from "@/domain/scoring/types";

/**
 * 回归测试（Code Review H4）：历史年限必须按完整日历年计算。
 * 旧的 Δms/365.25 天算法把含闰日的恰好 5 年（1826 天）算成 4.9993 年，
 * 导致按规格回填的干净数据永远拿不到 HIGH 置信度。
 */
function seriesEndingAt(latestAsOf: string): MetricSeries {
  return {
    currentValue: 3,
    history: [
      { value: 1, asOf: "2021-08-23", availableAt: "2021-08-23T18:00:00+08:00", quality: "VALID" },
      { value: 3, asOf: latestAsOf, availableAt: latestAsOf + "T18:00:00+08:00", quality: "VALID" },
    ],
    source: "tushare-index-aggregate",
    asOf: latestAsOf,
    quality: "VALID",
    coverage: 1,
  };
}

describe("置信度年限边界（H4）", () => {
  it("fullYearsBetween 按日历年计算并正确处理闰日", () => {
    expect(fullYearsBetween("2021-08-23", "2026-08-23")).toBe(5);
    expect(fullYearsBetween("2021-08-23", "2026-08-22")).toBe(4);
    expect(fullYearsBetween("2020-02-29", "2024-02-29")).toBe(4);
    expect(fullYearsBetween("2024-01-01", "2025-01-01")).toBe(1);
  });

  it("恰好 5 个日历年的干净 VALID 序列可得 HIGH", () => {
    const result = scoreHistoricalMetric(seriesEndingAt("2026-08-23"), 1, "HIGHER_IS_BETTER", "2026-08-23");
    expect(result.score).not.toBeNull();
    expect(result.confidence).toBe("HIGH");
  });

  it("差一天不足 5 年仍为 MEDIUM", () => {
    const result = scoreHistoricalMetric(seriesEndingAt("2026-08-21"), 1, "HIGHER_IS_BETTER", "2026-08-22");
    expect(result.confidence).toBe("MEDIUM");
  });

  it("PARTIAL 或 derived 来源封顶 MEDIUM", () => {
    const partial = { ...seriesEndingAt("2026-08-23"), quality: "PARTIAL" as const };
    expect(scoreHistoricalMetric(partial, 1, "HIGHER_IS_BETTER", "2026-08-23").confidence).toBe("MEDIUM");
    const derived = { ...seriesEndingAt("2026-08-23"), source: "DERIVED:MA200:tushare" };
    expect(scoreHistoricalMetric(derived, 1, "HIGHER_IS_BETTER", "2026-08-23").confidence).toBe("MEDIUM");
  });
});
