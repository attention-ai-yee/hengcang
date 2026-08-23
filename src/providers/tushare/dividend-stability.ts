import type { TushareDividendRecord } from "./index";

export function scoreDividendStability(records: TushareDividendRecord[], evaluationDate: string): number | null {
  const currentYear = Number(evaluationDate.slice(0, 4));
  const paidByYear = new Map<number, number>();
  for (const record of records) {
    const paidDate = record.payDate ?? record.exDate;
    const year = Number((paidDate ?? record.reportPeriod).slice(0, 4));
    // Only implementation/completion records with a positive cash amount count.
    if (!Number.isFinite(year) || year >= currentYear || !paidDate || (record.cashDividend ?? 0) <= 0) continue;
    paidByYear.set(year, (paidByYear.get(year) ?? 0) + (record.cashDividend ?? 0));
  }
  const years = Array.from({ length: 5 }, (_, index) => currentYear - 1 - index).reverse();
  const dividends = years.map((year) => paidByYear.get(year) ?? 0);
  const paidYears = dividends.filter((value) => value > 0).length;
  if (paidYears === 0) return null;
  let score = paidYears === 5 ? 80 : paidYears === 4 ? 65 : paidYears === 3 ? 50 : 30;
  if (paidYears === 5) score += 10;
  if (dividends.at(-1)! > 0) score += 5;
  if (dividends.at(-1) === 0) score -= 20;
  if (dividends.slice(-3).every((value, index, values) => index === 0 || value < values[index - 1])) score -= 10;
  return Math.max(0, Math.min(100, score));
}
