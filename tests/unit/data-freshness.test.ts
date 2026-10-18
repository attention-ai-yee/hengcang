import { describe, expect, it } from "vitest";
import { DEFAULT_SCORING_CONFIG, scoreHistoricalMetric } from "@/domain/scoring";
import type { MetricSeries } from "@/domain/scoring";

/**
 * 数据新鲜度降级（v1.5）回归：
 * - 引擎过去只校验 asOf/availableAt 的时点合法性（不晚于评估日），不校验数据"多旧"；
 *   上游停更后旧值仍会以 HIGH/MEDIUM 参与打分。
 * - 新增 history.maxObservationAgeDays=180：指标最新观察距评估日 >180 天时，
 *   只把组件 confidence 降为 LOW（分数/分位不变）；180 天整仍视为新鲜。
 * - 新鲜度锚点取 asOf 与 availableAt 的较晚者：财务报告期早于公告日，
 *   若只看 asOf 会误伤正常的季度披露（如 Q3 报告在次年 4 月仍是有效最新值）。
 */
const EVAL_DATE = "2026-08-21";
const DAY_MS = 24 * 60 * 60 * 1000;

function shiftDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * 构造 5 年干净 VALID 序列（值固定为 10..20，确保 percentile/score 与日期无关），
 * 最新观察日为 latestAsOf；availableAt 可单独指定（模拟报告期 vs 公告日）。
 */
function seriesEndingAt(latestAsOf: string, options: { availableAt?: string } = {}): MetricSeries {
  const history = Array.from({ length: 6 }, (_, index) => {
    const asOf = shiftDays(latestAsOf, -(5 - index) * 365);
    return { value: 10 + index * 2, asOf, availableAt: `${asOf}T18:00:00+08:00`, quality: "VALID" as const };
  });
  return {
    currentValue: history[history.length - 1].value,
    history,
    source: "tushare-index-aggregate",
    asOf: latestAsOf,
    availableAt: options.availableAt ?? `${latestAsOf}T18:00:00+08:00`,
    quality: "VALID",
    coverage: 1,
  };
}

function confidenceOf(series: MetricSeries): "HIGH" | "MEDIUM" | "LOW" {
  return scoreHistoricalMetric(series, 1, "HIGHER_IS_BETTER", EVAL_DATE).confidence;
}

describe("数据新鲜度：陈旧序列降级（maxObservationAgeDays=180）", () => {
  it("默认配置包含 history.maxObservationAgeDays=180", () => {
    expect(DEFAULT_SCORING_CONFIG.history.maxObservationAgeDays).toBe(180);
  });

  it("最新观察就在评估日：保持 HIGH（不误伤新鲜数据）", () => {
    expect(confidenceOf(seriesEndingAt(EVAL_DATE))).toBe("HIGH");
  });

  it("阈值边界 180 天整仍为新鲜（LOW 只在严格超过阈值时触发）", () => {
    const boundary = shiftDays(EVAL_DATE, -180);
    expect(confidenceOf(seriesEndingAt(boundary))).toBe("HIGH");
  });

  it("181 天超过阈值：组件可信度降为 LOW（历史仍满 5 年，证明降级来自新鲜度而非年限）", () => {
    const overThreshold = shiftDays(EVAL_DATE, -181);
    expect(confidenceOf(seriesEndingAt(overThreshold))).toBe("LOW");
  });

  it("长期停更（如 400 天未更新）：LOW", () => {
    expect(confidenceOf(seriesEndingAt(shiftDays(EVAL_DATE, -400)))).toBe("LOW");
  });

  it("季度数据不误伤：报告期 asOf 较旧但公告日 availableAt 新鲜时仍按 availableAt 判定", () => {
    const reportPeriod = shiftDays(EVAL_DATE, -300);
    const announcedAt = shiftDays(EVAL_DATE, -30);
    expect(confidenceOf(seriesEndingAt(reportPeriod, { availableAt: `${announcedAt}T08:00:00+08:00` }))).toBe("HIGH");
  });

  it("availableAt 也陈旧时仍降级；缺少 availableAt 时退回 asOf 判定", () => {
    const stale = shiftDays(EVAL_DATE, -400);
    expect(confidenceOf(seriesEndingAt(stale, { availableAt: `${stale}T08:00:00+08:00` }))).toBe("LOW");
    const withoutAvailableAt = { ...seriesEndingAt(stale) };
    delete withoutAvailableAt.availableAt;
    expect(confidenceOf(withoutAvailableAt)).toBe("LOW");
  });

  it("只降可信度、不改分数：陈旧与新鲜序列的 percentile / score 完全一致", () => {
    const fresh = scoreHistoricalMetric(seriesEndingAt(EVAL_DATE), 1, "HIGHER_IS_BETTER", EVAL_DATE);
    const stale = scoreHistoricalMetric(seriesEndingAt(shiftDays(EVAL_DATE, -400)), 1, "HIGHER_IS_BETTER", EVAL_DATE);
    expect(fresh.confidence).toBe("HIGH");
    expect(stale.confidence).toBe("LOW");
    expect(stale.percentile).toBe(fresh.percentile);
    expect(stale.score).toBe(fresh.score);
    // 组件保留原始 asOf，降级可解释
    expect(stale.asOf).toBe(shiftDays(EVAL_DATE, -400));
  });
});
