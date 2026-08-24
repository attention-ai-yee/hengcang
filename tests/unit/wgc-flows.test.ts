import { describe, expect, it } from "vitest";
import { parseWgcMonthlyFlows } from "@/providers/wgc";

function payload(usdSeries: Array<{ name: string; data: Array<[number, number]> }>) {
  return { chartData: { data: { Monthly: { series: { usd: usdSeries } } } } };
}

function monthStart(year: number, month: number): number {
  return Date.UTC(year, month - 1, 1);
}

describe("WGC 全球黄金 ETF 流量解析", () => {
  it("剔除 Gold Price 辅助线，跨区域求和并做三个月滚动", () => {
    const result = parseWgcMonthlyFlows(payload([
      { name: "North America", data: [[monthStart(2026, 1), 1.0e8], [monthStart(2026, 2), 2.0e8], [monthStart(2026, 3), 3.0e8]] },
      { name: "Europe", data: [[monthStart(2026, 1), 5.0e7], [monthStart(2026, 2), 6.0e7], [monthStart(2026, 3), 7.0e7]] },
      { name: "Gold Price (rhs)", data: [[monthStart(2026, 1), 4000], [monthStart(2026, 2), 4100], [monthStart(2026, 3), 4200]] },
    ]));
    expect(result.length).toBe(1);
    const point = result[0];
    expect(point.asOf).toBe("2026-03-01");
    // 三个月合计 7.8 亿美元 -> 百万美元口径 780
    expect(point.valueMillionUsd).toBeCloseTo(780, 6);
  });

  it("月份断档不产出伪滚动窗口", () => {
    const result = parseWgcMonthlyFlows(payload([
      { name: "Asia", data: [[monthStart(2025, 1), 10], [monthStart(2025, 2), 20], [monthStart(2025, 6), 30], [monthStart(2025, 7), 40], [monthStart(2025, 8), 50]] },
    ]));
    expect(result.map((p) => p.asOf)).toEqual(["2025-08-01"]);
  });

  it("非预期载荷返回空数组（触发回退）", () => {
    expect(parseWgcMonthlyFlows({})).toEqual([]);
    expect(parseWgcMonthlyFlows({ chartData: {} })).toEqual([]);
  });
});