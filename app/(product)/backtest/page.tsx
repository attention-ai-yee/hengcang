import { BacktestRunner } from "@/components/backtest-runner";
import { Card, PageIntro, StatusPill } from "@/components/ui";
import { listBacktestRunsWithResults } from "@/db/queries";

export const dynamic = "force-dynamic";

const STRATEGY_CN: Record<string, string> = {
  BUY_AND_HOLD: "持有基准",
  FIXED_ALLOCATION: "固定比例再平衡",
  SCORE_DRIVEN: "评分 + 上限 + 迟滞",
};

function pct(bps: number | null | undefined) {
  return bps === null || bps === undefined ? "—" : (bps / 100).toFixed(1) + "%";
}

function sharpe(milli: number | null | undefined) {
  return milli === null || milli === undefined ? "—" : (milli / 1000).toFixed(2);
}

export default async function BacktestPage() {
  const runs = await listBacktestRunsWithResults();
  return (
    <>
      <PageIntro eyebrow="Point-in-time backtest" title="策略回测" description="回测只读取当时已发布的数据，信号在下一可交易时点执行，并计入交易成本。" />
      <section className="mb-5 grid gap-4 md:grid-cols-3">
        {[
          ["Buy & Hold", "持有基准"],
          ["Fixed Allocation", "固定比例再平衡"],
          ["Score Driven", "评分 + 上限 + 迟滞"],
        ].map(([title, text]) => <Card key={title} className="p-5"><StatusPill>策略</StatusPill><h2 className="mt-4 text-lg font-semibold">{title}</h2><p className="mt-2 text-sm text-[#68756e]">{text}</p></Card>)}
      </section>
      <Card className="p-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="font-semibold">历史运行</h2>
            <p className="mt-1 text-sm text-[#68756e]">点内时间回测：只读当时已发布的数据，信号在下一可交易时点执行，并计入交易成本。
              {runs.length > 0 ? " 当前共 " + runs.length + " 次运行（最近在前）。" : ""}</p>
          </div>
          <BacktestRunner />
        </div>
        {runs.length === 0 ? (
          <p className="mt-3 text-sm text-[#68756e]">尚无回测结果。点击右上角「运行回测」计算三种策略（持有基准 / 固定比例再平衡 / 评分 + 上限 + 迟滞）。</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="data-table min-w-[860px]">
              <thead><tr><th>策略</th><th>区间</th><th>总收益</th><th>年化</th><th>最大回撤</th><th>波动率</th><th>夏普</th><th>换手(bps)</th><th>交易次数</th><th>完成时间</th></tr></thead>
              <tbody>{runs.map((run) => (<tr key={run.id}>
                <td><strong>{STRATEGY_CN[run.strategy] ?? run.strategy}</strong></td>
                <td>{run.startDate} → {run.endDate}</td>
                <td>{pct(run.result?.cagrBps != null ? Math.round((Math.pow(1 + (run.result?.cagrBps ?? 0) / 10000, (Date.parse(run.endDate) - Date.parse(run.startDate)) / 86400000 / 365.25) - 1) * 10000) : run.result?.cagrBps)}</td>
                <td>{pct(run.result?.cagrBps)}</td>
                <td>{pct(run.result?.maxDrawdownBps)}</td>
                <td>{pct(run.result?.volatilityBps)}</td>
                <td>{sharpe(run.result?.sharpeMilli)}</td>
                <td>{run.result?.turnoverBps ?? "—"}</td>
                <td>{run.result?.tradeCount ?? "—"}</td>
                <td>{run.completedAt?.slice(0, 16).replace("T", " ") ?? "—"}</td>
              </tr>))}</tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
