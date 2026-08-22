import { eq } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import { dataSourceStatus } from "@/db/schema";
import type { ScorableAssetBucket } from "@/domain/types";
import type { CanonicalMetricKey } from "@/metrics/catalog";
import {
  commitProviderMetricObservations,
  type ProviderMetricObservationInput,
} from "@/metrics/observation-repository";
import { TushareProvider } from "@/providers/tushare";
import { getTushareScoreProxies, type TushareScoreProxy } from "@/providers/tushare/proxies";
import type { MetricPoint, PricePoint, ProviderResult } from "@/providers/types";
import { refreshScoresForBuckets } from "./scoring-refresh-service";

interface BucketRefreshReport {
  bucket: ScorableAssetBucket;
  proxy: string;
  symbol: string;
  observationCount: number;
  latestAsOf: string | null;
  scoreSaved: boolean;
  warnings: string[];
}

export interface AutomaticRefreshReport {
  provider: "tushare";
  status: "READY" | "DEGRADED" | "ERROR" | "NOT_CONFIGURED";
  fetchedAt: string;
  inserted: number;
  updated: number;
  buckets: BucketRefreshReport[];
}

interface AutomaticRefreshOptions {
  provider?: TushareProvider;
  now?: Date;
  proxies?: TushareScoreProxy[];
}

function shanghaiDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function yearsBefore(day: string, years: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCFullYear(date.getUTCFullYear() - years);
  return date.toISOString().slice(0, 10);
}

function providerMessage<T>(result: ProviderResult<T>, label: string): string | null {
  if (result.ok) return result.data instanceof Array && result.data.length === 0 ? `${label}没有返回数据` : null;
  return `${label}：${result.error.message}`;
}

function priceObservations(
  bucket: ScorableAssetBucket,
  result: Extract<ProviderResult<PricePoint[]>, { ok: true }>,
): ProviderMetricObservationInput[] {
  return result.data.map((point) => ({
    subjectType: "ASSET_BUCKET",
    subjectId: bucket,
    metricKey: "PRICE_CLOSE",
    value: point.close,
    unit: "price",
    provider: result.provider,
    observedAt: point.observedAt,
    availableAt: point.availableAt,
    asOf: point.asOf,
    fetchedAt: result.fetchedAt,
    quality: result.quality,
  }));
}

function metricObservations(
  bucket: ScorableAssetBucket,
  result: Extract<ProviderResult<MetricPoint[]>, { ok: true }>,
): ProviderMetricObservationInput[] {
  return result.data.flatMap((point): ProviderMetricObservationInput[] => {
    if (bucket === "TECH_GROWTH" && point.key === "PE_TTM") {
      return [{
        subjectType: "ASSET_BUCKET",
        subjectId: bucket,
        metricKey: "PE_FORWARD",
        value: point.value,
        unit: point.unit,
        provider: result.provider,
        observedAt: point.observedAt,
        availableAt: point.availableAt,
        asOf: point.asOf,
        fetchedAt: result.fetchedAt,
        quality: "PARTIAL",
      }];
    }
    if (!(point.key === "PE_TTM" || point.key === "PB" || point.key === "PS" || point.key === "DIVIDEND_YIELD" || point.key === "REAL_YIELD_10Y")) {
      return [];
    }
    return [{
      subjectType: "ASSET_BUCKET",
      subjectId: bucket,
      metricKey: point.key as CanonicalMetricKey,
      value: point.value,
      unit: point.unit,
      provider: result.provider,
      observedAt: point.observedAt,
      availableAt: point.availableAt,
      asOf: point.asOf,
      fetchedAt: result.fetchedAt,
      quality: result.quality,
    }];
  });
}

function deriveImpliedEarningsGrowth(
  bucket: Exclude<ScorableAssetBucket, "GOLD">,
  rows: ProviderMetricObservationInput[],
  fetchedAt: string,
): ProviderMetricObservationInput[] {
  const prices = new Map(rows.filter((row) => row.metricKey === "PRICE_CLOSE").map((row) => [row.asOf, Number(row.value)]));
  const peKey = bucket === "TECH_GROWTH" ? "PE_FORWARD" : "PE_TTM";
  const peRows = rows
    .filter((row) => row.metricKey === peKey)
    .sort((first, second) => first.asOf.localeCompare(second.asOf));
  const earningsSeries = peRows.flatMap((row) => {
    const price = prices.get(row.asOf);
    const pe = Number(row.value);
    return price && pe > 0 ? [{ row, value: price / pe }] : [];
  });
  const outputKey: CanonicalMetricKey = bucket === "BROAD_EQUITY" ? "INDEX_EARNINGS_GROWTH" : "EARNINGS_GROWTH";
  const derived: ProviderMetricObservationInput[] = [];
  for (let index = 252; index < earningsSeries.length; index += 1) {
    const current = earningsSeries[index];
    const previous = earningsSeries[index - 252];
    if (previous.value === 0) continue;
    const value = (current.value / previous.value - 1) * 100;
    if (!Number.isFinite(value)) continue;
    derived.push({
      subjectType: "ASSET_BUCKET",
      subjectId: bucket,
      metricKey: outputKey,
      value: value.toFixed(6),
      unit: "percent",
      provider: "tushare-derived",
      observedAt: current.row.observedAt,
      availableAt: current.row.availableAt,
      asOf: current.row.asOf,
      fetchedAt,
      quality: "PARTIAL",
    });
  }
  return derived;
}

function saveProviderStatus(status: AutomaticRefreshReport["status"], now: string, errorMessages: string[]) {
  const db = getDatabase();
  const previous = db.select().from(dataSourceStatus).where(eq(dataSourceStatus.provider, "tushare")).get();
  const values = {
    enabled: status !== "NOT_CONFIGURED",
    status,
    lastAttemptAt: now,
    lastSuccessAt: status === "READY" || status === "DEGRADED" ? now : previous?.lastSuccessAt ?? null,
    lastErrorCode: errorMessages.length > 0 ? (status === "NOT_CONFIGURED" ? "NOT_CONFIGURED" : "PARTIAL_FAILURE") : null,
    lastErrorMessage: errorMessages.length > 0 ? errorMessages.slice(0, 8).join("；") : null,
    capabilitiesJson: JSON.stringify(["PRICE_SERIES", "VALUATION_METRICS", "FUNDAMENTAL_METRICS", "MACRO_SERIES"]),
    updatedAt: now,
  };
  db.insert(dataSourceStatus)
    .values({ id: "provider-tushare", provider: "tushare", ...values })
    .onConflictDoUpdate({ target: dataSourceStatus.provider, set: values })
    .run();
}

export async function refreshAutomaticMarketData(
  options: AutomaticRefreshOptions = {},
): Promise<AutomaticRefreshReport> {
  const nowDate = options.now ?? new Date();
  const fetchedAt = nowDate.toISOString();
  const end = shanghaiDate(nowDate);
  const range = { start: yearsBefore(end, 5), end };
  const provider = options.provider ?? new TushareProvider();
  const proxies = options.proxies ?? getTushareScoreProxies();

  if (!process.env.TUSHARE_TOKEN && !options.provider) {
    const message = "尚未在本机环境中配置 TUSHARE_TOKEN";
    saveProviderStatus("NOT_CONFIGURED", fetchedAt, [message]);
    return { provider: "tushare", status: "NOT_CONFIGURED", fetchedAt, inserted: 0, updated: 0, buckets: [] };
  }

  let inserted = 0;
  let updated = 0;
  const allWarnings: string[] = [];
  const reports: BucketRefreshReport[] = [];

  for (const proxy of proxies) {
    const warnings: string[] = [];
    const bucketRows: ProviderMetricObservationInput[] = [];
    const prices = await provider.getPriceSeries({
      symbol: proxy.symbol,
      instrumentKind: proxy.instrumentKind,
      range,
      interval: "1day",
    });
    const priceWarning = providerMessage(prices, `${proxy.label}行情`);
    if (priceWarning) warnings.push(priceWarning);
    if (prices.ok) bucketRows.push(...priceObservations(proxy.bucket, prices));

    if (proxy.valuationMetrics.length > 0) {
      const valuation = await provider.getValuationMetrics({
        symbol: proxy.symbol,
        instrumentKind: proxy.instrumentKind,
        metrics: proxy.valuationMetrics,
        range,
        asOf: end,
      });
      const valuationWarning = providerMessage(valuation, `${proxy.label}估值`);
      if (valuationWarning) warnings.push(valuationWarning);
      if (valuation.ok) bucketRows.push(...metricObservations(proxy.bucket, valuation));
    }

    if (proxy.bucket === "GOLD") {
      const realYield = await provider.getMacroSeries({ seriesId: "REAL_YIELD_10Y", range });
      const macroWarning = providerMessage(realYield, "美国 10 年实际利率");
      if (macroWarning) warnings.push(macroWarning);
      if (realYield.ok) bucketRows.push(...metricObservations(proxy.bucket, realYield));
    } else {
      bucketRows.push(...deriveImpliedEarningsGrowth(proxy.bucket, bucketRows, fetchedAt));
    }

    const commit = commitProviderMetricObservations(bucketRows);
    inserted += commit.inserted;
    updated += commit.updated;
    const latestAsOf = bucketRows.reduce<string | null>(
      (latest, row) => latest === null || row.asOf > latest ? row.asOf : latest,
      null,
    );
    let scoreSaved = false;
    if (latestAsOf) {
      const scores = await refreshScoresForBuckets([{ bucket: proxy.bucket, asOf: latestAsOf }]);
      scoreSaved = scores[0]?.saved ?? false;
    }
    allWarnings.push(...warnings);
    reports.push({
      bucket: proxy.bucket,
      proxy: proxy.label,
      symbol: proxy.symbol,
      observationCount: bucketRows.length,
      latestAsOf,
      scoreSaved,
      warnings,
    });
  }

  const totalObservations = reports.reduce((sum, report) => sum + report.observationCount, 0);
  const status = totalObservations === 0 ? "ERROR" : allWarnings.length > 0 ? "DEGRADED" : "READY";
  saveProviderStatus(status, fetchedAt, allWarnings);
  return { provider: "tushare", status, fetchedAt, inserted, updated, buckets: reports };
}
