import defaults from "./default-config.json";

export interface ScoringConfig {
  version: number;
  /**
   * v6：配置吸引力分只由便宜程度与趋势合成；基本面改成体检（见 health-check.ts），
   * 只负责「恶化 → 暂停新增」，不再以分数加权进入机会分。
   */
  scoreWeights: { cheapness: number; trend: number };
  thresholds: {
    strongAdd: number;
    lightAdd: number;
    hold: number;
    doNotAdd: number;
    /** 手工基本面覆盖分（0–100）低于该值视为体检不通过 */
    fundamentalCircuitBreaker: number;
  };
  healthCheck: {
    /** 「上一期」与最新值至少相隔的天数（约一个季度） */
    previousReportMinDays: number;
    /** 「上一期」与最新值最多相隔的天数；超过视为缺少对照值 */
    previousReportMaxDays: number;
    /** 红利桶分红稳定性（成分加权 0–100）低于该值视为体检不通过 */
    dividendStabilityFloor: number;
  };
  positionLimits: { singleStock: number; thematicETF: number };
  signalRules: { confirmationTradingDays: number; cooldownDays: number };
  history: {
    highYears: number;
    mediumYears: number;
    mediumCoverage: number;
    highCoverage: number;
    /** 数据新鲜度上限：指标最新观察（asOf 与 availableAt 较晚者）距评估日超过该天数时，组件可信度降为 LOW（不改分数）。 */
    maxObservationAgeDays: number;
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
  const { previousReportMinDays, previousReportMaxDays, dividendStabilityFloor } = config.healthCheck;
  if (!(previousReportMinDays > 0 && previousReportMaxDays > previousReportMinDays)) {
    throw new Error("基本面体检的对照期天数无效");
  }
  if (dividendStabilityFloor < 0 || dividendStabilityFloor > 100) {
    throw new Error("分红稳定性下限必须位于 0–100");
  }
  if (!(config.history.highCoverage >= config.history.mediumCoverage && config.history.mediumCoverage > 0)) {
    throw new Error("可信度覆盖率阈值无效");
  }
  if (!(Number.isFinite(config.history.maxObservationAgeDays) && config.history.maxObservationAgeDays > 0)) {
    throw new Error("数据新鲜度阈值必须为正数");
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
