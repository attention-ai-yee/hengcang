"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ASSET_BUCKETS } from "@/domain/types";
import { BUCKET_LABELS } from "@/lib/presentation";
import { DECISION_ACTION_LABELS, DECISION_ACTIONS } from "@/lib/validation";

export function DecisionLogForm() {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [status, setStatus] = useState("");

  async function submit(formData: FormData) {
    setStatus("记录中…");
    const response = await fetch("/api/decisions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        assetBucket: formData.get("assetBucket"),
        action: formData.get("action"),
        rationale: formData.get("rationale"),
      }),
    });
    if (response.ok) {
      setStatus("已记录决策日志");
      formRef.current?.reset();
      router.refresh();
      return;
    }
    const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    setStatus(body?.error?.message ?? "记录失败，请检查资产桶、动作与理由");
  }

  return (
    <form ref={formRef} action={submit} className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      <label className="grid gap-1.5 text-sm">
        资产桶
        <select name="assetBucket" className="rounded-xl border border-[#cfd8d2] bg-white px-3 py-2.5">
          {ASSET_BUCKETS.map((bucket) => (
            <option key={bucket} value={bucket}>{BUCKET_LABELS[bucket]}</option>
          ))}
        </select>
      </label>
      <label className="grid gap-1.5 text-sm">
        动作
        <select name="action" className="rounded-xl border border-[#cfd8d2] bg-white px-3 py-2.5">
          {DECISION_ACTIONS.map((action) => (
            <option key={action} value={action}>{DECISION_ACTION_LABELS[action]}</option>
          ))}
        </select>
      </label>
      <label className="grid gap-1.5 text-sm md:col-span-2">
        理由
        <textarea
          required
          name="rationale"
          rows={3}
          maxLength={500}
          placeholder="当时知道了什么？为什么做这个动作？"
          className="rounded-xl border border-[#cfd8d2] bg-white px-3 py-2.5"
        />
      </label>
      <div className="flex flex-wrap items-center gap-3 md:col-span-2 xl:col-span-4">
        <button type="submit" className="rounded-xl bg-[#173f32] px-4 py-2.5 text-sm font-semibold text-white">记录决策</button>
        <span className="text-sm text-[#66736d]" aria-live="polite">{status}</span>
      </div>
    </form>
  );
}
