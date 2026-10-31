import type { TushareDividendRecord } from "./index";

export function scoreDividendStability(records: TushareDividendRecord[], evaluationDate: string): number | null {
  const currentYear = Number(evaluationDate.slice(0, 4));
  const paidByYear = new Map<number, number>();
  for (const record of records) {
    const paidDate = record.payDate ?? record.exDate;
    const year = Number((paidDate ?? record.reportPeriod).slice(0, 4));
    // 只算已实施、有现金金额的记录：预案、股东大会通过、未通过的方案都不算（v2 起分红稳定性 < 60 会直接触发体检）。
    // div_proc 缺失的旧数据退回看派息日 / 除息日。
    if (record.procedure !== null && record.procedure.trim() !== "" && record.procedure.trim() !== "实施") continue;
    if (!Number.isFinite(year) || year >= currentYear || !paidDate || (record.cashDividend ?? 0) <= 0) continue;
    paidByYear.set(year, (paidByYear.get(year) ?? 0) + (record.cashDividend ?? 0));
  }
  const years = Array.from({ length: 5 }, (_, index) => currentYear - 1 - index).reverse();
  const dividends = years.map((year) => paidByYear.get(year) ?? 0);
  const paidYears = dividends.filter((value) => value > 0).length;
  // 5 年一次现金分红都没有：有分红记录（如「不分配」预案）就按规格给 30 − 20 = 10 分；原来直接剔除，
  // 长期不分红的公司不计入，指数的分红稳定性偏高、会掩盖恶化（2026-10-31 复查）。完全没有记录（新股、缺数据）才不算。
  if (paidYears === 0) return records.length > 0 ? 10 : null;
  let score = paidYears === 5 ? 80 : paidYears === 4 ? 65 : paidYears === 3 ? 50 : 30;
  if (paidYears === 5) score += 10;
  if (dividends.at(-1)! > 0) score += 5;
  if (dividends.at(-1) === 0) score -= 20;
  if (dividends.slice(-3).every((value, index, values) => index === 0 || value < values[index - 1])) score -= 10;
  return Math.max(0, Math.min(100, score));
}
