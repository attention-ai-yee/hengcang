import { describe, expect, it } from "vitest";
import { rollingPercentile, scoreHistoricalMetric, scoringHistory } from "@/domain/scoring/percentile";
import { deriveRatioSeries } from "@/domain/scoring/series-transforms";
import type { HistoricalObservation, MetricSeries } from "@/domain/scoring/types";

/**
 * 2026-10-31 计算复查：历史分位的窗口、取样和定义。
 * 估值类序列入库频率不一（全量回填是月末快照，之后每天刷新都加一点），全部照算会让最近的点占多数。
 */
const EVAL = "2026-10-30";

function point(asOf: string, value: number): HistoricalObservation {
  return { value, asOf, availableAt: `${asOf}T18:00:00+08:00`, quality: "VALID" };
}

function seriesOf(history: HistoricalObservation[]): MetricSeries {
  const latest = history.at(-1)!;
  return { currentValue: latest.value, history, source: "tushare", asOf: latest.asOf, availableAt: latest.availableAt, quality: "VALID", coverage: 1 };
}

/** 2021-11 到 2026-09 每月最后一个工作日附近一点，值在 10–20 之间来回 */
function monthEndBackfill(): HistoricalObservation[] {
  return Array.from({ length: 59 }, (_, index) => {
    const month = new Date(Date.UTC(2021, 10 + index, 28)).toISOString().slice(0, 10);
    return point(month, 15 + 5 * Math.sin(index / 4));
  });
}

describe("估值类历史按月取样", () => {
  it("月末快照后面接上每天的点，分位与只有月末快照时相同（原来会被最近的日频点带偏）", () => {
    const monthly = [...monthEndBackfill(), point(EVAL, 12)];
    // 同样的月末快照，再加 2025-11 以来每月 1–24 日每个工作日一点（每天刷新一年的样子），值都在当前值附近
    const daily: HistoricalObservation[] = [];
    for (let ms = Date.parse("2025-11-03T00:00:00Z"); ms < Date.parse(`${EVAL}T00:00:00Z`); ms += 86_400_000) {
      const day = new Date(ms);
      if (day.getUTCDay() === 0 || day.getUTCDay() === 6 || day.getUTCDate() > 24) continue;
      daily.push(point(day.toISOString().slice(0, 10), 11 + (day.getUTCDate() % 3)));
    }
    const mixed = [...monthEndBackfill(), ...daily, point(EVAL, 12)].sort((a, b) => a.asOf.localeCompare(b.asOf));
    expect(mixed.length).toBeGreaterThan(250);
    expect(scoringHistory(seriesOf(mixed), EVAL, "MONTH_END")).toHaveLength(60);
    const expected = scoreHistoricalMetric(seriesOf(monthly), 1, "LOWER_IS_BETTER", EVAL);
    expect(scoreHistoricalMetric(seriesOf(mixed), 1, "LOWER_IS_BETTER", EVAL)).toMatchObject({ percentile: expected.percentile, score: expected.score });
    // 不按月取样时，近一年的两百来个日频点占了大多数，分位被拉偏
    expect(scoreHistoricalMetric(seriesOf(mixed), 1, "LOWER_IS_BETTER", EVAL, "ALL").percentile).not.toBe(expected.percentile);
  });

  it("行情派生特征（ALL）每个交易日都算", () => {
    const history = [point("2026-10-28", 1), point("2026-10-29", 2), point(EVAL, 3)];
    expect(scoringHistory(seriesOf(history), EVAL, "ALL")).toHaveLength(3);
    expect(scoringHistory(seriesOf(history), EVAL, "MONTH_END")).toHaveLength(1);
  });

  it("只看评估日前 5 年（不含正好 5 年前那天）", () => {
    const history = [point("2021-10-29", 1), point("2021-10-30", 2), point("2021-11-01", 3), point(EVAL, 4)];
    expect(scoringHistory(seriesOf(history), EVAL, "ALL").map((entry) => entry.asOf)).toEqual(["2021-11-01", EVAL]);
  });
});

describe("中位秩分位", () => {
  it("两个方向对称：历史最低与最高分别接近 0 和 100", () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(rollingPercentile(1, values)).toBeCloseTo(0.05, 10);
    expect(rollingPercentile(10, values)).toBeCloseTo(0.95, 10);
    expect(rollingPercentile(5, values)).toBeCloseTo(0.45, 10);
    // 全部相等时没有信息，取中间
    expect(rollingPercentile(3, [3, 3, 3, 3])).toBe(0.5);
  });

  it("「越低越好」在历史最便宜时得高分、最贵时得低分，且对称", () => {
    const history = Array.from({ length: 20 }, (_, index) => point(new Date(Date.UTC(2025, index, 15)).toISOString().slice(0, 10), 10 + index));
    const cheapest = seriesOf([...history.slice(1), point(EVAL, 5)]);
    const dearest = seriesOf([...history.slice(1), point(EVAL, 50)]);
    const cheap = scoreHistoricalMetric(cheapest, 1, "LOWER_IS_BETTER", EVAL).score!;
    const dear = scoreHistoricalMetric(dearest, 1, "LOWER_IS_BETTER", EVAL).score!;
    expect(cheap).toBeGreaterThan(95);
    expect(dear).toBeLessThan(5);
    expect(cheap + dear).toBeCloseTo(100, 5);
  });
});

describe("PEG：PE 与增速按日期对齐", () => {
  it("每个 PE 点配日期不晚于它的最新增速（财报汇总只在公告日附近有点）", () => {
    const pe = seriesOf([point("2026-08-03", 30), point("2026-08-04", 31), point("2026-09-01", 33), point(EVAL, 36)]);
    const growth = seriesOf([point("2026-07-31", 10), point("2026-08-28", 12), point("2026-10-25", 18)]);
    const peg = deriveRatioSeries(pe, growth, { featureName: "PEG_TTM" });
    expect(peg.history.map((entry) => [entry.asOf, entry.value])).toEqual([
      ["2026-08-03", 3], ["2026-08-04", 3.1], ["2026-09-01", 33 / 12], [EVAL, 2],
    ]);
    expect(peg.currentValue).toBe(2);
    // 派生点的可见时间取两边较晚者
    expect(peg.history[2].availableAt).toBe("2026-09-01T18:00:00+08:00");
  });

  it("增速比 PE 旧 200 天以上就不配对，免得停更的财报静默顶上", () => {
    const pe = seriesOf([point("2026-01-05", 30), point(EVAL, 36)]);
    const growth = seriesOf([point("2025-12-20", 10)]);
    const peg = deriveRatioSeries(pe, growth, { featureName: "PEG_TTM" });
    expect(peg.history.map((entry) => entry.asOf)).toEqual(["2026-01-05"]);
  });
});
