import Link from "next/link";
import { Card, PageIntro, StatusPill } from "@/components/ui";
import { formatBps, formatMoneyMinor } from "@/domain/portfolio";
import { ASSET_BUCKETS, type AssetBucket } from "@/domain/types";
import { needsThesis } from "@/domain/thesis";
import { BUCKET_LABELS, instrumentTypeLabel, THESIS_ATTENTION_LABELS } from "@/lib/presentation";
import { getPortfolioView } from "@/server/portfolio-service";
import { listThesisSummaries, type ThesisSummary } from "@/server/thesis-service";

export const dynamic = "force-dynamic";

/** 有评分的资产桶；海外权益、现金债券、其他不打分，低于区间时直接按目标补，不用等评分（复查发现） */
const SCORED_BUCKETS: ReadonlySet<AssetBucket> = new Set<AssetBucket>(["GOLD", "VALUE_DIVIDEND", "TECH_GROWTH", "BROAD_EQUITY"]);

export default async function HoldingsPage() {
  const [view, theses] = await Promise.all([getPortfolioView(), listThesisSummaries()]);
  // 占比与预留资金扣除已在服务层统一计算（Code Review M15），这里只做展示。
  const risks = new Map(view.holdingRisks.map((risk) => [risk.id, risk]));
  // 再平衡参考所需（原 /rebalance 页逻辑，随菜单合并迁入）
  const total = BigInt(view.summary.investableAssetsMinor);
  const targets = new Map(view.targets.map((target) => [target.assetBucket, target]));
  return (
    <>
      <PageIntro
        eyebrow="Holdings & risk"
        title="持仓与风险"
        description="集中度按可投资资产计算（已扣除预留资金）；未拆分的账户汇总不会被视为已经分散。"
        action={<Link href="/onboarding" className="rounded-xl bg-[#173f32] px-4 py-2.5 text-sm font-semibold text-white">新增持仓</Link>}
      />
      {!view.summary.concentrationComplete && (
        <Card className="mb-5 border-[#ead7b7] bg-[#fffaf1] p-4 text-sm text-[#795f35]">
          集中度分析不完整：{view.summary.unresolvedHoldings.join("、")} 需要进一步拆分。
        </Card>
      )}
      <Card className="overflow-x-auto p-2">
        <table className="data-table min-w-[1020px]">
          <thead><tr><th>标的</th><th>资产桶</th><th>当前市值</th><th>可投资资产占比</th><th>类型</th><th>状态</th><th>投资逻辑</th><th>数据时间</th></tr></thead>
          <tbody>
            {view.holdings.map((holding) => {
              const value = BigInt(holding.marketValueMinor);
              const bps = risks.get(holding.id)?.weightBps ?? 0;
              const risk = risks.get(holding.id);
              return (
                <tr key={holding.id}>
                  <td><strong>{holding.name}</strong><span className="mt-1 block text-xs text-[#78847e]">{holding.symbol ?? "无代码"}</span></td>
                  <td>{BUCKET_LABELS[holding.assetBucket as AssetBucket]}</td>
                  <td>{formatMoneyMinor(value)}</td>
                  <td>{formatBps(bps)}</td>
                  <td>{instrumentTypeLabel(holding.instrumentType)}</td>
                  <td className="space-x-1">{risk?.isOverweight && <StatusPill tone="danger">超配（单股/ETF 上限 {formatBps(risk.applicableLimitBps ?? 0)}）</StatusPill>}{risk && !risk.isOverweight && !risk.canAdd && <StatusPill tone="warn">已达上限</StatusPill>}{holding.isApproximate && <StatusPill tone="warn">约数</StatusPill>}{holding.needsBreakdown && <StatusPill tone="danger">待拆分</StatusPill>}{!holding.isApproximate && !holding.needsBreakdown && <StatusPill tone="good">已确认</StatusPill>}</td>
                  <td><ThesisCell holdingId={holding.id} summary={theses.get(holding.id)} required={needsThesis(holding)} /></td>
                  <td>{holding.asOf}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
      {/* 再平衡参考：原独立菜单并入持仓页（目标权重 vs 当前占比） */}
      <div className="mt-8">
        <h2 className="text-lg font-semibold text-[#27342e]">再平衡参考</h2>
        <p className="mt-1 text-sm text-[#68756e]">差额仅用于理解偏离；只有评分、仓位上限、硬风险和冷却条件同时允许时，系统才会显示可执行状态。</p>
      </div>
      <div className="mt-4 grid gap-4">
        {ASSET_BUCKETS.map((bucket) => {
          const current = BigInt(view.summary.byBucket[bucket].investableValueMinor);
          const actualBps = view.summary.byBucket[bucket].weightBps;
          const target = targets.get(bucket);
          const targetBps = target?.targetBps ?? 0;
          const targetValue = (total * BigInt(targetBps)) / 10_000n;
          const difference = targetValue - current;
          const withinBand = target ? actualBps >= target.minBps && actualBps <= target.maxBps : true;
          return (
            <Card key={bucket} className="grid gap-4 p-5 md:grid-cols-[1fr_auto_auto] md:items-center">
              <div><h3 className="font-semibold">{BUCKET_LABELS[bucket]}</h3><p className="mt-1 text-sm text-[#68756e]">当前 {formatBps(actualBps)} · 目标 {formatBps(targetBps)} · 区间 {formatBps(target?.minBps ?? 0)}–{formatBps(target?.maxBps ?? 0)}</p></div>
              <div className="text-left md:text-right"><span className="block text-xs text-[#728078]">回到中性的参考差额</span><strong>{difference >= 0n ? "+" : "−"}{formatMoneyMinor(difference >= 0n ? difference : -difference)}</strong></div>
              <StatusPill tone={withinBand ? "good" : "warn"}>{withinBand ? "保持" : actualBps > (target?.maxBps ?? 0) ? "停止新增" : SCORED_BUCKETS.has(bucket) ? "等待评分确认" : "低于区间：新增资金优先补足"}</StatusPill>
            </Card>
          );
        })}
      </div>
    </>
  );
}

/** 持仓级投资逻辑状态（v2，§4）：触发未复核 → 暂停新增；集中持仓没写逻辑 → 提醒补写。 */
function ThesisCell({ holdingId, summary, required }: { holdingId: string; summary?: ThesisSummary; required: boolean }) {
  const pill = summary?.status === "BREACHED"
    ? <StatusPill tone="danger">{THESIS_ATTENTION_LABELS.BREACHED}</StatusPill>
    : summary && summary.pendingNews > 0
      ? <StatusPill tone="warn">{THESIS_ATTENTION_LABELS.NEWS_TO_CONFIRM}</StatusPill>
      : summary?.status === "INTACT"
      ? <StatusPill tone={summary.reviewDue ? "warn" : "good"}>{summary.reviewDue ? THESIS_ATTENTION_LABELS.REVIEW_DUE : "逻辑完好"}</StatusPill>
      : required
        ? <StatusPill tone="warn">{THESIS_ATTENTION_LABELS.MISSING}</StatusPill>
        : null;
  return (
    <span className="flex flex-wrap items-center gap-2">
      {pill}
      <Link href={`/holdings/${holdingId}`} className="text-xs font-semibold text-[#315f4d] underline">{summary ? "查看" : "写逻辑"}</Link>
    </span>
  );
}
