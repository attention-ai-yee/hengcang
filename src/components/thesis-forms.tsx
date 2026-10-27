"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MAX_THESIS_BREAKERS } from "@/domain/thesis";
import { sendJson } from "@/lib/client-fetch";
import { shanghaiDate } from "@/lib/shanghai";
import { draftThesisAction } from "@/server/actions/news";

interface BreakerItem {
  id?: string;
  description: string;
  status?: string;
}

const inputClass = "rounded-xl border border-[#cfd8d2] bg-white px-3 py-2.5";
const buttonClass = "rounded-xl bg-[#173f32] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60";

/** 保存成功后服务端返回的最新逻辑与条件（带 id 和状态） */
function savedEditorState(data: unknown): { thesis: string; breakers: BreakerItem[] } | null {
  const view = data as { thesis?: { thesis?: unknown } | null; breakers?: Array<{ id?: unknown; description?: unknown; status?: unknown }> } | null;
  if (!view || typeof view.thesis?.thesis !== "string" || !Array.isArray(view.breakers)) return null;
  const breakers = view.breakers.flatMap((item) => typeof item.id === "string" && typeof item.description === "string"
    ? [{ id: item.id, description: item.description, status: typeof item.status === "string" ? item.status : undefined }]
    : []);
  return { thesis: view.thesis.thesis, breakers };
}

/**
 * 投资逻辑 + 失效条件编辑：已触发的条件锁定（不能改写、不能删除），先写复核解除。
 * aiDraft：还没写过逻辑且配置了 DeepSeek 时，可以让 AI 起草（只填进编辑框，保存与否由你决定）。
 */
export function ThesisEditor({ holdingId, initialThesis, initialBreakers, aiDraft = false }: { holdingId: string; initialThesis: string; initialBreakers: BreakerItem[]; aiDraft?: boolean }) {
  const router = useRouter();
  const [thesis, setThesis] = useState(initialThesis);
  const [breakers, setBreakers] = useState<BreakerItem[]>(initialBreakers.length > 0 ? initialBreakers : [{ description: "" }]);
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const [drafting, setDrafting] = useState(false);

  async function draft() {
    const hasContent = thesis.trim() !== "" || breakers.some((item) => item.description.trim() !== "");
    if (hasContent && !window.confirm("用 AI 草稿替换编辑框里的内容？（不会自动保存）")) return;
    setDrafting(true);
    setStatus("AI 起草中，通常需要十几秒…");
    try {
      const result = await draftThesisAction(holdingId);
      if (!result.ok) {
        setStatus(result.message);
        return;
      }
      setThesis(result.thesis);
      setBreakers(result.breakers.map((description) => ({ description })));
      setStatus("草稿已填好：请逐条核对、修改后再保存");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "起草失败");
    } finally {
      setDrafting(false);
    }
  }

  async function save() {
    setSaving(true);
    setStatus("保存中…");
    const result = await sendJson(`/api/portfolio/holdings/${holdingId}/thesis`, "PUT", {
      thesis,
      breakers: breakers
        .filter((item) => item.id || item.description.trim())
        .map((item) => ({ ...(item.id ? { id: item.id } : {}), description: item.description })),
    });
    setSaving(false);
    if (!result.ok) {
      setStatus(result.message);
      return;
    }
    // 用服务端返回的条件（带新 id）更新编辑框：否则第二次保存会把刚加的条件当成「删掉再新建」（复查发现）
    const saved = savedEditorState(result.data);
    if (saved) {
      setThesis(saved.thesis);
      setBreakers(saved.breakers.length > 0 ? saved.breakers : [{ description: "" }]);
    }
    setStatus("已保存");
    router.refresh();
  }

  return (
    <div className="grid gap-4">
      <label className="grid gap-1.5 text-sm">
        投资逻辑<span className="text-xs text-[#748078]">为什么持有它？靠什么赚钱？写给半年后的自己看。</span>
        <textarea value={thesis} onChange={(event) => setThesis(event.target.value)} rows={4} maxLength={2000} className={inputClass} placeholder="例如：锂电扩产周期带动设备订单，龙头份额稳定，估值处于历史低位。" />
      </label>
      <div className="grid gap-2 text-sm">
        <span>失效条件<span className="ml-2 text-xs text-[#748078]">3–5 条可验证的事实；任何一条出现，就暂停新增并复核。</span></span>
        {breakers.map((item, index) => {
          const locked = item.status === "TRIGGERED";
          return (
            <div key={item.id ?? `new-${index}`} className="flex items-center gap-2">
              <input
                value={item.description}
                readOnly={locked}
                maxLength={200}
                onChange={(event) => setBreakers(breakers.map((current, position) => position === index ? { ...current, description: event.target.value } : current))}
                className={`${inputClass} flex-1 ${locked ? "bg-[#fbeeee] text-[#91352f]" : ""}`}
                placeholder="例如：最大客户订单明显缩减"
              />
              {locked
                ? <span className="text-xs font-semibold text-[#91352f]">已触发，先写复核</span>
                : <button type="button" onClick={() => setBreakers(breakers.filter((_, position) => position !== index))} className="text-xs text-[#68756e] underline">删除</button>}
            </div>
          );
        })}
        {breakers.length < MAX_THESIS_BREAKERS && (
          <button type="button" onClick={() => setBreakers([...breakers, { description: "" }])} className="w-fit text-sm font-semibold text-[#315f4d]">+ 添加一条失效条件</button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" disabled={saving || drafting} onClick={save} className={buttonClass}>保存投资逻辑</button>
        {aiDraft && (
          <button type="button" disabled={saving || drafting} onClick={() => void draft()} className="rounded-xl border border-[#cfd8d2] px-4 py-2.5 text-sm font-semibold text-[#315f4d] disabled:opacity-60">
            {drafting ? "起草中…" : "让 AI 起草"}
          </button>
        )}
        <span className="text-sm text-[#66736d]" aria-live="polite">{status}</span>
      </div>
    </div>
  );
}

/** 记录一条消息：对应到某条失效条件即触发它（该持仓暂停新增）。 */
export function ThesisEventForm({ holdingId, breakers }: { holdingId: string; breakers: Array<{ id: string; description: string }> }) {
  const router = useRouter();
  const [status, setStatus] = useState("");

  async function submit(formData: FormData) {
    setStatus("记录中…");
    const sourceUrl = String(formData.get("sourceUrl") ?? "").trim();
    const breakerId = String(formData.get("breakerId") ?? "");
    const result = await sendJson(`/api/portfolio/holdings/${holdingId}/thesis/events`, "POST", {
      kind: "NEWS",
      occurredOn: formData.get("occurredOn"),
      summary: formData.get("summary"),
      sourceUrl: sourceUrl || null,
      breakerId: breakerId || null,
    }, "记录失败，请检查输入");
    if (result.ok) {
      setStatus(breakerId ? "已记录，并触发了对应的失效条件" : "已记录");
      router.refresh();
      return;
    }
    setStatus(result.message);
  }

  return (
    <form action={submit} className="grid gap-4 md:grid-cols-2">
      <label className="grid gap-1.5 text-sm">发生日期<input required name="occurredOn" type="date" defaultValue={shanghaiDate()} max={shanghaiDate()} className={inputClass} /></label>
      <label className="grid gap-1.5 text-sm">来源链接<input name="sourceUrl" type="url" placeholder="https://（公告、新闻原文）" className={inputClass} /></label>
      <label className="grid gap-1.5 text-sm md:col-span-2">发生了什么<textarea required name="summary" rows={2} maxLength={500} placeholder="只写事实：谁、什么时候、做了什么" className={inputClass} /></label>
      <label className="grid gap-1.5 text-sm md:col-span-2">
        对应哪条失效条件
        <select name="breakerId" defaultValue="" className={inputClass}>
          <option value="">不对应任何失效条件（只记录）</option>
          {breakers.map((breaker) => <option key={breaker.id} value={breaker.id}>{breaker.description}</option>)}
        </select>
      </label>
      <div className="flex flex-wrap items-center gap-3 md:col-span-2">
        <button type="submit" className={buttonClass}>记录消息</button>
        <span className="text-sm text-[#66736d]" aria-live="polite">{status}</span>
      </div>
    </form>
  );
}

/** 写复核：对应已触发的失效条件即解除；不对应条件则是定期复核。 */
export function ThesisReviewForm({ holdingId, breakerId, submitLabel }: { holdingId: string; breakerId?: string; submitLabel: string }) {
  const router = useRouter();
  const [status, setStatus] = useState("");

  async function submit(formData: FormData) {
    setStatus("保存中…");
    const result = await sendJson(`/api/portfolio/holdings/${holdingId}/thesis/events`, "POST", {
      kind: "REVIEW", occurredOn: shanghaiDate(), summary: formData.get("summary"), breakerId: breakerId ?? null,
    });
    if (result.ok) {
      setStatus("已保存复核");
      router.refresh();
      return;
    }
    setStatus(result.message);
  }

  return (
    <form action={submit} className="grid gap-3">
      <textarea required name="summary" rows={2} maxLength={1000} placeholder="复核结论：逻辑是否还成立？依据是什么？要不要调整仓位？" className={inputClass} />
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={buttonClass}>{submitLabel}</button>
        <span className="text-sm text-[#66736d]" aria-live="polite">{status}</span>
      </div>
    </form>
  );
}
