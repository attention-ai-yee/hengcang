import { Card, PageIntro, StatusPill } from "@/components/ui";
import { listBacktestRuns } from "@/db/queries";

export const dynamic = "force-dynamic";

export default async function BacktestPage() {
  const runs = await listBacktestRuns();
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
        <h2 className="font-semibold">历史运行</h2>
        <p className="mt-3 text-sm text-[#68756e]">{runs.length === 0 ? "尚无回测。导入带 OHLC 与 available_at 的历史数据后可运行。" : `已保存 ${runs.length} 次运行。`}</p>
      </Card>
    </>
  );
}
