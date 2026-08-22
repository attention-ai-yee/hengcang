import { listLatestScores } from "@/db/queries";
import { apiSuccess } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET() {
  return apiSuccess(await listLatestScores());
}
