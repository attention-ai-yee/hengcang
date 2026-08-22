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

function historyConfidence(metric: MetricSeries, evaluationDate: string): Confidence {
  if (metric.source.toUpperCase().includes("MANUAL")) return "LOW";
  const history = availableHistory(metric, evaluationDate);
  if (history.length === 0) return "LOW";
  const earliest = history.reduce((min, point) => (point.asOf < min ? point.asOf : min), history[0].asOf);
  const years = (Date.parse(evaluationDate) - Date.parse(earliest)) / (365.25 * 24 * 60 * 60 * 1000);
  return years < DEFAULT_SCORING_CONFIG.history.minimumYearsForMediumConfidence ? "LOW" : "HIGH";
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
  };
}
