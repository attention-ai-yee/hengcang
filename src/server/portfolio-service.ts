import { eq } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import { DEFAULT_PORTFOLIO_ID, getPortfolioRecord, listAllocationTargets, listHoldings } from "@/db/queries";
import { holdings } from "@/db/schema";
import { summarizePortfolio } from "@/domain/portfolio";
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
  const [rows, targets, portfolio] = await Promise.all([listHoldings(), listAllocationTargets(), getPortfolioRecord()]);
  const reservedCashMinor = BigInt(portfolio?.reservedCashMinor ?? "0");
  const summary = summarizePortfolio(rows.map(toDomainHolding), reservedCashMinor);
  return {
    holdings: rows,
    targets,
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

export async function updateHolding(id: string, patch: HoldingPatch) {
  getDatabase().update(holdings).set({ ...patch, updatedAt: new Date().toISOString() }).where(eq(holdings.id, id)).run();
  return getDatabase().query.holdings.findFirst({ where: eq(holdings.id, id) });
}

export async function deleteHolding(id: string) {
  return getDatabase().delete(holdings).where(eq(holdings.id, id)).run().changes > 0;
}
