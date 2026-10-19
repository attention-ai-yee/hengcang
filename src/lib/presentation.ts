import type { FundamentalHealthStatus, HealthCheckStatus } from "@/domain/scoring/health-check";
import type { ThesisAttentionKind } from "@/domain/thesis";
import type { AssetBucket, RecommendationState } from "@/domain/types";

export const BUCKET_LABELS: Record<AssetBucket, string> = {
  CASH_BONDS: "现金与债券",
  GOLD: "黄金",
  VALUE_DIVIDEND: "红利与价值",
  TECH_GROWTH: "科技与成长",
  BROAD_EQUITY: "宽基权益",
  OVERSEAS_EQUITY: "海外权益",
  OTHER: "其他",
};

export const INSTRUMENT_TYPE_LABELS: Record<string, string> = {
  FUND: "基金",
  STOCK: "股票",
  ETF: "交易型开放式指数基金（ETF）",
  CASH: "现金",
  BOND: "债券",
  GOLD: "黄金",
  ACCOUNT_AGGREGATE: "账户汇总",
};

export function instrumentTypeLabel(instrumentType: string): string {
  return INSTRUMENT_TYPE_LABELS[instrumentType] ?? instrumentType;
}

export const CONFIDENCE_LABELS = {
  HIGH: "高可信度",
  MEDIUM: "中可信度",
  LOW: "低可信度",
} as const;

export const STATE_LABELS: Record<RecommendationState, string> = {
  STRONG_ADD_ALLOWED: "明显机会，可考虑增配",
  LIGHT_ADD_ALLOWED: "偏有吸引力，可小幅增配",
  HOLD: "中性，持有 / 等待",
  DO_NOT_ADD: "偏贵或偏弱，停止新增",
  REDUCE_CONSIDER: "风险偏高，可考虑降低仓位",
  OVERWEIGHT: "超配：停止新增，不强制卖出",
  REASSESS_THESIS: "基本面恶化，重新评估逻辑",
  LOW_CONFIDENCE: "数据可信度低，等待确认",
};

/** 基本面体检（v2）的结论文案 */
export const FUNDAMENTAL_HEALTH_LABELS: Record<FundamentalHealthStatus, string> = {
  HEALTHY: "正常",
  DETERIORATING: "恶化",
  UNKNOWN: "数据不足",
  NOT_APPLICABLE: "不适用",
};

export const HEALTH_CHECK_STATUS_LABELS: Record<HealthCheckStatus, string> = {
  OK: "通过",
  BREACH: "不通过",
  MISSING: "缺数据",
};

export const THESIS_ATTENTION_LABELS: Record<ThesisAttentionKind, string> = {
  BREACHED: "逻辑待复核：暂停新增",
  NEWS_TO_CONFIRM: "AI 发现可能触发：待确认",
  REVIEW_DUE: "季度复核到期",
  MISSING: "未写投资逻辑",
};
