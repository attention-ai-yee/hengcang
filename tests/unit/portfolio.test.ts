import { describe, expect, it } from "vitest";
import { summarizePortfolio } from "@/domain/portfolio";
import { evaluateHoldingRisk } from "@/domain/risk";
import type { HoldingInput } from "@/domain/types";

const holdings: HoldingInput[] = [
  { name: "现金", marketValueMinor: 8_000_000n, assetBucket: "CASH_BONDS" },
  { name: "股票账户总值", marketValueMinor: 22_000_000n, assetBucket: "TECH_GROWTH", needsBreakdown: true },
  { name: "债券基金", marketValueMinor: 16_000_000n, assetBucket: "CASH_BONDS" },
  { name: "中欧红利A", marketValueMinor: 10_000_000n, assetBucket: "VALUE_DIVIDEND" },
  { name: "黄金", marketValueMinor: 2_000_000n, assetBucket: "GOLD", isApproximate: true },
  { name: "其他科技/A500", marketValueMinor: 1_000_000n, assetBucket: "OTHER", isApproximate: true },
];

describe("summarizePortfolio", () => {
  it("从当前持仓得到 ¥590,000，而不是固定总资产", () => {
    const summary = summarizePortfolio(holdings);

    expect(summary.totalValueMinor).toBe(59_000_000n);
    expect(summary.byBucket.CASH_BONDS.valueMinor).toBe(24_000_000n);
    expect(summary.byBucket.TECH_GROWTH.weightBps).toBe(3729);
  });

  it("未拆分账户使集中度分析标记为不完整", () => {
    const summary = summarizePortfolio(holdings);

    expect(summary.concentrationComplete).toBe(false);
    expect(summary.unresolvedHoldings).toEqual(["股票账户总值"]);
  });

  it("Case E：预留买车资金从可投资资产和现金债券桶扣除", () => {
    const summary = summarizePortfolio(
      [
        { name: "现金与债券", marketValueMinor: 20_000_000n, assetBucket: "CASH_BONDS" },
        { name: "单股", marketValueMinor: 5_000_000n, assetBucket: "TECH_GROWTH", isSingleStock: true },
        { name: "其他资产", marketValueMinor: 35_000_000n, assetBucket: "BROAD_EQUITY" },
      ],
      15_000_000n,
    );

    expect(summary.totalValueMinor).toBe(60_000_000n);
    expect(summary.investableAssetsMinor).toBe(45_000_000n);
    expect(summary.byBucket.CASH_BONDS.investableValueMinor).toBe(5_000_000n);
    expect(summary.byBucket.TECH_GROWTH.weightBps).toBe(1111);
    const risk = evaluateHoldingRisk({
      holdingValueMinor: 5_000_000n,
      portfolioValueMinor: summary.investableAssetsMinor,
      isSingleStock: true,
      isThematicEtf: false,
      limits: { singleStockBps: 800, thematicEtfBps: 1500 },
    });
    expect(risk.weightBps).toBe(1111);
    expect(risk.recommendationState).toBe("OVERWEIGHT");
  });
});
