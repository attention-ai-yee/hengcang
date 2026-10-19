import { Card, PageIntro, StatusPill } from "@/components/ui";
import { AutomaticDataRefresh } from "@/components/automatic-data-refresh";
import { ManualObservationImport } from "@/components/manual-observation-import";
import { listProviderStatuses } from "@/db/queries";
import { METRIC_CATALOG } from "@/metrics/catalog";
import { getTushareScoreProxies } from "@/providers/tushare/proxies";
import { BUCKET_LABELS } from "@/lib/presentation";

export const dynamic = "force-dynamic";

export default async function DataStatusPage() {
  const statuses = await listProviderStatuses();
  const proxies = getTushareScoreProxies();
  return (
    <>
      <PageIntro eyebrow="Data provenance" title="数据状态" description="日常只需一键刷新。系统自动获取历史行情和可用估值，写入观察值并重算评分；接口权限不足时保留旧数据并明确提示。" />
      <Card className="mb-5 p-5">
        <h2 className="text-lg font-semibold">自动获取并计算</h2>
        <p className="mt-1 text-sm leading-6 text-[#68756e]">自动拉取近 5 年数据。手工锁定值仍有最高优先级，自动刷新不会覆盖它。</p>
        <div className="mt-4"><AutomaticDataRefresh /></div>
        <details className="mt-5 rounded-xl border border-[#dce3de] p-4 text-sm">
          <summary className="cursor-pointer font-semibold">查看当前评分代理</summary>
          <div className="mt-3 grid gap-2 md:grid-cols-2">{proxies.map((proxy) => <div key={proxy.bucket} className="rounded-lg bg-[#f2f5f2] px-3 py-2"><strong>{BUCKET_LABELS[proxy.bucket]}</strong><span className="ml-2 text-[#68756e]">{proxy.label} · {proxy.symbol}</span></div>)}</div>
          <p className="mt-3 text-xs leading-5 text-[#748078]">代理代码可通过本机环境变量调整；默认不会把单只股票数据冒充指数基本面。</p>
        </details>
      </Card>
      <details className="mb-5 rounded-2xl border border-[#dce3de] bg-white p-5">
        <summary className="cursor-pointer font-semibold">高级兜底：手工 CSV / JSON 导入</summary>
        <p className="mt-2 text-sm leading-6 text-[#68756e]">仅在 Provider 没有权限提供某项指标时使用。先预览校验，再幂等写入；手工数据不会被自动源覆盖。</p>
        <div className="mt-4"><ManualObservationImport /></div>
        <details className="mt-4 rounded-xl border border-[#dce3de] p-4 text-sm">
          <summary className="cursor-pointer font-semibold">查看可用统一指标名</summary>
          <div className="mt-3 flex flex-wrap gap-2">{Object.entries(METRIC_CATALOG).map(([key, value]) => <span key={key} className="rounded-lg bg-[#f2f5f2] px-2.5 py-1.5 font-mono text-xs">{key} · {value.label}</span>)}</div>
        </details>
      </details>
      <Card className="mb-5 p-5">
        <h2 className="text-lg font-semibold">评分数据的降级含义</h2>
        <div className="mt-4 grid gap-3 text-sm md:grid-cols-3">
          <DataCondition title="Expected Earnings Growth" code="MISSING" text="当前数据源未提供一致预期盈利增长；该组件保持缺失，不会伪造。" />
          <DataCondition title="科技 Forward PE" code="PARTIAL_PROXY" text="使用 TTM PE 代理时明确降为 PARTIAL，最高只到中等可信度。" />
          <DataCondition title="指数日估值" code="PERMISSION_DENIED" text="若 index_dailybasic 没有权限，自动使用指数成分股聚合 PE/PB。" />
        </div>
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        {statuses.map((source) => (
          <Card key={source.id} className="p-5">
            <div className="flex items-center justify-between"><h2 className="font-semibold">{source.provider}</h2><StatusPill tone={source.enabled ? "good" : "neutral"}>{source.status}</StatusPill></div>
            <p className="mt-4 text-sm text-[#68756e]">能力：{formatCapabilities(source.capabilitiesJson)}</p>
            <p className="mt-2 text-xs text-[#7a867f]">最后成功：{source.lastSuccessAt ?? "尚未运行"}</p>
            {source.lastErrorCode && <p className="mt-2 text-xs font-medium text-[#8a570b]">数据状态：{statusMeaning(source.lastErrorCode)}</p>}
            {source.lastErrorMessage && <p className="mt-2 text-xs leading-5 text-[#8a570b]">{source.lastErrorMessage}</p>}
          </Card>
        ))}
      </div>
    </>
  );
}

function DataCondition({ title, code, text }: { title: string; code: "MISSING" | "PARTIAL_PROXY" | "PERMISSION_DENIED"; text: string }) {
  const tone = code === "MISSING" ? "neutral" : "warn";
  return <div className="rounded-xl border border-[#dce3de] bg-[#f8faf8] p-4"><div className="flex items-center justify-between gap-3"><strong>{title}</strong><StatusPill tone={tone}>{code}</StatusPill></div><p className="mt-2 leading-6 text-[#68756e]">{text}</p></div>;
}

function formatCapabilities(raw: string) {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.join("、");
    if (parsed && typeof parsed === "object") return Object.entries(parsed as Record<string, string>).map(([key, value]) => `${key}: ${value}`).join("；");
  } catch {}
  return "尚无状态";
}

function statusMeaning(code: string) {
  if (code === "PERMISSION_DENIED") return "权限不足：已保留旧数据并尝试可用的聚合/代理降级";
  if (code === "PARTIAL_FAILURE") return "部分数据不可用：请区分缺失、权限或代理项";
  if (code === "NOT_CONFIGURED") return "未配置：在 .env.local 填写对应的 Key 并重启后生效";
  return code;
}
