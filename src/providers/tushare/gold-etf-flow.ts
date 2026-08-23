import type { FundNavPoint, FundSharePoint } from "./index";

export interface GoldEtfFlowPoint { asOf: string; availableAt: string; value: number; }

/**
 * Approximates creation/redemption flow from fund-share (万份) and unit NAV.
 * It intentionally remains PARTIAL because it covers only configured domestic ETFs.
 */
export function calculateGoldEtfFlow3m(shares: FundSharePoint[], navs: FundNavPoint[]): GoldEtfFlowPoint[] {
  const navByDate = new Map(navs.map((point) => [point.navDate, point]));
  const grouped = new Map<string, FundSharePoint[]>();
  for (const point of shares) grouped.set(point.symbol, [...(grouped.get(point.symbol) ?? []), point]);
  const daily = new Map<string, { value: number; availableAt: string }>();
  for (const points of grouped.values()) {
    const sorted = [...points].sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
    for (let index = 1; index < sorted.length; index += 1) {
      const current = sorted[index];
      const nav = navByDate.get(current.tradeDate);
      if (!nav) continue;
      const value = (current.shares - sorted[index - 1].shares) * 10_000 * nav.unitNav;
      const existing = daily.get(current.tradeDate) ?? { value: 0, availableAt: nav.availableAt };
      daily.set(current.tradeDate, { value: existing.value + value, availableAt: existing.availableAt > nav.availableAt ? existing.availableAt : nav.availableAt });
    }
  }
  const days = Array.from(daily.entries()).sort(([a], [b]) => a.localeCompare(b));
  return days.map(([asOf, current], index) => ({
    asOf,
    availableAt: current.availableAt,
    value: days.slice(Math.max(0, index - 62), index + 1).reduce((sum, [, point]) => sum + point.value, 0),
  }));
}
