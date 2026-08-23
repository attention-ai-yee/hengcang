import { apiError, apiSuccess, zodFields } from "@/lib/api";
import { manualScorePayloadSchema } from "@/lib/validation";
import { saveManualScore } from "@/server/scoring-service";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError("INVALID_JSON", "请求体必须是 JSON", 400);
  }
  const parsed = manualScorePayloadSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("VALIDATION_ERROR", "手工评分数据无效", 422, zodFields(parsed.error));
  }
  return apiSuccess(await saveManualScore(parsed.data), { source: "manual", confidence: "LOW" });
}
