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

  /**
   * 回归测试（Code Review M1）：NAV 必须按 symbol+date 配对。
   * 只按日期建键时，两只 ETF 同日互相覆盖——A 基金份额变动乘 B 基金净值。
   */
  it("两只 ETF 同日净值互不覆盖（M1）", () => {
    const result = calculateGoldEtfFlow3m(
      [
        { symbol: "518880.SH", tradeDate: "2026-01-02", shares: 100 },
        { symbol: "518880.SH", tradeDate: "2026-01-03", shares: 102 }, // +2 万份
        { symbol: "159934.SZ", tradeDate: "2026-01-02", shares: 50 },
        { symbol: "159934.SZ", tradeDate: "2026-01-03", shares: 51 }, // +1 万份
      ],
      [
        { symbol: "518880.SH", navDate: "2026-01-03", availableAt: "2026-01-03T18:00:00+08:00", unitNav: 5 },
        { symbol: "159934.SZ", navDate: "2026-01-03", availableAt: "2026-01-03T18:00:00+08:00", unitNav: 2 },
      ],
    );
    // 修复前：518880 的 +2 万份会被 159934 的净值 2 乘（或反之），得 40_000/160_000 之类的错值。
    expect(result).toEqual([
      { asOf: "2026-01-03", availableAt: "2026-01-03T18:00:00+08:00", value: 2 * 10_000 * 5 + 1 * 10_000 * 2 },
    ]);
  });

  it("缺净值的交易日被跳过而不是用别只基金的净值", () => {
    const result = calculateGoldEtfFlow3m(
      [
        { symbol: "518880.SH", tradeDate: "2026-01-02", shares: 100 },
        { symbol: "518880.SH", tradeDate: "2026-01-03", shares: 102 },
      ],
      [{ symbol: "159934.SZ", navDate: "2026-01-03", availableAt: "2026-01-03T18:00:00+08:00", unitNav: 2 }],
    );
    expect(result).toEqual([]);
  });
});
