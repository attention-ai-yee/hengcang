import { runRefresh } from "./refresh";

/**
 * 自调度刷新循环（Code Review M5）：
 * - in-flight 锁防止回填超时或休眠唤醒后的 tick 叠加运行，避免 SQLite 写竞争；
 * - 不再用带 query 参数的动态 import 反复实例化模块图；
 * - 失败打印完整堆栈而不是只打 message。
 */
const sixHours = 6 * 60 * 60 * 1000;
let inFlight = false;
let timer: NodeJS.Timeout | undefined;

async function tick(): Promise<void> {
  if (inFlight) {
    console.log("上一轮刷新尚未结束，跳过本次触发。");
    return;
  }
  inFlight = true;
  try {
    const report = await runRefresh();
    console.log(new Date().toISOString(), JSON.stringify({
      provider: report.provider,
      status: report.status,
      inserted: report.inserted,
      updated: report.updated,
    }));
  } catch (error) {
    console.error("Scheduled refresh failed", error);
  } finally {
    inFlight = false;
  }
}

function schedule(): void {
  timer = setTimeout(() => {
    void tick().finally(schedule);
  }, sixHours);
  timer.unref?.();
}

schedule();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    clearTimeout(timer);
    process.exit(0);
  });
}
console.log("Local refresh worker started; interval: 6 hours.");
