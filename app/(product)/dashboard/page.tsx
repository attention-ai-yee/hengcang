import Link from "next/link";
import { AlertTriangle, ArrowRight, Clock3, ShieldCheck } from "lucide-react";
import { AllocationChart } from "@/components/allocation-chart";
import { Card, PageIntro, StatusPill } from "@/components/ui";
import { ScoreExplanationTooltip } from "@/components/score-explanation-tooltip";
import { formatBps, formatMoneyMinor } from "@/domain/portfolio";
import { ASSET_BUCKETS, type AssetBucket } from "@/domain/types";
import { BUCKET_LABELS, CONFIDENCE_LABELS, STATE_LABELS } from "@/lib/presentation";
import { listLatestScores, listLatestSignals } from "@/db/queries";
import { getPortfolioView } from "@/server/portfolio-service";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const [view, scores, signals] = await Promise.all([getPortfolioView(), listLatestScores(), listLatestSignals(5)]);
  const total = BigInt(view.summary.totalValueMinor);
  const investable = BigInt(view.summary.investableAssetsMinor);
  const reserved = BigInt(view.summary.reservedCashMinor);
  const targets = new Map(view.targets.map((target) => [target.assetBucket, target]));
  const latestScores = new Map<string, (typeof scores)[number]>();
  for (const score of scores) {
    if (!latestScores.has(score.assetBucket)) latestScores.set(score.assetBucket, score);
  }
  const chartData = ASSET_BUCKETS.map((bucket) => ({
    name: BUCKET_LABELS[bucket],
    value: view.summary.byBucket[bucket].weightBps / 100,
  })).filter((item) => item.value > 0);
  const latestScoreDate = Array.from(latestScores.values()).reduce<string | null>(
    (latest, score) => latest === null || score.asOf > latest ? score.asOf : latest,
    null,
  );

  return (
    <>
      <PageIntro
        eyebrow="Portfolio overview"
        title="先看风险，再看机会"
        description="总资产始终由当前持仓求和。所有评分和建议都带数据时间与可信度，不构成投资建议。"
        action={
          <Link href="/holdings" className="rounded-xl bg-[#173f32] px-4 py-2.5 text-sm font-semibold text-white">
            管理持仓
          </Link>
        }
      />

      <section className="mb-5 grid gap-4 md:grid-cols-4">
        <Card className="p-5 md:col-span-2">
          <p className="text-sm text-[#66736d]">总资产</p>
          <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
            <strong className="text-4xl tracking-[-0.04em]">{formatMoneyMinor(total)}</strong>
            <StatusPill tone={view.summary.concentrationComplete ? "good" : "warn"}>
              {view.summary.concentrationComplete ? "集中度数据完整" : "集中度分析不完整"}
            </StatusPill>
          </div>
          <p className="mt-5 border-t border-[#e5ebe7] pt-4 text-sm text-[#69766f]">
            {view.holdings.length} 项持仓 · 基础货币 CNY · 手工录入优先
          </p>
        </Card>
        <Card className="p-5">
          <p className="text-sm text-[#66736d]">可投资资产</p>
          <strong className="mt-2 block text-2xl tracking-[-0.03em]">{formatMoneyMinor(investable)}</strong>
          <p className="mt-3 text-xs leading-5 text-[#748078]">已扣除预留资金 {formatMoneyMinor(reserved)}</p>
        </Card>
        <Card className="border-[#ead7b7] bg-[#fffaf1] p-5">
          <div className="flex items-center gap-2 text-[#8a570b]">
            <AlertTriangle size={18} />
            <strong className="text-sm">最大集中风险</strong>
          </div>
          <p className="mt-4 text-xl font-semibold">
            {view.summary.concentrationComplete ? "暂无未处理警报" : "股票账户需要拆分"}
          </p>
          <p className="mt-2 text-sm leading-6 text-[#79694f]">
            {view.summary.concentrationComplete
              ? "后续风险引擎将持续检查单股、主题与资产桶上限。"
              : `${view.summary.unresolvedHoldings.join("、")} 尚未拆成具体标的，不能得出安全结论。`}
          </p>
        </Card>
      </section>

      <section className="mb-5 grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
        <Card className="p-5">
          <div className="mb-2 flex items-center justify-between">
            <div>
              <p className="eyebrow">Allocation</p>
              <h2 className="mt-1 text-xl font-semibold">可投资资产分布</h2>
            </div>
            <StatusPill>截至今天</StatusPill>
          </div>
          {chartData.length > 0 ? <AllocationChart data={chartData} /> : <EmptyState text="录入持仓后显示资产分布" />}
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            {ASSET_BUCKETS.map((bucket) => (
              <div key={bucket} className="flex items-center justify-between border-t border-[#edf0ee] py-2">
                <span className="text-[#65726c]">{BUCKET_LABELS[bucket]}</span>
                <strong>{formatBps(view.summary.byBucket[bucket].weightBps)}</strong>
              </div>
            ))}
          </div>
        </Card>

        <Card className="p-5">
          <p className="eyebrow">Target vs actual</p>
          <h2 className="mt-1 text-xl font-semibold">目标区间与偏离</h2>
          <div className="mt-6 grid gap-5">
            {ASSET_BUCKETS.map((bucket) => {
              const actual = view.summary.byBucket[bucket].weightBps;
              const target = targets.get(bucket);
              const targetBps = target?.targetBps ?? 0;
              const delta = actual - targetBps;
              return (
                <div key={bucket}>
                  <div className="mb-2 flex items-center justify-between text-sm">
                    <span className="font-medium">{BUCKET_LABELS[bucket]}</span>
                    <span className={delta > 0 ? "text-[#9d5f13]" : "text-[#60716a]"}>
                      {formatBps(actual)} / 目标 {formatBps(targetBps)}
                    </span>
                  </div>
                  <div className="h-2.5 overflow-hidden rounded-full bg-[#edf0ee]">
                    <div className="h-full rounded-full bg-[#315f4d]" style={{ width: `${Math.min(100, actual / 50)}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      </section>

      <section className="mb-5">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <p className="eyebrow">Asset scores</p>
            <h2 className="mt-1 text-xl font-semibold">资产桶评分</h2>
          </div>
          <Link href="/scores" className="flex items-center gap-1 text-sm font-semibold text-[#315f4d]">查看解释 <ArrowRight size={15} /></Link>
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {(["GOLD", "VALUE_DIVIDEND", "TECH_GROWTH", "BROAD_EQUITY"] as AssetBucket[]).map((bucket) => {
            const score = latestScores.get(bucket);
            return (
              <Card key={bucket} className="p-5">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-sm text-[#69766f]">{BUCKET_LABELS[bucket]}</p>
                    {score ? (
                      <ScoreExplanationTooltip
                        score={score.opportunityScore}
                        cheapness={score.cheapnessScore}
                        fundamental={score.fundamentalScore}
                        trend={score.trendScore}
                        confidence={score.confidence as keyof typeof CONFIDENCE_LABELS}
                        state={score.recommendationState as keyof typeof STATE_LABELS}
                      />
                    ) : <strong className="mt-2 block text-3xl">—</strong>}
                  </div>
                  <StatusPill tone={score?.confidence === "LOW" ? "warn" : score ? "good" : "neutral"}>
                    {score ? CONFIDENCE_LABELS[score.confidence as keyof typeof CONFIDENCE_LABELS] : "待录入"}
                  </StatusPill>
                </div>
                <p className="mt-5 border-t border-[#e7ece8] pt-4 text-sm font-semibold">
                  {score ? STATE_LABELS[score.recommendationState as keyof typeof STATE_LABELS] : "尚无可计算评分"}
                </p>
              </Card>
            );
          })}
        </div>
      </section>

      <section className="grid gap-5 lg:grid-cols-2">
        <Card className="p-5">
          <div className="flex items-center gap-2"><ShieldCheck size={18} className="text-[#315f4d]" /><h2 className="font-semibold">最新信号</h2></div>
          {signals.length === 0 ? <EmptyState text="尚无新信号；同方向状态不会重复提醒" /> : (
            <div className="mt-4 grid gap-3">{signals.map((signal) => <div key={signal.id} className="rounded-xl bg-[#f5f7f5] p-3 text-sm">{signal.summary}</div>)}</div>
          )}
        </Card>
        <Card className="p-5">
          <div className="flex items-center gap-2"><Clock3 size={18} className="text-[#315f4d]" /><h2 className="font-semibold">数据新鲜度</h2></div>
          <p className="mt-4 text-sm leading-6 text-[#65726c]">持仓金额仍以你的手工记录为准；资产评分已由 Tushare 自动观察值计算{latestScoreDate ? `，最新数据截至 ${latestScoreDate}` : ""}。每项评分保留来源、数据日期和可信度。</p>
          <Link href="/data-status" className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-[#315f4d]">查看数据源 <ArrowRight size={15} /></Link>
        </Card>
      </section>
    </>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="my-6 rounded-xl border border-dashed border-[#cfd8d2] bg-[#f8faf8] px-4 py-8 text-center text-sm text-[#718078]">{text}</div>;
}
