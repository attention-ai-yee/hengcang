import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { loadBacktestInput, runAllBacktests } from "@/server/backtest-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 交易成本假设可调（bps），默认 10，限制在 0–200 防止误输入。 */
function parseCostBps(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  return Math.min(200, Math.max(0, Math.round(raw)));
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim();
}

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  const refreshToken = process.env.REFRESH_TOKEN;
  if (refreshToken) {
    const provided = bearerToken(request);
    if (!provided || !tokenMatches(provided, refreshToken)) {
      return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "回测接口需要有效令牌", fields: {} } }, { status: 401 });
    }
  }
  try {
    const body = await request.json().catch(() => ({}) as Record<string, unknown>);
    const input = await loadBacktestInput();
    if (input.warnings?.length) console.warn("[backtest] 数据告警:", input.warnings.join("; "));
    const costBps = parseCostBps((body as { costBps?: unknown })?.costBps);
    const summaries = await runAllBacktests(costBps === undefined ? input : { ...input, costBps });
    return NextResponse.json({ data: { batchId: summaries[0]?.batchId ?? null, summaries } });
  } catch (error) {
    return NextResponse.json({ error: { code: "BACKTEST_FAILED", message: error instanceof Error ? error.message : "回测失败", fields: {} } }, { status: 500 });
  }
}
