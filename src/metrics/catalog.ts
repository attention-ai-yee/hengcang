export const METRIC_CATALOG = {
  PRICE_CLOSE: { label: "收盘价", defaultUnit: "price", positive: true },
  PE_TTM: { label: "滚动市盈率", defaultUnit: "ratio", positive: true },
  PE_FORWARD: { label: "预期市盈率（TTM 代理时会明确标记）", defaultUnit: "ratio", positive: true },
  PB: { label: "市净率", defaultUnit: "ratio", positive: true },
  PS: { label: "市销率", defaultUnit: "ratio", positive: true },
  PEG: { label: "PEG", defaultUnit: "ratio" },
  DIVIDEND_YIELD: { label: "股息率", defaultUnit: "percent", nonNegative: true },
  EARNINGS_GROWTH: { label: "盈利增长", defaultUnit: "percent" },
  EXPECTED_EARNINGS_GROWTH: { label: "预期盈利增长", defaultUnit: "percent" },
  REVENUE_GROWTH: { label: "营收增长", defaultUnit: "percent" },
  ROE: { label: "净资产收益率", defaultUnit: "percent" },
  EARNINGS_REVISION: { label: "盈利预期修正", defaultUnit: "percent" },
  INDEX_EARNINGS_GROWTH: { label: "指数盈利增长", defaultUnit: "percent" },
  // v2：价格 ÷ PE 推算的盈利增长只作参考（财报季之间的近似），不进入评分和基本面体检，
  // 也不再和成分股财报汇总口径混在同一条序列里（docs/hengcang_v2_*.md §2）。
  EARNINGS_GROWTH_DERIVED: { label: "价格/PE 推算盈利增长（仅参考）", defaultUnit: "percent" },
  INDEX_EARNINGS_GROWTH_DERIVED: { label: "价格/PE 推算指数盈利增长（仅参考）", defaultUnit: "percent" },
  EQUITY_RISK_PREMIUM: { label: "股权风险溢价", defaultUnit: "percent" },
  REAL_YIELD_10Y: { label: "10 年实际利率", defaultUnit: "percent" },
  DOLLAR_INDEX: { label: "美元广义指数", defaultUnit: "index", positive: true },
  GOLD_ETF_FLOW_3M: { label: "黄金 ETF 三个月净流入", defaultUnit: "currency" },
  GOLD_GLOBAL_ETF_FLOW_3M: { label: "全球黄金 ETF 三个月净流入（WGC）", defaultUnit: "currency" },
  DIVIDEND_STABILITY_SCORE: { label: "分红稳定性", defaultUnit: "score", scoreRange: true },
  CENTRAL_BANK_DEMAND_SCORE: { label: "央行购金需求", defaultUnit: "score", scoreRange: true },
  FUNDAMENTAL_OVERRIDE_SCORE: { label: "基本面手工覆盖", defaultUnit: "score", scoreRange: true },
} as const;

export type CanonicalMetricKey = keyof typeof METRIC_CATALOG;
export const CANONICAL_METRIC_KEYS = Object.keys(METRIC_CATALOG) as CanonicalMetricKey[];

export function metricLabel(key: string): string {
  return key in METRIC_CATALOG ? METRIC_CATALOG[key as CanonicalMetricKey].label : key;
}
