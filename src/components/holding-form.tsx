"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

function yuanToMinor(value: string): string {
  const [whole = "0", fraction = ""] = value.trim().split(".");
  return `${whole.replace(/^0+(?=\d)/, "")}${fraction.padEnd(2, "0").slice(0, 2)}`;
}

export function HoldingForm() {
  const router = useRouter();
  const [status, setStatus] = useState<string>("");

  async function submit(formData: FormData) {
    setStatus("保存中…");
    const response = await fetch("/api/portfolio/holdings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: formData.get("name"),
        symbol: formData.get("symbol") || null,
        instrumentType: formData.get("instrumentType"),
        assetBucket: formData.get("assetBucket"),
        marketValueMinor: yuanToMinor(String(formData.get("marketValue"))),
        currency: "CNY",
        isSingleStock: formData.get("isSingleStock") === "on",
        isThematicEtf: formData.get("isThematicEtf") === "on",
        isApproximate: formData.get("isApproximate") === "on",
        needsBreakdown: formData.get("needsBreakdown") === "on",
        asOf: new Date().toISOString().slice(0, 10),
      }),
    });
    setStatus(response.ok ? "已保存" : "保存失败，请检查输入");
    if (response.ok) router.refresh();
  }

  return (
    <form action={submit} className="app-card grid gap-4 p-5 md:grid-cols-2">
      <label className="grid gap-1.5 text-sm">名称<input required name="name" className="rounded-xl border border-[#cfd8d2] bg-white px-3 py-2.5" /></label>
      <label className="grid gap-1.5 text-sm">代码<input name="symbol" className="rounded-xl border border-[#cfd8d2] bg-white px-3 py-2.5" placeholder="可选" /></label>
      <label className="grid gap-1.5 text-sm">类型<select name="instrumentType" className="rounded-xl border border-[#cfd8d2] bg-white px-3 py-2.5"><option value="FUND">基金</option><option value="STOCK">股票</option><option value="ETF">ETF</option><option value="CASH">现金</option><option value="BOND">债券</option><option value="GOLD">黄金</option><option value="ACCOUNT_AGGREGATE">账户汇总</option></select></label>
      <label className="grid gap-1.5 text-sm">资产桶<select name="assetBucket" className="rounded-xl border border-[#cfd8d2] bg-white px-3 py-2.5"><option value="CASH_BONDS">现金与债券</option><option value="GOLD">黄金</option><option value="VALUE_DIVIDEND">红利与价值</option><option value="TECH_GROWTH">科技与成长</option><option value="BROAD_EQUITY">宽基权益</option><option value="OTHER">其他</option></select></label>
      <label className="grid gap-1.5 text-sm md:col-span-2">当前市值（元）<input required name="marketValue" inputMode="decimal" pattern="\d+(\.\d{1,2})?" className="rounded-xl border border-[#cfd8d2] bg-white px-3 py-2.5" /></label>
      <div className="flex flex-wrap gap-4 text-sm md:col-span-2">
        <label><input type="checkbox" name="isSingleStock" className="mr-2" />单一个股</label>
        <label><input type="checkbox" name="isThematicEtf" className="mr-2" />主题 ETF</label>
        <label><input type="checkbox" name="isApproximate" className="mr-2" />约数</label>
        <label><input type="checkbox" name="needsBreakdown" className="mr-2" />后续需要拆分</label>
      </div>
      <div className="flex items-center gap-3 md:col-span-2">
        <button type="submit" className="rounded-xl bg-[#173f32] px-4 py-2.5 text-sm font-semibold text-white">保存持仓</button>
        <span className="text-sm text-[#66736d]" aria-live="polite">{status}</span>
      </div>
    </form>
  );
}
