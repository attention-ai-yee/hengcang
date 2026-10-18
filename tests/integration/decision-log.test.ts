import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { and, eq } from "drizzle-orm";
import { closeDatabase, getDatabase } from "@/db/client";
import { decisionLogs, holdings, metricObservations, portfolios, scoreSnapshots, signals } from "@/db/schema";
import type { CanonicalMetricKey } from "@/metrics/catalog";
import { refreshScoresForBuckets } from "@/server/scoring-refresh-service";
import { GET, POST } from "../../app/api/decisions/route";

/**
 * 决策日志纵切：POST/GET 路由、分数与组合分布快照、冷却抑制、状态变化信号与硬上限信号。
 * 参考 tests/integration/manual-observation-flow.test.ts 的临时 SQLite 库模式。
 */
const testDatabase = path.join(os.tmpdir(), `hengcang-decision-log-${randomUUID()}.db`);
const previousDatabaseUrl = process.env.DATABASE_URL;
const FIXED_NOW = "2026-08-18T00:00:00Z";

beforeAll(() => {
  process.env.DATABASE_URL = testDatabase;
  const db = getDatabase();
  migrate(db, { migrationsFolder: path.resolve("drizzle") });
  db.insert(portfolios).values({
    id: "default",
    name: "测试组合",
    baseCurrency: "CNY",
    reservedCashMinor: "0",
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  }).run();
});

afterAll(() => {
  closeDatabase();
  process.env.DATABASE_URL = previousDatabaseUrl;
  for (const suffix of ["", "-wal", "-shm"]) {
    const filename = `${testDatabase}${suffix}`;
    if (fs.existsSync(filename)) fs.rmSync(filename);
  }
});

function decisionRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/decisions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function postDecision(body: unknown) {
  const response = await POST(decisionRequest(body));
  const json = (await response.json()) as Record<string, unknown> & {
    data?: Record<string, unknown>;
    error?: { code: string; fields?: Record<string, string[]> };
  };
  return { status: response.status, json };
}

function insertScoreSnapshot(input: { assetBucket: string; asOf: string; state: string; allowAdd: boolean }) {
  getDatabase().insert(scoreSnapshots).values({
    id: randomUUID(),
    portfolioId: "default",
    assetBucket: input.assetBucket,
    asOf: input.asOf,
    valuationScore: null,
    cheapnessScore: 60,
    fundamentalScore: 60,
    trendScore: 60,
    opportunityScore: 60,
    riskPenalty: 0,
    confidence: "HIGH",
    recommendationState: input.state,
    allowAdd: input.allowAdd,
    forceSell: false,
    riskSeverity: "INFO",
    componentsJson: JSON.stringify({}),
    createdAt: FIXED_NOW,
  }).run();
}

function insertMetric(input: {
  subjectId: string;
  metricKey: CanonicalMetricKey;
  value: string;
  unit: string;
  asOf: string;
}) {
  getDatabase().insert(metricObservations).values({
    id: randomUUID(),
    subjectType: "ASSET_BUCKET",
    subjectId: input.subjectId,
    metricKey: input.metricKey,
    value: input.value,
    unit: input.unit,
    provider: "tushare",
    observedAt: `${input.asOf}T00:00:00Z`,
    availableAt: `${input.asOf}T00:00:00Z`,
    asOf: input.asOf,
    fetchedAt: `${input.asOf}T00:00:00Z`,
    quality: "VALID",
    isManualOverride: false,
  }).run();
}

/**
 * 宽基权益的 4 年日频干净数据：PE/PB 单边下行（当前最便宜）、
 * 指数盈利单边上行（当前最强）、价格单边上行（趋势支柱完整）。
 * 用来让评分在无决策时达到可增配状态，从而验证冷却抑制确实生效。
 */
function seedBroadEquityObservations() {
  const db = getDatabase();
  const rows: Array<typeof metricObservations.$inferInsert> = [];
  const start = Date.UTC(2022, 7, 1);
  const end = Date.UTC(2026, 7, 15);
  let tradingIndex = 0;
  for (let timestamp = start; timestamp <= end; timestamp += 24 * 60 * 60 * 1000) {
    const day = new Date(timestamp);
    const weekday = day.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const asOf = day.toISOString().slice(0, 10);
    const values: Array<[CanonicalMetricKey, number, string]> = [
      ["PRICE_CLOSE", 100 + tradingIndex * 0.02, "price"],
      ["PE_TTM", 20 - tradingIndex * 0.005, "ratio"],
      ["PB", 2 - tradingIndex * 0.0005, "ratio"],
      ["INDEX_EARNINGS_GROWTH", 5 + tradingIndex * 0.005, "percent"],
    ];
    for (const [metricKey, value, unit] of values) {
      rows.push({
        id: randomUUID(),
        subjectType: "ASSET_BUCKET",
        subjectId: "BROAD_EQUITY",
        metricKey,
        value: String(Number(value.toFixed(4))),
        unit,
        provider: "tushare",
        observedAt: `${asOf}T00:00:00Z`,
        availableAt: `${asOf}T00:00:00Z`,
        asOf,
        fetchedAt: `${asOf}T00:00:00Z`,
        quality: "VALID",
        isManualOverride: false,
      });
    }
    tradingIndex += 1;
  }
  for (let index = 0; index < rows.length; index += 200) {
    db.insert(metricObservations).values(rows.slice(index, index + 200)).run();
  }
}

describe("决策日志纵切", () => {
  it("POST 记录决策，并快照最新评分状态与组合分布", async () => {
    insertScoreSnapshot({ assetBucket: "TECH_GROWTH", asOf: "2026-08-19", state: "LIGHT_ADD_ALLOWED", allowAdd: true });

    const { status, json } = await postDecision({
      assetBucket: "TECH_GROWTH",
      action: "ADD",
      rationale: "趋势确认后小幅加仓",
    });
    expect(status).toBe(200);
    const data = json.data as Record<string, unknown>;
    expect(data.direction).toBe("ADD");
    expect(data.systemState).toBe("LIGHT_ADD_ALLOWED");
    expect(String(data.decidedAt)).toMatch(/\+08:00$/);

    const score = JSON.parse(String(data.scoreSnapshotJson)) as Record<string, unknown>;
    expect(score.asOf).toBe("2026-08-19");
    expect(score.recommendationState).toBe("LIGHT_ADD_ALLOWED");
    expect(score.scoringConfigVersion).toBeTypeOf("number");

    const allocation = JSON.parse(String(data.allocationSnapshotJson)) as {
      byBucket: Record<string, unknown>;
      investableAssetsMinor: string;
    };
    expect(allocation.investableAssetsMinor).toBe("0");
    expect(Object.keys(allocation.byBucket)).toContain("TECH_GROWTH");

    const stored = getDatabase().select().from(decisionLogs).all();
    expect(stored).toHaveLength(1);
    expect(stored[0].action).toBe("ADD");
    expect(stored[0].direction).toBe("ADD");
    expect(stored[0].systemState).toBe("LIGHT_ADD_ALLOWED");
  });

  it("校验与列表：空理由 / 非法动作 / 非法 JSON 被拒绝", async () => {
    const blank = await postDecision({ assetBucket: "GOLD", action: "ADD", rationale: "   " });
    expect(blank.status).toBe(422);
    expect(blank.json.error?.fields?.rationale).toBeTruthy();

    const badAction = await postDecision({ assetBucket: "GOLD", action: "SELL", rationale: "x" });
    expect(badAction.status).toBe(422);

    const badJson = await POST(new Request("http://localhost:3000/api/decisions", { method: "POST", body: "not-json" }));
    expect(badJson.status).toBe(400);

    const response = await GET();
    const json = (await response.json()) as { data: Array<Record<string, unknown>> };
    expect(json.data).toHaveLength(1);
  });

  it("记录 ADD 决策后 7 天内，同方向评分被冷却抑制", async () => {
    seedBroadEquityObservations();

    const before = await refreshScoresForBuckets([{ bucket: "BROAD_EQUITY", asOf: "2026-08-19" }]);
    expect(before[0].saved).toBe(true);
    expect(before[0].result.state).toBe("STRONG_ADD_ALLOWED");
    expect(before[0].result.allowAdd).toBe(true);
    expect(before[0].result.signalSuppressed).toBe(false);

    const decision = await postDecision({
      assetBucket: "BROAD_EQUITY",
      action: "ADD",
      rationale: "估值处于历史低位且盈利增长稳定",
      decidedAt: "2026-08-20T00:00:00Z",
    });
    expect(decision.status).toBe(200);

    const after = await refreshScoresForBuckets([{ bucket: "BROAD_EQUITY", asOf: "2026-08-22" }]);
    expect(after[0].result.signalSuppressed).toBe(true);
    expect(after[0].result.allowAdd).toBe(false);
    expect(after[0].result.state).toBe("STRONG_ADD_ALLOWED");
    expect(after[0].result.reasons.join("")).toContain("七天冷却");
  });

  it("状态变化写入 signals，同一 fingerprint 重复刷新不重复写入", async () => {
    // 08-20 的极端盈利增长观察值触发基本面熔断（REASSESS_THESIS 即时态）。
    insertMetric({ subjectId: "BROAD_EQUITY", metricKey: "INDEX_EARNINGS_GROWTH", value: "-100", unit: "percent", asOf: "2026-08-20" });

    const first = await refreshScoresForBuckets([{ bucket: "BROAD_EQUITY", asOf: "2026-08-23" }]);
    expect(first[0].result.state).toBe("REASSESS_THESIS");
    expect(first[0].result.riskSeverity).toBe("WARNING");

    const fingerprint = "BROAD_EQUITY|STRONG_ADD_ALLOWED|REASSESS_THESIS|2026-08-23";
    const matching = getDatabase().select().from(signals).where(eq(signals.fingerprint, fingerprint)).all();
    expect(matching).toHaveLength(1);
    expect(matching[0].signalType).toBe("STATE_CHANGE");
    expect(matching[0].severity).toBe("WARNING");
    expect(matching[0].oldState).toBe("STRONG_ADD_ALLOWED");
    expect(matching[0].newState).toBe("REASSESS_THESIS");
    expect(matching[0].summary).toContain("→");

    await refreshScoresForBuckets([{ bucket: "BROAD_EQUITY", asOf: "2026-08-23" }]);
    expect(getDatabase().select().from(signals).where(eq(signals.fingerprint, fingerprint)).all()).toHaveLength(1);
  });

  it("持仓硬上限接入刷新链路：OVERWEIGHT/CRITICAL 与 HARD_LIMIT 信号", async () => {
    const db = getDatabase();
    db.insert(holdings).values([
      {
        id: "holding-cash",
        portfolioId: "default",
        name: "现金",
        instrumentType: "CASH",
        assetBucket: "CASH_BONDS",
        marketValueMinor: "88000000",
        asOf: "2026-08-15",
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      },
      {
        id: "holding-stock",
        portfolioId: "default",
        name: "先导智能",
        symbol: "300450",
        instrumentType: "STOCK",
        assetBucket: "TECH_GROWTH",
        theme: "新能源",
        marketValueMinor: "12000000",
        isSingleStock: true,
        asOf: "2026-08-15",
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      },
    ]).run();
    // 给科技桶一条观察值，让刷新链路有快照可保存（分数本身不是本用例关注点）。
    insertMetric({ subjectId: "TECH_GROWTH", metricKey: "PE_TTM", value: "30", unit: "ratio", asOf: "2026-08-20" });

    const refreshed = await refreshScoresForBuckets([{ bucket: "TECH_GROWTH", asOf: "2026-08-20" }]);
    const result = refreshed[0].result;
    expect(result.state).toBe("OVERWEIGHT");
    expect(result.hardLimitExceeded).toBe(true);
    expect(result.hardLimitLabel).toContain("先导智能");
    expect(result.hardLimitLabel).toContain("单股上限");
    expect(result.riskSeverity).toBe("CRITICAL");
    expect(result.allowAdd).toBe(false);
    expect(result.reasons.join("")).toContain("硬上限");

    const snapshot = db
      .select()
      .from(scoreSnapshots)
      .where(and(eq(scoreSnapshots.assetBucket, "TECH_GROWTH"), eq(scoreSnapshots.asOf, "2026-08-20")))
      .get();
    expect(snapshot?.riskSeverity).toBe("CRITICAL");
    expect(snapshot?.recommendationState).toBe("OVERWEIGHT");

    const bucketSignals = () => db.select().from(signals).where(eq(signals.assetBucket, "TECH_GROWTH")).all();
    expect(bucketSignals()).toHaveLength(1);
    expect(bucketSignals()[0].signalType).toBe("HARD_LIMIT");
    expect(bucketSignals()[0].severity).toBe("CRITICAL");
    expect(bucketSignals()[0].summary).toContain("先导智能");

    // 同一评估日再刷新：fingerprint 相同 → 跳过，不重复写入。
    await refreshScoresForBuckets([{ bucket: "TECH_GROWTH", asOf: "2026-08-20" }]);
    expect(bucketSignals()).toHaveLength(1);
  });
});
