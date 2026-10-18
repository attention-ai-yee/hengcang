import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, PageIntro, StatusPill } from "@/components/ui";
import { ThesisEditor, ThesisEventForm, ThesisReviewForm } from "@/components/thesis-forms";
import type { AssetBucket } from "@/domain/types";
import { BUCKET_LABELS } from "@/lib/presentation";
import { shanghaiDate, shanghaiDateTime } from "@/lib/shanghai";
import { getThesisView } from "@/server/thesis-service";

export const dynamic = "force-dynamic";

/**
 * 持仓的投资逻辑与事件日志（v2，docs/hengcang_v2_allocation_fundamentals_thesis.md §4）：
 * 消息不打分，以事件记录；对应到失效条件即触发，该持仓暂停新增，写完复核才能解除。
 */
export default async function HoldingThesisPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const view = await getThesisView(id);
  if (!view) notFound();
  const breakerById = new Map(view.breakers.map((breaker) => [breaker.id, breaker.description]));
  const triggered = view.breakers.filter((breaker) => breaker.status === "TRIGGERED");
  const active = view.breakers.filter((breaker) => breaker.status !== "TRIGGERED");
  return (
    <>
      <PageIntro
        eyebrow="Thesis & events"
        title={view.holding.name}
        description="写下为什么持有、什么情况说明逻辑失效。消息以事件记录：对应到失效条件即触发，该持仓暂停新增，写完复核才能解除。消息不会自动变成分数。"
        action={<Link href="/holdings" className="rounded-xl border border-[#cfd8d2] px-4 py-2.5 text-sm font-semibold text-[#315f4d]">返回持仓</Link>}
      />
      <Card className="mb-5 flex flex-wrap items-center gap-3 p-5 text-sm">
        <span className="text-[#68756e]">{BUCKET_LABELS[view.holding.assetBucket as AssetBucket]}{view.holding.symbol ? ` · ${view.holding.symbol}` : ""}</span>
        {view.status === "BREACHED" && <StatusPill tone="danger">逻辑待复核：暂停新增</StatusPill>}
        {view.status === "INTACT" && <StatusPill tone={view.reviewDue ? "warn" : "good"}>{view.reviewDue ? "季度复核到期" : "逻辑完好"}</StatusPill>}
        {view.status === "NO_THESIS" && <StatusPill tone={view.needsThesis ? "warn" : "neutral"}>{view.needsThesis ? "集中持仓：请写投资逻辑" : "尚未写投资逻辑"}</StatusPill>}
        <span className="text-[#68756e]">最近复核：{view.lastReviewOn ?? "还没有"}</span>
      </Card>

      {triggered.length > 0 && (
        <Card className="mb-5 border-[#efc8c3] bg-[#fff7f6] p-5">
          <h2 className="font-semibold text-[#91352f]">已触发的失效条件</h2>
          <div className="mt-4 grid gap-5">
            {triggered.map((breaker) => (
              <div key={breaker.id} className="grid gap-2">
                <p className="text-sm font-semibold">「{breaker.description}」<span className="ml-2 font-normal text-[#68756e]">触发于 {breaker.triggeredAt ? shanghaiDate(new Date(breaker.triggeredAt)) : "—"}</span></p>
                <ThesisReviewForm holdingId={view.holding.id} breakerId={breaker.id} submitLabel="写复核并解除暂停" />
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="mb-4 font-semibold">投资逻辑与失效条件</h2>
          <ThesisEditor
            holdingId={view.holding.id}
            initialThesis={view.thesis?.thesis ?? ""}
            initialBreakers={view.breakers.map((breaker) => ({ id: breaker.id, description: breaker.description, status: breaker.status }))}
          />
        </Card>
        <div className="grid gap-5">
          <Card className="p-5">
            <h2 className="mb-4 font-semibold">记录一条消息</h2>
            {view.thesis
              ? <ThesisEventForm holdingId={view.holding.id} breakers={active.map((breaker) => ({ id: breaker.id, description: breaker.description }))} />
              : <p className="text-sm text-[#68756e]">先写下投资逻辑和失效条件，再记录消息。</p>}
          </Card>
          {view.thesis && (
            <Card className="p-5">
              <h2 className="font-semibold">定期复核</h2>
              <p className="mb-4 mt-1 text-sm text-[#68756e]">没有触发也每季度过一遍（财报季前后最合适）：逻辑还成立吗？</p>
              <ThesisReviewForm holdingId={view.holding.id} submitLabel="记录本次复核" />
            </Card>
          )}
        </div>
      </div>

      <Card className="mt-5 overflow-x-auto p-2">
        <table className="data-table min-w-[760px]">
          <thead><tr><th>日期</th><th>类型</th><th>内容</th><th>对应失效条件</th><th>来源</th><th>记录时间</th></tr></thead>
          <tbody>
            {view.events.length === 0 ? (
              <tr><td colSpan={6} className="text-center text-[#718078]">还没有事件记录</td></tr>
            ) : view.events.map((event) => (
              <tr key={event.id}>
                <td>{event.occurredOn}</td>
                <td>{event.kind === "REVIEW" ? <StatusPill tone="good">复核</StatusPill> : <StatusPill tone="neutral">消息</StatusPill>}</td>
                <td className="max-w-md whitespace-pre-wrap">{event.summary}</td>
                <td>{event.breakerId ? breakerById.get(event.breakerId) ?? "（已删除）" : "—"}</td>
                <td>{event.sourceUrl ? <a href={event.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-[#315f4d] underline">原文</a> : "—"}</td>
                <td>{shanghaiDateTime(event.recordedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
