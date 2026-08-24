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

export interface CandidateChain {
  /** 最近一条先于 asOf 的快照的已确认状态；没有任何先前快照时为 undefined */
  previousState?: RecommendationState;
  states: RecommendationState[];
  dates: string[];
}

/**
 * 读取用于 3 日确认的候选链：只接受 componentsJson 里显式写有 candidateState
 * 的快照（自动刷新路径），手工代理评分等未参与候选链的快照不混入，
 * 避免把"已确认状态"当"候选状态"计数。limit 从配置推导而非硬编码。
 */
export async function loadCandidateChain(
  bucket: ScorableAssetBucket,
  asOf: string,
): Promise<CandidateChain> {
  const db = getDatabase();
  const window = Math.max(1, DEFAULT_SCORING_CONFIG.signalRules.confirmationTradingDays - 1);
  const prior = db
    .select()
    .from(scoreSnapshots)
    .where(
      and(
        eq(scoreSnapshots.portfolioId, DEFAULT_PORTFOLIO_ID),
        eq(scoreSnapshots.assetBucket, bucket),
        lt(scoreSnapshots.asOf, asOf),
      ),
    )
    .orderBy(desc(scoreSnapshots.asOf))
    .limit(window)
    .all();
  const chain: CandidateChain = { states: [], dates: [] };
  for (const snapshot of prior) {
    let candidateState: unknown;
    try {
      candidateState = (JSON.parse(snapshot.componentsJson) as { candidateState?: unknown }).candidateState;
    } catch {
      candidateState = undefined;
    }
    if (typeof candidateState !== "string") continue;
    chain.states.unshift(candidateState as RecommendationState);
    chain.dates.unshift(snapshot.asOf);
  }
  const latestPrior = prior[0];
  if (latestPrior) chain.previousState = latestPrior.recommendationState as RecommendationState;
  return chain;
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

  // 历史回填的点内时间纪律：OVERWEIGHT 闸门只反映「当时」的仓位。批量请求里
  // 只有各桶自己的最新评估日使用当前持仓权重；更早的日期不注入今天的仓位，
  // 否则某桶现在超限时会把该桶全部历史快照盖成 OVERWEIGHT（规格 §14 使用当时可获得的数据）。
  const latestAsOfByBucket = new Map<string, string>();
  for (const request of requests) {
    const latest = latestAsOfByBucket.get(request.bucket);
    if (!latest || request.asOf > latest) latestAsOfByBucket.set(request.bucket, request.asOf);
  }

  const portfolio = await getPortfolioView();
  const targets = new Map(portfolio.targets.map((target) => [target.assetBucket, target]));
  const builder = new ScoreInputBuilder(new SqliteMetricSeriesRepository({
    primaryProviderByMetric: {
      REAL_YIELD_10Y: "fred",
      DOLLAR_INDEX: "fred",
      PS: "tushare-index-aggregate",
      DIVIDEND_YIELD: "tushare-index-aggregate",
      ROE: "tushare-index-aggregate",
      EARNINGS_GROWTH: "tushare-index-aggregate",
      REVENUE_GROWTH: "tushare-index-aggregate",
      INDEX_EARNINGS_GROWTH: "tushare-index-aggregate",
      DIVIDEND_STABILITY_SCORE: "tushare-index-aggregate",
      GOLD_ETF_FLOW_3M: "tushare-gold-etf-proxy",
    },
    fallbackProviders: ["tushare", "tushare-index-aggregate", "tushare-derived-forward-pe", "tushare-derived", "fred", "twelve-data", "manual"],
  }));
  const results: Array<{ bucket: ScorableAssetBucket; asOf: string; saved: boolean; result: ScoreResult }> = [];

  for (const request of requests) {
    const chain = await loadCandidateChain(request.bucket, request.asOf);
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
      currentWeightBps: latestAsOfByBucket.get(request.bucket) === request.asOf
        ? portfolio.summary.byBucket[request.bucket].weightBps
        : undefined,
      positionLimitBps: target?.maxBps,
      previousState: chain.previousState,
      candidateHistory: chain.states,
      candidateHistoryDates: chain.dates,
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
