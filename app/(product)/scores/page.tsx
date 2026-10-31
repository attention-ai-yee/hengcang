import { Card, PageIntro, StatusPill } from "@/components/ui";
import { ManualScoreForm } from "@/components/manual-score-form";
import { AutomaticDataRefresh } from "@/components/automatic-data-refresh";
import { ScoreColorLegend, ScoreExplanationTooltip } from "@/components/score-explanation-tooltip";
import { listLatestScores } from "@/db/queries";
import { DEFAULT_SCORING_CONFIG, reportPeriodLabel, type HealthCheckPoint } from "@/domain/scoring";
import type { AssetBucket, RecommendationState } from "@/domain/types";
import { BUCKET_LABELS, CONFIDENCE_LABELS, FUNDAMENTAL_HEALTH_LABELS, HEALTH_CHECK_STATUS_LABELS, STATE_LABELS } from "@/lib/presentation";
import { readFundamentalHealth } from "@/lib/score-details";

const CHEAP_PCT = Math.round(DEFAULT_SCORING_CONFIG.scoreWeights.cheapness * 100);
const TREND_PCT = Math.round(DEFAULT_SCORING_CONFIG.scoreWeights.trend * 100);
const HEALTH = DEFAULT_SCORING_CONFIG.healthCheck;

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
            <div className="rounded-xl bg-[#f2f5f2] p-4"><strong>1. 便宜程度与趋势</strong><p className="mt-1 text-[#66736d]">只使用当时已经发布的数据计算滚动历史百分位，越高越有吸引力；覆盖率低于 60% 为低可信度，60%–80% 为中等，代理数据最高只到中等。</p></div>
          <div className="rounded-xl bg-[#f2f5f2] p-4"><strong>2. 基本面体检</strong><p className="mt-1 text-[#66736d]">不打分，只判断是否在恶化：盈利单季同比连续两个季度为负（还没有单季数据时看累计同比）；科技桶营收同样；红利桶分红稳定性低于 {HEALTH.dividendStabilityFloor}。恶化 → 暂停新增、重新评估；数据不足 → 最多小幅增配。</p></div>
          <div className="rounded-xl bg-[#f2f5f2] p-4"><strong>3. 计算配置吸引力分</strong><p className="mt-1 text-[#66736d]">{CHEAP_PCT}% × 便宜程度 + {TREND_PCT}% × 趋势。高分表示配置吸引力更强，不代表保证上涨。</p></div>
        </div>
        <ScoreColorLegend />
        <p className="mt-3 text-xs leading-5 text-[#748078]">权益资产基本面体检不通过时立即暂停新增并要求重新评估逻辑；黄金的宏观支持度（实际利率、美元、资金流）只作参考，不再拦路。超配与低可信度会覆盖普通分数区间。现金与债券、海外权益只按战略仓位管理，不计算配置吸引力分。</p>
        <details className="mt-4 rounded-xl border border-[#dce3de] p-4 text-sm">
          <summary className="cursor-pointer font-semibold">查看四类资产的默认指标</summary>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <ModelSummary title="黄金" text="价格吸引力：5 年价格位置、MA200 偏离、3M 拥挤。宏观支持度（实际利率、美元、全球黄金 ETF 资金流、央行购金）只作参考展示：2022 年后它和金价明显脱钩，v2 起不再拦路。" />
            <ModelSummary title="红利与价值" text="便宜程度：PE 35%、PB 25%、股息率 40%。基本面体检：盈利同比两期为负，或分红稳定性低于 60（基金拿不到成分财报时可用手工判断）。" />
            <ModelSummary title="科技与成长" text="便宜程度（已实现基本面模型）：PE_TTM 45%、PS 25%、PEG_TTM 30%。基本面体检：盈利同比或营收同比两期为负。" />
            <ModelSummary title="宽基权益" text="便宜程度：PE 60%、PB 40%（股权风险溢价为低可信派生代理，不进入主评分）。基本面体检：指数盈利同比两期为负。" />
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
            const health = readFundamentalHealth(score.componentsJson);
            const healthLabel = health.status ? FUNDAMENTAL_HEALTH_LABELS[health.status] : undefined;
            // 状态机三交易日确认期：旧确认状态可能是 LOW_CONFIDENCE 等历史残留，
            // 直接展示其标签会与当前置信度徽章矛盾（如「高可信度」+「数据可信度低」）。
            const transitioning = details.stateConfirmed === false && details.candidateState !== null && details.candidateState !== score.recommendationState;
            const transitionLabel = transitioning ? (STATE_LABELS[details.candidateState as RecommendationState] ?? details.candidateState) : "";
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
                    healthLabel={healthLabel}
                    stateNote={transitioning ? "状态切换确认中：候选「" + transitionLabel + "」（连续三个交易日后生效）" : undefined}
                  />
                </div>
                <StatusPill tone={score.confidence === "LOW" ? "warn" : "good"}>{CONFIDENCE_LABELS[score.confidence as keyof typeof CONFIDENCE_LABELS]}</StatusPill>
              </div>
              <div className="mt-5 grid grid-cols-3 gap-3 text-center text-sm">
                <Metric label={isGold ? "价格吸引力" : "便宜程度"} value={score.cheapnessScore} />
                {isGold
                  ? <Metric label="宏观支持度（参考）" value={score.fundamentalScore} />
                  : <TextMetric label="基本面体检" value={healthLabel ?? "旧版快照"} tone={health.status === "DETERIORATING" ? "danger" : health.status === "UNKNOWN" ? "warn" : "neutral"} />}
                                <Metric label="趋势" value={score.trendScore} />
              </div>
              <p className="mt-4 text-sm font-semibold">{transitioning ? "状态切换确认中：候选「" + transitionLabel + "」（连续三个交易日后生效）" : STATE_LABELS[score.recommendationState as RecommendationState]}</p>
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
                {health.checks.length > 0 && (
                  <div className="mt-4 overflow-x-auto">
                    <p className="mb-2 font-semibold text-[#27342e]">基本面体检明细</p>
                    <table className="data-table min-w-[560px]">
                      <thead><tr><th>检查项</th><th>触发条件</th><th>结果</th><th>最新</th><th>上一期</th><th>说明</th></tr></thead>
                      <tbody>{health.checks.map((check) => <tr key={check.key}><td>{check.label}</td><td>{check.rule}</td><td>{HEALTH_CHECK_STATUS_LABELS[check.status] ?? check.status}</td><td><HealthPoint point={check.latest} /></td><td><HealthPoint point={check.previous} /></td><td>{check.note ?? ""}</td></tr>)}</tbody>
                    </table>
                  </div>
                )}
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

function TextMetric({ label, value, tone }: { label: string; value: string; tone: "neutral" | "warn" | "danger" }) {
  const color = tone === "danger" ? "text-[#b4453d]" : tone === "warn" ? "text-[#a66b10]" : "text-[#17201c]";
  return <div className="rounded-xl bg-[#f2f5f2] p-3"><span className="block text-xs text-[#6f7c75]">{label}</span><strong className={`mt-1 block text-lg ${color}`}>{value}</strong></div>;
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

function parseDetails(json: string): { note: string; components: DetailComponent[]; reasons: string[]; candidateState: string | null; stateConfirmed: boolean } {
  try {
    const value = JSON.parse(json) as { note?: unknown; components?: unknown; reasons?: unknown; candidateState?: unknown; stateConfirmed?: unknown };
    const entries = value.components && typeof value.components === "object" && !Array.isArray(value.components)
      ? Object.entries(value.components as Record<string, Record<string, unknown>>)
      : [];
    return {
      note: typeof value.note === "string" ? value.note : "",
      candidateState: typeof value.candidateState === "string" ? value.candidateState : null,
      stateConfirmed: typeof value.stateConfirmed === "boolean" ? value.stateConfirmed : true,
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
    return { note: "评分明细格式无法解析", components: [], reasons: [], candidateState: null, stateConfirmed: true };
  }
}

/** 体检明细里的一个点：值一行，日期和以哪期财报为主各一行小字（卡片窄，挤在一行会折成好几行） */
function HealthPoint({ point }: { point: HealthCheckPoint | null }) {
  if (!point) return "—";
  return <>
    <span className="font-semibold">{point.value}</span>
    <span className="block whitespace-nowrap text-xs text-[#748078]">{point.asOf}</span>
    {point.reportPeriod && <span className="block whitespace-nowrap text-xs text-[#748078]">{reportPeriodLabel(point.reportPeriod)}为主</span>}
  </>;
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
  if (source === "wgc-goldhub") return "WGC 全球黄金 ETF 资金流";
  if (source === "tushare-gold-etf-proxy") return "国内黄金 ETF 资金流代理（回退）";
  if (source === "tushare-index-aggregate") return "Tushare 成分股聚合";
  return source;
}
