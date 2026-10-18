import { apiError, apiSuccess, parseJsonBody, zodFields } from "@/lib/api";
import { thesisPayloadSchema } from "@/lib/validation";
import { getThesisView, saveThesis, ThesisError } from "@/server/thesis-service";

export const dynamic = "force-dynamic";

type ThesisRouteContext = { params: Promise<{ id: string }> };

function thesisErrorResponse(error: unknown) {
  if (error instanceof ThesisError) return apiError(error.code, error.message, error.status);
  throw error;
}

/** 持仓的投资逻辑、失效条件与事件日志（v2，§4）。 */
export async function GET(_request: Request, context: ThesisRouteContext) {
  const { id } = await context.params;
  const view = await getThesisView(id);
  return view ? apiSuccess(view) : apiError("NOT_FOUND", "持仓不存在", 404);
}

/** 写入 / 修改投资逻辑与失效条件；已触发的条件不能删改（先写复核）。 */
export async function PUT(request: Request, context: ThesisRouteContext) {
  const parsedBody = await parseJsonBody(request);
  if (!parsedBody.ok) return parsedBody.response;
  const parsed = thesisPayloadSchema.safeParse(parsedBody.body);
  if (!parsed.success) return apiError("VALIDATION_ERROR", "投资逻辑无效", 422, zodFields(parsed.error));
  const { id } = await context.params;
  try {
    return apiSuccess(await saveThesis(id, parsed.data));
  } catch (error) {
    return thesisErrorResponse(error);
  }
}
