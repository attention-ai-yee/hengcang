import type { RecommendationState } from "../types";
import { DEFAULT_SCORING_CONFIG, type ScoringConfig } from "./config";

export type RecommendationDirection = "ADD" | "REDUCE" | "NONE";

const DAY_MS = 24 * 60 * 60 * 1000;

export function directionForState(state: RecommendationState): RecommendationDirection {
  if (state === "STRONG_ADD_ALLOWED" || state === "LIGHT_ADD_ALLOWED") return "ADD";
  if (state === "REDUCE_CONSIDER") return "REDUCE";
  return "NONE";
}

/**
 * 普通候选状态需要连续 N 个交易日保持才切换。
 * candidateHistoryDates 与 candidateHistory 一一对应（YYYY-MM-DD）：
 * 提供时按【不同交易日】计数——同一天多次刷新产生的快照只计一次，
 * 避免"盘中刷两次=两天"的双倍计数；日期断档不视为连续性破坏，
 * 但同日重复无法凑足确认天数。
 *
 * 交易日连续性（v1.5 修复）：仅"日期互不相同"无法识别断档、周末缺日与月度
 * 回填（如每月只采样一天），会把这三种情况误判为"连续 N 个交易日"。
 * 提供 tradingDates（升序、去重的已知交易日日历）时改用严格口径：
 * 取「候选历史日期 + 当前 asOf」最后 required 个日期，要求
 * (a) 当前 asOf 是已知交易日；
 * (b) 这 required 个日期在日历中连续相邻（索引差 1）；
 * 任一条件不满足即 confirmed=false（保守，宁可不切换）。
 * tradingDates 缺失或为空时保持旧的"日期互异"口径（向后兼容）。
 */
export function confirmStateTransition(input: {
  previousState: RecommendationState;
  candidateState: RecommendationState;
  candidateHistory: RecommendationState[];
  candidateHistoryDates?: string[];
  /** 当前评估日（YYYY-MM-DD）；仅在提供 tradingDates 时参与严格连续性校验 */
  asOf?: string;
  /** 升序、去重的已知交易日（YYYY-MM-DD）；提供且非空时按交易日连续相邻严格确认 */
  tradingDates?: string[];
  immediate: boolean;
  confirmationTradingDays?: number;
}) {
  if (input.candidateState === input.previousState || input.immediate) {
    return { state: input.candidateState, confirmed: true };
  }
  const required = input.confirmationTradingDays ?? DEFAULT_SCORING_CONFIG.signalRules.confirmationTradingDays;
  const recentStates = [...input.candidateHistory, input.candidateState].slice(-required);
  const statesMatch =
    recentStates.length === required && recentStates.every((state) => state === input.candidateState);
  let datesDistinct = true;
  if (input.candidateHistoryDates) {
    const priorDates = input.candidateHistoryDates.slice(-(required - 1));
    datesDistinct = new Set(priorDates).size >= required - 1;
  }
  const tradingDaysContiguous = input.tradingDates && input.tradingDates.length > 0
    ? satisfiesTradingDayContinuity({
        asOf: input.asOf,
        candidateHistoryDates: input.candidateHistoryDates ?? [],
        tradingDates: input.tradingDates,
        required,
      })
    : true;
  const confirmed = statesMatch && datesDistinct && tradingDaysContiguous;
  return { state: confirmed ? input.candidateState : input.previousState, confirmed };
}

/**
 * 严格交易日连续性：最后 required 个快照日期（候选历史 + 当前评估日）必须在
 * 已知交易日历中连续相邻。缺当前日、缺历史日、断档、周末或月度采样都返回 false。
 */
function satisfiesTradingDayContinuity(input: {
  asOf?: string;
  candidateHistoryDates: string[];
  tradingDates: string[];
  required: number;
}): boolean {
  if (!input.asOf) return false;
  const recentDates = [...input.candidateHistoryDates.slice(-(input.required - 1)), input.asOf];
  if (recentDates.length < input.required) return false;
  const indexByDate = new Map(input.tradingDates.map((date, index) => [date, index]));
  if (!indexByDate.has(input.asOf)) return false;
  let previousIndex: number | undefined;
  for (const date of recentDates) {
    const index = indexByDate.get(date);
    if (index === undefined) return false;
    if (previousIndex !== undefined && index !== previousIndex + 1) return false;
    previousIndex = index;
  }
  return true;
}

/** 只取日期部分（YYYY-MM-DD）的 UTC 日历日序号；解析失败返回 null。 */
function utcCalendarDay(value: string): number | null {
  const parsed = Date.parse(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(parsed) ? Math.round(parsed / DAY_MS) : null;
}

/**
 * 同方向建议冷却：按【日期部分】比较，而非绝对时间戳。
 * decidedAt 通常带时区（如 2026-10-18T15:00+08:00），asOf 为 date-only
 * （2026-10-18），直接相减会得到负数导致当天不抑制。改为比较 decidedAt.slice(0,10)
 * 与 asOf.slice(0,10) 的 UTC 日历日差：同日 elapsed=0 → 抑制。
 * 仍保持 elapsed >= 0 && elapsed < cooldownDays 语义。
 */
export function shouldSuppressRecommendation(input: {
  state: RecommendationState;
  lastDecisionDirection: Exclude<RecommendationDirection, "NONE">;
  lastDecisionAt: string;
  asOf: string;
  cooldownDays?: number;
}): boolean {
  if (directionForState(input.state) !== input.lastDecisionDirection) return false;
  const decidedDay = utcCalendarDay(input.lastDecisionAt);
  const asOfDay = utcCalendarDay(input.asOf);
  if (decidedDay === null || asOfDay === null) return false;
  const elapsedDays = asOfDay - decidedDay;
  const cooldownDays = input.cooldownDays ?? DEFAULT_SCORING_CONFIG.signalRules.cooldownDays;
  return elapsedDays >= 0 && elapsedDays < cooldownDays;
}

export function getBaseState(score: number, config: ScoringConfig = DEFAULT_SCORING_CONFIG): RecommendationState {
  if (score >= config.thresholds.strongAdd) return "STRONG_ADD_ALLOWED";
  if (score >= config.thresholds.lightAdd) return "LIGHT_ADD_ALLOWED";
  if (score >= config.thresholds.hold) return "HOLD";
  if (score >= config.thresholds.doNotAdd) return "DO_NOT_ADD";
  return "REDUCE_CONSIDER";
}
