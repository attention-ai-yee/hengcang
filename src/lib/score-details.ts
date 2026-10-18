import type { FundamentalHealthStatus, HealthCheckResult } from "@/domain/scoring/health-check";

export interface StoredFundamentalHealth {
  status: FundamentalHealthStatus | null;
  checks: HealthCheckResult[];
  reasons: string[];
}

const STATUSES = new Set<FundamentalHealthStatus>(["HEALTHY", "DETERIORATING", "UNKNOWN", "NOT_APPLICABLE"]);

/**
 * 从评分快照的 componentsJson 读出基本面体检（v2）。v1 快照没有这一项，返回 status = null，
 * 页面按「旧版快照」处理，不伪造结论。
 */
export function readFundamentalHealth(componentsJson: string): StoredFundamentalHealth {
  try {
    const value = JSON.parse(componentsJson) as { fundamentalHealth?: { status?: unknown; checks?: unknown; reasons?: unknown } };
    const health = value.fundamentalHealth;
    if (!health || typeof health !== "object") return { status: null, checks: [], reasons: [] };
    const status = typeof health.status === "string" && STATUSES.has(health.status as FundamentalHealthStatus)
      ? (health.status as FundamentalHealthStatus)
      : null;
    const checks = Array.isArray(health.checks)
      ? health.checks.filter((check): check is HealthCheckResult => Boolean(check) && typeof check === "object" && typeof (check as HealthCheckResult).key === "string")
      : [];
    const reasons = Array.isArray(health.reasons) ? health.reasons.filter((reason): reason is string => typeof reason === "string") : [];
    return { status, checks, reasons };
  } catch {
    return { status: null, checks: [], reasons: [] };
  }
}
