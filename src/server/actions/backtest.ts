"use server";

import { loadBacktestInput, runAllBacktests } from "@/server/backtest-service";

export type BacktestActionResult =
  | { ok: true; batchId: string | null; warnings: string[] }
  | { ok: false; message: string };

/**
 * 页面“运行回测”使用 server action 直接调用服务层：
 * 与刷新一致，配置 REFRESH_TOKEN 后 /api/backtest/run 需要 Bearer 令牌，
 * 浏览器端不应持有令牌，UI 改走同源 server action（复查修复）。
 */
export async function runBacktestAction(): Promise<BacktestActionResult> {
  try {
    const input = await loadBacktestInput();
    const warnings = input.warnings ?? [];
    if (warnings.length > 0) console.warn("[backtest] 数据告警:", warnings.join("; "));
    const summaries = await runAllBacktests(input);
    return { ok: true, batchId: summaries[0]?.batchId ?? null, warnings };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "回测失败",
    };
  }
}
