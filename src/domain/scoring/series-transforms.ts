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
    // 确定性数学变换（TRANSFORMED）：沿用 DERIVED:<特征>:<主数据源> 命名，
    // 使其继承主数据源置信度；代理类（PROXY，如 TTM 冒充 Forward）仍按普通派生封顶 MEDIUM。
    source: "DERIVED:CHANGE_" + lookbackDays + "D:" + input.source,
    asOf: input.asOf,
    availableAt: currentAvailableAt,
    quality: currentQuality,
    coverage: input.coverage,
  };
}

/**
 * 派生「比值」序列（如 PEG_TTM = PE_TTM / 已实现盈利增长%）。
 * 点位按双方 asOf 对齐；分母做下限保护（默认 +1 个百分点）：负增长因此得到
 * 极大的比值（最差分位），符合「高估值遇上盈利萎缩」的经济语义且避免符号翻转。
 * availableAt = max(分子, 分母)、quality = worse —— 无前视。
 */
export function deriveRatioSeries(
  numerator: MetricSeries,
  denominator: MetricSeries,
  options?: { minDenominator?: number; featureName?: string },
): MetricSeries {
  const minDenominator = options?.minDenominator ?? 1;
  const featureName = options?.featureName ?? "RATIO";
  const denByDate = new Map(denominator.history.map((point) => [point.asOf, point]));
  const history: HistoricalObservation[] = [];
  for (const point of numerator.history) {
    const den = denByDate.get(point.asOf);
    if (!den) continue;
    const safeDen = Math.max(den.value, minDenominator);
    if (!Number.isFinite(safeDen) || safeDen <= 0) continue;
    history.push({
      value: point.value / safeDen,
      asOf: point.asOf,
      availableAt: maxAvailableAt(point.availableAt ?? point.asOf + "T00:00:00Z", den.availableAt ?? den.asOf + "T00:00:00Z") ?? point.asOf + "T00:00:00Z",
      quality: worseQuality(point.quality, den.quality),
    });
  }
  let currentValue: number | null = null;
  if (numerator.currentValue !== null && Number.isFinite(numerator.currentValue) && denominator.currentValue !== null && Number.isFinite(denominator.currentValue)) {
    currentValue = numerator.currentValue / Math.max(denominator.currentValue, minDenominator);
  }
  const latest = history.at(-1);
  return {
    currentValue,
    history,
    source: "DERIVED:" + featureName + ":" + denominator.source,
    asOf: latest?.asOf ?? numerator.asOf,
    availableAt: latest?.availableAt ?? numerator.availableAt,
    quality: worseQuality(numerator.quality, denominator.quality),
    coverage:
      numerator.coverage !== undefined && denominator.coverage !== undefined
        ? Math.min(numerator.coverage, denominator.coverage)
        : numerator.coverage ?? denominator.coverage,
  };
}
