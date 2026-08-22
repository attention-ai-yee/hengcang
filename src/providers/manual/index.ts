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

export interface ManualDataset {
  prices?: Record<string, PricePoint[]>;
  metrics?: Record<string, MetricPoint[]>;
  macro?: Record<string, MetricPoint[]>;
}

export class ManualProvider implements MarketDataProvider {
  readonly id = "manual";

  constructor(private readonly dataset: ManualDataset = {}) {}

  capabilities(): ProviderCapability[] {
    return ["PRICE_SERIES", "VALUATION_METRICS", "FUNDAMENTAL_METRICS", "MACRO_SERIES"];
  }

  async getPriceSeries(request: PriceSeriesRequest): Promise<ProviderResult<PricePoint[]>> {
    return this.success(this.dataset.prices?.[request.symbol] ?? []);
  }

  async getValuationMetrics(request: MetricRequest): Promise<ProviderResult<MetricPoint[]>> {
    return this.success(this.filterMetrics(request));
  }

  async getFundamentalMetrics(request: MetricRequest): Promise<ProviderResult<MetricPoint[]>> {
    return this.success(this.filterMetrics(request));
  }

  async getMacroSeries(request: MacroRequest): Promise<ProviderResult<MetricPoint[]>> {
    return this.success(this.dataset.macro?.[request.seriesId] ?? []);
  }

  private filterMetrics(request: MetricRequest): MetricPoint[] {
    return (this.dataset.metrics?.[request.symbol] ?? []).filter((point) => request.metrics.includes(point.key));
  }

  private success<T>(data: T): ProviderResult<T> {
    return { ok: true, data, provider: this.id, fetchedAt: new Date().toISOString(), quality: "VALID" };
  }
}
