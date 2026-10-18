"use server";

import {
  refreshAutomaticMarketData,
  type AutomaticRefreshReport,
} from "@/server/automatic-data-refresh-service";

export type RefreshActionResult =
  | { ok: true; report: AutomaticRefreshReport }
  | { ok: false; message: string };

/**
 * 页面“一键自动刷新评分”使用 server action 直接调用服务层：
 * 配置 REFRESH_TOKEN 后，/api/data/refresh 只接受带 Bearer 的外部调用（cron/反代），
 * 浏览器端不应持有令牌；UI 走同源 server action，避免按钮必然 401（复查修复）。
 */
export async function refreshMarketDataAction(): Promise<RefreshActionResult> {
  try {
    const report = await refreshAutomaticMarketData();
    if (report.status === "NOT_CONFIGURED") {
      return { ok: false, message: "本机尚未配置 Tushare Token，无法自动拉取数据" };
    }
    return { ok: true, report };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "自动刷新失败",
    };
  }
}
