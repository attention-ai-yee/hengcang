/**
 * 回测报告脚本（只读）：加载点内时间输入，重放六种策略并打印指标对比。
 * 默认不落库；传入 --persist 时通过 runAllBacktests 写入一次运行记录（同一批次）。
 * 可用 --cost N 覆盖交易成本假设（bps，默认 10）。
 *
 * 用法：pnpm backtest [--persist] [--cost N]
 */
import { buildRebalance, loadBacktestInput, metricsFromEquity, normalizedTargets, simulateEquity, STRATEGIES } from "@/server/backtest-service";

const persist = process.argv.includes("--persist");
// 同时支持 --cost 50 与 --cost=50；值缺失或非法时显式告警并回退默认。
const costArg = process.argv.find((arg, index) => index > 1 && (arg === "--cost" || arg.startsWith("--cost=")));
let costOverride: number | undefined;
if (costArg !== undefined) {
  const rawValue = costArg === "--cost" ? process.argv[process.argv.indexOf("--cost") + 1] : costArg.slice("--cost=".length);
  const parsed = Number(rawValue);
  if (rawValue === undefined || !Number.isFinite(parsed)) {
    console.warn(`警告：--cost 的值「${rawValue ?? "缺失"}」不是数字，回退默认成本假设。`);
  } else {
    costOverride = parsed;
  }
}

const input = await loadBacktestInput();
if (input.warnings?.length) {
  console.warn("数据告警：", input.warnings.join("；"));
}
const costBps = Number.isFinite(costOverride) ? Math.min(200, Math.max(0, Math.round(costOverride!))) : input.costBps ?? 10;
const { target, limitMax, limitMin } = normalizedTargets(input.targets);
console.log(`评估网格：${input.dates.length} 个月末公共评估日（${input.dates[0]} → ${input.dates[input.dates.length - 1]}），交易成本 ${costBps}bps`);
console.log(`目标权重：${Object.entries(target).map(([bucket, weight]) => `${bucket} ${(weight * 100).toFixed(1)}%`).join(" / ")}`);

if (persist) {
  const { runAllBacktests } = await import("@/server/backtest-service");
  const summaries = await runAllBacktests({ ...input, costBps });
  console.log(`\n已写入回测批次 ${summaries[0]?.batchId}:`);
  for (const summary of summaries) {
    console.log(`  ${summary.strategy} -> ${summary.runId}`);
  }
}

console.log("\n策略                  总收益    年化   最大回撤  最差年度  最长回撤期   波动率    夏普  换手(bps)  交易次数");
for (const strategy of STRATEGIES) {
  // 与服务层共用 buildRebalance：信号滞后一格，dates[i] 收盘成交 dates[i-1] 的信号（T+1）。
  const rebalance = buildRebalance(strategy.key, { dates: input.dates, opportunityByDate: input.opportunityByDate, statesByDate: input.statesByDate, target, limitMax, limitMin });
  const { equity, tradeCount, turnoverBps } = simulateEquity(input.dates, input.bucketReturns, { ...target }, rebalance, costBps);
  const metrics = metricsFromEquity(equity);
  const pct = (bps: number | null) => `${(bps! / 100).toFixed(1)}%`.padStart(7);
  console.log(
    strategy.cn.padEnd(18),
    pct(metrics.totalReturnBps),
    pct(metrics.cagrBps),
    pct(metrics.maxDrawdownBps),
    pct(metrics.worstYearBps),
    String(metrics.longestDrawdownDays + "天").padStart(8),
    pct(metrics.volatilityBps),
    (metrics.sharpeMilli / 1000).toFixed(2).padStart(6),
    String(turnoverBps).padStart(10),
    String(tradeCount).padStart(8),
  );
}
