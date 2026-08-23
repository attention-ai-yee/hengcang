import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { closeDatabase, getDatabase } from "@/db/client";
import { portfolios } from "@/db/schema";
import { createHolding } from "@/server/portfolio-service";

/**
 * 回归测试（Code Review M20）：全新数据库（未 seed portfolios 行）上
 * 第一次添加持仓必须成功，而不是 FOREIGN KEY constraint failed 裸 500。
 */
const testDatabase = path.join(os.tmpdir(), `hengcang-fresh-db-${randomUUID()}.db`);
const previousDatabaseUrl = process.env.DATABASE_URL;

beforeAll(() => {
  process.env.DATABASE_URL = testDatabase;
  const db = getDatabase();
  migrate(db, { migrationsFolder: path.resolve("drizzle") });
});

afterAll(() => {
  closeDatabase();
  process.env.DATABASE_URL = previousDatabaseUrl;
  for (const suffix of ["", "-wal", "-shm"]) {
    const filename = `${testDatabase}${suffix}`;
    if (fs.existsSync(filename)) fs.rmSync(filename);
  }
});

describe("新库首次建仓（M20）", () => {
  it("portfolios 行不存在时自动补默认组合并成功创建持仓", async () => {
    const created = await createHolding({
      name: "第一笔现金",
      symbol: null,
      instrumentType: "CASH",
      assetBucket: "CASH_BONDS",
      region: "CN",
      theme: null,
      quantity: null,
      costBasisMinor: null,
      marketValueMinor: "100000",
      currency: "CNY",
      isSingleStock: false,
      isThematicEtf: false,
      isApproximate: false,
      needsBreakdown: false,
      asOf: "2026-08-22",
      notes: null,
    });
    expect(created.portfolioId).toBe("default");
    const portfolio = getDatabase().select().from(portfolios).where(eq(portfolios.id, "default")).get();
    expect(portfolio?.reservedCashMinor).toBe("0");
  });
});
