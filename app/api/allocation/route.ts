import { apiSuccess } from "@/lib/api";
import { getPortfolioView } from "@/server/portfolio-service";

export const dynamic = "force-dynamic";

export async function GET() {
  const view = await getPortfolioView();
  return apiSuccess({ actual: view.summary.byBucket, targets: view.targets });
}
