import { describe, expect, it } from "vitest";
import { aggregateThemeRisks, evaluateHoldingRisk, evaluateThemeRisk } from "@/domain/risk";

const LIMITS = { singleStockBps: 800, thematicEtfBps: 1500, themeBps: 2000 };
const PORTFOLIO = 100_000_000n; // 1,000,000 元（minor units）

describe("evaluateHoldingRisk", () => {
  it("单股严格超过 8% 时触发 OVERWEIGHT", () => {
    const result = evaluateHoldingRisk({
      holdingValueMinor: 4_800_001n,
      portfolioValueMinor: 60_000_000n,
      isSingleStock: true,
      isThematicEtf: false,
      limits: { singleStockBps: 800, thematicEtfBps: 1500 },
    });

    expect(result.isOverweight).toBe(true);
    expect(result.recommendationState).toBe("OVERWEIGHT");
    expect(result.severity).toBe("WARNING");
  });

  it("刚好等于 8% 时允许持有但禁止新增", () => {
    const result = evaluateHoldingRisk({
      holdingValueMinor: 4_800_000n,
      portfolioValueMinor: 60_000_000n,
      isSingleStock: true,
      isThematicEtf: false,
      limits: { singleStockBps: 800, thematicEtfBps: 1500 },
    });

    expect(result.isOverweight).toBe(false);
    expect(result.canAdd).toBe(false);
    expect(result.label).toBeNull();
  });

  it("主题 ETF 严格超过 15% 时触发超配", () => {
    const result = evaluateHoldingRisk({
      holdingValueMinor: 9_000_001n,
      portfolioValueMinor: 60_000_000n,
      isSingleStock: false,
      isThematicEtf: true,
      limits: { singleStockBps: 800, thematicEtfBps: 1500 },
    });
    expect(result.isOverweight).toBe(true);
    expect(result.canAdd).toBe(false);
    expect(result.recommendationState).toBe("OVERWEIGHT");
  });

  it("提供持仓名时返回具体违规标签", () => {
    const result = evaluateHoldingRisk({
      name: "先导智能",
      holdingValueMinor: 12_000_000n,
      portfolioValueMinor: PORTFOLIO,
      isSingleStock: true,
      isThematicEtf: false,
      limits: LIMITS,
    });
    expect(result.label).toBe("先导智能 12.0% 超过单股上限 8.0%");
  });
});

describe("evaluateThemeRisk：主题聚合", () => {
  it("同一主题持仓合计超过 20% 且组内单股超 8% 时返回最高风险标签", () => {
    const result = evaluateThemeRisk({
      assetBucket: "TECH_GROWTH",
      theme: "新能源",
      holdings: [
        { name: "先导智能", holdingValueMinor: 12_000_000n, isSingleStock: true, isThematicEtf: false },
        { name: "新能源ETF", holdingValueMinor: 10_000_000n, isSingleStock: false, isThematicEtf: true },
      ],
      portfolioValueMinor: PORTFOLIO,
      limits: LIMITS,
    });

    expect(result.weightBps).toBe(2200);
    expect(result.isOverweight).toBe(true); // 22% > 主题上限 20%
    expect(result.hardLimitExceeded).toBe(true);
    expect(result.severity).toBe("CRITICAL");
    // 最高风险按超限倍数排序：先导智能 12% / 8% = 1.5 高于主题 22% / 20% = 1.1
    expect(result.label).toBe("先导智能 12.0% 超过单股上限 8.0%");
  });

  it("主题合计超限但组内个别持仓未超限时，标签降级为主题级违规", () => {
    const result = evaluateThemeRisk({
      assetBucket: "TECH_GROWTH",
      theme: "新能源",
      holdings: [
        { name: "新能源ETF-A", holdingValueMinor: 11_000_000n, isSingleStock: false, isThematicEtf: true },
        { name: "新能源ETF-B", holdingValueMinor: 11_000_000n, isSingleStock: false, isThematicEtf: true },
      ],
      portfolioValueMinor: PORTFOLIO,
      limits: LIMITS,
    });

    expect(result.isOverweight).toBe(true);
    expect(result.hardLimitExceeded).toBe(true);
    expect(result.label).toBe("主题「新能源」合计 22.0% 超过主题上限 20.0%");
  });

  it("主题未超限且组内持仓合规时不产生硬上限违规", () => {
    const result = evaluateThemeRisk({
      assetBucket: "TECH_GROWTH",
      theme: "新能源",
      holdings: [
        { name: "先导智能", holdingValueMinor: 8_000_000n, isSingleStock: true, isThematicEtf: false },
      ],
      portfolioValueMinor: PORTFOLIO,
      limits: LIMITS,
    });

    expect(result.isOverweight).toBe(false);
    expect(result.hardLimitExceeded).toBe(false);
    expect(result.label).toBeNull();
    expect(result.severity).toBe("INFO");
  });
});

describe("aggregateThemeRisks：按桶汇总最高风险", () => {
  it("主题聚合 + 无主题持仓都参与桶级硬上限判断", () => {
    const result = aggregateThemeRisks({
      portfolioValueMinor: PORTFOLIO,
      limits: LIMITS,
      holdings: [
        { id: "h1", name: "先导智能", assetBucket: "TECH_GROWTH", theme: "新能源", holdingValueMinor: 12_000_000n, isSingleStock: true, isThematicEtf: false },
        { id: "h2", name: "新能源ETF", assetBucket: "TECH_GROWTH", theme: "新能源", holdingValueMinor: 10_000_000n, isSingleStock: false, isThematicEtf: true },
        { id: "h3", name: "沪深300ETF", assetBucket: "BROAD_EQUITY", theme: null, holdingValueMinor: 5_000_000n, isSingleStock: false, isThematicEtf: false },
      ],
    });

    expect(result.themeRisks).toHaveLength(1);
    expect(result.themeRisks[0].theme).toBe("新能源");
    expect(result.bucketRisks.TECH_GROWTH).toEqual({
      hardLimitExceeded: true,
      severity: "CRITICAL",
      label: "先导智能 12.0% 超过单股上限 8.0%",
    });
    expect(result.bucketRisks.BROAD_EQUITY).toEqual({ hardLimitExceeded: false, severity: "INFO", label: null });
  });

  it("无主题的单股超限也能识别（不因缺少 theme 漏判）", () => {
    const result = aggregateThemeRisks({
      portfolioValueMinor: PORTFOLIO,
      limits: LIMITS,
      holdings: [
        { id: "h1", name: "某股票", assetBucket: "VALUE_DIVIDEND", theme: null, holdingValueMinor: 9_000_000n, isSingleStock: true, isThematicEtf: false },
      ],
    });

    expect(result.themeRisks).toHaveLength(0);
    expect(result.bucketRisks.VALUE_DIVIDEND.hardLimitExceeded).toBe(true);
    expect(result.bucketRisks.VALUE_DIVIDEND.label).toContain("某股票");
  });

  it("恰好达到上限不算硬上限违规（只禁止新增）", () => {
    const result = aggregateThemeRisks({
      portfolioValueMinor: PORTFOLIO,
      limits: LIMITS,
      holdings: [
        { id: "h1", name: "某股票", assetBucket: "VALUE_DIVIDEND", theme: "银行", holdingValueMinor: 8_000_000n, isSingleStock: true, isThematicEtf: false },
      ],
    });

    expect(result.bucketRisks.VALUE_DIVIDEND.hardLimitExceeded).toBe(false);
    expect(result.themeRisks[0].hardLimitExceeded).toBe(false);
  });
});
