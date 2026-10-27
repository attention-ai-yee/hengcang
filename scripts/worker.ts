import { pathToFileURL } from "node:url";
import { runNewsScan } from "./news-scan";
import { runRefresh } from "./refresh";

/**
 * 自调度刷新循环（Code Review M5）：
 * - in-flight 锁防止回填超时或休眠唤醒后的 tick 叠加运行，避免 SQLite 写竞争；
 * - 不再用带 query 参数的动态 import 反复实例化模块图；
 * - 失败打印完整堆栈而不是只打 message。
 *
 * 数据新鲜度修复（worker 启动即退出）：原实现对循环唯一的 setTimeout 调用
 * `unref()`，进程里没有任何 ref 句柄，Node 事件循环认为无事可做，`pnpm worker`
 * 启动后立即退出，自动刷新永远不会触发。这里不再 unref——这个 timer 就是常驻
 * worker 的存活句柄。信号处理仍负责清理它并正常退出。
 */
export const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
/**
 * 按到期判断而不是固定 6 小时一跳（复查发现）：定时器在笔记本休眠时不走、重启后又从头数，
 * 原来的写法可能很久都刷不到一次。现在每 30 分钟醒一次，按墙钟时间看上次成功刷新是否已满 6 小时。
 */
export const CHECK_INTERVAL_MS = 30 * 60 * 1000;
/** 上次尝试失败（或没配置 Token）后至少隔 1 小时再试，免得每半小时打一次接口 */
export const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;
/** 启动后几秒就检查一次：开机或重启 worker 时数据已经过期的，马上补 */
export const STARTUP_DELAY_MS = 5_000;
let inFlight = false;

/** 行情和评分是否到期：上次成功距今满 6 小时，且上次尝试距今满 1 小时。 */
export function refreshDue(status: { lastSuccessAt: string | null; lastAttemptAt: string | null } | null | undefined, now: Date): boolean {
  const elapsed = (value: string | null | undefined) => {
    const time = value ? Date.parse(value) : Number.NaN;
    return Number.isFinite(time) ? now.getTime() - time : Number.POSITIVE_INFINITY;
  };
  return elapsed(status?.lastSuccessAt) >= REFRESH_INTERVAL_MS && elapsed(status?.lastAttemptAt) >= RETRY_AFTER_FAILURE_MS;
}
let timer: NodeJS.Timeout | undefined;

async function tick(): Promise<void> {
  if (inFlight) {
    console.log("上一轮刷新尚未结束，跳过本次触发。");
    return;
  }
  inFlight = true;
  try {
    try {
      const { readProviderStatus } = await import("../src/server/automatic-data-refresh-service");
      if (refreshDue(readProviderStatus("tushare"), new Date())) {
        const report = await runRefresh();
        console.log(new Date().toISOString(), JSON.stringify({
          provider: report.provider,
          status: report.status,
          inserted: report.inserted,
          updated: report.updated,
        }));
      }
    } catch (error) {
      console.error("Scheduled refresh failed", error);
    }
    // AI 新闻监控（§7）：每份投资逻辑距上次扫描满 20 小时才扫，即每天约一次；没配置 Key 时只记状态。
    try {
      const news = await runNewsScan();
      console.log(new Date().toISOString(), JSON.stringify({
        provider: "deepseek-news",
        status: news.status,
        scanned: news.scanned,
        triggered: news.triggered,
        possible: news.possible,
      }));
    } catch (error) {
      console.error("Scheduled news scan failed", error);
    }
  } finally {
    inFlight = false;
  }
}

/**
 * 安排一次延时执行并返回 timer 句柄。
 *
 * 返回的 timer 必须保持 ref（Node 默认行为，`timer.hasRef() === true`）：
 * 常驻 worker 没有其它挂起句柄，唯一让它活下去的就是这里返回的 ref timer；
 * 一旦 unref，`pnpm worker` 启动即退出（本函数存在的回归测试目的）。
 */
export function scheduleNextTick(handler: () => void | Promise<void>, intervalMs: number): NodeJS.Timeout {
  return setTimeout(() => {
    void handler();
  }, intervalMs);
}

function schedule(delayMs = CHECK_INTERVAL_MS): void {
  timer = scheduleNextTick(() => {
    void tick().finally(() => schedule());
  }, delayMs);
}

function startWorker(): void {
  schedule(STARTUP_DELAY_MS);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      clearTimeout(timer);
      process.exit(0);
    });
  }
  console.log("Local refresh worker started: checks every 30 minutes; refreshes data once the last success is 6+ hours old, scans news about daily.");
}

// 仅在直接执行（`pnpm worker`）时启动：被测试或其它模块导入时不得注册常驻
// timer / 信号处理器，避免污染宿主进程（与 scripts/refresh.ts 的约定一致）。
const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (invokedDirectly) startWorker();
