import type { RecommendationState, RiskSeverity } from "./types";

export interface RiskLimitsConfig {
  singleStockBps: number;
  thematicEtfBps: number;
  themeBps: number;
}

export interface HoldingRiskInput {
  /** 展示用持仓名；缺省时违规标签用「该持仓」占位 */
  name?: string;
  holdingValueMinor: bigint;
  portfolioValueMinor: bigint;
  isSingleStock: boolean;
  isThematicEtf: boolean;
  limits: { singleStockBps: number; thematicEtfBps: number };
}

export interface HoldingRiskResult {
  weightBps: number;
  applicableLimitBps: number | null;
  isOverweight: boolean;
  canAdd: boolean;
  severity: RiskSeverity;
  recommendationState: RecommendationState | null;
  /** 具体违规标签（如「先导智能 12.0% 超过单股上限 8.0%」）；未违规为 null */
  label: string | null;
}

export function formatRiskPercent(bps: number): string {
  return `${(bps / 100).toFixed(1)}%`;
}

interface LimitViolation {
  label: string;
  /** 超限倍数（实际权重 / 上限），用于在同一桶内挑选「最高风险」 */
  ratio: number;
}

function scaledWeight(valueMinor: bigint, portfolioValueMinor: bigint): number {
  return portfolioValueMinor > 0n ? Number((valueMinor * 10_000n) / portfolioValueMinor) : 0;
}

/** 严格超过：等于上限不算违规（只禁止新增，见 canAdd）。 */
function isOver(valueMinor: bigint, portfolioValueMinor: bigint, limitBps: number): boolean {
  return portfolioValueMinor > 0n && valueMinor * 10_000n > portfolioValueMinor * BigInt(limitBps);
}

function violationRatio(weightBps: number, limitBps: number | null): number {
  return limitBps !== null && limitBps > 0 ? weightBps / limitBps : Number.POSITIVE_INFINITY;
}

function holdingViolations(input: HoldingRiskInput, weightBps: number): LimitViolation[] {
  const name = input.name ?? "该持仓";
  const applicableLimits: Array<{ limitBps: number; limitLabel: string }> = [];
  if (input.isSingleStock) applicableLimits.push({ limitBps: input.limits.singleStockBps, limitLabel: "单股上限" });
  if (input.isThematicEtf) applicableLimits.push({ limitBps: input.limits.thematicEtfBps, limitLabel: "主题 ETF 上限" });
  return applicableLimits
    .filter(({ limitBps }) => isOver(input.holdingValueMinor, input.portfolioValueMinor, limitBps))
    .map(({ limitBps, limitLabel }) => ({
      label: `${name} ${formatRiskPercent(weightBps)} 超过${limitLabel} ${formatRiskPercent(limitBps)}`,
      ratio: violationRatio(weightBps, limitBps),
    }))
    .sort((first, second) => second.ratio - first.ratio);
}

export function evaluateHoldingRisk(input: HoldingRiskInput): HoldingRiskResult {
  const weightBps = scaledWeight(input.holdingValueMinor, input.portfolioValueMinor);
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
    // 逐持仓展示保持 WARNING：CRITICAL 留给接入评分状态机的硬上限违规（见 engine.riskSeverity）。
    severity: isOverweight ? "WARNING" : canAdd ? "INFO" : "WATCH",
    recommendationState: isOverweight ? "OVERWEIGHT" : null,
    label: holdingViolations(input, weightBps)[0]?.label ?? null,
  };
}

export interface ThemeRiskHoldingInput {
  name: string;
  holdingValueMinor: bigint;
  isSingleStock: boolean;
  isThematicEtf: boolean;
}

export interface ThemeRiskInput {
  assetBucket: string;
  theme: string;
  holdings: ThemeRiskHoldingInput[];
  portfolioValueMinor: bigint;
  limits: RiskLimitsConfig;
}

export interface ThemeRiskHoldingResult {
  name: string;
  weightBps: number;
  applicableLimitBps: number | null;
  isOverweight: boolean;
  label: string | null;
}

export interface ThemeRiskResult {
  assetBucket: string;
  theme: string;
  weightBps: number;
  applicableLimitBps: number;
  isOverweight: boolean;
  canAdd: boolean;
  severity: RiskSeverity;
  /** 主题合计或该主题内任一持仓触发硬上限（严格超过） */
  hardLimitExceeded: boolean;
  /** 该主题内最高风险的具体标签；未违规为 null */
  label: string | null;
  holdings: ThemeRiskHoldingResult[];
}

/**
 * 主题聚合评估：同一 theme 的持仓合计占可投资资产 bps 对比 themeBps；
 * 同时逐个持仓评估单股 8% / 主题 ETF 15% 上限，返回组内最高风险标签。
 */
export function evaluateThemeRisk(input: ThemeRiskInput): ThemeRiskResult {
  const themeValueMinor = input.holdings.reduce((sum, holding) => sum + holding.holdingValueMinor, 0n);
  const weightBps = scaledWeight(themeValueMinor, input.portfolioValueMinor);
  const applicableLimitBps = input.limits.themeBps;
  const isOverweight = isOver(themeValueMinor, input.portfolioValueMinor, applicableLimitBps);
  const themeViolation: LimitViolation | null = isOverweight
    ? {
        label: `主题「${input.theme}」合计 ${formatRiskPercent(weightBps)} 超过主题上限 ${formatRiskPercent(applicableLimitBps)}`,
        ratio: violationRatio(weightBps, applicableLimitBps),
      }
    : null;

  const holdings = input.holdings.map((holding) => {
    const result = evaluateHoldingRisk({
      name: holding.name,
      holdingValueMinor: holding.holdingValueMinor,
      portfolioValueMinor: input.portfolioValueMinor,
      isSingleStock: holding.isSingleStock,
      isThematicEtf: holding.isThematicEtf,
      limits: { singleStockBps: input.limits.singleStockBps, thematicEtfBps: input.limits.thematicEtfBps },
    });
    return {
      name: holding.name,
      weightBps: result.weightBps,
      applicableLimitBps: result.applicableLimitBps,
      isOverweight: result.isOverweight,
      label: result.label,
    };
  });

  const violations: LimitViolation[] = [
    ...(themeViolation ? [themeViolation] : []),
    ...holdings.flatMap((holding) =>
      holding.label === null
        ? []
        : [{ label: holding.label, ratio: violationRatio(holding.weightBps, holding.applicableLimitBps) }],
    ),
  ].sort((first, second) => second.ratio - first.ratio);

  const hardLimitExceeded = violations.length > 0;
  return {
    assetBucket: input.assetBucket,
    theme: input.theme,
    weightBps,
    applicableLimitBps,
    isOverweight,
    canAdd: !isOverweight,
    severity: hardLimitExceeded ? "CRITICAL" : weightBps < applicableLimitBps ? "INFO" : "WATCH",
    hardLimitExceeded,
    label: violations[0]?.label ?? null,
    holdings,
  };
}

export interface AggregateRiskHoldingInput extends ThemeRiskHoldingInput {
  id: string;
  assetBucket: string;
  theme?: string | null;
}

export interface BucketRiskSummary {
  /** 该资产桶内任一持仓或主题严格超过硬上限 */
  hardLimitExceeded: boolean;
  severity: RiskSeverity;
  /** 该桶内最高风险的具体标签；未违规为 null */
  label: string | null;
}

export interface AggregateRiskResult {
  /** 按（资产桶, 主题）聚合后的主题风险；没有 theme 的持仓不进入此列表 */
  themeRisks: ThemeRiskResult[];
  /** 每个出现过持仓的资产桶的最高风险摘要（评分状态机的硬上限输入） */
  bucketRisks: Record<string, BucketRiskSummary>;
}

/**
 * 把持仓按（资产桶, theme）聚合为主题风险，并汇总出每桶最高风险。
 * 无 theme 的持仓无法做主题聚合，但仍逐个评估单股/主题 ETF 硬上限，
 * 保证「该桶任一持仓触发硬上限」不会被漏判。
 */
export function aggregateThemeRisks(input: {
  portfolioValueMinor: bigint;
  limits: RiskLimitsConfig;
  holdings: AggregateRiskHoldingInput[];
}): AggregateRiskResult {
  const groups = new Map<string, AggregateRiskHoldingInput[]>();
  for (const holding of input.holdings) {
    const theme = holding.theme?.trim();
    if (!theme) continue;
    const key = `${holding.assetBucket}\u0000${theme}`;
    groups.set(key, [...(groups.get(key) ?? []), holding]);
  }

  const themeRisks = Array.from(groups.values())
    .map((holdings) => {
      const first = holdings[0];
      return evaluateThemeRisk({
        assetBucket: first.assetBucket,
        theme: first.theme?.trim() ?? "",
        holdings: holdings.map((holding) => ({
          name: holding.name,
          holdingValueMinor: holding.holdingValueMinor,
          isSingleStock: holding.isSingleStock,
          isThematicEtf: holding.isThematicEtf,
        })),
        portfolioValueMinor: input.portfolioValueMinor,
        limits: input.limits,
      });
    })
    .sort((first, second) => {
      const bucketOrder = first.assetBucket.localeCompare(second.assetBucket);
      return bucketOrder !== 0 ? bucketOrder : first.theme.localeCompare(second.theme);
    });

  const violationsByBucket = new Map<string, LimitViolation[]>();
  const recordViolation = (assetBucket: string, violation: LimitViolation) => {
    violationsByBucket.set(assetBucket, [...(violationsByBucket.get(assetBucket) ?? []), violation]);
  };
  for (const themeRisk of themeRisks) {
    if (themeRisk.isOverweight) {
      recordViolation(themeRisk.assetBucket, {
        label: `主题「${themeRisk.theme}」合计 ${formatRiskPercent(themeRisk.weightBps)} 超过主题上限 ${formatRiskPercent(themeRisk.applicableLimitBps)}`,
        ratio: violationRatio(themeRisk.weightBps, themeRisk.applicableLimitBps),
      });
    }
    for (const holding of themeRisk.holdings) {
      if (holding.label === null) continue;
      recordViolation(themeRisk.assetBucket, {
        label: holding.label,
        ratio: violationRatio(holding.weightBps, holding.applicableLimitBps),
      });
    }
  }
  for (const holding of input.holdings) {
    if (holding.theme?.trim()) continue;
    const result = evaluateHoldingRisk({
      name: holding.name,
      holdingValueMinor: holding.holdingValueMinor,
      portfolioValueMinor: input.portfolioValueMinor,
      isSingleStock: holding.isSingleStock,
      isThematicEtf: holding.isThematicEtf,
      limits: { singleStockBps: input.limits.singleStockBps, thematicEtfBps: input.limits.thematicEtfBps },
    });
    if (result.label === null) continue;
    recordViolation(holding.assetBucket, {
      label: result.label,
      ratio: violationRatio(result.weightBps, result.applicableLimitBps),
    });
  }

  const bucketRisks: Record<string, BucketRiskSummary> = {};
  for (const assetBucket of new Set(input.holdings.map((holding) => holding.assetBucket))) {
    const violations = (violationsByBucket.get(assetBucket) ?? []).sort((first, second) => second.ratio - first.ratio);
    bucketRisks[assetBucket] =
      violations.length > 0
        ? { hardLimitExceeded: true, severity: "CRITICAL", label: violations[0].label }
        : { hardLimitExceeded: false, severity: "INFO", label: null };
  }

  return { themeRisks, bucketRisks };
}
