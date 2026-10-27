"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { sendJson } from "@/lib/client-fetch";
import { shanghaiDate } from "@/lib/shanghai";

const SCORE_FIELDS = [
  { name: "cheapnessScore", label: "便宜程度分", hint: "越高越便宜" },
  { name: "trendScore", label: "趋势分", hint: "越高越强" },
] as const;

export function ManualScoreForm() {
  const router = useRouter();
  const [status, setStatus] = useState("");

  async function submit(formData: FormData) {
    setStatus("计算中…");
    const result = await sendJson("/api/scores/manual", "POST", {
      assetBucket: formData.get("assetBucket"),
      cheapnessScore: Number(formData.get("cheapnessScore")),
      fundamentalHealth: formData.get("fundamentalHealth"),
      trendScore: Number(formData.get("trendScore")),
      asOf: shanghaiDate(), // M14: 上海时区今天
    }, "计算失败，请检查 0–100 的输入范围与基本面体检选项");
    setStatus(result.ok ? "已生成低可信度评分快照" : result.message);
    if (result.ok) router.refresh();
  }

  return (
    <form action={submit} className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      <label className="grid gap-1.5 text-sm">
        资产桶
        <select name="assetBucket" className="rounded-xl border border-[#cfd8d2] bg-white px-3 py-2.5">
          <option value="GOLD">黄金</option>
          <option value="VALUE_DIVIDEND">红利与价值</option>
          <option value="TECH_GROWTH">科技与成长</option>
          <option value="BROAD_EQUITY">宽基权益</option>
        </select>
      </label>
      <label className="grid gap-1.5 text-sm">
        基本面体检<span className="text-xs text-[#748078]">黄金不适用，可忽略</span>
        <select name="fundamentalHealth" defaultValue="HEALTHY" className="rounded-xl border border-[#cfd8d2] bg-white px-3 py-2.5">
          <option value="HEALTHY">正常：没有恶化迹象</option>
          <option value="DETERIORATING">恶化：暂停新增、重新评估</option>
          <option value="UNKNOWN">数据不足：最多小幅增配</option>
        </select>
      </label>
      {SCORE_FIELDS.map((field) => (
        <label key={field.name} className="grid gap-1.5 text-sm">
          {field.label}<span className="text-xs text-[#748078]">{field.hint}</span>
          <input required name={field.name} type="number" min="0" max="100" step="1" defaultValue="50" className="rounded-xl border border-[#cfd8d2] bg-white px-3 py-2.5" />
        </label>
      ))}
      <div className="flex flex-wrap items-center gap-3 md:col-span-2 xl:col-span-4">
        <button type="submit" className="rounded-xl bg-[#173f32] px-4 py-2.5 text-sm font-semibold text-white">计算并保存</button>
        <span className="text-sm text-[#66736d]" aria-live="polite">{status}</span>
      </div>
    </form>
  );
}
