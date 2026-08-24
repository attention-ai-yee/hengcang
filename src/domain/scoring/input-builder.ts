import type {
  AssetModelInput,
  DirectScoreMetric,
  MetricSeries,
} from "./types";
import type { ScorableAssetBucket } from "../types";
import type { CanonicalMetricKey } from "@/metrics/catalog";
import { derivePriceFeatures } from "@/metrics/derive-price-features";
import { deriveRatioSeries } from "./series-transforms";
import type { MetricSeriesRepository } from "@/metrics/observation-repository";

function directScore(series: MetricSeries): DirectScoreMetric {
  return {
    score: series.currentValue,
    source: series.source,
    asOf: series.asOf,
    confidence: series.source === "manual" ? "LOW" : undefined,
    quality: series.quality,
    coverage: series.coverage,
  };
}

export class ScoreInputBuilder {
  constructor(private readonly repository: MetricSeriesRepository) {}

  async build(bucket: ScorableAssetBucket, asOf: string): Promise<AssetModelInput> {
    const load = (metricKey: CanonicalMetricKey) => this.repository.resolveSeries({ subjectId: bucket, metricKey, asOf });
    const price = await load("PRICE_CLOSE");
    const priceFeatures = derivePriceFeatures(price);

    switch (bucket) {
      case "VALUE_DIVIDEND": {
        const [pe, pb, dividendYield, earningsGrowth, roe, dividendStability, fundamentalOverride] = await Promise.all([
          load("PE_TTM"), load("PB"), load("DIVIDEND_YIELD"), load("EARNINGS_GROWTH"), load("ROE"),
          load("DIVIDEND_STABILITY_SCORE"), load("FUNDAMENTAL_OVERRIDE_SCORE"),
        ]);
        return {
          bucket, asOf, trend: priceFeatures.trend, pe, pb, dividendYield, earningsGrowth, roe,
          dividendStability: directScore(dividendStability),
          fundamentalOverride: fundamentalOverride.currentValue === null ? undefined : directScore(fundamentalOverride),
        };
      }
      case "TECH_GROWTH": {
        // 科技 v1.4（Route B）：全部使用真实聚合数据；PEG_TTM 为 PE 与已实现增长的确定性变换。
        const [pe, ps, earningsGrowth, revenueGrowth] = await Promise.all([
          load("PE_TTM"), load("PS"), load("EARNINGS_GROWTH"), load("REVENUE_GROWTH"),
        ]);
        const peg = pe.currentValue !== null && earningsGrowth.currentValue !== null
          ? deriveRatioSeries(pe, earningsGrowth, { featureName: "PEG_TTM" })
          : undefined;
        return {
          bucket,
          asOf,
          trend: priceFeatures.trend,
          pe,
          ps,
          earningsGrowth,
          revenueGrowth,
          peg: peg && peg.currentValue !== null ? peg : undefined,
        };
      }
      case "BROAD_EQUITY": {
        const [pe, pb, equityRiskPremium, indexEarningsGrowth, earningsRevision] = await Promise.all([
          load("PE_TTM"), load("PB"), load("EQUITY_RISK_PREMIUM"), load("INDEX_EARNINGS_GROWTH"), load("EARNINGS_REVISION"),
        ]);
        return {
          bucket, asOf, trend: priceFeatures.trend, pe, pb, indexEarningsGrowth,
          equityRiskPremium: equityRiskPremium.currentValue === null ? undefined : equityRiskPremium,
          earningsRevision: earningsRevision.currentValue === null ? undefined : earningsRevision,
        };
      }
      case "GOLD": {
        const [realYield, dollarIndex, globalFlow, domesticFlow, centralBankDemand] = await Promise.all([
          load("REAL_YIELD_10Y"), load("DOLLAR_INDEX"), load("GOLD_GLOBAL_ETF_FLOW_3M"), load("GOLD_ETF_FLOW_3M"), load("CENTRAL_BANK_DEMAND_SCORE"),
        ]);
        // 资金流：优先 WGC 全球口径（VALID）；缺失时回退国内 ETF 代理（PARTIAL）
        const etfFlow = globalFlow.currentValue !== null ? globalFlow : domesticFlow;
        return {
          bucket, asOf, trend: priceFeatures.trend,
          pricePosition: priceFeatures.pricePosition,
          distanceFromMa200: priceFeatures.distanceFromMa200,
          momentum3m: priceFeatures.momentum3m,
          realYield,
          dollarIndex,
          etfFlow: etfFlow.currentValue === null ? undefined : etfFlow,
          centralBankDemand: centralBankDemand.currentValue === null ? undefined : directScore(centralBankDemand),
        };
      }
    }
  }
}
