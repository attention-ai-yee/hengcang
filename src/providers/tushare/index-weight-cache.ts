import { and, desc, eq, lte } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import { indexConstituentSnapshots } from "@/db/schema";
import type { IndexWeightPoint } from "./index-aggregator";

export function cacheIndexWeights(points: IndexWeightPoint[], provider: string, fetchedAt: string) {
  const db = getDatabase();
  let inserted = 0;
  let updated = 0;
  db.transaction((transaction) => {
    for (const point of points) {
      const values = { indexSymbol: point.indexSymbol, effectiveDate: point.effectiveDate, constituentSymbol: point.constituentSymbol, weight: point.weight, provider, fetchedAt };
      const existing = transaction.select({ id: indexConstituentSnapshots.id }).from(indexConstituentSnapshots).where(and(
        eq(indexConstituentSnapshots.indexSymbol, point.indexSymbol), eq(indexConstituentSnapshots.effectiveDate, point.effectiveDate), eq(indexConstituentSnapshots.constituentSymbol, point.constituentSymbol),
      )).get();
      if (existing) { transaction.update(indexConstituentSnapshots).set(values).where(eq(indexConstituentSnapshots.id, existing.id)).run(); updated += 1; }
      else { transaction.insert(indexConstituentSnapshots).values({ id: crypto.randomUUID(), ...values }).run(); inserted += 1; }
    }
  });
  return { inserted, updated };
}

export interface IndexWeightSnapshot {
  points: IndexWeightPoint[];
  effectiveDate: string | null;
  /** 生效日距评估日的日历天数；无快照时为 null */
  ageDays: number | null;
}

/** 带时效元数据（Code Review M17）：上游停更后调用方可据此降级而不是照标 VALID。 */
export function readLatestIndexWeightSnapshot(indexSymbol: string, evaluationDate: string): IndexWeightSnapshot {
  const db = getDatabase();
  const effective = db.select({ effectiveDate: indexConstituentSnapshots.effectiveDate }).from(indexConstituentSnapshots).where(and(
    eq(indexConstituentSnapshots.indexSymbol, indexSymbol), lte(indexConstituentSnapshots.effectiveDate, evaluationDate),
  )).orderBy(desc(indexConstituentSnapshots.effectiveDate)).limit(1).get()?.effectiveDate;
  if (!effective) return { points: [], effectiveDate: null, ageDays: null };
  const ageDays = Math.max(0, Math.round((Date.parse(evaluationDate + "T00:00:00Z") - Date.parse(effective + "T00:00:00Z")) / 86_400_000));
  const points = db.select().from(indexConstituentSnapshots).where(and(eq(indexConstituentSnapshots.indexSymbol, indexSymbol), eq(indexConstituentSnapshots.effectiveDate, effective))).all()
    .map((row) => ({ indexSymbol: row.indexSymbol, effectiveDate: row.effectiveDate, constituentSymbol: row.constituentSymbol, weight: row.weight }));
  return { points, effectiveDate: effective, ageDays };
}

export function readLatestIndexWeights(indexSymbol: string, evaluationDate: string): IndexWeightPoint[] {
  return readLatestIndexWeightSnapshot(indexSymbol, evaluationDate).points;
}
