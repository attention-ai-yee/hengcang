"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

function minorToYuanInput(minor: string): string {
  const normalized = minor.replace(/^0+(?=\d)/, "") || "0";
  const negative = normalized.startsWith("-");
  const digits = negative ? normalized.slice(1) : normalized;
  const whole = digits.slice(0, -2) || "0";
  const fraction = digits.padStart(2, "0").slice(-2);
  const body = fraction === "00" ? whole : whole + "." + fraction;
  return negative ? "-" + body : body;
}

// 直接从分字符串格式化（Code Review M19）：Number 往返会把 0.50 元显示成 "1"，直接保存会改写存储值。
function yuanToMinor(value: string): string {
  const [whole = "0", fraction = ""] = value.trim().split(".");
  return `${whole.replace(/^0+(?=\d)/, "")}${fraction.padEnd(2, "0").slice(0, 2)}`;
}

export function ReservedCashForm({ initialMinor }: { initialMinor: string }) {
  const router = useRouter();
  const [status, setStatus] = useState("");
  const initialYuan = minorToYuanInput(initialMinor); // M19

  async function submit(formData: FormData) {
    setStatus("保存中…");
    const response = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reservedCashMinor: yuanToMinor(String(formData.get("reservedCash"))) }),
    });
    const body = await response.json();
    setStatus(response.ok ? "已保存，仓位比例已按可投资资产重算" : body.error?.message ?? "保存失败");
    if (response.ok) router.refresh();
  }

  return (
    <form action={submit} className="mt-4 grid gap-3">
      <label className="grid gap-1.5 text-sm">
        预留资金（元）
        <input required name="reservedCash" inputMode="decimal" pattern="\d+(\.\d{1,2})?" defaultValue={initialYuan} className="rounded-xl border border-[#cfd8d2] bg-white px-3 py-2.5" />
      </label>
      <p className="text-xs leading-5 text-[#748078]">预留资金优先从现金与债券桶扣除，不进入仓位比例分母。</p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className="rounded-xl bg-[#173f32] px-4 py-2.5 text-sm font-semibold text-white">保存预留资金</button>
        <span className="text-sm text-[#66736d]" aria-live="polite">{status}</span>
      </div>
    </form>
  );
}
