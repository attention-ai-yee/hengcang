import { NextResponse } from "next/server";
import type { ZodError } from "zod";

export function apiSuccess<T>(data: T, meta: Record<string, unknown> = {}) {
  return NextResponse.json({
    data,
    meta: { generatedAt: new Date().toISOString(), ...meta },
  });
}

export function apiError(
  code: string,
  message: string,
  status = 400,
  fields?: Record<string, string[]>,
) {
  return NextResponse.json({ error: { code, message, fields } }, { status });
}

export function zodFields(error: ZodError): Record<string, string[]> {
  const fields: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "root";
    fields[key] = [...(fields[key] ?? []), issue.message];
  }
  return fields;
}

/**
 * 解析 JSON 请求体；失败时返回统一的 INVALID_JSON 400。
 * （评审复查：收敛 settings / manual-scores / holdings 三处逐字重复。）
 */
export async function parseJsonBody(
  request: Request,
): Promise<{ ok: true; body: unknown } | { ok: false; response: ReturnType<typeof apiError> }> {
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return { ok: false, response: apiError("INVALID_JSON", "请求体必须是 JSON", 400) };
  }
}
