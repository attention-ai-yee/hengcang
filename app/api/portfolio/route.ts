import { apiSuccess } from "@/lib/api";
import { getPortfolioView } from "@/server/portfolio-service";

export const dynamic = "force-dynamic";

export async function GET() {
  return apiSuccess(await getPortfolioView());
}
