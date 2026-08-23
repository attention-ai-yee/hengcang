import defaults from "./default-config.json";

export interface ScoringConfig {
  version: number;
  scoreWeights: { cheapness: number; fundamental: number; trend: number };
  thresholds: {
    strongAdd: number;
    lightAdd: number;
    hold: number;
    doNotAdd: number;
    fundamentalCircuitBreaker: number;
  };
  positionLimits: { singleStock: number; thematicETF: number };
  signalRules: { confirmationTradingDays: number; cooldownDays: number };
  history: {
    preferredYears: number;
    minimumYearsForMediumConfidence: number;
    mediumCoverage: number;
    highCoverage: number;
  };
  portfolio: { baseCurrency: string; reservedCash: number };
  componentWeights: typeof defaults.componentWeights;
}

export const DEFAULT_SCORING_CONFIG = defaults satisfies ScoringConfig;

export function assertScoringConfig(config: ScoringConfig): void {
  const scoreWeightTotal = Object.values(config.scoreWeights).reduce((sum, value) => sum + value, 0);
  if (Math.abs(scoreWeightTotal - 1) > 1e-9) throw new Error("机会分权重必须合计为 1");

  const { strongAdd, lightAdd, hold, doNotAdd, fundamentalCircuitBreaker } = config.thresholds;
  if (!(strongAdd > lightAdd && lightAdd > hold && hold > doNotAdd)) {
    throw new Error("状态阈值必须严格递减");
  }
  if (fundamentalCircuitBreaker < 0 || fundamentalCircuitBreaker > 100) {
    throw new Error("基本面熔断阈值必须位于 0–100");
  }
  if (!(config.history.highCoverage >= config.history.mediumCoverage && config.history.mediumCoverage > 0)) {
    throw new Error("可信度覆盖率阈值无效");
  }

  function validateWeightGroups(value: unknown, path: string): void {
    if (!value || typeof value !== "object") return;
    const entries = Object.entries(value);
    if (entries.length > 0 && entries.every(([, child]) => typeof child === "number")) {
      const total = entries.reduce((sum, [, child]) => sum + (child as number), 0);
      if (Math.abs(total - 1) > 1e-9) throw new Error(`${path} 权重必须合计为 1`);
      return;
    }
    for (const [key, child] of entries) validateWeightGroups(child, `${path}.${key}`);
  }
  validateWeightGroups(config.componentWeights, "componentWeights");
}
