import { NextResponse } from "next/server";
import { refreshAutomaticMarketData } from "@/server/automatic-data-refresh-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isLocalRequest(request: Request) {
  try {
    const hostname = new URL(request.url).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  const refreshToken = process.env.REFRESH_TOKEN;
  if (
    refreshToken &&
    !isLocalRequest(request) &&
    request.headers.get("authorization") !== `Bearer ${refreshToken}`
  ) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "刷新接口需要有效令牌", fields: {} } },
      { status: 401 },
    );
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
