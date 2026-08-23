import { apiError, apiSuccess, zodFields } from "@/lib/api";
import { holdingPatchSchema } from "@/lib/validation";
import { ReservedCashNotFundedError, deleteHolding, updateHolding } from "@/server/portfolio-service";

type HoldingRouteContext = { params: Promise<{ id: string }> };

function errorResponse(error: unknown) {
  if (error instanceof ReservedCashNotFundedError) {
    return apiError(error.code, error.message, 409);
  }
  throw error;
}

export async function PATCH(request: Request, context: HoldingRouteContext) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError("INVALID_JSON", "请求体必须是 JSON", 400);
  }
  const parsed = holdingPatchSchema.safeParse(body);
  if (!parsed.success) return apiError("VALIDATION_ERROR", "持仓数据无效", 422, zodFields(parsed.error));
  const { id } = await context.params;
  try {
    const holding = await updateHolding(id, parsed.data);
    return holding ? apiSuccess(holding) : apiError("NOT_FOUND", "持仓不存在", 404);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(_request: Request, context: HoldingRouteContext) {
  const { id } = await context.params;
  try {
    return (await deleteHolding(id)) ? apiSuccess({ deleted: true }) : apiError("NOT_FOUND", "持仓不存在", 404);
  } catch (error) {
    return errorResponse(error);
  }
}
