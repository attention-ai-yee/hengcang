import { afterEach, describe, expect, it, vi } from "vitest";
import { TushareProvider } from "@/providers/tushare";
import { FredProvider } from "@/providers/fred";

afterEach(() => vi.unstubAllGlobals());

function mockTushare(data: { fields: string[]; items: Array<Array<string | number | null>> }) {
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ input, init });
    return new Response(JSON.stringify({ code: 0, msg: null, data }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, requests };
}

describe("Tushare canonical adapter", () => {
  it("指数行情映射为带可用时间的 PricePoint", async () => {
    const { fetchMock, requests } = mockTushare({
      fields: ["trade_date", "open", "high", "low", "close", "vol"],
      items: [["20260821", 4000, 4050, 3980, 4030, 123456]],
    });
    const provider = new TushareProvider("test-token");
    const result = await provider.getPriceSeries({
      symbol: "000300.SH",
      instrumentKind: "INDEX",
      range: { start: "2026-08-01", end: "2026-08-21" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0]).toMatchObject({ asOf: "2026-08-21", close: "4030", currency: "CNY" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(String(requests[0]?.init?.body));
    expect(body.api_name).toBe("index_daily");
    expect(body.token).toBe("test-token");
  });

  it("指数估值映射为统一 PE_TTM 与 PB 指标", async () => {
    mockTushare({
      fields: ["trade_date", "pe_ttm", "pb"],
      items: [["20260821", 12.5, 1.4]],
    });
    const provider = new TushareProvider("test-token");
    const result = await provider.getValuationMetrics({
      symbol: "000300.SH",
      instrumentKind: "INDEX",
      metrics: ["PE_TTM", "PB"],
      range: { start: "2026-08-01", end: "2026-08-21" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.map((point) => [point.key, point.value])).toEqual([
      ["PE_TTM", "12.5"],
      ["PB", "1.4"],
    ]);
  });

  it("财务指标：同一报告期同一公告日有修正前后两条时只留 update_flag = 1 的（不论顺序）", async () => {
    const fields = ["ts_code", "ann_date", "end_date", "roe", "netprofit_yoy", "tr_yoy", "or_yoy", "q_sales_yoy", "update_flag"];
    const original = ["600900.SH", "20260430", "20260331", 3.1, 25.0, 5.0, null, null, "0"];
    const revised = ["600900.SH", "20260430", "20260331", 3.2, 30.5, 6.0, null, null, "1"];
    const annual = ["600900.SH", "20260430", "20251231", 15.0, 6.17, 4.0, null, null, "0"];
    for (const items of [[original, revised, annual], [revised, original, annual]]) {
      mockTushare({ fields, items });
      const result = await new TushareProvider("test-token").getEquityFundamentals("600900.SH", { start: "2025-10-30", end: "2026-10-30" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.map((row) => [row.reportPeriod, row.earningsGrowth, row.roe])).toEqual([["2026-03-31", 30.5, 3.2], ["2025-12-31", 6.17, 15]]);
    }
  });

  it("不再把 Tushare us_trycr 伪标为实际利率", async () => {
    const provider = new TushareProvider("test-token");
    const result = await provider.getMacroSeries({
      seriesId: "REAL_YIELD_10Y",
      range: { start: "2026-08-01", end: "2026-08-21" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_SUPPORTED");
  });

  it("FRED 映射 DFII10 与 DTWEXBGS 到统一宏观指标", async () => {
    const { requests } = mockTushare({ fields: [], items: [] });
    const provider = new FredProvider("fred-test-key");
    const result = await provider.getMacroSeries({ seriesId: "DOLLAR_INDEX", range: { start: "2026-08-01", end: "2026-08-21" } });
    expect(result.ok).toBe(true);
    const url = new URL(String(requests[0]?.input));
    expect(url.searchParams.get("series_id")).toBe("DTWEXBGS");
  });
});
