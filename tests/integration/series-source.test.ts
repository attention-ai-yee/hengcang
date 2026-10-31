import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { closeDatabase, getDatabase } from "@/db/client";
import { metricObservations } from "@/db/schema";
import { SqliteMetricSeriesRepository } from "@/metrics/observation-repository";

/**
 * 一条序列只用一个来源（2026-10-31 计算复查）：原来逐日挑来源，PE 最近几个月是官方指数估值、
 * 更早是成分股汇总，当前值拿去比另一种口径的历史。现在整条序列选一个来源，手工覆盖仍逐日生效。
 */
const testDatabase = path.join(os.tmpdir(), `hengcang-series-source-${randomUUID()}.db`);
const previousDatabaseUrl = process.env.DATABASE_URL;
const EVAL = "2026-10-30";
// 与 scoring-refresh-service 的评分取数策略一致：PE 没有指定主来源，官方（tushare）优先于汇总
const POLICY = { fallbackProviders: ["tushare", "tushare-index-aggregate", "manual"] };

function insert(provider: string, asOf: string, value: number, isManualOverride = false) {
  getDatabase().insert(metricObservations).values({
    id: randomUUID(), subjectType: "ASSET_BUCKET", subjectId: "BROAD_EQUITY", metricKey: "PE_TTM", value: String(value), unit: "ratio",
    provider, observedAt: `${asOf}T15:00:00+08:00`, availableAt: `${asOf}T18:00:00+08:00`, asOf, fetchedAt: `${asOf}T20:00:00Z`,
    quality: "VALID", isManualOverride,
  }).run();
}

function weekdays(start: string, end: string): string[] {
  const days: string[] = [];
  for (let ms = Date.parse(`${start}T00:00:00Z`); ms <= Date.parse(`${end}T00:00:00Z`); ms += 86_400_000) {
    const day = new Date(ms);
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) days.push(day.toISOString().slice(0, 10));
  }
  return days;
}

function monthEnds(start: string, end: string): string[] {
  const last = new Map<string, string>();
  for (const day of weekdays(start, end)) last.set(day.slice(0, 7), day);
  return [...last.values()];
}

async function resolve(asOf = EVAL) {
  return new SqliteMetricSeriesRepository(POLICY).resolveSeries({ subjectId: "BROAD_EQUITY", metricKey: "PE_TTM", asOf });
}

beforeAll(() => {
  process.env.DATABASE_URL = testDatabase;
  migrate(getDatabase(), { migrationsFolder: path.resolve("drizzle") });
});

beforeEach(() => {
  getDatabase().delete(metricObservations).run();
});

afterAll(() => {
  closeDatabase();
  process.env.DATABASE_URL = previousDatabaseUrl;
  for (const suffix of ["", "-wal", "-shm"]) {
    const filename = `${testDatabase}${suffix}`;
    if (fs.existsSync(filename)) fs.rmSync(filename);
  }
});

describe("一条序列只用一个来源", () => {
  it("官方只有最近一个月（升级后没做全量回填）：整条用 5 年的成分股汇总，不拼官方", async () => {
    for (const day of monthEnds("2021-11-01", EVAL)) insert("tushare-index-aggregate", day, 10);
    for (const day of weekdays("2026-10-01", EVAL)) insert("tushare", day, 13);
    const series = await resolve();
    expect(series.source).toBe("tushare-index-aggregate");
    expect(series.history.every((entry) => entry.value === 10)).toBe(true);
    expect(series.history).toHaveLength(60);
  });

  it("官方也补满 5 年后：整条用官方，汇总的点不再混进来", async () => {
    for (const day of monthEnds("2021-11-01", EVAL)) insert("tushare-index-aggregate", day, 10);
    for (const day of weekdays("2021-11-01", EVAL)) insert("tushare", day, 13);
    const series = await resolve();
    expect(series.source).toBe("tushare");
    expect(series.currentValue).toBe(13);
    expect(series.history.every((entry) => entry.value === 13)).toBe(true);
  });

  it("官方停更一个多月：用仍在更新的汇总", async () => {
    for (const day of monthEnds("2021-11-01", EVAL)) insert("tushare-index-aggregate", day, 10);
    for (const day of weekdays("2021-11-01", "2026-09-15")) insert("tushare", day, 13);
    const series = await resolve();
    expect(series.source).toBe("tushare-index-aggregate");
    expect(series.asOf).toBe(EVAL);
  });

  it("手工覆盖仍逐日生效，盖在选中的来源上", async () => {
    for (const day of weekdays("2021-11-01", EVAL)) insert("tushare", day, 13);
    insert("manual", "2026-10-28", 99, true);
    const series = await resolve();
    expect(series.history.find((entry) => entry.asOf === "2026-10-28")?.value).toBe(99);
    expect(series.history.find((entry) => entry.asOf === "2026-10-27")?.value).toBe(13);
  });

  it("按评估日取数：过去某天只看那天以前的数据来选来源（回测不前视）", async () => {
    for (const day of monthEnds("2021-11-01", EVAL)) insert("tushare-index-aggregate", day, 10);
    for (const day of weekdays("2021-11-01", EVAL)) insert("tushare", day, 13);
    const series = await resolve("2024-06-28");
    expect(series.asOf).toBe("2024-06-28");
    expect(series.source).toBe("tushare");
  });
});
