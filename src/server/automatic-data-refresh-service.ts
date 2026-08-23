import { and, eq } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import { dataSourceStatus, metricObservations } from "@/db/schema";
import type { ScorableAssetBucket } from "@/domain/types";
import type { CanonicalMetricKey } from "@/metrics/catalog";
import { commitProviderMetricObservations, type ProviderMetricObservationInput } from "@/metrics/observation-repository";
import { FredProvider } from "@/providers/fred";
import { aggregateDividendYield, aggregateFundamentalMetric, aggregateHarmonicMetric, type AggregateMetricResult, type EquityFundamentalSnapshot } from "@/providers/tushare/index-aggregator";
import { cacheIndexWeights, readLatestIndexWeights } from "@/providers/tushare/index-weight-cache";
import { scoreDividendStability } from "@/providers/tushare/dividend-stability";
import { calculateGoldEtfFlow3m } from "@/providers/tushare/gold-etf-flow";
import { TushareProvider } from "@/providers/tushare";
import { getGoldEtfProxies, getTushareScoreProxies, type TushareScoreProxy } from "@/providers/tushare/proxies";
import type { MetricPoint, PricePoint, ProviderResult } from "@/providers/types";
import { refreshScoresForBuckets } from "./scoring-refresh-service";

interface BucketRefreshReport { bucket: ScorableAssetBucket; proxy: string; symbol: string; observationCount: number; latestAsOf: string | null; scoreSaved: boolean; warnings: string[]; }
export interface AutomaticRefreshReport { provider: "tushare"; status: "READY" | "DEGRADED" | "ERROR" | "NOT_CONFIGURED"; fetchedAt: string; inserted: number; updated: number; buckets: BucketRefreshReport[]; }
interface AutomaticRefreshOptions { provider?: TushareProvider; fredProvider?: FredProvider; now?: Date; proxies?: TushareScoreProxy[]; fullBackfill?: boolean; }
const AGGREGATE_PROVIDER = "tushare-index-aggregate";

function shanghaiDate(now: Date): string { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now); }
function yearsBefore(day: string, years: number): string { const date = new Date(`${day}T00:00:00Z`); date.setUTCFullYear(date.getUTCFullYear() - years); return date.toISOString().slice(0, 10); }
function monthsBefore(day: string, months: number): string { const date = new Date(`${day}T00:00:00Z`); date.setUTCMonth(date.getUTCMonth() - months); return date.toISOString().slice(0, 10); }
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
  return results.flatMap((result): ProviderMetricObservationInput[] => result.value === null ? [] : [{ subjectType: "ASSET_BUCKET", subjectId: bucket, metricKey: result.metricKey, value: result.value.toFixed(8), unit: result.metricKey === "DIVIDEND_YIELD" || result.metricKey === "ROE" || result.metricKey.includes("GROWTH") ? "percent" : "ratio", provider: AGGREGATE_PROVIDER, observedAt: `${result.effectiveDate || asOf}T15:00:00+08:00`, availableAt: `${asOf}T18:00:00+08:00`, asOf, fetchedAt, quality: result.quality, metadataJson: JSON.stringify({ constituentCoverage: result.constituentCoverage, constituentCount: result.constituentCount, validConstituentCount: result.validConstituentCount, effectiveDate: result.effectiveDate }) }]);
}
function forwardPeProxy(rows: ProviderMetricObservationInput[]): ProviderMetricObservationInput[] { return rows.filter((row) => row.metricKey === "PE_TTM").map((row) => ({ ...row, metricKey: "PE_FORWARD", provider: "tushare-derived-forward-pe", quality: "PARTIAL", metadataJson: JSON.stringify({ proxy: "PE_TTM", label: "Forward PE（TTM 代理）" }) })); }
/**
 * 从数据库历史 + 本次抓取行合并出 price/pe 序列，再按【日历约一年】(>=360 天) 的
 * 最近前值计算 EPS(price/pe) 同比增速（Code Review H7）：
 * 旧实现只看本次运行窗口且硬编码 252 个采样点，在降采样入库策略下永远凑不齐，
 * 属于死路径。改为跨运行读取库内全量历史后，月度/降采样序列也能产出同比点。
 */
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

function derivedEarningsGrowth(bucket: Exclude<ScorableAssetBucket, "GOLD">, rows: ProviderMetricObservationInput[], fetchedAt: string): ProviderMetricObservationInput[] {
  const prices = new Map<string, number>();
  const peByKeyAsOf = new Map<string, ProviderMetricObservationInput[]>();
  for (const row of [...bucketMetricHistory(bucket, ["PRICE_CLOSE"]), ...rows]) {
    if (row.metricKey === "PRICE_CLOSE") {
      prices.set(row.asOf, Number(row.value));
    } else if (row.metricKey === "PE_TTM" || row.metricKey === "PE_FORWARD") {
      const list = peByKeyAsOf.get(row.metricKey + ":" + row.asOf) ?? [];
      list.push(row);
      peByKeyAsOf.set(row.metricKey + ":" + row.asOf, list);
    }
  }
  const peKey = bucket === "TECH_GROWTH" ? "PE_FORWARD" : "PE_TTM";
  const series = Array.from(peByKeyAsOf.entries())
    .filter(([key]) => key.startsWith(peKey + ":"))
    .map(([, list]) => list[0])
    .filter((row) => {
      const price = prices.get(row.asOf);
      const pe = Number(row.value);
      return price !== undefined && price > 0 && pe > 0;
    })
    .map((row) => ({ row, value: prices.get(row.asOf)! / Number(row.value) }))
    .sort((a, b) => a.row.asOf.localeCompare(b.row.asOf));
  const metricKey: CanonicalMetricKey = bucket === "BROAD_EQUITY" ? "INDEX_EARNINGS_GROWTH" : "EARNINGS_GROWTH";
  const DAY_MS = 24 * 60 * 60 * 1000;
  return series.flatMap((current): ProviderMetricObservationInput[] => {
    let base: { row: ProviderMetricObservationInput; value: number } | null = null;
    const targetMs = Date.parse(current.row.asOf + "T00:00:00Z") - 360 * DAY_MS;
    for (let j = series.indexOf(current) - 1; j >= 0; j -= 1) {
      if (Date.parse(series[j].row.asOf + "T00:00:00Z") <= targetMs) {
        base = series[j];
        break;
      }
    }
    if (!base || base.value === 0) return [];
    const value = (current.value / base.value - 1) * 100;
    return Number.isFinite(value)
      ? [{
          ...current.row,
          metricKey,
          value: value.toFixed(6),
          unit: "percent",
          provider: "tushare-derived",
          fetchedAt,
          quality: "PARTIAL",
          metadataJson: JSON.stringify({
            proxy: "price_over_pe",
            lookbackDays: Math.round((Date.parse(current.row.asOf + "T00:00:00Z") - Date.parse(base.row.asOf + "T00:00:00Z")) / DAY_MS),
            baseAsOf: base.row.asOf,
          }),
        }]
      : [];
  });
}

function needsInitialHistory() { return !getDatabase().select({ id: metricObservations.id }).from(metricObservations).where(eq(metricObservations.metricKey, "PRICE_CLOSE")).limit(1).get(); }
function removeInvalidLegacyRealYield() {
  // Before v1.1 the Tushare us_trycr y10 field was stored as REAL_YIELD_10Y.
  // Its economic meaning is not verified, so preserving it would silently create
  // false HIGH/MEDIUM confidence. The canonical source is FRED DFII10.
  getDatabase().delete(metricObservations).where(and(eq(metricObservations.provider, "tushare"), eq(metricObservations.metricKey, "REAL_YIELD_10Y"))).run();
}
function sampleDates(prices: PricePoint[], fullBackfill: boolean): string[] { const sorted = [...new Set(prices.map((point) => point.asOf))].sort(); if (!fullBackfill) return sorted.slice(-1); const selected = new Map<string, string>(); for (const day of sorted) selected.set(day.slice(0, 7), day); return Array.from(selected.values()); }

async function fetchAndCacheWeights(provider: TushareProvider, indexSymbol: string, dates: string[], warnings: string[]) {
  for (const date of dates) {
    // Some index providers publish a snapshot only in an earlier month. Request a
    // short lookback and then select the latest effective date <= evaluation date.
    const result = await provider.getIndexWeights(indexSymbol, { start: monthsBefore(date, 3), end: date });
    const warning = providerMessage(result, `${indexSymbol}成分权重`); if (warning) { warnings.push(warning); continue; }
    if (result.ok && result.data.length > 0) cacheIndexWeights(result.data, result.provider, result.fetchedAt);
  }
}
async function refreshAggregatedValuation(provider: TushareProvider, proxies: TushareScoreProxy[], dates: string[], fetchedAt: string, warnings: string[]): Promise<ProviderMetricObservationInput[]> {
  const output: ProviderMetricObservationInput[] = [];
  for (const date of dates) {
    const daily = await provider.getMarketDailyBasics(date); const warning = providerMessage(daily, `${date}全市场估值`);
    if (warning || !daily.ok) { if (warning) warnings.push(warning); continue; }
    for (const proxy of proxies.filter((item) => item.bucket !== "GOLD")) {
      const weights = readLatestIndexWeights(proxy.symbol, date); if (!weights.length) { warnings.push(`${proxy.label}缺少 ${date} 前可用的成分权重`); continue; }
      const metrics = [aggregateHarmonicMetric("PE_TTM", weights, daily.data), aggregateHarmonicMetric("PB", weights, daily.data), aggregateHarmonicMetric("PS", weights, daily.data), aggregateDividendYield(weights, daily.data)];
      const allowed = proxy.bucket === "VALUE_DIVIDEND" ? metrics : proxy.bucket === "TECH_GROWTH" ? metrics.filter((item) => item.metricKey === "PS") : metrics.filter((item) => item.metricKey === "PE_TTM" || item.metricKey === "PB");
      output.push(...aggregateRows(proxy.bucket, allowed, date, fetchedAt));
    }
  }
  return output;
}
async function refreshGoldMacro(fred: FredProvider, range: { start: string; end: string }, warnings: string[]): Promise<ProviderMetricObservationInput[]> {
  const output: ProviderMetricObservationInput[] = [];
  for (const metricKey of ["REAL_YIELD_10Y", "DOLLAR_INDEX"] as const) {
    const result = await fred.getMacroSeries({ seriesId: metricKey, range }); const warning = providerMessage(result, metricKey === "REAL_YIELD_10Y" ? "美国 10 年实际利率" : "美元广义指数"); if (warning) warnings.push(warning); if (result.ok) output.push(...metricRows("GOLD", result));
  }
  return output;
}
async function refreshGoldEtfFlow(provider: TushareProvider, range: { start: string; end: string }, warnings: string[]): Promise<ProviderMetricObservationInput[]> {
  const shares = []; const navs = []; let fetchedAt = new Date().toISOString();
  for (const symbol of getGoldEtfProxies()) {
    const [share, nav] = await Promise.all([provider.getFundShare(symbol, range), provider.getFundNavForFlow(symbol, range)]);
    for (const [result, label] of [[share, `${symbol}基金份额`], [nav, `${symbol}基金净值`]] as const) { const warning = providerMessage(result, label); if (warning) warnings.push(warning); if (result.ok) fetchedAt = result.fetchedAt; }
    if (share.ok) shares.push(...share.data); if (nav.ok) navs.push(...nav.data);
  }
  return calculateGoldEtfFlow3m(shares, navs).map((point) => ({ subjectType: "ASSET_BUCKET", subjectId: "GOLD", metricKey: "GOLD_ETF_FLOW_3M", value: point.value.toFixed(2), unit: "currency", provider: "tushare-gold-etf-proxy", observedAt: `${point.asOf}T15:00:00+08:00`, availableAt: point.availableAt, asOf: point.asOf, fetchedAt, quality: "PARTIAL", metadataJson: JSON.stringify({ proxySymbols: getGoldEtfProxies() }) }));
}
async function refreshFundamentals(provider: TushareProvider, proxies: TushareScoreProxy[], evaluationDate: string, range: { start: string; end: string }, fullBackfill: boolean, warnings: string[], fetchedAt: string): Promise<ProviderMetricObservationInput[]> {
  if (!fullBackfill) return [];
  const symbols = new Set(proxies.filter((item) => item.bucket !== "GOLD").flatMap((proxy) => readLatestIndexWeights(proxy.symbol, evaluationDate).map((weight) => weight.constituentSymbol)));
  const snapshots: EquityFundamentalSnapshot[] = []; const output: ProviderMetricObservationInput[] = [];
  for (const symbol of symbols) {
    const result = await provider.getEquityFundamentals(symbol, range); const warning = providerMessage(result, `${symbol}财务指标`); if (warning) { warnings.push(warning); continue; } if (!result.ok) continue;
    snapshots.push(...result.data);
    for (const row of result.data) for (const [metricKey, value] of [["ROE", row.roe], ["EARNINGS_GROWTH", row.earningsGrowth], ["REVENUE_GROWTH", row.revenueGrowth]] as const) if (value !== null) output.push({ subjectType: "INSTRUMENT", subjectId: symbol, metricKey, value: value.toFixed(8), unit: "percent", provider: "tushare", observedAt: `${row.reportPeriod}T23:59:59+08:00`, availableAt: row.availableAt, asOf: row.reportPeriod, fetchedAt, quality: "VALID" });
  }
  for (const date of [...new Set(snapshots.map((row) => row.availableAt.slice(0, 10)))].sort()) for (const proxy of proxies.filter((item) => item.bucket !== "GOLD")) {
    const weights = readLatestIndexWeights(proxy.symbol, date); if (!weights.length) continue;
    const metrics = proxy.bucket === "VALUE_DIVIDEND" ? [aggregateFundamentalMetric("ROE", weights, snapshots, date), aggregateFundamentalMetric("EARNINGS_GROWTH", weights, snapshots, date)] : proxy.bucket === "TECH_GROWTH" ? [aggregateFundamentalMetric("EARNINGS_GROWTH", weights, snapshots, date), aggregateFundamentalMetric("REVENUE_GROWTH", weights, snapshots, date)] : [aggregateFundamentalMetric("INDEX_EARNINGS_GROWTH", weights, snapshots, date)];
    output.push(...aggregateRows(proxy.bucket, metrics, date, fetchedAt));
  }
  return output;
}
async function refreshDividendStability(provider: TushareProvider, valueProxy: TushareScoreProxy | undefined, evaluationDate: string, fullBackfill: boolean, warnings: string[], fetchedAt: string): Promise<ProviderMetricObservationInput[]> {
  if (!fullBackfill || !valueProxy) return [];
  const weights = readLatestIndexWeights(valueProxy.symbol, evaluationDate); if (!weights.length) return [];
  const scores: Array<{ symbol: string; score: number }> = [];
  for (const { constituentSymbol } of weights) {
    const history = await provider.getEquityDividendHistory(constituentSymbol); const warning = providerMessage(history, `${constituentSymbol}分红记录`); if (warning) { warnings.push(warning); continue; }
    if (!history.ok) continue; const score = scoreDividendStability(history.data, evaluationDate); if (score !== null) scores.push({ symbol: constituentSymbol, score });
  }
  const scoreBySymbol = new Map(scores.map((item) => [item.symbol, item.score])); const valid = weights.flatMap((weight) => scoreBySymbol.has(weight.constituentSymbol) ? [{ weight: weight.weight, score: scoreBySymbol.get(weight.constituentSymbol)! }] : []); const totalWeight = weights.reduce((sum, row) => sum + row.weight, 0); const validWeight = valid.reduce((sum, row) => sum + row.weight, 0); const coverage = totalWeight > 0 ? validWeight / totalWeight : 0;
  if (coverage < 0.6 || validWeight <= 0) return [];
  return aggregateRows("VALUE_DIVIDEND", [{ metricKey: "DIVIDEND_STABILITY_SCORE", value: valid.reduce((sum, row) => sum + row.weight * row.score, 0) / validWeight, constituentCoverage: coverage, constituentCount: weights.length, validConstituentCount: valid.length, quality: coverage >= 0.8 ? "VALID" : "PARTIAL", effectiveDate: weights[0]?.effectiveDate ?? evaluationDate }], evaluationDate, fetchedAt);
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
  const fullBackfill = options.fullBackfill ?? (process.env.FULL_BACKFILL === "true" || Boolean(needsInitialHistory())); const range = { start: fullBackfill ? yearsBefore(end, 5) : yearsBefore(end, 1), end }; const warnings: string[] = []; const byBucket = new Map<ScorableAssetBucket, ProviderMetricObservationInput[]>();
  for (const proxy of proxies) { const price = await provider.getPriceSeries({ symbol: proxy.symbol, instrumentKind: proxy.instrumentKind, range, interval: "1day" }); const warning = providerMessage(price, `${proxy.label}行情`); if (warning) warnings.push(warning); if (price.ok) byBucket.set(proxy.bucket, priceRows(proxy.bucket, price)); }
  const indexPrices = proxies.filter((item) => item.bucket !== "GOLD").flatMap((proxy) => (byBucket.get(proxy.bucket) ?? []).filter((row) => row.metricKey === "PRICE_CLOSE").map((row) => ({ asOf: row.asOf } as PricePoint))); const dates = sampleDates(indexPrices, fullBackfill);
  for (const proxy of proxies.filter((item) => item.bucket !== "GOLD")) await fetchAndCacheWeights(provider, proxy.symbol, dates, warnings);
  for (const row of await refreshAggregatedValuation(provider, proxies, dates, fetchedAt, warnings)) byBucket.set(row.subjectId as ScorableAssetBucket, [...(byBucket.get(row.subjectId as ScorableAssetBucket) ?? []), row]);
  let directCapability = "READY";
  for (const proxy of proxies.filter((item) => item.bucket !== "GOLD")) { const direct = await provider.getValuationMetrics({ symbol: proxy.symbol, instrumentKind: "INDEX", metrics: ["PE_TTM", "PB"], range: { start: `${end.slice(0, 7)}-01`, end }, asOf: end }); if (!direct.ok && direct.error.code === "PERMISSION_DENIED") directCapability = "PERMISSION_DENIED"; const warning = providerMessage(direct, `${proxy.label}官方指数估值`); if (warning) warnings.push(warning); if (direct.ok) byBucket.set(proxy.bucket, [...(byBucket.get(proxy.bucket) ?? []), ...metricRows(proxy.bucket, direct)]); }
  const techRows = byBucket.get("TECH_GROWTH") ?? []; byBucket.set("TECH_GROWTH", [...techRows, ...forwardPeProxy(techRows)]);
  byBucket.set("GOLD", [...(byBucket.get("GOLD") ?? []), ...await refreshGoldMacro(fred, range, warnings), ...await refreshGoldEtfFlow(provider, { start: fullBackfill ? range.start : yearsBefore(end, 1), end }, warnings)]);
  const fundamentalRows = await refreshFundamentals(provider, proxies, end, range, fullBackfill, warnings, fetchedAt); const allRows = [...fundamentalRows.filter((row) => row.subjectType === "INSTRUMENT")];
  for (const row of fundamentalRows.filter((row) => row.subjectType === "ASSET_BUCKET")) byBucket.set(row.subjectId as ScorableAssetBucket, [...(byBucket.get(row.subjectId as ScorableAssetBucket) ?? []), row]);
  byBucket.set("VALUE_DIVIDEND", [...(byBucket.get("VALUE_DIVIDEND") ?? []), ...await refreshDividendStability(provider, proxies.find((item) => item.bucket === "VALUE_DIVIDEND"), end, fullBackfill, warnings, fetchedAt)]);
  for (const bucket of ["VALUE_DIVIDEND", "TECH_GROWTH", "BROAD_EQUITY"] as const) { const rows = byBucket.get(bucket) ?? []; const target = bucket === "BROAD_EQUITY" ? "INDEX_EARNINGS_GROWTH" : "EARNINGS_GROWTH"; if (!rows.some((row) => row.metricKey === target && row.provider === AGGREGATE_PROVIDER)) allRows.push(...derivedEarningsGrowth(bucket, rows, fetchedAt)); }
  allRows.push(...Array.from(byBucket.values()).flat()); const commit = commitProviderMetricObservations(allRows); const reports: BucketRefreshReport[] = [];
  for (const proxy of proxies) { const rows = allRows.filter((row) => row.subjectType === "ASSET_BUCKET" && row.subjectId === proxy.bucket); const latestAsOf = rows.reduce<string | null>((latest, row) => !latest || row.asOf > latest ? row.asOf : latest, null); const score = latestAsOf ? await refreshScoresForBuckets([{ bucket: proxy.bucket, asOf: latestAsOf }]) : []; reports.push({ bucket: proxy.bucket, proxy: proxy.label, symbol: proxy.symbol, observationCount: rows.length, latestAsOf, scoreSaved: score[0]?.saved ?? false, warnings }); }
  const status = reports.some((report) => report.observationCount > 0) ? (warnings.length ? "DEGRADED" : "READY") : "ERROR"; saveProviderStatus("tushare", status, fetchedAt, warnings, { index_dailybasic: directCapability, index_weight: "READY", daily_basic: "READY", fina_indicator: fullBackfill ? "REQUESTED" : "INCREMENTAL_PENDING", fund_share: "READY", fund_nav: "READY" }); saveProviderStatus("fred", process.env.FRED_API_KEY ? "READY" : "NOT_CONFIGURED", fetchedAt, process.env.FRED_API_KEY ? [] : ["缺少 FRED_API_KEY，黄金宏观指标保持缺失"], { DFII10: "REAL_YIELD_10Y", DTWEXBGS: "DOLLAR_INDEX" });
  return { provider: "tushare", status, fetchedAt, inserted: commit.inserted, updated: commit.updated, buckets: reports };
}
