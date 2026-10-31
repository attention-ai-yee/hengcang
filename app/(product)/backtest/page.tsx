import { BacktestRunner } from "@/components/backtest-runner";
import { Card, PageIntro, StatusPill } from "@/components/ui";
import { listBacktestRunsWithResults } from "@/db/queries";
import { LEGACY_STRATEGY_CN, STRATEGIES } from "@/server/backtest-service";

export const dynamic = "force-dynamic";

const STRATEGY_CN: Record<string, string> = Object.fromEntries(STRATEGIES.map((item) => [item.key, item.cn]));

function pct(bps: number | null | undefined) {
  return bps === null || bps === undefined ? "—" : (bps / 100).toFixed(1) + "%";
}

function sharpe(milli: number | null | undefined) {
  return milli === null || milli === undefined ? "—" : (milli / 1000).toFixed(2);
}

interface RunRow {
  id: string;
  strategy: string;
  startDate: string;
  endDate: string;
  transactionCostBps: number;
  completedAt: string | null;
  inputsJson: string;
  result: {
    totalReturnBps: number | null;
    cagrBps: number | null;
    maxDrawdownBps: number | null;
    volatilityBps: number | null;
    sharpeMilli: number | null;
    worstYearBps: number | null;
    longestDrawdownDays: number | null;
    turnoverBps: number | null;
    tradeCount: number | null;
  } | null;
}

function RunTable({ runs }: { runs: RunRow[] }) {
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="data-table min-w-[980px]">
        <thead>
          <tr>
            <th>策略</th><th>区间</th><th>总收益</th><th>年化</th><th>最大回撤</th><th>最差年度</th>
            <th>最长回撤期</th><th>波动率</th><th title="年化收益 ÷ 年化波动，没有扣无风险利率，适合在几种策略之间比较">收益/波动比</th><th>换手(bps)</th><th>调仓桶次</th><th>完成时间</th>
          </tr>
        </thead>
        <tbody>{runs.map((run) => (<tr key={run.id}>
          <td><strong>{STRATEGY_CN[run.strategy] ?? LEGACY_STRATEGY_CN[run.strategy] ?? run.strategy}</strong></td>
          <td>{run.startDate} → {run.endDate}</td>
          <td>{pct(run.result?.totalReturnBps)}</td>
          <td>{pct(run.result?.cagrBps)}</td>
          <td>{pct(run.result?.maxDrawdownBps)}</td>
          <td>{pct(run.result?.worstYearBps)}</td>
          <td>{run.result?.longestDrawdownDays != null ? `${run.result.longestDrawdownDays} 天` : "—"}</td>
          <td>{pct(run.result?.volatilityBps)}</td>
          <td>{sharpe(run.result?.sharpeMilli)}</td>
          <td>{run.result?.turnoverBps ?? "—"}</td>
          <td>{run.result?.tradeCount ?? "—"}</td>
          <td>{run.completedAt?.slice(0, 16).replace("T", " ") ?? "—"}</td>
        </tr>))}</tbody>
      </table>
    </div>
  );
}

export default async function BacktestPage() {
  const runs = await listBacktestRunsWithResults();
  // 批次语义：一次「运行回测」产生的所有策略行共享 batch_id；主表只展示最新批次，
  // 避免旧引擎版本的历史行与新结果混排成自相矛盾的对比。
  // 取第一个非空 batchId（列表按创建时间倒序），兼容夹杂的无批次历史行。
  const latestBatchId = runs.find((run) => run.batchId !== null)?.batchId ?? null;
  const latestBatch = latestBatchId ? runs.filter((run) => run.batchId === latestBatchId) : [];
  const shown = latestBatch.length > 0 ? latestBatch : runs.slice(0, STRATEGIES.length);
  const olderCount = runs.length - shown.length;
  const latestInputs = (() => {
    try {
      return JSON.parse(shown[0]?.inputsJson ?? "{}") as { costBps?: number; targetsFallback?: boolean; warnings?: string[] };
    } catch {
      return {};
    }
  })();

  return (
    <>
      <PageIntro eyebrow="Point-in-time backtest" title="策略回测" description="点内时间回测：评分只用当时已发布的数据，信号在下一个评估日（月末）收盘成交，并计入交易成本。" />
      <section className="mb-5 grid gap-4 md:grid-cols-3">
        {[
          ["基准", "持有基准 / 固定比例再平衡（月度与季度）"],
          ["评分映射", "机会分直接映射权重乘数，对比含上限与不含上限两档"],
          ["状态门控 + 迟滞", "按已确认的推荐状态调整配置：允许增配才加仓，暂停时保持不动"],
        ].map(([title, text]) => <Card key={title} className="p-5"><StatusPill>策略</StatusPill><h2 className="mt-4 text-lg font-semibold">{title}</h2><p className="mt-2 text-sm text-[#68756e]">{text}</p></Card>)}
      </section>
      <Card className="p-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="font-semibold">历史运行</h2>
            <p className="mt-1 text-sm text-[#68756e]">月度公共评估日网格 · 交易成本假设 {latestInputs.costBps ?? 10}bps
              {" "}· 指标：总收益 / 年化 / 最大回撤 / 最差年度 / 最长回撤期 / 波动率 / 收益波动比（未扣无风险利率，不是严格的夏普）/ 换手 / 调仓桶次</p>
          </div>
          <BacktestRunner />
        </div>
        {latestInputs.warnings && latestInputs.warnings.length > 0 && (
          <p className="mt-3 rounded-lg bg-[#fdf3e7] px-3 py-2 text-sm text-[#8a5a1d]">数据告警：{latestInputs.warnings.join("；")}</p>
        )}
        {shown.length === 0 ? (
          <p className="mt-3 text-sm text-[#68756e]">尚无回测结果。点击右上角「运行回测」计算六种策略（持有基准 / 固定比例月度·季度 / 评分映射±上限 / 状态门控+迟滞）。</p>
        ) : (
          <>
            <RunTable runs={shown as RunRow[]} />
            {olderCount > 0 && <p className="mt-3 text-xs text-[#8a9590]">另有 {olderCount} 条历史批次记录未展示。</p>}
          </>
        )}
      </Card>
    </>
  );
}
