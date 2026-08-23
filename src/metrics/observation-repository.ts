import { and, asc, eq, inArray, lte } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import { dataSourceStatus, metricObservations } from "@/db/schema";
import type { MetricSeries } from "@/domain/scoring";
import type { ScorableAssetBucket } from "@/domain/types";
import type { CanonicalMetricKey } from "./catalog";
import type { ManualObservationInput } from "./manual-import";

export interface ResolveSeriesRequest {
  subjectId: ScorableAssetBucket;
  metricKey: CanonicalMetricKey;
  asOf: string;
}

export interface MetricSeriesRepository {
  resolveSeries(request: ResolveSeriesRequest): Promise<MetricSeries>;
}

export interface ProviderSelectionPolicy {
  primaryProviderByMetric?: Partial<Record<CanonicalMetricKey, string>>;
  fallbackProviders?: string[];
}

export interface ProviderMetricObservationInput {
  subjectType: "ASSET_BUCKET" | "INSTRUMENT";
  subjectId: ScorableAssetBucket | string;
  metricKey: CanonicalMetricKey;
  value: string;
  unit: string;
  provider: string;
  observedAt: string;
  availableAt: string;
  asOf: string;
  fetchedAt: string;
  quality: "VALID" | "PARTIAL";
  metadataJson?: string;
}

export class SqliteMetricSeriesRepository implements MetricSeriesRepository {
  constructor(private readonly policy: ProviderSelectionPolicy = {}) {}

  async resolveSeries(request: ResolveSeriesRequest): Promise<MetricSeries> {
    const rows = getDatabase()
      .select()
      .from(metricObservations)
      .where(and(
        eq(metricObservations.subjectType, "ASSET_BUCKET"),
        eq(metricObservations.subjectId, request.subjectId),
        eq(metricObservations.metricKey, request.metricKey),
        lte(metricObservations.asOf, request.asOf),
        inArray(metricObservations.quality, ["VALID", "PARTIAL"]),
      ))
      .orderBy(asc(metricObservations.asOf))
      .all()
      .filter((row) => row.availableAt.slice(0, 10) <= request.asOf);

    const selected = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const existing = selected.get(row.asOf);
      if (!existing || this.isPreferred(row, existing, request.metricKey, request.asOf)) {
        selected.set(row.asOf, row);
      }
    }

    const historyRows = Array.from(selected.values()).sort((first, second) => first.asOf.localeCompare(second.asOf));
    const latest = historyRows.at(-1);
    return {
      currentValue: latest ? Number(latest.value) : null,
      history: historyRows
        .map((row) => ({ value: Number(row.value), asOf: row.asOf, availableAt: row.availableAt, quality: row.quality as "VALID" | "PARTIAL" }))
        .filter((point) => Number.isFinite(point.value)),
      source: latest?.provider ?? "UNAVAILABLE",
      asOf: latest?.asOf ?? request.asOf,
      availableAt: latest?.availableAt,
      quality: latest?.quality as "VALID" | "PARTIAL" | undefined,
      coverage: latest ? parseCoverage(latest.metadataJson) : undefined,
    };
  }

  private isPreferred(
    candidate: typeof metricObservations.$inferSelect,
    existing: typeof metricObservations.$inferSelect,
    metricKey: CanonicalMetricKey,
    evaluationDate: string,
  ): boolean {
    const candidateRank = this.rank(candidate, metricKey);
    const existingRank = this.rank(existing, metricKey);
    if (candidate.provider === existing.provider) {
      // Revisions share an observed/as-of date. At a past evaluation date only
      // the most recently available revision may be used, never a later restatement.
      if (candidate.availableAt !== existing.availableAt) return candidate.availableAt > existing.availableAt;
      return candidate.fetchedAt > existing.fetchedAt;
    }
    if (candidateRank !== existingRank) return candidateRank > existingRank;
    if (candidate.quality !== existing.quality) return candidate.quality === "VALID";
    return candidate.fetchedAt > existing.fetchedAt;
  }

  private rank(row: typeof metricObservations.$inferSelect, metricKey: CanonicalMetricKey): number {
    if (row.isManualOverride) return 10_000;
    if (row.provider === this.policy.primaryProviderByMetric?.[metricKey]) return 1_000;
    const fallbackIndex = this.policy.fallbackProviders?.indexOf(row.provider) ?? -1;
    return fallbackIndex >= 0 ? 500 - fallbackIndex : 0;
  }
}

export function commitManualObservations(rows: ManualObservationInput[]) {
  const db = getDatabase();
  const fetchedAt = new Date().toISOString();
  let inserted = 0;
  let updated = 0;

  db.transaction((transaction) => {
    for (const row of rows) {
      const existing = transaction
        .select({ id: metricObservations.id })
        .from(metricObservations)
        .where(and(
          eq(metricObservations.subjectType, row.subjectType),
          eq(metricObservations.subjectId, row.subjectId),
          eq(metricObservations.metricKey, row.metricKey),
          eq(metricObservations.provider, "manual"),
          eq(metricObservations.asOf, row.asOf),
        ))
        .get();
      const values = {
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        metricKey: row.metricKey,
        value: row.value,
        unit: row.unit,
        provider: "manual",
        observedAt: row.observedAt,
        availableAt: row.availableAt,
        asOf: row.asOf,
        fetchedAt,
        quality: "VALID",
        metadataJson: null,
        isManualOverride: true,
      } as const;
      if (existing) {
        transaction.update(metricObservations).set(values).where(eq(metricObservations.id, existing.id)).run();
        updated += 1;
      } else {
        transaction.insert(metricObservations).values({ id: crypto.randomUUID(), ...values }).run();
        inserted += 1;
      }
    }

    transaction
      .update(dataSourceStatus)
      .set({
        enabled: true,
        status: "READY",
        lastAttemptAt: fetchedAt,
        lastSuccessAt: fetchedAt,
        lastErrorCode: null,
        lastErrorMessage: null,
        updatedAt: fetchedAt,
      })
      .where(eq(dataSourceStatus.provider, "manual"))
      .run();
  });

  return { inserted, updated, committed: rows.length, fetchedAt };
}

export function commitProviderMetricObservations(rows: ProviderMetricObservationInput[]) {
  if (rows.length === 0) return { inserted: 0, updated: 0, committed: 0 };
  const db = getDatabase();
  let inserted = 0;
  let updated = 0;

  db.transaction((transaction) => {
    for (const row of rows) {
      const existing = transaction
        .select({ id: metricObservations.id })
        .from(metricObservations)
        .where(and(
          eq(metricObservations.subjectType, row.subjectType),
          eq(metricObservations.subjectId, row.subjectId),
          eq(metricObservations.metricKey, row.metricKey),
          eq(metricObservations.provider, row.provider),
          eq(metricObservations.observedAt, row.observedAt),
          eq(metricObservations.availableAt, row.availableAt),
        ))
        .get();
      const values = { ...row, isManualOverride: false } as const;
      if (existing) {
        transaction.update(metricObservations).set(values).where(eq(metricObservations.id, existing.id)).run();
        updated += 1;
      } else {
        transaction.insert(metricObservations).values({ id: crypto.randomUUID(), ...values }).run();
        inserted += 1;
      }
    }
  });

  return { inserted, updated, committed: rows.length };
}

function parseCoverage(metadataJson: string | null): number | undefined {
  if (!metadataJson) return undefined;
  try {
    const parsed = JSON.parse(metadataJson) as { constituentCoverage?: unknown };
    const value = parsed.constituentCoverage;
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
