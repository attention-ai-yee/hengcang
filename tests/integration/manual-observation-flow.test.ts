import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { closeDatabase, getDatabase } from "@/db/client";
import { allocationTargets, dataSourceStatus, metricObservations, portfolios, scoreSnapshots } from "@/db/schema";
import { previewManualObservationImport } from "@/metrics/manual-import";
import { commitManualObservations } from "@/metrics/observation-repository";
import { refreshScoresForImportedRows } from "@/server/scoring-refresh-service";

const testDatabase = path.join(os.tmpdir(), `hengcang-manual-flow-${randomUUID()}.db`);
const previousDatabaseUrl = process.env.DATABASE_URL;

beforeAll(() => {
  process.env.DATABASE_URL = testDatabase;
  const db = getDatabase();
  migrate(db, { migrationsFolder: path.resolve("drizzle") });
  const now = "2026-08-22T00:00:00Z";
  db.insert(portfolios).values({ id: "default", name: "测试组合", baseCurrency: "CNY", reservedCashMinor: "0", createdAt: now, updatedAt: now }).run();
  db.insert(allocationTargets).values({
    id: "target-broad", portfolioId: "default", assetBucket: "BROAD_EQUITY",
    targetBps: 500, minBps: 0, maxBps: 1500, createdAt: now, updatedAt: now,
  }).run();
  db.insert(dataSourceStatus).values({
    id: "provider-manual", provider: "manual", enabled: true, status: "READY",
    capabilitiesJson: "[]", updatedAt: now,
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

describe("Manual 观察值 SQLite 纵切", () => {
  it("幂等提交后生成 ScoreSnapshot", async () => {
    const rows: Array<Record<string, unknown>> = [];
    for (let year = 2020; year <= 2025; year += 1) {
      const asOf = `${year}-12-31`;
      rows.push({ subjectId: "BROAD_EQUITY", metricKey: "PE_TTM", value: 20 - year + 2020, asOf });
      rows.push({ subjectId: "BROAD_EQUITY", metricKey: "PB", value: 3 - (year - 2020) * 0.1, asOf });
      rows.push({ subjectId: "BROAD_EQUITY", metricKey: "INDEX_EARNINGS_GROWTH", value: year - 2018, asOf });
    }
    const preview = previewManualObservationImport("json", JSON.stringify(rows));
    expect(preview.errors).toEqual([]);

    const first = commitManualObservations(preview.rows);
    const second = commitManualObservations(preview.rows);
    expect(first.inserted).toBe(preview.rows.length);
    expect(second.updated).toBe(preview.rows.length);

    const count = getDatabase().select().from(metricObservations).all().length;
    expect(count).toBe(preview.rows.length);

    const refreshed = await refreshScoresForImportedRows(preview.rows);
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0].saved).toBe(true);
    const snapshot = getDatabase().select().from(scoreSnapshots).where(eq(scoreSnapshots.assetBucket, "BROAD_EQUITY")).get();
    expect(snapshot?.opportunityScore).toBeTypeOf("number");
    expect(snapshot?.confidence).toBe("LOW");
    expect(snapshot?.recommendationState).toBe("LOW_CONFIDENCE");
  });
});
