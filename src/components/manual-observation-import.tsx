"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BUCKET_LABELS } from "@/lib/presentation";
import type { ScorableAssetBucket } from "@/domain/types";

type Format = "csv" | "json";
interface PreviewRow {
  subjectId: ScorableAssetBucket;
  metricKey: string;
  value: string;
  unit: string;
  asOf: string;
  availableAt: string;
}
interface PreviewData {
  digest: string;
  totalRows: number;
  validRows: number;
  duplicateRows: number;
  errors: Array<{ row: number; field: string; message: string }>;
  summary: Array<{ subjectId: ScorableAssetBucket; metricCount: number; observationCount: number; latestAsOf: string }>;
  previewRows: PreviewRow[];
}

export function ManualObservationImport() {
  const router = useRouter();
  const [format, setFormat] = useState<Format>("csv");
  const [content, setContent] = useState("");
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  function changeContent(value: string, nextFormat = format) {
    setContent(value);
    setFormat(nextFormat);
    setPreview(null);
    setStatus("");
  }

  async function loadFile(file: File | undefined) {
    if (!file) return;
    const nextFormat: Format = file.name.toLowerCase().endsWith(".json") ? "json" : "csv";
    changeContent(await file.text(), nextFormat);
  }

  async function runPreview() {
    setBusy(true);
    setStatus("正在校验…");
    try {
      const response = await fetch("/api/data/import/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ format, content }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "预览失败");
      setPreview(body.data);
      setStatus(body.meta?.canCommit ? "校验通过，可以提交" : "请先修正下方错误");
    } catch (error) {
      setPreview(null);
      setStatus(error instanceof Error ? error.message : "预览失败");
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!preview) return;
    setBusy(true);
    setStatus("正在写入观察值并计算评分…");
    try {
      const response = await fetch("/api/data/import/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ format, content, digest: preview.digest }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "提交失败");
      const saved = (body.data.scores as Array<{ saved: boolean }>).filter((score) => score.saved).length;
      setStatus(`已提交 ${body.data.import.committed} 条观察值，生成或更新 ${saved} 个评分快照`);
      router.refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "提交失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="rounded-xl border border-[#cfd8d2] bg-white px-3 py-2.5 font-semibold">
          选择 CSV / JSON
          <input className="sr-only" type="file" accept=".csv,.json,text/csv,application/json" onChange={(event) => void loadFile(event.target.files?.[0])} />
        </label>
        <select value={format} onChange={(event) => changeContent(content, event.target.value as Format)} className="rounded-xl border border-[#cfd8d2] bg-white px-3 py-2.5">
          <option value="csv">CSV</option><option value="json">JSON</option>
        </select>
        <a href="/templates/manual-observations.csv" download className="font-semibold text-[#315f4d]">下载 CSV 模板</a>
        <a href="/templates/manual-observations.json" download className="font-semibold text-[#315f4d]">下载 JSON 模板</a>
      </div>
      <textarea
        value={content}
        onChange={(event) => changeContent(event.target.value)}
        rows={8}
        spellCheck={false}
        placeholder="选择文件，或在此粘贴 CSV / JSON 内容"
        className="w-full rounded-xl border border-[#cfd8d2] bg-white p-3 font-mono text-xs leading-5"
      />
      <div className="flex flex-wrap items-center gap-3">
        <button disabled={busy || content.trim() === ""} onClick={() => void runPreview()} className="rounded-xl bg-[#173f32] px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40">校验并预览</button>
        <button disabled={busy || !preview || preview.errors.length > 0 || preview.validRows === 0} onClick={() => void commit()} className="rounded-xl border border-[#315f4d] bg-white px-4 py-2.5 text-sm font-semibold text-[#315f4d] disabled:cursor-not-allowed disabled:opacity-40">提交并计算评分</button>
        <span className="text-sm text-[#66736d]" aria-live="polite">{status}</span>
      </div>
      {preview && <Preview data={preview} />}
    </div>
  );
}

function Preview({ data }: { data: PreviewData }) {
  return (
    <div className="grid gap-4 border-t border-[#e3e8e5] pt-4">
      <div className="flex flex-wrap gap-2 text-xs">
        <span className="rounded-full bg-[#edf3ef] px-3 py-1.5">总行数 {data.totalRows}</span>
        <span className="rounded-full bg-[#e0eee6] px-3 py-1.5">有效 {data.validRows}</span>
        <span className="rounded-full bg-[#f1f2f1] px-3 py-1.5">文件内重复 {data.duplicateRows}</span>
        <span className="rounded-full bg-[#fff0d5] px-3 py-1.5">错误 {data.errors.length}</span>
      </div>
      {data.errors.length > 0 && <ul className="rounded-xl bg-[#fff7e8] p-4 text-sm text-[#805615]">{data.errors.slice(0, 20).map((error, index) => <li key={`${error.row}-${error.field}-${index}`}>第 {error.row} 行 · {error.field}：{error.message}</li>)}</ul>}
      {data.summary.length > 0 && <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">{data.summary.map((item) => <div key={item.subjectId} className="rounded-xl bg-[#f2f5f2] p-3 text-sm"><strong>{BUCKET_LABELS[item.subjectId]}</strong><p className="mt-1 text-xs text-[#6b7871]">{item.metricCount} 项指标 · {item.observationCount} 条 · 截至 {item.latestAsOf}</p></div>)}</div>}
      {data.previewRows.length > 0 && <div className="overflow-x-auto"><table className="data-table min-w-[760px]"><thead><tr><th>资产桶</th><th>指标</th><th>值</th><th>单位</th><th>数据日期</th><th>可用日期</th></tr></thead><tbody>{data.previewRows.map((row, index) => <tr key={`${row.subjectId}-${row.metricKey}-${row.asOf}-${index}`}><td>{BUCKET_LABELS[row.subjectId]}</td><td>{row.metricKey}</td><td>{row.value}</td><td>{row.unit}</td><td>{row.asOf}</td><td>{row.availableAt.slice(0, 10)}</td></tr>)}</tbody></table></div>}
    </div>
  );
}
