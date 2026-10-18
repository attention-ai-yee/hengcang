import { randomUUID } from "node:crypto";
import { getDatabase } from "@/db/client";
import { DEFAULT_PORTFOLIO_ID, getLatestScoreForBucket, listDecisions } from "@/db/queries";
import { decisionLogs } from "@/db/schema";
import { DEFAULT_SCORING_CONFIG } from "@/domain/scoring";
import { apiError, apiSuccess, parseJsonBody, zodFields } from "@/lib/api";
import { decisionDirectionForAction, decisionPayloadSchema } from "@/lib/validation";
import { ensureDefaultPortfolioRecord, getPortfolioView } from "@/server/portfolio-service";

export const dynamic = "force-dynamic";

/** 上海时区的当前时刻，写成带偏移的 ISO 8601（decision_logs.decided_at 点内时间口径）。 */
function shanghaiNowIso(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "00";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}+08:00`;
}

export async function GET() {
  return apiSuccess(await listDecisions());
}

/**
 * 记录决策日志：
 * - 同时快照当时最新 ScoreSnapshot（分数/状态/配置版本）与组合分布；
 * - systemState 取该资产桶最新评分状态；
 * - direction 由 action 推导（ADD→ADD、REDUCE→REDUCE、其他→NONE），供 7 天冷却抑制消费。
 */
export async function POST(request: Request) {
  const parsedBody = await parseJsonBody(request);
  if (!parsedBody.ok) return parsedBody.response;
  const parsed = decisionPayloadSchema.safeParse(parsedBody.body);
  if (!parsed.success) return apiError("VALIDATION_ERROR", "决策记录无效", 422, zodFields(parsed.error));
  const payload = parsed.data;

  const capturedAt = new Date().toISOString();
  ensureDefaultPortfolioRecord(capturedAt);
  const [view, latestScore] = await Promise.all([
    getPortfolioView(),
    getLatestScoreForBucket(payload.assetBucket),
  ]);

  const allocationSnapshot = {
    capturedAt,
    totalValueMinor: view.summary.totalValueMinor,
    investableAssetsMinor: view.summary.investableAssetsMinor,
    reservedCashMinor: view.summary.reservedCashMinor,
    byBucket: Object.fromEntries(
      Object.entries(view.summary.byBucket).map(([assetBucket, item]) => [
        assetBucket,
        { weightBps: item.weightBps, investableValueMinor: item.investableValueMinor },
      ]),
    ),
  };
  const scoreSnapshot = latestScore
    ? {
        asOf: latestScore.asOf,
        assetBucket: latestScore.assetBucket,
        recommendationState: latestScore.recommendationState,
        allowAdd: latestScore.allowAdd,
        forceSell: latestScore.forceSell,
        riskSeverity: latestScore.riskSeverity,
        confidence: latestScore.confidence,
        opportunityScore: latestScore.opportunityScore,
        cheapnessScore: latestScore.cheapnessScore,
        fundamentalScore: latestScore.fundamentalScore,
        trendScore: latestScore.trendScore,
        scoringConfigVersion: DEFAULT_SCORING_CONFIG.version,
      }
    : null;

  const record = {
    id: randomUUID(),
    portfolioId: DEFAULT_PORTFOLIO_ID,
    holdingId: null,
    assetBucket: payload.assetBucket,
    decidedAt: payload.decidedAt ?? shanghaiNowIso(),
    action: payload.action,
    direction: decisionDirectionForAction(payload.action),
    rationale: payload.rationale,
    scoreSnapshotJson: JSON.stringify(scoreSnapshot),
    allocationSnapshotJson: JSON.stringify(allocationSnapshot),
    systemState: latestScore?.recommendationState ?? "UNKNOWN",
    createdAt: capturedAt,
  };
  getDatabase().insert(decisionLogs).values(record).run();
  return apiSuccess(record, { created: true });
}
