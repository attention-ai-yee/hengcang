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

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * 最新观察距评估日的天数（数据新鲜度闸门，v1.5）。
 *
 * 取 `asOf` 与 `availableAt` 中较晚的日期作为"信息发生/可见"时间：财务报告期
 * (`asOf`=报告期末) 通常早于公告日 (`availableAt`)，用较晚者才不会把正常的
 * 季度披露滞后误判为陈旧（180 天阈值对财务/估值/价格统一适用）。
 * 解析失败或未来日期返回 null（不触发降级）。
 */
function observationAgeDays(metric: MetricSeries, evaluationDate: string): number | null {
  const observedDate = [metric.asOf, metric.availableAt ?? metric.asOf]
    .map((value) => value.slice(0, 10))
    .sort()
    .at(-1) ?? "";
  const observedMs = Date.parse(`${observedDate}T00:00:00Z`);
  const evaluationMs = Date.parse(`${evaluationDate.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(observedMs) || !Number.isFinite(evaluationMs)) return null;
  return Math.floor((evaluationMs - observedMs) / MS_PER_DAY);
}

/**
 * 陈旧数据只降可信度、不改分数：指标最新观察距评估日超过
 * `history.maxObservationAgeDays` 时返回 true，组件 confidence 降为 LOW。
 * 组件结果仍保留原始 asOf，可解释为什么被降级。
 */
function isStaleObservation(metric: MetricSeries, evaluationDate: string): boolean {
  const ageDays = observationAgeDays(metric, evaluationDate);
  return ageDays !== null && ageDays > DEFAULT_SCORING_CONFIG.history.maxObservationAgeDays;
}

function historyConfidence(metric: MetricSeries, evaluationDate: string): Confidence {
  if (metric.source.toUpperCase().includes("MANUAL")) return "LOW";
  const history = availableHistory(metric, evaluationDate);
  if (history.length === 0) return "LOW";
  // 数据新鲜度闸门：引擎过去只校验 asOf/availableAt 的时点合法性、不校验"多旧"。
  // 上游停更时旧值会照常参与打分；这里把组件 confidence 降为 LOW（不改分数），
  // 由下游 combineComponents/applyRiskRules 封顶状态、避免基于陈旧数据输出增配。
  if (isStaleObservation(metric, evaluationDate)) return "LOW";
  const earliest = history.reduce((min, point) => (point.asOf < min ? point.asOf : min), history[0].asOf);
  const years = fullYearsBetween(earliest, evaluationDate);
  if (years < DEFAULT_SCORING_CONFIG.history.mediumYears) return "LOW";
  // 规格 v1.1 §42 伪码：PARTIAL / manual 均指被评序列自身的 quality。
  // 不再因历史早期行（聚合成分覆盖不足时期的 PARTIAL）永久封顶——
  // 否则「history >= 3y + VALID -> HIGH eligible」对聚合基本面不可达。
  const containsPartial = metric.quality === "PARTIAL";
  const sourceUpper = metric.source.toUpperCase();
  if (containsPartial) return "MEDIUM";
  if (!sourceUpper.includes("DERIVED")) {
    // v1.1：VALID 且 >= 3 个完整日历年 -> HIGH 候选（Code Review M11 定权威版本）
    return years >= DEFAULT_SCORING_CONFIG.history.highYears ? "HIGH" : "MEDIUM";
  }
  // 含 DERIVED 的来源默认封顶 MEDIUM（§27：无论历史多长都不能升 HIGH）。
  // 唯一豁免：纯价格技术特征 DERIVED:<特征>:<干净主源>（如 DERIVED:MA60:tushare）
  // 继承主行情的年限可信度——v1.1 示例明确趋势支柱可为 HIGH。
  // 大小写不敏感；基础源本身是派生代理（DERIVED:X:tushare-derived）不豁免。
  const featureMatch = /^DERIVED:[A-Z0-9_]+:([^:]+)$/.exec(sourceUpper);
  const inheritsPrimary = featureMatch !== null && !featureMatch[1].includes("DERIVED");
  if (!inheritsPrimary) return "MEDIUM";
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