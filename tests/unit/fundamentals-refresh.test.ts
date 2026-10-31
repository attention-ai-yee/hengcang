import { describe, expect, it } from "vitest";
import {
  derivedGrowthMetricKey,
  FUNDAMENTALS_REFRESH_INTERVAL_DAYS,
  FUNDAMENTALS_SEASON_REFRESH_HOURS,
  fundamentalsRefreshMode,
  inReportingSeason,
  selectAggregationDates,
} from "@/server/automatic-data-refresh-service";

/** v2 财报刷新节奏与派生口径分离（docs/hengcang_v2_allocation_fundamentals_thesis.md §2）。 */
describe("fundamentalsRefreshMode", () => {
  const now = new Date("2026-10-18T10:00:00Z");

  it("全量回填一律 FULL", () => {
    expect(fundamentalsRefreshMode({ fullBackfill: true, lastSuccessAt: now.toISOString(), now })).toBe("FULL");
  });

  it("从未成功过：立即增量（v1 日常刷新永远不拉财报）", () => {
    expect(fundamentalsRefreshMode({ fullBackfill: false, lastSuccessAt: null, now })).toBe("INCREMENTAL");
    expect(fundamentalsRefreshMode({ fullBackfill: false, lastSuccessAt: undefined, now })).toBe("INCREMENTAL");
  });

  it("财报季外：距上次成功不足 7 天跳过，满 7 天增量", () => {
    const offSeason = new Date("2026-06-18T10:00:00Z");
    const day = 24 * 60 * 60 * 1000;
    const recent = new Date(offSeason.getTime() - (FUNDAMENTALS_REFRESH_INTERVAL_DAYS * day - 1)).toISOString();
    const due = new Date(offSeason.getTime() - FUNDAMENTALS_REFRESH_INTERVAL_DAYS * day).toISOString();
    expect(fundamentalsRefreshMode({ fullBackfill: false, lastSuccessAt: recent, now: offSeason })).toBe("SKIP");
    expect(fundamentalsRefreshMode({ fullBackfill: false, lastSuccessAt: due, now: offSeason })).toBe("INCREMENTAL");
  });

  it("财报季里每天一次（满 20 小时就刷），新财报不用等一周", () => {
    const hour = 60 * 60 * 1000;
    const recent = new Date(now.getTime() - (FUNDAMENTALS_SEASON_REFRESH_HOURS * hour - 1)).toISOString();
    const due = new Date(now.getTime() - FUNDAMENTALS_SEASON_REFRESH_HOURS * hour).toISOString();
    expect(fundamentalsRefreshMode({ fullBackfill: false, lastSuccessAt: recent, now })).toBe("SKIP");
    expect(fundamentalsRefreshMode({ fullBackfill: false, lastSuccessAt: due, now })).toBe("INCREMENTAL");
  });

  it("财报季的边界", () => {
    expect(["03-14", "03-15", "05-05", "05-06", "07-15", "09-05", "09-06", "10-01", "11-05", "11-06", "12-31"].map((monthDay) => inReportingSeason(`2026-${monthDay}`)))
      .toEqual([false, true, true, false, true, true, false, true, true, false, false]);
  });

  it("无法解析的上次成功时间按「到期」处理，不会永远跳过", () => {
    expect(fundamentalsRefreshMode({ fullBackfill: false, lastSuccessAt: "not-a-date", now })).toBe("INCREMENTAL");
  });
});

describe("selectAggregationDates", () => {
  it("去重、升序；重算上次汇总前 30 天以来的日期（迟到入库的财报也能并进来），更早的历史不动", () => {
    expect(selectAggregationDates(["2026-10-15", "2026-08-15", "2026-10-15", "2026-08-28", "2026-07-01", "2026-07-21"], "2026-08-20"))
      .toEqual(["2026-08-15", "2026-08-28", "2026-10-15"]);
  });

  it("没有历史汇总时保留全部日期", () => {
    expect(selectAggregationDates(["2026-04-28", "2026-04-25"], null)).toEqual(["2026-04-25", "2026-04-28"]);
  });
});

describe("derivedGrowthMetricKey", () => {
  it("派生盈利增长写入单独的参考指标，不再占用财报口径的指标名", () => {
    expect(derivedGrowthMetricKey("BROAD_EQUITY")).toBe("INDEX_EARNINGS_GROWTH_DERIVED");
    expect(derivedGrowthMetricKey("TECH_GROWTH")).toBe("EARNINGS_GROWTH_DERIVED");
    expect(derivedGrowthMetricKey("VALUE_DIVIDEND")).toBe("EARNINGS_GROWTH_DERIVED");
  });
});
