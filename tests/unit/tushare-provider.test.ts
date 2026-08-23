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
