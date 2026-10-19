import "./load-env";
import { pathToFileURL } from "node:url";

/**
 * AI 新闻监控（docs/hengcang_v2_allocation_fundamentals_thesis.md §7）。
 * `pnpm news:scan` 扫描到期的投资逻辑（距上次满 20 小时）；加 `--force` 立即扫描全部。
 */
export async function runNewsScan(options: { force?: boolean } = {}) {
  const { scanNews } = await import("../src/server/news-watch-service");
  return scanNews(options);
}

/** 仅在直接执行本脚本时设置退出码；被 worker 导入时不得污染宿主进程（与 refresh.ts 一致）。 */
const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (invokedDirectly) {
  const report = await runNewsScan({ force: process.argv.includes("--force") });
  console.log(JSON.stringify(report, null, 2));
  if (report.status === "ERROR" || report.status === "NOT_CONFIGURED") process.exitCode = 1;
}
