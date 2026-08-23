import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { refreshAutomaticMarketData } from "@/server/automatic-data-refresh-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 配置了 REFRESH_TOKEN 时一律要求有效的 Bearer 令牌；未配置时保持本地优先的开放行为。
 * 注意：不能用 request.url 的 host 判断"本地请求"——Next.js 会把 request.url 的
 * host 规范化为 localhost，远程请求同样命中，导致令牌校验永远被跳过。
 */
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
      return NextResponse.json(
        { error: { code: "UNAUTHORIZED", message: "刷新接口需要有效令牌", fields: {} } },
        { status: 401 },
      );
    }
  }

  try {
    const report = await refreshAutomaticMarketData();
    if (report.status === "NOT_CONFIGURED") {
      return NextResponse.json(
        { error: { code: "PROVIDER_NOT_CONFIGURED", message: "本机尚未配置 Tushare Token", fields: {} } },
        { status: 409 },
      );
    }
    return NextResponse.json({
      data: report,
      meta: {
        decisionSupportOnly: true,
        message: report.status === "READY" ? "自动刷新完成" : "自动刷新完成，部分受权限限制",
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: {
          code: "REFRESH_FAILED",
          message: error instanceof Error ? error.message : "自动刷新失败",
          fields: {},
        },
      },
      { status: 500 },
    );
  }
}
