import type { Confidence, RecommendationState, RiskSeverity, ScorableAssetBucket } from "../types";
import { DEFAULT_SCORING_CONFIG, assertScoringConfig, type ScoringConfig } from "./config";
import { assessFundamentalHealth, type FundamentalHealthStatus } from "./health-check";
import { combineComponents, calculateModelSubscores } from "./models";
import { clampScore, round1 } from "./percentile";
import { confirmStateTransition, getBaseState, shouldSuppressRecommendation } from "./state";
import type { AssetModelInput, ScoreComponentResult, ScoreResult, ScoreRiskContext, SubscoreResult } from "./types";

function worseConfidence(first: Confidence, second: Confidence): Confidence {
  const rank = { HIGH: 2, MEDIUM: 1, LOW: 0 } as const;
  return rank[first] <= rank[second] ? first : second;
}

/** v6：配置吸引力分 = 便宜程度 × 70% + 趋势 × 30%（基本面改为体检，不再加权）。 */
export function calculateOpportunityScore(
  cheapness: number,
  trend: number,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
): number {
  assertScoringConfig(config);
  return round1(clampScore(cheapness * config.scoreWeights.cheapness + trend * config.scoreWeights.trend));
}

export function applyRiskRules(input: {
  bucket?: ScorableAssetBucket;
  opportunityScore: number | null;
  /** 基本面体检结果（v6）；缺省按「数据不足」处理 */
  fundamentalHealth?: FundamentalHealthStatus;
  /** 体检给出的具体原因（哪条规则、哪两期数值），写进状态原因 */
  healthReasons?: string[];
  confidence: Confidence;
  currentWeightBps?: number;
  positionLimitBps?: number;
  hardLimitExceeded?: boolean;
  hardLimitLabel?: string;
  config?: ScoringConfig;
}): { state: RecommendationState; allowAdd: boolean; forceSell: false; reasons: string[]; immediate: boolean } {
  const config = input.config ?? DEFAULT_SCORING_CONFIG;
  const reasons: string[] = [];
  const health = input.fundamentalHealth ?? "UNKNOWN";

  // 体检不通过（如盈利连续两期同比为负）→ 暂停新增、重新评估投资逻辑，即时生效。
  // 黄金没有经营基本面（NOT_APPLICABLE），宏观支持度只展示、不拦路。
  if (input.bucket !== "GOLD" && health === "DETERIORATING") {
    reasons.push(...(input.healthReasons ?? []), "基本面体检不通过：暂停新增并重新评估投资逻辑");
    return { state: "REASSESS_THESIS", allowAdd: false, forceSell: false, reasons, immediate: true };
  }
  // 硬上限违规（组合层面的单股/主题约束）与桶超配同为 OVERWEIGHT 即时态：
  // 优先级 REASSESS_THESIS > OVERWEIGHT > LOW_CONFIDENCE（基本面熔断先判）。
  const bucketOverweight =
    input.currentWeightBps !== undefined &&
    input.positionLimitBps !== undefined &&
    input.currentWeightBps > input.positionLimitBps;
  if (input.hardLimitExceeded === true || bucketOverweight) {
    if (input.hardLimitExceeded === true) {
      reasons.push(
        input.hardLimitLabel
          ? `触发硬上限：${input.hardLimitLabel}；停止新增，不强制卖出`
          : "触发单股/主题硬上限：停止新增，不强制卖出",
      );
    }
    if (bucketOverweight) reasons.push("当前仓位严格超过适用上限：停止新增，不强制卖出");
    return { state: "OVERWEIGHT", allowAdd: false, forceSell: false, reasons, immediate: true };
  }
  if (input.opportunityScore === null || input.confidence === "LOW") {
    reasons.push("数据可信度不足，禁止输出增配状态");
    return { state: "LOW_CONFIDENCE", allowAdd: false, forceSell: false, reasons, immediate: true };
  }

  let state = getBaseState(input.opportunityScore, config);
  if (input.confidence === "MEDIUM") {
    if (state === "STRONG_ADD_ALLOWED") state = "LIGHT_ADD_ALLOWED";
    if (state === "REDUCE_CONSIDER") state = "DO_NOT_ADD";
    reasons.push("数据可信度为中等：不输出强增配或降低仓位状态");
  }
  // 体检数据不足（财报缺失或过期）：无法确认没有恶化，最多输出小幅增配。
  if (input.bucket !== "GOLD" && health === "UNKNOWN") {
    if (state === "STRONG_ADD_ALLOWED") state = "LIGHT_ADD_ALLOWED";
    reasons.push(...(input.healthReasons?.length ? input.healthReasons : ["基本面体检数据不足：最多输出小幅增配"]));
  }
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
  // v6：基本面子分（历史分位）只作展示参考；决策只看体检结果。
  const health = assessFundamentalHealth(input, config);
  const opportunity = combineComponents({
    cheapness: subscoreComponent("cheapness", subscores.cheapness, config.scoreWeights.cheapness, input.asOf),
    trend: subscoreComponent("trend", subscores.trend, config.scoreWeights.trend, input.asOf),
  });
  const confidence = risk.confidenceOverride
    ? worseConfidence(opportunity.confidence, risk.confidenceOverride)
    : opportunity.confidence;
  const rules = applyRiskRules({
    // 必须传入 bucket：否则黄金会因 undefined !== "GOLD" 误入通用基本面熔断
    bucket: input.bucket,
    opportunityScore: opportunity.score,
    fundamentalHealth: health.status,
    healthReasons: health.reasons,
    confidence,
    currentWeightBps: risk.currentWeightBps,
    positionLimitBps: risk.positionLimitBps,
    hardLimitExceeded: risk.hardLimitExceeded,
    hardLimitLabel: risk.hardLimitLabel,
    config,
  });

  /**
   * 支柱级完整性闸门：重权只允许发生在指标级。整根支柱（便宜程度/趋势）缺失时，
   * 机会分被静默重加权且置信度可能仍是 HIGH——此时禁止输出任何增配状态，
   * 按 LOW_CONFIDENCE 处理（体检不通过与超配两类更严重的即时态保持优先）。
   * v6 起基本面不再是机会分的支柱，缺失时由体检的 UNKNOWN 封顶处理。
   */
  const pillarMissing = subscores.cheapness.score === null || subscores.trend.score === null;
  const gated =
    pillarMissing && rules.state !== "REASSESS_THESIS" && rules.state !== "OVERWEIGHT"
      ? {
          state: "LOW_CONFIDENCE" as RecommendationState,
          allowAdd: false,
          forceSell: false as const,
          reasons: [...rules.reasons, "缺少整根评分支柱（便宜程度或趋势），禁止输出增配状态"],
          immediate: true,
        }
      : rules;

  const confirmation = risk.previousState
    ? confirmStateTransition({
        previousState: risk.previousState,
        candidateState: gated.state,
        candidateHistory: risk.candidateHistory ?? [],
        candidateHistoryDates: risk.candidateHistoryDates,
        tradingDates: risk.tradingDates,
        asOf: input.asOf,
        immediate: gated.immediate,
        confirmationTradingDays: config.signalRules.confirmationTradingDays,
      })
    : { state: gated.state, confirmed: true };
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
  const hardLimitExceeded = risk.hardLimitExceeded === true;
  // 风险严重度：硬上限违规 = CRITICAL；重新评估/超配 = WARNING；低可信度 = WATCH；其余 INFO。
  const riskSeverity: RiskSeverity = hardLimitExceeded
    ? "CRITICAL"
    : confirmation.state === "REASSESS_THESIS" || confirmation.state === "OVERWEIGHT"
      ? "WARNING"
      : confirmation.state === "LOW_CONFIDENCE"
        ? "WATCH"
        : "INFO";
  return {
    bucket: input.bucket,
    asOf: input.asOf,
    cheapnessScore: subscores.cheapness.score,
    fundamentalScore: subscores.fundamental.score,
    fundamentalHealth: health,
    trendScore: subscores.trend.score,
    opportunityScore: opportunity.score,
    confidence: pillarMissing ? worseConfidence(confidence, "MEDIUM") : confidence,
    candidateState: gated.state,
    state: confirmation.state,
    stateConfirmed: confirmation.confirmed,
    signalSuppressed,
    allowAdd: gated.allowAdd && confirmation.confirmed && !signalSuppressed,
    forceSell: false,
    riskSeverity,
    hardLimitExceeded,
    hardLimitLabel: hardLimitExceeded ? (risk.hardLimitLabel ?? null) : null,
    components,
    missingMetrics: [
      ...subscores.cheapness.missingMetrics.map((key) => `cheapness.${key}`),
      ...subscores.fundamental.missingMetrics.map((key) => `fundamental.${key}`),
      ...subscores.trend.missingMetrics.map((key) => `trend.${key}`),
    ],
    reasons: [
      ...gated.reasons,
      ...(!confirmation.confirmed ? ["候选状态尚未连续三个交易日确认"] : []),
      ...(signalSuppressed ? ["七天冷却期内，同方向建议已抑制"] : []),
    ],
  };
}
