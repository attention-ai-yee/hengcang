import { and, asc, eq, inArray, lte } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import { DEFAULT_PORTFOLIO_ID } from "@/db/queries";
import { allocationTargets, backtestResults, backtestRuns, metricObservations, scoreSnapshots } from "@/db/schema";
import type { RecommendationState, ScorableAssetBucket } from "@/domain/types";

/** 回测只覆盖四只参与评分的资产桶（现金/其他桶不参与权益模拟）。 */
export const BACKTEST_BUCKETS = ["GOLD", "VALUE_DIVIDEND", "TECH_GROWTH", "BROAD_EQUITY"] as ScorableAssetBucket[];

/**
 * 规格 §14 要求至少对比五种形态；这里展开为六条：
 * 持有基准、固定比例（月度/季度）、评分映射（无上限 / 含上限）、状态门控（含上限与迟滞）。
 * 状态门控直接消费 score_snapshots 的 recommendation_state——状态本身已含
 * 3 日确认迟滞，且只在状态迁移或漂移越带时交易，换手远低于逐月重映射。
 */
export const STRATEGIES = [
  { key: "BUY_AND_HOLD", label: "Buy & Hold", cn: "持有基准" },
  { key: "FIXED_MONTHLY", label: "Fixed Monthly", cn: "固定比例 · 月度再平衡" },
  { key: "FIXED_QUARTERLY", label: "Fixed Quarterly", cn: "固定比例 · 季度再平衡" },
  { key: "SCORE_TILT", label: "Score Tilt", cn: "评分映射（无上限）" },
  { key: "SCORE_TILT_CAPPED", label: "Score Tilt + Caps", cn: "评分映射 + 仓位上限" },
  { key: "STATE_GATED", label: "State Gated", cn: "状态门控 + 上限 + 迟滞" },
] as const;
export type StrategyKey = (typeof STRATEGIES)[number]["key"];

/** 旧引擎版本写入的 strategy 键 -> 展示名（仅用于历史行渲染）。 */
export const LEGACY_STRATEGY_CN: Record<string, string> = {
  FIXED_ALLOCATION: "固定比例再平衡（旧版）",
  SCORE_DRIVEN: "评分驱动（旧版）",
};

export interface BacktestSummary {
  runId: string;
  batchId: string;
  strategy: StrategyKey;
  startDate: string;
  endDate: string;
  totalReturnBps: number;
  cagrBps: number;
  maxDrawdownBps: number;
  volatilityBps: number;
  sharpeMilli: number;
  worstYearBps: number | null;
  longestDrawdownDays: number;
  turnoverBps: number;
  tradeCount: number;
  finalNav: number;
}

interface TargetInput { assetBucket: string; targetBps: number; minBps: number; maxBps: number; }

export interface NormalizedTargets {
  target: Record<string, number>;
  limitMax: Record<string, number>;
  limitMin: Record<string, number>;
  /** allocation_targets 缺失或全为 0 时为 true：等权兜底，上限不可用 */
  fallback: boolean;
}

export function normalizedTargets(targets: TargetInput[]): NormalizedTargets {
  const scoped = targets.filter((item) => (BACKTEST_BUCKETS as readonly string[]).includes(item.assetBucket));
  const sum = scoped.reduce((acc, item) => acc + item.targetBps, 0);
  const limitMax: Record<string, number> = {};
  const limitMin: Record<string, number> = {};
  const target: Record<string, number> = {};
  // 上限/下限独立于目标权重读取：即使 targetBps 合计为 0，maxBps/minBps 仍然有效。
  for (const item of scoped) {
    if (item.maxBps > 0) limitMax[item.assetBucket] = item.maxBps / 10000;
    if (item.minBps > 0) limitMin[item.assetBucket] = item.minBps / 10000;
  }
  if (sum <= 0) {
    const equal = 1 / BACKTEST_BUCKETS.length;
    for (const bucket of BACKTEST_BUCKETS) target[bucket] = equal;
    return { target, limitMax, limitMin, fallback: true };
  }
  for (const item of scoped) target[item.assetBucket] = item.targetBps / sum;
  return { target, limitMax, limitMin, fallback: false };
}

/** 机会分映射乘数：>=70 -> 1.3、>=60 -> 1.15、>=40 -> 1、>=30 -> 0.85、<30 -> 0.65、缺失 -> 0.8。 */
function opportunityMultiplier(score: number | null | undefined): number {
  if (score === null || score === undefined) return 0.8;
  if (score >= 70) return 1.3;
  if (score >= 60) return 1.15;
  if (score >= 40) return 1;
  if (score >= 30) return 0.85;
  return 0.65;
}

/**
 * 评分驱动权重：机会分 -> 乘数，先钳到单桶上限再归一化。
 * limitMax 为空对象时即「无上限」的纯评分映射变体。
 */
export function scoreDrivenWeights(
  opportunity: Record<string, number | null>,
  target: Record<string, number>,
  limit: Record<string, number>,
): Record<string, number> {
  const raw: Record<string, number> = {};
  for (const bucket of BACKTEST_BUCKETS) {
    raw[bucket] = (target[bucket] ?? 0) * opportunityMultiplier(opportunity[bucket]);
  }
  // 注水分配：归一化 -> 超限钳制 -> 溢出按未用额度比例再分配，迭代至收敛。
  const out: Record<string, number> = { ...raw };
  for (let iteration = 0; iteration < 32; iteration += 1) {
    const total = BACKTEST_BUCKETS.reduce((acc, bucket) => acc + out[bucket], 0);
    if (total > 0) {
      for (const bucket of BACKTEST_BUCKETS) out[bucket] /= total;
    }
    let overflow = 0;
    for (const bucket of BACKTEST_BUCKETS) {
      const cap = limit[bucket];
      if (cap !== undefined && out[bucket] > cap) {
        overflow += out[bucket] - cap;
        out[bucket] = cap;
      }
    }
    if (overflow <= 1e-9) break;
    let room = 0;
    for (const bucket of BACKTEST_BUCKETS) {
      const cap = limit[bucket];
      if (cap !== undefined && out[bucket] < cap - 1e-9) room += cap - out[bucket];
      else if (cap === undefined) room += 1;
    }
    if (room <= 1e-9) break;
    for (const bucket of BACKTEST_BUCKETS) {
      const cap = limit[bucket];
      if (cap !== undefined) {
        if (out[bucket] < cap - 1e-9) out[bucket] += overflow * ((cap - out[bucket]) / room);
      } else {
        out[bucket] += overflow / room;
      }
    }
  }
  return out;
}

/** 组合层面的无交易带：候选权重与当前权重的 Σ|Δw| 低于该值时不交易（降低对小幅漂移的敏感性）。 */
export const STATE_GATED_NO_TRADE_BAND = 0.01;

/**
 * 状态门控权重（规格 §14 第 5 条「评分模型+仓位上限+迟滞」的忠实实现）：
 * - STRONG/LIGHT_ADD_ALLOWED：向 target×乘数配置（钳单桶上限）；
 * - HOLD：维持目标权重；
 * - REDUCE_CONSIDER：降到 target×0.65（不低于下限带）；
 * - DO_NOT_ADD / OVERWEIGHT / REASSESS_THESIS / LOW_CONFIDENCE：暂停——不加仓也不卖出，
 *   锁定漂移后的当前权重，活跃桶按剩余预算归一（新钱只流向允许增配的桶）；
 * - 候选权重与当前的 Σ|Δw| 不足无交易带时返回 null（本期不交易）。
 * 迟滞来自两层：状态本身经 3 日确认才切换；权重仅在状态迁移或漂移越带时调整。
 */
export function stateGatedWeights(
  states: Record<string, string | undefined>,
  drifted: Record<string, number>,
  target: Record<string, number>,
  limitMax: Record<string, number>,
  limitMin: Record<string, number>,
): Record<string, number> | null {
  const active: Record<string, number> = {};
  const paused: Record<string, number> = {};
  let pausedSum = 0;
  for (const bucket of BACKTEST_BUCKETS) {
    const current = drifted[bucket] ?? target[bucket] ?? 0;
    const base = target[bucket] ?? 0;
    const cap = limitMax[bucket];
    let desired: number;
    switch (states[bucket]) {
      case "STRONG_ADD_ALLOWED": desired = Math.min(cap ?? Number.POSITIVE_INFINITY, base * 1.3); break;
      case "LIGHT_ADD_ALLOWED": desired = Math.min(cap ?? Number.POSITIVE_INFINITY, base * 1.15); break;
      case "REDUCE_CONSIDER": desired = Math.max(limitMin[bucket] ?? 0, base * 0.65); break;
      case "HOLD": desired = base; break;
      // 暂停状态（含快照缺失）：锁定当前权重
      default: desired = current; break;
    }
    if (states[bucket] === undefined || states[bucket] === "DO_NOT_ADD" || states[bucket] === "OVERWEIGHT"
      || states[bucket] === "REASSESS_THESIS" || states[bucket] === "LOW_CONFIDENCE") {
      paused[bucket] = current;
      pausedSum += current;
    } else {
      active[bucket] = desired;
    }
  }
  const activeKeys = Object.keys(active);
  if (activeKeys.length === 0) return null;
  const budget = 1 - pausedSum;
  const rawSum = activeKeys.reduce((acc, bucket) => acc + active[bucket], 0);
  if (rawSum <= 0 || budget <= 1e-9) return null;

  const out: Record<string, number> = { ...paused };
  for (const bucket of activeKeys) out[bucket] = (active[bucket] / rawSum) * budget;
  // 双向钳制迭代：归一化后重新执行上限与下限带，残差在仍有移动空间的活跃桶间
  // 按可动空间比例分摊（触上限的桶让出预算、破下限的桶补回），迭代至收敛。
  // 无上限桶的有效上限取 1（权重超过 100% 无意义），保证分摊空间有限可算。
  const capOf = (bucket: string) => Math.min(limitMax[bucket] ?? 1, 1);
  const floorOf = (bucket: string) => limitMin[bucket] ?? 0;
  for (let iteration = 0; iteration < 32; iteration += 1) {
    let adjusted = 0;
    for (const bucket of activeKeys) {
      const clamped = Math.min(Math.max(out[bucket], floorOf(bucket)), capOf(bucket));
      adjusted += Math.abs(clamped - out[bucket]);
      out[bucket] = clamped;
    }
    if (adjusted <= 1e-9) break;
    const activeSum = activeKeys.reduce((acc, bucket) => acc + out[bucket], 0);
    const residual = budget - activeSum;
    if (Math.abs(residual) <= 1e-9) break;
    let room = 0;
    for (const bucket of activeKeys) {
      room += residual > 0 ? capOf(bucket) - out[bucket] : out[bucket] - floorOf(bucket);
    }
    if (room <= 1e-9) break;
    for (const bucket of activeKeys) {
      const movable = residual > 0 ? capOf(bucket) - out[bucket] : out[bucket] - floorOf(bucket);
      if (movable > 0) out[bucket] += residual * (movable / room);
    }
  }
  const traded = BACKTEST_BUCKETS.reduce((acc, bucket) => acc + Math.abs(out[bucket] - (drifted[bucket] ?? 0)), 0);
  if (traded < STATE_GATED_NO_TRADE_BAND) return null;
  return out;
}

export interface EquityPoint { date: string; nav: number; }

/**
 * 组合净值模拟：按 bucket 每期收益加权；rebalance(i, driftedWeights) 返回新权重时收取换手成本
 * （成本 = 成交比列 × costBps）。rebalance 返回的目标自本期末生效，
 * 即赚取 dates[i] -> dates[i+1] 区间收益；信号类策略应在回调里读 dates[i-1]
 * 的快照（T+1：上一评估日产生信号，本评估日收盘成交）。
 */
export function simulateEquity(
  dates: string[],
  bucketReturns: Record<string, number[]>,
  initialWeights: Record<string, number>,
  rebalance: ((index: number, driftedWeights: Record<string, number>) => Record<string, number> | null) | null,
  costBps: number,
): { equity: EquityPoint[]; tradeCount: number; turnoverBps: number } {
  let nav = 1;
  let weights = { ...initialWeights };
  const equity: EquityPoint[] = [{ date: dates[0], nav }];
  let tradeCount = 0;
  let turnoverBps = 0;
  for (let i = 1; i < dates.length; i += 1) {
    let portfolioReturn = 0;
    for (const bucket of BACKTEST_BUCKETS) {
      portfolioReturn += (weights[bucket] ?? 0) * (bucketReturns[bucket]?.[i - 1] ?? 0);
    }
    nav *= 1 + portfolioReturn;
    // 权重随收益漂移（持有收益的自然再平衡），再决定是否执行目标再平衡
    const drifted: Record<string, number> = {};
    let driftTotal = 0;
    for (const bucket of BACKTEST_BUCKETS) {
      const value = (weights[bucket] ?? 0) * (1 + (bucketReturns[bucket]?.[i - 1] ?? 0));
      drifted[bucket] = value;
      driftTotal += value;
    }
    if (driftTotal > 0) {
      for (const bucket of BACKTEST_BUCKETS) drifted[bucket] /= driftTotal;
      weights = drifted;
    }
    const next = rebalance ? rebalance(i, weights) : null;
    if (next) {
      const traded = BACKTEST_BUCKETS.reduce((acc, bucket) => acc + Math.abs((next[bucket] ?? 0) - (weights[bucket] ?? 0)), 0);
      if (traded > 1e-6) {
        nav *= 1 - traded * (costBps / 10000);
        turnoverBps += traded * 10000;
        tradeCount += BACKTEST_BUCKETS.filter((bucket) => Math.abs((next[bucket] ?? 0) - (weights[bucket] ?? 0)) > 1e-4).length;
      }
      weights = next;
    }
    equity.push({ date: dates[i], nav });
  }
  return { equity, tradeCount, turnoverBps: Math.round(turnoverBps) };
}

function std(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((acc, value) => acc + (value - mean) * (value - mean), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function calendarDaysBetween(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / 86_400_000;
}

/**
 * 净值曲线指标。波动率/夏普按实测平均区间长度年化（365.25 / 平均日间隔），
 * 不假设固定月度间距——增量刷新会混入非月末采样日，硬编码 sqrt(12) 会失真。
 * 最长回撤期 = 峰值到修复（或序列末日）的最长历时天数。
 */
export interface EquityMetrics {
  totalReturnBps: number;
  cagrBps: number;
  maxDrawdownBps: number;
  volatilityBps: number;
  sharpeMilli: number;
  /** 最差自然年区间收益（bps）；单点曲线无年度可算时为 null */
  worstYearBps: number | null;
  longestDrawdownDays: number;
}

export function metricsFromEquity(equity: EquityPoint[]): EquityMetrics {
  const first = equity[0];
  const last = equity[equity.length - 1];
  const totalReturn = last.nav - first.nav;
  const days = Math.max(1, calendarDaysBetween(first.date, last.date));
  const cagr = Math.pow(last.nav / first.nav, 365.25 / days) - 1;
  if (equity.length < 2) {
    return {
      totalReturnBps: Math.round(totalReturn * 10000),
      cagrBps: Math.round(cagr * 10000),
      maxDrawdownBps: 0,
      volatilityBps: 0,
      sharpeMilli: 0,
      worstYearBps: null,
      longestDrawdownDays: 0,
    };
  }

  let gapTotal = 0;
  let peak = first.nav;
  let peakDate = first.date;
  let underwater = false;
  let maxDrawdown = 0;
  let longestDrawdownDays = 0;
  const returns: number[] = [];
  for (let i = 1; i < equity.length; i += 1) {
    const point = equity[i];
    gapTotal += Math.max(1, calendarDaysBetween(equity[i - 1].date, point.date));
    if (point.nav > peak) {
      // 回撤段以严格超越前峰收尾时，穿越区间也计入回撤历时（否则少算最后一段）
      if (underwater) {
        longestDrawdownDays = Math.max(longestDrawdownDays, Math.round(calendarDaysBetween(peakDate, point.date)));
        underwater = false;
      }
      peak = point.nav;
      peakDate = point.date;
    } else {
      underwater = true;
      longestDrawdownDays = Math.max(longestDrawdownDays, Math.round(calendarDaysBetween(peakDate, point.date)));
      const drawdown = point.nav / peak - 1;
      if (drawdown < maxDrawdown) maxDrawdown = drawdown;
    }
    returns.push(point.nav / equity[i - 1].nav - 1);
  }
  const periodsPerYear = returns.length > 0 ? 365.25 / (gapTotal / returns.length) : 12;
  const vol = std(returns) * Math.sqrt(periodsPerYear);
  const mean = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const sd = std(returns);
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(periodsPerYear) : 0;

  // 最差年度：按自然年切分的区间收益（新年起点 = 上一年最后一个观测点）。
  // 只有含 >=2 个观测点的年度段才参与取最小值——序列首尾的单点残段
  // （如 8 月末截止的 2026 年残段之前的跨年单点）不代表完整年度表现。
  const yearReturns: number[] = [];
  let currentYear = first.date.slice(0, 4);
  let yearStartNav = first.nav;
  let previousNav = first.nav;
  let yearObservations = 1;
  for (let i = 1; i < equity.length; i += 1) {
    const point = equity[i];
    const year = point.date.slice(0, 4);
    if (year !== currentYear) {
      if (yearObservations >= 2) yearReturns.push(previousNav / yearStartNav - 1);
      yearStartNav = previousNav;
      currentYear = year;
      yearObservations = 0;
    }
    previousNav = point.nav;
    yearObservations += 1;
  }
  if (yearObservations >= 2) yearReturns.push(previousNav / yearStartNav - 1);

  return {
    totalReturnBps: Math.round(totalReturn * 10000),
    cagrBps: Math.round(cagr * 10000),
    maxDrawdownBps: Math.round(maxDrawdown * 10000),
    volatilityBps: Math.round(vol * 10000),
    sharpeMilli: Math.round(sharpe * 1000),
    worstYearBps: yearReturns.length > 0 ? Math.round(Math.min(...yearReturns) * 10000) : null,
    longestDrawdownDays,
  };
}

/**
 * 公共评估日网格合并：每个自然月只保留最后一个公共日期。
 * 增量刷新会在月中写入按日快照（如 2026-08-21 与 08-24 并存），不合并会让
 * 相邻几天的区间被当作整月计入波动率，并重复支付换手成本。
 */
export function coalesceToMonthEnd(dates: string[]): string[] {
  const byMonth = new Map<string, string>();
  for (const date of dates) byMonth.set(date.slice(0, 7), date);
  return Array.from(byMonth.values()).sort();
}

function quarterKey(date: string): string {
  const month = Number(date.slice(5, 7));
  return `${date.slice(0, 4)}-Q${Math.floor((month - 1) / 3) + 1}`;
}

export interface RebalanceContext {
  dates: string[];
  opportunityByDate: Record<string, Record<string, number | null>>;
  statesByDate: Record<string, Record<string, string>>;
  target: Record<string, number>;
  limitMax: Record<string, number>;
  limitMin: Record<string, number>;
}

/**
 * 策略 -> 再平衡回调。信号类策略滞后一格：index i 读 dates[i-1] 的快照，
 * 在 dates[i] 收盘成交（规格 §14「下一可交易时点执行」）。
 */
export function buildRebalance(
  strategyKey: StrategyKey,
  context: RebalanceContext,
): ((index: number, driftedWeights: Record<string, number>) => Record<string, number> | null) | null {
  const { dates } = context;
  switch (strategyKey) {
    case "BUY_AND_HOLD":
      return null;
    case "FIXED_MONTHLY":
      return () => ({ ...context.target });
    case "FIXED_QUARTERLY":
      return (index) => (quarterKey(dates[index]) !== quarterKey(dates[index - 1]) ? { ...context.target } : null);
    case "SCORE_TILT":
      return (index) => scoreDrivenWeights(context.opportunityByDate[dates[index - 1]] ?? {}, context.target, {});
    case "SCORE_TILT_CAPPED":
      return (index) => scoreDrivenWeights(context.opportunityByDate[dates[index - 1]] ?? {}, context.target, context.limitMax);
    case "STATE_GATED":
      return (index, driftedWeights) =>
        stateGatedWeights(context.statesByDate[dates[index - 1]] ?? {}, driftedWeights, context.target, context.limitMax, context.limitMin);
  }
}

export interface BacktestInput {
  dates: string[];
  bucketReturns: Record<string, number[]>;
  opportunityByDate: Record<string, Record<string, number | null>>;
  statesByDate: Record<string, Record<string, string>>;
  targets: TargetInput[];
  costBps?: number;
  warnings?: string[];
  now?: string;
}

/** 一次跑完六种策略并落库（同一批次号）。信号类策略读上一评估日快照：T+1 执行。 */
export async function runAllBacktests(input: BacktestInput): Promise<BacktestSummary[]> {
  const db = getDatabase();
  const { dates, bucketReturns, opportunityByDate, statesByDate } = input;
  const costBps = input.costBps ?? 10;
  const now = input.now ?? new Date().toISOString();
  const batchId = crypto.randomUUID();
  const { target: targetWeights, limitMax, limitMin, fallback } = normalizedTargets(input.targets);
  if (dates.length < 2) throw new Error("历史评分快照不足（需至少 2 个公共评估日）");
  const context: RebalanceContext = {
    dates,
    opportunityByDate,
    statesByDate,
    target: targetWeights,
    limitMax,
    limitMin,
  };

  const summaries: BacktestSummary[] = [];
  db.transaction((tx) => {
    for (const strategy of STRATEGIES) {
      const rebalance = buildRebalance(strategy.key, context);
      const { equity, tradeCount, turnoverBps } = simulateEquity(dates, bucketReturns, { ...targetWeights }, rebalance, costBps);
      const metrics = metricsFromEquity(equity);
      const runId = crypto.randomUUID();
      tx.insert(backtestRuns).values({
        id: runId,
        portfolioId: DEFAULT_PORTFOLIO_ID,
        strategy: strategy.key,
        status: "completed",
        startDate: dates[0],
        endDate: dates[dates.length - 1],
        transactionCostBps: costBps,
        batchId,
        inputsJson: JSON.stringify({
          buckets: BACKTEST_BUCKETS,
          targets: targetWeights,
          limits: { max: limitMax, min: limitMin },
          targetsFallback: fallback,
          signalLag: "T+1_NEXT_GRID_CLOSE",
          costBps,
          warnings: input.warnings ?? [],
        }),
        startedAt: now,
        completedAt: now,
        createdAt: now,
      }).run();
      tx.insert(backtestResults).values({
        id: crypto.randomUUID(),
        backtestRunId: runId,
        totalReturnBps: metrics.totalReturnBps,
        cagrBps: metrics.cagrBps,
        maxDrawdownBps: metrics.maxDrawdownBps,
        volatilityBps: metrics.volatilityBps,
        sharpeMilli: metrics.sharpeMilli,
        worstYearBps: metrics.worstYearBps,
        longestDrawdownDays: metrics.longestDrawdownDays,
        turnoverBps,
        tradeCount,
        seriesJson: JSON.stringify({ dates: equity.map((point) => point.date), nav: equity.map((point) => point.nav) }),
        createdAt: now,
      }).run();
      summaries.push({
        runId,
        batchId,
        strategy: strategy.key,
        startDate: dates[0],
        endDate: dates[dates.length - 1],
        totalReturnBps: metrics.totalReturnBps,
        cagrBps: metrics.cagrBps,
        maxDrawdownBps: metrics.maxDrawdownBps,
        volatilityBps: metrics.volatilityBps,
        sharpeMilli: metrics.sharpeMilli,
        worstYearBps: metrics.worstYearBps,
        longestDrawdownDays: metrics.longestDrawdownDays,
        turnoverBps,
        tradeCount,
        finalNav: equity[equity.length - 1].nav,
      });
    }
  });
  return summaries;
}

/** 从数据库组装回测输入（点内时间：评分快照公共评估日网格 + PRICE_CLOSE 前值收益 + 已确认状态）。 */
export async function loadBacktestInput(): Promise<BacktestInput> {
  const db = getDatabase();
  const targetRows = db.select().from(allocationTargets).where(eq(allocationTargets.portfolioId, DEFAULT_PORTFOLIO_ID)).all();
  const targets = targetRows.map((row) => ({ assetBucket: row.assetBucket, targetBps: row.targetBps, minBps: row.minBps, maxBps: row.maxBps }));
  const snapshotRows = db.select({
    asOf: scoreSnapshots.asOf,
    bucket: scoreSnapshots.assetBucket,
    opportunity: scoreSnapshots.opportunityScore,
    state: scoreSnapshots.recommendationState,
  }).from(scoreSnapshots).where(and(
    eq(scoreSnapshots.portfolioId, DEFAULT_PORTFOLIO_ID),
    inArray(scoreSnapshots.assetBucket, BACKTEST_BUCKETS),
  )).orderBy(asc(scoreSnapshots.asOf)).all();
  const byBucket = new Map<string, Map<string, number>>();
  const statesByBucket = new Map<string, Map<string, string>>();
  for (const bucket of BACKTEST_BUCKETS) {
    byBucket.set(bucket, new Map());
    statesByBucket.set(bucket, new Map());
  }
  for (const row of snapshotRows) {
    if (row.opportunity !== null) byBucket.get(row.bucket)?.set(row.asOf, row.opportunity);
    statesByBucket.get(row.bucket)?.set(row.asOf, row.state);
  }
  const allDates = Array.from(new Set(snapshotRows.map((row) => row.asOf))).sort();
  const commonDates = allDates.filter((date) => BACKTEST_BUCKETS.every((bucket) => byBucket.get(bucket)!.has(date)));
  const dates = coalesceToMonthEnd(commonDates);
  if (dates.length < 2) throw new Error("历史评分快照不足（需至少 2 个公共评估日）");
  const priceRows = db.select({
    asOf: metricObservations.asOf,
    bucket: metricObservations.subjectId,
    value: metricObservations.value,
  }).from(metricObservations).where(and(
    eq(metricObservations.metricKey, "PRICE_CLOSE"),
    inArray(metricObservations.subjectId, BACKTEST_BUCKETS),
    lte(metricObservations.asOf, dates[dates.length - 1]),
  )).orderBy(asc(metricObservations.asOf)).all();
  const prices = new Map<string, Array<{ asOf: string; value: number }>>();
  for (const bucket of BACKTEST_BUCKETS) prices.set(bucket, []);
  for (const row of priceRows) prices.get(row.bucket)?.push({ asOf: row.asOf, value: Number(row.value) });
  const priceAt = (bucket: string, date: string): number | null => {
    const series = prices.get(bucket) ?? [];
    let best: number | null = null;
    for (const point of series) {
      if (point.asOf > date) break;
      best = point.value;
    }
    return best;
  };
  const warnings: string[] = [];
  const bucketReturns: Record<string, number[]> = {};
  for (const bucket of BACKTEST_BUCKETS) {
    const returns: number[] = [];
    let missingIntervals = 0;
    for (let i = 1; i < dates.length; i += 1) {
      const previous = priceAt(bucket, dates[i - 1]);
      const current = priceAt(bucket, dates[i]);
      if (previous === null || current === null || previous <= 0) {
        // 序列起点晚于回测起点或端点缺价：按 0% 处理但必须显式告警，不允许静默。
        missingIntervals += 1;
        returns.push(0);
        continue;
      }
      returns.push(current / previous - 1);
    }
    if (missingIntervals > 0) {
      warnings.push(`${bucket} 有 ${missingIntervals} 个评估区间缺少 PRICE_CLOSE，已按 0% 收益处理`);
    }
    bucketReturns[bucket] = returns;
  }
  const opportunityByDate: Record<string, Record<string, number | null>> = {};
  const statesByDate: Record<string, Record<string, string>> = {};
  for (const date of dates) {
    const entry: Record<string, number | null> = {};
    const stateEntry: Record<string, string> = {};
    for (const bucket of BACKTEST_BUCKETS) {
      entry[bucket] = byBucket.get(bucket)!.get(date) ?? null;
      const state = statesByBucket.get(bucket)!.get(date);
      if (state) stateEntry[bucket] = state;
    }
    opportunityByDate[date] = entry;
    statesByDate[date] = stateEntry;
  }
  return { dates, bucketReturns, opportunityByDate, statesByDate, targets, costBps: 10, warnings };
}
