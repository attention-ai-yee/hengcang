import type { HistoricalObservation, MetricSeries } from "./types";

/** 取两档质量中更差的一档（VALID > PARTIAL）；缺省视为未声明。 */
function worseQuality(
  first?: "VALID" | "PARTIAL",
  second?: "VALID" | "PARTIAL",
): "VALID" | "PARTIAL" | undefined {
  if (!first) return second;
  if (!second) return first;
  return first === "VALID" ? second : first;
}

/** 可用时间取较晚者；优先按绝对时间比较，解析失败退回字典序。 */
function maxAvailableAt(first?: string, second?: string): string | undefined {
  if (!first) return second;
  if (!second) return first;
  const a = Date.parse(first);
  const b = Date.parse(second);
  if (Number.isFinite(a) && Number.isFinite(b)) return a >= b ? first : second;
  return first >= second ? first : second;
}

function shiftDate(date: string, days: number): string {
  const ms = Date.parse(date + "T00:00:00Z") - days * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * 派生「N 天变化」序列（黄金 v1.2 宏观支持度的边际方向成分，规格 §10）。
 *
 * 对历史每个点 T：基准点取 asOf <= (T.asOf - lookbackDays) 的最近一条；
 * 禁止使用未来点插值（无前视）。派生行：
 * - value = 当前值 − 基准值
 * - availableAt = max(当前点, 基准点) —— 派生行不早于其任何输入可见
 * - quality = worse(当前点, 基准点)
 */
export function deriveChangeSeries(input: MetricSeries, lookbackDays: number): MetricSeries {
  const sorted = [...input.history].sort((a, b) => a.asOf.localeCompare(b.asOf));
  const history: HistoricalObservation[] = [];
  let cursor = 0;
  for (const point of sorted) {
    const targetDate = shiftDate(point.asOf, lookbackDays);
    while (cursor < sorted.length && sorted[cursor].asOf <= targetDate) cursor += 1;
    if (cursor === 0) continue; // 没有任何可用基准点
    const baseline = sorted[cursor - 1];
    history.push({
      value: point.value - baseline.value,
      asOf: point.asOf,
      // HistoricalObservation.availableAt 为必填：缺省时退回观察日零点
      availableAt:
        maxAvailableAt(point.availableAt ?? point.asOf + "T00:00:00Z", baseline.availableAt ?? baseline.asOf + "T00:00:00Z")
          ?? point.asOf + "T00:00:00Z",
      quality: worseQuality(point.quality, baseline.quality),
    });
  }

  let currentValue: number | null = null;
  let currentAvailableAt = input.availableAt;
  let currentQuality = input.quality;
  if (input.currentValue !== null && Number.isFinite(input.currentValue)) {
    const targetDate = shiftDate(input.asOf, lookbackDays);
    let baseline: HistoricalObservation | undefined;
    for (const point of sorted) {
      if (point.asOf <= targetDate) baseline = point;
      else break;
    }
    if (baseline) {
      currentValue = input.currentValue - baseline.value;
      currentAvailableAt = maxAvailableAt(currentAvailableAt ?? input.asOf + "T00:00:00Z", baseline.availableAt);
      currentQuality = worseQuality(currentQuality, baseline.quality);
    }
  }

  return {
    currentValue,
    history,
    source: input.source + "-derived-change-" + lookbackDays + "d",
    asOf: input.asOf,
    availableAt: currentAvailableAt,
    quality: currentQuality,
    coverage: input.coverage,
  };
}
