import { CircleHelp } from "lucide-react";
import { DEFAULT_SCORING_CONFIG } from "@/domain/scoring";
import type { Confidence, RecommendationState } from "@/domain/types";
import { CONFIDENCE_LABELS, STATE_LABELS } from "@/lib/presentation";
import { cn } from "@/lib/cn";

interface ScoreExplanationTooltipProps {
  assetBucket?: string;
  score: number | null;
  cheapness: number | null;
  fundamental: number | null;
  trend: number | null;
  confidence: Confidence;
  state: RecommendationState;
  /** 三交易日确认期等场景可覆盖状态文案（避免与置信度徽章矛盾） */
  stateNote?: string;
}

function scoreBand(score: number) {
  const thresholds = DEFAULT_SCORING_CONFIG.thresholds;
  if (score >= thresholds.strongAdd) return `明显机会区间（≥ ${thresholds.strongAdd}）`;
  if (score >= thresholds.lightAdd) return `偏有吸引力区间（${thresholds.lightAdd}–${thresholds.strongAdd - 0.1}）`;
  if (score >= thresholds.hold) return `中性区间（${thresholds.hold}–${thresholds.lightAdd - 0.1}）`;
  if (score >= thresholds.doNotAdd) return `偏贵或偏弱区间（${thresholds.doNotAdd}–${thresholds.hold - 0.1}）`;
  return `风险偏高区间（< ${thresholds.doNotAdd}）`;
}

function value(value: number | null) {
  return value === null ? "缺失" : value.toFixed(1);
}

function scoreColor(state: RecommendationState) {
  if (state === "STRONG_ADD_ALLOWED" || state === "LIGHT_ADD_ALLOWED") return "text-[#18754b]";
  if (state === "DO_NOT_ADD" || state === "REDUCE_CONSIDER" || state === "OVERWEIGHT" || state === "REASSESS_THESIS") return "text-[#b4453d]";
  if (state === "HOLD") return "text-[#a66b10]";
  return "text-[#806a35]";
}

export function ScoreExplanationTooltip({
  assetBucket,
  score,
  cheapness,
  fundamental,
  trend,
  confidence,
  state,
  stateNote,
}: ScoreExplanationTooltipProps) {
  // 黄金 v1.2（规格 §2/§24/§25）：支柱展示语义不同，且禁止对黄金使用「重新评估投资逻辑」类文案。
  const isGold = assetBucket === "GOLD";
  const cheapLabel = isGold ? "价格吸引力" : "便宜程度";
  const fundamentalLabel = isGold ? "宏观支持度" : "基本面";
  const summary = score === null
    ? "当前缺少足够数据，无法计算配置吸引力分。"
    : `${score.toFixed(1)} 分属于${scoreBand(score)}。当前状态：${stateNote ?? STATE_LABELS[state]}。`;

  return (
    <div className="mt-2">
      <span className="block text-[11px] font-semibold tracking-wide text-[#748078]">配置吸引力分</span>
      <div className="group relative mt-0.5 inline-flex items-center gap-2">
        <strong className={cn("text-4xl", scoreColor(state))}>{score ?? "—"}</strong>
        <button
          type="button"
          aria-label={summary + " 配置吸引力分由" + cheapLabel + " 50%、" + fundamentalLabel + " 30% 和趋势 20% 合成。"}
          className="grid size-6 place-items-center rounded-full border border-[#cbd7d0] bg-[#f5f8f6] text-[#557064] outline-none transition hover:border-[#315f4d] hover:text-[#315f4d] focus-visible:ring-2 focus-visible:ring-[#6f9b88]"
        >
          <CircleHelp size={15} aria-hidden="true" />
        </button>
        <div
          role="tooltip"
          className="pointer-events-none invisible absolute left-0 top-[calc(100%+0.6rem)] z-30 w-[min(21rem,calc(100vw-3rem))] translate-y-1 rounded-xl border border-[#d6e0da] bg-[#173f32] p-4 text-left text-sm font-normal leading-6 text-white opacity-0 shadow-xl transition group-hover:visible group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:visible group-focus-within:translate-y-0 group-focus-within:opacity-100"
        >
          <strong className="block text-sm">{summary}</strong>
          <p className="mt-2 text-xs leading-5 text-[#d4e3dc]">
            计算：50% × {cheapLabel} {value(cheapness)} + 30% × {fundamentalLabel} {value(fundamental)} + 20% × 趋势 {value(trend)}。
          </p>
          <div className="mt-2 text-xs leading-5 text-[#d4e3dc]">
            {isGold && (
              <p className="mt-2 text-xs leading-5 text-[#d4e3dc]">
                价格吸引力：衡量黄金当前价格位置和拥挤程度。宏观支持度：衡量实际利率、美元、ETF 资金流和央行需求的支持程度——低分代表宏观逆风，不表示黄金长期配置逻辑失效。趋势：衡量中长期价格趋势和动量状态。
              </p>
            )}
            可信度：{CONFIDENCE_LABELS[confidence]}。高分表示更值得考虑配置，但仍受仓位、基本面熔断和数据可信度约束；它不是交易指令。
          </div>
        </div>
      </div>
    </div>
  );
}

export function ScoreColorLegend() {
  const items = [
    { color: "bg-[#18754b]", label: "绿色：最终状态允许考虑增配" },
    { color: "bg-[#d4932e]", label: "黄色：最终状态为持有 / 等待" },
    { color: "bg-[#b4453d]", label: "红色：停止新增或考虑降低仓位" },
    { color: "bg-[#806a35]", label: "灰黄：数据可信度不足，暂不行动" },
  ];
  return (
    <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 rounded-xl border border-[#dce3de] bg-white px-4 py-3 text-xs text-[#5f6d66]">
      <strong className="w-full text-[#27342e] md:w-auto">配置吸引力分：</strong>
      {items.map((item) => (
        <span key={item.label} className="inline-flex items-center gap-2">
          <span className={cn("size-2.5 rounded-full", item.color)} aria-hidden="true" />
          {item.label}
        </span>
      ))}
    </div>
  );
}
