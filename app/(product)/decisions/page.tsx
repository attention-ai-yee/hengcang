import { Card, PageIntro } from "@/components/ui";
import { DecisionLogForm } from "@/components/decision-log-form";
import { listDecisions } from "@/db/queries";
import type { AssetBucket, RecommendationState } from "@/domain/types";
import { BUCKET_LABELS, STATE_LABELS } from "@/lib/presentation";
import { DECISION_ACTION_LABELS, type DecisionAction } from "@/lib/validation";

export const dynamic = "force-dynamic";

const DIRECTION_LABELS: Record<string, string> = {
  ADD: "加仓方向",
  REDUCE: "减仓方向",
  NONE: "无方向",
};

function actionLabel(action: string): string {
  return DECISION_ACTION_LABELS[action as DecisionAction] ?? action;
}

function systemStateLabel(state: string): string {
  return STATE_LABELS[state as RecommendationState] ?? (state === "UNKNOWN" ? "暂无评分" : state);
}

export default async function DecisionsPage() {
  const decisions = await listDecisions();
  return (
    <>
      <PageIntro
        eyebrow="Decision journal"
        title="决策日志"
        description="记录当时知道了什么、采取了什么动作，以及未来 30/90/180 天结果。写入时会快照当时的评分状态与组合分布；同方向决策会触发 7 天冷却抑制。"
      />
      <Card className="mb-5 p-5">
        <h2 className="text-lg font-semibold">记录一次决策</h2>
        <p className="mt-1 text-sm leading-6 text-[#66736d]">动作决定建议方向：加仓 → ADD、减仓 → REDUCE、保持/暂停新增 → NONE。只有 ADD / REDUCE 参与冷却抑制。</p>
        <div className="mt-4"><DecisionLogForm /></div>
      </Card>
      <Card className="overflow-x-auto p-2">
        {decisions.length === 0 ? <div className="p-8 text-center text-sm text-[#6b7871]">尚无决策记录</div> : (
          <table className="data-table min-w-[900px]">
            <thead><tr><th>日期</th><th>资产桶</th><th>动作</th><th>方向</th><th>系统状态</th><th>理由</th></tr></thead>
            <tbody>
              {decisions.map((decision) => (
                <tr key={decision.id}>
                  <td>{decision.decidedAt.slice(0, 10)}</td>
                  <td>{BUCKET_LABELS[decision.assetBucket as AssetBucket] ?? decision.assetBucket}</td>
                  <td>{actionLabel(decision.action)}</td>
                  <td>{DIRECTION_LABELS[decision.direction] ?? decision.direction}</td>
                  <td>{systemStateLabel(decision.systemState)}</td>
                  <td>{decision.rationale}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
