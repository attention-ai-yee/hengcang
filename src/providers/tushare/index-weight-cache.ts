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

export function readLatestIndexWeights(indexSymbol: string, evaluationDate: string): IndexWeightPoint[] {
  const db = getDatabase();
  const effective = db.select({ effectiveDate: indexConstituentSnapshots.effectiveDate }).from(indexConstituentSnapshots).where(and(
    eq(indexConstituentSnapshots.indexSymbol, indexSymbol), lte(indexConstituentSnapshots.effectiveDate, evaluationDate),
  )).orderBy(desc(indexConstituentSnapshots.effectiveDate)).limit(1).get()?.effectiveDate;
  if (!effective) return [];
  return db.select().from(indexConstituentSnapshots).where(and(eq(indexConstituentSnapshots.indexSymbol, indexSymbol), eq(indexConstituentSnapshots.effectiveDate, effective))).all()
    .map((row) => ({ indexSymbol: row.indexSymbol, effectiveDate: row.effectiveDate, constituentSymbol: row.constituentSymbol, weight: row.weight }));
}
