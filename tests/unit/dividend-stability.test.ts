import { describe, expect, it } from "vitest";
import type { TushareDividendRecord } from "@/providers/tushare";
import { scoreDividendStability } from "@/providers/tushare/dividend-stability";

/** 复查发现：v2 起分红稳定性 < 60 会直接触发体检，所以只能算真正实施了的分红。 */
function record(year: number, procedure: string | null, payDate: string | null = `${year}-07-10`): TushareDividendRecord {
  return { symbol: "600000.SH", announcementDate: `${year}-04-20`, reportPeriod: `${year - 1}-12-31`, procedure, cashDividend: 0.3, recordDate: null, exDate: payDate, payDate };
}

describe("scoreDividendStability", () => {
  it("预案、股东大会通过的方案不算，只算「实施」", () => {
    const implemented = [2021, 2022, 2023, 2024, 2025].map((year) => record(year, "实施"));
    const proposalsOnly = [2021, 2022, 2023, 2024, 2025].map((year) => record(year, year >= 2024 ? "预案" : "实施"));
    expect(scoreDividendStability(implemented, "2026-10-28")).toBe(95);
    expect(scoreDividendStability(proposalsOnly, "2026-10-28")).toBeLessThan(scoreDividendStability(implemented, "2026-10-28") ?? 0);
  });

  it("div_proc 缺失的旧数据退回看派息日", () => {
    expect(scoreDividendStability([2021, 2022, 2023, 2024, 2025].map((year) => record(year, null)), "2026-10-28")).toBe(95);
  });

  it("5 年一次现金分红都没有：有记录就按规格得 10 分（原来剔除，指数分红稳定性偏高）；完全没记录才不算", () => {
    const neverPaid = [2021, 2022, 2023, 2024, 2025].map((year) => ({ ...record(year, "实施"), cashDividend: 0 }));
    expect(scoreDividendStability(neverPaid, "2026-10-28")).toBe(10);
    expect(scoreDividendStability([], "2026-10-28")).toBeNull();
  });
});
