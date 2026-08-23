import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { closeDatabase, getDatabase } from "@/db/client";
import { holdings, portfolios } from "@/db/schema";
import { ReservedCashNotFundedError, deleteHolding, updateHolding } from "@/server/portfolio-service";

/**
 * 回归测试（Code Review H1）：持仓的修改/删除必须重验
 * "预留资金 ≤ 现金与债券桶"不变式，否则 summarizePortfolio 会抛错
 * 并让 dashboard/scores/import 等所有读取端永久 500。
 */
const testDatabase = path.join(os.tmpdir(), `hengcang-holding-invariant-${randomUUID()}.db`);
const previousDatabaseUrl = process.env.DATABASE_URL;
const now = "2026-08-22T00:00:00Z";

let cashHoldingId: string;
let goldHoldingId: string;

beforeAll(() => {
  process.env.DATABASE_URL = testDatabase;
  const db = getDatabase();
  migrate(db, { migrationsFolder: path.resolve("drizzle") });
  db.insert(portfolios).values({
    id: "default", name: "测试组合", baseCurrency: "CNY",
    reservedCashMinor: "100000", createdAt: now, updatedAt: now,
  }).run();
  cashHoldingId = randomUUID();
  goldHoldingId = randomUUID();
  db.insert(holdings).values({
    id: cashHoldingId, portfolioId: "default", name: "现金", instrumentType: "CASH",
    assetBucket: "CASH_BONDS", marketValueMinor: "100000", asOf: "2026-08-22",
    manualValueLocked: true, createdAt: now, updatedAt: now,
  }).run();
  db.insert(holdings).values({
    id: goldHoldingId, portfolioId: "default", name: "黄金", instrumentType: "GOLD",
    assetBucket: "GOLD", marketValueMinor: "500000", asOf: "2026-08-22",
    manualValueLocked: true, createdAt: now, updatedAt: now,
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

function cashRow() {
  return getDatabase().select().from(holdings).where(eq(holdings.id, cashHoldingId)).get();
}

describe("预留资金不变式（H1）", () => {
  it("把现金改到低于预留资金被拒绝且不落库", async () => {
    await expect(updateHolding(cashHoldingId, { marketValueMinor: "50000" })).rejects.toBeInstanceOf(
      ReservedCashNotFundedError,
    );
    expect(cashRow()?.marketValueMinor).toBe("100000");
  });

  it("把持仓移出现金与债券桶导致缺口时被拒绝", async () => {
    await expect(updateHolding(cashHoldingId, { assetBucket: "GOLD" })).rejects.toBeInstanceOf(
      ReservedCashNotFundedError,
    );
    expect(cashRow()?.assetBucket).toBe("CASH_BONDS");
  });

  it("删除唯一现金持仓被拒绝且不落库", async () => {
    await expect(deleteHolding(cashHoldingId)).rejects.toBeInstanceOf(ReservedCashNotFundedError);
    expect(cashRow()).toBeDefined();
  });

  it("不破坏不变式的修改正常执行", async () => {
    const updated = await updateHolding(cashHoldingId, { name: "现金储备", marketValueMinor: "150000" });
    expect(updated?.marketValueMinor).toBe("150000");
    expect(updated?.name).toBe("现金储备");
  });

  it("预留资金清零后删除不再受限", async () => {
    getDatabase()
      .update(portfolios)
      .set({ reservedCashMinor: "0" })
      .where(eq(portfolios.id, "default"))
      .run();
    await expect(deleteHolding(goldHoldingId)).resolves.toBe(true);
  });
});
