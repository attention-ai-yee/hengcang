"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { refreshMarketDataAction } from "@/server/actions/refresh";
import type { AutomaticRefreshReport } from "@/server/automatic-data-refresh-service";
import { BUCKET_LABELS } from "@/lib/presentation";

type RefreshReport = AutomaticRefreshReport;

export function AutomaticDataRefresh({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [report, setReport] = useState<RefreshReport | null>(null);

  async function refresh() {
    setBusy(true);
    setReport(null);
    setMessage("正在从 Tushare 拉取 5 年历史数据并计算评分，通常需要十几秒…");
    try {
      // 走同源 server action：配置 REFRESH_TOKEN 时 API 只接受外部 Bearer 调用，
      // 浏览器端不持有令牌，直接 fetch API 会 401（复查修复）。
      const result = await refreshMarketDataAction();
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      const data = result.report;
      setReport(data);
      const scored = data.buckets.filter((bucket) => bucket.scoreSaved).length;
      setMessage(`刷新完成：写入 ${data.inserted} 条、更新 ${data.updated} 条观察值，生成或更新 ${scored} 类资产评分。`);
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "自动刷新失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => void refresh()}
          className="rounded-xl bg-[#173f32] px-5 py-3 text-sm font-semibold text-white shadow-sm disabled:cursor-wait disabled:opacity-55"
        >
          {busy ? "正在自动获取并计算…" : "一键自动刷新评分"}
        </button>
        <span className="text-sm text-[#66736d]" aria-live="polite">{message}</span>
        {report && <Link href="/scores" className="text-sm font-semibold text-[#315f4d]">查看评分 →</Link>}
      </div>
      {!compact && report && (
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {report.buckets.map((bucket) => (
            <div key={bucket.bucket} className="rounded-xl border border-[#dde5df] bg-white p-4 text-sm">
              <div className="flex items-start justify-between gap-3">
                <strong>{BUCKET_LABELS[bucket.bucket]}</strong>
                <span className="rounded-full bg-[#edf3ef] px-2 py-1 text-[11px] font-semibold">{bucket.scoreSaved ? "已评分" : "待补数据"}</span>
              </div>
              <p className="mt-2 text-xs text-[#68756e]">{bucket.proxy} · {bucket.symbol}</p>
              <p className="mt-1 text-xs text-[#68756e]">{bucket.observationCount} 条 · 截至 {bucket.latestAsOf ?? "—"}</p>
              {bucket.warnings.length > 0 && (
                <p className="mt-2 text-xs leading-5 text-[#8a570b]">{bucket.warnings.join("；")}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
