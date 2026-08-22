import type { Confidence, RecommendationState } from "../types";
import { DEFAULT_SCORING_CONFIG, assertScoringConfig, type ScoringConfig } from "./config";
import { combineComponents, calculateModelSubscores } from "./models";
import { clampScore, round1 } from "./percentile";
import { confirmStateTransition, getBaseState, shouldSuppressRecommendation } from "./state";
import type { AssetModelInput, ScoreComponentResult, ScoreResult, ScoreRiskContext, SubscoreResult } from "./types";

function worseConfidence(first: Confidence, second: Confidence): Confidence {
  const rank = { HIGH: 2, MEDIUM: 1, LOW: 0 } as const;
  return rank[first] <= rank[second] ? first : second;
}

export function calculateOpportunityScore(
  cheapness: number,
  fundamental: number,
  trend: number,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
): number {
  assertScoringConfig(config);
  return round1(
    clampScore(
      cheapness * config.scoreWeights.cheapness +
        fundamental * config.scoreWeights.fundamental +
        trend * config.scoreWeights.trend,
    ),
  );
}

export function applyRiskRules(input: {
  opportunityScore: number | null;
  fundamentalScore: number | null;
  fundamentalCoverage?: number;
  confidence: Confidence;
  currentWeightBps?: number;
  positionLimitBps?: number;
  config?: ScoringConfig;
}): { state: RecommendationState; allowAdd: boolean; forceSell: false; reasons: string[]; immediate: boolean } {
  const config = input.config ?? DEFAULT_SCORING_CONFIG;
  const reasons: string[] = [];

  const fundamentalCoverage = input.fundamentalCoverage ?? 1;
  if (
    input.fundamentalScore !== null &&
    fundamentalCoverage >= config.history.lowConfidenceCoverage &&
    input.fundamentalScore < config.thresholds.fundamentalCircuitBreaker
  ) {
    reasons.push(`基本面分低于 ${config.thresholds.fundamentalCircuitBreaker}，暂停新增并重新评估投资逻辑`);
    return { state: "REASSESS_THESIS", allowAdd: false, forceSell: false, reasons, immediate: true };
  }
  if (
    input.currentWeightBps !== undefined &&
    input.positionLimitBps !== undefined &&
    input.currentWeightBps > input.positionLimitBps
  ) {
    reasons.push("当前仓位严格超过适用上限：停止新增，不强制卖出");
    return { state: "OVERWEIGHT", allowAdd: false, forceSell: false, reasons, immediate: true };
  }
  if (input.opportunityScore === null || input.fundamentalScore === null || input.confidence === "LOW") {
    reasons.push("数据可信度不足，禁止输出增配状态");
    return { state: "LOW_CONFIDENCE", allowAdd: false, forceSell: false, reasons, immediate: true };
  }

  const state = getBaseState(input.opportunityScore, config);
  return {
    state,
    allowAdd: state === "STRONG_ADD_ALLOWED" || state === "LIGHT_ADD_ALLOWED",
    forceSell: false,
    reasons,
    immediate: false,
  };
}

function subscoreComponent(key: string, result: SubscoreResult, weight: number, asOf: string): ScoreComponentResult {
  return {
    rawValue: result.score,
    percentile: null,
    score: result.score,
    weight,
    source: "SCORING_ENGINE_V1",
    asOf,
    confidence: result.confidence,
  };
}

export function calculateAssetScore(
  input: AssetModelInput,
  risk: ScoreRiskContext = {},
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
): ScoreResult {
  assertScoringConfig(config);
  const subscores = calculateModelSubscores(input);
  const opportunity = combineComponents({
    cheapness: subscoreComponent("cheapness", subscores.cheapness, config.scoreWeights.cheapness, input.asOf),
    fundamental: subscoreComponent("fundamental", subscores.fundamental, config.scoreWeights.fundamental, input.asOf),
    trend: subscoreComponent("trend", subscores.trend, config.scoreWeights.trend, input.asOf),
  });
  const confidence = risk.confidenceOverride
    ? worseConfidence(opportunity.confidence, risk.confidenceOverride)
    : opportunity.confidence;
  const rules = applyRiskRules({
    opportunityScore: opportunity.score,
    fundamentalScore: subscores.fundamental.score,
    fundamentalCoverage: subscores.fundamental.coverage,
    confidence,
    currentWeightBps: risk.currentWeightBps,
    positionLimitBps: risk.positionLimitBps,
    config,
  });
  const confirmation = risk.previousState
    ? confirmStateTransition({
        previousState: risk.previousState,
        candidateState: rules.state,
        candidateHistory: risk.candidateHistory ?? [],
        immediate: rules.immediate,
        confirmationTradingDays: config.signalRules.confirmationTradingDays,
      })
    : { state: rules.state, confirmed: true };
  const signalSuppressed = Boolean(
    risk.lastDecisionDirection &&
      risk.lastDecisionAt &&
      shouldSuppressRecommendation({
        state: confirmation.state,
        lastDecisionDirection: risk.lastDecisionDirection,
        lastDecisionAt: risk.lastDecisionAt,
        asOf: input.asOf,
        cooldownDays: config.signalRules.cooldownDays,
      }),
  );
  const components = {
    ...Object.fromEntries(Object.entries(subscores.cheapness.components).map(([key, value]) => [`cheapness.${key}`, value])),
    ...Object.fromEntries(Object.entries(subscores.fundamental.components).map(([key, value]) => [`fundamental.${key}`, value])),
    ...Object.fromEntries(Object.entries(subscores.trend.components).map(([key, value]) => [`trend.${key}`, value])),
  };
  return {
    bucket: input.bucket,
    asOf: input.asOf,
    cheapnessScore: subscores.cheapness.score,
    fundamentalScore: subscores.fundamental.score,
    trendScore: subscores.trend.score,
    opportunityScore: opportunity.score,
    confidence,
    candidateState: rules.state,
    state: confirmation.state,
    stateConfirmed: confirmation.confirmed,
    signalSuppressed,
    allowAdd: rules.allowAdd && confirmation.confirmed && !signalSuppressed,
    forceSell: false,
    components,
    missingMetrics: [
      ...subscores.cheapness.missingMetrics.map((key) => `cheapness.${key}`),
      ...subscores.fundamental.missingMetrics.map((key) => `fundamental.${key}`),
      ...subscores.trend.missingMetrics.map((key) => `trend.${key}`),
    ],
    reasons: [
      ...rules.reasons,
      ...(!confirmation.confirmed ? ["候选状态尚未连续三个交易日确认"] : []),
      ...(signalSuppressed ? ["七天冷却期内，同方向建议已抑制"] : []),
    ],
  };
}
