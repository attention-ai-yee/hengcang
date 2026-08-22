import { z } from "zod";
import { apiError, apiSuccess, zodFields } from "@/lib/api";
import { previewManualObservationImport } from "@/metrics/manual-import";

const requestSchema = z.object({
  format: z.enum(["csv", "json"]),
  content: z.string().min(1).max(10_000_000),
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError("INVALID_JSON", "请求体必须是 JSON", 400);
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) return apiError("VALIDATION_ERROR", "导入请求无效", 422, zodFields(parsed.error));

  const preview = previewManualObservationImport(parsed.data.format, parsed.data.content);
  return apiSuccess({
    digest: preview.digest,
    totalRows: preview.totalRows,
    validRows: preview.validRows,
    duplicateRows: preview.duplicateRows,
    errors: preview.errors,
    summary: preview.summary,
    previewRows: preview.rows.slice(0, 20),
  }, { canCommit: preview.errors.length === 0 && preview.validRows > 0 });
}
