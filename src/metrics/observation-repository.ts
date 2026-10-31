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
  private readonly seriesCache = new Map<string, MetricSeries>();

  constructor(private readonly policy: ProviderSelectionPolicy = {}) {}

  async resolveSeries(request: ResolveSeriesRequest): Promise<MetricSeries> {
    // 同一构建器实例内同一序列只全量载入一次（Code Review M16）。
    const cacheKey = `${request.subjectId}|${request.metricKey}|${request.asOf}`;
    const cached = this.seriesCache.get(cacheKey);
    if (cached) return cached;
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

    const seriesRows = this.consistentSource(rows, request.metricKey);
    const selected = new Map<string, (typeof rows)[number]>();
    for (const row of seriesRows) {
      const existing = selected.get(row.asOf);
      if (!existing || this.isPreferred(row, existing, request.metricKey, request.asOf)) {
        selected.set(row.asOf, row);
      }
    }

    const historyRows = Array.from(selected.values()).sort((first, second) => first.asOf.localeCompare(second.asOf));
    const latest = historyRows.at(-1);
    const series = {
      currentValue: latest ? Number(latest.value) : null,
      history: historyRows
        .map((row) => {
          return { value: Number(row.value), asOf: row.asOf, availableAt: row.availableAt, quality: row.quality as "VALID" | "PARTIAL", ...parseReportPeriod(row.metadataJson) };
        })
        .filter((point) => Number.isFinite(point.value)),
      source: latest?.provider ?? "UNAVAILABLE",
      asOf: latest?.asOf ?? request.asOf,
      availableAt: latest?.availableAt,
      quality: latest?.quality as "VALID" | "PARTIAL" | undefined,
      coverage: latest ? parseCoverage(latest.metadataJson) : undefined,
    };
    this.seriesCache.set(cacheKey, series);
    return series;
  }

  /**
   * 一条序列只用一个来源（手工覆盖行除外，仍逐日覆盖）。原来逐日挑来源：同一天有官方指数估值
   * （tushare）就用官方的，没有就用成分股汇总（tushare-index-aggregate），于是最近几个月是官方口径、
   * 更早是汇总口径，拿当前值去比另一种口径的历史，分位会系统性偏（2026-10-31 复查）。
   * 选法：在「最新一点不比全体最新早 10 天以上」的来源里，取历史最长的（起点按月比）；一样长取优先级高的。
   * 官方历史还短（升级后没做全量回填）时用汇总，官方补满 5 年后自动换成官方。
   */
  private consistentSource<T extends typeof metricObservations.$inferSelect>(rows: T[], metricKey: CanonicalMetricKey): T[] {
    const providerRows = rows.filter((row) => !row.isManualOverride);
    const spans = new Map<string, { first: string; last: string }>();
    for (const row of providerRows) {
      const span = spans.get(row.provider);
      if (!span) spans.set(row.provider, { first: row.asOf, last: row.asOf });
      else {
        if (row.asOf < span.first) span.first = row.asOf;
        if (row.asOf > span.last) span.last = row.asOf;
      }
    }
    if (spans.size <= 1) return rows;
    const latest = [...spans.values()].reduce((max, span) => (span.last > max ? span.last : max), "");
    const freshFrom = shiftDays(latest, -10);
    const [chosen] = [...spans.entries()]
      .filter(([, span]) => span.last >= freshFrom)
      .sort(([leftProvider, left], [rightProvider, right]) =>
        left.first.slice(0, 7).localeCompare(right.first.slice(0, 7))
        || this.providerRank(rightProvider, metricKey) - this.providerRank(leftProvider, metricKey));
    return rows.filter((row) => row.isManualOverride || row.provider === chosen?.[0]);
  }

  private providerRank(provider: string, metricKey: CanonicalMetricKey): number {
    if (provider === this.policy.primaryProviderByMetric?.[metricKey]) return 1_000;
    const fallbackIndex = this.policy.fallbackProviders?.indexOf(provider) ?? -1;
    return fallbackIndex >= 0 ? 500 - fallbackIndex : 0;
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
    return row.isManualOverride ? 10_000 : this.providerRank(row.provider, metricKey);
  }
}

function shiftDays(day: string, days: number): string {
  const date = new Date(`${day.slice(0, 10)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function commitManualObservations(rows: ManualObservationInput[]) {
  const db = getDatabase();
  const fetchedAt = new Date().toISOString();
  let inserted = 0;
  let updated = 0;
  let failed = 0;

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
          // 与唯一索引 metric_observation_unique 完全对齐（M8）：索引含 observedAt+availableAt 而不含 asOf，
          // 按 asOf 查存在会漏判重，随后 INSERT 撞索引并回滚整个事务
          eq(metricObservations.observedAt, row.observedAt),
          eq(metricObservations.availableAt, row.availableAt),
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
        try {
          transaction.insert(metricObservations).values({ id: crypto.randomUUID(), ...values }).run();
          inserted += 1;
        } catch (error) {
          // 残余的唯一约束冲突降级为行级跳过，不再回滚整个导入事务（M8）
          const code = (error as { code?: string } | null)?.code ?? "";
          if (!code.startsWith("SQLITE_CONSTRAINT")) throw error;
          failed += 1;
        }
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

  return { inserted, updated, failed, committed: rows.length, fetchedAt };
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

function parseReportPeriod(metadataJson: string | null): { reportPeriod?: string; reportPeriodShare?: number } {
  if (!metadataJson) return {};
  try {
    const { reportPeriod, reportPeriodShare } = JSON.parse(metadataJson) as { reportPeriod?: unknown; reportPeriodShare?: unknown };
    if (typeof reportPeriod !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(reportPeriod)) return {};
    const share = typeof reportPeriodShare === "number" && reportPeriodShare > 0 && reportPeriodShare <= 1 ? reportPeriodShare : undefined;
    return share === undefined ? { reportPeriod } : { reportPeriod, reportPeriodShare: share };
  } catch {
    return {};
  }
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
