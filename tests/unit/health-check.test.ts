import { describe, expect, it } from "vitest";
import { assessFundamentalHealth, calculateAssetScore, formatHealthPoint, reportPeriodLabel } from "@/domain/scoring";
import type { AssetModelInput, MetricSeries, TechGrowthInput, ValueDividendInput } from "@/domain/scoring/types";

/** 基本面体检 v2（docs/hengcang_v2_allocation_fundamentals_thesis.md §3）。 */
const EVAL_DATE = "2026-10-25";

function quarterly(points: Array<[string, number]>): MetricSeries {
  const history = points.map(([asOf, value]) => ({ value, asOf, availableAt: `${asOf}T18:00:00+08:00`, quality: "VALID" as const }));
  const latest = history.at(-1);
  return {
    currentValue: latest?.value ?? null,
    history,
    source: "tushare-index-aggregate",
    asOf: latest?.asOf ?? EVAL_DATE,
    availableAt: latest?.availableAt,
    quality: "VALID",
    coverage: 1,
  };
}

const EMPTY: MetricSeries = { currentValue: null, history: [], source: "UNAVAILABLE", asOf: EVAL_DATE };
const trend: AssetModelInput["trend"] = {
  price: { value: 120, source: "tushare", asOf: EVAL_DATE },
  ma20: { value: 110, source: "tushare", asOf: EVAL_DATE },
  ma60: { value: 100, source: "tushare", asOf: EVAL_DATE },
  ma200: { value: 80, source: "tushare", asOf: EVAL_DATE },
  momentum6m: EMPTY,
};

function tech(earningsGrowth: MetricSeries, revenueGrowth: MetricSeries): TechGrowthInput {
  return { bucket: "TECH_GROWTH", asOf: EVAL_DATE, trend, pe: EMPTY, ps: EMPTY, earningsGrowth, revenueGrowth };
}

function value(overrides: Partial<ValueDividendInput>): ValueDividendInput {
  return {
    bucket: "VALUE_DIVIDEND", asOf: EVAL_DATE, trend, pe: EMPTY, pb: EMPTY, dividendYield: EMPTY, roe: EMPTY,
    earningsGrowth: quarterly([["2026-07-20", 5], ["2026-10-20", 3]]),
    dividendStability: { score: 85, source: "tushare-index-aggregate", asOf: "2026-10-20", quality: "VALID" },
    ...overrides,
  };
}

describe("assessFundamentalHealth", () => {
  it("盈利、营收都没有连续两期为负 → HEALTHY", () => {
    const health = assessFundamentalHealth(tech(quarterly([["2026-07-15", -5], ["2026-10-20", 8]]), quarterly([["2026-07-15", 2], ["2026-10-20", 3]])));
    expect(health.status).toBe("HEALTHY");
    expect(health.checks.map((check) => check.status)).toEqual(["OK", "OK"]);
  });

  it("盈利同比最近两期（相隔约一个季度）都为负 → DETERIORATING，原因写明两期数值", () => {
    const health = assessFundamentalHealth(tech(quarterly([["2026-07-15", -8], ["2026-10-20", -12]]), quarterly([["2026-07-15", 2], ["2026-10-20", 1]])));
    expect(health.status).toBe("DETERIORATING");
    const check = health.checks.find((item) => item.key === "earningsGrowth");
    expect(check?.latest).toEqual({ value: -12, asOf: "2026-10-20" });
    expect(check?.previous).toEqual({ value: -8, asOf: "2026-07-15" });
    expect(health.reasons[0]).toContain("盈利同比");
    expect(health.reasons[0]).toContain("-12 @ 2026-10-20");
  });

  it("科技桶营收同比连续两期为负也算恶化", () => {
    const health = assessFundamentalHealth(tech(quarterly([["2026-07-15", 4], ["2026-10-20", 6]]), quarterly([["2026-07-15", -3], ["2026-10-20", -1]])));
    expect(health.status).toBe("DETERIORATING");
    expect(health.checks.find((item) => item.key === "revenueGrowth")?.status).toBe("BREACH");
  });

  it("对照值取「约一个季度前」：相隔不足 80 天的点不算上一期，超过 200 天视为缺失", () => {
    // 09-30 距 10-20 只有 20 天，不能当上一期；只剩 10-20 一个点 → 缺少对照值
    const tooClose = assessFundamentalHealth(tech(quarterly([["2026-09-30", -5], ["2026-10-20", -6]]), EMPTY));
    expect(tooClose.checks[0]).toMatchObject({ status: "MISSING", note: "缺少上一期（约一个季度前）的对照值" });
    // 2026-01-05 距 10-20 超过 200 天
    const tooFar = assessFundamentalHealth(tech(quarterly([["2026-01-05", -5], ["2026-10-20", -6]]), EMPTY));
    expect(tooFar.checks[0].status).toBe("MISSING");
    expect(tooFar.status).toBe("UNKNOWN");
  });

  it("最新数据超过 180 天未更新 → MISSING；全部缺失 → UNKNOWN", () => {
    const stale = assessFundamentalHealth(tech(quarterly([["2025-11-15", -8], ["2026-02-20", -12]]), EMPTY));
    expect(stale.checks[0]).toMatchObject({ status: "MISSING", note: "最新数据超过 180 天未更新" });
    expect(stale.status).toBe("UNKNOWN");
    expect(stale.reasons[0]).toContain("数据不足");
  });

  it("部分检查缺失、其余正常 → HEALTHY（有数据的项没有恶化）", () => {
    expect(assessFundamentalHealth(tech(quarterly([["2026-07-15", 3], ["2026-10-20", 4]]), EMPTY)).status).toBe("HEALTHY");
  });

  it("红利桶：分红稳定性低于 60 → DETERIORATING", () => {
    const health = assessFundamentalHealth(value({ dividendStability: { score: 45, source: "tushare-index-aggregate", asOf: "2026-10-20", quality: "VALID" } }));
    expect(health.status).toBe("DETERIORATING");
    expect(health.checks.find((item) => item.key === "dividendStability")?.status).toBe("BREACH");
  });

  it("红利桶：手工基本面覆盖分优先（基金拿不到成分财报时的兜底），低于 35 视为恶化", () => {
    const weak = assessFundamentalHealth(value({ fundamentalOverride: { score: 30, source: "manual", asOf: "2026-10-20" } }));
    expect(weak.status).toBe("DETERIORATING");
    expect(weak.checks.map((check) => check.key)).toEqual(["fundamentalOverride"]);
    expect(assessFundamentalHealth(value({ fundamentalOverride: { score: 60, source: "manual", asOf: "2026-10-20" } })).status).toBe("HEALTHY");
  });

  it("宽基：指数盈利同比连续两期为负 → DETERIORATING", () => {
    const health = assessFundamentalHealth({
      bucket: "BROAD_EQUITY", asOf: EVAL_DATE, trend, pe: EMPTY, pb: EMPTY,
      indexEarningsGrowth: quarterly([["2026-07-15", -1], ["2026-10-20", -2]]),
    });
    expect(health.status).toBe("DETERIORATING");
  });

  it("黄金不适用体检（宏观支持度只展示）", () => {
    const health = assessFundamentalHealth({
      bucket: "GOLD", asOf: EVAL_DATE, trend, pricePosition: EMPTY, distanceFromMa200: EMPTY, momentum3m: EMPTY,
      realYield: quarterly([["2026-07-15", 2.5], ["2026-10-20", 2.6]]), dollarIndex: EMPTY,
    });
    expect(health).toEqual({ status: "NOT_APPLICABLE", checks: [], reasons: [] });
  });
});

describe("calculateAssetScore 接入体检", () => {
  it("体检不通过 → REASSESS_THESIS（即时），配置吸引力分只由便宜程度与趋势合成", () => {
    const result = calculateAssetScore(tech(quarterly([["2026-07-15", -8], ["2026-10-20", -12]]), quarterly([["2026-07-15", 2], ["2026-10-20", 1]])));
    expect(result.fundamentalHealth.status).toBe("DETERIORATING");
    expect(result.candidateState).toBe("REASSESS_THESIS");
    expect(result.allowAdd).toBe(false);
    expect(Object.keys(result.components).some((key) => key.startsWith("fundamental."))).toBe(true); // 基本面子分仍作展示参考
  });
});

describe("上一期按报告期找（复查发现：三季报季拿三季报去比一季报）", () => {
  function periodic(points: Array<[string, number, string]>): MetricSeries {
    const history = points.map(([asOf, value, reportPeriod]) => ({ value, asOf, availableAt: `${asOf}T18:00:00+08:00`, quality: "VALID" as const, reportPeriod }));
    const latest = history.at(-1);
    return { currentValue: latest?.value ?? null, history, source: "tushare-index-aggregate", asOf: latest?.asOf ?? EVAL_DATE, availableAt: latest?.availableAt, quality: "VALID", coverage: 1 };
  }
  // 公告日序列：一季报主导到 8 月中旬，半年报 8 月下旬起主导，三季报 10 月下旬起主导
  const calendar = (q1: number, h1: number, q3: number) => periodic([
    ["2026-05-10", q1, "2026-03-31"],
    ["2026-08-12", q1 + 1, "2026-03-31"],
    ["2026-08-31", h1, "2026-06-30"],
    ["2026-10-10", h1, "2026-06-30"],
    ["2026-10-24", q3, "2026-09-30"],
  ]);

  it("三季报与半年报都为负 → 恶化（按日期间隔会拿到 8/12 的一季报而误判正常）", () => {
    const health = assessFundamentalHealth(tech(calendar(5, -8, -10), quarterly([["2026-07-15", 2], ["2026-10-20", 3]])));
    expect(health.status).toBe("DETERIORATING");
    expect(health.checks.find((item) => item.key === "earningsGrowth")?.previous).toEqual({ value: -8, asOf: "2026-10-10", reportPeriod: "2026-06-30" });
  });

  it("半年报为正、三季报为负 → 只有一期为负，不算恶化（按日期间隔会拿到一季报而误判恶化）", () => {
    const health = assessFundamentalHealth(tech(calendar(-5, 3, -2), quarterly([["2026-07-15", 2], ["2026-10-20", 3]])));
    expect(health.checks.find((item) => item.key === "earningsGrowth")?.status).toBe("OK");
  });

  it("相邻报告期隔得太远（中间缺了一期以上）→ 缺数据，不硬比", () => {
    const series = periodic([["2026-03-20", -5, "2025-09-30"], ["2026-10-24", -10, "2026-09-30"]]);
    const check = assessFundamentalHealth(tech(series, quarterly([["2026-07-15", 2], ["2026-10-20", 3]]))).checks.find((item) => item.key === "earningsGrowth");
    expect(check?.status).toBe("MISSING");
  });

  /** 带占比的点：[asOf, value, 主导报告期, 占比] */
  function shared(points: Array<[string, number, string, number | undefined]>): MetricSeries {
    const series = periodic(points.map(([asOf, value, period]) => [asOf, value, period]));
    return { ...series, history: series.history.map((point, index) => (points[index][3] === undefined ? point : { ...point, reportPeriodShare: points[index][3] })) };
  }
  const revenueOk = quarterly([["2026-07-15", 2], ["2026-10-20", 3]]);

  it("财报季里取上一期最「纯」的点，不取紧挨着最新点、已混进大半新财报的那天（2026-10-30 真实数据复查）", () => {
    const series = shared([
      ["2026-08-31", 26, "2026-06-30", 0.97],
      ["2026-10-09", 26.17, "2026-06-30", 1],
      ["2026-10-23", 18.18, "2026-06-30", 0.52],
      ["2026-10-24", 13.36, "2026-09-30", 0.6],
    ]);
    const check = assessFundamentalHealth(tech(series, revenueOk)).checks.find((item) => item.key === "earningsGrowth");
    expect(check?.previous).toEqual({ value: 26.17, asOf: "2026-10-09", reportPeriod: "2026-06-30" });
  });

  it("半年报为正、三季报为负：混进三季报后转负的那天不算「上一期也为负」", () => {
    // 按旧取法上一期是 10-23 的 −2（半年报只剩 52% 权重），会把一期为负误判成连续两期为负
    const series = shared([
      ["2026-10-09", 3, "2026-06-30", 1],
      ["2026-10-23", -2, "2026-06-30", 0.52],
      ["2026-10-24", -5, "2026-09-30", 0.6],
    ]);
    const health = assessFundamentalHealth(tech(series, revenueOk));
    expect(health.checks.find((item) => item.key === "earningsGrowth")).toMatchObject({ status: "OK", previous: { value: 3, asOf: "2026-10-09" } });
    expect(health.status).toBe("HEALTHY");
  });

  it("占比相差不到 2 个百分点算一样纯，取较新的（权重名单更新）；没有占比的旧点让位给有占比的", () => {
    const previousOf = (series: MetricSeries) => assessFundamentalHealth(tech(series, revenueOk)).checks.find((item) => item.key === "earningsGrowth")?.previous?.asOf;
    expect(previousOf(shared([
      ["2026-09-01", 20, "2026-06-30", undefined],
      ["2026-09-15", 21, "2026-06-30", 1],
      ["2026-10-12", 22, "2026-06-30", 0.99],
      ["2026-10-20", 18, "2026-06-30", 0.6],
      ["2026-10-24", 15, "2026-09-30", 0.7],
    ]))).toBe("2026-10-12");
    expect(previousOf(shared([
      ["2026-09-15", 21, "2026-06-30", 1],
      ["2026-10-12", 22, "2026-06-30", 0.97],
      ["2026-10-20", 18, "2026-06-30", 0.6],
      ["2026-10-24", 15, "2026-09-30", 0.7],
    ]))).toBe("2026-09-15");
  });

  it("明细和原因里标出每个点以哪一期财报为主", () => {
    expect(reportPeriodLabel("2026-06-30")).toBe("2026 半年报");
    expect(reportPeriodLabel("2025-12-31")).toBe("2025 年报");
    expect(formatHealthPoint({ value: -10, asOf: "2026-10-24", reportPeriod: "2026-09-30" })).toBe("-10 @ 2026-10-24（2026 三季报为主）");
    expect(formatHealthPoint({ value: -10, asOf: "2026-10-24" })).toBe("-10 @ 2026-10-24");
    const health = assessFundamentalHealth(tech(calendar(5, -8, -10), revenueOk));
    expect(health.reasons[0]).toContain("-10 @ 2026-10-24（2026 三季报为主），-8 @ 2026-10-10（2026 半年报为主）");
  });

  it("旧数据没有报告期时退回按日期间隔（约一个季度前）", () => {
    const health = assessFundamentalHealth(tech(quarterly([["2026-07-15", -8], ["2026-10-20", -12]]), quarterly([["2026-07-15", 2], ["2026-10-20", 3]])));
    expect(health.status).toBe("DETERIORATING");
  });
});

describe("手工基本面判断只在新鲜时替代自动体检（复查发现）", () => {
  const negativeTwice = quarterly([["2026-07-20", -6], ["2026-10-20", -9]]);

  it("过期（> 180 天）的手工判断不再盖住自动规则发现的恶化", () => {
    const stale = { score: 70, source: "manual", asOf: "2025-12-01", quality: "VALID" as const };
    expect(assessFundamentalHealth(value({ earningsGrowth: negativeTwice, fundamentalOverride: stale })).status).toBe("DETERIORATING");
  });

  it("新鲜的手工判断照旧替代自动体检", () => {
    const fresh = { score: 70, source: "manual", asOf: "2026-10-01", quality: "VALID" as const };
    const health = assessFundamentalHealth(value({ earningsGrowth: negativeTwice, fundamentalOverride: fresh }));
    expect(health.status).toBe("HEALTHY");
    expect(health.checks.map((check) => check.key)).toEqual(["fundamentalOverride"]);
  });
});

describe("增速体检看单季同比（2026-10-31）", () => {
  function periodicSeries(points: Array<[string, number, string]>): MetricSeries {
    const history = points.map(([asOf, value, reportPeriod]) => ({ value, asOf, availableAt: `${asOf}T18:00:00+08:00`, quality: "VALID" as const, reportPeriod }));
    return { currentValue: history.at(-1)!.value, history, source: "tushare-index-aggregate", asOf: history.at(-1)!.asOf, availableAt: history.at(-1)!.availableAt, quality: "VALID", coverage: 1 };
  }
  const broad = (cumulative: MetricSeries, quarter?: MetricSeries): AssetModelInput => ({
    bucket: "BROAD_EQUITY", asOf: EVAL_DATE, trend, pe: EMPTY, pb: EMPTY, indexEarningsGrowth: cumulative, indexEarningsGrowthQuarter: quarter,
  });
  // 累计同比还是正的（半年报 +26%、前三季度 +10%），单季已经连续两个季度为负
  const cumulative = periodicSeries([["2026-08-31", 26, "2026-06-30"], ["2026-10-24", 10, "2026-09-30"]]);
  const quarter = periodicSeries([["2026-08-31", -3, "2026-06-30"], ["2026-10-24", -21, "2026-09-30"]]);

  it("单季连续两个季度为负 → 恶化，即使累计同比还是正的", () => {
    const health = assessFundamentalHealth(broad(cumulative, quarter));
    expect(health.status).toBe("DETERIORATING");
    expect(health.checks[0]).toMatchObject({ label: "指数盈利同比（单季）", latest: { value: -21 }, previous: { value: -3 } });
  });

  it("单季没有上一期（旧库刚升级）→ 退回累计同比，标签注明", () => {
    const onlyLatest = periodicSeries([["2026-10-24", -21, "2026-09-30"]]);
    const health = assessFundamentalHealth(broad(cumulative, onlyLatest));
    expect(health.status).toBe("HEALTHY");
    expect(health.checks[0]).toMatchObject({ label: "指数盈利同比（累计）", latest: { value: 10 }, previous: { value: 26 } });
  });

  it("没有单季数据 → 用累计同比", () => {
    expect(assessFundamentalHealth(broad(cumulative)).checks[0].label).toBe("指数盈利同比（累计）");
  });
});

