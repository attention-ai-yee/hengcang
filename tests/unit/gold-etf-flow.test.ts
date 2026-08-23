import { describe, expect, it } from "vitest";
import { calculateGoldEtfFlow3m } from "@/providers/tushare/gold-etf-flow";

describe("黄金 ETF 流量代理", () => {
  it("用份额变化 × 单位净值并滚动累计", () => {
    const result = calculateGoldEtfFlow3m([
      { symbol: "518880.SH", tradeDate: "2026-01-02", shares: 100 },
      { symbol: "518880.SH", tradeDate: "2026-01-03", shares: 102 },
    ], [{ symbol: "518880.SH", navDate: "2026-01-03", availableAt: "2026-01-03T18:00:00+08:00", unitNav: 5 }]);
    expect(result).toEqual([{ asOf: "2026-01-03", availableAt: "2026-01-03T18:00:00+08:00", value: 100_000 }]);
  });
});
