import { z } from "zod";
import { apiError, apiSuccess, zodFields } from "@/lib/api";
import { previewManualObservationImport } from "@/metrics/manual-import";
import { commitManualObservations } from "@/metrics/observation-repository";
import { refreshScoresForImportedRows } from "@/server/scoring-refresh-service";

const requestSchema = z.object({
  format: z.enum(["csv", "json"]),
  content: z.string().min(1).max(10_000_000),
  digest: z.string().length(64),
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError("INVALID_JSON", "请求体必须是 JSON", 400);
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) return apiError("VALIDATION_ERROR", "提交请求无效", 422, zodFields(parsed.error));

  const preview = previewManualObservationImport(parsed.data.format, parsed.data.content);
  if (preview.digest !== parsed.data.digest) {
    return apiError("IMPORT_CHANGED_AFTER_PREVIEW", "文件内容在预览后发生变化，请重新预览", 409);
  }
  if (preview.errors.length > 0 || preview.rows.length === 0) {
    return apiError("IMPORT_HAS_ERRORS", "导入内容仍包含错误，无法提交", 422, {
      rows: preview.errors.map((error) => `第 ${error.row} 行 ${error.field}: ${error.message}`),
    });
  }

  const committed = commitManualObservations(preview.rows);
  const scores = await refreshScoresForImportedRows(preview.rows);
  return apiSuccess({
    import: committed,
    scores: scores.map((item) => ({
      bucket: item.bucket,
      asOf: item.asOf,
      saved: item.saved,
      opportunityScore: item.result.opportunityScore,
      confidence: item.result.confidence,
      state: item.result.state,
      missingMetrics: item.result.missingMetrics,
    })),
  }, { idempotent: true });
}
