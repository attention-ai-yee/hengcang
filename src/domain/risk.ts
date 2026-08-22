import type { RecommendationState, RiskSeverity } from "./types";

export interface HoldingRiskInput {
  holdingValueMinor: bigint;
  portfolioValueMinor: bigint;
  isSingleStock: boolean;
  isThematicEtf: boolean;
  limits: {
    singleStockBps: number;
    thematicEtfBps: number;
  };
}

export interface HoldingRiskResult {
  weightBps: number;
  applicableLimitBps: number | null;
  isOverweight: boolean;
  canAdd: boolean;
  severity: RiskSeverity;
  recommendationState: RecommendationState | null;
}

export function evaluateHoldingRisk(input: HoldingRiskInput): HoldingRiskResult {
  const weightBps =
    input.portfolioValueMinor > 0n
      ? Number((input.holdingValueMinor * 10_000n) / input.portfolioValueMinor)
      : 0;
  const limits = [
    input.isSingleStock ? input.limits.singleStockBps : null,
    input.isThematicEtf ? input.limits.thematicEtfBps : null,
  ].filter((value): value is number => value !== null);
  const applicableLimitBps = limits.length > 0 ? Math.min(...limits) : null;
  const scaledHolding = input.holdingValueMinor * 10_000n;
  const scaledLimit =
    applicableLimitBps === null ? null : input.portfolioValueMinor * BigInt(applicableLimitBps);
  const isOverweight = scaledLimit !== null && scaledHolding > scaledLimit;
  const canAdd = scaledLimit === null || scaledHolding < scaledLimit;

  return {
    weightBps,
    applicableLimitBps,
    isOverweight,
    canAdd,
    severity: isOverweight ? "WARNING" : canAdd ? "INFO" : "WATCH",
    recommendationState: isOverweight ? "OVERWEIGHT" : null,
  };
}
