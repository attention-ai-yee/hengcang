import { DEFAULT_SCORING_CONFIG, type ScoringConfig } from "./config";
import type { AssetModelInput, DirectScoreMetric, HistoricalObservation, MetricSeries } from "./types";

/**
 * 基本面体检 v2（docs/hengcang_v2_allocation_fundamentals_thesis.md §3）。
 *
 * v1 的基本面分是「当前值在自己近 3–5 年历史里的分位」，再以 30% 权重进入配置吸引力分、
 * 低于 35 触发熔断。分位是相对值：连续几年变差后，平庸的数字也能排到高分位，熔断反而解除；
 * 繁荣之后的正常放缓却可能触发熔断。v2 改成只回答一个问题——基本面在恶化吗？
 * 用看得懂的绝对规则判断，恶化 → 暂停新增、重新评估逻辑；不恶化 → 不加分也不减分。
 */
export type FundamentalHealthStatus = "HEALTHY" | "DETERIORATING" | "UNKNOWN" | "NOT_APPLICABLE";
export type HealthCheckStatus = "OK" | "BREACH" | "MISSING";

export interface HealthCheckPoint {
  value: number;
  asOf: string;
  /** 这一点按权重占主导的报告期（财报汇总才有） */
  reportPeriod?: string;
}

export interface HealthCheckResult {
  key: string;
  label: string;
  /** 触发条件的中文说明 */
  rule: string;
  status: HealthCheckStatus;
  latest: HealthCheckPoint | null;
  previous: HealthCheckPoint | null;
  /** MISSING 的原因（无数据 / 超过新鲜度上限 / 缺少上一期的对照值） */
  note?: string;
}

export interface FundamentalHealth {
  status: FundamentalHealthStatus;
  checks: HealthCheckResult[];
  reasons: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function dayNumber(value: string): number {
  return Math.floor(Date.parse(`${value.slice(0, 10)}T00:00:00Z`) / DAY_MS);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 相邻两个报告期最多相隔约两个季度（一季报和年报常常同一天发，可能直接从三季报跳到一季报） */
const MAX_REPORT_PERIOD_GAP_DAYS = 200;
/** 主导报告期占比与这一期最高值相差不到 2 个百分点的点算一样「纯」，取其中最新的（权重名单最新） */
const PERIOD_SHARE_TOLERANCE = 0.02;

const PERIOD_NAMES: Record<string, string> = { "03-31": "一季报", "06-30": "半年报", "09-30": "三季报", "12-31": "年报" };

/** 报告期的中文名：2026-06-30 → 2026 半年报 */
export function reportPeriodLabel(period: string): string {
  const name = PERIOD_NAMES[period.slice(5, 10)];
  return name ? `${period.slice(0, 4)} ${name}` : period;
}

export function formatHealthPoint(point: HealthCheckPoint): string {
  return `${point.value} @ ${point.asOf}${point.reportPeriod ? `（${reportPeriodLabel(point.reportPeriod)}为主）` : ""}`;
}

/**
 * 找「上一期」：
 * - 汇总点带报告期时按报告期找：比最新一点的主导报告期早的最近一期。按公告日算间隔会出错——
 *   半年报截止 8/31、三季报截止 10/31 只隔 61 天，固定的 80 天间隔会拿三季报去比一季报。
 * - 那一期的点里取主导报告期占比最高的：财报季里紧挨着最新点的前几天，大半权重已经换成新财报，
 *   拿它当上一期等于新财报跟自己比（2026-10-30 真实数据：沪深300 上一期取到 10-29 的 +18.18%，
 *   那天三季报已占四成多；纯半年报时是 +26.17%）。旧数据没有占比，取那一期最近的点。
 * - 旧数据没有报告期（全量回填一次后就都有了）：退回按日期间隔取约一个季度前的点。
 */
function findPreviousReport(history: HistoricalObservation[], latest: HistoricalObservation, config: ScoringConfig): HistoricalObservation | undefined {
  const period = latest.reportPeriod;
  if (period) {
    const earlierPeriod = history.reduce<string | undefined>(
      (best, point) => (point.reportPeriod !== undefined && point.reportPeriod < period && (best === undefined || point.reportPeriod > best) ? point.reportPeriod : best),
      undefined,
    );
    if (earlierPeriod) {
      if (dayNumber(period) - dayNumber(earlierPeriod) > MAX_REPORT_PERIOD_GAP_DAYS) return undefined;
      const candidates = history.filter((point) => point.reportPeriod === earlierPeriod);
      const purest = Math.max(...candidates.map((point) => point.reportPeriodShare ?? 0));
      return [...candidates].reverse().find((point) => (point.reportPeriodShare ?? 0) > purest - PERIOD_SHARE_TOLERANCE);
    }
  }
  const latestDay = dayNumber(latest.asOf);
  return [...history].reverse().find((point) => {
    const gap = latestDay - dayNumber(point.asOf);
    return gap >= config.healthCheck.previousReportMinDays && gap <= config.healthCheck.previousReportMaxDays;
  });
}

function isStale(asOf: string, visibleAt: string | undefined, evaluationDate: string, config: ScoringConfig): boolean {
  const visible = visibleAt && visibleAt.slice(0, 10) > asOf.slice(0, 10) ? visibleAt : asOf;
  return dayNumber(evaluationDate) - dayNumber(visible) > config.history.maxObservationAgeDays;
}

function toPoint(point: HistoricalObservation): HealthCheckPoint {
  return { value: round2(point.value), asOf: point.asOf, ...(point.reportPeriod ? { reportPeriod: point.reportPeriod } : {}) };
}

/**
 * 「最近两期都为负」：最新值与上一期（见 findPreviousReport）的值都 < 0。
 * 桶级汇总序列随成分股陆续披露而更新，按报告期（或日期间隔）取「上一期」比按点数取更稳。
 */
function consecutiveNegative(
  key: string,
  label: string,
  rule: string,
  series: MetricSeries | undefined,
  evaluationDate: string,
  config: ScoringConfig,
): HealthCheckResult {
  const base = { key, label, rule, latest: null, previous: null } as const;
  const history = series?.history ?? [];
  const latestPoint = history.at(-1);
  if (!latestPoint) return { ...base, status: "MISSING", note: "没有财报汇总数据" };
  const latest = toPoint(latestPoint);
  if (isStale(latestPoint.asOf, latestPoint.availableAt, evaluationDate, config)) {
    return { ...base, latest, status: "MISSING", note: `最新数据超过 ${config.history.maxObservationAgeDays} 天未更新` };
  }
  const previousPoint = findPreviousReport(history, latestPoint, config);
  if (!previousPoint) return { ...base, latest, status: "MISSING", note: "缺少上一期（约一个季度前）的对照值" };
  const previous = toPoint(previousPoint);
  return { ...base, latest, previous, status: latest.value < 0 && previous.value < 0 ? "BREACH" : "OK" };
}

/**
 * 增速类检查优先看单季同比（2026-10-31）：累计同比（如前三季度合计比去年同期）会把季度转折冲淡，
 * 晚一两个季度才转负——2026 年沪深300 半年报 +26%、前三季度 +10%，第三季度单季很可能已经下滑。
 * 单季序列给不出「最新 + 上一期」时（库里还没有单季汇总），退回累计同比，标签上注明用的哪种。
 */
function growthCheck(
  key: string,
  label: string,
  quarter: MetricSeries | undefined,
  cumulative: MetricSeries | undefined,
  evaluationDate: string,
  config: ScoringConfig,
): HealthCheckResult {
  if (quarter && quarter.history.length > 0) {
    const result = consecutiveNegative(key, `${label}（单季）`, "最近两个季度的单季同比都为负", quarter, evaluationDate, config);
    if (result.status !== "MISSING") return result;
  }
  return consecutiveNegative(key, `${label}（累计）`, "最近两期（相隔约一个季度）累计同比都为负", cumulative, evaluationDate, config);
}

function scoreFloor(
  key: string,
  label: string,
  metric: DirectScoreMetric | undefined,
  floor: number,
  evaluationDate: string,
  config: ScoringConfig,
): HealthCheckResult {
  const rule = `低于 ${floor} 分`;
  const base = { key, label, rule, previous: null } as const;
  if (!metric || metric.score === null || !Number.isFinite(metric.score)) {
    return { ...base, latest: null, status: "MISSING", note: "没有数据" };
  }
  const latest = { value: round2(metric.score), asOf: metric.asOf };
  if (isStale(metric.asOf, undefined, evaluationDate, config)) {
    return { ...base, latest, status: "MISSING", note: `最新数据超过 ${config.history.maxObservationAgeDays} 天未更新` };
  }
  return { ...base, latest, status: metric.score < floor ? "BREACH" : "OK" };
}

function checksFor(input: AssetModelInput, config: ScoringConfig): HealthCheckResult[] | null {
  switch (input.bucket) {
    case "VALUE_DIVIDEND":
      // 基金（如 004814）拿不到成分财报时，手工基本面覆盖分优先（v1 规格 §4.2 的兜底，口径改成体检）。
      // 只在它还新鲜时替代自动体检：过期的旧判断不能盖住自动规则发现的恶化。
      if (input.fundamentalOverride && !isStale(input.fundamentalOverride.asOf, undefined, input.asOf, config)) {
        return [scoreFloor("fundamentalOverride", "手工基本面判断", input.fundamentalOverride, config.thresholds.fundamentalCircuitBreaker, input.asOf, config)];
      }
      return [
        growthCheck("earningsGrowth", "盈利同比", input.earningsGrowthQuarter, input.earningsGrowth, input.asOf, config),
        scoreFloor("dividendStability", "分红稳定性", input.dividendStability, config.healthCheck.dividendStabilityFloor, input.asOf, config),
      ];
    case "TECH_GROWTH":
      return [
        growthCheck("earningsGrowth", "盈利同比", input.earningsGrowthQuarter, input.earningsGrowth, input.asOf, config),
        growthCheck("revenueGrowth", "营收同比", input.revenueGrowthQuarter, input.revenueGrowth, input.asOf, config),
      ];
    case "BROAD_EQUITY":
      return [growthCheck("indexEarningsGrowth", "指数盈利同比", input.indexEarningsGrowthQuarter, input.indexEarningsGrowth, input.asOf, config)];
    case "GOLD":
      // 黄金没有经营基本面；宏观支持度（实际利率、美元、资金流）只作展示参考，不参与体检
      return null;
  }
}

function describeCheck(check: HealthCheckResult): string {
  const points = [check.latest, check.previous]
    .filter((point): point is HealthCheckPoint => point !== null)
    .map(formatHealthPoint)
    .join("，");
  return `${check.label}${check.rule}${points ? `（${points}）` : ""}`;
}

export function assessFundamentalHealth(input: AssetModelInput, config: ScoringConfig = DEFAULT_SCORING_CONFIG): FundamentalHealth {
  const checks = checksFor(input, config);
  if (checks === null) return { status: "NOT_APPLICABLE", checks: [], reasons: [] };
  const breaches = checks.filter((check) => check.status === "BREACH");
  if (breaches.length > 0) {
    return { status: "DETERIORATING", checks, reasons: breaches.map((check) => `基本面体检：${describeCheck(check)}`) };
  }
  if (checks.every((check) => check.status === "MISSING")) {
    return { status: "UNKNOWN", checks, reasons: ["基本面体检数据不足（财报缺失或已过期），无法确认没有恶化：最多输出小幅增配"] };
  }
  return { status: "HEALTHY", checks, reasons: [] };
}
