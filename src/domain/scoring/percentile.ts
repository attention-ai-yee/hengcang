import type { Confidence } from "../types";
import { DEFAULT_SCORING_CONFIG } from "./config";
import type { MetricSeries, ScoreComponentResult } from "./types";

export type ScoreDirection = "HIGHER_IS_BETTER" | "LOWER_IS_BETTER";

export function clampScore(value: number): number {
  return Math.min(100, Math.max(0, value));
}

export function round1(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

export function rollingPercentile(current: number, historyUpToToday: number[]): number {
  const valid = historyUpToToday.filter(Number.isFinite);
  if (valid.length === 0) return Number.NaN;
  return valid.filter((value) => value <= current).length / valid.length;
}

export function availableHistory(metric: MetricSeries, evaluationDate: string) {
  return metric.history.filter(
    (point) =>
      Number.isFinite(point.value) &&
      point.asOf.slice(0, 10) <= evaluationDate &&
      point.availableAt.slice(0, 10) <= evaluationDate,
  );
}

/**
 * 计算两个 YYYY-MM-DD 之间跨越的完整日历年数。
 * 不能用 Δms / 365.25 天：含一个闰日的"恰好 N 个日历年"（如规格回填窗口
 * 2021-08-23 → 2026-08-23 = 1826 天）会被算成 4.9993 年，导致干净 5 年
 * 历史永远拿不到 HIGH 置信度，进而把状态系统性封顶在 LIGHT_ADD_ALLOWED。
 */
export function fullYearsBetween(from: string, to: string): number {
  const [fromYear, fromMonth, fromDay] = from.slice(0, 10).split("-").map(Number);
  const [toYear, toMonth, toDay] = to.slice(0, 10).split("-").map(Number);
  if ([fromYear, fromMonth, fromDay, toYear, toMonth, toDay].some((part) => !Number.isFinite(part))) return 0;
  let years = toYear - fromYear;
  if (toMonth < fromMonth || (toMonth === fromMonth && toDay < fromDay)) years -= 1;
  return years;
}

function historyConfidence(metric: MetricSeries, evaluationDate: string): Confidence {
  if (metric.source.toUpperCase().includes("MANUAL")) return "LOW";
  const history = availableHistory(metric, evaluationDate);
  if (history.length === 0) return "LOW";
  const earliest = history.reduce((min, point) => (point.asOf < min ? point.asOf : min), history[0].asOf);
  const years = fullYearsBetween(earliest, evaluationDate);
  if (years < DEFAULT_SCORING_CONFIG.history.mediumYears) return "LOW";
  const containsPartial = metric.quality === "PARTIAL" || history.some((point) => point.quality === "PARTIAL");
  if (containsPartial || metric.source.toUpperCase().includes("DERIVED")) return "MEDIUM";
  // v1.1 §§：VALID 且 ≥ 3 个完整日历年 → HIGH 候选（Code Review M11 定权威版本）
  return years >= DEFAULT_SCORING_CONFIG.history.highYears ? "HIGH" : "MEDIUM";
}

export function scoreHistoricalMetric(
  metric: MetricSeries,
  weight: number,
  direction: ScoreDirection,
  evaluationDate: string,
): ScoreComponentResult {
  const currentIsAvailable =
    metric.currentValue !== null &&
    Number.isFinite(metric.currentValue) &&
    metric.asOf.slice(0, 10) <= evaluationDate &&
    (metric.availableAt ?? metric.asOf).slice(0, 10) <= evaluationDate;
  const history = availableHistory(metric, evaluationDate);

  if (!currentIsAvailable || history.length === 0) {
    return {
      rawValue: metric.currentValue,
      percentile: null,
      score: null,
      weight,
      source: metric.source,
      asOf: metric.asOf,
      confidence: "LOW",
      quality: metric.quality,
      coverage: metric.coverage,
    };
  }

  const percentile = rollingPercentile(metric.currentValue as number, history.map((point) => point.value));
  const score = direction === "HIGHER_IS_BETTER" ? percentile * 100 : (1 - percentile) * 100;
  return {
    rawValue: metric.currentValue,
    percentile: round1(percentile * 100),
    score: round1(clampScore(score)),
    weight,
    source: metric.source,
    asOf: metric.asOf,
    confidence: historyConfidence(metric, evaluationDate),
    quality: metric.quality,
    coverage: metric.coverage,
  };
}