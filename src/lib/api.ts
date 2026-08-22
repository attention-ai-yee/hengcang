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
