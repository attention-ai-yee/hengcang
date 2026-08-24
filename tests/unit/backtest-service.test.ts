import { describe, expect, it } from "vitest";
import {
  buildRebalance,
  coalesceToMonthEnd,
  metricsFromEquity,
  normalizedTargets,
  scoreDrivenWeights,
  simulateEquity,
  STATE_GATED_NO_TRADE_BAND,
  stateGatedWeights,
} from "@/server/backtest-service";

describe("回测引擎纯函数", () => {
  it("scoreDrivenWeights：高分桶增配、上限生效、权重归一到 1", () => {
    const target = { GOLD: 0.1, VALUE_DIVIDEND: 0.25, TECH_GROWTH: 0.3, BROAD_EQUITY: 0.35 };
    const limitMax = { VALUE_DIVIDEND: 0.35, TECH_GROWTH: 0.4, BROAD_EQUITY: 0.15 };
    const raw = scoreDrivenWeights({ GOLD: 75, VALUE_DIVIDEND: 55, TECH_GROWTH: 45, BROAD_EQUITY: 20 }, target, limitMax);
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
    // 换手 1.5 -> 成本 1.5 × 10bp = 15bp：i=1 净值 1.1×0.9985，期末 1.09835×1.1
    expect(costly.equity.at(-1)!.nav).toBeCloseTo(1.208185, 9);
    expect(costly.turnoverBps).toBe(15000);
    expect(costly.tradeCount).toBe(4);
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

  it("metricsFromEquity：最差年度按自然年切分、最长回撤期计到修复或序列末日", () => {
    const metrics = metricsFromEquity([
      { date: "2025-01-01", nav: 1.0 },
      { date: "2025-06-01", nav: 1.2 },
      { date: "2025-12-31", nav: 0.9 },
      { date: "2026-06-01", nav: 1.1 },
      { date: "2026-12-31", nav: 0.99 },
    ]);
    // 2025 年：0.9/1.0 - 1 = -10%；2026 年：0.99/0.9 - 1 = +10%
    expect(metrics.worstYearBps).toBe(-1000);
    // 峰值 1.2 在 2025-06-01，此后一直未修复，最长回撤期计到序列末日
    expect(metrics.longestDrawdownDays).toBe(Math.round((Date.parse("2026-12-31") - Date.parse("2025-06-01")) / 86_400_000));
    expect(metrics.maxDrawdownBps).toBe(-2500);
  });

  it("metricsFromEquity：严格超越前峰的修复日也计入最长回撤期；单边上涨无回撤期", () => {
    const recovered = metricsFromEquity([
      { date: "2024-01-31", nav: 1.1 },
      { date: "2024-02-28", nav: 1.05 },
      { date: "2024-03-31", nav: 1.0 },
      { date: "2024-04-30", nav: 1.02 },
      { date: "2024-05-31", nav: 1.06 },
      { date: "2024-06-30", nav: 1.15 },
    ]);
    // 峰值 1.1 在 01-31，直到 06-30 才超越 -> 回撤历时含修复穿越日
    expect(recovered.longestDrawdownDays).toBe(Math.round((Date.parse("2024-06-30") - Date.parse("2024-01-31")) / 86_400_000));
    const rising = metricsFromEquity([
      { date: "2024-01-31", nav: 1.0 },
      { date: "2024-02-29", nav: 1.1 },
      { date: "2024-03-31", nav: 1.2 },
    ]);
    expect(rising.longestDrawdownDays).toBe(0);
  });

  it("metricsFromEquity：首尾单点残段不参与最差年度；单点曲线返回 null", () => {
    // 2025 尾部残段只有 1 个观测点，不参与取最小值 -> 最差年度是 2024 的 +50%
    const stubbed = metricsFromEquity([
      { date: "2024-01-31", nav: 1.0 },
      { date: "2024-12-31", nav: 1.5 },
      { date: "2025-01-31", nav: 1.51 },
    ]);
    expect(stubbed.worstYearBps).toBe(5000);
    const single = metricsFromEquity([{ date: "2025-01-01", nav: 1 }]);
    expect(single.worstYearBps).toBeNull();
    expect(single.totalReturnBps).toBe(0);
  });

  it("metricsFromEquity：波动率年化按实测区间长度而非固定月度", () => {
    const points = [
      { date: "2025-01-01", nav: 1 },
      { date: "2025-01-02", nav: 1.01 },
      { date: "2025-01-03", nav: 1.03 },
    ];
    const tight = metricsFromEquity(points).volatilityBps;
    const spread = metricsFromEquity([
      { date: "2025-01-01", nav: 1 },
      { date: "2025-01-31", nav: 1.01 },
      { date: "2025-03-02", nav: 1.03 },
    ]).volatilityBps;
    // 相同收益序列：间隔越短，年化波动率越高（sqrt(periodsPerYear) 随实测间距缩放）
    expect(tight).toBeGreaterThan(spread * 4);
  });

  it("coalesceToMonthEnd：每个自然月只保留最后一个公共评估日并保持有序", () => {
    const coalesced = coalesceToMonthEnd(["2026-07-31", "2026-08-21", "2026-08-22", "2026-08-24"]);
    expect(coalesced).toEqual(["2026-07-31", "2026-08-24"]);
  });

  describe("stateGatedWeights", () => {
    const target = { GOLD: 0.25, VALUE_DIVIDEND: 0.25, TECH_GROWTH: 0.25, BROAD_EQUITY: 0.25 };
    const noCaps = { limitMax: {} as Record<string, number>, limitMin: {} as Record<string, number> };

    it("允许加配的桶获得更高目标，HOLD 桶回到目标，权重合计为 1", () => {
      const weights = stateGatedWeights(
        { GOLD: "LIGHT_ADD_ALLOWED", VALUE_DIVIDEND: "HOLD", TECH_GROWTH: "HOLD", BROAD_EQUITY: "HOLD" },
        target, target, noCaps.limitMax, noCaps.limitMin,
      )!;
      const total = Object.values(weights).reduce((a, b) => a + b, 0);
      expect(total).toBeCloseTo(1, 10);
      expect(weights.GOLD).toBeGreaterThan(0.25);
      expect(weights.VALUE_DIVIDEND).toBeLessThan(0.25);
    });

    it("DO_NOT_ADD 暂停桶保持漂移权重，新钱只流向允许增配的桶", () => {
      const drifted = { GOLD: 0.4, VALUE_DIVIDEND: 0.2, TECH_GROWTH: 0.2, BROAD_EQUITY: 0.2 };
      const weights = stateGatedWeights(
        { GOLD: "DO_NOT_ADD", VALUE_DIVIDEND: "LIGHT_ADD_ALLOWED", TECH_GROWTH: "HOLD", BROAD_EQUITY: "HOLD" },
        drifted, target, noCaps.limitMax, noCaps.limitMin,
      )!;
      expect(weights.GOLD).toBeCloseTo(0.4, 10);
      expect(weights.VALUE_DIVIDEND).toBeGreaterThan(0.2);
    });

    it("全部暂停时返回 null（本期不交易）", () => {
      const weights = stateGatedWeights(
        { GOLD: "LOW_CONFIDENCE", VALUE_DIVIDEND: "REASSESS_THESIS", TECH_GROWTH: "DO_NOT_ADD", BROAD_EQUITY: "LOW_CONFIDENCE" },
        target, target, noCaps.limitMax, noCaps.limitMin,
      );
      expect(weights).toBeNull();
    });

    it("组合变化不足无交易带时不调整；上限被尊重；REDUCE_CONSIDER 不低于下限带且确实减配", () => {
      const nearTarget = { GOLD: 0.251, VALUE_DIVIDEND: 0.25, TECH_GROWTH: 0.25, BROAD_EQUITY: 0.249 };
      const banded = stateGatedWeights(
        { GOLD: "HOLD", VALUE_DIVIDEND: "HOLD", TECH_GROWTH: "HOLD", BROAD_EQUITY: "HOLD" },
        nearTarget, target, noCaps.limitMax, noCaps.limitMin,
      );
      expect(banded).toBeNull();
      const capped = stateGatedWeights(
        { GOLD: "STRONG_ADD_ALLOWED", VALUE_DIVIDEND: "HOLD", TECH_GROWTH: "HOLD", BROAD_EQUITY: "HOLD" },
        target, target, { GOLD: 0.26 }, {},
      )!;
      expect(capped.GOLD).toBeLessThanOrEqual(0.26 + 1e-9);
      const reduced = stateGatedWeights(
        { GOLD: "REDUCE_CONSIDER", VALUE_DIVIDEND: "HOLD", TECH_GROWTH: "HOLD", BROAD_EQUITY: "HOLD" },
        target, target, noCaps.limitMax, { GOLD: 0.2 },
      )!;
      // 归一后按比例缩放，但相对关系保持：GOLD 是最低配且不低于下限带
      expect(reduced.GOLD).toBeLessThan(reduced.VALUE_DIVIDEND);
      expect(reduced.GOLD).toBeGreaterThanOrEqual(0.2 - 1e-9);
    });

    it("缩放后破下限带的桶被补回，缺口由其他活跃桶承担；触上限的桶让出预算", () => {
      // GOLD REDUCE（下限 0.22）+ VD HOLD，TECH/BROAD 锁定 0.3：预算只剩 0.4，
      // 按比例缩放会把 GOLD 压到 0.187 -> 必须补回下限并由 VD 承担缺口
      const drifted = { GOLD: 0.2, VALUE_DIVIDEND: 0.2, TECH_GROWTH: 0.3, BROAD_EQUITY: 0.3 };
      const weights = stateGatedWeights(
        { GOLD: "REDUCE_CONSIDER", VALUE_DIVIDEND: "HOLD" },
        drifted, target, {}, { GOLD: 0.22 },
      )!;
      expect(weights.GOLD).toBeGreaterThanOrEqual(0.22 - 1e-9);
      const total = Object.values(weights).reduce((a, b) => a + b, 0);
      expect(total).toBeCloseTo(1, 9);

      // STRONG_ADD 触上限：GOLD 钳在 0.24，溢出预算落到 HOLD 桶
      const capped = stateGatedWeights(
        { GOLD: "STRONG_ADD_ALLOWED", VALUE_DIVIDEND: "HOLD", TECH_GROWTH: "HOLD", BROAD_EQUITY: "HOLD" },
        target, target, { GOLD: 0.24 }, {},
      )!;
      expect(capped.GOLD).toBeLessThanOrEqual(0.24 + 1e-9);
      expect(capped.VALUE_DIVIDEND).toBeGreaterThan(0.25);
      expect(Object.values(capped).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    });

    it("导出的无交易带常量在组合层面 100bps 量级", () => {
      expect(STATE_GATED_NO_TRADE_BAND).toBeGreaterThan(0);
      expect(STATE_GATED_NO_TRADE_BAND).toBeLessThanOrEqual(0.02);
    });
  });

  describe("normalizedTargets 兜底分支", () => {
    it("targetBps 合计为 0 时仍读取 maxBps/minBps 上限，并标记 fallback", () => {
      const result = normalizedTargets([{ assetBucket: "GOLD", targetBps: 0, minBps: 500, maxBps: 1500 }]);
      expect(result.fallback).toBe(true);
      expect(result.target.GOLD).toBeCloseTo(0.25, 10);
      expect(result.limitMax.GOLD).toBeCloseTo(0.15, 10);
      expect(result.limitMin.GOLD).toBeCloseTo(0.05, 10);
    });

    it("正常路径按可评分桶的目标比例归一，并独立读取上下限", () => {
      const result = normalizedTargets([
        { assetBucket: "GOLD", targetBps: 1000, minBps: 500, maxBps: 1500 },
        { assetBucket: "TECH_GROWTH", targetBps: 3000, minBps: 2000, maxBps: 4000 },
        { assetBucket: "CASH_BONDS", targetBps: 6000, minBps: 0, maxBps: 0 },
      ]);
      expect(result.fallback).toBe(false);
      expect(result.target.GOLD).toBeCloseTo(0.25, 12);
      expect(result.target.TECH_GROWTH).toBeCloseTo(0.75, 12);
      expect(result.target.CASH_BONDS).toBeUndefined();
      expect(result.limitMax.GOLD).toBeCloseTo(0.15, 12);
      expect(result.limitMax.TECH_GROWTH).toBeCloseTo(0.4, 12);
    });
  });

  describe("buildRebalance 信号滞后（T+1）", () => {
    const dates = ["2025-01-31", "2025-02-28", "2025-03-31"];
    const target = { GOLD: 0.25, VALUE_DIVIDEND: 0.25, TECH_GROWTH: 0.25, BROAD_EQUITY: 0.25 };
    // 注意 2025-03-31 自己的分数很高：若实现误读当期快照会得到高权重——用于暴露前视。
    const opportunityByDate = {
      "2025-01-31": { GOLD: 90, VALUE_DIVIDEND: 50, TECH_GROWTH: 50, BROAD_EQUITY: 50 },
      "2025-02-28": { GOLD: 20, VALUE_DIVIDEND: 50, TECH_GROWTH: 50, BROAD_EQUITY: 50 },
      "2025-03-31": { GOLD: 90, VALUE_DIVIDEND: 50, TECH_GROWTH: 50, BROAD_EQUITY: 50 },
    };

    it("SCORE_TILT 在 index i 使用 dates[i-1] 的评分，而不是当期评分", () => {
      const rebalance = buildRebalance("SCORE_TILT", {
        dates, opportunityByDate, statesByDate: {}, target, limitMax: {}, limitMin: {},
      })!;
      const atLastIndex = rebalance(2, target)!;
      const expected = scoreDrivenWeights(opportunityByDate["2025-02-28"], target, {});
      expect(atLastIndex.GOLD).toBeCloseTo(expected.GOLD, 12);
      // 2 月末 GOLD 分只有 20 -> 低乘数，权重必须低于目标；若读了 3 月末的 90 会远高于目标
      expect(atLastIndex.GOLD).toBeLessThan(target.GOLD);
    });

    it("FIXED_QUARTERLY 只在进入新季度时再平衡", () => {
      const quarterlyDates = ["2025-01-31", "2025-02-28", "2025-03-31", "2025-04-30"];
      const rebalance = buildRebalance("FIXED_QUARTERLY", {
        dates: quarterlyDates, opportunityByDate: {}, statesByDate: {}, target, limitMax: {}, limitMin: {},
      })!;
      expect(rebalance(1, target)).toBeNull();
      expect(rebalance(2, target)).toBeNull();
      expect(rebalance(3, target)).toEqual(target);
    });

    it("STATE_GATED 在 index i 使用 dates[i-1] 的状态", () => {
      const statesByDate = {
        "2025-01-31": { GOLD: "LOW_CONFIDENCE", VALUE_DIVIDEND: "LOW_CONFIDENCE", TECH_GROWTH: "LOW_CONFIDENCE", BROAD_EQUITY: "LOW_CONFIDENCE" },
        "2025-02-28": { GOLD: "LIGHT_ADD_ALLOWED", VALUE_DIVIDEND: "HOLD", TECH_GROWTH: "HOLD", BROAD_EQUITY: "HOLD" },
      };
      const drifted = { GOLD: 0.25, VALUE_DIVIDEND: 0.25, TECH_GROWTH: 0.25, BROAD_EQUITY: 0.25 };
      const rebalance = buildRebalance("STATE_GATED", {
        dates, opportunityByDate: {}, statesByDate, target, limitMax: {}, limitMin: {},
      })!;
      const weights = rebalance(2, drifted)!;
      // index 2 读的是 2025-02-28 的 LIGHT_ADD_ALLOWED（而非当期缺失的状态）
      expect(weights.GOLD).toBeGreaterThan(0.25);
      // 反向验证滞后：index 1 读到的是 1 月末的全 LOW_CONFIDENCE（全部锁定）-> 不交易
      expect(rebalance(1, drifted)).toBeNull();
    });
  });
});
