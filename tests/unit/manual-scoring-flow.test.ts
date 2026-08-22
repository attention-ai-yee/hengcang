import { describe, expect, it } from "vitest";
import { calculateAssetScore, ScoreInputBuilder, type MetricSeries } from "@/domain/scoring";
import type { ScorableAssetBucket } from "@/domain/types";
import type { CanonicalMetricKey } from "@/metrics/catalog";
import { previewManualObservationImport, type ManualObservationInput } from "@/metrics/manual-import";
import type { MetricSeriesRepository, ResolveSeriesRequest } from "@/metrics/observation-repository";

class InMemoryMetricRepository implements MetricSeriesRepository {
  constructor(private readonly rows: ManualObservationInput[]) {}

  async resolveSeries(request: ResolveSeriesRequest): Promise<MetricSeries> {
    const rows = this.rows
      .filter((row) => row.subjectId === request.subjectId && row.metricKey === request.metricKey && row.asOf <= request.asOf)
      .sort((first, second) => first.asOf.localeCompare(second.asOf));
    const latest = rows.at(-1);
    return {
      currentValue: latest ? Number(latest.value) : null,
      history: rows.map((row) => ({ value: Number(row.value), asOf: row.asOf, availableAt: row.availableAt })),
      source: latest ? "manual" : "UNAVAILABLE",
      asOf: latest?.asOf ?? request.asOf,
      availableAt: latest?.availableAt,
    };
  }
}

function dateAfter(start: string, offset: number): string {
  const date = new Date(`${start}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function observation(subjectId: ScorableAssetBucket, metricKey: CanonicalMetricKey, value: number, asOf: string) {
  return { subjectId, metricKey, value, asOf };
}

describe("Manual → Observation → Input Builder → Score", () => {
  it("用手工黄金历史构建派生趋势并生成低可信度评分快照结果", async () => {
    const rows: Array<Record<string, unknown>> = [];
    for (let index = 0; index < 270; index += 1) {
      rows.push(observation("GOLD", "PRICE_CLOSE", 100 + index * 0.2, dateAfter("2024-01-01", index)));
    }
    for (let year = 2020; year <= 2025; year += 1) {
      const asOf = `${year}-09-01`;
      rows.push(observation("GOLD", "REAL_YIELD_10Y", 3 - (year - 2020) * 0.3, asOf));
      rows.push(observation("GOLD", "DOLLAR_INDEX", 110 - (year - 2020) * 2, asOf));
      rows.push(observation("GOLD", "GOLD_ETF_FLOW_3M", year - 2020, asOf));
    }
    rows.push(observation("GOLD", "CENTRAL_BANK_DEMAND_SCORE", 75, "2025-09-01"));

    const preview = previewManualObservationImport("json", JSON.stringify(rows));
    expect(preview.errors).toEqual([]);

    const asOf = preview.summary[0].latestAsOf;
    const input = await new ScoreInputBuilder(new InMemoryMetricRepository(preview.rows)).build("GOLD", asOf);
    expect(input.trend.ma200.value).toBeTypeOf("number");
    expect(input.trend.momentum6m.currentValue).toBeTypeOf("number");

    const result = calculateAssetScore(input);
    expect(result.opportunityScore).toBeTypeOf("number");
    expect(result.confidence).toBe("LOW");
    expect(result.state).toBe("LOW_CONFIDENCE");
    expect(result.allowAdd).toBe(false);
    expect(Object.keys(result.components)).toContain("cheapness.distanceFromMa200");
  });
});
