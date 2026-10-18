import type { AssetBucket } from "./types";

export interface AllocationBand {
  targetBps: number;
  minBps: number;
  maxBps: number;
}

/**
 * 默认战略仓位 v2（2026-10-18）：权益 60%，其中海外 25%。
 * 依据：etf-trend 仓库 research/hengcang/README.md 的配置回测——同样 60% 权益，全国内配置
 * （v1 默认）2014–2023 年化 6.8%、最大回撤 34%；放 25% 标普后年化 8.5%、最大回撤 21%。
 * 迁移 drizzle/0004 只改写仍是 v1 默认值的组合（见 V1_DEFAULT_ALLOCATION_BANDS）。
 */
export const DEFAULT_ALLOCATION_BANDS: Record<AssetBucket, AllocationBand> = {
  CASH_BONDS: { targetBps: 3000, minBps: 2000, maxBps: 4000 },
  GOLD: { targetBps: 1000, minBps: 500, maxBps: 1500 },
  VALUE_DIVIDEND: { targetBps: 2000, minBps: 1000, maxBps: 3000 },
  TECH_GROWTH: { targetBps: 1500, minBps: 500, maxBps: 2500 },
  BROAD_EQUITY: { targetBps: 0, minBps: 0, maxBps: 1000 },
  OVERSEAS_EQUITY: { targetBps: 2500, minBps: 1500, maxBps: 3500 },
  OTHER: { targetBps: 0, minBps: 0, maxBps: 1000 },
};

/** v1 默认战略仓位（迁移识别「从未改过的默认配置」用，不再作为默认值）。 */
export const V1_DEFAULT_ALLOCATION_BANDS: Record<Exclude<AssetBucket, "OVERSEAS_EQUITY">, AllocationBand> = {
  CASH_BONDS: { targetBps: 3000, minBps: 2000, maxBps: 4000 },
  GOLD: { targetBps: 1000, minBps: 500, maxBps: 1500 },
  VALUE_DIVIDEND: { targetBps: 2500, minBps: 1500, maxBps: 3500 },
  TECH_GROWTH: { targetBps: 3000, minBps: 2000, maxBps: 4000 },
  BROAD_EQUITY: { targetBps: 500, minBps: 0, maxBps: 1500 },
  OTHER: { targetBps: 0, minBps: 0, maxBps: 1000 },
};

export const DEFAULT_RISK_LIMITS = {
  singleStockBps: 800,
  thematicEtfBps: 1500,
  themeBps: 2000,
  cooldownDays: 7,
};
