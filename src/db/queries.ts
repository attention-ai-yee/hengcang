import { and, asc, desc, eq } from "drizzle-orm";
import { getDatabase } from "./client";
import {
  allocationTargets,
  backtestResults,
  backtestRuns,
  dataSourceStatus,
  decisionLogs,
  holdings,
  portfolios,
  riskLimits,
  scoreSnapshots,
  signals,
} from "./schema";

export const DEFAULT_PORTFOLIO_ID = "default";

export async function getPortfolioRecord() {
  const db = getDatabase();
  return db.query.portfolios.findFirst({ where: eq(portfolios.id, DEFAULT_PORTFOLIO_ID) });
}

export async function listHoldings() {
  const db = getDatabase();
  return db.select().from(holdings).where(eq(holdings.portfolioId, DEFAULT_PORTFOLIO_ID)).orderBy(asc(holdings.name));
}

export async function listAllocationTargets() {
  const db = getDatabase();
  return db
    .select()
    .from(allocationTargets)
    .where(eq(allocationTargets.portfolioId, DEFAULT_PORTFOLIO_ID))
    .orderBy(asc(allocationTargets.assetBucket));
}

export async function listLatestScores() {
  const db = getDatabase();
  return db
    .select()
    .from(scoreSnapshots)
    .where(eq(scoreSnapshots.portfolioId, DEFAULT_PORTFOLIO_ID))
    .orderBy(desc(scoreSnapshots.asOf));
}

/** 某资产桶的最新一条评分快照（决策日志写入时快照当时系统状态）。 */
export async function getLatestScoreForBucket(assetBucket: string) {
  return getDatabase()
    .select()
    .from(scoreSnapshots)
    .where(and(eq(scoreSnapshots.portfolioId, DEFAULT_PORTFOLIO_ID), eq(scoreSnapshots.assetBucket, assetBucket)))
    .orderBy(desc(scoreSnapshots.asOf))
    .limit(1)
    .get();
}

export async function listLatestSignals(limit = 10) {
  const db = getDatabase();
  return db
    .select()
    .from(signals)
    .where(eq(signals.portfolioId, DEFAULT_PORTFOLIO_ID))
    .orderBy(desc(signals.createdAt))
    .limit(limit);
}

export async function listProviderStatuses() {
  return getDatabase().select().from(dataSourceStatus).orderBy(asc(dataSourceStatus.provider));
}

export async function getRiskLimits() {
  return getDatabase().query.riskLimits.findFirst({ where: eq(riskLimits.portfolioId, DEFAULT_PORTFOLIO_ID) });
}

export async function listDecisions() {
  return getDatabase()
    .select()
    .from(decisionLogs)
    .where(eq(decisionLogs.portfolioId, DEFAULT_PORTFOLIO_ID))
    .orderBy(desc(decisionLogs.decidedAt));
}

export async function listBacktestRunsWithResults() {
  const db = getDatabase();
  const runs = await listBacktestRuns();
  const results = db.select().from(backtestResults).all();
  const byRun = new Map(results.map((result) => [result.backtestRunId, result]));
  return runs.map((run) => ({ ...run, result: byRun.get(run.id) ?? null }));
}
export async function listBacktestRuns() {
  return getDatabase()
    .select()
    .from(backtestRuns)
    .where(eq(backtestRuns.portfolioId, DEFAULT_PORTFOLIO_ID))
    .orderBy(desc(backtestRuns.createdAt));
}
