/**
 * 持仓级投资逻辑与失效条件（v2，docs/hengcang_v2_allocation_fundamentals_thesis.md §4）。
 *
 * 消息不自动打成分数——噪音大、没有可回测的历史，被新闻牵着走是个人投资者最常见的亏法。
 * 改为事先写下「投资逻辑 + 3–5 条可验证的失效条件」，消息以事件记录并对应到失效条件；
 * 任何一条被触发，该持仓暂停新增，写完复核才能解除。纯函数，便于单测。
 */
export type BreakerStatus = "ACTIVE" | "TRIGGERED";
export type ThesisStatus = "NO_THESIS" | "INTACT" | "BREACHED";

/** 每份投资逻辑最多的失效条件条数（建议 3–5 条） */
export const MAX_THESIS_BREAKERS = 8;
/** 没有触发也要定期复核：超过该天数没有任何复核记录 → 提示「季度复核到期」 */
export const THESIS_REVIEW_INTERVAL_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

function dayNumber(value: string): number {
  return Math.floor(Date.parse(`${value.slice(0, 10)}T00:00:00Z`) / DAY_MS);
}

export function thesisStatus(input: { hasThesis: boolean; breakers: Array<{ status: string }> }): ThesisStatus {
  if (!input.hasThesis) return "NO_THESIS";
  return input.breakers.some((breaker) => breaker.status === "TRIGGERED") ? "BREACHED" : "INTACT";
}

/** 新增是否被投资逻辑拦住：有失效条件被触发且尚未复核 */
export function thesisBlocksAdd(status: ThesisStatus): boolean {
  return status === "BREACHED";
}

/**
 * 集中持仓（单一个股、主题 ETF）必须写投资逻辑：它们的风险来自具体公司或行业的消息，
 * 宽基、债券、黄金这类分散资产由配置纪律管住即可。
 */
export function needsThesis(holding: { isSingleStock: boolean; isThematicEtf: boolean }): boolean {
  return holding.isSingleStock || holding.isThematicEtf;
}

/**
 * 定期复核：自上次复核（没有复核则自写下逻辑起）超过 90 天 → 到期。
 * 时间只看日期部分，today 用上海时区的 YYYY-MM-DD。
 */
export function reviewDue(input: { lastReviewOn: string | null; thesisCreatedAt: string; today: string; intervalDays?: number }): boolean {
  const since = input.lastReviewOn ?? input.thesisCreatedAt;
  return dayNumber(input.today) - dayNumber(since) >= (input.intervalDays ?? THESIS_REVIEW_INTERVAL_DAYS);
}

/**
 * 保存失效条件时的变更计划：已触发的条件不能被删除或改写——否则不写复核就能绕过暂停。
 * 返回要更新、新增、删除的条目；违反规则时返回 error。
 */
export function planBreakerChanges(
  existing: Array<{ id: string; description: string; status: string }>,
  submitted: Array<{ id?: string; description: string }>,
):
  | { ok: true; update: Array<{ id: string; description: string }>; insert: string[]; remove: string[] }
  | { ok: false; error: "UNKNOWN_BREAKER" | "BREAKER_TRIGGERED"; breakerId: string } {
  const byId = new Map(existing.map((breaker) => [breaker.id, breaker]));
  const kept = new Set<string>();
  const update: Array<{ id: string; description: string }> = [];
  const insert: string[] = [];
  for (const item of submitted) {
    if (!item.id) {
      insert.push(item.description);
      continue;
    }
    const current = byId.get(item.id);
    if (!current) return { ok: false, error: "UNKNOWN_BREAKER", breakerId: item.id };
    kept.add(item.id);
    if (current.description === item.description) continue;
    if (current.status === "TRIGGERED") return { ok: false, error: "BREAKER_TRIGGERED", breakerId: item.id };
    update.push({ id: item.id, description: item.description });
  }
  const remove = existing.filter((breaker) => !kept.has(breaker.id));
  const triggeredRemoval = remove.find((breaker) => breaker.status === "TRIGGERED");
  if (triggeredRemoval) return { ok: false, error: "BREAKER_TRIGGERED", breakerId: triggeredRemoval.id };
  return { ok: true, update, insert, remove: remove.map((breaker) => breaker.id) };
}

export type ThesisAttentionKind = "BREACHED" | "REVIEW_DUE" | "MISSING";

export interface ThesisAttentionItem {
  holdingId: string;
  name: string;
  kind: ThesisAttentionKind;
  /** 已触发、等待复核的失效条件（仅 BREACHED） */
  triggered: string[];
}

const ATTENTION_ORDER: Record<ThesisAttentionKind, number> = { BREACHED: 0, REVIEW_DUE: 1, MISSING: 2 };

/**
 * 首页常驻提醒：触发未复核（暂停新增）在前，其次季度复核到期，最后是集中持仓没写逻辑。
 * 信号流只显示最近几条，触发信号会被后来的评分信号挤掉；这里按当前状态显示，处理完才消失。
 */
export function thesisAttention(
  holdings: Array<{ id: string; name: string; isSingleStock: boolean; isThematicEtf: boolean }>,
  summaries: Map<string, { status: ThesisStatus; reviewDue: boolean; triggered: string[] }>,
): ThesisAttentionItem[] {
  const items: ThesisAttentionItem[] = [];
  for (const holding of holdings) {
    const summary = summaries.get(holding.id);
    const base = { holdingId: holding.id, name: holding.name, triggered: [] as string[] };
    if (summary?.status === "BREACHED") items.push({ ...base, kind: "BREACHED", triggered: summary.triggered });
    else if (summary?.reviewDue) items.push({ ...base, kind: "REVIEW_DUE" });
    else if (!summary && needsThesis(holding)) items.push({ ...base, kind: "MISSING" });
  }
  return items.sort((left, right) => ATTENTION_ORDER[left.kind] - ATTENTION_ORDER[right.kind]);
}
