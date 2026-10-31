import { describe, expect, it } from "vitest";
import { calculateAssetScore, scoreHistoricalMetric } from "@/domain/scoring";
import { deriveChangeSeries } from "@/domain/scoring/series-transforms";
import type { AssetModelInput, MetricSeries, TrendModelInput } from "@/domain/scoring/types";

const AS_OF = "2026-08-21";

function monthly(values: number[], source: string): MetricSeries {
  const history = values.map((value, i) => {
    const day = `${2023 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}-15`;
    return { value, asOf: day, availableAt: `${day}T18:00:00+08:00`, quality: "VALID" as const };
  });
  return { currentValue: values[values.length - 1], history, source, asOf: AS_OF, quality: "VALID", coverage: 1 };
}

/** 2023-01 到 2026-08 每月一点、加速上升：当前值和最近三个月的变化都是窗口内最高 */
function ascending(source: string): MetricSeries {
  return monthly(Array.from({ length: 44 }, (_, i) => 1 + i * i * 0.002), source);
}

/** 加速下降：当前值是窗口内最低（如 ETF 资金持续流出） */
function descending(source: string): MetricSeries {
  return monthly(Array.from({ length: 44 }, (_, i) => 5 - i * i * 0.002), source);
}

function flat(value: number, source: string): MetricSeries {
  return { currentValue: value, history: [{ value, asOf: "2022-01-10", availableAt: "2022-01-10T18:00:00+08:00", quality: "VALID" }], source, asOf: AS_OF, quality: "VALID", coverage: 1 };
}

const trend: TrendModelInput = {
  price: { value: 983, source: "tushare", asOf: AS_OF },
  ma20: { value: 924, source: "DERIVED:MA20:tushare", asOf: AS_OF },
  ma60: { value: 916, source: "DERIVED:MA60:tushare", asOf: AS_OF },
  ma200: { value: 993, source: "DERIVED:MA200:tushare", asOf: AS_OF },
  momentum6m: flat(0.05, "DERIVED:MOMENTUM_6M:tushare"),
};

function goldInput(): AssetModelInput {
  return {
    bucket: "GOLD",
    asOf: AS_OF,
    trend,
    pricePosition: flat(50, "tushare"),
    distanceFromMa200: flat(-0.01, "DERIVED:DISTANCE_MA200:tushare"),
    momentum3m: flat(-0.02, "DERIVED:MOMENTUM_3M:tushare"),
    realYield: ascending("fred"),
    dollarIndex: ascending("fred"),
    etfFlow: (() => { const s = descending("tushare-gold-etf-proxy"); s.quality = "PARTIAL"; return s; })(),
    centralBankDemand: flat(5, "tushare"),
  };
}

describe("置信度来源分类（TRANSFORMED vs PROXY）与引擎 bucket 接线", () => {
  it("确定性变换沿用 DERIVED:<特征>:<主数据源> 命名并继承 HIGH", () => {
    const derived = deriveChangeSeries(ascending("fred"), 90);
    expect(derived.source).toBe("DERIVED:CHANGE_90D:fred");
    const scored = scoreHistoricalMetric(derived, 1, "LOWER_IS_BETTER", AS_OF);
    expect(scored.confidence).toBe("HIGH");
    const proxyLike = scoreHistoricalMetric(
      Object.assign(ascending("x"), { source: "tushare-derived-forward-pe" }),
      1, "LOWER_IS_BETTER", AS_OF,
    );
    expect(proxyLike.confidence).toBe("MEDIUM");
  });

  it("黄金宏观极差时不再误入 REASSESS_THESIS（bucket 接线回归）", () => {
    const result = calculateAssetScore(goldInput());
    expect(result.fundamentalScore).not.toBeNull();
    expect(result.fundamentalScore!).toBeLessThan(35);
    expect(result.state).not.toBe("REASSESS_THESIS");
    expect(result.reasons.join()).not.toContain("重新评估");
  });

  it("宽基：PARTIAL 派生 ERP 不进主评分，回退 PE/PB；高可信 ERP 保留", () => {
    const base: AssetModelInput = {
      bucket: "BROAD_EQUITY", asOf: AS_OF, trend,
      pe: ascending("tushare-index-aggregate"), pb: ascending("tushare-index-aggregate"),
      equityRiskPremium: ascending("tushare"), indexEarningsGrowth: ascending("tushare-index-aggregate"),
    };
    const withPartialErp = calculateAssetScore(
      Object.assign({}, base, { equityRiskPremium: Object.assign(ascending("tushare-derived"), { quality: "PARTIAL" as const }) }),
    );
    expect(Object.keys(withPartialErp.components).some((k) => k.includes("equityRiskPremium"))).toBe(false);
    const withGoodErp = calculateAssetScore(base);
    expect(Object.keys(withGoodErp.components).some((k) => k.includes("equityRiskPremium"))).toBe(true);
  });
});