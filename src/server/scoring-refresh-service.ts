import { and, desc, eq, lt, lte } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import { DEFAULT_PORTFOLIO_ID } from "@/db/queries";
import { configSnapshots, decisionLogs, scoreSnapshots } from "@/db/schema";
import {
  calculateAssetScore,
  DEFAULT_SCORING_CONFIG,
  ScoreInputBuilder,
  type ScoreResult,
} from "@/domain/scoring";
import type { RecommendationState, ScorableAssetBucket } from "@/domain/types";
import type { ManualObservationInput } from "@/metrics/manual-import";
import { SqliteMetricSeriesRepository } from "@/metrics/observation-repository";
import { getPortfolioView } from "./portfolio-service";

function previousCandidate(componentsJson: string, fallback: string): RecommendationState {
  try {
    const parsed = JSON.parse(componentsJson) as { candidateState?: unknown };
    return typeof parsed.candidateState === "string" ? parsed.candidateState as RecommendationState : fallback as RecommendationState;
  } catch {
    return fallback as RecommendationState;
  }
}

function riskSeverity(result: ScoreResult) {
  if (result.state === "REASSESS_THESIS" || result.state === "OVERWEIGHT") return "WARNING";
  if (result.state === "LOW_CONFIDENCE") return "WATCH";
  return "INFO";
}

export async function refreshScoresForBuckets(
  requests: Array<{ bucket: ScorableAssetBucket; asOf: string }>,
) {
  if (requests.length === 0) return [];
  const db = getDatabase();
  const now = new Date().toISOString();
  const configSnapshotId = crypto.randomUUID();
  db.insert(configSnapshots).values({
    id: configSnapshotId,
    portfolioId: DEFAULT_PORTFOLIO_ID,
    version: DEFAULT_SCORING_CONFIG.version,
    configJson: JSON.stringify(DEFAULT_SCORING_CONFIG),
    createdAt: now,
  }).run();

  const portfolio = await getPortfolioView();
  const targets = new Map(portfolio.targets.map((target) => [target.assetBucket, target]));
  const builder = new ScoreInputBuilder(new SqliteMetricSeriesRepository({
    fallbackProviders: ["tushare", "tushare-derived", "fred", "twelve-data", "manual"],
  }));
  const results: Array<{ bucket: ScorableAssetBucket; asOf: string; saved: boolean; result: ScoreResult }> = [];

  for (const request of requests) {
    const prior = db
      .select()
      .from(scoreSnapshots)
      .where(and(
        eq(scoreSnapshots.portfolioId, DEFAULT_PORTFOLIO_ID),
        eq(scoreSnapshots.assetBucket, request.bucket),
        lt(scoreSnapshots.asOf, request.asOf),
      ))
      .orderBy(desc(scoreSnapshots.asOf))
      .limit(2)
      .all();
    const latestDecision = db
      .select()
      .from(decisionLogs)
      .where(and(
        eq(decisionLogs.portfolioId, DEFAULT_PORTFOLIO_ID),
        eq(decisionLogs.assetBucket, request.bucket),
        lte(decisionLogs.decidedAt, `${request.asOf}T23:59:59Z`),
      ))
      .orderBy(desc(decisionLogs.decidedAt))
      .limit(1)
      .get();
    const input = await builder.build(request.bucket, request.asOf);
    const target = targets.get(request.bucket);
    const result = calculateAssetScore(input, {
      currentWeightBps: portfolio.summary.byBucket[request.bucket].weightBps,
      positionLimitBps: target?.maxBps,
      previousState: prior[0]?.recommendationState as RecommendationState | undefined,
      candidateHistory: prior
        .map((snapshot) => previousCandidate(snapshot.componentsJson, snapshot.recommendationState))
        .reverse(),
      lastDecisionDirection: latestDecision?.direction === "ADD" || latestDecision?.direction === "REDUCE"
        ? latestDecision.direction
        : undefined,
      lastDecisionAt: latestDecision?.decidedAt,
    });
    const hasObservation = Object.values(result.components).some((component) => component.rawValue !== null);
    if (hasObservation) {
      const record = {
        id: crypto.randomUUID(),
        portfolioId: DEFAULT_PORTFOLIO_ID,
        assetBucket: result.bucket,
        asOf: result.asOf,
        valuationScore: null,
        cheapnessScore: result.cheapnessScore,
        fundamentalScore: result.fundamentalScore,
        trendScore: result.trendScore,
        opportunityScore: result.opportunityScore,
        riskPenalty: 0,
        confidence: result.confidence,
        recommendationState: result.state,
        allowAdd: result.allowAdd,
        forceSell: result.forceSell,
        riskSeverity: riskSeverity(result),
        componentsJson: JSON.stringify({
          modelVersion: DEFAULT_SCORING_CONFIG.version,
          candidateState: result.candidateState,
          stateConfirmed: result.stateConfirmed,
          signalSuppressed: result.signalSuppressed,
          components: result.components,
          missingMetrics: result.missingMetrics,
          reasons: result.reasons,
        }),
        configSnapshotId,
        createdAt: now,
      };
      db.insert(scoreSnapshots)
        .values(record)
        .onConflictDoUpdate({
          target: [scoreSnapshots.portfolioId, scoreSnapshots.assetBucket, scoreSnapshots.asOf],
          set: {
            cheapnessScore: record.cheapnessScore,
            fundamentalScore: record.fundamentalScore,
            trendScore: record.trendScore,
            opportunityScore: record.opportunityScore,
            confidence: record.confidence,
            recommendationState: record.recommendationState,
            allowAdd: record.allowAdd,
            forceSell: record.forceSell,
            riskSeverity: record.riskSeverity,
            componentsJson: record.componentsJson,
            configSnapshotId,
            createdAt: now,
          },
        })
        .run();
    }
    results.push({ bucket: request.bucket, asOf: request.asOf, saved: hasObservation, result });
  }
  return results;
}

export async function refreshScoresForImportedRows(rows: ManualObservationInput[]) {
  const latestByBucket = new Map<ScorableAssetBucket, string>();
  for (const row of rows) {
    const current = latestByBucket.get(row.subjectId);
    if (!current || row.asOf > current) latestByBucket.set(row.subjectId, row.asOf);
  }
  return refreshScoresForBuckets(
    Array.from(latestByBucket, ([bucket, asOf]) => ({ bucket, asOf })),
  );
}
