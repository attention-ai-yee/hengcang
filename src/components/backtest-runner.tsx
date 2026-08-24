"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export function BacktestRunner() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/backtest/run", { method: "POST" });
      const body = (await response.json()) as { data?: unknown; error?: { message?: string } };
      if (!response.ok) {
        setMessage(body?.error?.message ?? "回测失败");
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