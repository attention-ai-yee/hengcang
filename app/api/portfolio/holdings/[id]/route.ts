import { apiError, apiSuccess, zodFields } from "@/lib/api";
import { holdingPatchSchema } from "@/lib/validation";
import { deleteHolding, updateHolding } from "@/server/portfolio-service";

type HoldingRouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: HoldingRouteContext) {
  const parsed = holdingPatchSchema.safeParse(await request.json());
  if (!parsed.success) return apiError("VALIDATION_ERROR", "持仓数据无效", 422, zodFields(parsed.error));
  const { id } = await context.params;
  const holding = await updateHolding(id, parsed.data);
  return holding ? apiSuccess(holding) : apiError("NOT_FOUND", "持仓不存在", 404);
}

export async function DELETE(_request: Request, context: HoldingRouteContext) {
  const { id } = await context.params;
  return (await deleteHolding(id)) ? apiSuccess({ deleted: true }) : apiError("NOT_FOUND", "持仓不存在", 404);
}
