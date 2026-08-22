import { Card, PageIntro, StatusPill } from "@/components/ui";
import { ReservedCashForm } from "@/components/reserved-cash-form";
import { getPortfolioRecord, getRiskLimits, listAllocationTargets } from "@/db/queries";
import type { AssetBucket } from "@/domain/types";
import { BUCKET_LABELS } from "@/lib/presentation";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [targets, limits, portfolio] = await Promise.all([listAllocationTargets(), getRiskLimits(), getPortfolioRecord()]);
  return (
    <>
      <PageIntro eyebrow="Configuration" title="设置" description="阈值和权重属于配置，不写死在 UI。API Key 只从服务端环境变量读取。" />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="p-5"><h2 className="font-semibold">战略仓位</h2><div className="mt-4 grid gap-3">{targets.map((target) => <div key={target.id} className="flex items-center justify-between rounded-xl bg-[#f4f6f4] p-3 text-sm"><span>{BUCKET_LABELS[target.assetBucket as AssetBucket]}</span><strong>{target.targetBps / 100}% · {target.minBps / 100}%–{target.maxBps / 100}%</strong></div>)}</div></Card>
        <Card className="p-5"><h2 className="font-semibold">风险上限</h2><div className="mt-4 grid gap-3 text-sm"><SettingRow label="单一个股" value={`${(limits?.singleStockBps ?? 800) / 100}%`} /><SettingRow label="主题 ETF" value={`${(limits?.thematicEtfBps ?? 1500) / 100}%`} /><SettingRow label="单一主题" value={`${(limits?.themeBps ?? 2000) / 100}%`} /><SettingRow label="冷却期" value={`${limits?.cooldownDays ?? 7} 天`} /></div></Card>
        <Card className="p-5"><h2 className="font-semibold">家庭大额支出</h2><ReservedCashForm initialMinor={portfolio?.reservedCashMinor ?? "0"} /></Card>
        <Card className="p-5 lg:col-span-2"><div className="flex items-center justify-between"><div><h2 className="font-semibold">运行模式</h2><p className="mt-2 text-sm text-[#68756e]">本地单用户 · SQLite · Asia/Shanghai · 基础货币 CNY</p></div><StatusPill tone="good">本地优先</StatusPill></div></Card>
      </div>
    </>
  );
}

function SettingRow({ label, value }: { label: string; value: string }) {
  return <div className="flex items-center justify-between border-b border-[#e5eae7] py-2"><span className="text-[#66736d]">{label}</span><strong>{value}</strong></div>;
}
