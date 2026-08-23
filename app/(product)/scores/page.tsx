import { Card, PageIntro, StatusPill } from "@/components/ui";
import { ManualScoreForm } from "@/components/manual-score-form";
import { AutomaticDataRefresh } from "@/components/automatic-data-refresh";
import { ScoreColorLegend, ScoreExplanationTooltip } from "@/components/score-explanation-tooltip";
import { listLatestScores } from "@/db/queries";
import type { AssetBucket, RecommendationState } from "@/domain/types";
import { BUCKET_LABELS, CONFIDENCE_LABELS, STATE_LABELS } from "@/lib/presentation";

export const dynamic = "force-dynamic";

export default async function ScoresPage() {
  const scores = await listLatestScores();
  const latestByBucket = new Map<string, (typeof scores)[number]>();
  for (const score of scores) {
    if (!latestByBucket.has(score.assetBucket)) latestByBucket.set(score.assetBucket, score);
  }
  const latestScores = Array.from(latestByBucket.values());
  return (
    <>
      <PageIntro eyebrow="可解释评分" title="资产评分" description="配置吸引力分为 0–100 分，越高表示越值得考虑配置或增配；它不是机械买入信号，最终状态还会检查数据可信度、基本面和仓位上限。" />
      <Card className="mb-5 p-5">
        <h2 className="text-lg font-semibold">让系统自己获取数据</h2>
        <p className="mt-1 text-sm leading-6 text-[#66736d]">从 Tushare 自动拉取近 5 年行情和可用估值，完成观察值入库、派生指标和评分快照更新。</p>
        <div className="mt-4"><AutomaticDataRefresh compact /></div>
      </Card>
      <Card className="mb-5 p-5">
        <h2 className="text-lg font-semibold">评分如何计算</h2>
          <div className="mt-4 grid gap-3 text-sm leading-6 md:grid-cols-3">
            <div className="rounded-xl bg-[#f2f5f2] p-4"><strong>1. 指标归一化</strong><p className="mt-1 text-[#66736d]">只使用当时已经发布的数据计算滚动历史百分位。便宜程度、基本面和趋势均为越高越有吸引力。</p></div>
          <div className="rounded-xl bg-[#f2f5f2] p-4"><strong>2. 合成三项分</strong><p className="mt-1 text-[#66736d]">按资产桶权重加权；覆盖率低于 60% 为低可信度，60%–80% 为中等。代理数据最高只到中等可信度。</p></div>
          <div className="rounded-xl bg-[#f2f5f2] p-4"><strong>3. 计算配置吸引力分</strong><p className="mt-1 text-[#66736d]">50% × 便宜程度 + 30% × 基本面 + 20% × 趋势。高分表示配置吸引力更强，不代表保证上涨。</p></div>
        </div>
        <ScoreColorLegend />
        <p className="mt-3 text-xs leading-5 text-[#748078]">权益资产基本面低于 35 时立即暂停新增并要求重新评估逻辑；黄金宏观支持度偏低时仅停止新增、继续观察宏观方向。超配与低可信度会覆盖普通分数区间。现金与债券不计算配置吸引力分。</p>
        <details className="mt-4 rounded-xl border border-[#dce3de] p-4 text-sm">
          <summary className="cursor-pointer font-semibold">查看四类资产的默认指标</summary>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <ModelSummary title="黄金" text="价格吸引力：5 年价格位置、MA200 偏离、3M 拥挤；宏观支持度：实际利率水平与 3M 变化、美元指数水平与 3M 变化、国内黄金 ETF 资金流代理（15%）、央行购金需求（15%）。宏观支持度低只代表逆风，不代表长期配置逻辑失效。" />
            <ModelSummary title="红利与价值" text="便宜程度：PE 35%、PB 25%、股息率 40%；基本面：盈利增长 40%、ROE 30%、分红稳定性 30%。" />
            <ModelSummary title="科技与成长" text="便宜程度：Forward PE 40%、PS 20%、增长调整估值 40%；基本面：盈利、营收和盈利预期修正。" />
            <ModelSummary title="宽基权益" text="便宜程度：PE、PB、股权风险溢价；基本面：指数盈利增长与盈利预期修正。" />
          </div>
        </details>
      </Card>
      <details className="mb-5 rounded-2xl border border-[#dce3de] bg-white p-5">
        <summary className="cursor-pointer font-semibold">高级兜底：手工代理评分</summary>
        <p className="mt-2 text-sm text-[#66736d]">仅在数据源权限不足时使用；未附带原始历史序列，因此固定标记为低可信度。</p>
        <div className="mt-4"><ManualScoreForm /></div>
      </details>
      {latestScores.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="text-lg font-semibold">尚无评分快照</p>
          <p className="mt-2 text-sm text-[#66736d]">点击上方“一键自动刷新评分”，系统会自行获取数据并计算。</p>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {latestScores.map((score) => {
            const isGold = score.assetBucket === "GOLD";
            const details = parseDetails(score.componentsJson);
            return <Card key={score.id} className="p-5">
              <div className="flex items-start justify-between">
                <div>
                  <p className="eyebrow">{BUCKET_LABELS[score.assetBucket as AssetBucket]}</p>
                  <ScoreExplanationTooltip
                    score={score.opportunityScore}
                    cheapness={score.cheapnessScore}
                    fundamental={score.fundamentalScore}
                    trend={score.trendScore}
                    confidence={score.confidence as keyof typeof CONFIDENCE_LABELS}
                    state={score.recommendationState as RecommendationState}
                    assetBucket={score.assetBucket}
                  />
                </div>
                <StatusPill tone={score.confidence === "LOW" ? "warn" : "good"}>{CONFIDENCE_LABELS[score.confidence as keyof typeof CONFIDENCE_LABELS]}</StatusPill>
              </div>
              <div className="mt-5 grid grid-cols-3 gap-3 text-center text-sm">
                <Metric label={isGold ? "价格吸引力" : "便宜程度"} value={score.cheapnessScore} />
                <Metric label={isGold ? "宏观支持度" : "基本面"} value={score.fundamentalScore} />
                                <Metric label="趋势" value={score.trendScore} />
              </div>
              <p className="mt-4 text-sm font-semibold">{STATE_LABELS[score.recommendationState as RecommendationState]}</p>
              <p className="mt-1 text-xs text-[#748078]">as_of {score.asOf}</p>
              <details className="mt-4 border-t border-[#e7ece8] pt-4 text-sm">
                <summary className="cursor-pointer font-semibold text-[#315f4d]">为什么是这个分数</summary>
                {details.note && <p className="mt-3 leading-6 text-[#66736d]">{details.note}</p>}
                <div className="mt-3 overflow-x-auto">
                  <table className="data-table min-w-[560px]">
                    <thead><tr><th>指标</th><th>原始值</th><th>历史分位</th><th>得分</th><th>权重</th><th>来源 / 质量</th><th>日期 / 覆盖</th></tr></thead>
                    <tbody>{details.components.map((component) => <tr key={component.key}><td>{component.key}</td><td>{showValue(component.rawValue)}</td><td>{showValue(component.percentile, "%")}</td><td>{showValue(component.score)}</td><td>{(component.weight * 100).toFixed(0)}%</td><td>{providerLabel(component.source)} · <Quality quality={component.quality} /></td><td>{component.asOf}{component.coverage === null ? "" : ` · ${(component.coverage * 100).toFixed(0)}%`}</td></tr>)}</tbody>
                  </table>
                </div>
                {details.reasons.length > 0 && <ul className="mt-3 list-disc space-y-1 pl-5 text-[#72572e]">{details.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}
              </details>
            </Card>;
          })}
        </div>
      )}
    </>
  );
}

function Metric({ label, value }: { label: string; value: number | null }) {
  return <div className="rounded-xl bg-[#f2f5f2] p-3"><span className="block text-xs text-[#6f7c75]">{label}</span><strong className="mt-1 block text-lg">{value ?? "—"}</strong></div>;
}

function ModelSummary({ title, text }: { title: string; text: string }) {
  return <div className="rounded-xl bg-[#f2f5f2] p-3"><strong>{title}</strong><p className="mt-1 leading-6 text-[#66736d]">{text}</p></div>;
}

interface DetailComponent {
  key: string;
  rawValue: number | null;
  percentile: number | null;
  score: number | null;
  weight: number;
  source: string;
  asOf: string;
  quality: "VALID" | "PARTIAL" | null;
  coverage: number | null;
}

function parseDetails(json: string): { note: string; components: DetailComponent[]; reasons: string[] } {
  try {
    const value = JSON.parse(json) as { note?: unknown; components?: unknown; reasons?: unknown };
    const entries = value.components && typeof value.components === "object" && !Array.isArray(value.components)
      ? Object.entries(value.components as Record<string, Record<string, unknown>>)
      : [];
    return {
      note: typeof value.note === "string" ? value.note : "",
      components: entries.map(([key, component]) => ({
        key,
        rawValue: typeof component.rawValue === "number" ? component.rawValue : null,
        percentile: typeof component.percentile === "number" ? component.percentile : null,
        score: typeof component.score === "number" ? component.score : null,
        weight: typeof component.weight === "number" ? component.weight : 0,
        source: typeof component.source === "string" ? component.source : "未知",
        asOf: typeof component.asOf === "string" ? component.asOf : "未知",
        quality: component.quality === "VALID" || component.quality === "PARTIAL" ? component.quality : null,
        coverage: typeof component.coverage === "number" ? component.coverage : null,
      })),
      reasons: Array.isArray(value.reasons) ? value.reasons.filter((item): item is string => typeof item === "string") : [],
    };
  } catch {
    return { note: "评分明细格式无法解析", components: [], reasons: [] };
  }
}

function showValue(value: number | null, suffix = "") {
  return value === null ? "—" : `${value}${suffix}`;
}

function Quality({ quality }: { quality: DetailComponent["quality"] }) {
  if (quality === "VALID") return <span className="text-[#18754b]">有效</span>;
  if (quality === "PARTIAL") return <span className="text-[#a66b10]">代理 / 部分</span>;
  return <span className="text-[#748078]">未标记</span>;
}

function providerLabel(source: string) {
  if (source === "tushare-derived-forward-pe") return "TTM PE 代理";
  if (source === "tushare-gold-etf-proxy") return "国内黄金 ETF 资金流代理";
  if (source === "tushare-index-aggregate") return "Tushare 成分股聚合";
  return source;
}
