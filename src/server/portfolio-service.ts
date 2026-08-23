import { and, eq, ne } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import { DEFAULT_PORTFOLIO_ID, getPortfolioRecord, getRiskLimits, listAllocationTargets, listHoldings } from "@/db/queries";
import { holdings, portfolios } from "@/db/schema";

import { summarizePortfolio } from "@/domain/portfolio";
import { evaluateHoldingRisk } from "@/domain/risk";
import type { AssetBucket, HoldingInput } from "@/domain/types";
import type { z } from "zod";
import type { holdingPatchSchema, holdingPayloadSchema } from "@/lib/validation";

export type HoldingPayload = z.infer<typeof holdingPayloadSchema>;
export type HoldingPatch = z.infer<typeof holdingPatchSchema>;

function toDomainHolding(row: typeof holdings.$inferSelect): HoldingInput {
  return {
    name: row.name,
    symbol: row.symbol ?? undefined,
    marketValueMinor: BigInt(row.marketValueMinor),
    assetBucket: row.assetBucket as AssetBucket,
    instrumentType: row.instrumentType,
    isSingleStock: row.isSingleStock,
    isThematicEtf: row.isThematicEtf,
    isApproximate: row.isApproximate,
    needsBreakdown: row.needsBreakdown,
    theme: row.theme ?? undefined,
  };
}

export async function getPortfolioView() {
  const [rows, targets, portfolio, limits] = await Promise.all([
    listHoldings(),
    listAllocationTargets(),
    getPortfolioRecord(),
    getRiskLimits(),
  ]);
  const reservedCashMinor = BigInt(portfolio?.reservedCashMinor ?? "0");
  const summary = summarizePortfolio(rows.map(toDomainHolding), reservedCashMinor);
  // 单股/主题 ETF 硬上限（Code Review H6）：以可投资资产为分母逐持仓评估，
  // 超配 → OVERWEIGHT/WARNING；恰好到达上限（无法再增）→ WATCH。
  const holdingRisks = rows.map((row) => ({
    id: row.id,
    name: row.name,
    ...evaluateHoldingRisk({
      holdingValueMinor: BigInt(row.marketValueMinor),
      portfolioValueMinor: summary.investableAssetsMinor,
      isSingleStock: row.isSingleStock,
      isThematicEtf: row.isThematicEtf,
      limits: {
        singleStockBps: limits?.singleStockBps ?? 800,
        thematicEtfBps: limits?.thematicEtfBps ?? 1500,
      },
    }),
  }));
  return {
    holdings: rows,
    targets,
    holdingRisks,
    summary: {
      totalValueMinor: summary.totalValueMinor.toString(),
      reservedCashMinor: summary.reservedCashMinor.toString(),
      investableAssetsMinor: summary.investableAssetsMinor.toString(),
      concentrationComplete: summary.concentrationComplete,
      unresolvedHoldings: summary.unresolvedHoldings,
      byBucket: Object.fromEntries(
        Object.entries(summary.byBucket).map(([key, value]) => [
          key,
          { ...value, valueMinor: value.valueMinor.toString(), investableValueMinor: value.investableValueMinor.toString() },
        ]),
      ),
    },
  };
}

export async function createHolding(payload: HoldingPayload) {
  const now = new Date().toISOString();
  const record = {
    id: crypto.randomUUID(),
    portfolioId: DEFAULT_PORTFOLIO_ID,
    ...payload,
    symbol: payload.symbol || null,
    theme: payload.theme || null,
    quantity: payload.quantity || null,
    costBasisMinor: payload.costBasisMinor || null,
    notes: payload.notes || null,
    manualValueLocked: true,
    createdAt: now,
    updatedAt: now,
  };
  getDatabase().insert(holdings).values(record).run();
  return record;
}

/**
 * 预留资金不变式：reservedCashMinor 不得大于现金与债券桶总额。
 * settings PATCH 有校验，但持仓的修改/删除同样可能破坏该不变式
 * （例如改小现金持仓市值、把持仓移出 CASH_BONDS、删除现金持仓），
 * 一旦破坏，summarizePortfolio 会抛错并让所有读取端 500。
 * 因此在写路径上先按"变更后的持仓集合"预检。
 */
export class ReservedCashNotFundedError extends Error {
  readonly code = "RESERVED_CASH_NOT_FUNDED" as const;
  constructor() {
    super("预留资金不能超过现金与债券桶的当前金额");
    this.name = "ReservedCashNotFundedError";
  }
}

async function assertReservedCashStillFunded(nextRows: Array<typeof holdings.$inferSelect>) {
  const portfolio = await getPortfolioRecord();
  const reserved = BigInt(portfolio?.reservedCashMinor ?? "0");
  if (reserved <= 0n) return;
  const cashAndBonds = nextRows
    .filter((row) => row.assetBucket === "CASH_BONDS")
    .reduce((sum, row) => sum + BigInt(row.marketValueMinor), 0n);
  if (reserved > cashAndBonds) throw new ReservedCashNotFundedError();
}

export async function updateHolding(id: string, patch: HoldingPatch) {
  const db = getDatabase();
  const existing = await db.query.holdings.findFirst({ where: eq(holdings.id, id) });
  if (!existing) return undefined;
  const merged = { ...existing, ...patch } as typeof holdings.$inferSelect;
  const others = await db
    .select()
    .from(holdings)
    .where(and(eq(holdings.portfolioId, DEFAULT_PORTFOLIO_ID), ne(holdings.id, id)));
  await assertReservedCashStillFunded([...others, merged]);
  db.update(holdings).set({ ...patch, updatedAt: new Date().toISOString() }).where(eq(holdings.id, id)).run();
  return db.query.holdings.findFirst({ where: eq(holdings.id, id) });
}

export async function deleteHolding(id: string) {
  const db = getDatabase();
  const existing = await db.query.holdings.findFirst({ where: eq(holdings.id, id) });
  if (!existing) return false;
  const others = await db
    .select()
    .from(holdings)
    .where(and(eq(holdings.portfolioId, DEFAULT_PORTFOLIO_ID), ne(holdings.id, id)));
  await assertReservedCashStillFunded(others);
  return db.delete(holdings).where(eq(holdings.id, id)).run().changes > 0;
}
