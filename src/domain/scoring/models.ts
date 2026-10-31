import type { Confidence } from "../types";
import { DEFAULT_SCORING_CONFIG } from "./config";
import { clampScore, round1, scoreHistoricalMetric } from "./percentile";
import { deriveChangeSeries } from "./series-transforms";
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

/**
 * Trend Model v1.3：把长期趋势与均线结构从二值开关改为连续线性带。
 * 距离以百分点表示，落在 ±halfBandPct 带内线性插值（中点 50 分），两端饱和。
 * 可解释性优先于 logistic：Price = MA200 × 0.98 时长期趋势分约 30，一眼可算。
 */
function bandScore(distancePct: number, halfBandPct: number): number {
  return Math.min(100, Math.max(0, 50 + (distancePct / halfBandPct) * 50));
}

export function calculateTrend(input: TrendModelInput, asOf: string): SubscoreResult {
  const weights = DEFAULT_SCORING_CONFIG.componentWeights.trend;
  const price = input.price.value;
  const ma20 = input.ma20.value;
  const ma60 = input.ma60.value;
  const ma200 = input.ma200.value;
  const priceSource = input.price.source;
  const priceConfidence = input.price.confidence ?? (priceSource.toUpperCase().includes("MANUAL") ? "LOW" : "HIGH");

  // 长期趋势：价格相对 MA200 的偏离（百分点），±5% 线性带（v1.3）
  const d200 = price === null || ma200 === null || ma200 === 0 ? null : ((price / ma200 - 1) * 100);
  const ma200Score = d200 === null ? null : bandScore(d200, 5);
  // 均线结构：短期(MA20/MA60，±5% 带)占 35% + 长期(MA60/MA200，±10% 带)占 65%（v1.3）
  let alignmentScore: number | null = null;
  if (ma60 !== null && ma200 !== null && ma60 !== 0 && ma200 !== 0) {
    const longScore = bandScore((ma60 / ma200 - 1) * 100, 10);
    if (ma20 !== null && ma20 !== 0) {
      alignmentScore = bandScore((ma20 / ma60 - 1) * 100, 5) * 0.35 + longScore * 0.65;
    } else {
      alignmentScore = longScore;
    }
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
    momentum6m: scoreHistoricalMetric(input.momentum6m, weights.momentum6m, "HIGHER_IS_BETTER", asOf, "ALL"),
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
  // 科技 v1.4（Route B）：估值支柱 = PE_TTM 45% + PS 25% + PEG_TTM 30%（确定性变换）；
  // 基本面支柱 = 已实现盈利增长 55% + 营收增长 45%。不再消费 PARTIAL 前瞻代理。
  const growthAdjusted: ScoreComponentResult = input.peg
    ? scoreHistoricalMetric(input.peg, weights.cheapness.growthAdjustedValuation, "LOWER_IS_BETTER", input.asOf)
    : { rawValue: null, percentile: null, score: null, weight: weights.cheapness.growthAdjustedValuation, source: "UNAVAILABLE", asOf: input.asOf, confidence: "LOW" };
  const cheapness = combineComponents({
    pe: scoreHistoricalMetric(input.pe, weights.cheapness.pe, "LOWER_IS_BETTER", input.asOf),
    ps: scoreHistoricalMetric(input.ps, weights.cheapness.ps, "LOWER_IS_BETTER", input.asOf),
    growthAdjustedValuation: growthAdjusted,
  });
  const fundamental = combineComponents({
    earningsGrowth: scoreHistoricalMetric(input.earningsGrowth, weights.fundamental.earningsGrowth, "HIGHER_IS_BETTER", input.asOf),
    revenueGrowth: scoreHistoricalMetric(input.revenueGrowth, weights.fundamental.revenueGrowth, "HIGHER_IS_BETTER", input.asOf),
  });
  return { cheapness, fundamental, trend: calculateTrend(input.trend, input.asOf) };
}

/**
 * 该指标能否支撑 HIGH 置信度（与 historyConfidence 的判定一致）：
 * 最新数据非 PARTIAL 且来源不是派生/代理。确定性变换类来源应使用
 * DERIVED:<特征>:<主数据源> 命名以获得豁免。
 */
function metricCanSupportHighConfidence(metric: { source: string; quality?: "VALID" | "PARTIAL" }): boolean {
  return metric.quality !== "PARTIAL" && !metric.source.toUpperCase().includes("DERIVED");
}
function calculateBroadEquity(input: BroadEquityInput) {
  const weights = DEFAULT_SCORING_CONFIG.componentWeights.BROAD_EQUITY;
  // 低可信 ERP 不进入主评分：当前 EQUITY_RISK_PREMIUM 是「沪深300 盈利收益率 − 美国10Y 实际利率」
  // 的估算代理（PARTIAL），且跨市场语义存疑；回退到 PE/PB 双因子（cheapnessWithoutErp）。
  const cheapness = input.equityRiskPremium && metricCanSupportHighConfidence(input.equityRiskPremium)
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
    longTermPricePosition: scoreHistoricalMetric(input.pricePosition, weights.cheapness.longTermPricePosition, "LOWER_IS_BETTER", input.asOf, "ALL"),
    distanceFromMa200: scoreHistoricalMetric(input.distanceFromMa200, weights.cheapness.distanceFromMa200, "LOWER_IS_BETTER", input.asOf, "ALL"),
    momentumCrowding: scoreHistoricalMetric(input.momentum3m, weights.cheapness.momentumCrowding, "LOWER_IS_BETTER", input.asOf, "ALL"),
  });
  // 黄金 v1.2（docs/hengcang_gold_model_revision_v1_2.md §6/§16）：
  // 宏观支持度 = 水平项(实际利率 25% + 美元 20%) + 边际变化项(各 15%/10%) + 资金面(ETF 流 15% + 央行购金 15%)。
  const realYieldChange3m = deriveChangeSeries(input.realYield, 90);
  const dollarChange3m = deriveChangeSeries(input.dollarIndex, 90);
  const fundamentalComponents: Record<string, ScoreComponentResult> = {
    realYieldLevel: scoreHistoricalMetric(input.realYield, weights.fundamental.realYieldLevel, "LOWER_IS_BETTER", input.asOf),
    realYieldChange3m: scoreHistoricalMetric(realYieldChange3m, weights.fundamental.realYieldChange3m, "LOWER_IS_BETTER", input.asOf),
    dollarLevel: scoreHistoricalMetric(input.dollarIndex, weights.fundamental.dollarLevel, "LOWER_IS_BETTER", input.asOf),
    dollarChange3m: scoreHistoricalMetric(dollarChange3m, weights.fundamental.dollarChange3m, "LOWER_IS_BETTER", input.asOf),
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
