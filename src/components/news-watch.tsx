"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { confirmNewsAction, dismissNewsAction, scanHoldingNewsAction, type NewsActionResult } from "@/server/actions/news";

const smallButton = "rounded-lg border border-[#cfd8d2] bg-white px-3 py-1.5 text-xs font-semibold text-[#315f4d] disabled:opacity-60";

async function runAction(action: () => Promise<NewsActionResult>): Promise<NewsActionResult> {
  try {
    return await action();
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "操作失败" };
  }
}

/** 立即检查这只持仓的新闻（忽略每天一次的间隔）。 */
export function NewsScanButton({ holdingId }: { holdingId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function scan() {
    setBusy(true);
    setMessage("正在搜索并逐条判断，通常需要半分钟到两分钟…");
    const result = await runAction(() => scanHoldingNewsAction(holdingId));
    setBusy(false);
    setMessage(result.message);
    if (result.ok) router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" disabled={busy} onClick={() => void scan()} className="rounded-xl bg-[#173f32] px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-wait disabled:opacity-60">
        {busy ? "检查中…" : "立即检查新闻"}
      </button>
      <span className="text-sm text-[#66736d]" aria-live="polite">{message}</span>
    </div>
  );
}

/** 「可能触发」：一键确认（触发对应条件）或忽略。 */
export function NewsDecisionButtons({ newsItemId, breakerDescription }: { newsItemId: string; breakerDescription: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function decide(action: () => Promise<NewsActionResult>) {
    setBusy(true);
    const result = await runAction(action);
    setBusy(false);
    setMessage(result.message);
    if (result.ok) router.refresh();
  }

  return (
    <span className="flex flex-wrap items-center gap-2">
      <button type="button" disabled={busy} onClick={() => void decide(() => confirmNewsAction(newsItemId))} className={`${smallButton} border-[#efc8c3] text-[#91352f]`}>
        确认触发「{breakerDescription}」
      </button>
      <button type="button" disabled={busy} onClick={() => void decide(() => dismissNewsAction(newsItemId))} className={smallButton}>忽略</button>
      {message && <span className="text-xs text-[#66736d]" aria-live="polite">{message}</span>}
    </span>
  );
}

/** AI 自动触发的条件：判断有误时一键撤销（记「撤销误判」，不算复核）。 */
export function DismissAiTriggerButton({ newsItemId }: { newsItemId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function dismiss() {
    if (!window.confirm("确定这是 AI 误判、要撤销暂停吗？")) return;
    setBusy(true);
    const result = await runAction(() => dismissNewsAction(newsItemId));
    setBusy(false);
    setMessage(result.ok ? "已撤销" : result.message);
    if (result.ok) router.refresh();
  }

  return (
    <span className="flex flex-wrap items-center gap-2">
      <button type="button" disabled={busy} onClick={() => void dismiss()} className={smallButton}>误判，撤销</button>
      {message && <span className="text-xs text-[#66736d]" aria-live="polite">{message}</span>}
    </span>
  );
}
