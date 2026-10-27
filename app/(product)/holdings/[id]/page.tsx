import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, PageIntro, StatusPill } from "@/components/ui";
import { DismissAiTriggerButton, NewsDecisionButtons, NewsScanButton } from "@/components/news-watch";
import { ThesisEditor, ThesisEventForm, ThesisReviewForm } from "@/components/thesis-forms";
import { NEWS_MAX_AGE_DAYS } from "@/domain/news-watch";
import type { AssetBucket } from "@/domain/types";
import { BUCKET_LABELS } from "@/lib/presentation";
import { shanghaiDate, shanghaiDateTime } from "@/lib/shanghai";
import { isNewsWatchConfigured, listNewsItems, newsItemsForEvents, type NewsItemRow } from "@/server/news-watch-service";
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
  const newsConfigured = isNewsWatchConfigured();
  const news = view.thesis ? listNewsItems(view.thesis.id) : [];
  const eventById = new Map(view.events.map((event) => [event.id, event]));
  const triggerNews = newsItemsForEvents(triggered.flatMap((breaker) => breaker.triggeredByEventId ? [breaker.triggeredByEventId] : []));
  const queries = readQueries(view.thesis?.newsQueriesJson ?? null);
  return (
    <>
      <PageIntro
        eyebrow="Thesis & events"
        title={view.holding.name}
        description={newsConfigured
          ? "写下为什么持有、什么情况说明逻辑失效。AI 每天自动搜索新闻、对照失效条件判断：证据确凿的自动暂停新增，其余等你一键确认；写完复核才能解除。消息不会自动变成分数。"
          : "写下为什么持有、什么情况说明逻辑失效。配置 DeepSeek 后 AI 每天自动搜索新闻、对照失效条件判断，也可以手工补记；对应到失效条件即暂停新增，写完复核才能解除。消息不会自动变成分数。"}
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
                {(() => {
                  const event = breaker.triggeredByEventId ? eventById.get(breaker.triggeredByEventId) : undefined;
                  const item = breaker.triggeredByEventId ? triggerNews.get(breaker.triggeredByEventId) : undefined;
                  if (event?.origin !== "AI" || !item) return null;
                  return (
                    <div className="grid gap-2 rounded-xl bg-white p-3 text-sm">
                      <p>
                        <StatusPill tone="warn">AI 判断</StatusPill>
                        <span className="ml-2">来自新闻：</span>
                        <a href={item.url} target="_blank" rel="noopener noreferrer nofollow" className="text-[#315f4d] underline">{item.title}</a>
                        <span className="ml-1 text-xs text-[#7a867f]">（{item.siteName ?? "来源未知"}{item.publishedOn ? ` · ${item.publishedOn}` : ""}）</span>
                      </p>
                      {item.evidence && <blockquote className="border-l-2 border-[#efc8c3] pl-3 text-[#5b4a48]">「{item.evidence}」</blockquote>}
                      <p className="text-xs text-[#68756e]">先看原文：判断属实就在下面写复核；是误判就一键撤销（不算复核）。</p>
                      <DismissAiTriggerButton newsItemId={item.id} />
                    </div>
                  );
                })()}
                <ThesisReviewForm holdingId={view.holding.id} breakerId={breaker.id} submitLabel="写复核并解除暂停" />
              </div>
            ))}
          </div>
        </Card>
      )}

      {view.thesis && (
        <Card className="mb-5 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="max-w-2xl">
              <h2 className="font-semibold">AI 新闻监控</h2>
              <p className="mt-1 text-sm text-[#68756e]">
                每天自动搜索最近 {NEWS_MAX_AGE_DAYS} 天的新闻，对照失效条件逐条判断。证据确凿（原文能逐字找到、来源可靠、{NEWS_MAX_AGE_DAYS} 天内、AI 高置信）才自动暂停新增；其余标为「可能触发」，等你一键确认或忽略。
              </p>
            </div>
            {newsConfigured && <NewsScanButton holdingId={view.holding.id} />}
          </div>
          {!newsConfigured ? (
            <p className="mt-4 rounded-xl bg-[#fffaf1] p-3 text-sm text-[#795f35]">在 <code>.env.local</code> 里配置 <code>DEEPSEEK_API_KEY</code> 并重启后开启。</p>
          ) : (
            <>
              <p className="mt-3 text-xs text-[#7a867f]">
                上次检查：{view.thesis.newsScannedAt ? shanghaiDateTime(view.thesis.newsScannedAt) : "还没有"}
                {queries.length > 0 ? ` · 搜索词：${queries.join(" / ")}` : ""}
              </p>
              <ul className="mt-4 grid gap-3">
                {news.length === 0 ? (
                  <li className="text-sm text-[#718078]">还没有发现相关新闻</li>
                ) : news.map((item) => {
                  const pending = item.verdict === "POSSIBLE" && item.status === "OPEN";
                  return (
                    <li key={item.id} className="rounded-xl border border-[#e2e8e4] p-3 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <NewsVerdictPill item={item} />
                        <a href={item.url} target="_blank" rel="noopener noreferrer nofollow" className="font-semibold text-[#27342e] underline">{item.title}</a>
                        <span className="text-xs text-[#7a867f]">{item.siteName ?? "来源未知"}{item.publishedOn ? ` · ${item.publishedOn}` : ""}</span>
                      </div>
                      <p className="mt-1.5 text-[#4f5c55]">{item.summary}</p>
                      {pending && <div className="mt-2"><NewsDecisionButtons newsItemId={item.id} breakerDescription={item.breakerId ? breakerById.get(item.breakerId) : undefined} /></div>}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="mb-4 font-semibold">投资逻辑与失效条件</h2>
          <ThesisEditor
            // 条件或状态在别处变了（记录消息、AI 触发、复核）就重新载入编辑框，免得拿旧 id 保存
            key={view.breakers.map((breaker) => `${breaker.id}:${breaker.status}`).join("|")}
            holdingId={view.holding.id}
            initialThesis={view.thesis?.thesis ?? ""}
            initialBreakers={view.breakers.map((breaker) => ({ id: breaker.id, description: breaker.description, status: breaker.status }))}
            aiDraft={newsConfigured && !view.thesis}
          />
        </Card>
        <div className="grid gap-5">
          <Card className="p-5">
            <h2 className="font-semibold">{view.thesis ? "手工补记一条消息（可选）" : "新闻怎么进来"}</h2>
            {view.thesis ? (
              <>
                <p className="mb-4 mt-1 text-sm text-[#68756e]">AI 没搜到、但你知道的消息可以在这里补上。</p>
                <ThesisEventForm holdingId={view.holding.id} breakers={active.map((breaker) => ({ id: breaker.id, description: breaker.description }))} />
              </>
            ) : (
              <p className="mt-3 text-sm leading-6 text-[#68756e]">
                {newsConfigured
                  ? "保存投资逻辑和失效条件后，AI 每天自动搜索这只持仓的新闻并对照判断，不用你看网页、录消息。可以先点「让 AI 起草」，改好再保存。"
                  : "保存投资逻辑和失效条件后即可记录消息；在 .env.local 配置 DEEPSEEK_API_KEY 后，AI 会每天自动搜索新闻并对照判断。"}
              </p>
            )}
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
                <td className="space-x-1 whitespace-nowrap">
                  {event.kind === "REVIEW" ? <StatusPill tone="good">复核</StatusPill> : event.kind === "DISMISS" ? <StatusPill tone="neutral">撤销误判</StatusPill> : <StatusPill tone="neutral">消息</StatusPill>}
                  {event.origin === "AI" && <StatusPill tone="warn">AI</StatusPill>}
                </td>
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

function readQueries(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/** 新闻的判断结果与处理状态 */
function NewsVerdictPill({ item }: { item: NewsItemRow }) {
  if (item.status === "DISMISSED") return <StatusPill tone="neutral">{item.verdict === "TRIGGER" || item.eventId ? "已撤销（误判）" : "已忽略"}</StatusPill>;
  if (item.verdict === "TRIGGER") return <StatusPill tone="danger">已自动触发</StatusPill>;
  if (item.verdict === "POSSIBLE") return item.status === "CONFIRMED" ? <StatusPill tone="danger">已确认触发</StatusPill> : <StatusPill tone="warn">可能触发：待确认</StatusPill>;
  return <StatusPill tone="neutral">相关</StatusPill>;
}
