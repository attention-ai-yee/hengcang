import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { closeDatabase, getDatabase } from "@/db/client";
import { metricObservations, portfolios, scoreSnapshots } from "@/db/schema";
import { loadCandidateChain, loadKnownTradingDates } from "@/server/scoring-refresh-service";
import { saveManualScore } from "@/server/scoring-service";

/**
 * 回归测试（Code Review H5）：候选链只接受显式带 candidateState 的快照，
 * 手工代理评分参与同一确认链并写入 candidateState。
 */
const testDatabase = path.join(os.tmpdir(), `hengcang-candidate-chain-${randomUUID()}.db`);
const previousDatabaseUrl = process.env.DATABASE_URL;
const now = "2026-08-22T00:00:00Z";

beforeAll(() => {
  process.env.DATABASE_URL = testDatabase;
  const db = getDatabase();
  migrate(db, { migrationsFolder: path.resolve("drizzle") });
  db.insert(portfolios).values({
    id: "default", name: "测试组合", baseCurrency: "CNY",
    reservedCashMinor: "0", createdAt: now, updatedAt: now,
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

function insertSnapshot(input: { asOf: string; state: string; candidateState?: string }) {
  const db = getDatabase();
  db.insert(scoreSnapshots).values({
    id: randomUUID(),
    portfolioId: "default",
    assetBucket: "GOLD",
    asOf: input.asOf,
    valuationScore: null,
    cheapnessScore: 50,
    fundamentalScore: 50,
    trendScore: 50,
    opportunityScore: 50,
    riskPenalty: 0,
    confidence: "HIGH",
    recommendationState: input.state,
    allowAdd: false,
    forceSell: false,
    riskSeverity: "INFO",
    componentsJson: JSON.stringify(
      input.candidateState === undefined ? {} : { candidateState: input.candidateState },
    ),
    createdAt: now,
  }).run();
}

describe("候选链与手工评分（H5）", () => {
  it("缺少 candidateState 的快照不进入候选链，previousState 仍取最近一条", async () => {
    insertSnapshot({ asOf: "2026-08-19", state: "HOLD" });
    insertSnapshot({ asOf: "2026-08-20", state: "LIGHT_ADD_ALLOWED", candidateState: "LIGHT_ADD_ALLOWED" });
    const chain = await loadCandidateChain("GOLD", "2026-08-21");
    expect(chain.previousState).toBe("LIGHT_ADD_ALLOWED");
    expect(chain.states).toEqual(["LIGHT_ADD_ALLOWED"]);
    expect(chain.dates).toEqual(["2026-08-20"]);
  });

  it("saveManualScore 写入 candidateState 并走同一确认链", async () => {
    const record = await saveManualScore({
      assetBucket: "GOLD",
      cheapnessScore: 80,
      fundamentalScore: 60,
      trendScore: 50,
      asOf: "2026-08-22",
    });
    expect(record.recommendationState).toBe("LOW_CONFIDENCE");
    const parsed = JSON.parse(record.componentsJson) as { candidateState?: string };
    expect(parsed.candidateState).toBe("LOW_CONFIDENCE");
    const chain = await loadCandidateChain("GOLD", "2026-08-23");
    expect(chain.states).toContain("LOW_CONFIDENCE");
  });
});

describe("已知交易日历（连续交易日确认口径）", () => {
  function insertObservation(input: { asOf: string; metricKey: string; provider?: string }) {
    getDatabase().insert(metricObservations).values({
      id: randomUUID(),
      subjectType: "ASSET_BUCKET",
      subjectId: "GOLD",
      metricKey: input.metricKey,
      value: "100",
      unit: "price",
      provider: input.provider ?? "tushare",
      observedAt: `${input.asOf}T15:00:00+08:00`,
      availableAt: `${input.asOf}T18:00:00+08:00`,
      asOf: input.asOf,
      fetchedAt: now,
      quality: "VALID",
    }).run();
  }

  it("只取 PRICE_CLOSE 观察日，升序去重且忽略其他指标", () => {
    // 乱序插入 + 非价格指标 + 同日双 provider（distinct 后只算一个交易日）
    insertObservation({ asOf: "2026-08-20", metricKey: "PRICE_CLOSE" });
    insertObservation({ asOf: "2026-08-17", metricKey: "PRICE_CLOSE" });
    insertObservation({ asOf: "2026-08-18", metricKey: "PE_TTM" });
    insertObservation({ asOf: "2026-08-18", metricKey: "PRICE_CLOSE" });
    insertObservation({ asOf: "2026-08-20", metricKey: "PRICE_CLOSE", provider: "manual" });

    expect(loadKnownTradingDates()).toEqual(["2026-08-17", "2026-08-18", "2026-08-20"]);
  });
});
