import type { AssetBucket } from "./types";

export interface AllocationBand {
  targetBps: number;
  minBps: number;
  maxBps: number;
}

export const DEFAULT_ALLOCATION_BANDS: Record<AssetBucket, AllocationBand> = {
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
