import { describe, expect, it } from "vitest";
import { assessFundamentalHealth, calculateAssetScore } from "@/domain/scoring";
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
    expect(tooClose.checks[0]).toMatchObject({ status: "MISSING", note: "缺少约一个季度前的对照值" });
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
