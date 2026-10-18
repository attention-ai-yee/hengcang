import { apiError, apiSuccess, parseJsonBody, zodFields } from "@/lib/api";
import { thesisEventPayloadSchema } from "@/lib/validation";
import { recordThesisEvent, ThesisError } from "@/server/thesis-service";

export const dynamic = "force-dynamic";

type ThesisEventRouteContext = { params: Promise<{ id: string }> };

/**
 * 记录消息或复核（v2，§4）：消息对应某条失效条件即触发它（该持仓暂停新增）；
 * 复核对应已触发的条件即解除。
 */
export async function POST(request: Request, context: ThesisEventRouteContext) {
  const parsedBody = await parseJsonBody(request);
  if (!parsedBody.ok) return parsedBody.response;
  const parsed = thesisEventPayloadSchema.safeParse(parsedBody.body);
  if (!parsed.success) return apiError("VALIDATION_ERROR", "事件记录无效", 422, zodFields(parsed.error));
  const { id } = await context.params;
  try {
    return apiSuccess(await recordThesisEvent(id, parsed.data), { created: true });
  } catch (error) {
    if (error instanceof ThesisError) return apiError(error.code, error.message, error.status);
    throw error;
  }
}
