import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { and, eq } from "drizzle-orm";
import { closeDatabase, getDatabase } from "@/db/client";
import { portfolios, scoreSnapshots } from "@/db/schema";
import type { FredProvider } from "@/providers/fred";
import type { TushareProvider } from "@/providers/tushare";
import type { DailyBasicRow, EquityFundamentalSnapshot, IndexWeightPoint } from "@/providers/tushare/index-aggregator";
import type { MetricPoint, PricePoint, ProviderResult } from "@/providers/types";
import { refreshAutomaticMarketData } from "@/server/automatic-data-refresh-service";

/**
 * 端到端核算（2026-10-31）：用确定性的合成数据跑完整的「拉数 → 入库 → 汇总 → 评分」，
 * 再在测试里按规格独立重算一遍便宜程度、趋势和配置吸引力分，逐项对比。
 * 重点覆盖这次修的三处：估值分位只看近 5 年、按月取样、一条序列只用一个来源（官方指数估值）。
 */
const testDatabase = path.join(os.tmpdir(), `hengcang-pipeline-${randomUUID()}.db`);
const previousDatabaseUrl = process.env.DATABASE_URL;
const NOW = new Date("2026-10-30T10:00:00Z");
const EVAL = "2026-10-30";
const WINDOW_START = "2021-10-30";

const INDEXES = { VALUE_DIVIDEND: "000016.SH", TECH_GROWTH: "399006.SZ", BROAD_EQUITY: "000300.SH" } as const;
const PHASE: Record<string, number> = { "Au99.99": 0.3, "000016.SH": 1.1, "399006.SZ": 2.3, "000300.SH": 4.0 };

function tradingDays(start: string, end: string): string[] {
  const days: string[] = [];
  for (let ms = Date.parse(`${start}T00:00:00Z`); ms <= Date.parse(`${end}T00:00:00Z`); ms += 86_400_000) {
    const day = new Date(ms);
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) days.push(day.toISOString().slice(0, 10));
  }
  return days;
}
const ALL_DAYS = tradingDays("2020-06-01", EVAL);
const DAY_INDEX = new Map(ALL_DAYS.map((day, index) => [day, index]));
const t = (day: string) => DAY_INDEX.get(day) ?? 0;

const close = (symbol: string, day: string) => 1000 * (1 + 0.25 * Math.sin((2 * Math.PI * t(day)) / 400 + PHASE[symbol])) + 0.2 * t(day);
const officialPe = (symbol: string, day: string) => 12 + 3 * Math.sin((2 * Math.PI * t(day)) / 300 + PHASE[symbol]);
const officialPb = (symbol: string, day: string) => 1.3 + 0.3 * Math.sin((2 * Math.PI * t(day)) / 350 + PHASE[symbol]);
const constituents = (index: string) => ["A", "B", "C"].map((letter) => `${index}-${letter}`);
const CONSTITUENT_WEIGHTS = [0.5, 0.3, 0.2];

function ok<T>(data: T): ProviderResult<T> {
  return { ok: true, data, provider: "tushare", fetchedAt: NOW.toISOString(), quality: "VALID" };
}

const valuationRanges: Array<{ symbol: string; start: string; end: string }> = [];

const fakeTushare = {
  async getPriceSeries(request: { symbol: string; range: { start: string; end: string } }) {
    return ok<PricePoint[]>(tradingDays(request.range.start, request.range.end).map((day) => ({
      observedAt: `${day}T15:00:00+08:00`, availableAt: `${day}T18:00:00+08:00`, asOf: day,
      close: close(request.symbol, day).toFixed(4), currency: "CNY",
    })));
  },
  async getIndexWeights(indexSymbol: string, range: { start: string; end: string }) {
    return ok<IndexWeightPoint[]>(constituents(indexSymbol).map((constituentSymbol, index) => ({
      indexSymbol, constituentSymbol, effectiveDate: range.end, weight: CONSTITUENT_WEIGHTS[index] * 100,
    })));
  },
  async getMarketDailyBasics(date: string) {
    return ok<DailyBasicRow[]>(Object.values(INDEXES).flatMap((index) => constituents(index).map((symbol, k) => ({
      // 成分股估值与官方指数估值口径不同（故意错开）：一条序列若混用两种来源，分位会和官方口径对不上
      symbol, tradeDate: date, peTtm: officialPe(index, date) * [0.8, 1.0, 1.5][k], pb: officialPb(index, date) * [0.9, 1.0, 1.2][k],
      psTtm: 2 + 0.3 * Math.sin(t(date) / 50 + k), dividendYield: 3 + 0.5 * Math.sin(t(date) / 70 + k),
    }))));
  },
  async getValuationMetrics(request: { symbol: string; metrics: string[]; range?: { start: string; end: string } }) {
    const range = request.range ?? { start: EVAL, end: EVAL };
    valuationRanges.push({ symbol: request.symbol, ...range });
    return ok<MetricPoint[]>(tradingDays(range.start, range.end).flatMap((day) => [
      { key: "PE_TTM", value: officialPe(request.symbol, day).toFixed(6), unit: "ratio", observedAt: `${day}T15:00:00+08:00`, availableAt: `${day}T18:00:00+08:00`, asOf: day },
      { key: "PB", value: officialPb(request.symbol, day).toFixed(6), unit: "ratio", observedAt: `${day}T15:00:00+08:00`, availableAt: `${day}T18:00:00+08:00`, asOf: day },
    ].filter((point) => request.metrics.includes(point.key))));
  },
  async getEquityFundamentals(symbol: string) {
    const reports: EquityFundamentalSnapshot[] = [];
    for (let year = 2021; year <= 2026; year += 1) {
      for (const [quarter, monthDay] of [[1, "03-31"], [2, "06-30"], [3, "09-30"], [4, "12-31"]] as const) {
        const reportPeriod = `${year}-${monthDay}`;
        const announced = new Date(Date.parse(`${reportPeriod}T00:00:00Z`) + 25 * 86_400_000).toISOString().slice(0, 10);
        if (announced > EVAL) continue;
        const growth = 12 + 4 * Math.sin(year * 4 + quarter);
        reports.push({ symbol, reportPeriod, availableAt: `${announced}T08:00:00+08:00`, roe: 10, earningsGrowth: growth, revenueGrowth: growth + 3, quarterEarningsGrowth: growth - 3, quarterRevenueGrowth: growth });
      }
    }
    return ok(reports);
  },
  async getEquityDividendHistory(symbol: string) {
    return ok([2021, 2022, 2023, 2024, 2025, 2026].map((year) => ({
      symbol, announcementDate: `${year}-04-20`, reportPeriod: `${year - 1}-12-31`, procedure: "实施",
      cashDividend: 0.5, recordDate: `${year}-06-20`, exDate: `${year}-06-21`, payDate: `${year}-06-21`,
    })));
  },
  async getFundShare() { return ok([]); },
  async getFundNavForFlow() { return ok([]); },
};

const fakeFred = {
  async getMacroSeries() {
    return { ok: false, provider: "fred", fetchedAt: NOW.toISOString(), error: { code: "NOT_CONFIGURED", message: "测试不配 FRED" }, fallbackAllowed: true };
  },
};

/** 规格 §3：中位秩分位（含当前值），不依赖引擎代码 */
function midRank(current: number, values: number[]): number {
  return (values.filter((value) => value < current).length + values.filter((value) => value === current).length / 2) / values.length;
}
const round1 = (value: number) => Math.round((value + Number.EPSILON) * 10) / 10;
const band = (distancePct: number, halfBand: number) => Math.min(100, Math.max(0, 50 + (distancePct / halfBand) * 50));
/** 近 5 年、每个自然月最后一个交易日（当月就是评估日） */
function monthEnds(days: string[]): string[] {
  const last = new Map<string, string>();
  for (const day of days) if (day > WINDOW_START && day <= EVAL) last.set(day.slice(0, 7), day);
  return [...last.values()];
}
/** 入库值保留 4 位（价格）/ 6 位（估值），重算也用同样的数 */
const storedClose = (symbol: string, day: string) => Number(close(symbol, day).toFixed(4));
const storedPe = (symbol: string, day: string) => Number(officialPe(symbol, day).toFixed(6));
const storedPb = (symbol: string, day: string) => Number(officialPb(symbol, day).toFixed(6));

interface StoredComponent { score: number | null; percentile: number | null; source: string; weight: number; confidence: string }

function latestSnapshot(bucket: string) {
  const row = getDatabase().select().from(scoreSnapshots)
    .where(and(eq(scoreSnapshots.assetBucket, bucket), eq(scoreSnapshots.asOf, EVAL))).get();
  if (!row) throw new Error(`${bucket} 没有 ${EVAL} 的评分`);
  return { row, components: (JSON.parse(row.componentsJson) as { components: Record<string, StoredComponent> }).components };
}

function expectedTrend(symbol: string) {
  const days = ALL_DAYS.filter((day) => day <= EVAL);
  const closes = days.map((day) => storedClose(symbol, day));
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const last = closes.length - 1;
  const ma = (window: number) => mean(closes.slice(last + 1 - window));
  const ma20 = ma(20);
  const ma60 = ma(60);
  const ma200 = ma(200);
  const ma200Score = band((closes[last] / ma200 - 1) * 100, 5);
  const alignment = band((ma20 / ma60 - 1) * 100, 5) * 0.35 + band((ma60 / ma200 - 1) * 100, 10) * 0.65;
  const momentum = days.map((day, index) => (index >= 126 ? { day, value: closes[index] / closes[index - 126] - 1 } : null))
    .filter((point): point is { day: string; value: number } => point !== null && point.day > WINDOW_START);
  const momentumScore = round1(midRank(momentum.at(-1)!.value, momentum.map((point) => point.value)) * 100);
  return round1((ma200Score * 0.4 + alignment * 0.3 + momentumScore * 0.3) / 1.0);
}

beforeAll(async () => {
  process.env.DATABASE_URL = testDatabase;
  const db = getDatabase();
  migrate(db, { migrationsFolder: path.resolve("drizzle") });
  db.insert(portfolios).values({ id: "default", name: "测试组合", baseCurrency: "CNY", reservedCashMinor: "0", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() }).run();
  // WGC 全球 ETF 流量走公网：测试里让它失败，走国内代理（空）
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
  await refreshAutomaticMarketData({
    provider: fakeTushare as unknown as TushareProvider,
    fredProvider: fakeFred as unknown as FredProvider,
    now: NOW,
    fullBackfill: true,
  });
}, 120_000);

afterAll(() => {
  vi.unstubAllGlobals();
  closeDatabase();
  process.env.DATABASE_URL = previousDatabaseUrl;
  for (const suffix of ["", "-wal", "-shm"]) {
    const filename = `${testDatabase}${suffix}`;
    if (fs.existsSync(filename)) fs.rmSync(filename);
  }
});

describe("刷新 + 评分全链路核算（合成数据，测试内独立重算）", () => {
  it("全量回填按 5 年窗口拉官方指数估值（原来只拉当月）", () => {
    for (const symbol of Object.values(INDEXES)) {
      expect(valuationRanges.find((range) => range.symbol === symbol)).toMatchObject({ start: "2021-10-30", end: EVAL });
    }
  });

  it("宽基便宜程度：PE/PB 只用官方口径、近 5 年月末取样、中位秩，与独立重算一致", () => {
    const { row, components } = latestSnapshot("BROAD_EQUITY");
    const symbol = INDEXES.BROAD_EQUITY;
    const samples = monthEnds(ALL_DAYS);
    expect(samples).toHaveLength(60);
    const pePct = midRank(storedPe(symbol, EVAL), samples.map((day) => storedPe(symbol, day)));
    const pbPct = midRank(storedPb(symbol, EVAL), samples.map((day) => storedPb(symbol, day)));
    expect(components["cheapness.pe"]).toMatchObject({ source: "tushare", percentile: round1(pePct * 100), score: round1((1 - pePct) * 100) });
    expect(components["cheapness.pb"]).toMatchObject({ source: "tushare", percentile: round1(pbPct * 100), score: round1((1 - pbPct) * 100) });
    // 没有实际利率就没有 ERP，用 PE 60% + PB 40%
    const cheapness = round1((round1((1 - pePct) * 100) * 0.6 + round1((1 - pbPct) * 100) * 0.4) / 1.0);
    expect(row.cheapnessScore).toBe(cheapness);
    const trend = expectedTrend(symbol);
    expect(row.trendScore).toBe(trend);
    expect(row.opportunityScore).toBe(round1((cheapness * 0.7 + trend * 0.3) / 1.0));
  });

  it("增速体检用单季同比（全量回填算出完整的单季历史，上一期可比）", () => {
    for (const [bucket, label] of [["BROAD_EQUITY", "指数盈利同比（单季）"], ["TECH_GROWTH", "盈利同比（单季）"], ["VALUE_DIVIDEND", "盈利同比（单季）"]] as const) {
      const health = (JSON.parse(latestSnapshot(bucket).row.componentsJson) as { fundamentalHealth: { checks: Array<{ label: string; status: string; previous: unknown }> } }).fundamentalHealth;
      expect(health.checks[0]).toMatchObject({ label, status: "OK" });
      expect(health.checks[0].previous).not.toBeNull();
    }
  });

  it("红利便宜程度：股息率用成分股汇总（唯一来源）；PE 仍用官方口径", () => {
    const { components } = latestSnapshot("VALUE_DIVIDEND");
    expect(components["cheapness.pe"].source).toBe("tushare");
    expect(components["cheapness.dividendYield"].source).toBe("tushare-index-aggregate");
    expect(components["cheapness.dividendYield"].score).not.toBeNull();
  });

  it("黄金：金价位置、距 MA200、3 个月动量按日频、近 5 年计算，与独立重算一致", () => {
    const { row, components } = latestSnapshot("GOLD");
    const symbol = "Au99.99";
    const days = ALL_DAYS.filter((day) => day <= EVAL);
    const closes = days.map((day) => storedClose(symbol, day));
    const inWindow = (index: number) => days[index] > WINDOW_START;
    const positionValues = closes.filter((_, index) => inWindow(index));
    const positionPct = midRank(closes.at(-1)!, positionValues);
    expect(components["cheapness.longTermPricePosition"].percentile).toBe(round1(positionPct * 100));
    const ma200At = (index: number) => closes.slice(index - 199, index + 1).reduce((sum, value) => sum + value, 0) / 200;
    const distances = closes.map((value, index) => (index >= 199 && inWindow(index) ? value / ma200At(index) - 1 : null)).filter((value): value is number => value !== null);
    expect(components["cheapness.distanceFromMa200"].percentile).toBe(round1(midRank(distances.at(-1)!, distances) * 100));
    const momentum = closes.map((value, index) => (index >= 63 && inWindow(index) ? value / closes[index - 63] - 1 : null)).filter((value): value is number => value !== null);
    expect(components["cheapness.momentumCrowding"].percentile).toBe(round1(midRank(momentum.at(-1)!, momentum) * 100));
    expect(row.trendScore).toBe(expectedTrend(symbol));
  });

  it("全量回填之后的增量刷新不报错、分数照常更新（原来派生行带着来源行的主键，写回时冲突，每次增量刷新都失败）", async () => {
    const report = await refreshAutomaticMarketData({
      provider: fakeTushare as unknown as TushareProvider,
      fredProvider: fakeFred as unknown as FredProvider,
      now: new Date("2026-10-30T12:00:00Z"),
      fullBackfill: false,
    });
    expect(report.status).not.toBe("ERROR");
    expect(report.buckets.every((bucket) => bucket.scoreSaved)).toBe(true);
    expect(latestSnapshot("BROAD_EQUITY").row.opportunityScore).not.toBeNull();
  }, 120_000);

  it("周末刷新：分红稳定性记在最后一个交易日，最新评分看得到（原来记成周六，体检退回去年年底那行、判缺数据）", async () => {
    await refreshAutomaticMarketData({
      provider: fakeTushare as unknown as TushareProvider,
      fredProvider: fakeFred as unknown as FredProvider,
      now: new Date("2026-10-31T10:00:00Z"),
      fullBackfill: true,
    });
    const row = getDatabase().select().from(scoreSnapshots)
      .where(and(eq(scoreSnapshots.assetBucket, "VALUE_DIVIDEND"), eq(scoreSnapshots.asOf, EVAL))).get();
    const health = (JSON.parse(row!.componentsJson) as { fundamentalHealth: { checks: Array<{ key: string; status: string; latest: { asOf: string } | null }> } }).fundamentalHealth;
    expect(health.checks.find((check) => check.key === "dividendStability")).toMatchObject({ status: "OK", latest: { asOf: EVAL } });
  }, 120_000);

  it("科技：PEG 由官方 PE 与汇总增速按日期对齐得出，有完整历史（不再只剩重合的几天）", () => {
    const { components } = latestSnapshot("TECH_GROWTH");
    expect(components["cheapness.pe"].source).toBe("tushare");
    expect(components["cheapness.growthAdjustedValuation"].source).toBe("DERIVED:PEG_TTM:tushare-index-aggregate");
    expect(components["cheapness.growthAdjustedValuation"].score).not.toBeNull();
    expect(components["cheapness.growthAdjustedValuation"].confidence).toBe("HIGH");
  });
});
