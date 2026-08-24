import type { ProviderResult } from "./types";

/**
 * WGC（世界黄金协会）Goldhub 全球黄金 ETF 资金流。
 * 无官方开放 API；数据由官网图表层通过 fsapi.gold.org 的公开 JSON 端点提供，
 * 内容即 Goldhub「Gold ETF holdings and flows」月度数据集（分区域、USD 口径）。
 */
const FLOWS_API_URL = "https://fsapi.gold.org/api/v11/charts/etfv2/revised/flows-chart2";

export interface WgcMonthlyFlowPoint {
  /** 三个月滚动窗口的最后一个自然月（YYYY-MM-01） */
  asOf: string;
  /** 官方按月修订发布：保守起见可用时间取次月同日 */
  availableAt: string;
  /** 三个月滚动净流入（百万美元） */
  valueMillionUsd: number;
}

function isoMonthStart(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function nextMonthSameDay(asOf: string): string {
  const ms = Date.parse(asOf + "T00:00:00Z") + 31 * 24 * 60 * 60 * 1000;
  const next = new Date(ms).toISOString().slice(0, 10);
  // 回退到目标月内存在的日期（如 01-31 -> 03-02/03 情形，统一钳到 28 日内无碍）
  return next.slice(0, 8) + String(Math.min(Number(next.slice(8, 10)), 28)).padStart(2, "0");
}

/**
 * 解析 fsapi flows-chart2 载荷 -> 全球三个月滚动净流入序列。
 * - 仅聚合区域流量序列，剔除 "Gold Price (rhs)" 这类右侧坐标辅助线；
 * - 三个月窗口要求月份连续（间隔 ≤35 天），断档不产出，避免跨缺口伪流量；
 * - 数值换算为百万美元并保留两位小数。纯函数，便于单测。
 */
export function parseWgcMonthlyFlows(payload: unknown): WgcMonthlyFlowPoint[] {
  const series = (payload as { chartData?: { data?: { Monthly?: { series?: { usd?: unknown } } } } })
    ?.chartData?.data?.Monthly?.series?.usd;
  if (!Array.isArray(series)) return [];
  const byMonth = new Map<number, number>();
  for (const entry of series) {
    const name = (entry as { name?: unknown })?.name;
    if (typeof name !== "string" || /gold price/i.test(name)) continue;
    const points = (entry as { data?: unknown })?.data;
    if (!Array.isArray(points)) continue;
    for (const point of points) {
      if (!Array.isArray(point) || point.length < 2) continue;
      const ts = point[0];
      const value = point[1];
      if (typeof ts !== "number" || !Number.isFinite(ts)) continue;
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      byMonth.set(ts, (byMonth.get(ts) ?? 0) + value);
    }
  }
  const monthly = Array.from(byMonth.entries()).sort((first, second) => first[0] - second[0]);
  const output: WgcMonthlyFlowPoint[] = [];
  for (let i = 2; i < monthly.length; i += 1) {
    if (monthly[i][0] - monthly[i - 1][0] > 35 * 86_400_000) continue;
    if (monthly[i - 1][0] - monthly[i - 2][0] > 35 * 86_400_000) continue;
    const sum = monthly[i][1] + monthly[i - 1][1] + monthly[i - 2][1];
    const asOf = isoMonthStart(monthly[i][0]);
    output.push({
      asOf,
      availableAt: nextMonthSameDay(asOf) + "T18:00:00+08:00",
      valueMillionUsd: Math.round((sum / 1_000_000) * 100) / 100,
    });
  }
  return output;
}

export async function fetchWgcGlobalMonthlyFlows(
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderResult<WgcMonthlyFlowPoint[]>> {
  const fetchedAt = new Date().toISOString();
  try {
    const response = await fetchImpl(FLOWS_API_URL, {
      headers: { accept: "application/json", "user-agent": "hengcang-dashboard/1.0" },
    });
    if (!response.ok) {
      return { ok: false, provider: "wgc-goldhub", fetchedAt, fallbackAllowed: true, error: { code: "UPSTREAM_ERROR", message: "WGC fsapi HTTP " + response.status } };
    }
    const payload = (await response.json()) as unknown;
    const points = parseWgcMonthlyFlows(payload);
    if (points.length === 0) {
      return { ok: false, provider: "wgc-goldhub", fetchedAt, fallbackAllowed: true, error: { code: "INVALID_RESPONSE", message: "WGC 载荷中没有可用的月度流量序列" } };
    }
    return { ok: true, data: points, provider: "wgc-goldhub", fetchedAt, quality: "VALID" };
  } catch (error) {
    return { ok: false, provider: "wgc-goldhub", fetchedAt, fallbackAllowed: true, error: { code: "UPSTREAM_ERROR", message: error instanceof Error ? error.message : "WGC 请求失败" } };
  }
}