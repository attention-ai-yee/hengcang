import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { and, eq } from "drizzle-orm";
import { closeDatabase, getDatabase } from "@/db/client";
import { metricObservations } from "@/db/schema";
import { commitProviderMetricObservations, type ProviderMetricObservationInput } from "@/metrics/observation-repository";
import type { EquityFundamentalSnapshot } from "@/providers/tushare/index-aggregator";
import { cacheIndexWeights } from "@/providers/tushare/index-weight-cache";
import type { TushareScoreProxy } from "@/providers/tushare/proxies";
import type { ProviderResult } from "@/providers/types";
import { refreshFundamentals } from "@/server/automatic-data-refresh-service";

/**
 * v2 财报增量刷新（docs/hengcang_v2_allocation_fundamentals_thesis.md §2）：
 * - 增量模式只为上次桶级汇总之后的新日期生成汇总行，不覆盖全量回填算好的历史；
 * - 每个日期只用当日已披露的最新财报（点内时间）；
 * - 迁移 0005 把 v1 混在财报口径里的派生行移到 *_DERIVED 指标。
 */
const testDatabase = path.join(os.tmpdir(), `hengcang-fundamentals-${randomUUID()}.db`);
const previousDatabaseUrl = process.env.DATABASE_URL;
const FETCHED_AT = "2026-10-25T10:00:00.000Z";
const TECH_PROXY: TushareScoreProxy = { bucket: "TECH_GROWTH", label: "创业板指", symbol: "399006.SZ", instrumentKind: "INDEX", valuationMetrics: [] };

function report(symbol: string, reportPeriod: string, announced: string, earningsGrowth: number, revenueGrowth: number): EquityFundamentalSnapshot {
  return { symbol, reportPeriod, availableAt: `${announced}T08:00:00+08:00`, roe: 8, earningsGrowth, revenueGrowth };
}

const REPORTS: EquityFundamentalSnapshot[] = [
  report("A.SZ", "2026-03-31", "2026-04-25", -10, 5),
  report("A.SZ", "2026-06-30", "2026-08-15", -20, 2),
  report("A.SZ", "2026-09-30", "2026-10-15", -30, -1),
  report("B.SZ", "2026-03-31", "2026-04-28", 10, 6),
  report("B.SZ", "2026-06-30", "2026-08-28", 0, 3),
  report("B.SZ", "2026-09-30", "2026-10-20", -10, -2),
];

function success(data: EquityFundamentalSnapshot[]): ProviderResult<EquityFundamentalSnapshot[]> {
  return { ok: true, data, provider: "tushare", fetchedAt: FETCHED_AT, quality: "VALID" };
}

const fakeProvider = {
  async getEquityFundamentals(symbol: string) {
    return success(REPORTS.filter((row) => row.symbol === symbol));
  },
};

function bucketGrowthRows(rows: ProviderMetricObservationInput[], metricKey: string) {
  return rows
    .filter((row) => row.subjectType === "ASSET_BUCKET" && row.metricKey === metricKey)
    .map((row) => ({ asOf: row.asOf, value: Number(row.value) }))
    .sort((first, second) => first.asOf.localeCompare(second.asOf));
}

beforeAll(() => {
  process.env.DATABASE_URL = testDatabase;
  migrate(getDatabase(), { migrationsFolder: path.resolve("drizzle") });
  for (const effectiveDate of ["2025-12-31", "2026-06-30"]) {
    cacheIndexWeights(["A.SZ", "B.SZ"].map((constituentSymbol) => ({ indexSymbol: TECH_PROXY.symbol, effectiveDate, constituentSymbol, weight: 0.5 })), "tushare", FETCHED_AT);
  }
  // 上次全量回填留下的桶级汇总：截至 2026-08-20
  commitProviderMetricObservations([{
    subjectType: "ASSET_BUCKET", subjectId: "TECH_GROWTH", metricKey: "EARNINGS_GROWTH", value: "-5", unit: "percent",
    provider: "tushare-index-aggregate", observedAt: "2026-06-30T15:00:00+08:00", availableAt: "2026-08-20T18:00:00+08:00",
    asOf: "2026-08-20", fetchedAt: "2026-08-21T00:00:00.000Z", quality: "VALID",
  }]);
});

afterAll(() => {
  closeDatabase();
  process.env.DATABASE_URL = previousDatabaseUrl;
  for (const suffix of ["", "-wal", "-shm"]) {
    const filename = `${testDatabase}${suffix}`;
    if (fs.existsSync(filename)) fs.rmSync(filename);
  }
});

describe("refreshFundamentals 增量模式", () => {
  it("只补上次汇总（2026-08-20）之后的日期，且每个日期用当日已披露的最新财报", async () => {
    const warnings: string[] = [];
    const rows = await refreshFundamentals(fakeProvider, [TECH_PROXY], "2026-10-25", { start: "2025-07-25", end: "2026-10-25" }, "INCREMENTAL", warnings, FETCHED_AT);
    expect(bucketGrowthRows(rows, "EARNINGS_GROWTH")).toEqual([
      { asOf: "2026-08-28", value: -10 }, // A 半年报 −20、B 半年报 0
      { asOf: "2026-10-15", value: -15 }, // A 三季报 −30、B 仍是半年报 0
      { asOf: "2026-10-20", value: -20 }, // A −30、B 三季报 −10
    ]);
    expect(bucketGrowthRows(rows, "REVENUE_GROWTH").map((row) => row.asOf)).toEqual(["2026-08-28", "2026-10-15", "2026-10-20"]);
    // 个股层面的财报全部入库（幂等 upsert），供以后按持仓做体检
    expect(rows.filter((row) => row.subjectType === "INSTRUMENT" && row.metricKey === "EARNINGS_GROWTH")).toHaveLength(REPORTS.length);
  });

  it("全量模式重算全部可算的日期（覆盖率不足 60% 的 2026-04-25 不出行）", async () => {
    const rows = await refreshFundamentals(fakeProvider, [TECH_PROXY], "2026-10-25", { start: "2021-10-25", end: "2026-10-25" }, "FULL", [], FETCHED_AT);
    expect(bucketGrowthRows(rows, "EARNINGS_GROWTH").map((row) => row.asOf)).toEqual(["2026-04-28", "2026-08-15", "2026-08-28", "2026-10-15", "2026-10-20"]);
  });

  it("SKIP 模式不请求任何数据", async () => {
    let calls = 0;
    const counting = { async getEquityFundamentals() { calls += 1; return success([]); } };
    expect(await refreshFundamentals(counting, [TECH_PROXY], "2026-10-25", { start: "2025-07-25", end: "2026-10-25" }, "SKIP", [], FETCHED_AT)).toEqual([]);
    expect(calls).toBe(0);
  });
});

describe("迁移 0005：派生盈利增长移到 *_DERIVED 指标", () => {
  it("只移动 provider = tushare-derived 的行，财报汇总口径不动", () => {
    commitProviderMetricObservations([
      { subjectType: "ASSET_BUCKET", subjectId: "BROAD_EQUITY", metricKey: "INDEX_EARNINGS_GROWTH", value: "3", unit: "percent", provider: "tushare-derived", observedAt: "2026-09-30T15:00:00+08:00", availableAt: "2026-09-30T18:00:00+08:00", asOf: "2026-09-30", fetchedAt: FETCHED_AT, quality: "PARTIAL" },
      { subjectType: "ASSET_BUCKET", subjectId: "TECH_GROWTH", metricKey: "EARNINGS_GROWTH", value: "4", unit: "percent", provider: "tushare-derived", observedAt: "2026-09-30T15:00:00+08:00", availableAt: "2026-09-30T18:00:00+08:00", asOf: "2026-09-30", fetchedAt: FETCHED_AT, quality: "PARTIAL" },
    ]);
    const sqlite = getDatabase().$client;
    for (const statement of fs.readFileSync(path.resolve("drizzle/0005_v2_derived_growth_keys.sql"), "utf8").split("--> statement-breakpoint")) {
      if (statement.trim()) sqlite.exec(statement);
    }
    const keysFor = (provider: string) => getDatabase().select({ subjectId: metricObservations.subjectId, metricKey: metricObservations.metricKey })
      .from(metricObservations).where(and(eq(metricObservations.provider, provider), eq(metricObservations.subjectType, "ASSET_BUCKET"))).all()
      .map((row) => `${row.subjectId}:${row.metricKey}`).sort();
    expect(keysFor("tushare-derived")).toEqual(["BROAD_EQUITY:INDEX_EARNINGS_GROWTH_DERIVED", "TECH_GROWTH:EARNINGS_GROWTH_DERIVED"]);
    expect(keysFor("tushare-index-aggregate")).toEqual(["TECH_GROWTH:EARNINGS_GROWTH"]);
  });
});
