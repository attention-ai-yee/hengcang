import type { Confidence } from "../types";
import { DEFAULT_SCORING_CONFIG } from "./config";
import { clampScore, round1, scoreHistoricalMetric } from "./percentile";
import type {
  AssetModelInput,
  DirectScoreMetric,
  GoldInput,
  MetricSeries,
  ScoreComponentResult,
  SubscoreResult,
  TechGrowthInput,
  TrendModelInput,
  ValueDividendInput,
  BroadEquityInput,
} from "./types";

function directComponent(metric: DirectScoreMetric, weight: number): ScoreComponentResult {
  const valid = metric.score !== null && Number.isFinite(metric.score);
  return {
    rawValue: metric.score,
    percentile: null,
    score: valid ? round1(clampScore(metric.score as number)) : null,
    weight,
    source: metric.source,
    asOf: metric.asOf,
    // PARTIAL 直分封顶中可信度（M10 / v1.1 §27）
    confidence: (() => {
      const declared = metric.confidence ?? (metric.source.toUpperCase().includes("MANUAL") ? "LOW" : "HIGH");
      return metric.quality === "PARTIAL" ? worstConfidence([declared, "MEDIUM"]) : declared;
    })(),
    quality: metric.quality,
    coverage: metric.coverage,
  };
}

function worstConfidence(values: Confidence[]): Confidence {
  if (values.includes("LOW")) return "LOW";
  if (values.includes("MEDIUM")) return "MEDIUM";
  return "HIGH";
}

export function combineComponents(
  components: Record<string, ScoreComponentResult>,
  confidenceThresholds = {
    mediumCoverage: DEFAULT_SCORING_CONFIG.history.mediumCoverage,
    highCoverage: DEFAULT_SCORING_CONFIG.history.highCoverage,
  },
): SubscoreResult {
  const entries = Object.entries(components);
  const totalWeight = entries.reduce((sum, [, component]) => sum + component.weight, 0);
  const available = entries.filter(([, component]) => component.score !== null);
  const availableWeight = available.reduce((sum, [, component]) => sum + component.weight, 0);
  const coverage = totalWeight > 0 ? availableWeight / totalWeight : 0;
  const missingMetrics = entries.filter(([, component]) => component.score === null).map(([key]) => key);

  if (availableWeight <= 0) {
    return { score: null, coverage: 0, confidence: "LOW", components, missingMetrics };
  }

  const score = round1(
    available.reduce((sum, [, component]) => sum + (component.score as number) * component.weight, 0) /
      availableWeight,
  );
  const sourceConfidence = worstConfidence(available.map(([, component]) => component.confidence));
  // 覆盖率档位只用于“降级”，不得抬高来源置信度：手工/代理来源的 LOW
  // 不能因为覆盖率达标而被覆盖成 MEDIUM/HIGH（Code Review M10/L5 同源问题）。
  const coverageTier: Confidence =
    coverage < confidenceThresholds.mediumCoverage
      ? "LOW"
      : coverage <= confidenceThresholds.highCoverage
        ? "MEDIUM"
        : "HIGH";
  const confidence = worstConfidence([coverageTier, sourceConfidence]);

  return { score, coverage: round1(coverage * 100) / 100, confidence, components, missingMetrics };
}

export function calculateTrend(input: TrendModelInput, asOf: string): SubscoreResult {
  const weights = DEFAULT_SCORING_CONFIG.componentWeights.trend;
  const price = input.price.value;
  const ma20 = input.ma20.value;
  const ma60 = input.ma60.value;
  const ma200 = input.ma200.value;
  const priceSource = input.price.source;
  const priceConfidence = input.price.confidence ?? (priceSource.toUpperCase().includes("MANUAL") ? "LOW" : "HIGH");

  const ma200Score = price === null || ma200 === null ? null : price > ma200 ? 100 : 0;
  let alignmentScore: number | null = null;
  if (ma60 !== null && ma200 !== null) {
    alignmentScore = ma20 !== null && ma20 > ma60 && ma60 > ma200 ? 100 : ma60 > ma200 ? 66.6667 : 0;
  }

  return combineComponents({
    ma200: {
      rawValue: price === null || ma200 === null ? null : price / ma200 - 1,
      percentile: null,
      score: ma200Score,
      weight: weights.ma200,
      source: priceSource,
      asOf,
      confidence: priceConfidence,
      quality: input.price.quality,
      coverage: input.price.coverage,
    },
    maAlignment: {
      rawValue: alignmentScore,
      percentile: null,
      score: alignmentScore,
      weight: weights.maAlignment,
      source: input.ma60.source,
      asOf,
      confidence: input.ma60.confidence ?? (input.ma60.source.toUpperCase().includes("MANUAL") ? "LOW" : "HIGH"),
      quality: input.ma60.quality,
      coverage: input.ma60.coverage,
    },
    momentum6m: scoreHistoricalMetric(input.momentum6m, weights.momentum6m, "HIGHER_IS_BETTER", asOf),
  });
}

function overrideSubscore(metric: DirectScoreMetric, key: string): SubscoreResult {
  return combineComponents({ [key]: directComponent(metric, 1) });
}

function calculateValueDividend(input: ValueDividendInput) {
  const weights = DEFAULT_SCORING_CONFIG.componentWeights.VALUE_DIVIDEND;
  const cheapness = combineComponents({
    pe: scoreHistoricalMetric(input.pe, weights.cheapness.pe, "LOWER_IS_BETTER", input.asOf),
    pb: scoreHistoricalMetric(input.pb, weights.cheapness.pb, "LOWER_IS_BETTER", input.asOf),
    dividendYield: scoreHistoricalMetric(input.dividendYield, weights.cheapness.dividendYield, "HIGHER_IS_BETTER", input.asOf),
  });
  const fundamental = input.fundamentalOverride
    ? overrideSubscore(input.fundamentalOverride, "fundamentalOverride")
    : combineComponents({
        earningsGrowth: scoreHistoricalMetric(input.earningsGrowth, weights.fundamental.earningsGrowth, "HIGHER_IS_BETTER", input.asOf),
        roe: scoreHistoricalMetric(input.roe, weights.fundamental.roe, "HIGHER_IS_BETTER", input.asOf),
        dividendStability: directComponent(input.dividendStability, weights.fundamental.dividendStability),
      });
  return { cheapness, fundamental, trend: calculateTrend(input.trend, input.asOf) };
}

function calculateTechGrowth(input: TechGrowthInput) {
  const weights = DEFAULT_SCORING_CONFIG.componentWeights.TECH_GROWTH;
  const forwardPe = scoreHistoricalMetric(input.forwardPe, weights.cheapness.forwardPe, "LOWER_IS_BETTER", input.asOf);
  let growthAdjusted: ScoreComponentResult;
  if (input.expectedEarningsGrowth.currentValue !== null && input.expectedEarningsGrowth.currentValue <= 0) {
    growthAdjusted = {
      rawValue: input.expectedEarningsGrowth.currentValue,
      percentile: null,
      score: forwardPe.score === null ? null : Math.min(30, forwardPe.score),
      weight: weights.cheapness.growthAdjustedValuation,
      source: input.expectedEarningsGrowth.source,
      asOf: input.asOf,
      confidence: forwardPe.confidence,
      quality: forwardPe.quality,
      coverage: forwardPe.coverage,
    };
  } else if (input.peg) {
    growthAdjusted = scoreHistoricalMetric(input.peg, weights.cheapness.growthAdjustedValuation, "LOWER_IS_BETTER", input.asOf);
  } else {
    growthAdjusted = {
      rawValue: null,
      percentile: null,
      score: null,
      weight: weights.cheapness.growthAdjustedValuation,
      source: input.forwardPe.source,
      asOf: input.asOf,
      confidence: "LOW",
      quality: input.forwardPe.quality,
      coverage: input.forwardPe.coverage,
    };
  }
  const cheapness = combineComponents({
    forwardPe,
    ps: scoreHistoricalMetric(input.ps, weights.cheapness.ps, "LOWER_IS_BETTER", input.asOf),
    growthAdjustedValuation: growthAdjusted,
  });
  const fundamental = input.earningsRevision
    ? combineComponents({
        earningsGrowth: scoreHistoricalMetric(input.earningsGrowth, weights.fundamental.earningsGrowth, "HIGHER_IS_BETTER", input.asOf),
        revenueGrowth: scoreHistoricalMetric(input.revenueGrowth, weights.fundamental.revenueGrowth, "HIGHER_IS_BETTER", input.asOf),
        earningsRevision: scoreHistoricalMetric(input.earningsRevision, weights.fundamental.earningsRevision, "HIGHER_IS_BETTER", input.asOf),
      })
    : combineComponents({
        earningsGrowth: scoreHistoricalMetric(input.earningsGrowth, weights.fundamentalWithoutRevision.earningsGrowth, "HIGHER_IS_BETTER", input.asOf),
        revenueGrowth: scoreHistoricalMetric(input.revenueGrowth, weights.fundamentalWithoutRevision.revenueGrowth, "HIGHER_IS_BETTER", input.asOf),
      });
  return { cheapness, fundamental, trend: calculateTrend(input.trend, input.asOf) };
}

function calculateBroadEquity(input: BroadEquityInput) {
  const weights = DEFAULT_SCORING_CONFIG.componentWeights.BROAD_EQUITY;
  const cheapness = input.equityRiskPremium
    ? combineComponents({
        pe: scoreHistoricalMetric(input.pe, weights.cheapness.pe, "LOWER_IS_BETTER", input.asOf),
        pb: scoreHistoricalMetric(input.pb, weights.cheapness.pb, "LOWER_IS_BETTER", input.asOf),
        equityRiskPremium: scoreHistoricalMetric(input.equityRiskPremium, weights.cheapness.equityRiskPremium, "HIGHER_IS_BETTER", input.asOf),
      })
    : combineComponents({
        pe: scoreHistoricalMetric(input.pe, weights.cheapnessWithoutErp.pe, "LOWER_IS_BETTER", input.asOf),
        pb: scoreHistoricalMetric(input.pb, weights.cheapnessWithoutErp.pb, "LOWER_IS_BETTER", input.asOf),
      });
  const fundamental = input.earningsRevision
    ? combineComponents({
        indexEarningsGrowth: scoreHistoricalMetric(input.indexEarningsGrowth, weights.fundamental.indexEarningsGrowth, "HIGHER_IS_BETTER", input.asOf),
        earningsRevision: scoreHistoricalMetric(input.earningsRevision, weights.fundamental.earningsRevision, "HIGHER_IS_BETTER", input.asOf),
      })
    : combineComponents({
        indexEarningsGrowth: scoreHistoricalMetric(input.indexEarningsGrowth, 1, "HIGHER_IS_BETTER", input.asOf),
      });
  return { cheapness, fundamental, trend: calculateTrend(input.trend, input.asOf) };
}

function isMetricSeries(value: GoldInput["centralBankDemand"]): value is MetricSeries {
  return Boolean(value && "history" in value);
}

function calculateGold(input: GoldInput) {
  const weights = DEFAULT_SCORING_CONFIG.componentWeights.GOLD;
  const cheapness = combineComponents({
    longTermPricePosition: scoreHistoricalMetric(input.pricePosition, weights.cheapness.longTermPricePosition, "LOWER_IS_BETTER", input.asOf),
    distanceFromMa200: scoreHistoricalMetric(input.distanceFromMa200, weights.cheapness.distanceFromMa200, "LOWER_IS_BETTER", input.asOf),
    momentumCrowding: scoreHistoricalMetric(input.momentum3m, weights.cheapness.momentumCrowding, "LOWER_IS_BETTER", input.asOf),
  });
  const fundamentalComponents: Record<string, ScoreComponentResult> = {
    realYield: scoreHistoricalMetric(input.realYield, weights.fundamental.realYield, "LOWER_IS_BETTER", input.asOf),
    dollar: scoreHistoricalMetric(input.dollarIndex, weights.fundamental.dollar, "LOWER_IS_BETTER", input.asOf),
    etfFlow: input.etfFlow
      ? scoreHistoricalMetric(input.etfFlow, weights.fundamental.etfFlow, "HIGHER_IS_BETTER", input.asOf)
      : { rawValue: null, percentile: null, score: null, weight: weights.fundamental.etfFlow, source: "UNAVAILABLE", asOf: input.asOf, confidence: "LOW" },
    centralBankDemand: input.centralBankDemand
      ? isMetricSeries(input.centralBankDemand)
        ? scoreHistoricalMetric(input.centralBankDemand, weights.fundamental.centralBankDemand, "HIGHER_IS_BETTER", input.asOf)
        : directComponent(input.centralBankDemand, weights.fundamental.centralBankDemand)
      : { rawValue: null, percentile: null, score: null, weight: weights.fundamental.centralBankDemand, source: "UNAVAILABLE", asOf: input.asOf, confidence: "LOW" },
  };
  return {
    cheapness,
    fundamental: combineComponents(fundamentalComponents),
    trend: calculateTrend(input.trend, input.asOf),
  };
}

export function calculateModelSubscores(input: AssetModelInput) {
  switch (input.bucket) {
    case "VALUE_DIVIDEND":
      return calculateValueDividend(input);
    case "TECH_GROWTH":
      return calculateTechGrowth(input);
    case "BROAD_EQUITY":
      return calculateBroadEquity(input);
    case "GOLD":
      return calculateGold(input);
  }
}
