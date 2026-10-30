import type { Confidence, RecommendationState, RiskSeverity, ScorableAssetBucket } from "../types";
import type { FundamentalHealth } from "./health-check";
import type { RecommendationDirection } from "./state";

export interface HistoricalObservation {
  value: number;
  asOf: string;
  availableAt: string;
  quality?: "VALID" | "PARTIAL";
  /** 财报类桶级汇总按权重占主导的报告期；旧数据或非财报指标没有 */
  reportPeriod?: string;
  /** 主导报告期占有效权重的比例（0–1）；2026-10-30 之前写入的汇总没有 */
  reportPeriodShare?: number;
}

export interface MetricSeries {
  currentValue: number | null;
  history: HistoricalObservation[];
  source: string;
  asOf: string;
  availableAt?: string;
  quality?: "VALID" | "PARTIAL";
  coverage?: number;
}

export interface DirectScoreMetric {
  score: number | null;
  source: string;
  asOf: string;
  confidence?: Confidence;
  quality?: "VALID" | "PARTIAL";
  coverage?: number;
}

export interface PointMetric {
  value: number | null;
  source: string;
  asOf: string;
  confidence?: Confidence;
  quality?: "VALID" | "PARTIAL";
  coverage?: number;
}

export interface ScoreComponentResult {
  rawValue: number | null;
  percentile: number | null;
  score: number | null;
  weight: number;
  source: string;
  asOf: string;
  confidence: Confidence;
  quality?: "VALID" | "PARTIAL";
  coverage?: number;
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

/**
 * 科技成长 v1.4（Route B，TTM 已实现基本面模型）：
 * 不再假装知道未来——去掉 Forward PE 代理、一致预期增长与盈利修正，
 * 用真实 PE_TTM/PS 加上 PE×实际增长的确定性 PEG 变换回答
 * 「按照已经发生的盈利和估值，现在科技贵不贵」。
 */
export interface TechGrowthInput extends BaseModelInput {
  bucket: "TECH_GROWTH";
  pe: MetricSeries;
  ps: MetricSeries;
  earningsGrowth: MetricSeries;
  revenueGrowth: MetricSeries;
  peg?: MetricSeries;
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
  /**
   * 该资产桶内任一持仓/主题严格超过单股 8% / 主题 ETF 15% / 主题 20% 硬上限。
   * 硬上限违规是组合层面的即时风险，优先于普通桶超配与低可信度。
   */
  hardLimitExceeded?: boolean;
  /** 具体违规标签，写进 OVERWEIGHT 原因与信号摘要 */
  hardLimitLabel?: string;
  confidenceOverride?: Confidence;
  previousState?: RecommendationState;
  candidateHistory?: RecommendationState[];
  /** 与 candidateHistory 一一对应的快照日期（YYYY-MM-DD），用于按不同交易日计数确认 */
  candidateHistoryDates?: string[];
  /**
   * 升序、去重的已知交易日（YYYY-MM-DD）。提供且非空时，连续 N 个交易日确认
   * 改为严格校验：当前评估日必须是交易日，且最近 required 个快照日期在日历中
   * 连续相邻；断档/周末/月度回填不再能凑足确认天数。
   */
  tradingDates?: string[];
  lastDecisionDirection?: Exclude<RecommendationDirection, "NONE">;
  lastDecisionAt?: string;
}

export interface ScoreResult {
  bucket: ScorableAssetBucket;
  asOf: string;
  cheapnessScore: number | null;
  /** 基本面子分（历史分位，v6 起只作展示参考，不参与决策） */
  fundamentalScore: number | null;
  /** 基本面体检（v6）：恶化 → REASSESS_THESIS；数据不足 → 最多小幅增配 */
  fundamentalHealth: FundamentalHealth;
  trendScore: number | null;
  opportunityScore: number | null;
  confidence: Confidence;
  candidateState: RecommendationState;
  state: RecommendationState;
  stateConfirmed: boolean;
  signalSuppressed: boolean;
  allowAdd: boolean;
  forceSell: false;
  /** 硬上限违规 CRITICAL；REASSESS/桶超配 WARNING；LOW_CONFIDENCE WATCH；其余 INFO */
  riskSeverity: RiskSeverity;
  hardLimitExceeded: boolean;
  hardLimitLabel: string | null;
  components: Record<string, ScoreComponentResult>;
  missingMetrics: string[];
  reasons: string[];
}
