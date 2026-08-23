import { apiError, apiSuccess, parseJsonBody, zodFields } from "@/lib/api";
import { manualScorePayloadSchema } from "@/lib/validation";
import { saveManualScore } from "@/server/scoring-service";

export async function POST(request: Request) {
  const parsedBody = await parseJsonBody(request);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.body;
  const parsed = manualScorePayloadSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("VALIDATION_ERROR", "手工评分数据无效", 422, zodFields(parsed.error));
  }
  return apiSuccess(await saveManualScore(parsed.data), { source: "manual", confidence: "LOW" });
}
