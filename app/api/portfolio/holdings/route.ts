import { apiError, apiSuccess, parseJsonBody, zodFields } from "@/lib/api";
import { holdingPayloadSchema } from "@/lib/validation";
import { createHolding, getPortfolioView } from "@/server/portfolio-service";

export const dynamic = "force-dynamic";

export async function GET() {
  const view = await getPortfolioView();
  return apiSuccess(view.holdings);
}

export async function POST(request: Request) {
  const parsedBody = await parseJsonBody(request);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.body;
  const parsed = holdingPayloadSchema.safeParse(body);
  if (!parsed.success) return apiError("VALIDATION_ERROR", "持仓数据无效", 422, zodFields(parsed.error));
  return apiSuccess(await createHolding(parsed.data), { created: true });
}
