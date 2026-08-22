import type { RecommendationState } from "../types";
import { DEFAULT_SCORING_CONFIG, type ScoringConfig } from "./config";

export type RecommendationDirection = "ADD" | "REDUCE" | "NONE";

export function directionForState(state: RecommendationState): RecommendationDirection {
  if (state === "STRONG_ADD_ALLOWED" || state === "LIGHT_ADD_ALLOWED") return "ADD";
  if (state === "REDUCE_CONSIDER") return "REDUCE";
  return "NONE";
}

export function confirmStateTransition(input: {
  previousState: RecommendationState;
  candidateState: RecommendationState;
  candidateHistory: RecommendationState[];
  immediate: boolean;
  confirmationTradingDays?: number;
}) {
  if (input.candidateState === input.previousState || input.immediate) {
    return { state: input.candidateState, confirmed: true };
  }
  const required = input.confirmationTradingDays ?? DEFAULT_SCORING_CONFIG.signalRules.confirmationTradingDays;
  const recent = [...input.candidateHistory, input.candidateState].slice(-required);
  const confirmed = recent.length === required && recent.every((state) => state === input.candidateState);
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
