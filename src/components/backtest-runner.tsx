"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { runBacktestAction } from "@/server/actions/backtest";

export function BacktestRunner() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setMessage(null);
    try {
      // 与刷新一致：走同源 server action，避免配置 REFRESH_TOKEN 后按钮必然 401。
      const result = await runBacktestAction();
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      router.refresh();
    } catch {
      setMessage("回测请求失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={() => void run()}
        disabled={busy}
        className="rounded-xl bg-[#173f32] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#245a48] disabled:opacity-50"
      >
        {busy ? "回测运行中…" : "运行回测"}
      </button>
      {message && <span className="text-sm text-[#b4453d]">{message}</span>}
    </div>
  );
}