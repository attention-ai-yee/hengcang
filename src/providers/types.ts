export type ProviderCapability =
  | "PRICE_SERIES"
  | "VALUATION_METRICS"
  | "FUNDAMENTAL_METRICS"
  | "MACRO_SERIES";

export interface DateRange {
  start: string;
  end: string;
}

export interface PriceSeriesRequest {
  symbol: string;
  range: DateRange;
  interval?: "1day";
  instrumentKind?: "EQUITY" | "INDEX" | "FUND" | "GOLD_SPOT";
}

export interface MetricRequest {
  symbol: string;
  metrics: string[];
  asOf?: string;
  range?: DateRange;
  instrumentKind?: "EQUITY" | "INDEX" | "FUND" | "GOLD_SPOT";
}

export interface MacroRequest {
  seriesId: string;
  range: DateRange;
}

export interface PricePoint {
  observedAt: string;
  availableAt: string;
  asOf: string;
  open?: string;
  high?: string;
  low?: string;
  close: string;
  volume?: string;
  currency: string;
}

export interface MetricPoint {
  key: string;
  value: string;
  unit: string;
  observedAt: string;
  availableAt: string;
  asOf: string;
}

export type ProviderErrorCode =
  | "NOT_CONFIGURED"
  | "NOT_SUPPORTED"
  | "PERMISSION_DENIED"
  | "RATE_LIMITED"
  | "UPSTREAM_ERROR"
  | "INVALID_RESPONSE";

export type ProviderResult<T> =
  | {
      ok: true;
      data: T;
      provider: string;
      fetchedAt: string;
      quality: "VALID" | "PARTIAL";
    }
  | {
      ok: false;
      provider: string;
      fetchedAt: string;
      error: { code: ProviderErrorCode; message: string };
      fallbackAllowed: boolean;
    };

export interface MarketDataProvider {
  id: string;
  capabilities(): ProviderCapability[];
  getPriceSeries(request: PriceSeriesRequest): Promise<ProviderResult<PricePoint[]>>;
  getValuationMetrics(request: MetricRequest): Promise<ProviderResult<MetricPoint[]>>;
  getFundamentalMetrics(request: MetricRequest): Promise<ProviderResult<MetricPoint[]>>;
  getMacroSeries(request: MacroRequest): Promise<ProviderResult<MetricPoint[]>>;
}
