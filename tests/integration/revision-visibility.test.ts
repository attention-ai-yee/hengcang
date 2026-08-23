import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { closeDatabase, getDatabase } from "@/db/client";
import { commitProviderMetricObservations, SqliteMetricSeriesRepository } from "@/metrics/observation-repository";

const filename = path.join(os.tmpdir(), `hengcang-revision-${randomUUID()}.db`);
const prior = process.env.DATABASE_URL;

beforeAll(() => {
  process.env.DATABASE_URL = filename;
  migrate(getDatabase(), { migrationsFolder: path.resolve("drizzle") });
});

afterAll(() => {
  closeDatabase();
  process.env.DATABASE_URL = prior;
  for (const suffix of ["", "-wal", "-shm"]) if (fs.existsSync(`${filename}${suffix}`)) fs.rmSync(`${filename}${suffix}`);
});

describe("财务修订可见性", () => {
  it("保留相同报告期的多个 availableAt 版本，并在回测日选择当时最后可见版本", async () => {
    commitProviderMetricObservations([
      { subjectType: "ASSET_BUCKET", subjectId: "BROAD_EQUITY", metricKey: "INDEX_EARNINGS_GROWTH", value: "10", unit: "percent", provider: "tushare-index-aggregate", observedAt: "2025-12-31T23:59:59+08:00", availableAt: "2026-03-20T08:00:00+08:00", asOf: "2025-12-31", fetchedAt: "2026-03-20T09:00:00+08:00", quality: "VALID" },
      { subjectType: "ASSET_BUCKET", subjectId: "BROAD_EQUITY", metricKey: "INDEX_EARNINGS_GROWTH", value: "14", unit: "percent", provider: "tushare-index-aggregate", observedAt: "2025-12-31T23:59:59+08:00", availableAt: "2026-04-10T08:00:00+08:00", asOf: "2025-12-31", fetchedAt: "2026-04-10T09:00:00+08:00", quality: "VALID" },
    ]);
    const repository = new SqliteMetricSeriesRepository({ primaryProviderByMetric: { INDEX_EARNINGS_GROWTH: "tushare-index-aggregate" } });
    expect((await repository.resolveSeries({ subjectId: "BROAD_EQUITY", metricKey: "INDEX_EARNINGS_GROWTH", asOf: "2026-03-31" })).currentValue).toBe(10);
    expect((await repository.resolveSeries({ subjectId: "BROAD_EQUITY", metricKey: "INDEX_EARNINGS_GROWTH", asOf: "2026-04-11" })).currentValue).toBe(14);
  });
});
