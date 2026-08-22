import { apiError, apiSuccess, zodFields } from "@/lib/api";
import { manualScorePayloadSchema } from "@/lib/validation";
import { saveManualScore } from "@/server/scoring-service";

export async function POST(request: Request) {
  const parsed = manualScorePayloadSchema.safeParse(await request.json());
  if (!parsed.success) {
    return apiError("VALIDATION_ERROR", "手工评分数据无效", 422, zodFields(parsed.error));
  }
  return apiSuccess(await saveManualScore(parsed.data), { source: "manual", confidence: "LOW" });
}
