import { getDatabase } from "@/db/client";
import { DEFAULT_PORTFOLIO_ID } from "@/db/queries";
import { scoreSnapshots } from "@/db/schema";
import { applyRiskRules, calculateOpportunityScore, DEFAULT_SCORING_CONFIG } from "@/domain/scoring";
import { confirmStateTransition } from "@/domain/scoring/state";
import type { AssetBucket, ScorableAssetBucket } from "@/domain/types";
import { getPortfolioView } from "@/server/portfolio-service";
import type { z } from "zod";
import type { manualScorePayloadSchema } from "@/lib/validation";
import { loadCandidateChain } from "./scoring-refresh-service";

export type ManualScorePayload = z.infer<typeof manualScorePayloadSchema>;

/**
 * 手工代理评分（低可信度兜底）。与自动刷新共用同一条 3 日确认候选链：
 * 快照里显式写入 candidateState，后续自动刷新的 loadCandidateChain
 * 能正确识别它，而不会把"已确认状态"误当"候选状态"计数。
 */
export async function saveManualScore(payload: ManualScorePayload) {
  const view = await getPortfolioView();
  const target = view.targets.find((item) => item.assetBucket === payload.assetBucket);
  const actualBps = view.summary.byBucket[payload.assetBucket as AssetBucket].weightBps;
  const isOverweight = target ? actualBps > target.maxBps : false;
  const confidence = "LOW" as const;
  const opportunityScore = calculateOpportunityScore(payload.cheapnessScore, payload.trendScore);
  const healthReasons = payload.fundamentalHealth === "DETERIORATING"
    ? ["基本面体检：手工判断为恶化"]
    : payload.fundamentalHealth === "UNKNOWN"
      ? ["基本面体检：手工判断为数据不足，最多输出小幅增配"]
      : [];
  const rules = applyRiskRules({
    bucket: payload.assetBucket as ScorableAssetBucket,
    opportunityScore,
    fundamentalHealth: payload.assetBucket === "GOLD" ? "NOT_APPLICABLE" : payload.fundamentalHealth,
    healthReasons,
    confidence,
    currentWeightBps: actualBps,
    positionLimitBps: target?.maxBps,
  });

  const chain = await loadCandidateChain(payload.assetBucket, payload.asOf);
  const confirmation = chain.previousState
    ? confirmStateTransition({
        previousState: chain.previousState,
        candidateState: rules.state,
        candidateHistory: chain.states,
        candidateHistoryDates: chain.dates,
        immediate: rules.immediate,
        confirmationTradingDays: DEFAULT_SCORING_CONFIG.signalRules.confirmationTradingDays,
      })
    : { state: rules.state, confirmed: true };

  const now = new Date().toISOString();
  const record = {
    id: crypto.randomUUID(),
    portfolioId: DEFAULT_PORTFOLIO_ID,
    assetBucket: payload.assetBucket,
    asOf: payload.asOf,
    valuationScore: null,
    cheapnessScore: payload.cheapnessScore,
    fundamentalScore: null,
    trendScore: payload.trendScore,
    opportunityScore,
    riskPenalty: 0,
    confidence,
    recommendationState: confirmation.state,
    allowAdd: rules.allowAdd && confirmation.confirmed,
    forceSell: false,
    riskSeverity: isOverweight ? "WARNING" : "INFO",
    componentsJson: JSON.stringify({
      source: "MANUAL_AGGREGATE_PROXY",
      modelVersion: 1,
      note: "用户手工录入的已归一化代理分，未使用原始指标历史序列",
      candidateState: rules.state,
      stateConfirmed: confirmation.confirmed,
      fundamentalHealth: {
        status: payload.assetBucket === "GOLD" ? "NOT_APPLICABLE" : payload.fundamentalHealth,
        checks: [],
        reasons: healthReasons,
      },
      components: {
        cheapness: { rawValue: payload.cheapnessScore, percentile: null, score: payload.cheapnessScore, weight: DEFAULT_SCORING_CONFIG.scoreWeights.cheapness, source: "MANUAL", asOf: payload.asOf },
        trend: { rawValue: payload.trendScore, percentile: null, score: payload.trendScore, weight: DEFAULT_SCORING_CONFIG.scoreWeights.trend, source: "MANUAL", asOf: payload.asOf },
      },
      reasons: [
        ...rules.reasons,
        ...(confirmation.confirmed ? [] : ["候选状态尚未连续三个交易日确认"]),
      ],
    }),
    createdAt: now,
  };

  getDatabase()
    .insert(scoreSnapshots)
    .values(record)
    .onConflictDoUpdate({
      target: [scoreSnapshots.portfolioId, scoreSnapshots.assetBucket, scoreSnapshots.asOf],
      set: {
        valuationScore: record.valuationScore,
        cheapnessScore: record.cheapnessScore,
        fundamentalScore: record.fundamentalScore,
        trendScore: record.trendScore,
        opportunityScore: record.opportunityScore,
        riskPenalty: record.riskPenalty,
        confidence: record.confidence,
        recommendationState: record.recommendationState,
        allowAdd: record.allowAdd,
        forceSell: record.forceSell,
        riskSeverity: record.riskSeverity,
        componentsJson: record.componentsJson,
        createdAt: record.createdAt,
      },
    })
    .run();

  return record;
}
