export const ASSET_BUCKETS = [
  "CASH_BONDS",
  "GOLD",
  "VALUE_DIVIDEND",
  "TECH_GROWTH",
  "BROAD_EQUITY",
  "OTHER",
] as const;

export type AssetBucket = (typeof ASSET_BUCKETS)[number];
export type ScorableAssetBucket = Exclude<AssetBucket, "CASH_BONDS" | "OTHER">;

export const RECOMMENDATION_STATES = [
  "STRONG_ADD_ALLOWED",
  "LIGHT_ADD_ALLOWED",
  "HOLD",
  "DO_NOT_ADD",
  "REDUCE_CONSIDER",
  "OVERWEIGHT",
  "REASSESS_THESIS",
  "LOW_CONFIDENCE",
] as const;

export type RecommendationState = (typeof RECOMMENDATION_STATES)[number];
export type Confidence = "HIGH" | "MEDIUM" | "LOW";
export type RiskSeverity = "INFO" | "WATCH" | "WARNING" | "CRITICAL";

export interface HoldingInput {
  name: string;
  marketValueMinor: bigint;
  assetBucket: AssetBucket;
  instrumentType?: string;
  symbol?: string;
  isSingleStock?: boolean;
  isThematicEtf?: boolean;
  isApproximate?: boolean;
  needsBreakdown?: boolean;
  theme?: string;
}

export interface BucketSummary {
  valueMinor: bigint;
  investableValueMinor: bigint;
  weightBps: number;
  holdingCount: number;
}

export interface PortfolioSummary {
  totalValueMinor: bigint;
  reservedCashMinor: bigint;
  investableAssetsMinor: bigint;
  byBucket: Record<AssetBucket, BucketSummary>;
  concentrationComplete: boolean;
  unresolvedHoldings: string[];
}

export interface ScoreComponent {
  key: string;
  label: string;
  weight: number;
  normalizedScore: number | null;
  asOf?: string;
  provider?: string;
}
