import { and, desc, eq, lt, lte } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import { DEFAULT_PORTFOLIO_ID } from "@/db/queries";
import { configSnapshots, decisionLogs, metricObservations, scoreSnapshots, signals } from "@/db/schema";
import {
  calculateAssetScore,
  DEFAULT_SCORING_CONFIG,
  ScoreInputBuilder,
  type ScoreResult,
} from "@/domain/scoring";
import type { RecommendationState, RiskSeverity, ScorableAssetBucket } from "@/domain/types";
import { BUCKET_LABELS, STATE_LABELS } from "@/lib/presentation";
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

function bucketLabel(bucket: ScorableAssetBucket): string {
  return BUCKET_LABELS[bucket];
}

/**
 * 已知交易日历（升序、去重）：以 ASSET_BUCKET 的 PRICE_CLOSE 观察日为口径。
 * 「连续 N 个交易日确认」用它识别断档/周末/月度回填——只看快照日期互异会把
 * 这些情况误判成连续交易日。只取最近 60 个交易日（确认只需要最近 required 天）。
 * 日历为空（全新库/测试库）时返回 []，confirmStateTransition 回退到日期互异口径。
 * 每次 refreshScoresForBuckets 调用只查一次，供该轮全部桶共用。
 */
export function loadKnownTradingDates(limit = 60): string[] {
  const rows = getDatabase()
    .selectDistinct({ asOf: metricObservations.asOf })
    .from(metricObservations)
    .where(and(
      eq(metricObservations.subjectType, "ASSET_BUCKET"),
      eq(metricObservations.metricKey, "PRICE_CLOSE"),
    ))
    .orderBy(desc(metricObservations.asOf))
    .limit(limit)
    .all();
  const ascending = rows.map((row) => row.asOf.slice(0, 10)).reverse();
  return [...new Set(ascending)];
}

export interface RefreshScoresOptions {
  /**
   * 历史全量回填：月度采样快照无法满足「连续 N 个交易日」的逐日确认，
   * 置 true 时不传 previousState/candidateHistory/tradingDates，
   * 每个历史快照直接按候选态确认入库。正常增量刷新不使用该开关，仍走严格确认。
   */
  skipConfirmation?: boolean;
}

export interface RecommendationSignalPlan {
  fingerprint: string;
  severity: RiskSeverity;
  signalType: "STATE_CHANGE" | "HARD_LIMIT";
  oldState: RecommendationState | null;
  newState: RecommendationState;
  summary: string;
}

/**
 * 信号生成规则（纯函数，便于单测）：
 * - 与同桶上一条快照的 recommendation_state 不同 → 状态变化信号；
 * - 硬上限违规（riskSeverity = CRITICAL）即使状态未变也生成信号；
 * - 其余情况不生成，避免每个评估日都刷同状态噪音。
 * fingerprint 由「桶|旧状态|新状态|评估日」构成，重复计算同一天只保留一条。
 */
export function planRecommendationSignal(input: {
  assetBucket: ScorableAssetBucket;
  asOf: string;
  oldState?: RecommendationState | null;
  newState: RecommendationState;
  riskSeverity: RiskSeverity;
  hardLimitExceeded?: boolean;
  hardLimitLabel?: string | null;
}): RecommendationSignalPlan | null {
  const oldState = input.oldState ?? null;
  const stateChanged = oldState !== null && oldState !== input.newState;
  const critical = input.riskSeverity === "CRITICAL" || input.hardLimitExceeded === true;
  if (!stateChanged && !critical) return null;
  const stateText = oldState
    ? `${STATE_LABELS[oldState]} → ${STATE_LABELS[input.newState]}`
    : `当前状态 ${STATE_LABELS[input.newState]}`;
  const summary = critical
    ? `硬上限违规：${input.hardLimitLabel ?? "持仓超过单股或主题上限"}；${stateText}`
    : `${bucketLabel(input.assetBucket)}：${stateText}`;
  return {
    fingerprint: `${input.assetBucket}|${oldState ?? "NONE"}|${input.newState}|${input.asOf}`,
    severity: critical ? "CRITICAL" : input.riskSeverity,
    signalType: critical ? "HARD_LIMIT" : "STATE_CHANGE",
    oldState,
    newState: input.newState,
    summary,
  };
}

export async function refreshScoresForBuckets(
  requests: Array<{ bucket: ScorableAssetBucket; asOf: string }>,
  options: RefreshScoresOptions = {},
) {
  if (requests.length === 0) return [];
  const db = getDatabase();
  // 确认口径的交易日历：整轮刷新只查一次，所有桶/日期共用（升序、去重）。
  const tradingDates = loadKnownTradingDates();
  const strictConfirmation = options.skipConfirmation !== true;
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
    // 与仓位权重同一套点内时间纪律：硬上限反映的是当前持仓快照，只注入各桶最新评估日，
    // 避免历史回填把全部旧快照误标成 OVERWEIGHT/CRITICAL。
    const isLatestAsOf = latestAsOfByBucket.get(request.bucket) === request.asOf;
    const bucketRisk = isLatestAsOf ? portfolio.bucketRisks[request.bucket] : undefined;
    const input = await builder.build(request.bucket, request.asOf);
    const target = targets.get(request.bucket);
    const result = calculateAssetScore(input, {
      currentWeightBps: isLatestAsOf
        ? portfolio.summary.byBucket[request.bucket].weightBps
        : undefined,
      positionLimitBps: target?.maxBps,
      hardLimitExceeded: bucketRisk?.hardLimitExceeded === true ? true : undefined,
      hardLimitLabel: bucketRisk?.label ?? undefined,
      previousState: strictConfirmation ? chain.previousState : undefined,
      candidateHistory: strictConfirmation ? chain.states : undefined,
      candidateHistoryDates: strictConfirmation ? chain.dates : undefined,
      tradingDates: strictConfirmation && tradingDates.length > 0 ? tradingDates : undefined,
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
        riskSeverity: result.riskSeverity,
        componentsJson: JSON.stringify({
          modelVersion: DEFAULT_SCORING_CONFIG.version,
          candidateState: result.candidateState,
          stateConfirmed: result.stateConfirmed,
          signalSuppressed: result.signalSuppressed,
          hardLimitExceeded: result.hardLimitExceeded,
          hardLimitLabel: result.hardLimitLabel,
          fundamentalHealth: result.fundamentalHealth,
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

      // 信号只由各桶最新评估日生成：全量回填的历史快照只入库、不刷提醒。
      const signalPlan = isLatestAsOf
        ? planRecommendationSignal({
            assetBucket: result.bucket,
            asOf: result.asOf,
            oldState: chain.previousState,
            newState: result.state,
            riskSeverity: result.riskSeverity,
            hardLimitExceeded: result.hardLimitExceeded,
            hardLimitLabel: result.hardLimitLabel,
          })
        : null;
      if (signalPlan) {
        const duplicate = db
          .select({ id: signals.id })
          .from(signals)
          .where(and(
            eq(signals.portfolioId, DEFAULT_PORTFOLIO_ID),
            eq(signals.fingerprint, signalPlan.fingerprint),
          ))
          .get();
        if (!duplicate) {
          db.insert(signals).values({
            id: crypto.randomUUID(),
            portfolioId: DEFAULT_PORTFOLIO_ID,
            assetBucket: result.bucket,
            fingerprint: signalPlan.fingerprint,
            severity: signalPlan.severity,
            signalType: signalPlan.signalType,
            oldState: signalPlan.oldState,
            newState: signalPlan.newState,
            summary: signalPlan.summary,
            isDuplicate: false,
            createdAt: now,
          }).run();
        }
      }
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
