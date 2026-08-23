import { describe, expect, it } from "vitest";
import { deriveChangeSeries } from "@/domain/scoring/series-transforms";
import type { MetricSeries } from "@/domain/scoring/types";

function build(history: Array<[string, number, string?]>, currentValue: number | null = null): MetricSeries {
  return {
    currentValue,
    history: history.map(([asOf, value, availableAt]) => ({
      value,
      asOf,
      availableAt: availableAt ?? asOf + "T18:00:00+08:00",
      quality: "VALID" as const,
    })),
    source: "fred",
    asOf: history[history.length - 1][0],
    availableAt: history[history.length - 1][0] + "T18:00:00+08:00",
    quality: "VALID",
    coverage: 1,
  };
}

describe("deriveChangeSeries（黄金 v1.2 边际变化成分）", () => {
  it("Case 1: 恰好 90 天前有观测 -> 差值正确", () => {
    const derived = deriveChangeSeries(build([["2026-01-01", 2.4], ["2026-04-01", 2.1]]), 90);
    // 2026-04-01 的 90 天前正是 2026-01-01
    const april = derived.history.find((point) => point.asOf === "2026-04-01");
    expect(april?.value).toBeCloseTo(-0.3, 10);
  });

  it("Case 2: 无恰好 90 天前观测 -> 取 targetDate 之前最近一条，禁止未来插值", () => {
    const derived = deriveChangeSeries(
      build([["2026-01-01", 2.4], ["2026-02-01", 2.5], ["2026-04-15", 2.0]]),
      90,
    );
    const april = derived.history.find((point) => point.asOf === "2026-04-15");
    // 04-15 的 90 天前是 01-15，基准只能取 01-01（2.4），不得用 02-01
    expect(april?.value).toBeCloseTo(-0.4, 10);
    // 02-01 的基准在去年，无可用基准 -> 不产出
    expect(derived.history.find((point) => point.asOf === "2026-02-01")).toBeUndefined();
  });

  it("Case 3: availableAt = max(当前, 基准)，quality = worse(当前, 基准)", () => {
    const input = build([
      ["2026-01-01", 2.4, "2026-01-01T18:00:00+08:00"],
      ["2026-04-01", 2.1, "2026-04-02T12:00:00+08:00"],
    ]);
    // 把基准点标成 PARTIAL 以验证质量传导
    input.history[0].quality = "PARTIAL";
    const derived = deriveChangeSeries(input, 90);
    const april = derived.history.find((point) => point.asOf === "2026-04-01");
    expect(april?.availableAt).toBe("2026-04-02T12:00:00+08:00");
    expect(april?.quality).toBe("PARTIAL");
  });

  it("currentValue 同样按 asOf-lookback 取基准；无基准时为 null", () => {
    const withBase = deriveChangeSeries(
      build([["2026-01-01", 2.4], ["2026-04-01", 2.1]], 2.05),
      90,
    );
    expect(withBase.currentValue).toBeCloseTo(-0.35, 10);
    const noBase = deriveChangeSeries(build([["2026-04-01", 2.1]]), 90);
    expect(noBase.currentValue).toBeNull();
  });
});
