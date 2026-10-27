import type { CanonicalMetricKey } from "@/metrics/catalog";

export interface IndexWeightPoint {
  indexSymbol: string;
  constituentSymbol: string;
  effectiveDate: string;
  weight: number;
}

export interface DailyBasicRow {
  symbol: string;
  tradeDate: string;
  peTtm: number | null;
  pb: number | null;
  psTtm: number | null;
  dividendYield: number | null;
}

export interface EquityFundamentalSnapshot {
  symbol: string;
  reportPeriod: string;
  availableAt: string;
  roe: number | null;
  earningsGrowth: number | null;
  revenueGrowth: number | null;
}

export interface AggregateMetricResult {
  metricKey: CanonicalMetricKey;
  value: number | null;
  /** 财报类汇总：按权重占主导的报告期（YYYY-MM-DD）。体检据此找「上一期」，见 health-check.ts */
  reportPeriod?: string;
  constituentCoverage: number;
  constituentCount: number;
  validConstituentCount: number;
  quality: "VALID" | "PARTIAL";
  effectiveDate: string;
}

function qualityFor(coverage: number): "VALID" | "PARTIAL" | null {
  if (coverage >= 0.8) return "VALID";
  if (coverage >= 0.6) return "PARTIAL";
  return null;
}

function activeWeights(weights: IndexWeightPoint[]) {
  const totalWeight = weights.reduce((sum, row) => sum + row.weight, 0);
  return { totalWeight, weights: weights.filter((row) => Number.isFinite(row.weight) && row.weight > 0) };
}

export function aggregateHarmonicMetric(
  metricKey: Extract<CanonicalMetricKey, "PE_TTM" | "PB" | "PS">,
  weights: IndexWeightPoint[],
  basics: DailyBasicRow[],
): AggregateMetricResult {
  const bySymbol = new Map(basics.map((row) => [row.symbol, row]));
  const { totalWeight, weights: validWeights } = activeWeights(weights);
  const field = metricKey === "PE_TTM" ? "peTtm" : metricKey === "PB" ? "pb" : "psTtm";
  const valid = validWeights.flatMap((weight) => {
    const value = bySymbol.get(weight.constituentSymbol)?.[field];
    return value !== null && value !== undefined && Number.isFinite(value) && value > 0 ? [{ weight: weight.weight, value }] : [];
  });
  const validWeight = valid.reduce((sum, row) => sum + row.weight, 0);
  const coverage = totalWeight > 0 ? validWeight / totalWeight : 0;
  const quality = qualityFor(coverage);
  const denominator = valid.reduce((sum, row) => sum + row.weight / row.value, 0);
  return {
    metricKey,
    value: quality && denominator > 0 ? validWeight / denominator : null,
    constituentCoverage: coverage,
    constituentCount: validWeights.length,
    validConstituentCount: valid.length,
    quality: quality ?? "PARTIAL",
    effectiveDate: weights[0]?.effectiveDate ?? "",
  };
}

export function aggregateDividendYield(weights: IndexWeightPoint[], basics: DailyBasicRow[]): AggregateMetricResult {
  const bySymbol = new Map(basics.map((row) => [row.symbol, row]));
  const { totalWeight, weights: validWeights } = activeWeights(weights);
  const valid = validWeights.flatMap((weight) => {
    const value = bySymbol.get(weight.constituentSymbol)?.dividendYield;
    // Zero is a genuine zero yield, unlike null which is unavailable.
    return value !== null && value !== undefined && Number.isFinite(value) && value >= 0 ? [{ weight: weight.weight, value }] : [];
  });
  const validWeight = valid.reduce((sum, row) => sum + row.weight, 0);
  const coverage = totalWeight > 0 ? validWeight / totalWeight : 0;
  const quality = qualityFor(coverage);
  return {
    metricKey: "DIVIDEND_YIELD",
    value: quality && validWeight > 0 ? valid.reduce((sum, row) => sum + row.weight * row.value, 0) / validWeight : null,
    constituentCoverage: coverage,
    constituentCount: validWeights.length,
    validConstituentCount: valid.length,
    quality: quality ?? "PARTIAL",
    effectiveDate: weights[0]?.effectiveDate ?? "",
  };
}

export function winsorize(values: number[], lowerPercentile = 0.05, upperPercentile = 0.95): number[] {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return [];
  const lower = sorted[Math.floor((sorted.length - 1) * lowerPercentile)];
  const upper = sorted[Math.ceil((sorted.length - 1) * upperPercentile)];
  return values.map((value) => Math.min(upper, Math.max(lower, value)));
}

export function aggregateFundamentalMetric(
  metricKey: Extract<CanonicalMetricKey, "ROE" | "EARNINGS_GROWTH" | "REVENUE_GROWTH" | "INDEX_EARNINGS_GROWTH">,
  weights: IndexWeightPoint[],
  fundamentals: EquityFundamentalSnapshot[],
  evaluationDate: string,
): AggregateMetricResult {
  const latestBySymbol = new Map<string, EquityFundamentalSnapshot>();
  for (const row of fundamentals) {
    if (row.availableAt.slice(0, 10) > evaluationDate) continue;
    const existing = latestBySymbol.get(row.symbol);
    if (!existing || row.availableAt > existing.availableAt) latestBySymbol.set(row.symbol, row);
  }
  const { totalWeight, weights: validWeights } = activeWeights(weights);
  const field = metricKey === "ROE" ? "roe" : metricKey === "REVENUE_GROWTH" ? "revenueGrowth" : "earningsGrowth";
  const usable = validWeights.flatMap((weight) => {
    const snapshot = latestBySymbol.get(weight.constituentSymbol);
    const value = snapshot?.[field];
    return snapshot && value !== null && value !== undefined && Number.isFinite(value) ? [{ weight: weight.weight, value, reportPeriod: snapshot.reportPeriod }] : [];
  });
  // 各成分股最新财报的报告期不一样（财报季里有人已出三季报、有人还是半年报）：取权重最大的那一期，平手取较新的
  const weightByPeriod = new Map<string, number>();
  for (const row of usable) weightByPeriod.set(row.reportPeriod, (weightByPeriod.get(row.reportPeriod) ?? 0) + row.weight);
  const reportPeriod = [...weightByPeriod.entries()]
    .sort((left, right) => right[1] - left[1] || right[0].localeCompare(left[0]))[0]?.[0];
  const validWeight = usable.reduce((sum, row) => sum + row.weight, 0);
  const coverage = totalWeight > 0 ? validWeight / totalWeight : 0;
  const quality = qualityFor(coverage);
  const clipped = winsorize(usable.map((row) => row.value));
  return {
    metricKey,
    value: quality && validWeight > 0 ? usable.reduce((sum, row, index) => sum + row.weight * clipped[index], 0) / validWeight : null,
    ...(reportPeriod ? { reportPeriod } : {}),
    constituentCoverage: coverage,
    constituentCount: validWeights.length,
    validConstituentCount: usable.length,
    quality: quality ?? "PARTIAL",
    effectiveDate: weights[0]?.effectiveDate ?? "",
  };
}
