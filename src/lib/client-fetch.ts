/**
 * 浏览器端提交 JSON（Code Review L12）：网络错误、非 JSON 响应（如数据库忙时的 500）都转成可读的失败信息，
 * 不抛异常——表单 action 里抛错会让整页落到错误页。422 时优先显示服务端给的字段错误。
 */
export type SendJsonResult = { ok: true; data: unknown } | { ok: false; message: string };

export async function sendJson(url: string, method: "POST" | "PUT" | "PATCH", body: unknown, fallback = "保存失败，请检查输入"): Promise<SendJsonResult> {
  let response: Response;
  try {
    response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    return { ok: false, message: "连接不上本机服务，请确认 pnpm dev 还在运行" };
  }
  const json = (await response.json().catch(() => null)) as { data?: unknown; error?: { message?: string; fields?: Record<string, string[]> } } | null;
  if (response.ok) return { ok: true, data: json?.data };
  const field = json?.error?.fields ? Object.values(json.error.fields).flat()[0] : undefined;
  return { ok: false, message: field ?? json?.error?.message ?? `${fallback}（HTTP ${response.status}）` };
}
