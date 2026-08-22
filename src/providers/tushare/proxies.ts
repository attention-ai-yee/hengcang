import type { ScorableAssetBucket } from "@/domain/types";
import type { PriceSeriesRequest } from "../types";

export interface TushareScoreProxy {
  bucket: ScorableAssetBucket;
  label: string;
  symbol: string;
  instrumentKind: NonNullable<PriceSeriesRequest["instrumentKind"]>;
  valuationMetrics: string[];
}

export function getTushareScoreProxies(): TushareScoreProxy[] {
  return [
    {
      bucket: "GOLD",
      label: "上海金 Au99.99",
      symbol: process.env.TUSHARE_GOLD_PROXY ?? "Au99.99",
      instrumentKind: "GOLD_SPOT",
      valuationMetrics: [],
    },
    {
      bucket: "VALUE_DIVIDEND",
      label: "上证 50（红利价值代理）",
      symbol: process.env.TUSHARE_VALUE_PROXY ?? "000016.SH",
      instrumentKind: "INDEX",
      valuationMetrics: ["PE_TTM", "PB"],
    },
    {
      bucket: "TECH_GROWTH",
      label: "创业板指（科技成长代理）",
      symbol: process.env.TUSHARE_TECH_PROXY ?? "399006.SZ",
      instrumentKind: "INDEX",
      valuationMetrics: ["PE_TTM", "PB"],
    },
    {
      bucket: "BROAD_EQUITY",
      label: "沪深 300（宽基权益代理）",
      symbol: process.env.TUSHARE_BROAD_PROXY ?? "000300.SH",
      instrumentKind: "INDEX",
      valuationMetrics: ["PE_TTM", "PB"],
    },
  ];
}
