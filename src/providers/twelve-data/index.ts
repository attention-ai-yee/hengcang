import { fetchJson, providerFailure } from "../shared";
import type {
  MacroRequest,
  MarketDataProvider,
  MetricPoint,
  MetricRequest,
  PricePoint,
  PriceSeriesRequest,
  ProviderCapability,
  ProviderResult,
} from "../types";

interface TwelveDataResponse {
  code?: number;
  message?: string;
  meta?: { currency?: string };
  values?: Array<{ datetime: string; open: string; high: string; low: string; close: string; volume?: string }>;
}

export class TwelveDataProvider implements MarketDataProvider {
  readonly id = "twelve-data";

  constructor(private readonly apiKey = process.env.TWELVE_DATA_API_KEY) {}

  capabilities(): ProviderCapability[] {
    return ["PRICE_SERIES"];
  }

  async getPriceSeries(request: PriceSeriesRequest): Promise<ProviderResult<PricePoint[]>> {
    if (!this.apiKey) return providerFailure(this.id, "NOT_CONFIGURED", "缺少 TWELVE_DATA_API_KEY");
    const url = new URL("https://api.twelvedata.com/time_series");
    url.searchParams.set("symbol", request.symbol);
    url.searchParams.set("interval", "1day");
    url.searchParams.set("start_date", request.range.start);
    url.searchParams.set("end_date", request.range.end);
    url.searchParams.set("apikey", this.apiKey);
    try {
      const response = await fetchJson<TwelveDataResponse>(url.toString());
      if (response.code || !response.values) {
        return providerFailure(this.id, response.code === 429 ? "RATE_LIMITED" : "UPSTREAM_ERROR", response.message ?? "Twelve Data 返回错误");
      }
      const currency = response.meta?.currency ?? "USD";
      const data = response.values.map((value): PricePoint => ({
        observedAt: `${value.datetime}T16:00:00Z`,
        availableAt: `${value.datetime}T23:59:59Z`,
        asOf: value.datetime,
        open: value.open,
        high: value.high,
        low: value.low,
        close: value.close,
        volume: value.volume,
        currency,
      }));
      return { ok: true, data, provider: this.id, fetchedAt: new Date().toISOString(), quality: "VALID" };
    } catch (error) {
      return providerFailure(this.id, "UPSTREAM_ERROR", error instanceof Error ? error.message : "Twelve Data 请求失败");
    }
  }

  async getValuationMetrics(_request: MetricRequest): Promise<ProviderResult<MetricPoint[]>> {
    return providerFailure(this.id, "NOT_SUPPORTED", "Global Adapter MVP 仅接行情");
  }

  async getFundamentalMetrics(_request: MetricRequest): Promise<ProviderResult<MetricPoint[]>> {
    return providerFailure(this.id, "NOT_SUPPORTED", "Global Adapter MVP 仅接行情");
  }

  async getMacroSeries(_request: MacroRequest): Promise<ProviderResult<MetricPoint[]>> {
    return providerFailure(this.id, "NOT_SUPPORTED", "Global Adapter 不负责宏观数据");
  }
}
