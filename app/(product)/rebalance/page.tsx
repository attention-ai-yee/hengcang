import { Card, PageIntro, StatusPill } from "@/components/ui";
import { formatBps, formatMoneyMinor } from "@/domain/portfolio";
import { ASSET_BUCKETS } from "@/domain/types";
import { BUCKET_LABELS } from "@/lib/presentation";
import { getPortfolioView } from "@/server/portfolio-service";

export const dynamic = "force-dynamic";

export default async function RebalancePage() {
  const view = await getPortfolioView();
  const total = BigInt(view.summary.investableAssetsMinor);
  const targets = new Map(view.targets.map((target) => [target.assetBucket, target]));
  return (
    <>
      <PageIntro eyebrow="Rebalance guardrails" title="再平衡参考" description="差额仅用于理解偏离；只有评分、仓位上限、硬风险和冷却条件同时允许时，系统才会显示可执行状态。" />
      <div className="grid gap-4">
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
              <div><h2 className="font-semibold">{BUCKET_LABELS[bucket]}</h2><p className="mt-1 text-sm text-[#68756e]">当前 {formatBps(actualBps)} · 目标 {formatBps(targetBps)} · 区间 {formatBps(target?.minBps ?? 0)}–{formatBps(target?.maxBps ?? 0)}</p></div>
              <div className="text-left md:text-right"><span className="block text-xs text-[#728078]">回到中性的参考差额</span><strong>{difference >= 0n ? "+" : "−"}{formatMoneyMinor(difference >= 0n ? difference : -difference)}</strong></div>
              <StatusPill tone={withinBand ? "good" : "warn"}>{withinBand ? "保持" : actualBps > (target?.maxBps ?? 0) ? "停止新增" : "等待评分确认"}</StatusPill>
            </Card>
          );
        })}
      </div>
    </>
  );
}
