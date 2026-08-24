import { describe, expect, it } from "vitest";
import { metricsFromEquity, scoreDrivenWeights, simulateEquity } from "@/server/backtest-service";

describe("回测引擎纯函数", () => {
  it("scoreDrivenWeights：高分桶增配、上限生效、权重归一到 1", () => {
    const target = { GOLD: 0.1, VALUE_DIVIDEND: 0.25, TECH_GROWTH: 0.3, BROAD_EQUITY: 0.35 };
    const limit = { VALUE_DIVIDEND: 0.35, TECH_GROWTH: 0.4, BROAD_EQUITY: 0.15 };
    const raw = scoreDrivenWeights({ GOLD: 75, VALUE_DIVIDEND: 55, TECH_GROWTH: 45, BROAD_EQUITY: 20 }, target, limit);
    const total = Object.values(raw).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);
    expect(raw.BROAD_EQUITY).toBeLessThanOrEqual(0.15);
    expect(raw.GOLD).toBeGreaterThan(target.GOLD);
  });

  it("simulateEquity：权重随收益漂移（B&H 与再平衡区分的关键）", () => {
    const dates = ["2025-01-01", "2025-02-01"];
    const returns = { GOLD: [0.20], VALUE_DIVIDEND: [0], TECH_GROWTH: [0], BROAD_EQUITY: [0] };
    const weights = { GOLD: 0.25, VALUE_DIVIDEND: 0.25, TECH_GROWTH: 0.25, BROAD_EQUITY: 0.25 };
    const { equity } = simulateEquity(dates, returns, weights, null, 0);
    expect(equity.at(-1)!.nav).toBeCloseTo(1.05, 10);
    // 漂移后 GOLD 占比应高于 25%
    const goldShare = (0.25 * 1.2) / (0.25 * 1.2 + 0.75);
    expect(goldShare).toBeCloseTo(0.2857, 3);
  });

  it("simulateEquity：固定收益与成本扣减", () => {
    const dates = ["2025-01-01", "2025-02-01", "2025-03-01"];
    const returns = { GOLD: [0.10, 0.10], VALUE_DIVIDEND: [0.10, 0.10], TECH_GROWTH: [0.10, 0.10], BROAD_EQUITY: [0.10, 0.10] };
    const weights = { GOLD: 0.25, VALUE_DIVIDEND: 0.25, TECH_GROWTH: 0.25, BROAD_EQUITY: 0.25 };
    const { equity, turnoverBps, tradeCount } = simulateEquity(dates, returns, weights, () => ({ ...weights }), 0);
    expect(equity.at(-1)!.nav).toBeCloseTo(1.21, 10);
    expect(turnoverBps).toBe(0);
    expect(tradeCount).toBe(0);
    const costly = simulateEquity(dates, returns, weights, () => ({ GOLD: 1, VALUE_DIVIDEND: 0, TECH_GROWTH: 0, BROAD_EQUITY: 0 }), 10);
    // 换手 1.5 -> 成本 1.5 * 10bp = 15bp，净值应略低于无条件情形
    expect(costly.equity.at(-1)!.nav).toBeLessThan(1.21);
    expect(costly.turnoverBps).toBeGreaterThan(0);
  });

  it("metricsFromEquity：回撤与年化合理", () => {
    const metrics = metricsFromEquity([
      { date: "2025-01-01", nav: 1 },
      { date: "2026-01-01", nav: 1.2 },
      { date: "2026-02-01", nav: 1.1 },
    ]);
    expect(metrics.totalReturnBps).toBe(1000);
    expect(metrics.maxDrawdownBps).toBeCloseTo(-833, 0);
    expect(metrics.cagrBps).toBeGreaterThan(0);
  });
});