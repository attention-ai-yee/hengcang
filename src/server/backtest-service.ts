import { and, asc, eq, inArray, lte } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import { DEFAULT_PORTFOLIO_ID } from "@/db/queries";
import { allocationTargets, backtestResults, backtestRuns, metricObservations, scoreSnapshots } from "@/db/schema";
import type { ScorableAssetBucket } from "@/domain/types";

/** 回测只覆盖四只参与评分的资产桶（现金/其他桶不参与权益模拟）。 */
export const BACKTEST_BUCKETS = ["GOLD", "VALUE_DIVIDEND", "TECH_GROWTH", "BROAD_EQUITY"] as ScorableAssetBucket[];

export const STRATEGIES = [
  { key: "BUY_AND_HOLD", label: "Buy & Hold", cn: "持有基准" },
  { key: "FIXED_ALLOCATION", label: "Fixed Allocation", cn: "固定比例再平衡" },
  { key: "SCORE_DRIVEN", label: "Score Driven", cn: "评分 + 上限 + 迟滞" },
] as const;
export type StrategyKey = (typeof STRATEGIES)[number]["key"];

export interface BacktestSummary {
  runId: string;
  strategy: StrategyKey;
  startDate: string;
  endDate: string;
  totalReturnBps: number;
  cagrBps: number;
  maxDrawdownBps: number;
  volatilityBps: number;
  sharpeMilli: number;
  turnoverBps: number;
  tradeCount: number;
  finalNav: number;
}

interface TargetInput { assetBucket: string; targetBps: number; maxBps: number; }

export function normalizedTargets(targets: TargetInput[]): { target: Record<string, number>; limit: Record<string, number> } {
  const scoped = targets.filter((item) => (BACKTEST_BUCKETS as readonly string[]).includes(item.assetBucket));
  const sum = scoped.reduce((acc, item) => acc + item.targetBps, 0);
  const target: Record<string, number> = {};
  const limit: Record<string, number> = {};
  if (sum <= 0) {
    const equal = 1 / BACKTEST_BUCKETS.length;
    for (const bucket of BACKTEST_BUCKETS) target[bucket] = equal;
    return { target, limit };
  }
  for (const item of scoped) {
    target[item.assetBucket] = item.targetBps / sum;
    limit[item.assetBucket] = item.maxBps / 10000;
  }
  return { target, limit };
}

/**
 * 评分驱动权重：机会分映射乘数（>=70 -> 1.3、60-70 -> 1.15、40-60 -> 1、
 * 30-40 -> 0.85、<30 -> 0.65、缺失 -> 0.8），先钳到单桶上限再归一化。
 */
export function scoreDrivenWeights(
  opportunity: Record<string, number | null>,
  target: Record<string, number>,
  limit: Record<string, number>,
): Record<string, number> {
  const raw: Record<string, number> = {};
  for (const bucket of BACKTEST_BUCKETS) {
    const score = opportunity[bucket];
    const multiplier = score === null ? 0.8 : score >= 70 ? 1.3 : score >= 60 ? 1.15 : score >= 40 ? 1 : score >= 30 ? 0.85 : 0.65;
    raw[bucket] = (target[bucket] ?? 0) * multiplier;
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

export interface EquityPoint { date: string; nav: number; }

/**
 * 组合净值模拟：按 bucket 每期收益加权；rebalance(i) 返回新权重时收取换手成本
 * （成本 = 成交比列 × costBps）。
 */
export function simulateEquity(
  dates: string[],
  bucketReturns: Record<string, number[]>,
  initialWeights: Record<string, number>,
  rebalance: ((index: number) => Record<string, number> | null) | null,
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
    const next = rebalance ? rebalance(i) : null;
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

export function metricsFromEquity(equity: EquityPoint[]): { totalReturnBps: number; cagrBps: number; maxDrawdownBps: number; volatilityBps: number; sharpeMilli: number } {
  const first = equity[0];
  const last = equity[equity.length - 1];
  const totalReturn = last.nav - 1;
  const days = Math.max(1, (Date.parse(last.date) - Date.parse(first.date)) / 86_400_000);
  const cagr = Math.pow(last.nav, 365.25 / days) - 1;
  let peak = first.nav;
  let maxDrawdown = 0;
  const returns: number[] = [];
  for (let i = 1; i < equity.length; i += 1) {
    const nav = equity[i].nav;
    if (nav > peak) peak = nav;
    const drawdown = nav / peak - 1;
    if (drawdown < maxDrawdown) maxDrawdown = drawdown;
    returns.push(nav / equity[i - 1].nav - 1);
  }
  const vol = std(returns) * Math.sqrt(12);
  const mean = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const sd = std(returns);
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(12) : 0;
  return {
    totalReturnBps: Math.round(totalReturn * 10000),
    cagrBps: Math.round(cagr * 10000),
    maxDrawdownBps: Math.round(maxDrawdown * 10000),
    volatilityBps: Math.round(vol * 10000),
    sharpeMilli: Math.round(sharpe * 1000),
  };
}

export interface BacktestInput {
  dates: string[];
  bucketReturns: Record<string, number[]>;
  opportunityByDate: Record<string, Record<string, number | null>>;
  targets: TargetInput[];
  costBps?: number;
  now?: string;
}

/** 一次跑完三种策略并落库（BUY_AND_HOLD / FIXED_ALLOCATION / SCORE_DRIVEN）。 */
export async function runAllBacktests(input: BacktestInput): Promise<BacktestSummary[]> {
  const db = getDatabase();
  const { dates, bucketReturns, opportunityByDate } = input;
  const costBps = input.costBps ?? 10;
  const now = input.now ?? new Date().toISOString();
  const { target: targetWeights, limit: limits } = normalizedTargets(input.targets);
  if (dates.length < 2) throw new Error("历史评分快照不足（需至少 2 个公共评估日）");
  const summaries: BacktestSummary[] = [];
  db.transaction((tx) => {
    for (const strategy of STRATEGIES) {
      let rebalance: ((index: number) => Record<string, number> | null) | null = null;
      if (strategy.key === "FIXED_ALLOCATION") rebalance = () => ({ ...targetWeights });
      if (strategy.key === "SCORE_DRIVEN") rebalance = (index) => scoreDrivenWeights(opportunityByDate[dates[index]] ?? {}, targetWeights, limits);
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
        inputsJson: JSON.stringify({ buckets: BACKTEST_BUCKETS, targets: targetWeights, costBps }),
        startedAt: now,
        completedAt: now,
        createdAt: now,
      }).run();
      tx.insert(backtestResults).values({
        id: crypto.randomUUID(),
        backtestRunId: runId,
        cagrBps: metrics.cagrBps,
        maxDrawdownBps: metrics.maxDrawdownBps,
        volatilityBps: metrics.volatilityBps,
        sharpeMilli: metrics.sharpeMilli,
        turnoverBps,
        tradeCount,
        seriesJson: JSON.stringify({ dates: equity.map((point) => point.date), nav: equity.map((point) => point.nav) }),
        createdAt: now,
      }).run();
      summaries.push({
        runId,
        strategy: strategy.key,
        startDate: dates[0],
        endDate: dates[dates.length - 1],
        totalReturnBps: metrics.totalReturnBps,
        cagrBps: metrics.cagrBps,
        maxDrawdownBps: metrics.maxDrawdownBps,
        volatilityBps: metrics.volatilityBps,
        sharpeMilli: metrics.sharpeMilli,
        turnoverBps,
        tradeCount,
        finalNav: equity[equity.length - 1].nav,
      });
    }
  });
  return summaries;
}

/** 从数据库组装回测输入（点内时间：评分快照公共评估日 + PRICE_CLOSE 前值）。 */
export async function loadBacktestInput(): Promise<BacktestInput> {
  const db = getDatabase();
  const targetRows = db.select().from(allocationTargets).where(eq(allocationTargets.portfolioId, DEFAULT_PORTFOLIO_ID)).all();
  const targets = targetRows.map((row) => ({ assetBucket: row.assetBucket, targetBps: row.targetBps, maxBps: row.maxBps }));
  const snapshotRows = db.select({
    asOf: scoreSnapshots.asOf,
    bucket: scoreSnapshots.assetBucket,
    opportunity: scoreSnapshots.opportunityScore,
  }).from(scoreSnapshots).where(and(
    eq(scoreSnapshots.portfolioId, DEFAULT_PORTFOLIO_ID),
    inArray(scoreSnapshots.assetBucket, BACKTEST_BUCKETS),
  )).orderBy(asc(scoreSnapshots.asOf)).all();
  const byBucket = new Map<string, Map<string, number>>();
  for (const bucket of BACKTEST_BUCKETS) {
    byBucket.set(bucket, new Map());
    for (const row of snapshotRows) {
      if (row.bucket === bucket && row.opportunity !== null) byBucket.get(bucket)!.set(row.asOf, row.opportunity);
    }
  }
  const allDates = Array.from(new Set(snapshotRows.map((row) => row.asOf))).sort();
  const dates = allDates.filter((date) => BACKTEST_BUCKETS.every((bucket) => byBucket.get(bucket)!.has(date)));
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
  const bucketReturns: Record<string, number[]> = {};
  for (const bucket of BACKTEST_BUCKETS) {
    const returns: number[] = [];
    for (let i = 1; i < dates.length; i += 1) {
      const previous = priceAt(bucket, dates[i - 1]);
      const current = priceAt(bucket, dates[i]);
      returns.push(previous !== null && current !== null && previous > 0 ? current / previous - 1 : 0);
    }
    bucketReturns[bucket] = returns;
  }
  const opportunityByDate: Record<string, Record<string, number | null>> = {};
  for (const date of dates) {
    const entry: Record<string, number | null> = {};
    for (const bucket of BACKTEST_BUCKETS) entry[bucket] = byBucket.get(bucket)!.get(date) ?? null;
    opportunityByDate[date] = entry;
  }
  return { dates, bucketReturns, opportunityByDate, targets, costBps: 10 };
}