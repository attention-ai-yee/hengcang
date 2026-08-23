import type { RecommendationState } from "../types";
import { DEFAULT_SCORING_CONFIG, type ScoringConfig } from "./config";

export type RecommendationDirection = "ADD" | "REDUCE" | "NONE";

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
 */
export function confirmStateTransition(input: {
  previousState: RecommendationState;
  candidateState: RecommendationState;
  candidateHistory: RecommendationState[];
  candidateHistoryDates?: string[];
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
  const confirmed = statesMatch && datesDistinct;
  return { state: confirmed ? input.candidateState : input.previousState, confirmed };
}

export function shouldSuppressRecommendation(input: {
  state: RecommendationState;
  lastDecisionDirection: Exclude<RecommendationDirection, "NONE">;
  lastDecisionAt: string;
  asOf: string;
  cooldownDays?: number;
}): boolean {
  if (directionForState(input.state) !== input.lastDecisionDirection) return false;
  const elapsedDays = (Date.parse(input.asOf) - Date.parse(input.lastDecisionAt)) / (24 * 60 * 60 * 1000);
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
