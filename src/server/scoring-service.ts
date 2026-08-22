import { getDatabase } from "@/db/client";
import { DEFAULT_PORTFOLIO_ID } from "@/db/queries";
import { scoreSnapshots } from "@/db/schema";
import { applyRiskRules, calculateOpportunityScore } from "@/domain/scoring";
import type { AssetBucket } from "@/domain/types";
import { getPortfolioView } from "@/server/portfolio-service";
import type { z } from "zod";
import type { manualScorePayloadSchema } from "@/lib/validation";

export type ManualScorePayload = z.infer<typeof manualScorePayloadSchema>;

export async function saveManualScore(payload: ManualScorePayload) {
  const view = await getPortfolioView();
  const target = view.targets.find((item) => item.assetBucket === payload.assetBucket);
  const actualBps = view.summary.byBucket[payload.assetBucket as AssetBucket].weightBps;
  const isOverweight = target ? actualBps > target.maxBps : false;
  const confidence = "LOW" as const;
  const opportunityScore = calculateOpportunityScore(
    payload.cheapnessScore,
    payload.fundamentalScore,
    payload.trendScore,
  );
  const rules = applyRiskRules({
    opportunityScore,
    fundamentalScore: payload.fundamentalScore,
    confidence,
    currentWeightBps: actualBps,
    positionLimitBps: target?.maxBps,
  });
  const now = new Date().toISOString();
  const record = {
    id: crypto.randomUUID(),
    portfolioId: DEFAULT_PORTFOLIO_ID,
    assetBucket: payload.assetBucket,
    asOf: payload.asOf,
    valuationScore: null,
    cheapnessScore: payload.cheapnessScore,
    fundamentalScore: payload.fundamentalScore,
    trendScore: payload.trendScore,
    opportunityScore,
    riskPenalty: 0,
    confidence,
    recommendationState: rules.state,
    allowAdd: rules.allowAdd,
    forceSell: false,
    riskSeverity: isOverweight ? "WARNING" : "INFO",
    componentsJson: JSON.stringify({
      source: "MANUAL_AGGREGATE_PROXY",
      modelVersion: 1,
      note: "用户手工录入的已归一化代理分，未使用原始指标历史序列",
      components: {
        cheapness: { rawValue: payload.cheapnessScore, percentile: null, score: payload.cheapnessScore, weight: 0.5, source: "MANUAL", asOf: payload.asOf },
        fundamental: { rawValue: payload.fundamentalScore, percentile: null, score: payload.fundamentalScore, weight: 0.3, source: "MANUAL", asOf: payload.asOf },
        trend: { rawValue: payload.trendScore, percentile: null, score: payload.trendScore, weight: 0.2, source: "MANUAL", asOf: payload.asOf },
      },
      reasons: rules.reasons,
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
