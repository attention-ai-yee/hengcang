import { describe, expect, it } from "vitest";
import { calculateAssetScore } from "@/domain/scoring";
import type { AssetModelInput, MetricSeries, ValueDividendInput } from "@/domain/scoring/types";
import { planRecommendationSignal } from "@/server/scoring-refresh-service";

/**
 * 回归测试：单股 8% / 主题 ETF 15% / 主题 20% 硬上限接入评分状态机。
 * - 硬上限违规 → OVERWEIGHT + immediate（无候选确认期）+ allowAdd=false；
 * - 优先级：REASSESS_THESIS（基本面熔断）> OVERWEIGHT（硬上限/桶超配）> LOW_CONFIDENCE；
 * - riskSeverity：硬上限 CRITICAL / 重估与桶超配 WARNING / 低可信度 WATCH / 其余 INFO；
 * - 信号计划：状态变化或 CRITICAL 才生成，fingerprint 含桶|旧状态|新状态|评估日。
 */
const EVAL_DATE = "2026-08-23";

function metric(value: number): MetricSeries {
  return {
    currentValue: value,
    history: [{ value, asOf: "2020-01-01", availableAt: "2020-01-01T00:00:00Z", quality: "VALID" }],
    source: "tushare-index-aggregate",
    asOf: EVAL_DATE,
    availableAt: EVAL_DATE + "T00:00:00Z",
    quality: "VALID",
    coverage: 1,
  };
}

const presentTrend: AssetModelInput["trend"] = {
  price: { value: 120, source: "tushare", asOf: EVAL_DATE },
  ma20: { value: 110, source: "tushare", asOf: EVAL_DATE },
  ma60: { value: 100, source: "tushare", asOf: EVAL_DATE },
  ma200: { value: 80, source: "tushare", asOf: EVAL_DATE },
  momentum6m: {
    currentValue: 0.15,
    history: [
      { value: 0.1, asOf: "2020-01-01", availableAt: "2020-01-01T00:00:00Z", quality: "VALID" },
      { value: 0.15, asOf: EVAL_DATE, availableAt: EVAL_DATE + "T00:00:00Z", quality: "VALID" },
    ],
    source: "tushare-index-aggregate",
    asOf: EVAL_DATE,
    quality: "VALID",
    coverage: 1,
  },
};

const missingTrend: AssetModelInput["trend"] = {
  price: { value: null, source: "UNAVAILABLE", asOf: EVAL_DATE },
  ma20: { value: null, source: "UNAVAILABLE", asOf: EVAL_DATE },
  ma60: { value: null, source: "UNAVAILABLE", asOf: EVAL_DATE },
  ma200: { value: null, source: "UNAVAILABLE", asOf: EVAL_DATE },
  momentum6m: { currentValue: null, history: [], source: "UNAVAILABLE", asOf: EVAL_DATE },
};

function inputWithTrend(trend: ValueDividendInput["trend"]): ValueDividendInput {
  return {
    bucket: "VALUE_DIVIDEND",
    asOf: EVAL_DATE,
    trend,
    pe: metric(10),
    pb: metric(1),
    dividendYield: metric(5),
    earningsGrowth: metric(8),
    roe: metric(12),
    dividendStability: { score: 80, source: "tushare-index-aggregate", asOf: EVAL_DATE, quality: "VALID" },
  };
}

const HARD_LIMIT_LABEL = "先导智能 12.0% 超过单股上限 8.0%";

describe("硬上限接入评分状态机", () => {
  it("hardLimitExceeded → OVERWEIGHT 即时态，禁止新增并写入具体标签", () => {
    const result = calculateAssetScore(inputWithTrend(presentTrend), {
      hardLimitExceeded: true,
      hardLimitLabel: HARD_LIMIT_LABEL,
    });

    expect(result.candidateState).toBe("OVERWEIGHT");
    expect(result.state).toBe("OVERWEIGHT");
    expect(result.allowAdd).toBe(false);
    expect(result.forceSell).toBe(false);
    expect(result.hardLimitExceeded).toBe(true);
    expect(result.hardLimitLabel).toBe(HARD_LIMIT_LABEL);
    expect(result.riskSeverity).toBe("CRITICAL");
    expect(result.reasons.join("")).toContain(HARD_LIMIT_LABEL);
  });

  it("硬上限优先于支柱缺失闸门（不会降级成 LOW_CONFIDENCE）", () => {
    const result = calculateAssetScore(inputWithTrend(missingTrend), {
      hardLimitExceeded: true,
      hardLimitLabel: HARD_LIMIT_LABEL,
    });
    expect(result.candidateState).toBe("OVERWEIGHT");
    expect(result.state).toBe("OVERWEIGHT");
  });

  it("基本面熔断仍优先于硬上限（REASSESS_THESIS > OVERWEIGHT）", () => {
    const weakFundamental: AssetModelInput = {
      ...inputWithTrend(presentTrend),
      earningsGrowth: metric(0),
      roe: metric(0),
      dividendStability: { score: 10, source: "tushare-index-aggregate", asOf: EVAL_DATE, quality: "VALID" },
      fundamentalOverride: { score: 10, source: "tushare", asOf: EVAL_DATE, quality: "VALID" },
    };
    const result = calculateAssetScore(weakFundamental, {
      hardLimitExceeded: true,
      hardLimitLabel: HARD_LIMIT_LABEL,
    });
    expect(result.candidateState).toBe("REASSESS_THESIS");
    // 组合级硬上限风险仍在：严重度取更严重的 CRITICAL，便于信号提示。
    expect(result.riskSeverity).toBe("CRITICAL");
  });

  it("桶权重超配（非硬上限）→ OVERWEIGHT/WARNING", () => {
    const result = calculateAssetScore(inputWithTrend(presentTrend), {
      currentWeightBps: 4500,
      positionLimitBps: 4000,
    });
    expect(result.state).toBe("OVERWEIGHT");
    expect(result.riskSeverity).toBe("WARNING");
  });

  it("普通可增配状态 → INFO；低可信度 → WATCH", () => {
    const normal = calculateAssetScore(inputWithTrend(presentTrend));
    expect(normal.state).toBe("LIGHT_ADD_ALLOWED");
    expect(normal.allowAdd).toBe(true);
    expect(normal.riskSeverity).toBe("INFO");

    const gated = calculateAssetScore(inputWithTrend(missingTrend));
    expect(gated.state).toBe("LOW_CONFIDENCE");
    expect(gated.riskSeverity).toBe("WATCH");
  });
});

describe("信号计划：状态变化 / 硬上限去重", () => {
  it("状态未变且非 CRITICAL 不生成信号", () => {
    expect(
      planRecommendationSignal({
        assetBucket: "GOLD",
        asOf: "2026-08-23",
        oldState: "HOLD",
        newState: "HOLD",
        riskSeverity: "INFO",
      }),
    ).toBeNull();
  });

  it("状态变化生成状态变更信号，fingerprint 含旧/新状态与评估日", () => {
    const plan = planRecommendationSignal({
      assetBucket: "GOLD",
      asOf: "2026-08-23",
      oldState: "HOLD",
      newState: "LIGHT_ADD_ALLOWED",
      riskSeverity: "INFO",
    });
    expect(plan).not.toBeNull();
    expect(plan?.fingerprint).toBe("GOLD|HOLD|LIGHT_ADD_ALLOWED|2026-08-23");
    expect(plan?.signalType).toBe("STATE_CHANGE");
    expect(plan?.severity).toBe("INFO");
    expect(plan?.summary).toContain("→");
  });

  it("CRITICAL 即使状态未变也生成硬上限信号，并写入具体标签", () => {
    const plan = planRecommendationSignal({
      assetBucket: "TECH_GROWTH",
      asOf: "2026-08-23",
      oldState: "OVERWEIGHT",
      newState: "OVERWEIGHT",
      riskSeverity: "CRITICAL",
      hardLimitExceeded: true,
      hardLimitLabel: HARD_LIMIT_LABEL,
    });
    expect(plan?.signalType).toBe("HARD_LIMIT");
    expect(plan?.severity).toBe("CRITICAL");
    expect(plan?.fingerprint).toBe("TECH_GROWTH|OVERWEIGHT|OVERWEIGHT|2026-08-23");
    expect(plan?.summary).toContain(HARD_LIMIT_LABEL);
  });

  it("首次快照的 CRITICAL 用 NONE 占位旧状态", () => {
    const plan = planRecommendationSignal({
      assetBucket: "TECH_GROWTH",
      asOf: "2026-08-23",
      newState: "OVERWEIGHT",
      riskSeverity: "CRITICAL",
      hardLimitExceeded: true,
      hardLimitLabel: HARD_LIMIT_LABEL,
    });
    expect(plan?.fingerprint).toBe("TECH_GROWTH|NONE|OVERWEIGHT|2026-08-23");
  });
});
