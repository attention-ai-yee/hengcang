import type { Confidence, RecommendationState, ScorableAssetBucket } from "../types";
import type { RecommendationDirection } from "./state";

export interface HistoricalObservation {
  value: number;
  asOf: string;
  availableAt: string;
}

export interface MetricSeries {
  currentValue: number | null;
  history: HistoricalObservation[];
  source: string;
  asOf: string;
  availableAt?: string;
}

export interface DirectScoreMetric {
  score: number | null;
  source: string;
  asOf: string;
  confidence?: Confidence;
}

export interface PointMetric {
  value: number | null;
  source: string;
  asOf: string;
  confidence?: Confidence;
}

export interface ScoreComponentResult {
  rawValue: number | null;
  percentile: number | null;
  score: number | null;
  weight: number;
  source: string;
  asOf: string;
  confidence: Confidence;
}

export interface SubscoreResult {
  score: number | null;
  coverage: number;
  confidence: Confidence;
  components: Record<string, ScoreComponentResult>;
  missingMetrics: string[];
}

export interface TrendModelInput {
  price: PointMetric;
  ma20: PointMetric;
  ma60: PointMetric;
  ma200: PointMetric;
  momentum6m: MetricSeries;
}

interface BaseModelInput {
  asOf: string;
  trend: TrendModelInput;
}

export interface ValueDividendInput extends BaseModelInput {
  bucket: "VALUE_DIVIDEND";
  pe: MetricSeries;
  pb: MetricSeries;
  dividendYield: MetricSeries;
  earningsGrowth: MetricSeries;
  roe: MetricSeries;
  dividendStability: DirectScoreMetric;
  fundamentalOverride?: DirectScoreMetric;
}

export interface TechGrowthInput extends BaseModelInput {
  bucket: "TECH_GROWTH";
  forwardPe: MetricSeries;
  ps: MetricSeries;
  expectedEarningsGrowth: MetricSeries;
  peg?: MetricSeries;
  earningsGrowth: MetricSeries;
  revenueGrowth: MetricSeries;
  earningsRevision?: MetricSeries;
}

export interface BroadEquityInput extends BaseModelInput {
  bucket: "BROAD_EQUITY";
  pe: MetricSeries;
  pb: MetricSeries;
  equityRiskPremium?: MetricSeries;
  indexEarningsGrowth: MetricSeries;
  earningsRevision?: MetricSeries;
}

export interface GoldInput extends BaseModelInput {
  bucket: "GOLD";
  pricePosition: MetricSeries;
  distanceFromMa200: MetricSeries;
  momentum3m: MetricSeries;
  realYield: MetricSeries;
  dollarIndex: MetricSeries;
  etfFlow?: MetricSeries;
  centralBankDemand?: MetricSeries | DirectScoreMetric;
}

export type AssetModelInput = ValueDividendInput | TechGrowthInput | BroadEquityInput | GoldInput;

export interface ScoreRiskContext {
  currentWeightBps?: number;
  positionLimitBps?: number;
  confidenceOverride?: Confidence;
  previousState?: RecommendationState;
  candidateHistory?: RecommendationState[];
  lastDecisionDirection?: Exclude<RecommendationDirection, "NONE">;
  lastDecisionAt?: string;
}

export interface ScoreResult {
  bucket: ScorableAssetBucket;
  asOf: string;
  cheapnessScore: number | null;
  fundamentalScore: number | null;
  trendScore: number | null;
  opportunityScore: number | null;
  confidence: Confidence;
  candidateState: RecommendationState;
  state: RecommendationState;
  stateConfirmed: boolean;
  signalSuppressed: boolean;
  allowAdd: boolean;
  forceSell: false;
  components: Record<string, ScoreComponentResult>;
  missingMetrics: string[];
  reasons: string[];
}
