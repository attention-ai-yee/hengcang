import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterAll, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { exportMarketSnapshot, importMarketSnapshot } from "@/server/market-snapshot";

/**
 * 市场数据存档（2026-10-31）：云端数据库是临时的，存档导入后只需增量刷新。
 * 存档只能有市场数据：持仓、组合设置、手工录入的数值不能进去（存档放在私有仓库，但也不该带个人数据）。
 */
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hengcang-snapshot-test-"));
const NOW = "2026-10-31T08:00:00.000Z";

function freshDatabase(name: string, withPortfolio = true) {
  const file = path.join(directory, name);
  const sqlite = new Database(file);
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: path.resolve("drizzle") });
  if (withPortfolio) db.insert(schema.portfolios).values({ id: "default", name: "组合", baseCurrency: "CNY", reservedCashMinor: "0", createdAt: NOW, updatedAt: NOW }).run();
  return { file, sqlite, db };
}

function observation(provider: string, value: string, isManualOverride = false) {
  return {
    id: randomUUID(), subjectType: "ASSET_BUCKET", subjectId: "BROAD_EQUITY", metricKey: isManualOverride ? "PE_TTM" : "PRICE_CLOSE", value, unit: "price",
    provider, observedAt: `2026-10-30T15:00:00+08:00`, availableAt: `2026-10-30T18:00:00+08:00`, asOf: "2026-10-30", fetchedAt: NOW, quality: "VALID", isManualOverride,
  };
}

afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

describe("市场数据存档", () => {
  const source = freshDatabase("source.db");
  source.db.insert(schema.holdings).values({
    id: "holding-1", portfolioId: "default", name: "我的股票", assetBucket: "TECH_GROWTH", instrumentType: "STOCK", quantity: "100",
    marketValueMinor: "12345600", asOf: "2026-10-30", createdAt: NOW, updatedAt: NOW,
  } as typeof schema.holdings.$inferInsert).run();
  source.db.insert(schema.metricObservations).values([observation("tushare", "3985.501"), observation("manual", "9.9", true)]).run();
  source.db.insert(schema.indexConstituentSnapshots).values({ id: randomUUID(), indexSymbol: "000300.SH", effectiveDate: "2026-09-30", constituentSymbol: "600519.SH", weight: 4.2, provider: "tushare", fetchedAt: NOW }).run();
  source.db.insert(schema.dataSourceStatus).values({ id: "provider-tushare-fina", provider: "tushare-fina", enabled: true, status: "READY", lastAttemptAt: NOW, lastSuccessAt: NOW, capabilitiesJson: "{}", updatedAt: NOW } as typeof schema.dataSourceStatus.$inferInsert).run();
  source.db.insert(schema.configSnapshots).values({ id: "config-1", portfolioId: "default", version: 7, configJson: "{}", createdAt: NOW }).run();
  source.db.insert(schema.scoreSnapshots).values({
    id: randomUUID(), portfolioId: "default", assetBucket: "BROAD_EQUITY", asOf: "2026-10-30", valuationScore: null, cheapnessScore: 46.5, fundamentalScore: 57.7,
    trendScore: 6.4, opportunityScore: 34.5, riskPenalty: 0, confidence: "HIGH", recommendationState: "DO_NOT_ADD", allowAdd: false, forceSell: false,
    riskSeverity: "INFO", componentsJson: "{}", configSnapshotId: "config-1", createdAt: NOW,
  }).run();
  source.sqlite.close();
  const archive = path.join(directory, "market-data.sqlite.gz");
  const exported = exportMarketSnapshot(source.file, archive);

  it("导出：只有市场数据，没有持仓、组合和手工录入的数值", () => {
    expect(exported.latestPriceDate).toBe("2026-10-30");
    const unpacked = path.join(directory, "unpacked.db");
    fs.writeFileSync(unpacked, zlib.gunzipSync(fs.readFileSync(archive)));
    const snapshot = new Database(unpacked, { readonly: true });
    const count = (table: string) => (snapshot.prepare(`select count(*) n from ${table}`).get() as { n: number }).n;
    expect(count("holdings")).toBe(0);
    expect(count("portfolios")).toBe(0);
    expect(count("metric_observations")).toBe(1);
    expect((snapshot.prepare("select provider from metric_observations").get() as { provider: string }).provider).toBe("tushare");
    expect(count("score_snapshots")).toBe(1);
    expect(count("index_constituent_snapshots")).toBe(1);
    snapshot.close();
    expect(JSON.parse(fs.readFileSync(`${archive}.json`, "utf8"))).toMatchObject({ latestPriceDate: "2026-10-30", rows: { metric_observations: 1 } });
  });

  it("导入：新库里有了行情、权重、数据源状态和评分；导两次不重复；目标库自己的持仓不动", () => {
    const target = freshDatabase("target.db");
    target.db.insert(schema.holdings).values({
      id: "holding-target", portfolioId: "default", name: "目标库持仓", assetBucket: "GOLD", instrumentType: "FUND", quantity: "1",
      marketValueMinor: "100", asOf: "2026-10-30", createdAt: NOW, updatedAt: NOW,
    } as typeof schema.holdings.$inferInsert).run();
    target.sqlite.close();
    importMarketSnapshot(archive, target.file);
    importMarketSnapshot(archive, target.file);
    const check = new Database(target.file, { readonly: true });
    const count = (table: string) => (check.prepare(`select count(*) n from ${table}`).get() as { n: number }).n;
    expect(count("metric_observations")).toBe(1);
    expect(count("index_constituent_snapshots")).toBe(1);
    expect(count("score_snapshots")).toBe(1);
    expect((check.prepare("select last_success_at d from data_source_status where provider = 'tushare-fina'").get() as { d: string }).d).toBe(NOW);
    expect((check.prepare("select name from holdings").all() as Array<{ name: string }>).map((row) => row.name)).toEqual(["目标库持仓"]);
    check.close();
  });

  it("目标库没初始化（没有默认组合）时给出明确提示", () => {
    const bare = freshDatabase("bare.db", false);
    bare.sqlite.close();
    expect(() => importMarketSnapshot(archive, bare.file)).toThrow("db:seed");
  });
});
