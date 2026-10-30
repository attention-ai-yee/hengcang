import { and, eq, inArray } from "drizzle-orm";
import { shanghaiDate } from "@/lib/shanghai";
import { getDatabase } from "@/db/client";
import { dataSourceStatus, metricObservations } from "@/db/schema";
import type { ScorableAssetBucket } from "@/domain/types";
import type { CanonicalMetricKey } from "@/metrics/catalog";
import { commitProviderMetricObservations, type ProviderMetricObservationInput } from "@/metrics/observation-repository";
import { FredProvider } from "@/providers/fred";
import { aggregateDividendYield, aggregateFundamentalMetric, aggregateHarmonicMetric, type AggregateMetricResult, type EquityFundamentalSnapshot, type IndexWeightPoint } from "@/providers/tushare/index-aggregator";
import { cacheIndexWeights, readLatestIndexWeightSnapshot, readLatestIndexWeights } from "@/providers/tushare/index-weight-cache";
import { scoreDividendStability } from "@/providers/tushare/dividend-stability";
import type { TushareDividendRecord } from "@/providers/tushare/index";
import { calculateGoldEtfFlow3m } from "@/providers/tushare/gold-etf-flow";
import { fetchWgcGlobalMonthlyFlows } from "@/providers/wgc";
import { TushareProvider } from "@/providers/tushare";
import { getGoldEtfProxies, getTushareScoreProxies, type TushareScoreProxy } from "@/providers/tushare/proxies";
import type { MetricPoint, PricePoint, ProviderResult } from "@/providers/types";
import { refreshScoresForBuckets } from "./scoring-refresh-service";

interface BucketRefreshReport { bucket: ScorableAssetBucket; proxy: string; symbol: string; observationCount: number; latestAsOf: string | null; scoreSaved: boolean; warnings: string[]; }
export interface AutomaticRefreshReport { provider: "tushare"; status: "READY" | "DEGRADED" | "ERROR" | "NOT_CONFIGURED"; fetchedAt: string; inserted: number; updated: number; buckets: BucketRefreshReport[]; }
interface AutomaticRefreshOptions { provider?: TushareProvider; fredProvider?: FredProvider; now?: Date; proxies?: TushareScoreProxy[]; fullBackfill?: boolean; }
const AGGREGATE_PROVIDER = "tushare-index-aggregate";

const WEIGHT_MAX_AGE_DAYS = 120;

/** 读成分权重并检查时效（Code Review M17）：上游停更后旧名单照用会静默失真，超龄降级。 */
function readWeightsWithAge(indexSymbol: string, date: string, warnings: string[]): { points: IndexWeightPoint[]; stale: boolean } | null {
  const snapshot = readLatestIndexWeightSnapshot(indexSymbol, date);
  if (!snapshot.points.length) return null;
  let stale = false;
  if (snapshot.ageDays !== null && snapshot.ageDays > WEIGHT_MAX_AGE_DAYS) {
    warnings.push(`${indexSymbol} 成分权重已 ${snapshot.ageDays} 天未更新（生效日 ${snapshot.effectiveDate ?? "未知"}），聚合结果降级 PARTIAL`);
    stale = true;
  }
  return { points: snapshot.points, stale };
}

function degradeQuality<T extends { quality: "VALID" | "PARTIAL" }>(rows: readonly T[], stale: boolean): T[] {
  return stale ? rows.map((row) => ({ ...row, quality: "PARTIAL" as const })) : [...rows];
}

/** warnings 是跨桶共享数组：同一提示只保留一条，按桶去重避免重复刷屏。 */
function pushWarningOnce(warnings: string[], message: string): void {
  if (!warnings.includes(message)) warnings.push(message);
}

function yearsBefore(day: string, years: number): string { const date = new Date(`${day}T00:00:00Z`); date.setUTCFullYear(date.getUTCFullYear() - years); return date.toISOString().slice(0, 10); }
function monthsBefore(day: string, months: number): string { const date = new Date(`${day}T00:00:00Z`); date.setUTCMonth(date.getUTCMonth() - months); return date.toISOString().slice(0, 10); }
function daysBefore(day: string, days: number): string { const date = new Date(`${day.slice(0, 10)}T00:00:00Z`); date.setUTCDate(date.getUTCDate() - days); return date.toISOString().slice(0, 10); }
function providerMessage(result: ProviderResult<unknown>, label: string): string | null { return result.ok ? (result.data instanceof Array && result.data.length === 0 ? `${label}没有返回数据` : null) : `${label}：${result.error.code} ${result.error.message}`; }

function priceRows(bucket: ScorableAssetBucket, result: Extract<ProviderResult<PricePoint[]>, { ok: true }>): ProviderMetricObservationInput[] {
  return result.data.map((point) => ({ subjectType: "ASSET_BUCKET", subjectId: bucket, metricKey: "PRICE_CLOSE", value: point.close, unit: "price", provider: result.provider, observedAt: point.observedAt, availableAt: point.availableAt, asOf: point.asOf, fetchedAt: result.fetchedAt, quality: result.quality }));
}
function metricRows(bucket: ScorableAssetBucket, result: Extract<ProviderResult<MetricPoint[]>, { ok: true }>, provider = result.provider): ProviderMetricObservationInput[] {
  return result.data.flatMap((point): ProviderMetricObservationInput[] => {
    const key = point.key as CanonicalMetricKey;
    return key in { PE_TTM: 1, PB: 1, PS: 1, DIVIDEND_YIELD: 1, REAL_YIELD_10Y: 1, DOLLAR_INDEX: 1 } ? [{ subjectType: "ASSET_BUCKET", subjectId: bucket, metricKey: key, value: point.value, unit: point.unit, provider, observedAt: point.observedAt, availableAt: point.availableAt, asOf: point.asOf, fetchedAt: result.fetchedAt, quality: result.quality }] : [];
  });
}
function aggregateRows(bucket: ScorableAssetBucket, results: AggregateMetricResult[], asOf: string, fetchedAt: string): ProviderMetricObservationInput[] {
  return results.flatMap((result): ProviderMetricObservationInput[] => result.value === null ? [] : [{ subjectType: "ASSET_BUCKET", subjectId: bucket, metricKey: result.metricKey, value: result.value.toFixed(8), unit: result.metricKey === "DIVIDEND_YIELD" || result.metricKey === "ROE" || result.metricKey.includes("GROWTH") ? "percent" : "ratio", provider: AGGREGATE_PROVIDER, observedAt: `${result.effectiveDate || asOf}T15:00:00+08:00`, availableAt: `${asOf}T18:00:00+08:00`, asOf, fetchedAt, quality: result.quality, metadataJson: JSON.stringify({ constituentCoverage: result.constituentCoverage, constituentCount: result.constituentCount, validConstituentCount: result.validConstituentCount, effectiveDate: result.effectiveDate, ...(result.reportPeriod ? { reportPeriod: result.reportPeriod, reportPeriodShare: result.reportPeriodShare } : {}) }) }]);
}
/** 读取某桶指定指标的全量入库历史（跨运行），供派生序列做点内配对（Code Review H7）。 */
function bucketMetricHistory(bucket: string, metricKeys: string[]): ProviderMetricObservationInput[] {
  return metricKeys.flatMap((metricKey) =>
    getDatabase()
      .select()
      .from(metricObservations)
      .where(
        and(
          eq(metricObservations.subjectType, "ASSET_BUCKET"),
          eq(metricObservations.subjectId, bucket),
          eq(metricObservations.metricKey, metricKey),
        ),
      )
      .all(),
  ) as unknown as ProviderMetricObservationInput[];
}

/**
 * 同一 asOf 只保留「该观察日已可见」的最新版本（点内配对，无前视）：
 * - 只接受 availableAt 的日期 <= asOf 的版本（当天收盘后发布的版本对当天仍可见）；
 * - 同日多版本取 availableAt 最晚者，再以 fetchedAt 兜底；
 * - 可选 evaluationEnd 过滤观察日之后的记录（手工/异常未来日期不进入派生）。
 */
function latestPointAvailableByAsOf(
  rows: ProviderMetricObservationInput[],
  metricKey: string,
  evaluationEnd?: string,
): Map<string, ProviderMetricObservationInput> {
  const selected = new Map<string, ProviderMetricObservationInput>();
  for (const row of rows) {
    if (row.metricKey !== metricKey) continue;
    const asOf = row.asOf.slice(0, 10);
    if (evaluationEnd !== undefined && asOf > evaluationEnd) continue;
    if ((row.availableAt ?? row.asOf).slice(0, 10) > asOf) continue;
    const existing = selected.get(asOf);
    if (!existing) {
      selected.set(asOf, row);
      continue;
    }
    if (row.availableAt > existing.availableAt || (row.availableAt === existing.availableAt && row.fetchedAt > existing.fetchedAt)) {
      selected.set(asOf, row);
    }
  }
  return selected;
}

/** 派生行的可用时间不得早于任一输入：取较晚者（与 ERP 派生同一无前视规则）。 */
function maxAvailableAt(...values: Array<string | undefined>): string {
  let latest = "";
  for (const value of values) {
    if (!value) continue;
    if (!latest) {
      latest = value;
      continue;
    }
    const currentMs = Date.parse(value);
    const latestMs = Date.parse(latest);
    latest = Number.isFinite(currentMs) && Number.isFinite(latestMs) ? (currentMs > latestMs ? value : latest) : (value > latest ? value : latest);
  }
  return latest;
}

/** v2：派生盈利增长写入单独的 *_DERIVED 指标，只作参考，不和财报汇总口径混成一条序列。 */
export function derivedGrowthMetricKey(bucket: Exclude<ScorableAssetBucket, "GOLD">): CanonicalMetricKey {
  return bucket === "BROAD_EQUITY" ? "INDEX_EARNINGS_GROWTH_DERIVED" : "EARNINGS_GROWTH_DERIVED";
}

/** 财报（fina_indicator）与分红历史的增量刷新间隔：每周一次即可跟上财报季，避免每 6 小时重复拉几百只成分股。 */
export const FUNDAMENTALS_REFRESH_INTERVAL_DAYS = 7;
/** 增量刷新的财报窗口：15 个月覆盖每只成分股最近 4–5 个报告期，新评估日的「最新已披露财报」一定在窗口内。 */
export const FUNDAMENTALS_INCREMENTAL_WINDOW_MONTHS = 15;
const FUNDAMENTALS_STATUS_PROVIDER = "tushare-fina";

export type FundamentalsRefreshMode = "FULL" | "INCREMENTAL" | "SKIP";

/**
 * v1 只在全量回填时拉财报，日常刷新永远跳过：ROE、营收增长等没有派生兜底的指标半年后
 * 触发 180 天新鲜度闸门。v2：全量回填照旧；否则距上次成功超过 7 天就做一次增量。
 */
export function fundamentalsRefreshMode(input: { fullBackfill: boolean; lastSuccessAt: string | null | undefined; now: Date }): FundamentalsRefreshMode {
  if (input.fullBackfill) return "FULL";
  if (!input.lastSuccessAt) return "INCREMENTAL";
  const elapsedMs = input.now.getTime() - Date.parse(input.lastSuccessAt);
  return Number.isFinite(elapsedMs) && elapsedMs < FUNDAMENTALS_REFRESH_INTERVAL_DAYS * 24 * 60 * 60 * 1000 ? "SKIP" : "INCREMENTAL";
}

/** 增量模式回头重算的天数：公告日早于上次汇总、但晚几天才进 Tushare 的财报也要并进去 */
export const FUNDAMENTALS_RECOMPUTE_DAYS = 30;

/**
 * 增量模式只为「上次汇总前 30 天之后」的日期生成桶级汇总：
 * - 不回算更早的历史：窗口只有 15 个月，重算窗口前部的历史日期时，部分成分股的当时最新财报会落在
 *   窗口之外，低覆盖率的结果会 upsert 覆盖全量回填时算好的历史行；
 * - 但最近 30 天要重算：公告日在上次汇总之前、晚几天才进入 Tushare 的财报（财报季很常见），
 *   只算新日期就永远并不进来。
 */
export function selectAggregationDates(snapshotDates: string[], lastAggregateAsOf: string | null): string[] {
  const from = lastAggregateAsOf === null ? null : daysBefore(lastAggregateAsOf, FUNDAMENTALS_RECOMPUTE_DAYS);
  return [...new Set(snapshotDates)].filter((date) => from === null || date > from).sort();
}

function lastAggregateAsOf(bucket: ScorableAssetBucket): string | null {
  const rows = getDatabase()
    .select({ asOf: metricObservations.asOf })
    .from(metricObservations)
    .where(and(
      eq(metricObservations.subjectType, "ASSET_BUCKET"),
      eq(metricObservations.subjectId, bucket),
      eq(metricObservations.provider, AGGREGATE_PROVIDER),
      inArray(metricObservations.metricKey, ["ROE", "EARNINGS_GROWTH", "REVENUE_GROWTH", "INDEX_EARNINGS_GROWTH"]),
    ))
    .all();
  return rows.reduce<string | null>((latest, row) => (!latest || row.asOf > latest ? row.asOf : latest), null);
}

/**
 * 由 PRICE_CLOSE / PE 序列派生的盈利同比增速（EPS = price/pe 的【日历约一年】增速）。
 *
 * 数据新鲜度修复：
 * - PE 历史必须也从数据库读：增量刷新本次运行只带回最新一天的 PE，单靠本次 rows
 *   永远凑不出 360 天前的基准点，派生盈利增长会恒为空 → 财务基本面永久陈旧。
 * - 点内配对：价格与 PE 只在同一 asOf 配对，且只使用该观察日已可见（availableAt<=asOf）
 *   的最新版本；派生行 availableAt 取所有输入的较晚者，避免前视。
 * - Tech v1.4 已删除 PE_FORWARD 生产者：三个桶统一用已实现的 PE_TTM 派生；
 *   仅当旧库完全没有 PE_TTM 历史时，回退到 v1.3 遗留的 PE_FORWARD 代理行。
 */
function derivedEarningsGrowth(bucket: Exclude<ScorableAssetBucket, "GOLD">, rows: ProviderMetricObservationInput[], fetchedAt: string, evaluationEnd: string): ProviderMetricObservationInput[] {
  const merged = [...bucketMetricHistory(bucket, ["PRICE_CLOSE", "PE_TTM", "PE_FORWARD"]), ...rows];
  const pricesByAsOf = latestPointAvailableByAsOf(merged, "PRICE_CLOSE", evaluationEnd);
  const peTtmByAsOf = latestPointAvailableByAsOf(merged, "PE_TTM", evaluationEnd);
  // v1.4 起 PE_TTM 是唯一估值口径；PE_FORWARD 仅作为旧库兼容回退。
  const peKey = peTtmByAsOf.size > 0 ? "PE_TTM" : "PE_FORWARD";
  const peByAsOf = peTtmByAsOf.size > 0 ? peTtmByAsOf : latestPointAvailableByAsOf(merged, "PE_FORWARD", evaluationEnd);
  const DAY_MS = 24 * 60 * 60 * 1000;
  const series = Array.from(peByAsOf.entries()).flatMap(([asOf, row]) => {
    const priceRow = pricesByAsOf.get(asOf);
    const price = Number(priceRow?.value);
    const pe = Number(row.value);
    return priceRow && price > 0 && pe > 0 ? [{ row, priceRow, value: price / pe }] : [];
  }).sort((first, second) => first.row.asOf.localeCompare(second.row.asOf));
  const metricKey = derivedGrowthMetricKey(bucket);
  const output: ProviderMetricObservationInput[] = [];
  for (let index = 0; index < series.length; index += 1) {
    const current = series[index];
    const targetMs = Date.parse(current.row.asOf + "T00:00:00Z") - 360 * DAY_MS;
    let base: (typeof series)[number] | null = null;
    for (let earlier = index - 1; earlier >= 0; earlier -= 1) {
      if (Date.parse(series[earlier].row.asOf + "T00:00:00Z") <= targetMs) {
        base = series[earlier];
        break;
      }
    }
    if (!base || base.value === 0) continue;
    const value = (current.value / base.value - 1) * 100;
    if (!Number.isFinite(value)) continue;
    output.push({
      ...current.row,
      metricKey,
      value: value.toFixed(6),
      unit: "percent",
      provider: "tushare-derived",
      fetchedAt,
      quality: "PARTIAL",
      availableAt: maxAvailableAt(current.row.availableAt, current.priceRow.availableAt, base.row.availableAt, base.priceRow.availableAt),
      metadataJson: JSON.stringify({
        proxy: "price_over_pe",
        peMetricKey: peKey,
        lookbackDays: Math.round((Date.parse(current.row.asOf + "T00:00:00Z") - Date.parse(base.row.asOf + "T00:00:00Z")) / DAY_MS),
        baseAsOf: base.row.asOf,
        inputs: {
          peAvailableAt: current.row.availableAt,
          priceAvailableAt: current.priceRow.availableAt,
          basePeAvailableAt: base.row.availableAt,
          basePriceAvailableAt: base.priceRow.availableAt,
        },
      }),
    });
  }
  return output;
}

/**
 * ERP = 盈利收益率(100/PE_TTM) − 10 年实际利率（补全宽基权益便宜度支柱的缺失指标）。
 * 两个输入都是已入库的主数据序列；按 asOf 对齐取最近一期实际利率。
 */
/**
 * ERP = 盈利收益率(100/PE_TTM) − 10 年实际利率（补全宽基权益便宜度支柱的缺失指标）。
 * 两个输入都是已入库的主数据序列；按 asOf 对齐取最近一期实际利率。
 * 无前视（评审复查修复）：availableAt 取两个输入 availableAt 的较晚者——实际利率
 * 为 T+1 18:00 发布时，对齐日的 ERP 最早也要到次日才可见。
 * §27 惯例：provider=tushare-derived 的派生序列 quality 一律 PARTIAL（封顶 MEDIUM）。
 */
function deriveEquityRiskPremium(bucket: 'BROAD_EQUITY', runRows: ProviderMetricObservationInput[], evaluationEnd: string, fetchedAt: string): ProviderMetricObservationInput[] {
  const realYields = bucketMetricHistory("GOLD", ["REAL_YIELD_10Y"])
    .map((row) => ({ asOf: row.asOf, value: Number(row.value), availableAt: row.availableAt }))
    .filter((point) => Number.isFinite(point.value) && point.availableAt !== undefined)
    .sort((first, second) => first.asOf.localeCompare(second.asOf));
  if (!realYields.length) return [];
  const pes = new Map<string, { value: number; availableAt: string }>();
  for (const row of [...bucketMetricHistory(bucket, ["PE_TTM"]), ...runRows.filter((row) => row.metricKey === "PE_TTM")]) {
    const value = Number(row.value);
    const availableAt = row.availableAt ?? `${row.asOf}T18:00:00+08:00`;
    if (Number.isFinite(value) && value > 0) pes.set(row.asOf, { value, availableAt }); // 本次运行行覆盖同日历史
  }
  const output: ProviderMetricObservationInput[] = [];
  for (const [asOf, pe] of Array.from(pes.entries()).sort(([a], [b]) => a.localeCompare(b))) {
    if (asOf > evaluationEnd) continue;
    let realYield: { value: number; availableAt: string } | null = null;
    for (const point of realYields) {
      if (point.asOf <= asOf) realYield = point;
      else break;
    }
    if (realYield === null || realYield.value <= -90) continue; // 实际利率缺失或异常时不产出
    const erp = 100 / pe.value - realYield.value;
    if (!Number.isFinite(erp)) continue;
    // ISO 字符串字典序即可比较先后
    const availableAt = pe.availableAt > realYield.availableAt ? pe.availableAt : realYield.availableAt;
    output.push({
      subjectType: "ASSET_BUCKET",
      subjectId: bucket,
      metricKey: "EQUITY_RISK_PREMIUM",
      value: erp.toFixed(6),
      unit: "percent",
      provider: "tushare-derived",
      observedAt: `${asOf}T15:00:00+08:00`,
      availableAt,
      asOf,
      fetchedAt,
      quality: "PARTIAL",
      metadataJson: JSON.stringify({ formula: "100/PE_TTM - REAL_YIELD_10Y", inputs: { peAvailableAt: pe.availableAt, realYieldAvailableAt: realYield.availableAt } }),
    });
  }
  return output;
}

function needsInitialHistory() { return !getDatabase().select({ id: metricObservations.id }).from(metricObservations).where(eq(metricObservations.metricKey, "PRICE_CLOSE")).limit(1).get(); }
/**
 * 清理早期 ERP 派生行：当时 quality 误标 VALID 且 availableAt 未按输入取晚（无前视复查修复）。
 * 这些行已被按日重新推导的 PARTIAL 行完全取代，保留会造成同日双行。
 */
export function removeLegacyValidEquityRiskPremium() {
  // 只删自动派生的旧行：手工导入一律以 VALID 入库，旧条件会在每次刷新时把它们静默删掉
  getDatabase()
    .delete(metricObservations)
    .where(and(
      eq(metricObservations.metricKey, "EQUITY_RISK_PREMIUM"),
      eq(metricObservations.quality, "VALID"),
      eq(metricObservations.isManualOverride, false),
    ))
    .run();
}
function removeInvalidLegacyRealYield() {
  // Before v1.1 the Tushare us_trycr y10 field was stored as REAL_YIELD_10Y.
  // Its economic meaning is not verified, so preserving it would silently create
  // false HIGH/MEDIUM confidence. The canonical source is FRED DFII10.
  getDatabase().delete(metricObservations).where(and(eq(metricObservations.provider, "tushare"), eq(metricObservations.metricKey, "REAL_YIELD_10Y"))).run();
}
function sampleDates(prices: PricePoint[], fullBackfill: boolean): string[] { const sorted = [...new Set(prices.map((point) => point.asOf))].sort(); if (!fullBackfill) return sorted.slice(-1); const selected = new Map<string, string>(); for (const day of sorted) selected.set(day.slice(0, 7), day); return Array.from(selected.values()); }

async function fetchAndCacheWeights(provider: TushareProvider, indexSymbol: string, dates: string[], warnings: string[]) {
  await Promise.all(dates.map(async (date) => {
    // Some index providers publish a snapshot only in an earlier month. Request a
    // short lookback and then select the latest effective date <= evaluation date.
    const result = await provider.getIndexWeights(indexSymbol, { start: monthsBefore(date, 3), end: date });
    const warning = providerMessage(result, `${indexSymbol}成分权重`); if (warning) { warnings.push(warning); return; }
    if (result.ok && result.data.length > 0) cacheIndexWeights(result.data, result.provider, result.fetchedAt);
  }));
}
async function refreshAggregatedValuation(provider: TushareProvider, proxies: TushareScoreProxy[], dates: string[], fetchedAt: string, warnings: string[]): Promise<ProviderMetricObservationInput[]> {
  const output: ProviderMetricObservationInput[] = [];
  for (const date of dates) {
    const daily = await provider.getMarketDailyBasics(date); const warning = providerMessage(daily, `${date}全市场估值`);
    if (warning || !daily.ok) { if (warning) warnings.push(warning); continue; }
    for (const proxy of proxies.filter((item) => item.bucket !== "GOLD")) {
      const weightInfo = readWeightsWithAge(proxy.symbol, date, warnings); if (!weightInfo) { warnings.push(`${proxy.label}缺少 ${date} 前可用的成分权重`); continue; }
      const weights = weightInfo.points;
      const metrics = degradeQuality([aggregateHarmonicMetric("PE_TTM", weights, daily.data), aggregateHarmonicMetric("PB", weights, daily.data), aggregateHarmonicMetric("PS", weights, daily.data), aggregateDividendYield(weights, daily.data)], weightInfo.stale);
      const allowed = proxy.bucket === "VALUE_DIVIDEND" ? metrics : proxy.bucket === "TECH_GROWTH" ? metrics.filter((item) => item.metricKey === "PS" || item.metricKey === "PE_TTM") : metrics.filter((item) => item.metricKey === "PE_TTM" || item.metricKey === "PB");
      output.push(...aggregateRows(proxy.bucket, allowed, date, fetchedAt));
    }
  }
  return output;
}
async function refreshGoldMacro(fred: FredProvider, range: { start: string; end: string }, warnings: string[]): Promise<{ rows: ProviderMetricObservationInput[]; fetchedSeriesCount: number; total: number }> {
  // FRED 的失败只记在 FRED 自己名下（Code Review M13），不再混入共享 warnings 让 tushare 背锅。
  const results = await Promise.all((["REAL_YIELD_10Y", "DOLLAR_INDEX"] as const).map(async (metricKey) => {
    const result = await fred.getMacroSeries({ seriesId: metricKey, range });
    const warning = providerMessage(result, metricKey === "REAL_YIELD_10Y" ? "美国 10 年实际利率" : "美元广义指数");
    if (warning) warnings.push(warning);
    return result.ok ? metricRows("GOLD", result) : [];
  }));
  return { rows: results.flat(), fetchedSeriesCount: results.filter((rows) => rows.length > 0).length, total: 2 };
}
async function refreshGoldEtfFlow(provider: TushareProvider, range: { start: string; end: string }, warnings: string[]): Promise<ProviderMetricObservationInput[]> {
  // 主路径：WGC Goldhub 全球月度流量（官方修订口径，VALID）。失败时回退国内 ETF 代理（PARTIAL）。
  const wgc = await fetchWgcGlobalMonthlyFlows();
  if (wgc.ok && wgc.data.length >= 36) {
    return wgc.data.map((point) => ({ subjectType: "ASSET_BUCKET", subjectId: "GOLD", metricKey: "GOLD_GLOBAL_ETF_FLOW_3M", value: String(point.valueMillionUsd), unit: "currency", provider: wgc.provider, observedAt: point.asOf + "T15:00:00+08:00", availableAt: point.availableAt, asOf: point.asOf, fetchedAt: wgc.fetchedAt, quality: "VALID", metadataJson: JSON.stringify({ source: "WGC Goldhub gold ETF flows", unit: "million USD", window: "3-month rolling sum" }) }));
  }
  if (!wgc.ok) warnings.push("WGC 全球黄金 ETF 流量不可用（" + wgc.error.message + "），回退国内 ETF 代理");
  else warnings.push("WGC 序列过短（" + wgc.data.length + " 点），回退国内 ETF 代理");
  const shares = []; const navs = []; let fetchedAt = new Date().toISOString();
  for (const symbol of getGoldEtfProxies()) {
    const [share, nav] = await Promise.all([provider.getFundShare(symbol, range), provider.getFundNavForFlow(symbol, range)]);
    for (const [result, label] of [[share, `${symbol}基金份额`], [nav, `${symbol}基金净值`]] as const) { const warning = providerMessage(result, label); if (warning) warnings.push(warning); if (result.ok) fetchedAt = result.fetchedAt; }
    if (share.ok) shares.push(...share.data); if (nav.ok) navs.push(...nav.data);
  }
  return calculateGoldEtfFlow3m(shares, navs).map((point) => ({ subjectType: "ASSET_BUCKET", subjectId: "GOLD", metricKey: "GOLD_ETF_FLOW_3M", value: point.value.toFixed(2), unit: "currency", provider: "tushare-gold-etf-proxy", observedAt: `${point.asOf}T15:00:00+08:00`, availableAt: point.availableAt, asOf: point.asOf, fetchedAt, quality: "PARTIAL", metadataJson: JSON.stringify({ proxySymbols: getGoldEtfProxies() }) }));
}
export async function refreshFundamentals(provider: Pick<TushareProvider, "getEquityFundamentals">, proxies: TushareScoreProxy[], evaluationDate: string, range: { start: string; end: string }, mode: FundamentalsRefreshMode, warnings: string[], fetchedAt: string): Promise<ProviderMetricObservationInput[]> {
  if (mode === "SKIP") return [];
  const symbols = new Set(proxies.filter((item) => item.bucket !== "GOLD").flatMap((proxy) => readLatestIndexWeights(proxy.symbol, evaluationDate).map((weight) => weight.constituentSymbol)));
  const snapshots: EquityFundamentalSnapshot[] = []; const output: ProviderMetricObservationInput[] = [];
  for (const symbol of symbols) {
    const result = await provider.getEquityFundamentals(symbol, range); const warning = providerMessage(result, `${symbol}财务指标`); if (warning) { warnings.push(warning); continue; } if (!result.ok) continue;
    snapshots.push(...result.data);
    for (const row of result.data) for (const [metricKey, value] of [["ROE", row.roe], ["EARNINGS_GROWTH", row.earningsGrowth], ["REVENUE_GROWTH", row.revenueGrowth]] as const) if (value !== null) output.push({ subjectType: "INSTRUMENT", subjectId: symbol, metricKey, value: value.toFixed(8), unit: "percent", provider: "tushare", observedAt: `${row.reportPeriod}T23:59:59+08:00`, availableAt: row.availableAt, asOf: row.reportPeriod, fetchedAt, quality: "VALID" });
  }
  const snapshotDates = snapshots.map((row) => row.availableAt.slice(0, 10)).filter((date) => date <= evaluationDate);
  for (const proxy of proxies.filter((item) => item.bucket !== "GOLD")) for (const date of selectAggregationDates(snapshotDates, mode === "INCREMENTAL" ? lastAggregateAsOf(proxy.bucket) : null)) {
    const weightInfo = readWeightsWithAge(proxy.symbol, date, warnings); if (!weightInfo) continue;
    const weights = weightInfo.points;
    const metrics = degradeQuality(
      proxy.bucket === "VALUE_DIVIDEND"
        ? [aggregateFundamentalMetric("ROE", weights, snapshots, date), aggregateFundamentalMetric("EARNINGS_GROWTH", weights, snapshots, date)]
        : proxy.bucket === "TECH_GROWTH"
          ? [aggregateFundamentalMetric("EARNINGS_GROWTH", weights, snapshots, date), aggregateFundamentalMetric("REVENUE_GROWTH", weights, snapshots, date)]
          : [aggregateFundamentalMetric("INDEX_EARNINGS_GROWTH", weights, snapshots, date)],
      weightInfo.stale,
    );
    output.push(...aggregateRows(proxy.bucket, metrics, date, fetchedAt));
  }
  return output;
}
async function refreshDividendStability(provider: TushareProvider, valueProxy: TushareScoreProxy | undefined, evaluationDate: string, fullBackfill: boolean, warnings: string[], fetchedAt: string): Promise<ProviderMetricObservationInput[]> {
  if (!valueProxy) return [];
  const weightInfo = readWeightsWithAge(valueProxy.symbol, evaluationDate, warnings); if (!weightInfo) return [];
  // 分红历史每次运行只拉取一次；历史年界行仅在全量回填时重建，评估日行始终刷新
  const weights = weightInfo.points;
  const historyBySymbol = new Map<string, TushareDividendRecord[]>();
  for (const { constituentSymbol } of weights) {
    const history = await provider.getEquityDividendHistory(constituentSymbol); const warning = providerMessage(history, `${constituentSymbol}分红记录`); if (warning) { warnings.push(warning); continue; }
    if (history.ok) historyBySymbol.set(constituentSymbol, history.data);
  }

  const buildRowFor = (date: string) => {
    const scored = weights.flatMap(({ constituentSymbol, weight }) => {
      const records = historyBySymbol.get(constituentSymbol);
      if (!records) return [];
      const score = scoreDividendStability(records, date);
      return score === null ? [] : [{ weight: weight, score: score }];
    });
    const totalWeight = weights.reduce((sum, row) => sum + row.weight, 0);
    const validWeight = scored.reduce((sum, row) => sum + row.weight, 0);
    const coverage = totalWeight > 0 ? validWeight / totalWeight : 0;
    if (coverage < 0.6 || validWeight <= 0 || scored.length === 0) return null;
    return degradeQuality([{ metricKey: "DIVIDEND_STABILITY_SCORE" as const, value: scored.reduce((sum, row) => sum + row.weight * row.score, 0) / validWeight, constituentCoverage: coverage, constituentCount: weights.length, validConstituentCount: scored.length, quality: coverage >= 0.8 ? "VALID" : "PARTIAL", effectiveDate: weights[0]?.effectiveDate ?? date }], weightInfo.stale);
  };
  const output: ProviderMetricObservationInput[] = [];
  const dates = new Set<string>([evaluationDate]);
  if (fullBackfill) {
    // 分数仅在跨年时变化：回填窗口内每个自然年的 12-31 各一条
    const firstYear = Number(yearsBefore(evaluationDate, 5).slice(0, 4));
    const endYear = Number(evaluationDate.slice(0, 4));
    for (let year = firstYear; year <= endYear; year += 1) {
      const yearEnd = String(year) + "-12-31";
      if (yearEnd <= evaluationDate) dates.add(yearEnd);
    }
  }
  for (const date of Array.from(dates).sort()) {
    const metrics = buildRowFor(date);
    if (metrics) output.push(...aggregateRows("VALUE_DIVIDEND", metrics, date, fetchedAt));
  }
  return output;
}
/** 读取某个数据源的状态行（worker 按「上次成功刷新距今多久」决定要不要刷新） */
export function readProviderStatus(provider: string) {
  return getDatabase().select().from(dataSourceStatus).where(eq(dataSourceStatus.provider, provider)).get() ?? null;
}

function saveProviderStatus(provider: string, status: AutomaticRefreshReport["status"], now: string, errors: string[], capabilities: Record<string, string>) {
  const db = getDatabase(); const previous = db.select().from(dataSourceStatus).where(eq(dataSourceStatus.provider, provider)).get();
  const values = { enabled: status !== "NOT_CONFIGURED", status, lastAttemptAt: now, lastSuccessAt: status === "READY" || status === "DEGRADED" ? now : previous?.lastSuccessAt ?? null, lastErrorCode: errors.length ? (errors.some((item) => item.includes("PERMISSION_DENIED")) ? "PERMISSION_DENIED" : "PARTIAL_FAILURE") : null, lastErrorMessage: errors.length ? errors.slice(0, 8).join("；") : null, capabilitiesJson: JSON.stringify(capabilities), updatedAt: now };
  db.insert(dataSourceStatus).values({ id: `provider-${provider}`, provider, ...values }).onConflictDoUpdate({ target: dataSourceStatus.provider, set: values }).run();
}

export async function refreshAutomaticMarketData(options: AutomaticRefreshOptions = {}): Promise<AutomaticRefreshReport> {
  const now = options.now ?? new Date(); const fetchedAt = now.toISOString(); const end = shanghaiDate(now); const provider = options.provider ?? new TushareProvider(); const fred = options.fredProvider ?? new FredProvider(); const proxies = options.proxies ?? getTushareScoreProxies();
  if (!process.env.TUSHARE_TOKEN && !options.provider) { saveProviderStatus("tushare", "NOT_CONFIGURED", fetchedAt, ["尚未在本机环境中配置 TUSHARE_TOKEN"], { index_dailybasic: "UNKNOWN" }); return { provider: "tushare", status: "NOT_CONFIGURED", fetchedAt, inserted: 0, updated: 0, buckets: [] }; }
  removeInvalidLegacyRealYield();
  removeLegacyValidEquityRiskPremium();
  const fullBackfill = options.fullBackfill ?? (process.env.FULL_BACKFILL === "true" || Boolean(needsInitialHistory())); const range = { start: fullBackfill ? yearsBefore(end, 5) : yearsBefore(end, 1), end }; const warnings: string[] = []; const fredWarnings: string[] = []; const byBucket = new Map<ScorableAssetBucket, ProviderMetricObservationInput[]>();
  // 受控并发（Code Review M16）：provider 内部限流器负责 RPM，外层并行缩短整轮耗时。
  await Promise.all(proxies.map(async (proxy) => {
    const price = await provider.getPriceSeries({ symbol: proxy.symbol, instrumentKind: proxy.instrumentKind, range, interval: "1day" });
    const warning = providerMessage(price, `${proxy.label}行情`); if (warning) warnings.push(warning);
    if (price.ok) byBucket.set(proxy.bucket, priceRows(proxy.bucket, price));
  }));
  const indexPrices = proxies.filter((item) => item.bucket !== "GOLD").flatMap((proxy) => (byBucket.get(proxy.bucket) ?? []).filter((row) => row.metricKey === "PRICE_CLOSE").map((row) => ({ asOf: row.asOf } as PricePoint))); const dates = sampleDates(indexPrices, fullBackfill);
  for (const proxy of proxies.filter((item) => item.bucket !== "GOLD")) await fetchAndCacheWeights(provider, proxy.symbol, dates, warnings);
  for (const row of await refreshAggregatedValuation(provider, proxies, dates, fetchedAt, warnings)) byBucket.set(row.subjectId as ScorableAssetBucket, [...(byBucket.get(row.subjectId as ScorableAssetBucket) ?? []), row]);
  let directCapability = "READY";
  await Promise.all(proxies.filter((item) => item.bucket !== "GOLD").map(async (proxy) => {
    const direct = await provider.getValuationMetrics({ symbol: proxy.symbol, instrumentKind: "INDEX", metrics: ["PE_TTM", "PB"], range: { start: `${end.slice(0, 7)}-01`, end }, asOf: end });
    if (!direct.ok && direct.error.code === "PERMISSION_DENIED") directCapability = "PERMISSION_DENIED";
    const warning = providerMessage(direct, `${proxy.label}官方指数估值`); if (warning) warnings.push(warning);
    if (direct.ok) byBucket.set(proxy.bucket, [...(byBucket.get(proxy.bucket) ?? []), ...metricRows(proxy.bucket, direct)]);
  }));
      // FRED 序列廉价且一次性请求即可拉全：固定 5 年窗口，避免增量模式把实际利率/
  // 美元指数的历史压到 1 年内而把黄金基本面钉在 LOW（置信度年限不足）。
  const goldMacro = await refreshGoldMacro(fred, { start: yearsBefore(end, 5), end }, fredWarnings);
  byBucket.set("GOLD", [...(byBucket.get("GOLD") ?? []), ...goldMacro.rows, ...await refreshGoldEtfFlow(provider, { start: fullBackfill ? range.start : yearsBefore(end, 1), end }, warnings)]);
  // v2：财报不再只在全量回填时拉取——距上次成功超过 7 天就增量刷新一次（15 个月窗口，只补新日期）。
  const fundamentalsStatus = getDatabase().select().from(dataSourceStatus).where(eq(dataSourceStatus.provider, FUNDAMENTALS_STATUS_PROVIDER)).get();
  const fundamentalsMode = fundamentalsRefreshMode({ fullBackfill, lastSuccessAt: fundamentalsStatus?.lastSuccessAt, now });
  const fundamentalsRange = fundamentalsMode === "FULL" ? range : { start: monthsBefore(end, FUNDAMENTALS_INCREMENTAL_WINDOW_MONTHS), end };
  const fundamentalWarnings: string[] = [];
  const fundamentalRows = await refreshFundamentals(provider, proxies, end, fundamentalsRange, fundamentalsMode, fundamentalWarnings, fetchedAt); const allRows = [...fundamentalRows.filter((row) => row.subjectType === "INSTRUMENT")];
  warnings.push(...fundamentalWarnings);
  for (const row of fundamentalRows.filter((row) => row.subjectType === "ASSET_BUCKET")) byBucket.set(row.subjectId as ScorableAssetBucket, [...(byBucket.get(row.subjectId as ScorableAssetBucket) ?? []), row]);
  // 分红历史一年才变一次，跟财报同一节奏（v1 每 6 小时重拉全部成分股）。
  if (fundamentalsMode !== "SKIP") byBucket.set("VALUE_DIVIDEND", [...(byBucket.get("VALUE_DIVIDEND") ?? []), ...await refreshDividendStability(provider, proxies.find((item) => item.bucket === "VALUE_DIVIDEND"), end, fullBackfill, warnings, fetchedAt)]);
  for (const bucket of ["VALUE_DIVIDEND", "TECH_GROWTH", "BROAD_EQUITY"] as const) {
    // 派生盈利增长写入单独的 *_DERIVED 参考指标（每次都算），不再充当财报口径的兜底。
    const rows = byBucket.get(bucket) ?? [];
    // v2 起派生值只作参考展示，算不出来不影响评分，也不再把 Tushare 状态标成 DEGRADED
    allRows.push(...derivedEarningsGrowth(bucket, rows, fetchedAt, end));
  }
  allRows.push(...deriveEquityRiskPremium("BROAD_EQUITY", byBucket.get("BROAD_EQUITY") ?? [], end, fetchedAt));
  allRows.push(...Array.from(byBucket.values()).flat()); const commit = commitProviderMetricObservations(allRows); const reports: BucketRefreshReport[] = [];
  // 财报状态在数据入库之后才记：之前记的话，入库前崩溃或被中断会让下一次财报刷新白白跳过 7 天
  if (fundamentalsMode !== "SKIP") {
    saveProviderStatus(FUNDAMENTALS_STATUS_PROVIDER, fundamentalRows.length > 0 ? (fundamentalWarnings.length ? "DEGRADED" : "READY") : "ERROR", fetchedAt, fundamentalWarnings, { fina_indicator: fundamentalsMode, dividend: fundamentalsMode, window: `${fundamentalsRange.start}..${fundamentalsRange.end}` });
  }
  for (const proxy of proxies) {
    const rows = allRows.filter((row) => row.subjectType === "ASSET_BUCKET" && row.subjectId === proxy.bucket);
    const latestAsOf = rows.reduce<string | null>((latest, row) => !latest || row.asOf > latest ? row.asOf : latest, null);
    // 全量回填时按历史月度采样日逐日回算快照：这是回测与历史评分的点内时间数据基础；
    // 增量模式仍只刷新最新日。
    const requests = fullBackfill
      ? dates.map((date) => ({ bucket: proxy.bucket as ScorableAssetBucket, asOf: date }))
      : latestAsOf
        ? [{ bucket: proxy.bucket, asOf: latestAsOf }]
        : [];
    // 全量回填的历史快照是月度采样，无法满足「连续 N 个交易日」的逐日确认：
    // 跳过确认直接按候选态入库（回测/历史评分用途）；增量刷新仍走严格交易日确认。
    const scores = requests.length > 0 ? await refreshScoresForBuckets(requests, { skipConfirmation: fullBackfill }) : [];
    reports.push({ bucket: proxy.bucket, proxy: proxy.label, symbol: proxy.symbol, observationCount: rows.length, latestAsOf, scoreSaved: scores.some((score) => score.saved), warnings });
  }
  const status = reports.some((report) => report.observationCount > 0) ? (warnings.length ? "DEGRADED" : "READY") : "ERROR"; saveProviderStatus("tushare", status, fetchedAt, warnings, { index_dailybasic: directCapability, index_weight: "READY", daily_basic: "READY", fina_indicator: fundamentalsMode, fund_share: "READY", fund_nav: "READY" }); // FRED 状态独立评估（Code Review M13）：不凭环境变量标 READY，也不把 FRED 失败算进 tushare。
  const fredStatus: AutomaticRefreshReport["status"] = !process.env.FRED_API_KEY
    ? "NOT_CONFIGURED"
    : goldMacro.total > 0 && goldMacro.fetchedSeriesCount === 0
      ? "ERROR"
      : fredWarnings.length
        ? "DEGRADED"
        : "READY";
  saveProviderStatus("fred", fredStatus, fetchedAt, !process.env.FRED_API_KEY ? ["缺少 FRED_API_KEY，黄金宏观指标保持缺失"] : fredWarnings, { DFII10: "REAL_YIELD_10Y", DTWEXBGS: "DOLLAR_INDEX" });
  return { provider: "tushare", status, fetchedAt, inserted: commit.inserted, updated: commit.updated, buckets: reports };
}
