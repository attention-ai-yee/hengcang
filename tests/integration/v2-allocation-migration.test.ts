import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { asc, eq } from "drizzle-orm";
import { closeDatabase, getDatabase } from "@/db/client";
import { allocationTargets, portfolios } from "@/db/schema";
import { DEFAULT_ALLOCATION_BANDS, V1_DEFAULT_ALLOCATION_BANDS } from "@/domain/settings";
import { ASSET_BUCKETS } from "@/domain/types";

/**
 * 迁移 0004（v2 战略仓位）：仍是 v1 默认值的组合改写为 v2 默认（权益 60%，海外 25%）；
 * 改过目标的组合不动原比例、只补一行 0% 的海外权益；重复执行不再改变任何行。
 * v1/v2 的数值都从代码常量取，SQL 里的硬编码与常量漂移时本测试会失败。
 */
const testDatabase = path.join(os.tmpdir(), `hengcang-v2-allocation-${randomUUID()}.db`);
const previousDatabaseUrl = process.env.DATABASE_URL;
const NOW = "2026-10-01T00:00:00.000Z";
const migrationSql = fs.readFileSync(path.resolve("drizzle/0004_v2_allocation_targets.sql"), "utf8");

function runMigration0004() {
  const sqlite = getDatabase().$client;
  for (const statement of migrationSql.split("--> statement-breakpoint")) {
    if (statement.trim()) sqlite.exec(statement);
  }
}

function targetsOf(portfolioId: string) {
  const rows = getDatabase()
    .select()
    .from(allocationTargets)
    .where(eq(allocationTargets.portfolioId, portfolioId))
    .orderBy(asc(allocationTargets.assetBucket))
    .all();
  return Object.fromEntries(rows.map((row) => [row.assetBucket, { targetBps: row.targetBps, minBps: row.minBps, maxBps: row.maxBps }]));
}

beforeAll(() => {
  process.env.DATABASE_URL = testDatabase;
  const db = getDatabase();
  migrate(db, { migrationsFolder: path.resolve("drizzle") });
  for (const id of ["default", "custom"]) {
    db.insert(portfolios).values({ id, name: id, baseCurrency: "CNY", reservedCashMinor: "0", createdAt: NOW, updatedAt: NOW }).run();
  }
  for (const [bucket, band] of Object.entries(V1_DEFAULT_ALLOCATION_BANDS)) {
    db.insert(allocationTargets).values({ id: `target-${bucket.toLowerCase()}`, portfolioId: "default", assetBucket: bucket, ...band, createdAt: NOW, updatedAt: NOW }).run();
    // 「custom」组合：科技成长被手工改过（35%），其余仍是 v1 默认值
    const customBand = bucket === "TECH_GROWTH" ? { targetBps: 3500, minBps: 2500, maxBps: 4500 } : band;
    db.insert(allocationTargets).values({ id: `custom-${bucket.toLowerCase()}`, portfolioId: "custom", assetBucket: bucket, ...customBand, createdAt: NOW, updatedAt: NOW }).run();
  }
});

afterAll(() => {
  closeDatabase();
  process.env.DATABASE_URL = previousDatabaseUrl;
  for (const suffix of ["", "-wal", "-shm"]) {
    const filename = `${testDatabase}${suffix}`;
    if (fs.existsSync(filename)) fs.rmSync(filename);
  }
});

describe("v2 默认战略仓位", () => {
  it("v1 与 v2 默认目标都合计 100%，且 v2 覆盖全部资产桶", () => {
    const sum = (bands: Record<string, { targetBps: number }>) => Object.values(bands).reduce((total, band) => total + band.targetBps, 0);
    expect(sum(V1_DEFAULT_ALLOCATION_BANDS)).toBe(10_000);
    expect(sum(DEFAULT_ALLOCATION_BANDS)).toBe(10_000);
    expect(Object.keys(DEFAULT_ALLOCATION_BANDS).sort()).toEqual([...ASSET_BUCKETS].sort());
    for (const band of Object.values(DEFAULT_ALLOCATION_BANDS)) {
      expect(band.minBps).toBeLessThanOrEqual(band.targetBps);
      expect(band.targetBps).toBeLessThanOrEqual(band.maxBps);
    }
  });
});

describe("迁移 0004", () => {
  it("未改过的 v1 默认组合改写为 v2 默认值，并补上海外权益", () => {
    runMigration0004();
    expect(targetsOf("default")).toEqual(DEFAULT_ALLOCATION_BANDS);
  });

  it("改过目标的组合保持原比例，只补一行 0% 的海外权益", () => {
    const custom = targetsOf("custom");
    expect(custom.TECH_GROWTH).toEqual({ targetBps: 3500, minBps: 2500, maxBps: 4500 });
    expect(custom.VALUE_DIVIDEND).toEqual(V1_DEFAULT_ALLOCATION_BANDS.VALUE_DIVIDEND);
    expect(custom.OVERSEAS_EQUITY).toEqual({ targetBps: 0, minBps: 0, maxBps: 3500 });
  });

  it("真实升级路径：drizzle 迁移器在已有 v1 数据的库上只补跑 0004", () => {
    // 复制一份只到 0003 的迁移目录，先建出「v1 时代」的库，再用完整目录升级
    const upgradeDb = path.join(os.tmpdir(), `hengcang-v2-upgrade-${randomUUID()}.db`);
    const v1Folder = fs.mkdtempSync(path.join(os.tmpdir(), "hengcang-v1-migrations-"));
    fs.cpSync(path.resolve("drizzle"), v1Folder, { recursive: true });
    const journalPath = path.join(v1Folder, "meta", "_journal.json");
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as { entries: Array<{ tag: string }> };
    journal.entries = journal.entries.filter((entry) => entry.tag < "0004");
    fs.writeFileSync(journalPath, JSON.stringify(journal));
    const sqlite = new Database(upgradeDb);
    try {
      const db = drizzle(sqlite);
      migrate(db, { migrationsFolder: v1Folder });
      sqlite.prepare("INSERT INTO portfolios (id, name, base_currency, reserved_cash_minor, created_at, updated_at) VALUES ('default', 'v1', 'CNY', '0', ?, ?)").run(NOW, NOW);
      const insert = sqlite.prepare("INSERT INTO allocation_targets (id, portfolio_id, asset_bucket, target_bps, min_bps, max_bps, created_at, updated_at) VALUES (?, 'default', ?, ?, ?, ?, ?, ?)");
      for (const [bucket, band] of Object.entries(V1_DEFAULT_ALLOCATION_BANDS)) {
        insert.run(`target-${bucket.toLowerCase()}`, bucket, band.targetBps, band.minBps, band.maxBps, NOW, NOW);
      }
      migrate(db, { migrationsFolder: path.resolve("drizzle") });
      const rows = sqlite.prepare("SELECT asset_bucket, target_bps, min_bps, max_bps FROM allocation_targets WHERE portfolio_id = 'default'").all() as Array<{ asset_bucket: string; target_bps: number; min_bps: number; max_bps: number }>;
      expect(Object.fromEntries(rows.map((row) => [row.asset_bucket, { targetBps: row.target_bps, minBps: row.min_bps, maxBps: row.max_bps }]))).toEqual(DEFAULT_ALLOCATION_BANDS);
    } finally {
      sqlite.close();
      fs.rmSync(v1Folder, { recursive: true, force: true });
      for (const suffix of ["", "-wal", "-shm"]) if (fs.existsSync(`${upgradeDb}${suffix}`)) fs.rmSync(`${upgradeDb}${suffix}`);
    }
  });

  it("重复执行不再改变任何行", () => {
    const before = { default: targetsOf("default"), custom: targetsOf("custom") };
    runMigration0004();
    expect({ default: targetsOf("default"), custom: targetsOf("custom") }).toEqual(before);
  });
});
