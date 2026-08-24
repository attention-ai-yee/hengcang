import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { loadBacktestInput, runAllBacktests } from "@/server/backtest-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    const input = await loadBacktestInput();
    const summaries = await runAllBacktests(input);
    return NextResponse.json({ data: summaries });
  } catch (error) {
    return NextResponse.json({ error: { code: "BACKTEST_FAILED", message: error instanceof Error ? error.message : "回测失败", fields: {} } }, { status: 500 });
  }
}