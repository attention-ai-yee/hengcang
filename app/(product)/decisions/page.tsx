import { Card, PageIntro } from "@/components/ui";
import { listDecisions } from "@/db/queries";
import type { AssetBucket } from "@/domain/types";
import { BUCKET_LABELS } from "@/lib/presentation";

export const dynamic = "force-dynamic";

export default async function DecisionsPage() {
  const decisions = await listDecisions();
  return (
    <>
      <PageIntro eyebrow="Decision journal" title="决策日志" description="记录当时知道了什么、采取了什么动作，以及未来 30/90/180 天结果。" />
      <Card className="overflow-x-auto p-2">
        {decisions.length === 0 ? <div className="p-8 text-center text-sm text-[#6b7871]">尚无决策记录。Decision Log 写入 API 将在下一业务纵切接通。</div> : (
          <table className="data-table min-w-[800px]"><thead><tr><th>日期</th><th>资产桶</th><th>动作</th><th>系统状态</th><th>理由</th></tr></thead><tbody>{decisions.map((decision) => <tr key={decision.id}><td>{decision.decidedAt.slice(0, 10)}</td><td>{BUCKET_LABELS[decision.assetBucket as AssetBucket]}</td><td>{decision.action}</td><td>{decision.systemState}</td><td>{decision.rationale}</td></tr>)}</tbody></table>
        )}
      </Card>
    </>
  );
}
