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

interface FredResponse {
  observations?: Array<{ date: string; value: string; realtime_start: string }>;
}

export class FredProvider implements MarketDataProvider {
  readonly id = "fred";

  constructor(private readonly apiKey = process.env.FRED_API_KEY) {}

  capabilities(): ProviderCapability[] {
    return ["MACRO_SERIES"];
  }

  async getMacroSeries(request: MacroRequest): Promise<ProviderResult<MetricPoint[]>> {
    if (!this.apiKey) return providerFailure(this.id, "NOT_CONFIGURED", "缺少 FRED_API_KEY");
    const url = new URL("https://api.stlouisfed.org/fred/series/observations");
    url.searchParams.set("series_id", request.seriesId);
    url.searchParams.set("api_key", this.apiKey);
    url.searchParams.set("file_type", "json");
    url.searchParams.set("observation_start", request.range.start);
    url.searchParams.set("observation_end", request.range.end);
    try {
      const response = await fetchJson<FredResponse>(url.toString());
      const data = (response.observations ?? [])
        .filter((observation) => observation.value !== ".")
        .map((observation): MetricPoint => ({
          key: request.seriesId,
          value: observation.value,
          unit: "provider_defined",
          observedAt: `${observation.date}T00:00:00Z`,
          availableAt: `${observation.realtime_start}T00:00:00Z`,
          asOf: observation.date,
        }));
      return { ok: true, data, provider: this.id, fetchedAt: new Date().toISOString(), quality: "VALID" };
    } catch (error) {
      return providerFailure(this.id, "UPSTREAM_ERROR", error instanceof Error ? error.message : "FRED 请求失败");
    }
  }

  async getPriceSeries(_request: PriceSeriesRequest): Promise<ProviderResult<PricePoint[]>> {
    return providerFailure(this.id, "NOT_SUPPORTED", "FRED Adapter 不负责市场行情");
  }

  async getValuationMetrics(_request: MetricRequest): Promise<ProviderResult<MetricPoint[]>> {
    return providerFailure(this.id, "NOT_SUPPORTED", "FRED Adapter 不负责估值数据");
  }

  async getFundamentalMetrics(_request: MetricRequest): Promise<ProviderResult<MetricPoint[]>> {
    return providerFailure(this.id, "NOT_SUPPORTED", "FRED Adapter 不负责财务数据");
  }
}
